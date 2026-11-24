/**
 * @test-id MOBILE-RESEAL-DB-001
 * @level unit
 * @req STOR-RESEAL-01[badger-mobile]
 * @why The phone's key change renames its library's references to the re-sealed copies through
 *   react-native-sqlite-storage, which carries no BLOB bytes: a BLOB comes back as base64 text and a bound byte array
 *   is no BLOB. A packed chunk list (`media_chunk_lists`) read or written as bytes would come out empty or wrong and
 *   every video would stop playing after the switch. `sqliteStorageResealDb` reads BLOBs as hex and writes them as
 *   `X'..'`; the test runs the rewrite over real SQLite behind a driver that behaves like the bridge.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { packChunkList, unpackChunkList, CHUNK_LIST_KEY_MODE } from "@space/library-db-definition/chunkLists";
import { ALL_LIBRARY_DB_GROUPS } from "@space/library-db-definition/manifest";
import { getGroupDdlStatements } from "@space/library-db-definition/migrations";
import { rewriteBadgerReferences } from "@space/media-reseal";
import { describe, expect, it } from "vitest";
import { sqliteStorageResealDb } from "../src/lib/library/resealDb";

const P = "0f0e0d0c-0b0a-4908-8706-050403020100";
const media = (n: number) => `media/${P}/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const toValue = (value: unknown): SQLInputValue => {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new Error(`the bridge carries no ${value instanceof Uint8Array ? "Uint8Array" : typeof value} parameter`);
};

/** react-native-sqlite-storage on Android: BLOB results as base64 text, byte-array parameters refused. */
const bridgeLike = (db: DatabaseSync) => ({
  executeSql: async (sql: string, params: unknown[] = []) => {
    const statement = db.prepare(sql);
    const values = params.map(toValue);
    if (statement.columns().length === 0) {
      statement.run(...values);
      return [{ rows: { length: 0, item: () => ({}) }, rowsAffected: 0 }];
    }
    const rows = statement
      .all(...values)
      .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v])));
    return [{ rows: { length: rows.length, item: (i: number) => rows[i] }, rowsAffected: 0 }];
  },
});

describe("sqliteStorageResealDb (STOR-RESEAL-01)", () => {
  it("repacks a chunk list and renames plain columns through a driver that carries no bytes", async () => {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    for (const group of ALL_LIBRARY_DB_GROUPS) for (const sql of getGroupDdlStatements(group)) db.exec(sql);
    const list = packChunkList([
      { key: media(1), sizeBytes: 10, startSeconds: 0 },
      { key: media(2), sizeBytes: 20, startSeconds: 2 },
    ]);
    db.prepare(
      `INSERT INTO media_chunk_lists (owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at)
       VALUES ('fmt', 1, ?, ?, ?, ?, ?, ?, '2020-01-01T00:00:00.000Z')`
    ).run(list.placementId, list.keyMode, list.keyData, list.count, list.sizes, list.starts);
    // A subtitle row: its other NOT NULL columns without a default get a placeholder of their type.
    const subtitle: Record<string, SQLInputValue> = { id: "s1", object_key: media(3) };
    for (const info of db.prepare("PRAGMA table_info(media_subtitles)").all()) {
      const name = String(info.name);
      if (name in subtitle || Number(info.notnull) !== 1 || info.dflt_value !== null) continue;
      const type = String(info.type).toUpperCase();
      subtitle[name] = type.includes("INT") || type.includes("REAL") ? 0 : `media_subtitles-${name}`;
    }
    const names = Object.keys(subtitle);
    db.prepare(`INSERT INTO media_subtitles (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
      ...names.map((name) => subtitle[name]!)
    );
    const adapter = sqliteStorageResealDb(bridgeLike(db));

    const rewrite = await rewriteBadgerReferences(
      adapter,
      new Map([
        [media(2), media(102)],
        [media(3), media(103)],
      ])
    );

    const row = db.prepare("SELECT * FROM media_chunk_lists WHERE owner_id = 'fmt'").get()!;
    const bytes = (value: unknown) => (value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(0));
    expect(row.key_data).toBeInstanceOf(Uint8Array);
    expect(
      unpackChunkList({
        placementId: String(row.placement_id),
        keyMode: CHUNK_LIST_KEY_MODE.uuidBytes,
        keyData: bytes(row.key_data),
        count: Number(row.count),
        sizes: bytes(row.sizes),
        starts: row.starts == null ? null : bytes(row.starts),
      })
    ).toEqual([
      { key: media(1), sizeBytes: 10, startSeconds: 0 },
      { key: media(102), sizeBytes: 20, startSeconds: 2 },
    ]);
    expect(db.prepare("SELECT object_key FROM media_subtitles WHERE id = 's1'").get()?.object_key).toBe(media(103));
    expect(rewrite.byColumn).toEqual({ "media_subtitles.object_key": 1, "media_chunk_lists.key_data": 1 });
  });
});
