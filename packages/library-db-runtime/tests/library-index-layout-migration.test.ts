/**
 * @test-id LIB-INDEX-LAYOUT-MIGRATION-001
 * @level integration (real bun:sqlite + real LibraryDb)
 *
 * The saved library carries the same duplicate indexes in every copy, so the layout pass drops
 * `media_format_chunks_format_id_idx` and `media_audio_chunks_track_id_idx` (the composite unique
 * indexes `(format_id, order_index)` / `(track_id, order_index)` already serve those lookups) and
 * adds `media_items(added_at)` / `media_items(updated_at)`. Pins:
 *   1. a fresh library never creates the duplicates and does create the new indexes,
 *   2. a library in the PRIOR shape (duplicates present, new indexes absent, user_version 0)
 *      opens through the registered migrations: rows and columns untouched, only indexes change,
 *   3. the same holds through the real `LibraryDb.openLocal` on prior-shape per-group files.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@space/library-db-definition/migrationRunner";
import { ensureLibrarySchema, type SqliteDb } from "@space/library-db-definition/migrations";
import { desktopCoreMigrations, desktopPlaybackMigrations } from "../src/desktopMigrations";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[LIB-INDEX-LAYOUT-MIGRATION-001]";
const DUPLICATES = ["media_format_chunks_format_id_idx", "media_audio_chunks_track_id_idx"];
const ADDED = ["media_items_added_at_idx", "media_items_updated_at_idx"];
const KEPT = ["media_format_chunks_unique_idx", "media_audio_chunks_unique_idx"];

const indexNames = (db: Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name;").all() as Array<{ name: string }>).map(
    (row) => row.name
  );

const columns = (db: Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>).map((row) => row.name);

const userVersion = (db: Database) => Number((db.prepare("PRAGMA user_version;").get() as { user_version: number }).user_version);

const asSqlite = (db: Database) => db as unknown as SqliteDb;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-index-layout-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`${TAG} setup root=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

describe("index layout pass", () => {
  it("a fresh schema creates no duplicate chunk indexes and does index added_at / updated_at", () => {
    const core = new Database(":memory:");
    const playback = new Database(":memory:");
    ensureLibrarySchema(asSqlite(core), "core");
    ensureLibrarySchema(asSqlite(playback), "playback");
    const coreIdx = indexNames(core);
    const playbackIdx = indexNames(playback);
    console.info(`${TAG} fresh coreIdx=${JSON.stringify(coreIdx)} playbackIdx=${JSON.stringify(playbackIdx)}`);
    try {
      for (const name of ADDED) expect(coreIdx).toContain(name);
      for (const name of DUPLICATES) expect(playbackIdx).not.toContain(name);
      for (const name of KEPT) expect(playbackIdx).toContain(name);
    } finally {
      core.close();
      playback.close();
    }
  });

  it("a prior-shape playback + core file migrates: duplicates dropped, new indexes added, rows and columns untouched", () => {
    const core = new Database(":memory:");
    const playback = new Database(":memory:");
    ensureLibrarySchema(asSqlite(core), "core");
    ensureLibrarySchema(asSqlite(playback), "playback");
    // Rebuild the PRIOR shape.
    for (const name of ADDED) core.exec(`DROP INDEX IF EXISTS ${name};`);
    playback.exec("CREATE INDEX media_format_chunks_format_id_idx ON media_format_chunks(format_id);");
    playback.exec("CREATE INDEX media_audio_chunks_track_id_idx ON media_audio_chunks(track_id);");
    const now = new Date().toISOString();
    core
      .prepare(
        "INSERT INTO media_items (id, type, title, added_at, updated_at) VALUES ('m1', 'movie', 'Prior', ?, ?);"
      )
      .run(now, now);
    const columnsBefore = { items: columns(core, "media_items"), chunks: columns(playback, "media_format_chunks"), audio: columns(playback, "media_audio_chunks") };
    console.info(`${TAG} prior shape coreIdx=${JSON.stringify(indexNames(core))} playbackIdx=${JSON.stringify(indexNames(playback))}`);
    try {
      expect(indexNames(playback)).toEqual(expect.arrayContaining(DUPLICATES));
      expect(indexNames(core)).not.toContain(ADDED[0]!);

      const coreResult = runMigrations(asSqlite(core), "core", desktopCoreMigrations);
      const playbackResult = runMigrations(asSqlite(playback), "playback", desktopPlaybackMigrations);
      console.info(`${TAG} migrated core=${JSON.stringify(coreResult)} playback=${JSON.stringify(playbackResult)}`);

      expect(coreResult).toEqual({ from: 0, to: 1, applied: [1] });
      expect(playbackResult).toEqual({ from: 0, to: 1, applied: [1] });
      for (const name of ADDED) expect(indexNames(core)).toContain(name);
      for (const name of DUPLICATES) expect(indexNames(playback)).not.toContain(name);
      for (const name of KEPT) expect(indexNames(playback)).toContain(name);
      expect(columns(core, "media_items")).toEqual(columnsBefore.items);
      expect(columns(playback, "media_format_chunks")).toEqual(columnsBefore.chunks);
      expect(columns(playback, "media_audio_chunks")).toEqual(columnsBefore.audio);
      expect(Number((core.prepare("SELECT COUNT(*) AS n FROM media_items;").get() as { n: number }).n)).toBe(1);

      // A second pass has nothing to do.
      expect(runMigrations(asSqlite(core), "core", desktopCoreMigrations).applied).toEqual([]);
      expect(runMigrations(asSqlite(playback), "playback", desktopPlaybackMigrations).applied).toEqual([]);
    } finally {
      core.close();
      playback.close();
    }
  });

  it("LibraryDb.openLocal migrates prior-shape per-group files in place", async () => {
    const first = await LibraryDb.openLocal("token", "key");
    first.close();
    const dir = join(root, "library");
    const playbackPath = join(dir, "library.playback.sqlite");
    const corePath = join(dir, "library.core.sqlite");
    expect(existsSync(playbackPath)).toBe(true);

    // Put both files back into the prior shape and a pre-migration user_version.
    const priorPlayback = new Database(playbackPath);
    priorPlayback.exec("CREATE INDEX IF NOT EXISTS media_format_chunks_format_id_idx ON media_format_chunks(format_id);");
    priorPlayback.exec("CREATE INDEX IF NOT EXISTS media_audio_chunks_track_id_idx ON media_audio_chunks(track_id);");
    priorPlayback.exec("PRAGMA user_version = 0;");
    priorPlayback.close();
    const priorCore = new Database(corePath);
    for (const name of ADDED) priorCore.exec(`DROP INDEX IF EXISTS ${name};`);
    priorCore.exec("PRAGMA user_version = 0;");
    priorCore.close();
    console.info(`${TAG} prior-shape files written, reopening`);

    const second = await LibraryDb.openLocal("token", "key");
    second.close();

    const playback = new Database(playbackPath, { readonly: true });
    const core = new Database(corePath, { readonly: true });
    const playbackIdx = indexNames(playback);
    const coreIdx = indexNames(core);
    console.info(`${TAG} after reopen playbackIdx=${JSON.stringify(playbackIdx)} coreIdx=${JSON.stringify(coreIdx)} versions=${userVersion(playback)}/${userVersion(core)}`);
    try {
      for (const name of DUPLICATES) expect(playbackIdx).not.toContain(name);
      for (const name of KEPT) expect(playbackIdx).toContain(name);
      for (const name of ADDED) expect(coreIdx).toContain(name);
      expect(userVersion(playback)).toBe(1);
      expect(userVersion(core)).toBe(1);
    } finally {
      playback.close();
      core.close();
    }
  });
});
