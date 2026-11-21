/**
 * Parrot's library ops: the change records published on the op stream between snapshots, and the
 * single SQL generator every client applies them with (`buildParrotOpStatements`). Rows use the
 * column names of the SQLite schema, camel-cased as in `schema.ts`.
 *
 * Upserts are idempotent (`ON CONFLICT … DO UPDATE`), so replaying an op is harmless. Deletes take
 * their dependents with them: an album its tracks, a track its files, a file its chunk rows.
 */
import type { AlbumKind } from "./schema";
import { parrotTableGroups, type ParrotLibraryGroup } from "./manifest";

/**
 * Version of this op vocabulary; a stream declaring a higher one is refused before it is applied. 5: the catalog id
 * fields became `musicId`/`musicEditionId` (schema 10, META-SRC-09).
 */
export const PARROT_OP_STREAM_VERSION = 5;

/** Who took an artist's Commons photo and under which licence (PAR-META-15); `licenceUrl` null for a public-domain file. */
export type ParrotPhotoCredit = { author: string; licence: string; licenceUrl: string | null };

export type ArtistRow = {
  id: string;
  /** The artist's id in the metadata, opaque. */
  musicId: string | null;
  name: string;
  sortName: string;
  /**
   * The artist's photo copied into the vault (PAR-META-15), large and small copies as an album's cover. Absent or null
   * keeps the stored one, so an import's upsert never wipes it; a new large copy replaces both copies and the credit.
   */
  pictureObjectKey?: string | null;
  pictureThumbObjectKey?: string | null;
  /** Set for Commons photos only; ignored without a new `pictureObjectKey`. */
  pictureCredit?: ParrotPhotoCredit | null;
  /** When the photo was asked for (ms); absent or null keeps the stored time. */
  pictureTriedAt?: number | null;
};

/** One song of an album's full tracklist from the metadata, owned or not (PAR-LIB-05). */
export type ParrotListedTrack = { disc: number; number: number; title: string; durationMs: number | null };

/**
 * The `albums.tracklist` column's JSON as a tracklist, or null when it is unknown or unreadable: an album without one
 * shows only the songs the user has (PAR-LIB-05).
 */
