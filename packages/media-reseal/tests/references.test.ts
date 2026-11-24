import { DatabaseSync } from "node:sqlite";
import { CHUNK_LIST_KEY_MODE, packChunkList, packSeededChunkList, unpackChunkList } from "@space/library-db-definition/chunkLists";
import { ALL_LIBRARY_DB_GROUPS } from "@space/library-db-definition/manifest";
import { getGroupDdlStatements } from "@space/library-db-definition/migrations";
import { PARROT_LIBRARY_SCHEMA_VERSION, parrotLibraryMigrationStatements } from "@space/parrot-library-db-definition/migrations";
import { describe, expect, it } from "vitest";
import { preparedResealDb, rewriteBadgerReferences, rewriteParrotReferences, type ResealSqlValue } from "../src/references";

type Value = ResealSqlValue;

/** Inserts a row, filling every other NOT NULL column without a default with a placeholder of its type. */
const insert = (db: DatabaseSync, table: string, values: Record<string, Value>) => {
  const row: Record<string, Value> = { ...values };
  for (const info of db.prepare(`PRAGMA table_info(${table})`).all()) {
    const name = String(info.name);
    if (name in row || Number(info.notnull) !== 1 || info.dflt_value !== null) continue;
    const type = String(info.type).toUpperCase();
    row[name] = type.includes("INT") || type.includes("REAL") ? 0 : type.includes("BLOB") ? new Uint8Array(0) : `${table}-${name}`;
  }
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((n) => row[n]!));
};

const one = (db: DatabaseSync, sql: string, ...params: Value[]) => db.prepare(sql).get(...params);

const P = "0f0e0d0c-0b0a-4908-8706-050403020100";
const bytes = (value: unknown) => (value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(0));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const media = (n: number) => `media/${P}/${uuid(n)}`;

describe("rewriteBadgerReferences (STOR-RESEAL-01)", () => {
  /** Every group's current schema in one file; rows are placed one table at a time, without their parents. */
  const badger = () => {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    for (const group of ALL_LIBRARY_DB_GROUPS) for (const sql of getGroupDdlStatements(group)) db.exec(sql);
    return db;
  };

  it("renames plain key columns, artwork in both forms, preview sheets and nothing else", async () => {
    const db = badger();
    insert(db, "media_formats", {
      id: "f1",
      init_key: media(1),
      preview_sheets: JSON.stringify({ interval: 10, sheets: [{ objectKey: media(2), count: 4 }, { objectKey: media(9) }] }),
    });
    insert(db, "media_subtitles", { id: "s1", object_key: media(3) });
    insert(db, "media_items", { id: "m1", poster_path: `asset:image/jpeg::${media(4)}`, backdrop_path: media(5) });
    insert(db, "media_items", { id: "m2", poster_path: "https://images.example.com/w500/x.jpg", backdrop_path: media(8) });
    const copies = new Map([
      [media(1), media(101)],
      [media(2), media(102)],
      [media(3), media(103)],
      [media(4), media(104)],
      [media(5), media(105)],
    ]);

    const rewrite = await rewriteBadgerReferences(preparedResealDb(db), copies);

    expect(one(db, "SELECT init_key FROM media_formats WHERE id = 'f1'")?.init_key).toBe(media(101));
    const sheets = JSON.parse(String(one(db, "SELECT preview_sheets FROM media_formats WHERE id = 'f1'")?.preview_sheets));
    expect(sheets).toEqual({ interval: 10, sheets: [{ objectKey: media(102), count: 4 }, { objectKey: media(9) }] });
    expect(one(db, "SELECT object_key FROM media_subtitles WHERE id = 's1'")?.object_key).toBe(media(103));
    expect(one(db, "SELECT poster_path, backdrop_path FROM media_items WHERE id = 'm1'")).toEqual({
      poster_path: `asset:image/jpeg::${media(104)}`,
      backdrop_path: media(105),
    });
    // Not stored by us, or with no copy (kept): left alone.
    expect(one(db, "SELECT poster_path, backdrop_path FROM media_items WHERE id = 'm2'")).toEqual({
      poster_path: "https://images.example.com/w500/x.jpg",
      backdrop_path: media(8),
    });
    expect(rewrite.references).toBe(5);
    expect(rewrite.byColumn).toEqual({
      "media_formats.init_key": 1,
      "media_subtitles.object_key": 1,
      "media_items.poster_path": 1,
      "media_items.backdrop_path": 1,
      "media_formats.preview_sheets": 1,
    });
    expect(db.prepare(`SELECT name FROM temp.sqlite_master WHERE name = 'sf_reseal_map'`).all()).toEqual([]);
  });

  it("repacks chunk lists: mode 1 stays mode 1, a seeded list (mode 2) becomes mode 1 with the copies", async () => {
    const db = badger();
    const byUuid = packChunkList([
      { key: media(11), sizeBytes: 100, startSeconds: 0 },
      { key: media(12), sizeBytes: 200, startSeconds: 4 },
    ]);
    expect(byUuid.keyMode).toBe(CHUNK_LIST_KEY_MODE.uuidBytes);
    const seeded = packSeededChunkList({ placementId: P, seed: new Uint8Array(16).fill(7), sizes: [300, 400], starts: [0, 6] });
    const seededChunks = unpackChunkList(seeded);
    const untouched = packChunkList([{ key: media(13), sizeBytes: 50, startSeconds: null }]);
    for (const [owner, list] of [["fmt-a", byUuid], ["fmt-b", seeded], ["fmt-c", untouched]] as const) {
      insert(db, "media_chunk_lists", {
        owner_id: owner,
        owner_kind: 1,
        placement_id: list.placementId,
        key_mode: list.keyMode,
        key_data: list.keyData,
        count: list.count,
        sizes: list.sizes,
        starts: list.starts,
        updated_at: "2020-01-01T00:00:00.000Z",
      });
    }
    const copies = new Map([
      [media(12), media(112)],
      [seededChunks[0]!.key, media(120)],
      [seededChunks[1]!.key, media(121)],
    ]);

    const rewrite = await rewriteBadgerReferences(preparedResealDb(db), copies);

    const read = (owner: string) => {
      const row = one(db, "SELECT * FROM media_chunk_lists WHERE owner_id = ?", owner)!;
      const list = {
        placementId: String(row.placement_id),
        keyMode: CHUNK_LIST_KEY_MODE.uuidBytes,
        keyData: bytes(row.key_data),
        count: Number(row.count),
        sizes: bytes(row.sizes),
        starts: row.starts == null ? null : bytes(row.starts),
      };
      expect(Number(row.key_mode)).toBe(CHUNK_LIST_KEY_MODE.uuidBytes);
      return { chunks: unpackChunkList(list), updatedAt: String(row.updated_at) };
    };
    expect(read("fmt-a").chunks).toEqual([
      { key: media(11), sizeBytes: 100, startSeconds: 0 },
      { key: media(112), sizeBytes: 200, startSeconds: 4 },
    ]);
    expect(read("fmt-a").updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(read("fmt-b").chunks).toEqual([
      { key: media(120), sizeBytes: 300, startSeconds: 0 },
      { key: media(121), sizeBytes: 400, startSeconds: 6 },
    ]);
    expect(read("fmt-c")).toEqual({ chunks: [{ key: media(13), sizeBytes: 50, startSeconds: null }], updatedAt: "2020-01-01T00:00:00.000Z" });
    expect(rewrite.byColumn).toEqual({ "media_chunk_lists.key_data": 3 });
  });

  it("skips a group file that holds none of the tables, and does nothing without copies", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    expect(await rewriteBadgerReferences(preparedResealDb(db), new Map([[media(1), media(2)]]))).toEqual({ references: 0, byColumn: {} });
    expect(await rewriteBadgerReferences(preparedResealDb(badger()), new Map())).toEqual({ references: 0, byColumn: {} });
  });
});

