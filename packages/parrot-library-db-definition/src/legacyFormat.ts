/**
 * META-SRC-09: the one place Parrot's library code still spells the column names library files used up to schema 9.
 * Files written by released builds carry them, so the migration list needs them twice: step 1 creates a new file the
 * way the first build did, and step 10 copies each old id column into its neutral name (`music_id`,
 * `music_edition_id`). Nothing else reads or writes these names. They go once the migration list is squashed into
 * one step at a schema every supported build writes (none older than schema 10 left).
 */

/** The library as the first build created it (schema 1), the starting point of every file. */
export const PARROT_LEGACY_VERSION_1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY NOT NULL,
  mbid TEXT,
  name TEXT NOT NULL,
  sort_name TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  album_artist_id TEXT NOT NULL,
  year INTEGER,
  kind TEXT NOT NULL DEFAULT 'studio',
  mbid_release_group TEXT,
  mbid_release TEXT,
  cover_object_key TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS albums_album_artist_id_idx ON albums (album_artist_id)`,
  `CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT NOT NULL,
  disc INTEGER NOT NULL DEFAULT 1,
  number INTEGER,
  title TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  duration_ms INTEGER,
  mbid_recording TEXT
)`,
  `CREATE INDEX IF NOT EXISTS tracks_album_id_idx ON tracks (album_id)`,
  `CREATE INDEX IF NOT EXISTS tracks_artist_id_idx ON tracks (artist_id)`,
  `CREATE TABLE IF NOT EXISTS track_files (
  id TEXT PRIMARY KEY NOT NULL,
  track_id TEXT NOT NULL,
  codec TEXT NOT NULL,
  container TEXT NOT NULL,
  mime TEXT NOT NULL,
  lossless INTEGER NOT NULL,
  bitrate_kbps INTEGER,
  sample_rate INTEGER,
  size_bytes INTEGER NOT NULL,
  light_copy INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS track_files_track_id_idx ON track_files (track_id)`,
  `CREATE TABLE IF NOT EXISTS track_file_chunks (
  track_file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  plain_offset INTEGER NOT NULL,
  plain_size INTEGER NOT NULL,
  PRIMARY KEY (track_file_id, idx)
)`,
  `CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`,
];

/** Each schema-9 id column by its table and its schema-10 name: step 10 copies the first into the second. */
export const PARROT_LEGACY_ID_COLUMNS: Readonly<Record<"artists" | "albums" | "tracks", Readonly<Record<string, string>>>> = {
  artists: { music_id: "mbid" },
  albums: { music_id: "mbid_release_group", music_edition_id: "mbid_release" },
  tracks: { music_id: "mbid_recording" },
};
