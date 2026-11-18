/**
 * @req LIB-EDIT-02
 *
 * The phone's metadata step 3 (media_editions) on a real SQLite file (node:sqlite) in the old format: `media_files`
 * without `edition_id` / `content_sha256`, two films and an episode. After the step every film and episode has one
 * unnamed edition holding all of its files; a second run changes nothing.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { metadataMigrations } from "../src/lib/libraryMigrations";

// Hoisted above the imports: the playback-blob helper the migrations import pulls react-native-quick-crypto.
vi.mock("react-native-quick-crypto", () => ({ default: { randomBytes: (size: number) => Buffer.alloc(size) } }));

const log = (phase: string, data: unknown) => console.info(`[library-editions-migration] ${phase}`, JSON.stringify(data));

/** react-native-sqlite-storage's `executeSql` over node:sqlite: what the migration's `up` calls. */
const asPhoneDb = (db: DatabaseSync) => ({
  executeSql: async (sql: string, params: unknown[] = []) => {
    const statement = db.prepare(sql);
    const rows = statement.columns().length
      ? (statement.all(...(params as SQLInputValue[])) as Record<string, unknown>[])
      : (statement.run(...(params as SQLInputValue[])), []);
    return [{ rows: { length: rows.length, item: (i: number) => rows[i] } }];
  },
});

describe("phone metadata step 3: media_editions", () => {
  it("gives every film and episode one unnamed edition holding all of its files, once", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE media_files (
      id TEXT PRIMARY KEY, media_id TEXT NOT NULL, filename TEXT NOT NULL, season INTEGER, episode INTEGER,
      added_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'local', template_id TEXT)`);
    const insert = db.prepare("INSERT INTO media_files (id, media_id, filename, season, episode, added_at) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("f-sintel-a", "sintel", "Sintel.1080p.mkv", null, null, "2026-01-02T00:00:00.000Z");
    insert.run("f-sintel-b", "sintel", "Sintel.720p.mkv", null, null, "2026-01-01T00:00:00.000Z");
    insert.run("f-tos", "tos", "Tears.of.Steel.mkv", null, null, "2026-01-03T00:00:00.000Z");
    insert.run("f-show", "show", "Show.S02E05.mkv", 2, 5, "2026-01-04T00:00:00.000Z");

    const step = metadataMigrations.find((migration) => migration.version === 3)!;
    expect(step.description).toBe("media_editions_v3");
    const phoneDb = asPhoneDb(db) as unknown as Parameters<typeof step.up>[0];
    await step.up(phoneDb);
    const editions = db.prepare("SELECT id, media_id, season, episode, name, created_at FROM media_editions ORDER BY id").all();
    const files = db.prepare("SELECT id, edition_id, content_sha256 FROM media_files ORDER BY id").all();
    log("after first run", { editions, files });
    expect(editions).toEqual([
      { id: "ed-show-2-5", media_id: "show", season: 2, episode: 5, name: "", created_at: "2026-01-04T00:00:00.000Z" },
      { id: "ed-sintel-x-x", media_id: "sintel", season: null, episode: null, name: "", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "ed-tos-x-x", media_id: "tos", season: null, episode: null, name: "", created_at: "2026-01-03T00:00:00.000Z" },
    ]);
    expect(files).toEqual([
      { id: "f-show", edition_id: "ed-show-2-5", content_sha256: null },
      { id: "f-sintel-a", edition_id: "ed-sintel-x-x", content_sha256: null },
      { id: "f-sintel-b", edition_id: "ed-sintel-x-x", content_sha256: null },
      { id: "f-tos", edition_id: "ed-tos-x-x", content_sha256: null },
    ]);

    await step.up(phoneDb);
    expect(db.prepare("SELECT id, media_id, season, episode, name, created_at FROM media_editions ORDER BY id").all()).toEqual(editions);
    expect(db.prepare("SELECT id, edition_id, content_sha256 FROM media_files ORDER BY id").all()).toEqual(files);
  });
});
