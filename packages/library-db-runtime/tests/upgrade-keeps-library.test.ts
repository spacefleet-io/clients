/**
 * @req LIB-FMT-02
 * @req LIB-FMT-04[badger-desktop]
 * @req LIB-FMT-08[badger-desktop,runtime,badger-jellyfin]
 *
 * Test id: LIBDB-UPGRADE-001.
 *
 * An app update keeps the Badger desktop library (REL-UPD-01's background update replaces the app, never the user's
 * data dir). The library lives in `<userData>/library/library.<group>.sqlite`; the new build opens the files the old
 * build left there through `LibraryDb.openLocal`, which runs each group's registered steps (src/desktopMigrations.ts).
 *  - Files left by a build before every registered step (core, metadata and playback at `user_version` 0, metadata
 *    without `media_crew`, `media_editions` and the files' edition columns) open at the current layout, and the
 *    title, its linked file and a setting are all still there; the file lands in its title's unnamed edition.
 *  - A group file written by a newer build (`user_version` above what this build knows) is refused with
 *    `LibraryFormatTooNewError`, and the file keeps its version and its rows, so updating the app opens it again.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defaultEditionId } from "@space/shared/mediaEditions";
import { desktopCoreMigrations, desktopMetadataMigrations, desktopPlaybackMigrations } from "../src/desktopMigrations";
import { LibraryDb, LibraryFormatTooNewError } from "../src/libraryDb";

const TEST_ID = "LIBDB-UPGRADE-001";
const log = (phase: string, data?: unknown) => console.info(`[${TEST_ID}] phase ${phase}`, JSON.stringify(data ?? ""));

const latest = (steps: ReadonlyArray<{ version: number }>) => Math.max(0, ...steps.map((step) => step.version));
const CURRENT = {
  core: latest(desktopCoreMigrations),
  metadata: latest(desktopMetadataMigrations),
  playback: latest(desktopPlaybackMigrations),
};

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-libdb-upgrade-"));
  process.env.SF_USER_DATA_PATH = root;
  log("setup", { root, current: CURRENT });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const groupFile = (group: "core" | "metadata" | "playback") => join(root, "library", `library.${group}.sqlite`);

const withFile = <T>(group: "core" | "metadata" | "playback", run: (db: Database) => T): T => {
  const db = new Database(groupFile(group));
  try {
    return run(db);
  } finally {
    db.close();
  }
};

const userVersion = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
const indexes = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (row) => row.name
  );
const columns = (db: Database, table: string) =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);

const fileState = () => ({
  core: withFile("core", (db) => ({
    version: userVersion(db),
    addedAtIndexes: indexes(db).filter((name) => name === "media_items_added_at_idx" || name === "media_items_updated_at_idx"),
    media: db.query("SELECT id, title FROM media_items ORDER BY id").all(),
    setting: db.query("SELECT value FROM app_settings WHERE key = 'ui.language'").get(),
  })),
  metadata: withFile("metadata", (db) => ({
    version: userVersion(db),
    tables: tables(db).filter((name) => name === "media_crew" || name === "media_editions"),
    fileColumns: columns(db, "media_files").filter((name) => name === "edition_id" || name === "content_sha256").sort(),
    files: db.query("SELECT * FROM media_files ORDER BY id").all() as Array<Record<string, unknown>>,
  })),
  playback: withFile("playback", (db) => ({
    version: userVersion(db),
    chunkIndexes: indexes(db).filter((name) => name === "media_format_chunks_format_id_idx" || name === "media_audio_chunks_track_id_idx"),
  })),
});

/** First run of an installed build: a title, its file and a setting, written through the app's own LibraryDb. */
const firstRun = async () => {
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
    rating: 7,
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
  db.setSetting("ui.language", "fr");
  db.close();
  return mediaId;
};

