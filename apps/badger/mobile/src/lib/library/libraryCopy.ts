/**
 * SQL that moves library rows between the split DBs (core / metadata /
 * playback / ingest) and the combined snapshot DB without any row crossing the
 * JS bridge: the other side is ATTACHed and SQLite copies the rows itself.
 *
 *  - `buildCombinedCopyStatements`: run on the snapshot connection, the split
 *    files attached as `src_core` / `src_metadata` / `src_playback`.
 *  - `buildSplitCopyPlan`: run on each split connection, the snapshot file
 *    attached as `SPLIT_SOURCE_ALIAS`.
 */

type CopyTable = readonly [table: string, columns: string];

export const CORE_TABLES: readonly CopyTable[] = [
  [
    "media_items",
    "id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path, added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes",
  ],
  ["media_external_ids", "id, media_id, media_type, source, external_id"],
  ["media_genres", "id, media_id, genre_id"],
  ["app_settings", "key, value, updated_at"],
  ["playlists", "id, name, slug, is_system, created_at"],
  ["playlist_items", "id, playlist_id, media_id, added_at"],
];

export const METADATA_TABLES: readonly CopyTable[] = [
  ["people", "id, name, profile_path"],
  ["people_external_ids", "id, person_id, source, external_id"],
  ["media_roles", "id, media_id, person_id, role, order_index"],
  ["media_seasons", "id, media_id, season_number, title, overview, poster_path, episode_count, air_date"],
  ["media_episodes", "id, media_id, season_number, episode_number, title, overview, still_path, air_date"],
  ["media_trailers", "id, media_id, provider, key, name, language"],
  [
    "media_skip_markers",
    "id, media_id, episode_id, type, start_seconds, end_seconds, source, confidence, created_at, updated_at",
  ],
  ["media_editions", "id, media_id, season, episode, name, name_user_set, duration_seconds, created_at"],
  ["media_files", "id, media_id, filename, season, episode, added_at, status, edition_id, content_sha256, original_size_bytes"],
  ["media_file_desired_formats", "id, media_id, file_id, quality, codec, bitrate_kbps"],
];

const LIBRARY_MEDIA = "SELECT id FROM src_core.media_items";
const LIBRARY_FORMATS = `SELECT id FROM src_playback.media_formats WHERE media_id IN (${LIBRARY_MEDIA})`;
const LIBRARY_AUDIO_TRACKS = `SELECT id FROM src_playback.media_audio_tracks WHERE media_id IN (${LIBRARY_MEDIA})`;

/** Playback rows of the library's media only (the playback DB may still hold rows of removed titles). */
const PLAYBACK_STATEMENTS: readonly string[] = [
  `INSERT OR REPLACE INTO main.media_formats (
    id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, size_mb, init_key, init_size, duration_seconds, total_size,
    preview_sheets
  ) SELECT id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, size_mb, init_key, init_size, duration_seconds, total_size,
    preview_sheets
  FROM src_playback.media_formats WHERE media_id IN (${LIBRARY_MEDIA});`,
  `INSERT OR REPLACE INTO main.media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds)
  SELECT id, format_id, chunk_key, order_index, size_bytes, start_seconds FROM src_playback.media_format_chunks
  WHERE format_id IN (${LIBRARY_FORMATS});`,
  `INSERT OR REPLACE INTO main.media_audio_tracks (
    id, media_id, file_id, episode_id, language, label, is_default, source, codec, codec_string, init_key, init_size, duration_seconds, total_size, created_at
  ) SELECT t.id, t.media_id, t.file_id, t.episode_id, t.language, t.label, t.is_default, t.source, t.codec, t.codec_string, t.init_key, t.init_size, t.duration_seconds, t.total_size, m.updated_at
  FROM src_playback.media_audio_tracks t JOIN src_core.media_items m ON m.id = t.media_id;`,
  `INSERT OR REPLACE INTO main.media_audio_chunks (id, track_id, chunk_key, order_index, size_bytes, start_seconds)
  SELECT id, track_id, chunk_key, order_index, size_bytes, start_seconds FROM src_playback.media_audio_chunks
  WHERE track_id IN (${LIBRARY_AUDIO_TRACKS});`,
  `INSERT OR REPLACE INTO main.media_subtitles (
    id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, derived_from_subtitle_id, created_at
  ) SELECT id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, derived_from_subtitle_id, created_at
  FROM src_playback.media_subtitles WHERE media_id IN (${LIBRARY_MEDIA});`,
  `INSERT OR REPLACE INTO main.media_chapters (id, format_id, title, start_seconds)
  SELECT id, format_id, title, start_seconds FROM src_playback.media_chapters
  WHERE format_id IN (${LIBRARY_FORMATS});`,
  // LIB-FMT-11: packed chunk lists and the per-file playback clock of a converted library (empty before the switch).
  `INSERT OR REPLACE INTO main.media_chunk_lists (owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at)
  SELECT owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at FROM src_playback.media_chunk_lists
  WHERE owner_id IN (${LIBRARY_FORMATS}) OR owner_id IN (${LIBRARY_AUDIO_TRACKS});`,
  `INSERT OR REPLACE INTO main.media_file_playback (media_id, file_id, updated_at)
  SELECT media_id, file_id, updated_at FROM src_playback.media_file_playback WHERE media_id IN (${LIBRARY_MEDIA});`,
];

