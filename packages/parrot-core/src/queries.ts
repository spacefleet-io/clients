// The library screens' queries over the decrypted Parrot snapshot (SQLite, schema in
// @space/parrot-library-db-definition). Plain SQL with `?` parameters, so the phone's SQLite, the desktop's
// node:sqlite and the web player's in-browser SQLite all run the same text.
import type { TrackFileRow, TrackRow } from "./catalog";

/** Albums with their album artist, in artist sort order, then year, then title. */
export const ALBUMS_SQL = `SELECT al.id AS id, al.title AS title, COALESCE(ar.name, '') AS artistName, al.album_artist_id AS artistId, al.year AS year, al.kind AS kind,
       (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS trackCount, al.created_at AS addedAt, al.genre AS genre
  FROM albums al LEFT JOIN artists ar ON ar.id = al.album_artist_id
 ORDER BY COALESCE(ar.sort_name, ar.name, '') COLLATE NOCASE, al.year, al.title COLLATE NOCASE`;

/** The albums of one album artist (parameter: artist id), oldest first. */
export const ARTIST_ALBUMS_SQL = `SELECT al.id AS id, al.title AS title, COALESCE(ar.name, '') AS artistName, al.album_artist_id AS artistId, al.year AS year, al.kind AS kind,
       (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS trackCount, al.created_at AS addedAt
  FROM albums al LEFT JOIN artists ar ON ar.id = al.album_artist_id
 WHERE al.album_artist_id = ?
 ORDER BY al.year, al.title COLLATE NOCASE`;

/** Artists that have an album or a song, in sort-name order, with their counts and their photo (PAR-META-15). */
export const ARTISTS_SQL = `SELECT ar.id AS id, ar.name AS name,
       ar.picture_object_key AS pictureObjectKey, ar.picture_thumb_object_key AS pictureThumbObjectKey,
       ar.picture_author AS pictureAuthor, ar.picture_licence AS pictureLicence, ar.picture_licence_url AS pictureLicenceUrl,
       (SELECT COUNT(*) FROM albums al WHERE al.album_artist_id = ar.id) AS albumCount,
       (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id) AS trackCount
  FROM artists ar
 WHERE EXISTS (SELECT 1 FROM albums al WHERE al.album_artist_id = ar.id) OR EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = ar.id)
 ORDER BY ar.sort_name COLLATE NOCASE, ar.name COLLATE NOCASE`;

/** One album's stored tracklist JSON (parameter: album id), or null; read it with `parseParrotTracklist` (PAR-LIB-05). */
export const ALBUM_TRACKLIST_SQL = `SELECT tracklist FROM albums WHERE id = ?`;

/**
 * The library's albums with a stored tracklist, for matching an import against (PAR-META-03): album id, title,
 * album artist's name and the tracklist JSON.
 */
export const IMPORT_LIBRARY_ALBUMS_SQL = `SELECT al.id AS id, al.music_id AS musicId, al.title AS title, COALESCE(ar.name, '') AS artist,
       al.tracklist AS tracklist
  FROM albums al LEFT JOIN artists ar ON ar.id = al.album_artist_id
 WHERE al.tracklist IS NOT NULL ORDER BY al.id`;

/** The slots (album, disc, number) the library's placed songs fill; a song kept as is (unidentified) fills none. */
export const IMPORT_LIBRARY_SLOTS_SQL = `SELECT album_id AS albumId, disc, number FROM tracks
 WHERE number IS NOT NULL AND COALESCE(unidentified, 0) = 0`;

/** The songs of one album (parameter: album id); order them with `sortTracks`. */
export const ALBUM_TRACKS_SQL = `SELECT t.id AS id, t.album_id AS albumId, t.disc AS disc, t.number AS number, t.title AS title,
       COALESCE(ar.name, '') AS artistName, COALESCE(t.artist_id, '') AS artistId, t.duration_ms AS durationMs, t.gain_db AS gainDb, t.peak AS peak,
       t.album_gain_db AS albumGainDb, t.album_peak AS albumPeak
  FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id
 WHERE t.album_id = ?`;

