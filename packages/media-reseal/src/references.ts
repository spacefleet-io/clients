/**
 * Rewriting a library's references from the old objects to their re-sealed copies (STOR-RESEAL-01), in the device's
 * local library database, before the key change seals and publishes it under the new key. Kept objects
 * (STOR-RESEAL-05) and objects with no copy keep their key.
 *
 * Badger (@space/library-db-definition) refers to media objects from:
 *   - plain key columns: format and audio-track init pieces, per-chunk rows, subtitles, and their template twins;
 *   - artwork columns, `asset:<content type>::<key>` or a bare key (`artworkStorageKey`): posters, backdrops, season
 *     posters, episode stills, cast and crew photos;
 *   - `media_formats.preview_sheets`, JSON whose `sheets[].objectKey` are the seek-bar preview sheets (MPV-PREV-01);
 *   - packed chunk lists (`media_chunk_lists`, LIB-FMT-11): unpacked, renamed and packed again. A list whose keys are
 *     all `media/<placement>/<uuid>` packs as key mode 1, so a seeded list (mode 2) becomes mode 1 (a seed cannot name
 *     a copy).
 * Parrot (@space/parrot-library-db-definition) refers to them from plain key columns only.
 *
 * Badger's library is split over several group files: each is rewritten on its own, and a table a file does not hold is
 * skipped.
 */
import {
  CHUNK_LIST_KEY_MODE,
  packChunkList,
  type PackedChunkList,
  unpackChunkList,
  type ChunkListKeyMode,
} from "@space/library-db-definition/chunkLists";
import { artworkStorageKey } from "@space/library-db-definition/mediaDetails";

export type ResealSqlValue = string | number | null | Uint8Array;
export type ResealSqlRow = Record<string, unknown>;

/** The database calls the rewrite needs; a synchronous driver is wrapped by `preparedResealDb`. */
export type ResealSqlDb = {
  all(sql: string, params?: ResealSqlValue[]): Promise<ResealSqlRow[]>;
  run(sql: string, params?: ResealSqlValue[]): Promise<void>;
};

/** A `prepare`-style driver: node:sqlite `DatabaseSync`, bun:sqlite, better-sqlite3. */
export type PreparedSqlDb = {
  prepare(sql: string): { all(...params: ResealSqlValue[]): unknown[]; run(...params: ResealSqlValue[]): unknown };
};

export const preparedResealDb = (db: PreparedSqlDb): ResealSqlDb => ({
  all: async (sql, params = []) => db.prepare(sql).all(...params).filter((row): row is ResealSqlRow => typeof row === "object" && row !== null),
  run: async (sql, params = []) => {
    db.prepare(sql).run(...params);
  },
});

/** References rewritten, per `table.column`. */
export type ReferenceRewrite = { references: number; byColumn: Record<string, number> };

type Column = { table: string; column: string };

const BADGER_KEY_COLUMNS: ReadonlyArray<Column> = [
  { table: "media_formats", column: "init_key" },
  { table: "media_format_chunks", column: "chunk_key" },
  { table: "media_audio_tracks", column: "init_key" },
  { table: "media_audio_chunks", column: "chunk_key" },
  { table: "media_subtitles", column: "object_key" },
  { table: "media_template_formats", column: "init_key" },
  { table: "media_template_format_chunks", column: "chunk_key" },
  { table: "media_template_audio_tracks", column: "init_key" },
  { table: "media_template_audio_chunks", column: "chunk_key" },
  { table: "media_template_subtitles", column: "object_key" },
];

/** Artwork columns; every table here has an `id` primary key. */
const BADGER_ARTWORK_COLUMNS: ReadonlyArray<Column> = [
  { table: "media_items", column: "poster_path" },
  { table: "media_items", column: "backdrop_path" },
  { table: "people", column: "profile_path" },
  { table: "media_seasons", column: "poster_path" },
  { table: "media_episodes", column: "still_path" },
];

const PARROT_KEY_COLUMNS: ReadonlyArray<Column> = [
  { table: "artists", column: "picture_object_key" },
  { table: "artists", column: "picture_thumb_object_key" },
  { table: "albums", column: "cover_object_key" },
  { table: "albums", column: "cover_thumb_object_key" },
  { table: "track_files", column: "tags_object_key" },
  { table: "track_file_chunks", column: "object_key" },
];

