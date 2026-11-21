/**
 * @bugfix @regression-proof
 * @req LIB-FMT-08[badger-mobile,badger-tv]
 *
 * An app update over a phone that already holds a library (Badger Android 100 -> 101) kept the metadata DB in its
 * old layout: the open path only ran the CREATE-IF-NOT-EXISTS baseline, never `metadataMigrations`, so `media_files`
 * stayed without `edition_id` and the next remote `media.upsert` failed its metadata batch with
 * `table media_files has no column named edition_id`. Opening a split DB must run its registered migrations first.
 *
 * Real SQLite (node:sqlite) behind the `executeSql` shape react-native-sqlite-storage gives the open path.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { buildOpStatements } from "@space/library-db-definition";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { ensureCoreSchema, ensureIngestSchema, ensureMetadataSchema, ensurePlaybackSchema } from "../src/lib/librarySchema";
import { coreMigrations, ingestMigrations, metadataMigrations, playbackMigrations } from "../src/lib/libraryMigrations";

// Hoisted above the imports: the schema module and the playback-blob migration pull react-native-quick-crypto.
vi.mock("react-native-quick-crypto", () => ({ default: { randomBytes: (size: number) => Buffer.alloc(size) } }));

const TAG = "[library-open-migrates-every-db]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}`, data === undefined ? "" : JSON.stringify(data));

type Row = Record<string, unknown>;

/** react-native-sqlite-storage's `executeSql` / `sqlBatch` over node:sqlite; multi-statement DDL without params goes through `exec`. */
const asPhoneDb = (db: DatabaseSync) => {
  const executeSql = async (sql: string, params: unknown[] = []) => {
    const statement = db.prepare(sql);
    let rows: Row[] = [];
    if (statement.columns().length) rows = statement.all(...(params as SQLInputValue[])) as Row[];
    else if (params.length) statement.run(...(params as SQLInputValue[]));
    else db.exec(sql);
    return [{ rows: { length: rows.length, item: (i: number) => rows[i] } }];
  };
  const sqlBatch = async (statements: Array<string | [string, unknown[]]>) => {
    db.exec("BEGIN;");
    try {
      for (const entry of statements) await (typeof entry === "string" ? executeSql(entry) : executeSql(entry[0], entry[1]));
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  };
  return { executeSql, sqlBatch };
};
type PhoneDb = Parameters<typeof ensureMetadataSchema>[0];
const phone = (db: DatabaseSync) => asPhoneDb(db) as unknown as PhoneDb;

const userVersion = (db: DatabaseSync) => Number((db.prepare("PRAGMA user_version;").get() as Row).user_version);
const columnsOf = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table});`).all() as Row[]).map((row) => String(row.name));
const latest = (migrations: ReadonlyArray<{ version: number }>) => Math.max(...migrations.map((m) => m.version));
const dump = (db: DatabaseSync, label: string) =>
  log(`dump.${label}`, {
    userVersion: userVersion(db),
    mediaFilesColumns: columnsOf(db, "media_files"),
    tables: (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;").all() as Row[]).map((r) => r.name),
    files: db.prepare("SELECT * FROM media_files ORDER BY id;").all(),
    editions: columnsOf(db, "media_editions").length ? db.prepare("SELECT * FROM media_editions ORDER BY id;").all() : null,
  });

/**
 * A metadata DB as a pre-editions build (09d69db8) left it on the phone, after the next build's open path ran:
 * user_version 0, `media_files` with the old column list, `media_crew` and `media_editions` missing.
 */
const preEditionsMetadataDb = async () => {
  const db = new DatabaseSync(":memory:");
  await ensureMetadataSchema(phone(db)).catch(() => undefined);
  db.exec("PRAGMA user_version = 0;");
  db.exec("DROP TABLE IF EXISTS media_editions;");
  db.exec("DROP TABLE IF EXISTS media_crew;");
  db.exec("DROP INDEX IF EXISTS media_files_edition_id_idx;");
  for (const column of ["content_sha256", "edition_id"]) {
    if (columnsOf(db, "media_files").includes(column)) db.exec(`ALTER TABLE media_files DROP COLUMN ${column};`);
  }
  db.prepare("INSERT INTO media_files (id, media_id, filename, season, episode, added_at, status) VALUES (?, ?, ?, ?, ?, ?, ?);").run(
    "f-old",
    "film-1",
    "Film.720p.mkv",
    null,
    null,
    "2026-11-01T00:00:00.000Z",
    "local"
  );
  return db;
};

const filmUpsert = (updatedAt: string): LibraryOp => ({
  id: "op-1",
  type: "media.upsert" as const,
  createdAt: updatedAt,
  payload: {
    details: {
      id: "film-1",
      title: "Film",
      type: "movie",
      updatedAt,
      cast: [],
      crew: [],
      seasons: [],
      episodes: [],
      trailers: [],
      skipMarkers: [],
      formats: [],
      audioTracks: [],
      subtitleTracks: [],
      subtitles: [],
      chapters: [],
      playlistIds: [],
      hasLocalFiles: true,
      editions: [
        { id: "ed-film-1-extended", season: null, episode: null, name: "Extended", nameUserSet: true, durationSeconds: 7200, createdAt: updatedAt },
      ],
      files: [
        {
          id: "f-new",
          filename: "Film.Extended.1080p.mkv",
          season: null,
          episode: null,
          desiredFormats: [],
          editionId: "ed-film-1-extended",
          contentSha256: "ab".repeat(32),
        },
      ],
    } as unknown as MediaDetails,
  },
});

const applyMetadataStatements = (db: DatabaseSync, op: LibraryOp) => {
  const statements = buildOpStatements(op, () => crypto.randomUUID()).metadata ?? [];
  log("upsert.metadata.statements", { count: statements.length });
  db.exec("BEGIN;");
  try {
    for (const statement of statements) db.prepare(statement.sql).run(...(statement.params as SQLInputValue[]));
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
};

describe("opening a split library DB migrates it before use (LIB-FMT-08)", () => {
  it("brings a pre-editions metadata DB to the editions layout, so a media.upsert with edition_id applies", async () => {
    const db = await preEditionsMetadataDb();
    dump(db, "before_open");
    expect(userVersion(db)).toBe(0);
    expect(columnsOf(db, "media_files")).not.toContain("edition_id");

    log("phase.open");
    await ensureMetadataSchema(phone(db));
    dump(db, "after_open");
    const layoutAfterOpen = { userVersion: userVersion(db), mediaFiles: columnsOf(db, "media_files"), crew: columnsOf(db, "media_crew") };
    // LIB-EDIT-02: the file already there must sit in its film's unnamed edition (read before the upsert replaces it).
    const oldFileEdition = layoutAfterOpen.mediaFiles.includes("edition_id")
      ? db.prepare("SELECT edition_id FROM media_files WHERE id = 'f-old';").get()
      : null;
    log("open.result", { layoutAfterOpen, oldFileEdition });

    // First the symptom seen on the phone: the metadata batch of a media.upsert carrying editions.
    log("phase.upsert");
    let failure: unknown = null;
    try {
      applyMetadataStatements(db, filmUpsert("2026-11-12T10:00:00.000Z"));
    } catch (error) {
      failure = error;
      dump(db, "upsert_failed");
    }
    log("upsert.result", { failure: failure instanceof Error ? failure.message : failure });
    expect(failure instanceof Error ? failure.message : failure).toBeNull();
    dump(db, "after_upsert");
    expect(db.prepare("SELECT id, edition_id, content_sha256 FROM media_files ORDER BY id;").all()).toEqual([
      { id: "f-new", edition_id: "ed-film-1-extended", content_sha256: "ab".repeat(32) },
    ]);
    expect(db.prepare("SELECT id, name FROM media_editions WHERE media_id = 'film-1' ORDER BY id;").all()).toEqual([
      { id: "ed-film-1-extended", name: "Extended" },
    ]);

    // Then the cause: the open path ran every registered metadata step.
    expect(layoutAfterOpen.userVersion).toBe(latest(metadataMigrations));
    expect(layoutAfterOpen.mediaFiles).toEqual(expect.arrayContaining(["edition_id", "content_sha256"]));
    expect(layoutAfterOpen.crew.length).toBeGreaterThan(0);
    expect(oldFileEdition).toEqual({ edition_id: "ed-film-1-x-x" });

    log("phase.reopen");
    await ensureMetadataSchema(phone(db));
    expect(userVersion(db)).toBe(latest(metadataMigrations));
    expect(db.prepare("SELECT COUNT(*) AS n FROM media_files;").get()).toEqual({ n: 1 });
  });

  it("stamps every split DB at its registry's latest version on open", async () => {
    const opens = [
      ["core", ensureCoreSchema, coreMigrations],
      ["metadata", ensureMetadataSchema, metadataMigrations],
      ["playback", ensurePlaybackSchema, playbackMigrations],
      ["ingest", ensureIngestSchema, ingestMigrations],
    ] as const;
    for (const [group, open, migrations] of opens) {
      const db = new DatabaseSync(":memory:");
      await open(phone(db));
      log("fresh_open", { group, userVersion: userVersion(db), latest: latest(migrations) });
      expect(userVersion(db)).toBe(latest(migrations));
      await open(phone(db));
      expect(userVersion(db)).toBe(latest(migrations));
    }
  });

  // LIB-FMT-11: a playback DB an earlier build left at the latest version, without the packed tables. No migration
  // step adds them (that would bump user_version before the switch, LIB-FMT-13), so the open creates them empty.
  it("creates the packed playback tables on an existing playback DB without bumping its version (LIB-FMT-11)", async () => {
    const packed = ["media_chunk_lists", "media_file_playback"];
    const tables = (db: DatabaseSync) =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('${packed.join("', '")}') ORDER BY name;`).all() as Row[])
        .map((row) => String(row.name));
    const db = new DatabaseSync(":memory:");
    await ensurePlaybackSchema(phone(db));
    for (const table of packed) db.exec(`DROP TABLE ${table};`);
    const before = { userVersion: userVersion(db), tables: tables(db) };
    log("packed.before_open", before);
    expect(before).toEqual({ userVersion: latest(playbackMigrations), tables: [] });

    await ensurePlaybackSchema(phone(db));
    const after = { userVersion: userVersion(db), tables: tables(db) };
    log("packed.after_open", after);
    expect(after).toEqual({ userVersion: latest(playbackMigrations), tables: packed });
    expect(db.prepare("SELECT COUNT(*) AS n FROM media_chunk_lists;").get()).toEqual({ n: 0 });
  });
});