describe("Badger library across an app update", () => {
  it("files left by a build before every registered step open at the current layout with the title, its file and settings kept", async () => {
    const mediaId = await firstRun();
    log("written-by-first-run", fileState());

    // Turn the files into what a build before every registered step left: user_version 0, and the metadata file
    // without the crew table, the editions table and the files' edition columns; the indexes those steps change too.
    withFile("core", (db) => {
      db.exec("DROP INDEX IF EXISTS media_items_added_at_idx; DROP INDEX IF EXISTS media_items_updated_at_idx; PRAGMA user_version = 0;");
    });
    withFile("metadata", (db) => {
      const editionIndexes = db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media_files' AND (sql LIKE '%edition_id%' OR sql LIKE '%content_sha256%')")
        .all() as Array<{ name: string }>;
      for (const { name } of editionIndexes) db.exec(`DROP INDEX "${name}"`);
      db.exec("DROP TABLE IF EXISTS media_crew; DROP TABLE IF EXISTS media_editions;");
      for (const column of ["edition_id", "content_sha256"]) {
        if (columns(db, "media_files").includes(column)) db.exec(`ALTER TABLE media_files DROP COLUMN ${column}`);
      }
      db.exec("PRAGMA user_version = 0;");
    });
    withFile("playback", (db) => {
      db.exec(
        "CREATE INDEX IF NOT EXISTS media_format_chunks_format_id_idx ON media_format_chunks(format_id);" +
          "CREATE INDEX IF NOT EXISTS media_audio_chunks_track_id_idx ON media_audio_chunks(track_id);" +
          "PRAGMA user_version = 0;"
      );
    });
    const old = fileState();
    log("old-build-files", old);
    expect(old.core).toMatchObject({ version: 0, addedAtIndexes: [] });
    expect(old.metadata).toMatchObject({ version: 0, tables: [], fileColumns: [] });
    expect(old.metadata.files).toHaveLength(1);
    expect(old.playback.chunkIndexes).toEqual(["media_audio_chunks_track_id_idx", "media_format_chunks_format_id_idx"]);

    // The updated build opens them.
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const details = db.getMediaDetails(mediaId);
    const setting = db.getSetting("ui.language");
    log("opened-by-new-build", { title: details?.title, files: details?.files, editions: details?.editions, setting });
    expect(details?.title).toBe("Sintel");
    expect(details?.files.map((file) => file.filename)).toEqual(["Sintel (2010) [1080p].mkv"]);
    const editionId = defaultEditionId(mediaId, null, null);
    expect(details?.files.map((file) => file.editionId)).toEqual([editionId]);
    expect(details?.editions?.map((edition) => edition.id)).toEqual([editionId]);
    expect(setting?.value).toBe("fr");
    db.close();

    const after = fileState();
    log("after-update", after);
    expect(after.core).toMatchObject({ version: CURRENT.core, setting: { value: "fr" } });
    expect(after.core.addedAtIndexes).toEqual(["media_items_added_at_idx", "media_items_updated_at_idx"]);
    expect(after.core.media).toEqual(old.core.media);
    expect(after.metadata).toMatchObject({ version: CURRENT.metadata, tables: ["media_crew", "media_editions"] });
    expect(after.metadata.fileColumns).toEqual(["content_sha256", "edition_id"]);
    expect(after.metadata.files).toHaveLength(1);
    expect(after.metadata.files[0]).toMatchObject({ ...old.metadata.files[0], edition_id: editionId });
    expect(after.playback).toEqual({ version: CURRENT.playback, chunkIndexes: [] });

    // A second launch of the same build changes nothing.
    const again = await LibraryDb.openLocal("token", "key");
    again.close();
    const second = fileState();
    log("second-launch", second);
    expect(second).toEqual(after);
  });

  for (const group of ["core", "metadata"] as const) {
    it(`a ${group} file from a newer build is refused, and keeps its version and rows`, async () => {
      const mediaId = await firstRun();
      const tooNew = CURRENT[group] + 1;
      withFile(group, (db) => db.exec(`PRAGMA user_version = ${tooNew};`));
      const before = fileState();
      log(`${group}-from-newer-build`, before);

      let refused: unknown = null;
      try {
        const db = await LibraryDb.openLocal("token", "key");
        db.close();
      } catch (error) {
        refused = error;
      }
      log(`${group}-refused`, { error: refused instanceof Error ? `${refused.name}: ${refused.message}` : refused });
      expect(refused).toBeInstanceOf(LibraryFormatTooNewError);

      const after = fileState();
      log(`${group}-after-refusal`, after);
      expect(after[group].version).toBe(tooNew);
      expect(after).toEqual(before);
      expect(after.core.media).toEqual([{ id: mediaId, title: "Sintel" }]);
      expect(after.metadata.files).toHaveLength(1);
    });
  }
});
