/**
 * @req STOR-USE-02
 * @req LIB-FMT-02
 *
 * Desktop metadata step 3 on a library in the old format (`media_files` without `original_size_bytes`), then the
 * runtime backfill from the playback file's source copy: the column is added, files and their rows are kept, older
 * files get their source copy's bytes, a recorded size is never overwritten, and the backfill runs once.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { desktopMetadataMigrations } from "../src/desktopMigrations";
import { backfillOriginalSizeFromSourceFormats } from "@space/library-db-definition/originalSize";
import type { SqliteDb } from "@space/library-db-definition/migrations";

const log = (phase: string, data: unknown) => console.info(`[original-size-upgrade] ${phase}`, JSON.stringify(data));
// bun:sqlite's bindings are narrower than the driver-neutral shape the migrations take (same cast as backfill-has-files-across-dbs).
const asDb = (db: Database) => db as unknown as SqliteDb;

describe("desktop metadata step 3: media_files.original_size_bytes", () => {
  it("STOR-USE-02 adds the column, keeps every file and backfills from the source copy once", () => {
    const core = new Database(":memory:");
    const metadata = new Database(":memory:");
    const playback = new Database(":memory:");
    core.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    metadata.exec(`CREATE TABLE media_files (
      id TEXT PRIMARY KEY, media_id TEXT NOT NULL, filename TEXT NOT NULL, season INTEGER, episode INTEGER,
      added_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'local', template_id TEXT, edition_id TEXT, content_sha256 TEXT)`);
    const insert = metadata.prepare("INSERT INTO media_files (id, media_id, filename, added_at) VALUES (?, ?, ?, ?)");
    insert.run("f-source", "sintel", "Sintel.mkv", "2026-01-01T00:00:00.000Z");
    insert.run("f-unmarked", "tos", "Tears.mkv", "2026-01-02T00:00:00.000Z");
    insert.run("f-nothing", "show", "Show.mkv", "2026-01-03T00:00:00.000Z");
    playback.exec(`CREATE TABLE media_formats (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, total_size INTEGER,
      is_source INTEGER NOT NULL DEFAULT 0)`);
    const format = playback.prepare("INSERT INTO media_formats (id, file_id, total_size, is_source) VALUES (?, ?, ?, ?)");
    format.run("fmt-src", "f-source", 3_000_000, 1);
    format.run("fmt-360", "f-source", 400_000, 0);
    format.run("fmt-a", "f-unmarked", 900_000, 0);
    format.run("fmt-b", "f-unmarked", 2_000_000, 0);

    log("phase.migrate", { before: metadata.prepare("PRAGMA table_info(media_files)").all().length });
    const step = desktopMetadataMigrations.find((m) => m.version === 3)!;
    expect(step.description).toBe("media_files_original_size");
    step.up(asDb(metadata));
    step.up(asDb(metadata));
    const columns = (metadata.prepare("PRAGMA table_info(media_files)").all() as Array<{ name: string }>).map((c) => c.name);
    log("phase.columns", columns);
    expect(columns).toContain("original_size_bytes");
    expect(metadata.prepare("SELECT COUNT(*) AS n FROM media_files").get()).toEqual({ n: 3 });

    log("phase.backfill", {});
    const filled = backfillOriginalSizeFromSourceFormats(asDb(core), asDb(metadata), asDb(playback));
    const rows = metadata.prepare("SELECT id, original_size_bytes FROM media_files ORDER BY id").all();
    log("phase.after_backfill", { filled, rows });
    expect(filled).toBe(2);
    expect(rows).toEqual([
      { id: "f-nothing", original_size_bytes: null },
      { id: "f-source", original_size_bytes: 3_000_000 },
      { id: "f-unmarked", original_size_bytes: 2_000_000 },
    ]);

    metadata.prepare("UPDATE media_files SET original_size_bytes = NULL WHERE id = 'f-source'").run();
    const second = backfillOriginalSizeFromSourceFormats(asDb(core), asDb(metadata), asDb(playback));
    log("phase.second_run", { second, marker: core.prepare("SELECT key, value FROM app_settings").all() });
    expect(second).toBe(0);
    expect(metadata.prepare("SELECT original_size_bytes AS b FROM media_files WHERE id = 'f-source'").get()).toEqual({ b: null });
  });
});
