/**
 * @req STOR-USE-02[badger-mobile]
 * @req LIB-FMT-02[ci]
 *
 * The phone's metadata step 4 on a real SQLite file (node:sqlite) in the old format: `media_files` without
 * `original_size_bytes`. The step adds the column and keeps every file; a second run changes nothing.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { metadataMigrations } from "../src/lib/libraryMigrations";

vi.mock("react-native-quick-crypto", () => ({ default: { randomBytes: (size: number) => Buffer.alloc(size) } }));

const log = (phase: string, data: unknown) => console.info(`[library-original-size-migration] ${phase}`, JSON.stringify(data));

const asPhoneDb = (db: DatabaseSync) => ({
  executeSql: async (sql: string, params: unknown[] = []) => {
    const statement = db.prepare(sql);
    const rows = statement.columns().length
      ? (statement.all(...(params as SQLInputValue[])) as Record<string, unknown>[])
      : (statement.run(...(params as SQLInputValue[])), []);
    return [{ rows: { length: rows.length, item: (i: number) => rows[i] } }];
  },
});

describe("phone metadata step 4: media_files.original_size_bytes", () => {
  it("STOR-USE-02 adds the column and keeps every file, once", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE media_files (
      id TEXT PRIMARY KEY, media_id TEXT NOT NULL, filename TEXT NOT NULL, season INTEGER, episode INTEGER,
      added_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'local', template_id TEXT, edition_id TEXT, content_sha256 TEXT)`);
    db.prepare("INSERT INTO media_files (id, media_id, filename, added_at, edition_id) VALUES (?, ?, ?, ?, ?)").run(
      "f-sintel", "sintel", "Sintel.mkv", "2026-01-01T00:00:00.000Z", "ed-sintel-x-x"
    );
    const step = metadataMigrations.find((migration) => migration.version === 4)!;
    expect(step.description).toBe("media_files_original_size_v4");
    const phoneDb = asPhoneDb(db) as unknown as Parameters<typeof step.up>[0];
    await step.up(phoneDb);
    await step.up(phoneDb);
    const columns = (db.prepare("PRAGMA table_info(media_files)").all() as Array<{ name: string }>).map((c) => c.name);
    const files = db.prepare("SELECT id, edition_id, original_size_bytes FROM media_files").all();
    log("after", { columns, files });
    expect(columns).toContain("original_size_bytes");
    expect(files).toEqual([{ id: "f-sintel", edition_id: "ed-sintel-x-x", original_size_bytes: null }]);
  });
});
