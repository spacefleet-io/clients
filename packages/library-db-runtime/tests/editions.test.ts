/**
 * @req LIB-EDIT-01
 * @req LIB-EDIT-02
 *
 * Edition storage: the `media_editions` table and the files' `edition_id`. Real engine (bun:sqlite).
 *  - An old-format metadata DB (media_files without the edition columns, two films and an episode) upgrades through
 *    the registered metadata step 2: one unnamed edition per film and per episode, every file in it; a second run
 *    changes nothing.
 *  - A library from before editions (no table, no columns) still reads its files.
 *  - The shared op applier stores a title's editions when the op carries them, and files a pre-edition client's files
 *    under their unit's unnamed edition when it does not.
 *  - The desktop LibraryDb: a linked file lands in its unit's unnamed edition, and details read it back.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureLibrarySchema, type SqliteDb } from "@space/library-db-definition/migrations";
import { readMediaDetailsSync } from "@space/library-db-definition/mediaDetails";
import { buildMediaMetadataStatements } from "@space/library-db-definition/ops";
import { defaultEditionId, editionResumeKey, readEditionResume } from "@space/shared/mediaEditions";
import { parseEpisodeResumeValue } from "@space/shared/playbackResume";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { desktopMetadataMigrations } from "../src/desktopMigrations";
import { LibraryDb } from "../src/libraryDb";

const SUITE = "editions";
const log = (phase: string, data?: unknown) => console.info(`[${SUITE}] ${phase}`, JSON.stringify(data ?? ""));

const editionsStep = desktopMetadataMigrations.find((m) => m.version === 2)!;

/** The `media_files` table as every build before LIB-EDIT-01 created it. */
const oldFormatMetadataDb = () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE media_files (
    id TEXT PRIMARY KEY, media_id TEXT NOT NULL, filename TEXT NOT NULL, season INTEGER, episode INTEGER,
    added_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'local', template_id TEXT)`);
  const insert = db.prepare("INSERT INTO media_files (id, media_id, filename, season, episode, added_at) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run("f-sintel-1080", "sintel", "Sintel.1080p.mkv", null, null, "2026-01-02T00:00:00.000Z");
  insert.run("f-sintel-720", "sintel", "Sintel.720p.mkv", null, null, "2026-01-01T00:00:00.000Z");
  insert.run("f-bbb", "bbb", "Big.Buck.Bunny.mkv", null, null, "2026-01-03T00:00:00.000Z");
  insert.run("f-show-s1e2", "show", "Show.S01E02.mkv", 1, 2, "2026-01-04T00:00:00.000Z");
  return db;
};

const editionRows = (db: Database) =>
  db.query("SELECT id, media_id, season, episode, name, name_user_set, created_at FROM media_editions ORDER BY id").all();
const fileEditions = (db: Database) =>
  Object.fromEntries(
    (db.query("SELECT id, edition_id FROM media_files ORDER BY id").all() as Array<{ id: string; edition_id: string }>).map(
      (row) => [row.id, row.edition_id]
    )
  );

describe("metadata migration step 2 (media_editions)", () => {
  it("gives every film and episode one unnamed edition holding all of its files, once", () => {
    const db = oldFormatMetadataDb();
    editionsStep.up(db as unknown as SqliteDb);
    const editions = editionRows(db);
    const files = fileEditions(db);
    log("after first run", { editions, files });
    expect(editions).toEqual([
      { id: "ed-bbb-x-x", media_id: "bbb", season: null, episode: null, name: "", name_user_set: 0, created_at: "2026-01-03T00:00:00.000Z" },
      { id: "ed-show-1-2", media_id: "show", season: 1, episode: 2, name: "", name_user_set: 0, created_at: "2026-01-04T00:00:00.000Z" },
      { id: "ed-sintel-x-x", media_id: "sintel", season: null, episode: null, name: "", name_user_set: 0, created_at: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(files).toEqual({
      "f-bbb": "ed-bbb-x-x",
      "f-show-s1e2": "ed-show-1-2",
      "f-sintel-1080": "ed-sintel-x-x",
      "f-sintel-720": "ed-sintel-x-x",
    });
    // The SQL id is the one every client computes.
    expect(files["f-show-s1e2"]).toBe(defaultEditionId("show", 1, 2));
    expect(files["f-bbb"]).toBe(defaultEditionId("bbb", null, null));

    editionsStep.up(db as unknown as SqliteDb);
    log("after second run", { editions: editionRows(db), files: fileEditions(db) });
    expect(editionRows(db)).toEqual(editions);
    expect(fileEditions(db)).toEqual(files);
  });

  it("on a fresh library (columns from the baseline) only adds what is missing", () => {
    const db = new Database(":memory:");
    ensureLibrarySchema(db as unknown as SqliteDb, "metadata");
    const columns = (db.query("PRAGMA table_info(media_files)").all() as Array<{ name: string }>).map((c) => c.name);
    log("fresh columns", columns);
    expect(columns).toContain("edition_id");
    expect(columns).toContain("content_sha256");
    editionsStep.up(db as unknown as SqliteDb);
    expect(editionRows(db)).toEqual([]);
  });
});

describe("reading media details", () => {
  const readDetails = (db: Database, mediaId: string) =>
    readMediaDetailsSync(
      (query) => {
        try {
          return db.query(query.sql).all(...(query.params as string[])) as Record<string, unknown>[];
        } catch (error) {
          // This fixture holds only media_items and media_files; the edition reads must cope on their own.
          if (query.name === "editions" || query.name === "fileEditions") throw error;
          return [];
        }
      },
      mediaId
    );

  const withTitles = (db: Database) => {
    db.run("CREATE TABLE media_items (id TEXT PRIMARY KEY, type TEXT, title TEXT, added_at TEXT, updated_at TEXT, has_files INTEGER)");
    db.run("INSERT INTO media_items VALUES ('sintel', 'movie', 'Sintel', 'x', 'x', 1)");
    return db;
  };

  it("a library from before editions still reads its files, with no editions", () => {
    const db = withTitles(oldFormatMetadataDb());
    const details = readDetails(db, "sintel")!;
    log("old details", { files: details.files, editions: details.editions });
    expect(details.files.map((file) => file.id).sort()).toEqual(["f-sintel-1080", "f-sintel-720"]);
    expect(details.files.every((file) => file.editionId === undefined)).toBe(true);
    expect(details.editions).toEqual([]);
  });

  it("after the upgrade, details carry the editions and each file's edition", () => {
    const db = withTitles(oldFormatMetadataDb());
    editionsStep.up(db as unknown as SqliteDb);
    const details = readDetails(db, "sintel")!;
    log("upgraded details", { files: details.files, editions: details.editions });
    expect(details.editions).toEqual([
      {
        id: "ed-sintel-x-x",
        season: null,
        episode: null,
        name: "",
        nameUserSet: false,
        durationSeconds: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(details.files.map((file) => file.editionId)).toEqual(["ed-sintel-x-x", "ed-sintel-x-x"]);
  });
});

describe("media.upsert op applier", () => {
  const baseDetails = (overrides: Partial<MediaDetails>): MediaDetails =>
    ({
      id: "sintel",
      type: "movie",
      title: "Sintel",
      addedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
      cast: [],
      trailers: [],
      seasons: [],
      episodes: [],
      files: [],
      formats: [],
      audioTracks: [],
      subtitleTracks: [],
      ...overrides,
    }) as unknown as MediaDetails;

  const apply = (db: Database, details: MediaDetails) => {
    let n = 0;
    const statements = buildMediaMetadataStatements(details, () => `gen-${(n += 1)}`).metadata ?? [];
    for (const { sql, params } of statements) db.prepare(sql).run(...(params as never[]));
  };

  const freshMetadata = () => {
    const db = new Database(":memory:");
    ensureLibrarySchema(db as unknown as SqliteDb, "metadata");
    return db;
  };

  it("stores the title's editions and each file's edition when the op carries them", () => {
    const db = freshMetadata();
    apply(
      db,
      baseDetails({
        editions: [
          { id: "ed-theatrical", season: null, episode: null, name: "Theatrical", nameUserSet: true, durationSeconds: 888, createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "ed-director", season: null, episode: null, name: "", nameUserSet: false, durationSeconds: 960, createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        files: [
          { id: "f1", filename: "Sintel.mkv", season: null, episode: null, desiredFormats: [], editionId: "ed-theatrical", contentSha256: "ab".repeat(32) },
          { id: "f2", filename: "Sintel.dc.mkv", season: null, episode: null, desiredFormats: [], editionId: "ed-director", contentSha256: null },
        ],
      })
    );
    const editions = db.query("SELECT id, name, name_user_set, duration_seconds FROM media_editions ORDER BY created_at").all();
    const files = db.query("SELECT id, edition_id, content_sha256 FROM media_files ORDER BY id").all();
    log("op with editions", { editions, files });
    expect(editions).toEqual([
      { id: "ed-theatrical", name: "Theatrical", name_user_set: 1, duration_seconds: 888 },
      { id: "ed-director", name: "", name_user_set: 0, duration_seconds: 960 },
    ]);
    expect(files).toEqual([
      { id: "f1", edition_id: "ed-theatrical", content_sha256: "ab".repeat(32) },
      { id: "f2", edition_id: "ed-director", content_sha256: null },
    ]);
  });

  it("an op from a client before editions files each file under its unit's unnamed edition and keeps named ones", () => {
    const db = freshMetadata();
    db.run(
      "INSERT INTO media_editions (id, media_id, season, episode, name, name_user_set, created_at) VALUES ('ed-director', 'sintel', NULL, NULL, 'Director''s Cut', 1, 'x')"
    );
    apply(db, baseDetails({ files: [{ id: "f1", filename: "Sintel.mkv", season: null, episode: null, desiredFormats: [] }] }));
    const editions = db.query("SELECT id, name FROM media_editions ORDER BY id").all();
    const files = db.query("SELECT id, edition_id FROM media_files").all();
    log("op without editions", { editions, files });
    expect(editions).toEqual([
      { id: "ed-director", name: "Director's Cut" },
      { id: "ed-sintel-x-x", name: "" },
    ]);
    expect(files).toEqual([{ id: "f1", edition_id: "ed-sintel-x-x" }]);
  });
});

describe("desktop LibraryDb", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-editions-"));
    process.env.SF_USER_DATA_PATH = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.SF_USER_DATA_PATH;
  });

  it("a linked file lands in its film's unnamed edition, and details read it back; delete removes it", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await db.addMediaFromCatalog({
      id: 45745,
      type: "movie",
      title: "Sintel",
      originalTitle: "Sintel",
      originalLanguage: "en",
      overview: "A girl and a dragon.",
      year: "2010",
      posterPath: null,
      backdropPath: null,
      genres: [],
      cast: [],
      trailers: [],
      seasons: [],
      episodes: [],
      totalEpisodes: 0,
    });
    await db.linkFileToMedia(mediaId, "Sintel (2010) [1080p].mkv");
    const details = db.getMediaDetails(mediaId)!;
    log("desktop details", { files: details.files, editions: details.editions });
    const editionId = defaultEditionId(mediaId, null, null);
    expect(details.editions?.map((edition) => [edition.id, edition.name, edition.nameUserSet])).toEqual([[editionId, "", false]]);
    expect(details.files.map((file) => file.editionId)).toEqual([editionId]);
    await db.deleteMedia(mediaId);
    expect(db.getMediaDetails(mediaId)).toBeNull();
    db.close();
  });

  const sintel = (db: LibraryDb) =>
    db.addMediaFromCatalog({
      id: 45745,
      type: "movie",
      title: "Sintel",
      originalTitle: "Sintel",
      originalLanguage: "en",
      overview: null,
      year: "2010",
      rating: null,
      posterPath: null,
      backdropPath: null,
      genres: [],
      cast: [],
      trailers: [],
      seasons: [],
      episodes: [],
      totalEpisodes: 0,
    } as unknown as Parameters<LibraryDb["addMediaFromCatalog"]>[0]);

  it("named editions hold their own files; linking into one leaves the other alone", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await sintel(db);
    const theatrical = db.addMediaEdition(mediaId, { name: "Theatrical", durationSeconds: 888 });
    const extended = db.addMediaEdition(mediaId, { name: "Extended", durationSeconds: 960 });
    await db.linkFileToMedia(mediaId, "Sintel.th.mkv", null, null, { editionId: theatrical });
    await db.linkFileToMedia(mediaId, "Sintel.ext.mkv", null, null, { editionId: extended });
    await db.linkFileToMedia(mediaId, "Sintel.ext.v2.mkv", null, null, { editionId: extended });
    const details = db.getMediaDetails(mediaId)!;
    const byEdition = details.files.map((file) => [file.filename, file.editionId]).sort();
    log("named editions", { editions: details.editions, byEdition });
    expect(details.editions?.map((e) => [e.name, e.durationSeconds, e.nameUserSet]).sort()).toEqual([
      ["Extended", 960, true],
      ["Theatrical", 888, true],
    ]);
    expect(byEdition).toEqual([
      ["Sintel.ext.v2.mkv", extended],
      ["Sintel.th.mkv", theatrical],
    ]);
    db.close();
  });

  it("@req PLAY-RESUME-05[badger-desktop] each edition keeps its own resume spot; finishing one clears it", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await sintel(db);
    const theatrical = db.addMediaEdition(mediaId, { name: "Theatrical", durationSeconds: 888 });
    const extended = db.addMediaEdition(mediaId, { name: "Extended", durationSeconds: 960 });
    db.setActiveProfile({ id: "main-uuid", isMain: true });
    await db.setProgress(mediaId, 50, null, { positionSeconds: 444, durationSeconds: 888, editionId: theatrical });
    await db.setProgress(mediaId, 25, null, { positionSeconds: 240, durationSeconds: 960, editionId: extended });
    const read = () =>
      readEditionResume(
        [
          { id: theatrical, durationSeconds: 888 },
          { id: extended, durationSeconds: 960 },
        ],
        (key) => db.getSetting(key)?.value
      );
    const both = read();
    log("two spots", both);
    expect(both[theatrical]?.positionSeconds).toBe(444);
    expect(both[extended]?.positionSeconds).toBe(240);

    await db.setProgress(mediaId, 100, null, { positionSeconds: 888, durationSeconds: 888, editionId: theatrical });
    const after = read();
    log("theatrical finished", { after, stored: db.getSetting(editionResumeKey(theatrical)) });
    expect(db.getSetting(editionResumeKey(theatrical))?.value).toBe("");
    expect(Object.keys(after)).toEqual([extended]);

    db.setActiveProfile({ id: "kid-uuid", isMain: false });
    await db.setProgress(mediaId, 40, null, { positionSeconds: 355, durationSeconds: 888, editionId: theatrical });
    const kidRow = db.getSetting(`p:kid-uuid:${editionResumeKey(theatrical)}`);
    log("kid spot", kidRow);
    expect(parseEpisodeResumeValue(kidRow?.value)?.positionSeconds).toBe(355);
    expect(db.getSetting(editionResumeKey(theatrical))?.value).toBe("");
    db.close();
  });
});