const MAP_TABLE = "temp.sf_reseal_map";
/** Rows per INSERT: two parameters each, under SQLite's oldest bound-parameter limit (999). */
const MAP_INSERT_ROWS = 400;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string) => {
  if (!IDENTIFIER.test(name)) throw new Error(`reseal_bad_identifier:${name}`);
  return name;
};

const columnsOf = async (db: ResealSqlDb, table: string): Promise<Set<string>> =>
  new Set((await db.all(`PRAGMA table_info(${ident(table)})`)).map((row) => String(row.name)));

const has = async (db: ResealSqlDb, cache: Map<string, Set<string>>, { table, column }: Column) => {
  let columns = cache.get(table);
  if (!columns) {
    columns = await columnsOf(db, table);
    cache.set(table, columns);
  }
  return columns.has(column);
};

const count = (rewrite: ReferenceRewrite, key: string, n: number) => {
  if (n === 0) return;
  rewrite.references += n;
  rewrite.byColumn[key] = (rewrite.byColumn[key] ?? 0) + n;
};

/** Loads the copies into a temporary table, so each plain column is rewritten by one statement. */
const loadMap = async (db: ResealSqlDb, copies: ReadonlyMap<string, string>) => {
  await db.run(`CREATE TEMP TABLE IF NOT EXISTS sf_reseal_map (old_key TEXT PRIMARY KEY, new_key TEXT NOT NULL)`);
  await db.run(`DELETE FROM ${MAP_TABLE}`);
  const entries = [...copies];
  for (let i = 0; i < entries.length; i += MAP_INSERT_ROWS) {
    const batch = entries.slice(i, i + MAP_INSERT_ROWS);
    await db.run(`INSERT OR REPLACE INTO ${MAP_TABLE} (old_key, new_key) VALUES ${batch.map(() => "(?, ?)").join(", ")}`, batch.flat());
  }
};

const rewriteKeyColumns = async (db: ResealSqlDb, columns: ReadonlyArray<Column>, cache: Map<string, Set<string>>, rewrite: ReferenceRewrite) => {
  for (const target of columns) {
    if (!(await has(db, cache, target))) continue;
    const table = ident(target.table);
    const column = ident(target.column);
    const [row] = await db.all(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (SELECT old_key FROM ${MAP_TABLE})`);
    const n = Number(row?.n ?? 0);
    if (n === 0) continue;
    await db.run(
      `UPDATE ${table} SET ${column} = (SELECT new_key FROM ${MAP_TABLE} WHERE old_key = ${table}.${column})
       WHERE ${column} IN (SELECT old_key FROM ${MAP_TABLE})`
    );
    count(rewrite, `${table}.${column}`, n);
  }
};

const rewriteArtwork = async (db: ResealSqlDb, copies: ReadonlyMap<string, string>, cache: Map<string, Set<string>>, rewrite: ReferenceRewrite) => {
  for (const target of BADGER_ARTWORK_COLUMNS) {
    if (!(await has(db, cache, target))) continue;
    const table = ident(target.table);
    const column = ident(target.column);
    const rows = await db.all(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`);
    let n = 0;
    for (const row of rows) {
      const value = String(row.value);
      const key = artworkStorageKey(value);
      const copy = key ? copies.get(key) : undefined;
      if (!key || !copy) continue;
      // The key is the value's end in both forms (bare, or after `asset:<type>::`).
      await db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [value.slice(0, value.length - key.length) + copy, String(row.id)]);
      n += 1;
    }
    count(rewrite, `${table}.${column}`, n);
  }
};

const rewritePreviewSheets = async (
  db: ResealSqlDb,
  copies: ReadonlyMap<string, string>,
  cache: Map<string, Set<string>>,
  rewrite: ReferenceRewrite
) => {
  if (!(await has(db, cache, { table: "media_formats", column: "preview_sheets" }))) return;
  const rows = await db.all(`SELECT id, preview_sheets AS value FROM media_formats WHERE preview_sheets IS NOT NULL AND preview_sheets <> ''`);
  let n = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.value));
    } catch {
      continue;
    }
    const sheets = typeof parsed === "object" && parsed !== null && "sheets" in parsed ? parsed.sheets : undefined;
    if (!Array.isArray(sheets)) continue;
    let changed = 0;
    for (const sheet of sheets) {
      if (typeof sheet !== "object" || sheet === null || !("objectKey" in sheet) || typeof sheet.objectKey !== "string") continue;
      const copy = copies.get(sheet.objectKey);
      if (!copy) continue;
      sheet.objectKey = copy;
      changed += 1;
    }
    if (changed === 0) continue;
    await db.run(`UPDATE media_formats SET preview_sheets = ? WHERE id = ?`, [JSON.stringify(parsed), String(row.id)]);
    n += changed;
  }
  count(rewrite, "media_formats.preview_sheets", n);
};

