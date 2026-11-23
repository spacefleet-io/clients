import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  parrotLibraryMigrationStatements,
  parseParrotTracklist,
  type AlbumRow,
  type ParrotListedTrack,
  type ParrotLibraryOp,
  type TrackFileChunkRow,
} from "@space/parrot-library-db-definition";
import { parrotOpStatements, readParrotLyrics, readParrotPlaylists, type ParrotLyrics, type ParrotPlaylist } from "@space/parrot-core";
import { asRollbackJournalImage } from "@space/library-db-definition/sqliteImage";

/**
 * Parrot's library snapshot as a SQLite database in memory, through `node:sqlite` so the same code runs in Bun
 * (scripts, tests) and in Electron's main process without a native module to rebuild.
 */
export type ParrotLibraryDb = DatabaseSync;

/**
 * Opens a snapshot's bytes (or a new empty library) and brings it to the current schema. A snapshot a phone stored
 * in WAL mode gets the rollback-journal header first (LIB-FMT-10): in-memory SQLite refuses a WAL header with
 * "unable to open database file".
 */
export const openParrotLibrary = (bytes: Uint8Array | null): ParrotLibraryDb => {
  const db = new DatabaseSync(":memory:");
  if (bytes) db.deserialize(asRollbackJournalImage(bytes));
  const version = (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0;
  const statements = parrotLibraryMigrationStatements(version);
  if (statements.length) {
    db.exec("BEGIN");
    try {
      for (const sql of statements) db.exec(sql);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
};

/** Applies the ops in one transaction, in order. */
export const applyParrotOps = (db: ParrotLibraryDb, ops: readonly ParrotLibraryOp[]): void => {
  db.exec("BEGIN");
  try {
    for (const { sql, params } of parrotOpStatements(ops)) db.prepare(sql).run(...(params as SQLInputValue[]));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

export const serializeParrotLibrary = (db: ParrotLibraryDb): Uint8Array => new Uint8Array(db.serialize());

export type ParrotLibraryArtist = {
  id: string;
  name: string;
  albumCount: number;
  trackCount: number;
  /** The artist's photo in the user's storage (encrypted, PAR-META-15), as an album cover's two copies; null while it has none. */
  pictureObjectKey: string | null;
  pictureThumbObjectKey: string | null;
  /** The credit line's parts for a Commons photo ("Photo: author, licence"); null when it needs none. */
  pictureAuthor: string | null;
  pictureLicence: string | null;
  pictureLicenceUrl: string | null;
};
export type ParrotLibraryAlbum = {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  year: number | null;
  trackCount: number;
  /** The album's large cover in the user's storage (encrypted, PAR-META-04), or null while it has none. */
  coverObjectKey: string | null;
  /** Its small copy for tiles and lists; null when the large one is already small or predates small copies. */
  coverThumbObjectKey: string | null;
  /** When it first came into the library (ms), for the "Recently added" order. */
  addedAt: number;
  /** Its genre tag, for the library's Genre filter (PAR-LIB-06). */
  genre: string | null;
  /**
   * Its full tracklist from the metadata, owned songs and missing ones (PAR-LIB-05); null when unknown (an album
   * imported before tracklists were stored, or never matched): its page then lists only the songs the user has.
   */
  tracklist: ParrotListedTrack[] | null;
};
export type ParrotLibraryTrack = {
  id: string;
  title: string;
  albumId: string;
  albumTitle: string;
  artistId: string;
  artistName: string;
  disc: number;
  number: number | null;
  durationMs: number | null;
  /** The original file, played as it was uploaded (PAR-FMT-01); null when the song has none yet. */
  fileId: string | null;
  mime: string | null;
  sizeBytes: number | null;
  /** For "Even out volume" (PAR-PLAY-03): ReplayGain 2.0 gain (dB) and peak (true or the tag's sample peak); null until measured. */
  gainDb: number | null;
  peak: number | null;
  albumGainDb: number | null;
  albumPeak: number | null;
  /** The user kept the song as is at import, matched to nothing, so it can be identified later (PAR-UP-05). */
  unidentified: boolean;
  /** The year and genre the song shows: its own, else its album's unless the user emptied them (PAR-META-17). */
  year: number | null;
  genre: string | null;
  /** Its original file is lossless, and it has stored lyrics: the library's filters (PAR-LIB-06). */
  lossless: boolean;
  hasLyrics: boolean;
};
export type ParrotLibraryFile = {
  id: string;
  trackId: string;
  mime: string;
  /** The stored codec (`alac` for Apple Lossless, which the apps decode themselves, PAR-FMT-01). */
  codec?: string | null;
  sizeBytes: number;
  chunks: TrackFileChunkRow[];
};

export const listParrotArtists = (db: ParrotLibraryDb): ParrotLibraryArtist[] =>
  db
    .prepare(
      `SELECT ar.id, ar.name,
              ar.picture_object_key AS pictureObjectKey, ar.picture_thumb_object_key AS pictureThumbObjectKey,
              ar.picture_author AS pictureAuthor, ar.picture_licence AS pictureLicence, ar.picture_licence_url AS pictureLicenceUrl,
              (SELECT COUNT(*) FROM albums al WHERE al.album_artist_id = ar.id) AS albumCount,
              (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id) AS trackCount
       FROM artists ar ORDER BY ar.sort_name COLLATE NOCASE, ar.name COLLATE NOCASE`
    )
    .all() as ParrotLibraryArtist[];

export const listParrotAlbums = (db: ParrotLibraryDb): ParrotLibraryAlbum[] =>
  (
    db
      .prepare(
        `SELECT al.id, al.title, al.album_artist_id AS artistId, ar.name AS artistName, al.year, al.genre,
                al.cover_object_key AS coverObjectKey, al.cover_thumb_object_key AS coverThumbObjectKey, al.created_at AS addedAt,
                (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS trackCount, al.tracklist
         FROM albums al JOIN artists ar ON ar.id = al.album_artist_id
         ORDER BY ar.sort_name COLLATE NOCASE, al.year, al.title COLLATE NOCASE`
      )
      .all() as Array<Omit<ParrotLibraryAlbum, "tracklist"> & { tracklist: string | null }>
  ).map((album) => ({ ...album, tracklist: parseParrotTracklist(album.tracklist) }));

/** One album row as the `album.upsert` op carries it, or null. */
export const getParrotAlbumRow = (db: ParrotLibraryDb, albumId: string): AlbumRow | null => {
  const row = db
    .prepare(
      `SELECT id, title, album_artist_id AS albumArtistId, year, kind, music_id AS musicId,
              music_edition_id AS musicEditionId, cover_object_key AS coverObjectKey, cover_thumb_object_key AS coverThumbObjectKey,
              created_at AS createdAt, tracklist
       FROM albums WHERE id = ?`
    )
    .get(albumId) as (Omit<AlbumRow, "tracklist"> & { tracklist: string | null }) | undefined;
  return row ? { ...row, tracklist: parseParrotTracklist(row.tracklist) } : null;
};

/** Songs in album order. The original file (not a light copy) is the one listed (PAR-FMT-01). */
export const listParrotTracks = (db: ParrotLibraryDb): ParrotLibraryTrack[] =>
  (
    db
      .prepare(
        `SELECT t.id, t.title, t.album_id AS albumId, al.title AS albumTitle, t.artist_id AS artistId, ar.name AS artistName,
              t.disc, t.number, t.duration_ms AS durationMs,
              f.id AS fileId, f.mime, f.size_bytes AS sizeBytes,
              t.gain_db AS gainDb, t.peak, t.album_gain_db AS albumGainDb, t.album_peak AS albumPeak,
              COALESCE(t.unidentified, 0) AS unidentified,
              CASE WHEN t.year_edited THEN t.year ELSE COALESCE(t.year, al.year) END AS year,
              CASE WHEN t.genre_edited THEN t.genre ELSE COALESCE(t.genre, al.genre) END AS genre,
              COALESCE(f.lossless, 0) AS lossless,
              EXISTS (SELECT 1 FROM lyrics l WHERE l.track_id = t.id AND (l.plain IS NOT NULL OR l.synced IS NOT NULL)) AS hasLyrics
       FROM tracks t
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN track_files f ON f.id = (
         SELECT id FROM track_files WHERE track_id = t.id ORDER BY light_copy, created_at LIMIT 1
       )
       ORDER BY (SELECT sort_name FROM artists WHERE id = al.album_artist_id) COLLATE NOCASE, al.year,
                al.title COLLATE NOCASE, t.disc, t.number, t.title COLLATE NOCASE`
      )
      .all() as Array<Omit<ParrotLibraryTrack, "unidentified" | "lossless" | "hasLyrics"> & { unidentified: number; lossless: number; hasLyrics: number }>
  ).map((track) => ({ ...track, unidentified: track.unidentified === 1, lossless: track.lossless === 1, hasLyrics: track.hasLyrics === 1 }));

/** The playlists with their songs in order, Liked songs first (PAR-PL-01, PAR-PL-04). */
export const listParrotPlaylists = (db: ParrotLibraryDb): ParrotPlaylist[] =>
  readParrotPlaylists(<T>(sql: string) => db.prepare(sql).all() as T[]);

/** One song's lyrics, or null when it has none (PAR-LYR-01). */
export const getParrotLyrics = (db: ParrotLibraryDb, trackId: string): ParrotLyrics | null =>
  readParrotLyrics(<T>(sql: string, params: unknown[]) => db.prepare(sql).all(...(params as SQLInputValue[])) as T[], trackId);

/** One stored file with its chunk map, or null. */
export const getParrotFile = (db: ParrotLibraryDb, fileId: string): ParrotLibraryFile | null => {
  const file = db
    .prepare("SELECT id, track_id AS trackId, mime, codec, size_bytes AS sizeBytes FROM track_files WHERE id = ?")
    .get(fileId) as Omit<ParrotLibraryFile, "chunks"> | undefined;
  if (!file) return null;
  const chunks = db
    .prepare(
      "SELECT idx, object_key AS objectKey, plain_offset AS plainOffset, plain_size AS plainSize FROM track_file_chunks WHERE track_file_id = ? ORDER BY idx"
    )
    .all(fileId) as TrackFileChunkRow[];
  return { ...file, chunks };
};

export const hasParrotFile = (db: ParrotLibraryDb, fileId: string): boolean =>
  db.prepare("SELECT 1 AS found FROM track_files WHERE id = ?").get(fileId) !== undefined;
