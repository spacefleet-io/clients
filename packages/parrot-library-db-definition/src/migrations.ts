/**
 * Parrot library DDL as plain SQL, so every SQLite driver (bun:sqlite in the runtime and seeders,
 * React Native on the phone) builds the same file. The schema version lives in `PRAGMA user_version`.
 *
 * Steps only ever append: step N takes a file from version N-1 to N. A file newer than this build
 * is refused rather than guessed at.
 */

import { PARROT_LEGACY_ID_COLUMNS, PARROT_LEGACY_VERSION_1 } from "./legacyFormat";

/** The newest schema this build reads. */
export const PARROT_LIBRARY_SCHEMA_VERSION = 11;

/**
 * The schema a library is brought to when opened, and stays at until its account stores songs in parts (API-VER-01):
 * schema 11 is reached only by applying a change that stores a file in parts (`parrotLibraryStatementsForOps` in
 * @space/parrot-core), so a library no switched account touched stays readable by the builds released before it.
 */
export const PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION = 10;

/** The first build's library (schema 1); its old id column names live in `legacyFormat.ts` (META-SRC-09). */
const VERSION_1: readonly string[] = PARROT_LEGACY_VERSION_1;

/** Each album's small cover copy for tiles and lists (PAR-META-04); `cover_object_key` holds the large one. */
const VERSION_2: readonly string[] = [`ALTER TABLE albums ADD COLUMN cover_thumb_object_key TEXT`];