const asBytes = (value: unknown): Uint8Array => (value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(0));

const KEY_MODES: ReadonlyArray<ChunkListKeyMode> = Object.values(CHUNK_LIST_KEY_MODE);
const asKeyMode = (value: unknown): ChunkListKeyMode => {
  const mode = KEY_MODES.find((m) => m === Number(value));
  if (mode === undefined) throw new Error(`media_chunk_lists: unknown key_mode ${String(value)}`);
  return mode;
};

const rewriteChunkLists = async (db: ResealSqlDb, copies: ReadonlyMap<string, string>, cache: Map<string, Set<string>>, rewrite: ReferenceRewrite) => {
  if (!(await has(db, cache, { table: "media_chunk_lists", column: "key_data" }))) return;
  const rows = await db.all(`SELECT owner_id, placement_id, key_mode, key_data, count, sizes, starts FROM media_chunk_lists`);
  let n = 0;
  for (const row of rows) {
    const list: PackedChunkList = {
      placementId: String(row.placement_id ?? ""),
      keyMode: asKeyMode(row.key_mode),
      keyData: asBytes(row.key_data),
      count: Number(row.count),
      sizes: asBytes(row.sizes),
      starts: row.starts == null ? null : asBytes(row.starts),
    };
    const chunks = unpackChunkList(list);
    let changed = 0;
    const renamed = chunks.map((chunk) => {
      const copy = copies.get(chunk.key);
      if (!copy) return chunk;
      changed += 1;
      return { ...chunk, key: copy };
    });
    if (changed === 0) continue;
    const packed = packChunkList(renamed);
    await db.run(
      `UPDATE media_chunk_lists SET placement_id = ?, key_mode = ?, key_data = ?, count = ?, sizes = ?, starts = ?, updated_at = ? WHERE owner_id = ?`,
      [packed.placementId, packed.keyMode, packed.keyData, packed.count, packed.sizes, packed.starts, new Date().toISOString(), String(row.owner_id)]
    );
    n += changed;
  }
  count(rewrite, "media_chunk_lists.key_data", n);
};

const withMap = async (db: ResealSqlDb, copies: ReadonlyMap<string, string>, work: () => Promise<void>) => {
  if (copies.size === 0) return;
  await loadMap(db, copies);
  try {
    await work();
  } finally {
    await db.run(`DROP TABLE IF EXISTS ${MAP_TABLE}`);
  }
};

/** Rewrites one Badger library file (any group) from old keys to copies; `copies` maps old key → copy key. */
export const rewriteBadgerReferences = async (db: ResealSqlDb, copies: ReadonlyMap<string, string>): Promise<ReferenceRewrite> => {
  const rewrite: ReferenceRewrite = { references: 0, byColumn: {} };
  const cache = new Map<string, Set<string>>();
  await withMap(db, copies, async () => {
    await rewriteKeyColumns(db, BADGER_KEY_COLUMNS, cache, rewrite);
    await rewriteArtwork(db, copies, cache, rewrite);
    await rewritePreviewSheets(db, copies, cache, rewrite);
    await rewriteChunkLists(db, copies, cache, rewrite);
  });
  return rewrite;
};

/** Rewrites the Parrot library from old keys to copies; `copies` maps old key → copy key. */
export const rewriteParrotReferences = async (db: ResealSqlDb, copies: ReadonlyMap<string, string>): Promise<ReferenceRewrite> => {
  const rewrite: ReferenceRewrite = { references: 0, byColumn: {} };
  const cache = new Map<string, Set<string>>();
  await withMap(db, copies, () => rewriteKeyColumns(db, PARROT_KEY_COLUMNS, cache, rewrite));
  return rewrite;
};
