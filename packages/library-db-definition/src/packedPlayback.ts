/**
 * The packed playback layout of vault v4 (LIB-FMT-11/12): its tables and the playback group's conversion step.
 * Browser-safe (no Node imports), so the web player runs the same step as desktop and phone.
 */
import { CHUNK_LIST_OWNER_KIND, packChunkList } from "./chunkLists";

/** The driver shape the step needs: `better-sqlite3`, `bun:sqlite`, sql.js wrappers (same as `migrations.ts` `SqliteDb`). */
export type PackedPlaybackDb = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    all: () => unknown[];
    run: (...params: Array<string | number | Uint8Array | null>) => unknown;
  };
};

/**
 * The packed playback tables (LIB-FMT-11, vault v4 plan §1.2). Part of the base playback DDL, so every build from
 * version 4 on has them — EMPTY until the account is switched and `convertPlaybackToPackedLayout` runs (LIB-FMT-13).
 * Empty tables write no data and leave the group's `user_version` alone; the manifest lists them so split and export
 * copy them. So their presence says nothing about the layout. `media_file_playback` is the per-file playback clock
 * (LIB-SYNC-08); its `file_id` is `playbackFileKey` (`''` = no file).
 */
export const PACKED_PLAYBACK_DDL: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS media_chunk_lists (
    owner_id TEXT PRIMARY KEY,
    owner_kind INTEGER NOT NULL,
    placement_id TEXT NOT NULL,
    key_mode INTEGER NOT NULL,
    key_data BLOB NOT NULL,
    count INTEGER NOT NULL,
    sizes BLOB NOT NULL,
    starts BLOB,
    updated_at TEXT NOT NULL
  ) WITHOUT ROWID;`,
  `CREATE TABLE IF NOT EXISTS media_file_playback (
    media_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(media_id, file_id)
  ) WITHOUT ROWID;`,
];

type ChunkRow = { owner: string; chunk_key: string; size_bytes: number | null; start_seconds: number | null };

/**
 * The playback group's conversion step (LIB-FMT-12, vault v4 plan §1.2): packs every format's and audio track's
 * per-chunk rows into one `media_chunk_lists` row each (key mode 0 or 1, never a seed; owners come from the chunk
 * rows), then empties the per-chunk tables (kept, LIB-FMT-03). Atomic (a savepoint, so it nests in the caller's
 * transaction) and idempotent: with the per-chunk tables empty it changes nothing, so a switched account may run it
 * on any group file it receives. Writes no clock rows: a file's clock starts with its first
 * `media.file.playback.set`. Each registry registers it under its own next playback version, run only once the
 * account is switched (LIB-FMT-13).
 */
export const convertPlaybackToPackedLayout = (db: PackedPlaybackDb, nowIso: string): { lists: number; rows: number } => {
  db.exec("SAVEPOINT convert_playback_packed;");
  try {
    for (const statement of PACKED_PLAYBACK_DDL) db.exec(statement);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO media_chunk_lists (owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`
    );
    let lists = 0;
    let rows = 0;
    const sources = [
      { table: "media_format_chunks", ownerColumn: "format_id", ownerKind: CHUNK_LIST_OWNER_KIND.format },
      { table: "media_audio_chunks", ownerColumn: "track_id", ownerKind: CHUNK_LIST_OWNER_KIND.audioTrack },
    ];
    for (const { table, ownerColumn, ownerKind } of sources) {
      const chunkRows = db
        .prepare(
          `SELECT ${ownerColumn} AS owner, chunk_key, size_bytes, start_seconds FROM ${table} ORDER BY ${ownerColumn}, order_index;`
        )
        .all() as ChunkRow[];
      rows += chunkRows.length;
      let start = 0;
      while (start < chunkRows.length) {
        const owner = chunkRows[start].owner;
        let end = start;
        while (end < chunkRows.length && chunkRows[end].owner === owner) end += 1;
        const list = packChunkList(
          chunkRows.slice(start, end).map((row) => ({
            key: row.chunk_key,
            sizeBytes: row.size_bytes,
            startSeconds: row.start_seconds,
          }))
        );
        insert.run(owner, ownerKind, list.placementId, list.keyMode, list.keyData, list.count, list.sizes, list.starts, nowIso);
        lists += 1;
        start = end;
      }
      db.exec(`DELETE FROM ${table};`);
    }
    db.exec("RELEASE convert_playback_packed;");
    return { lists, rows };
  } catch (error) {
    db.exec("ROLLBACK TO convert_playback_packed;");
    db.exec("RELEASE convert_playback_packed;");
    throw error;
  }
};