export const copyStatements = (alias: string, tables: readonly CopyTable[]) =>
  tables.map(
    ([table, columns]) => `INSERT OR REPLACE INTO main.${table} (${columns}) SELECT ${columns} FROM ${alias}.${table};`
  );

/** Every copy statement in dependency order (parents before the rows that reference them). */
export const buildCombinedCopyStatements = (): string[] => [
  ...copyStatements("src_core", CORE_TABLES),
  ...copyStatements("src_metadata", METADATA_TABLES),
  ...PLAYBACK_STATEMENTS,
];

/** Alias the snapshot file gets on each split connection. */
export const SPLIT_SOURCE_ALIAS = "src_snapshot";

export type SplitCopyGroup = "core" | "metadata" | "playback" | "ingest";

/** table -> its columns, as `PRAGMA table_info` reports them (an absent table has no entry). */
export type TableColumns = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * One copy: `columns` is what the current schema wants; `select` overrides the source expression of a
 * column (it then needs no source column); `from` / `prefix` carry a join; `where` limits the rows.
 */
type PlaybackCopy = {
  table: string;
  columns: readonly string[];
  from?: string;
  prefix?: string;
  select?: Readonly<Record<string, string>>;
  where?: string;
};

const SNAPSHOT_MEDIA = `SELECT id FROM ${SPLIT_SOURCE_ALIAS}.media_items`;
const SNAPSHOT_FORMATS = `SELECT id FROM ${SPLIT_SOURCE_ALIAS}.media_formats WHERE media_id IN (${SNAPSHOT_MEDIA})`;
const SNAPSHOT_AUDIO_TRACKS = `SELECT id FROM ${SPLIT_SOURCE_ALIAS}.media_audio_tracks WHERE media_id IN (${SNAPSHOT_MEDIA})`;

/** Playback rows of the snapshot's media only (a snapshot may still carry rows of removed titles). */
const PLAYBACK_COPIES: readonly PlaybackCopy[] = [
  {
    table: "media_formats",
    columns: [
      "id", "media_id", "file_id", "quality", "codec", "codec_string", "bitrate_kbps", "size_mb",
      "init_key", "init_size", "duration_seconds", "total_size", "preview_sheets",
    ],
    where: `media_id IN (${SNAPSHOT_MEDIA})`,
  },
  {
    table: "media_format_chunks",
    columns: ["id", "format_id", "chunk_key", "order_index", "size_bytes", "start_seconds"],
    where: `format_id IN (${SNAPSHOT_FORMATS})`,
  },
  {
    table: "media_audio_tracks",
    columns: [
      "id", "media_id", "file_id", "episode_id", "language", "label", "is_default", "source", "codec",
      "codec_string", "init_key", "init_size", "duration_seconds", "total_size", "created_at",
    ],
    from: `${SPLIT_SOURCE_ALIAS}.media_audio_tracks t JOIN ${SPLIT_SOURCE_ALIAS}.media_items m ON m.id = t.media_id`,
    prefix: "t.",
    select: { created_at: "m.updated_at" },
  },
  {
    table: "media_audio_chunks",
    columns: ["id", "track_id", "chunk_key", "order_index", "size_bytes", "start_seconds"],
    where: `track_id IN (${SNAPSHOT_AUDIO_TRACKS})`,
  },
  {
    table: "media_subtitles",
    columns: [
      "id", "media_id", "file_id", "episode_id", "language", "label", "object_key", "format", "is_default",
      "source", "derived_from_subtitle_id", "created_at",
    ],
    where: `media_id IN (${SNAPSHOT_MEDIA})`,
  },
  {
    table: "media_chapters",
    columns: ["id", "format_id", "title", "start_seconds"],
    where: `format_id IN (${SNAPSHOT_FORMATS})`,
  },
  {
    // LIB-FMT-11: a converted snapshot's packed chunk lists and per-file playback clock (empty before the switch).
    table: "media_chunk_lists",
    columns: ["owner_id", "owner_kind", "placement_id", "key_mode", "key_data", "count", "sizes", "starts", "updated_at"],
    where: `owner_id IN (${SNAPSHOT_FORMATS}) OR owner_id IN (${SNAPSHOT_AUDIO_TRACKS})`,
  },
  {
    table: "media_file_playback",
    columns: ["media_id", "file_id", "updated_at"],
    where: `media_id IN (${SNAPSHOT_MEDIA})`,
  },
];