describe("rewriteParrotReferences (STOR-RESEAL-01)", () => {
  it("renames covers, pictures, tags and song chunks", async () => {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    for (const statement of parrotLibraryMigrationStatements(0, PARROT_LIBRARY_SCHEMA_VERSION)) db.exec(statement);
    insert(db, "albums", { id: "al1", cover_object_key: media(1), cover_thumb_object_key: media(2) });
    insert(db, "artists", { id: "ar1", picture_object_key: media(3), picture_thumb_object_key: null });
    insert(db, "track_files", { id: "tf1", tags_object_key: media(4) });
    insert(db, "track_file_chunks", { track_file_id: "tf1", idx: 0, object_key: media(5) });
    insert(db, "track_file_chunks", { track_file_id: "tf1", idx: 1, object_key: media(6) });
    // Many copies: the map is loaded in several INSERTs (two parameters a row, 400 rows each).
    const copies = new Map(Array.from({ length: 1000 }, (_, i) => [media(1000 + i), media(5000 + i)] as const));
    for (const n of [1, 2, 3, 4, 5]) copies.set(media(n), media(100 + n));

    const rewrite = await rewriteParrotReferences(preparedResealDb(db), copies);

    expect(one(db, "SELECT cover_object_key, cover_thumb_object_key FROM albums")).toEqual({
      cover_object_key: media(101),
      cover_thumb_object_key: media(102),
    });
    expect(one(db, "SELECT picture_object_key, picture_thumb_object_key FROM artists")).toEqual({
      picture_object_key: media(103),
      picture_thumb_object_key: null,
    });
    expect(one(db, "SELECT tags_object_key FROM track_files")?.tags_object_key).toBe(media(104));
    expect(db.prepare("SELECT object_key FROM track_file_chunks ORDER BY idx").all()).toEqual([{ object_key: media(105) }, { object_key: media(6) }]);
    expect(rewrite.references).toBe(5);
  });
});