/** The user's playlists and their songs in order (PAR-PL-01). */
const VERSION_3: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  PRIMARY KEY (playlist_id, position)
)`,
  `CREATE INDEX IF NOT EXISTS playlist_tracks_track_id_idx ON playlist_tracks (track_id)`,
];

/** Song year and genre, album genre (PAR-LIB-04), and lyrics copied into the vault (PAR-LYR-05). */
const VERSION_4: readonly string[] = [
  `ALTER TABLE tracks ADD COLUMN year INTEGER`,
  `ALTER TABLE tracks ADD COLUMN genre TEXT`,
  `ALTER TABLE albums ADD COLUMN genre TEXT`,
  `CREATE TABLE IF NOT EXISTS lyrics (
  track_id TEXT PRIMARY KEY NOT NULL,
  plain TEXT,
  synced TEXT,
  source TEXT,
  fetched_at INTEGER
)`,
];

/** Which years and genres the user set or emptied in the edit dialog, so an import never refills them (PAR-META-17). */
const VERSION_5: readonly string[] = [
  `ALTER TABLE albums ADD COLUMN year_edited INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE albums ADD COLUMN genre_edited INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tracks ADD COLUMN year_edited INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tracks ADD COLUMN genre_edited INTEGER NOT NULL DEFAULT 0`,
];

/** Each song's loudness for even volume (PAR-PLAY-03): ReplayGain 2.0 gain and peak, the album's from the file's tags. */
const VERSION_6: readonly string[] = [
  `ALTER TABLE tracks ADD COLUMN gain_db REAL`,
  `ALTER TABLE tracks ADD COLUMN peak REAL`,
  `ALTER TABLE tracks ADD COLUMN album_gain_db REAL`,
  `ALTER TABLE tracks ADD COLUMN album_peak REAL`,
];

/** Each artist's photo copied into the vault (PAR-META-15): its two copies, the Commons credit, and when it was asked for. */
const VERSION_7: readonly string[] = [
  `ALTER TABLE artists ADD COLUMN picture_object_key TEXT`,
  `ALTER TABLE artists ADD COLUMN picture_thumb_object_key TEXT`,
  `ALTER TABLE artists ADD COLUMN picture_author TEXT`,
  `ALTER TABLE artists ADD COLUMN picture_licence TEXT`,
  `ALTER TABLE artists ADD COLUMN picture_licence_url TEXT`,
  `ALTER TABLE artists ADD COLUMN picture_tried_at INTEGER`,
];

/**
 * Each album's full tracklist from the metadata, so its page lists the songs the user does not have greyed out, and
 * each song kept as is at import, unidentified, so it can be identified later (PAR-LIB-05, PAR-UP-05).
 */
const VERSION_8: readonly string[] = [`ALTER TABLE albums ADD COLUMN tracklist TEXT`, `ALTER TABLE tracks ADD COLUMN unidentified INTEGER`];

/**
 * The user edited the album by hand (its title, artist or cover): a new music copy no longer refreshes its details
 * (PAR-COPY-01).
 */
const VERSION_9: readonly string[] = [`ALTER TABLE albums ADD COLUMN edited INTEGER NOT NULL DEFAULT 0`];

/** Each table step 10 rebuilds: its schema-10 layout, column order kept, and the indexes the rebuild drops. */
const NEUTRAL_ID_TABLES: ReadonlyArray<{ table: keyof typeof PARROT_LEGACY_ID_COLUMNS; columns: readonly string[]; indexes: readonly string[] }> = [
  {
    table: "artists",
    columns: [
      "id TEXT PRIMARY KEY NOT NULL",
      "music_id TEXT",
      "name TEXT NOT NULL",
      "sort_name TEXT NOT NULL",
      "picture_object_key TEXT",
      "picture_thumb_object_key TEXT",
      "picture_author TEXT",
      "picture_licence TEXT",
      "picture_licence_url TEXT",
      "picture_tried_at INTEGER",
    ],
    indexes: [],
  },
  {
    table: "albums",
    columns: [
      "id TEXT PRIMARY KEY NOT NULL",
      "title TEXT NOT NULL",
      "album_artist_id TEXT NOT NULL",
      "year INTEGER",
      "kind TEXT NOT NULL DEFAULT 'studio'",
      "music_id TEXT",
      "music_edition_id TEXT",
      "cover_object_key TEXT",
      "created_at INTEGER NOT NULL",
      "cover_thumb_object_key TEXT",
      "genre TEXT",
      "year_edited INTEGER NOT NULL DEFAULT 0",
      "genre_edited INTEGER NOT NULL DEFAULT 0",
      "tracklist TEXT",
      "edited INTEGER NOT NULL DEFAULT 0",
    ],
    indexes: [`CREATE INDEX IF NOT EXISTS albums_album_artist_id_idx ON albums (album_artist_id)`],
  },
  {
    table: "tracks",
    columns: [
      "id TEXT PRIMARY KEY NOT NULL",
      "album_id TEXT NOT NULL",
      "disc INTEGER NOT NULL DEFAULT 1",
      "number INTEGER",
      "title TEXT NOT NULL",
      "artist_id TEXT NOT NULL",
      "duration_ms INTEGER",
      "music_id TEXT",
      "year INTEGER",
      "genre TEXT",
      "year_edited INTEGER NOT NULL DEFAULT 0",
      "genre_edited INTEGER NOT NULL DEFAULT 0",
      "gain_db REAL",
      "peak REAL",
      "album_gain_db REAL",
      "album_peak REAL",
      "unidentified INTEGER",
    ],
    indexes: [`CREATE INDEX IF NOT EXISTS tracks_album_id_idx ON tracks (album_id)`, `CREATE INDEX IF NOT EXISTS tracks_artist_id_idx ON tracks (artist_id)`],
  },
];

/**
 * META-SRC-09: the catalog ids get neutral column names (`music_id`, `music_edition_id`). Each table is rebuilt and
 * its rows copied, ids included, because the phone's SQLite (Android 8 and up) predates `RENAME COLUMN`.
 */
const VERSION_10: readonly string[] = NEUTRAL_ID_TABLES.flatMap(({ table, columns, indexes }) => {
  const names = columns.map((column) => column.split(" ")[0]!);
  const legacy: Readonly<Record<string, string>> = PARROT_LEGACY_ID_COLUMNS[table];
  return [
    `CREATE TABLE ${table}_v10 (\n  ${columns.join(",\n  ")}\n)`,
    `INSERT INTO ${table}_v10 (${names.join(", ")}) SELECT ${names.map((name) => legacy[name] ?? name).join(", ")} FROM ${table}`,
    `DROP TABLE ${table}`,
    `ALTER TABLE ${table}_v10 RENAME TO ${table}`,
    ...indexes,
  ];
});

/**
 * PAR-FMT-01: a song's file stored split (a header with no picture, the sound, the file's own tags in an object of
 * their own); null on files stored whole.
 */
const VERSION_11: readonly string[] = [
  `ALTER TABLE track_files ADD COLUMN header_bytes INTEGER`,
  `ALTER TABLE track_files ADD COLUMN source_size_bytes INTEGER`,
  `ALTER TABLE track_files ADD COLUMN tags_object_key TEXT`,
];

/** `PARROT_LIBRARY_MIGRATIONS[n - 1]` takes a file from version n-1 to n. */
export const PARROT_LIBRARY_MIGRATIONS: readonly (readonly string[])[] = [
  VERSION_1,
  VERSION_2,
  VERSION_3,
  VERSION_4,
  VERSION_5,
  VERSION_6,
  VERSION_7,
  VERSION_8,
  VERSION_9,
  VERSION_10,
  VERSION_11,
];

export class ParrotLibraryTooNewError extends Error {
  constructor(readonly fileVersion: number) {
    super(`parrot library schema ${fileVersion} is newer than this build (${PARROT_LIBRARY_SCHEMA_VERSION})`);
    this.name = "ParrotLibraryTooNewError";
  }
}

/**
 * The statements that bring a file at `fileVersion` (its `PRAGMA user_version`) to `target` (by default the schema a
 * library stays at while its songs are stored whole), ending with the `user_version` bump. Run them in one
 * transaction. Empty when the file is at `target` or above: a file is never taken back to an older schema.
 */
export const parrotLibraryMigrationStatements = (fileVersion: number, target: number = PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION): string[] => {
  if (fileVersion > PARROT_LIBRARY_SCHEMA_VERSION) throw new ParrotLibraryTooNewError(fileVersion);
  if (fileVersion >= target) return [];
  return [...PARROT_LIBRARY_MIGRATIONS.slice(fileVersion, target).flat(), `PRAGMA user_version = ${target}`];
};