const INGEST_TABLES: readonly CopyTable[] = [
  [
    "ingest_jobs",
    "id, media_id, file_id, worker_peer_id, owner_client_id, kind, status, progress_pct, error_code, error_message, meta_json, created_at, updated_at, completed_at",
  ],
  ["ingest_job_events", "id, job_id, level, message, meta_json, created_at"],
];

const columnList = (columns: string) => columns.split(",").map((c) => c.trim());

/** The tables of each split DB with the columns the current schema wants (what a DB of this build has). */
export const declaredSplitColumns = (): Record<SplitCopyGroup, Map<string, Set<string>>> => ({
  core: new Map(CORE_TABLES.map(([table, columns]) => [table, new Set(columnList(columns))])),
  metadata: new Map(METADATA_TABLES.map(([table, columns]) => [table, new Set(columnList(columns))])),
  playback: new Map(PLAYBACK_COPIES.map(({ table, columns }) => [table, new Set(columns)])),
  ingest: new Map(INGEST_TABLES.map(([table, columns]) => [table, new Set(columnList(columns))])),
});

/** Source columns of `table` that the target also has; null when either side lacks the table. */
const sharedColumns = (
  table: string,
  wanted: readonly string[],
  source: TableColumns,
  target: TableColumns,
  computed: Readonly<Record<string, string>> = {}
): string[] | null => {
  const src = source.get(table);
  const dst = target.get(table);
  if (!src?.size || !dst?.size) return null;
  const shared = wanted.filter((column) => dst.has(column) && (column in computed || src.has(column)));
  return shared.length ? shared : null;
};

const intersectedCopies = (
  tables: readonly CopyTable[],
  source: TableColumns,
  target: TableColumns
): string[] =>
  tables.flatMap(([table, columns]) => {
    const shared = sharedColumns(table, columnList(columns), source, target);
    if (!shared) return [];
    const list = shared.join(", ");
    return [`INSERT OR REPLACE INTO main.${table} (${list}) SELECT ${list} FROM ${SPLIT_SOURCE_ALIAS}.${table};`];
  });

const intersectedPlaybackCopies = (source: TableColumns, target: TableColumns): string[] =>
  PLAYBACK_COPIES.flatMap((copy) => {
    const shared = sharedColumns(copy.table, copy.columns, source, target, copy.select);
    if (!shared) return [];
    const select = shared.map((column) => copy.select?.[column] ?? `${copy.prefix ?? ""}${column}`).join(", ");
    const from = copy.from ?? `${SPLIT_SOURCE_ALIAS}.${copy.table}`;
    const where = copy.where ? ` WHERE ${copy.where}` : "";
    return [`INSERT OR REPLACE INTO main.${copy.table} (${shared.join(", ")}) SELECT ${select} FROM ${from}${where};`];
  });

/**
 * The copy statements that fill each split DB from the attached snapshot, parents before the rows
 * that reference them. A snapshot written by an older build lacks tables and columns that were added
 * later, so each statement names only the columns present on BOTH sides (`source`: the snapshot,
 * `targets`: each split DB); a table missing on either side is left out.
 */
export const buildSplitCopyPlan = (
  source: TableColumns,
  targets: Readonly<Record<SplitCopyGroup, TableColumns>>
): Record<SplitCopyGroup, string[]> => ({
  core: intersectedCopies(CORE_TABLES, source, targets.core),
  metadata: intersectedCopies(METADATA_TABLES, source, targets.metadata),
  playback: intersectedPlaybackCopies(source, targets.playback),
  ingest: intersectedCopies(INGEST_TABLES, source, targets.ingest),
});