/**
 * Every song of the library with its album's title, by title then artist; the phone's Songs view and the web player's
 * Songs tab. The year and genre are the ones the song shows (its own, else its album's unless the user emptied them,
 * PAR-META-17); `lossless` is its original file's and `hasLyrics` says lyrics are stored, for the filters (PAR-LIB-06).
 */
export const SONGS_SQL = `SELECT t.id AS id, t.album_id AS albumId, t.disc AS disc, t.number AS number, t.title AS title,
       COALESCE(ar.name, '') AS artistName, COALESCE(t.artist_id, '') AS artistId, t.duration_ms AS durationMs, COALESCE(al.title, '') AS albumTitle, t.gain_db AS gainDb, t.peak AS peak,
       t.album_gain_db AS albumGainDb, t.album_peak AS albumPeak,
       CASE WHEN t.year_edited THEN t.year ELSE COALESCE(t.year, al.year) END AS year,
       CASE WHEN t.genre_edited THEN t.genre ELSE COALESCE(t.genre, al.genre) END AS genre,
       (SELECT f.lossless FROM track_files f WHERE f.track_id = t.id ORDER BY f.light_copy, f.created_at LIMIT 1) AS lossless,
       EXISTS (SELECT 1 FROM lyrics l WHERE l.track_id = t.id AND (l.plain IS NOT NULL OR l.synced IS NOT NULL)) AS hasLyrics
  FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id
 ORDER BY t.title COLLATE NOCASE, ar.name COLLATE NOCASE, al.title COLLATE NOCASE`;

/** Every stored file of the library (`RawTrackFileRow`s): the phone reads them once per load for keeping (PAR-OFFL-01). */
export const ALL_TRACK_FILES_SQL = `SELECT id, track_id AS trackId, mime, lossless, bitrate_kbps AS bitrateKbps, size_bytes AS sizeBytes,
       light_copy AS lightCopy, created_at AS createdAt
  FROM track_files`;

/** The stored files of one song (parameter: track id); pick one with `pickPlayableFile` after `toTrackFileRow`. */
export const TRACK_FILES_SQL = `${ALL_TRACK_FILES_SQL} WHERE track_id = ?`;

/** The chunk objects of one stored file (parameter: track file id), in order. */
export const FILE_CHUNKS_SQL = `SELECT idx, object_key AS objectKey, plain_offset AS plainOffset, plain_size AS plainSize
  FROM track_file_chunks WHERE track_file_id = ? ORDER BY idx`;

/** The albums that have a cover, with the keys of its two stored copies (`ParrotCoverKeys`, PAR-META-04). */
export const ALBUM_COVERS_SQL = `SELECT id, cover_object_key AS coverObjectKey, cover_thumb_object_key AS coverThumbObjectKey
  FROM albums WHERE cover_object_key IS NOT NULL`;

/**
 * An `ARTISTS_SQL` row. The photo's keys work as an album's cover keys (`parrotCoverThumbKey` with `coverObjectKey` =
 * `pictureObjectKey`); `parrotArtistPictureCredit` turns the three credit columns into the credit line's parts.
 */
export type ArtistRow = {
  id: string;
  name: string;
  albumCount: number;
  trackCount: number;
  pictureObjectKey: string | null;
  pictureThumbObjectKey: string | null;
  pictureAuthor: string | null;
  pictureLicence: string | null;
  pictureLicenceUrl: string | null;
};

/**
 * A `SONGS_SQL` row: a song, the title of its album and what the library's filters read (SQLite's booleans are 0 or 1;
 * absent on rows read by other queries).
 */
export type SongRow = TrackRow & {
  albumTitle: string;
  year?: number | null;
  genre?: string | null;
  lossless?: number | boolean | null;
  hasLyrics?: number | boolean | null;
};

/** A `TRACK_FILES_SQL` row as SQLite returns it: its booleans are 0 or 1. */
export type RawTrackFileRow = Omit<TrackFileRow, "lossless" | "lightCopy"> & {
  lossless: number | boolean;
  lightCopy: number | boolean;
};

export const toTrackFileRow = (row: RawTrackFileRow): TrackFileRow => ({
  ...row,
  lossless: !!row.lossless,
  lightCopy: !!row.lightCopy,
});