export const parseParrotTracklist = (raw: unknown): ParrotListedTrack[] | null => {
  if (typeof raw !== "string" || !raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const rows = value.filter(
    (row): row is ParrotListedTrack =>
      !!row &&
      typeof row === "object" &&
      Number.isInteger(row.disc) &&
      Number.isInteger(row.number) &&
      typeof row.title === "string" &&
      (row.durationMs === null || typeof row.durationMs === "number")
  );
  return rows.length ? rows.map(({ disc, number, title, durationMs }) => ({ disc, number, title, durationMs })) : null;
};

export type AlbumRow = {
  id: string;
  title: string;
  albumArtistId: string;
  year: number | null;
  kind: AlbumKind;
  /** The album's id in the metadata, opaque (the album across its editions). */
  musicId: string | null;
  /** The edition (release) of it the songs came from, opaque. */
  musicEditionId: string | null;
  /** The large cover copy (at most 1200 px wide), shown where the cover is big (PAR-META-04). */
  coverObjectKey: string | null;
  /** The small cover copy (at most 500 px wide) for tiles and lists; null when the large one is already that small. */
  coverThumbObjectKey: string | null;
  createdAt: number;
  /** Absent or null keeps the album's genre (an import never wipes one the user set, PAR-META-11). */
  genre?: string | null;
  /**
   * The user set the year in the edit dialog, emptying it included (PAR-META-17). An op carrying it writes `year` as
   * it is, null clearing it; once set, an op without it (an import of another file) leaves the year alone.
   */
  yearEdited?: boolean;
  /** Like `yearEdited`, for the genre. */
  genreEdited?: boolean;
  /**
   * The user edited the album by hand (title, artist or cover): a new music copy no longer refreshes it (PAR-COPY-01).
   * Once set it stays: an op without it leaves the flag alone.
   */
  edited?: boolean;
  /**
   * The album's full tracklist from the metadata (PAR-LIB-05). Absent, null or empty keeps the stored one, so a song
   * imported without a match never wipes the list an earlier match stored; a list replaces it.
   */
  tracklist?: ParrotListedTrack[] | null;
};

export type TrackRow = {
  id: string;
  albumId: string;
  disc: number;
  number: number | null;
  title: string;
  artistId: string;
  durationMs: number | null;
  /** The song's id in the metadata, opaque. */
  musicId: string | null;
  /** The song's own year; absent or null keeps the stored one, so a re-import never wipes an edit (PAR-META-11). */
  year?: number | null;
  /** Absent or null keeps the stored genre, like `year`. */
  genre?: string | null;
  /** The user set the song's year, emptying it included (PAR-META-17); see `AlbumRow.yearEdited`. */
  yearEdited?: boolean;
  /** Like `yearEdited`, for the genre. */
  genreEdited?: boolean;
  /**
   * Even volume (PAR-PLAY-03): ReplayGain 2.0 gain (dB) and sample peak (linear), the album's from the file's tags.
   * Absent or null keeps the stored value, so an edit never loses the measurement.
   */
  gainDb?: number | null;
  peak?: number | null;
  albumGainDb?: number | null;
  albumPeak?: number | null;
  /**
   * The user kept the song as is at import, matched to nothing (PAR-UP-05). Absent or null keeps the stored flag, so
   * an edit never loses it; false clears it once the song is identified.
   */
  unidentified?: boolean | null;
};

/** A song's lyrics copied into the vault (PAR-LYR-05). */
export type LyricsRow = {
  trackId: string;
  plain: string | null;
  synced: string | null;
  source: string | null;
  fetchedAt: number;
};

export type TrackFileRow = {
  id: string;
  trackId: string;
  codec: string;
  container: string;
  mime: string;
  lossless: boolean;
  bitrateKbps: number | null;
  sampleRate: number | null;
  /** Bytes the players read: the stored pieces end to end. */
  sizeBytes: number;
  lightCopy: boolean;
  createdAt: number;
  /**
   * PAR-FMT-01, a file stored split: the header's bytes at the start of the stored file (0: the container needs none,
   * MP3 and ADTS), the size of the file the user picked, and the sealed object holding the file's own tags. All three
   * absent or null: the file is stored whole, as the user's file was (imports before 2026-11-21, light copies).
   */
  headerBytes?: number | null;
  sourceSizeBytes?: number | null;
  tagsObjectKey?: string | null;
};

/** A file stored in parts (PAR-FMT-01): its row needs schema 11's layout columns. */
export const isSplitTrackFile = (file: TrackFileRow) =>
  file.headerBytes != null || file.sourceSizeBytes != null || file.tagsObjectKey != null;

/** A playlist's own row (PAR-PL-01); its songs travel in `playlist_tracks.set`. */
export type PlaylistRow = { id: string; name: string; createdAt: number; updatedAt: number };

/** One stored piece of a track file; `trackFileId` comes from the enclosing file. */
export type TrackFileChunkRow = { idx: number; objectKey: string; plainOffset: number; plainSize: number };

type OpBase<Type extends string, Payload> = { id: string; type: Type; createdAt: string; payload: Payload };

export type ParrotLibraryOp =
  | OpBase<"artist.upsert", ArtistRow>
  | OpBase<"artist.delete", { id: string }>
  | OpBase<"album.upsert", AlbumRow>
  | OpBase<"album.delete", { id: string }>
  | OpBase<"track.upsert", TrackRow>
  | OpBase<"track.delete", { id: string }>
  /** Replaces the file's chunk rows with `chunks`. */
  | OpBase<"track_file.upsert", { file: TrackFileRow; chunks: TrackFileChunkRow[] }>
  | OpBase<"track_file.delete", { id: string }>
  | OpBase<"setting.set", { key: string; value: string }>
  | OpBase<"playlist.upsert", PlaylistRow>
  /** Deletes the playlist with its song list. */
  | OpBase<"playlist.delete", { id: string }>
  /** Replaces the playlist's whole song list with `trackIds`, in order. */
  | OpBase<"playlist_tracks.set", { playlistId: string; trackIds: string[] }>
  | OpBase<"lyrics.set", LyricsRow>
  | OpBase<"lyrics.delete", { trackId: string }>;

export type ParrotLibraryOpType = ParrotLibraryOp["type"];

export class UnknownParrotOpTypeError extends Error {
  readonly opType: string;
  constructor(opType: string) {
    super(`UNKNOWN_OP_TYPE: ${opType}`);
    this.name = "UnknownParrotOpTypeError";
    this.opType = opType;
  }
}

export type ParrotSqlStatement = { readonly sql: string; readonly params: ReadonlyArray<unknown> };

export type ParrotOpStatementsByGroup = Readonly<
  Partial<Record<ParrotLibraryGroup, ReadonlyArray<ParrotSqlStatement>>>
>;

/** Builds an op with the given identity; callers supply `id` (a UUID) and `createdAt` (ISO). */
export const createParrotOp = <Type extends ParrotLibraryOpType>(
  type: Type,
  payload: Extract<ParrotLibraryOp, { type: Type }>["payload"],
  meta: { id: string; createdAt: string }
) => ({ id: meta.id, type, createdAt: meta.createdAt, payload }) as Extract<ParrotLibraryOp, { type: Type }>;

const bool = (value: boolean) => (value ? 1 : 0);

const deleteTrackFileStatements = (where: string, param: string): ParrotSqlStatement[] => [
  { sql: `DELETE FROM track_file_chunks WHERE track_file_id IN (SELECT id FROM track_files WHERE ${where})`, params: [param] },
  { sql: `DELETE FROM track_files WHERE ${where}`, params: [param] },
];

const statementsFor = (op: ParrotLibraryOp): ParrotSqlStatement[] => {
  switch (op.type) {
    case "artist.upsert": {
      const a = op.payload;
      return [
        {
          sql: `INSERT INTO artists (id, music_id, name, sort_name, picture_object_key, picture_thumb_object_key, picture_author, picture_licence, picture_licence_url, picture_tried_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET music_id = COALESCE(artists.music_id, excluded.music_id), name = excluded.name, sort_name = excluded.sort_name,
  picture_object_key = COALESCE(excluded.picture_object_key, artists.picture_object_key),
  picture_thumb_object_key = CASE WHEN excluded.picture_object_key IS NULL THEN artists.picture_thumb_object_key ELSE excluded.picture_thumb_object_key END,
  picture_author = CASE WHEN excluded.picture_object_key IS NULL THEN artists.picture_author ELSE excluded.picture_author END,
  picture_licence = CASE WHEN excluded.picture_object_key IS NULL THEN artists.picture_licence ELSE excluded.picture_licence END,
  picture_licence_url = CASE WHEN excluded.picture_object_key IS NULL THEN artists.picture_licence_url ELSE excluded.picture_licence_url END,
  picture_tried_at = COALESCE(excluded.picture_tried_at, artists.picture_tried_at)`,
          params: [
            a.id,
            a.musicId,
            a.name,
            a.sortName,
            a.pictureObjectKey ?? null,
            a.pictureObjectKey ? (a.pictureThumbObjectKey ?? null) : null,
            a.pictureObjectKey ? (a.pictureCredit?.author ?? null) : null,
            a.pictureObjectKey ? (a.pictureCredit?.licence ?? null) : null,
            a.pictureObjectKey ? (a.pictureCredit?.licenceUrl ?? null) : null,
            a.pictureTriedAt ?? null,
          ],
        },
      ];
    }
    case "artist.delete":
      return [{ sql: "DELETE FROM artists WHERE id = ?", params: [op.payload.id] }];
    case "album.upsert": {
      const a = op.payload;
      // A null cover never wipes the album's cover: each song's upsert carries the album row, and a song without a
      // picture must not undo the one an earlier song gave (PAR-META-04). A year or genre the user set or emptied
      // stays until he sets it again (PAR-META-17). A song without a matched album carries no tracklist and keeps the
      // one an earlier match stored (PAR-LIB-05).
      return [
        {
          sql: `INSERT INTO albums (id, title, album_artist_id, year, kind, music_id, music_edition_id, cover_object_key, cover_thumb_object_key, created_at, genre, year_edited, genre_edited, tracklist, edited)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET title = excluded.title, album_artist_id = excluded.album_artist_id,
  year = CASE WHEN excluded.year_edited = 1 THEN excluded.year WHEN albums.year_edited = 1 THEN albums.year ELSE excluded.year END,
  kind = excluded.kind, music_id = COALESCE(excluded.music_id, albums.music_id), music_edition_id = excluded.music_edition_id,
  cover_object_key = COALESCE(excluded.cover_object_key, albums.cover_object_key),
  cover_thumb_object_key = CASE WHEN excluded.cover_object_key IS NULL THEN albums.cover_thumb_object_key ELSE excluded.cover_thumb_object_key END,
  genre = CASE WHEN excluded.genre_edited = 1 THEN excluded.genre WHEN albums.genre_edited = 1 THEN albums.genre ELSE COALESCE(excluded.genre, albums.genre) END,
  year_edited = MAX(excluded.year_edited, albums.year_edited), genre_edited = MAX(excluded.genre_edited, albums.genre_edited),
  tracklist = COALESCE(excluded.tracklist, albums.tracklist), edited = MAX(excluded.edited, albums.edited)`,
          params: [
            a.id,
            a.title,
            a.albumArtistId,
            a.year,
            a.kind,
            a.musicId,
            a.musicEditionId,
            a.coverObjectKey,
            a.coverThumbObjectKey,
            a.createdAt,
            a.genre ?? null,
            bool(!!a.yearEdited),
            bool(!!a.genreEdited),
            a.tracklist?.length ? JSON.stringify(a.tracklist) : null,
            bool(!!a.edited),
          ],
        },
      ];
    }
    case "album.delete": {
      const id = op.payload.id;
      return [
        ...deleteTrackFileStatements("track_id IN (SELECT id FROM tracks WHERE album_id = ?)", id),
        { sql: "DELETE FROM playlist_tracks WHERE track_id IN (SELECT id FROM tracks WHERE album_id = ?)", params: [id] },
        { sql: "DELETE FROM lyrics WHERE track_id IN (SELECT id FROM tracks WHERE album_id = ?)", params: [id] },
        { sql: "DELETE FROM tracks WHERE album_id = ?", params: [id] },
        { sql: "DELETE FROM albums WHERE id = ?", params: [id] },
      ];
    }
    case "track.upsert": {
      const t = op.payload;
      return [
        {
          sql: `INSERT INTO tracks (id, album_id, disc, number, title, artist_id, duration_ms, music_id, year, genre, year_edited, genre_edited, gain_db, peak, album_gain_db, album_peak, unidentified)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET album_id = excluded.album_id, disc = excluded.disc, number = excluded.number,
  title = excluded.title, artist_id = excluded.artist_id, duration_ms = excluded.duration_ms, music_id = excluded.music_id,
  year = CASE WHEN excluded.year_edited = 1 THEN excluded.year WHEN tracks.year_edited = 1 THEN tracks.year ELSE COALESCE(excluded.year, tracks.year) END,
  genre = CASE WHEN excluded.genre_edited = 1 THEN excluded.genre WHEN tracks.genre_edited = 1 THEN tracks.genre ELSE COALESCE(excluded.genre, tracks.genre) END,
  year_edited = MAX(excluded.year_edited, tracks.year_edited), genre_edited = MAX(excluded.genre_edited, tracks.genre_edited),
  gain_db = COALESCE(excluded.gain_db, tracks.gain_db), peak = COALESCE(excluded.peak, tracks.peak),
  album_gain_db = COALESCE(excluded.album_gain_db, tracks.album_gain_db), album_peak = COALESCE(excluded.album_peak, tracks.album_peak),
  unidentified = COALESCE(excluded.unidentified, tracks.unidentified)`,
          params: [
            t.id,
            t.albumId,
            t.disc,
            t.number,
            t.title,
            t.artistId,
            t.durationMs,
            t.musicId,
            t.year ?? null,
            t.genre ?? null,
            bool(!!t.yearEdited),
            bool(!!t.genreEdited),
            t.gainDb ?? null,
            t.peak ?? null,
            t.albumGainDb ?? null,
            t.albumPeak ?? null,
            t.unidentified == null ? null : bool(t.unidentified),
          ],
        },
      ];
    }
    case "track.delete": {
      const id = op.payload.id;
      return [
        ...deleteTrackFileStatements("track_id = ?", id),
        { sql: "DELETE FROM playlist_tracks WHERE track_id = ?", params: [id] },
        { sql: "DELETE FROM lyrics WHERE track_id = ?", params: [id] },
        { sql: "DELETE FROM tracks WHERE id = ?", params: [id] },
      ];
    }
    case "track_file.upsert": {
      const { file: f, chunks } = op.payload;
      const columns = `id, track_id, codec, container, mime, lossless, bitrate_kbps, sample_rate, size_bytes, light_copy, created_at`;
      const update = `track_id = excluded.track_id, codec = excluded.codec, container = excluded.container,
  mime = excluded.mime, lossless = excluded.lossless, bitrate_kbps = excluded.bitrate_kbps,
  sample_rate = excluded.sample_rate, size_bytes = excluded.size_bytes, light_copy = excluded.light_copy`;
      const params = [
        f.id,
        f.trackId,
        f.codec,
        f.container,
        f.mime,
        bool(f.lossless),
        f.bitrateKbps,
        f.sampleRate,
        f.sizeBytes,
        bool(f.lightCopy),
        f.createdAt,
      ];
      return [
        // A file stored whole names only schema 10's columns, so it applies to a library still at schema 10
        // (API-VER-01); a file in parts also sets the layout columns, which describe the chunks below.
        isSplitTrackFile(f)
          ? {
              sql: `INSERT INTO track_files (${columns}, header_bytes, source_size_bytes, tags_object_key)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET ${update},
  header_bytes = excluded.header_bytes, source_size_bytes = excluded.source_size_bytes, tags_object_key = excluded.tags_object_key`,
              params: [...params, f.headerBytes ?? null, f.sourceSizeBytes ?? null, f.tagsObjectKey ?? null],
            }
          : {
              sql: `INSERT INTO track_files (${columns})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET ${update}`,
              params,
            },
        { sql: "DELETE FROM track_file_chunks WHERE track_file_id = ?", params: [f.id] },
        ...chunks.map((c) => ({
          sql: "INSERT INTO track_file_chunks (track_file_id, idx, object_key, plain_offset, plain_size) VALUES (?, ?, ?, ?, ?)",
          params: [f.id, c.idx, c.objectKey, c.plainOffset, c.plainSize],
        })),
      ];
    }
    case "track_file.delete":
      return deleteTrackFileStatements("id = ?", op.payload.id);
    case "setting.set":
      return [
        {
          sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          params: [op.payload.key, op.payload.value],
        },
      ];
    case "playlist.upsert": {
      const pl = op.payload;
      return [
        {
          sql: `INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
          params: [pl.id, pl.name, pl.createdAt, pl.updatedAt],
        },
      ];
    }
    case "playlist.delete":
      return [
        { sql: "DELETE FROM playlist_tracks WHERE playlist_id = ?", params: [op.payload.id] },
        { sql: "DELETE FROM playlists WHERE id = ?", params: [op.payload.id] },
      ];
    case "playlist_tracks.set": {
      const { playlistId, trackIds } = op.payload;
      return [
        { sql: "DELETE FROM playlist_tracks WHERE playlist_id = ?", params: [playlistId] },
        ...trackIds.map((trackId, position) => ({
          sql: "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)",
          params: [playlistId, position, trackId],
        })),
      ];
    }
    case "lyrics.set": {
      const l = op.payload;
      return [
        {
          sql: `INSERT INTO lyrics (track_id, plain, synced, source, fetched_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(track_id) DO UPDATE SET plain = excluded.plain, synced = excluded.synced, source = excluded.source,
  fetched_at = excluded.fetched_at`,
          params: [l.trackId, l.plain, l.synced, l.source, l.fetchedAt],
        },
      ];
    }
    case "lyrics.delete":
      return [{ sql: "DELETE FROM lyrics WHERE track_id = ?", params: [op.payload.trackId] }];
    default: {
      // A type past the stream-version gate with no builder is a bug or a corrupt op: fail loud
      // rather than advance the version without applying the change. `op` is `never` here; at
      // runtime it is whatever arrived on the stream.
      const unknownOp: { type: string } = op;
      throw new UnknownParrotOpTypeError(unknownOp.type);
    }
  }
};

const TABLE_PATTERN = /^(?:INSERT INTO|DELETE FROM)\s+(\w+)/;

/**
 * The SQL that applies `op`, by library group. Statements within a group run in order; the
 * milestone-1 library is one file, so callers may run every group in one transaction.
 */
export const buildParrotOpStatements = (op: ParrotLibraryOp): ParrotOpStatementsByGroup => {
  const byGroup: Partial<Record<ParrotLibraryGroup, ParrotSqlStatement[]>> = {};
  for (const statement of statementsFor(op)) {
    const table = TABLE_PATTERN.exec(statement.sql)?.[1];
    const group = table ? parrotTableGroups[table] : undefined;
    if (!group) throw new Error(`parrot op statement targets an unmapped table: ${statement.sql}`);
    (byGroup[group] ??= []).push(statement);
  }
  return byGroup;
};
