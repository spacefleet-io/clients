/**
 * Shared SQL-statement builders for the LibraryOp wire format.
 *
 * Both desktop and mobile clients receive the same `LibraryOp` payloads but
 * have very different execution drivers (sync better-sqlite3 + Drizzle on
 * desktop, async react-native-sqlite-storage + SqlBatcher on mobile). What is
 * identical between them is the *SQL* each op should emit per logical group.
 *
 * This module turns one op into a `{ group → [{ sql, params }] }` map. Each
 * client wraps the per-group statement list in its native batch/transaction
 * primitive. No driver assumptions; no SQLite reads inside the builder.
 *
 * The mobile client opens four files (no `templates`); statements for the
 * `templates` group are silently dropped by the mobile executor since today's
 * op vocabulary never targets templates (no template-group ops exist in
 * @space/shared/libraryOps). The map structure leaves room to add them later
 * without changing the builder signature.
 */

import { mediaFilesAndEditionsStatements } from "./editionDdl";
import { neutralMediaDetails } from "./legacyFormat";
import { CATALOG_ID_SOURCE } from "./catalogId";
import { systemPlaylistForSlug } from "./systemPlaylists";
import {
  CHUNK_LIST_KEY_MODE,
  CHUNK_LIST_OWNER_KIND,
  chunkListFromJson,
  chunkListKeys,
  chunkListToJson,
  decodeChunkSizes,
  decodeChunkStarts,
  packChunkList,
  type ChunkListOwnerKind,
  type PackedChunkListJson,
} from "./chunkLists";
import type {
  IngestJob,
  IngestJobEvent,
  IngestJobStatus,
  MediaDetails,
} from "@space/shared";
import type {
  LibraryOp,
  MediaUpsertOp,
  MediaUpsertV4Op,
  MediaDetailsV4,
  MediaDeleteOp,
  MediaProgressOp,
  MediaFilePlaybackSetOp,
  MediaFilePlaybackDeleteOp,
  MediaEpisodeDeleteOp,
  PlaylistCreateOp,
  PlaylistDeleteOp,
  PlaylistItemAddOp,
  PlaylistItemRemoveOp,
  SettingSetOp,
  IngestJobUpsertOp,
  IngestJobDeleteOp,
  IngestJobEventAddOp,
  IngestJobHistoryClearOp,
} from "@space/shared/libraryOps";
import type { LibraryDbGroup } from "./manifest";

/**
 * Current op-stream format version this build produces. Surface #2 of the
 * library DB — the `LibraryOp` wire vocabulary — is versioned by this counter.
 * Bump it whenever a new `LibraryOp` variant is added or an existing one's
 * shape changes; the publishing client declares it on the wire and a reader
 * too old for the declared version is refused by the Part D compatibility gate.
 *
 * v2: `media.upsert.appendMediaPlayback` carries `is_source` in the
 * `media_formats` INSERT OR REPLACE — the post-ingest quality-management
 * feature (plan: virtual-puzzling-sketch.md). v1 streams replay correctly
 * because `is_source` defaults to `false` (schema column DEFAULT 0) when
 * absent; the next source-job commit re-derives it from `sourceQuality`.
 *
 * v3 (META-SRC-09): `media.upsert` details carry the title's and each person's catalog id as `catalogId`, and no
 * other sites' ids. v1–v2 payloads still replay: `neutralMediaDetails` (`legacyFormat.ts`) reads their old keys.
 */
export const OP_STREAM_VERSION = 3;

/**
 * v4 (LIB-FMT-11): a title's playback travels per file (`media.file.playback.set`/`.delete`, `media.episode.delete`)
 * with packed chunk lists (`chunkLists.ts`); `media.upsert` carries core + metadata only, and an old `media.upsert`
 * is translated, never replayed as-is.
 *
 * Highest op-stream version this build READS: the compatibility support, reader gates and the
 * `x-library-op-stream-version` header on library reads. Never declared on a write: writers declare
 * `OP_STREAM_VERSION` (3) until their account is switched, then `writeOpStreamVersion(...)` (LIB-FMT-13). Kept apart
 * so a writer nobody migrated keeps declaring 3 and can never raise an account before the switch (Main 2026-11-21);
 * after the switch reaches every account, a cleanup folds this back into `OP_STREAM_VERSION = 4`.
 */
export const READ_OP_STREAM_VERSION = 4;

/**
 * The op-stream version a migrated writer declares (header and body of ops PUT and full-copy PUT): 4 only once the
 * account is switched (`/library/db/meta` `targetOpStreamVersion >= 4`), else 3. The ONLY way a writer may declare 4
 * (guarded by `tests/op-stream-write-version.test.ts`).
 */
export const writeOpStreamVersion = (targetOpStreamVersion: number | null | undefined): number =>
  (targetOpStreamVersion ?? OP_STREAM_VERSION) >= READ_OP_STREAM_VERSION ? READ_OP_STREAM_VERSION : OP_STREAM_VERSION;

/**
 * Lowest op-stream version this build can still apply. A stream whose `opStreamVersion` exceeds this build's
 * `READ_OP_STREAM_VERSION` is too new and must be refused *before* `buildOpStatements` runs (`currentLibrarySupport`
 * carries `READ_OP_STREAM_VERSION`, so a switched account's version-4 stream passes the gate of a v4 build). Raising
 * this lower bound is the deliberate act that drops support for an old op vocabulary.
 */
export const MIN_SUPPORTED_OP_STREAM_VERSION = 1;

/**
 * An op `type` reached `buildOpStatements` that it has no builder for.
 *
 * Within a supported `opStreamVersion`, every op type is known to the client.
 * The Part D version gate refuses streams the client is too old for *before*
 * `buildOpStatements` runs — so an unknown type past the gate is a genuine bug
 * (a new variant added without a builder, or a corrupt op), never version
 * skew, and must fail loud rather than be silently dropped.
 */
export class UnknownOpTypeError extends Error {
  readonly opType: string;
  constructor(opType: string) {
    super(`UNKNOWN_OP_TYPE: ${opType}`);
    this.name = "UnknownOpTypeError";
    this.opType = opType;
  }
}

/**
 * LIB-FMT-11: an op of change types 4 (or a translated old `media.upsert`) reached `buildOpStatements` without
 * `packedPlayback`, i.e. before this library's playback group was converted (`convertPlaybackToPackedLayout`). No
 * version-4 op exists before the account is switched, and every device converts before it applies anything newer, so
 * this is a caller bug: fail loud rather than write rows the old layout cannot hold.
 */
export class PlaybackLayoutError extends Error {
  readonly opType: string;
  constructor(opType: string) {
    super(`PLAYBACK_LAYOUT: ${opType} needs the packed playback layout (buildOpStatements packedPlayback)`);
    this.name = "PlaybackLayoutError";
    this.opType = opType;
  }
}

/** LIB-OPS-01: an op of a known type whose payload has a shape no writer produces. Refused, never skipped. */
export class LibraryOpShapeError extends Error {
  readonly opType: string;
  constructor(opType: string, detail: string) {
    super(`LIBRARY_OP_SHAPE: ${opType}: ${detail}`);
    this.name = "LibraryOpShapeError";
    this.opType = opType;
  }
}

export type BuildOpOptions = {
  /**
   * The playback group holds packed chunk lists (`media_chunk_lists`, `media_file_playback`): set once this library
   * ran `convertPlaybackToPackedLayout`, which happens only after its account is switched (LIB-FMT-12/13). Without it
   * the statements are today's (per-chunk rows) and a version-4 op throws `PlaybackLayoutError`.
   */
  packedPlayback?: boolean;
};

export type LibrarySqlStatement = {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
};

export type OpStatementsByGroup = Readonly<
  Partial<Record<LibraryDbGroup, ReadonlyArray<LibrarySqlStatement>>>
>;

export type IdGenerator = () => string;

const TERMINAL_INGEST_STATUSES: ReadonlyArray<IngestJobStatus> = [
  "completed",
  "failed",
  "cancelled",
];

const clampProgressPct = (raw: unknown): number =>
  Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));

const metaJson = (meta: unknown): string | null =>
  meta && typeof meta === "object" ? JSON.stringify(meta) : null;

type GroupBuilder = {
  add: (sql: string, params: ReadonlyArray<unknown>) => void;
  list: () => ReadonlyArray<LibrarySqlStatement>;
};

const newGroupBuilder = (): GroupBuilder => {
  const list: LibrarySqlStatement[] = [];
  return {
    add: (sql, params) => {
      list.push({ sql, params });
    },
    list: () => list,
  };
};

type Builders = Record<LibraryDbGroup, GroupBuilder>;

const newBuilders = (): Builders => ({
  core: newGroupBuilder(),
  metadata: newGroupBuilder(),
  playback: newGroupBuilder(),
  ingest: newGroupBuilder(),
  templates: newGroupBuilder(),
});

const finalize = (b: Builders): OpStatementsByGroup => {
  const out: { [G in LibraryDbGroup]?: ReadonlyArray<LibrarySqlStatement> } = {};
  for (const group of ["core", "metadata", "playback", "ingest", "templates"] as const) {
    const list = b[group].list();
    if (list.length > 0) out[group] = list;
  }
  return out;
};

const appendPlaylistCreate = (b: Builders, op: PlaylistCreateOp) => {
  const p = op.payload;
  const system = systemPlaylistForSlug(p.slug);
  if (system) {
    // LIB-SYNC-10: a system playlist has one id everywhere. A create naming another id (an older build) must not
    // REPLACE the row holding the slug, which would cascade-delete its items.
    b.core.add("INSERT OR IGNORE INTO playlists (id, name, slug, is_system, created_at) VALUES (?, ?, ?, ?, ?);", [
      system.id,
      system.name,
      system.slug,
      system.isSystem,
      p.createdAt,
    ]);
    return;
  }
  b.core.add(
    "INSERT OR REPLACE INTO playlists (id, name, slug, is_system, created_at) VALUES (?, ?, ?, ?, ?);",
    [p.id, p.name, p.slug, p.isSystem ? 1 : 0, p.createdAt]
  );
};

const appendPlaylistDelete = (b: Builders, op: PlaylistDeleteOp) => {
  b.core.add("DELETE FROM playlists WHERE id = ? AND is_system = 0;", [op.payload.id]);
};

const appendPlaylistItemAdd = (b: Builders, op: PlaylistItemAddOp) => {
  const p = op.payload;
  // LIB-SYNC-10: an item naming a playlist (or title) this library does not hold is dropped, not a foreign-key
  // failure that stops every later op from applying. The sender re-sends its system playlists' items once healed.
  b.core.add(
    `INSERT OR IGNORE INTO playlist_items (id, playlist_id, media_id, added_at)
     SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM playlists WHERE id = ?) AND EXISTS (SELECT 1 FROM media_items WHERE id = ?);`,
    [p.id, p.playlistId, p.mediaId, p.addedAt, p.playlistId, p.mediaId]
  );
};

const appendPlaylistItemRemove = (b: Builders, op: PlaylistItemRemoveOp) => {
  const p = op.payload;
  b.core.add("DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?;", [
    p.playlistId,
    p.mediaId,
  ]);
};

const appendMediaCore = (b: Builders, details: MediaDetailsV4, newId: IdGenerator) => {
  const mediaId = details.id;
  // An UPSERT guarded by the details clock, not INSERT OR REPLACE (LIB-SYNC-08):
  // - an upsert older than the stored `updated_at` is ignored, so a stale
  //   pending op of an offline device cannot overwrite newer details;
  // - the progress columns (progress_pct, last_watched_at) are written only
  //   when the row is first created. A re-save of the details never carries
  //   viewing progress with it; progress travels in `media.progress`;
  // - columns this op does not carry (preferred_audio_language) survive.
  // `updated_at` is the clock of the DETAILS only: `media.progress` does not
  // touch it, so watching never makes an unrelated details edit look stale.
  b.core.add(
    `INSERT INTO media_items (
      id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path,
      added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      original_title = excluded.original_title,
      original_language = excluded.original_language,
      overview = excluded.overview,
      year = excluded.year,
      rating = excluded.rating,
      poster_path = excluded.poster_path,
      backdrop_path = excluded.backdrop_path,
      added_at = excluded.added_at,
      updated_at = excluded.updated_at,
      has_files = excluded.has_files,
      total_episodes = excluded.total_episodes
    WHERE excluded.updated_at >= media_items.updated_at;`,
    [
      mediaId,
      details.type,
      details.title,
      details.originalTitle,
      details.originalLanguage,
      details.overview,
      details.year,
      details.rating,
      details.posterPath,
      details.backdropPath,
      details.addedAt,
      details.updatedAt,
      details.hasFiles ? 1 : 0,
      details.progressPct,
      details.lastWatchedAt,
      details.totalEpisodes,
    ]
  );

  // A stale upsert (rejected by the guard above) must not rewrite the
  // children either: every statement below runs only while the row carries
  // this op's `updated_at`.
  const rowIsThisUpsert = "EXISTS (SELECT 1 FROM media_items WHERE id = ? AND updated_at = ?)";
  const rowParams = [mediaId, details.updatedAt];
  b.core.add(`DELETE FROM media_external_ids WHERE media_id = ? AND ${rowIsThisUpsert};`, [mediaId, ...rowParams]);
  if (details.catalogId !== null) {
    b.core.add(
      `INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id)
       SELECT ?, ?, ?, ?, ? WHERE ${rowIsThisUpsert};`,
      [newId(), mediaId, details.type, CATALOG_ID_SOURCE, String(details.catalogId), ...rowParams]
    );
  }

  b.core.add(`DELETE FROM media_genres WHERE media_id = ? AND ${rowIsThisUpsert};`, [mediaId, ...rowParams]);
  const genres = details.genres ?? [];
  for (const genreId of genres) {
    b.core.add(
      `INSERT OR IGNORE INTO media_genres (id, media_id, genre_id)
       SELECT ?, ?, ? WHERE ${rowIsThisUpsert};`,
      [newId(), mediaId, genreId, ...rowParams]
    );
  }
};

const appendMediaMetadata = (b: Builders, details: MediaDetailsV4, newId: IdGenerator) => {
  const mediaId = details.id;
  const cast = details.cast ?? [];
  const trailers = details.trailers ?? [];
  const seasons = details.seasons ?? [];
  const episodes = details.episodes ?? [];
  const files = details.files ?? [];
  const skipMarkers = Array.isArray(details.skipMarkers) ? details.skipMarkers : [];

  b.metadata.add("DELETE FROM media_roles WHERE media_id = ?;", [mediaId]);
  for (const [index, member] of cast.entries()) {
    b.metadata.add(
      "INSERT OR REPLACE INTO people (id, name, profile_path) VALUES (?, ?, ?);",
      [member.personId, member.name, member.profilePath ?? null]
    );
    if (member.catalogId !== null) {
      b.metadata.add(
        "INSERT OR IGNORE INTO people_external_ids (id, person_id, source, external_id) VALUES (?, ?, ?, ?);",
        [newId(), member.personId, CATALOG_ID_SOURCE, String(member.catalogId)]
      );
    }
    b.metadata.add(
      "INSERT OR REPLACE INTO media_roles (id, media_id, person_id, role, order_index) VALUES (?, ?, ?, ?, ?);",
      [member.id, mediaId, member.personId, member.role, index]
    );
  }

  // LIB-CREW-01: an op from a client that predates crew carries no `crew` and leaves the stored credits alone.
  if (Array.isArray(details.crew)) {
    b.metadata.add("DELETE FROM media_crew WHERE media_id = ?;", [mediaId]);
    for (const [index, member] of details.crew.entries()) {
      b.metadata.add("INSERT OR REPLACE INTO people (id, name, profile_path) VALUES (?, ?, ?);", [
        member.personId,
        member.name,
        member.profilePath ?? null,
      ]);
      if (member.catalogId !== null) {
        b.metadata.add(
          "INSERT OR IGNORE INTO people_external_ids (id, person_id, source, external_id) VALUES (?, ?, ?, ?);",
          [newId(), member.personId, CATALOG_ID_SOURCE, String(member.catalogId)]
        );
      }
      b.metadata.add(
        "INSERT OR REPLACE INTO media_crew (id, media_id, person_id, job, order_index) VALUES (?, ?, ?, ?, ?);",
        [member.id, mediaId, member.personId, member.job, index]
      );
    }
  }

  b.metadata.add("DELETE FROM media_trailers WHERE media_id = ?;", [mediaId]);
  for (const trailer of trailers) {
    b.metadata.add(
      "INSERT INTO media_trailers (id, media_id, provider, key, name, language) VALUES (?, ?, ?, ?, ?, ?);",
      [newId(), mediaId, trailer.provider, trailer.key, trailer.name, trailer.language]
    );
  }

  b.metadata.add("DELETE FROM media_seasons WHERE media_id = ?;", [mediaId]);
  for (const season of seasons) {
    b.metadata.add(
      "INSERT OR REPLACE INTO media_seasons (id, media_id, season_number, title, overview, poster_path, episode_count, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
      [
        season.id,
        mediaId,
        season.seasonNumber,
        season.name,
        season.overview,
        season.posterPath,
        season.episodeCount,
        season.airDate,
      ]
    );
  }

  b.metadata.add("DELETE FROM media_episodes WHERE media_id = ?;", [mediaId]);
  for (const episode of episodes) {
    b.metadata.add(
      "INSERT OR REPLACE INTO media_episodes (id, media_id, season_number, episode_number, title, overview, still_path, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
      [
        episode.id,
        mediaId,
        episode.seasonNumber,
        episode.episodeNumber,
        episode.name,
        episode.overview,
        episode.stillPath,
        episode.airDate,
      ]
    );
  }

  b.metadata.add("DELETE FROM media_file_desired_formats WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_files WHERE media_id = ?;", [mediaId]);
  // LIB-EDIT-01: the title's editions, then each file with its edition.
  for (const [sql, params] of mediaFilesAndEditionsStatements(details)) b.metadata.add(sql, params);
  for (const file of files) {
    for (const format of file.desiredFormats) {
      b.metadata.add(
        "INSERT OR IGNORE INTO media_file_desired_formats (id, media_id, file_id, quality, codec, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?);",
        [newId(), mediaId, file.id, format.quality, format.codec, format.bitrateKbps ?? null]
      );
    }
  }

  b.metadata.add("DELETE FROM media_skip_markers WHERE media_id = ?;", [mediaId]);
  for (const marker of skipMarkers) {
    b.metadata.add(
      `INSERT OR REPLACE INTO media_skip_markers (
        id, media_id, episode_id, type, start_seconds, end_seconds, source, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        marker.id,
        mediaId,
        marker.episodeId ?? null,
        marker.type,
        marker.startSeconds,
        marker.endSeconds,
        marker.source,
        marker.confidence ?? null,
        marker.createdAt,
        marker.updatedAt,
      ]
    );
  }
};

const appendMediaPlayback = (b: Builders, details: MediaDetails, newId: IdGenerator) => {
  const mediaId = details.id;
  const formats = details.formats ?? [];
  const audioTracks = details.audioTracks ?? [];
  const subtitles = details.subtitles ?? [];
  const chapters = details.chapters ?? [];

  b.playback.add(
    "DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
    [mediaId]
  );
  b.playback.add(
    "DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
    [mediaId]
  );
  // media_formats rows are NOT deleted up front: an insert below may need the stored preview sheets of its
  // row, so the stale rows go after the inserts (see the end of the formats loop).
  b.playback.add(
    "DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);",
    [mediaId]
  );
  b.playback.add("DELETE FROM media_audio_tracks WHERE media_id = ?;", [mediaId]);
  b.playback.add("DELETE FROM media_subtitles WHERE media_id = ?;", [mediaId]);

  for (const format of formats) {
    // Seek-bar preview sheets (MPV-PREV-01, additive, no op-stream bump). A writer that does not know the field
    // (Kodi addon, mobile, older desktops) omits it: keep what is stored for this format — its own row by id,
    // else the row of the same file + quality — instead of erasing the record (GC would then delete the
    // sheets). An explicit value (object or null) wins. The subquery runs before INSERT OR REPLACE drops the row.
    const keepPreviews = format.previewSheets === undefined;
    b.playback.add(
      `INSERT OR REPLACE INTO media_formats (
        id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, duration_seconds, total_size, size_mb, is_source,
        preview_sheets
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${
        keepPreviews
          ? "(SELECT preview_sheets FROM media_formats WHERE media_id = ? AND (id = ? OR (file_id = ? AND quality = ?)) ORDER BY id = ? DESC LIMIT 1)"
          : "?"
      });`,
      [
        format.id,
        mediaId,
        format.fileId,
        format.quality,
        format.codec,
        format.codecString ?? null,
        format.bitrateKbps ?? null,
        format.initKey ?? null,
        format.initSize ?? null,
        format.durationSeconds ?? null,
        format.totalSize ?? null,
        format.sizeMb,
        // Op-stream v2: persisted via the publisher's snapshot of the local
        // `is_source` bit so replays on other clients preserve the
        // source-of-record marker. Pre-v2 payloads omit this column; replay
        // there relies on the schema DEFAULT 0 (the consumer's runtime fills
        // it back in at the next source-job commit).
        format.isSource ? 1 : 0,
        ...(keepPreviews
          ? [mediaId, format.id, format.fileId, format.quality, format.id]
          : [format.previewSheets ? JSON.stringify(format.previewSheets) : null]),
      ]
    );
    const formatChunks = format.chunks ?? [];
    for (let i = 0; i < formatChunks.length; i += 1) {
      const chunk = formatChunks[i]!;
      b.playback.add(
        "INSERT OR REPLACE INTO media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
        [newId(), format.id, chunk.key, i, chunk.sizeBytes ?? null, chunk.startSeconds ?? null]
      );
    }
  }
  // Format rows the payload no longer carries (their chunks and chapters were deleted above).
  if (formats.length) {
    b.playback.add(
      `DELETE FROM media_formats WHERE media_id = ? AND id NOT IN (${formats.map(() => "?").join(", ")});`,
      [mediaId, ...formats.map((format) => format.id)]
    );
  } else {
    b.playback.add("DELETE FROM media_formats WHERE media_id = ?;", [mediaId]);
  }

  for (const chapter of chapters) {
    b.playback.add(
      "INSERT OR REPLACE INTO media_chapters (id, format_id, title, start_seconds) VALUES (?, ?, ?, ?);",
      [chapter.id, chapter.formatId, chapter.title, chapter.startSeconds]
    );
  }

  for (const track of audioTracks) {
    b.playback.add(
      `INSERT OR REPLACE INTO media_audio_tracks (
        id, media_id, file_id, episode_id, language, label, is_default, source, codec, codec_string, init_key, init_size, duration_seconds, total_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        track.id,
        mediaId,
        track.fileId ?? null,
        track.episodeId ?? null,
        track.language,
        track.label,
        track.isDefault ? 1 : 0,
        track.source,
        track.codec ?? null,
        track.codecString ?? null,
        track.initKey ?? null,
        track.initSize ?? null,
        track.durationSeconds ?? null,
        track.totalSize ?? null,
        details.updatedAt,
      ]
    );
    const audioChunks = track.chunks ?? [];
    for (let i = 0; i < audioChunks.length; i += 1) {
      const chunk = audioChunks[i]!;
      b.playback.add(
        "INSERT OR REPLACE INTO media_audio_chunks (id, track_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
        [newId(), track.id, chunk.key, i, chunk.sizeBytes ?? null, chunk.startSeconds ?? null]
      );
    }
  }

  for (const subtitle of subtitles) {
    b.playback.add(
      `INSERT OR REPLACE INTO media_subtitles (
        id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, created_at,
        derived_from_subtitle_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        subtitle.id,
        mediaId,
        subtitle.fileId ?? null,
        subtitle.episodeId ?? null,
        subtitle.language,
        subtitle.label,
        subtitle.objectKey ?? null,
        subtitle.format ?? null,
        subtitle.isDefault ? 1 : 0,
        subtitle.source,
        subtitle.createdAt ?? details.updatedAt,
        // OCR twin link (PLAY-TRACK-05). Payloads from builds before the column omit it.
        subtitle.derivedFromSubtitleId ?? null,
      ]
    );
  }
};

// --- Change types 4: per-file playback with packed chunk lists (LIB-FMT-11) ------------------------------------------

/**
 * `media_file_playback.file_id` of a playback group: the file's id, `''` for the title's rows that name no file
 * (`file_id IS NULL`). The one place that maps between the two (SQLite cannot hold NULL in a primary key column).
 */
export const playbackFileKey = (fileId: string | null): string => fileId ?? "";

/** Inverse of `playbackFileKey`. */
export const playbackFileIdFromKey = (key: string): string | null => (key === "" ? null : key);

const V3_PLAYBACK_KEYS = ["formats", "audioTracks", "subtitles", "subtitleTracks", "chapters"] as const;

/**
 * The shape rule of LIB-FMT-11: ops carry no version of their own (only the account does) and an old op written
 * before the switch can sit in a page declared 4, so the payload decides. A `media.upsert` whose details carry any
 * playback key is the old type and is translated (`translateV3MediaUpsert`); one without is the version-4 upsert and
 * never touches playback. The one guard every TS reader narrows a `media.upsert` with (Kodi ports it).
 */
export const isV3MediaUpsert = (op: MediaUpsertOp | MediaUpsertV4Op): op is MediaUpsertOp =>
  V3_PLAYBACK_KEYS.some((key) => Reflect.get(op.payload.details, key) !== undefined);

/**
 * Ops whose metadata / playback / templates statements a receiver always runs, in op order, after the batch's core
 * statements (LIB-SYNC-22). They hold no core clock to check: the version-4 playback and episode ops carry their own
 * (LIB-SYNC-08), and a `media.delete` must clear every file the title has rows in, or its playback rows outlive it.
 * `media.upsert` is the one other op reaching those files; its rows go on only while the core row kept its clock.
 */
export const isSecondaryOnlyOp = (op: LibraryOp) =>
  op.type === "media.delete" ||
  op.type === "media.file.playback.set" ||
  op.type === "media.file.playback.delete" ||
  op.type === "media.episode.delete";

/** An old `media.upsert` as change types 4 (vault v4 plan §1.1; vectors: `test-vectors/chunk-lists.json` `translations`). */
export type TranslatedMediaUpsert = {
  upsert: MediaUpsertV4Op;
  /** One per file the title names (its `files`, then any other file a row names), then the no-file group, always. */
  playbackSets: MediaFilePlaybackSetOp[];
  /**
   * The old upsert replaced the title's whole playback: rows of a file not in `keepFileIds` are deleted (unless that
   * file's playback clock is newer than the upsert). Only a translated upsert prunes; a version-4 upsert never does.
   */
  prune: { mediaId: string; updatedAt: string; keepFileIds: string[] };
};

/**
 * Translate an old `media.upsert` (playback inline, one row per chunk) into the version-4 op set. Pure; ported by
 * Kodi, checked by every port against the `translations` vectors. Every set carries the details' `updatedAt` as its
 * clock; a chapter whose format is not in the payload is dropped (no reader could ever show it).
 */
export const translateV3MediaUpsert = (op: MediaUpsertOp): TranslatedMediaUpsert => {
  const details = neutralMediaDetails(op.payload.details);
  const { formats = [], audioTracks = [], subtitles, subtitleTracks, chapters = [], ...core } = details;
  const subtitleRows = subtitles ?? subtitleTracks ?? [];
  const fileIds: string[] = [];
  const seen = new Set<string>();
  for (const fileId of [
    ...(details.files ?? []).map((file) => file.id),
    ...formats.map((format) => format.fileId),
    ...audioTracks.map((track) => track.fileId),
    ...subtitleRows.map((subtitle) => subtitle.fileId),
  ]) {
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    fileIds.push(fileId);
  }
  const formatFile = new Map(formats.map((format) => [format.id, format.fileId ?? null]));
  const playbackSets = [...fileIds, null].map(
    (fileId): MediaFilePlaybackSetOp => ({
      id: `${op.id}:playback:${playbackFileKey(fileId)}`,
      type: "media.file.playback.set",
      createdAt: op.createdAt,
      payload: {
        mediaId: details.id,
        fileId,
        updatedAt: details.updatedAt,
        formats: formats
          .filter((format) => (format.fileId ?? null) === fileId)
          .map(({ chunks, ...format }) => ({ ...format, chunkList: chunkListToJson(packChunkList(chunks ?? [])) })),
        audioTracks: audioTracks
          .filter((track) => (track.fileId ?? null) === fileId)
          .map(({ chunks, ...track }) => ({ ...track, chunkList: chunkListToJson(packChunkList(chunks ?? [])) })),
        subtitles: subtitleRows.filter((subtitle) => (subtitle.fileId ?? null) === fileId),
        chapters: chapters.filter((chapter) => formatFile.has(chapter.formatId) && formatFile.get(chapter.formatId) === fileId),
      },
    })
  );
  return {
    upsert: { id: `${op.id}:upsert`, type: "media.upsert", createdAt: op.createdAt, payload: { details: core } },
    playbackSets,
    prune: { mediaId: details.id, updatedAt: details.updatedAt, keepFileIds: fileIds },
  };
};

/** A packed list's row values, validated (LIB-OPS-01: a list that does not decode is refused, never stored). */
const chunkListRow = (opType: string, json: PackedChunkListJson) => {
  try {
    const list = chunkListFromJson(json);
    decodeChunkSizes(list.sizes, list.count);
    decodeChunkStarts(list.starts, list.count);
    // A seed derives its keys on read; any other mode must hold exactly `count` keys.
    if (list.keyMode !== CHUNK_LIST_KEY_MODE.seed) chunkListKeys(list);
    return list;
  } catch (error) {
    throw new LibraryOpShapeError(opType, `bad chunkList: ${error instanceof Error ? error.message : String(error)}`);
  }
};

type SqlGuard = { sql: string; params: ReadonlyArray<unknown> };

const NO_GUARD: SqlGuard = { sql: "1", params: [] };

/** Deletes one file group's chunk lists and chapters (formats and tracks stay; the caller decides). */
const appendFileListsClear = (b: Builders, mediaId: string, fileId: string | null, guard: SqlGuard) => {
  const scope = [mediaId, fileId, ...guard.params];
  b.playback.add(
    `DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_formats WHERE media_id = ? AND file_id IS ?) AND ${guard.sql};`,
    scope
  );
  b.playback.add(
    `DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ? AND file_id IS ?) AND ${guard.sql};`,
    scope
  );
  b.playback.add(
    `DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ? AND file_id IS ?) AND ${guard.sql};`,
    scope
  );
};

const appendChunkListInsert = (
  b: Builders,
  opType: string,
  ownerId: string,
  ownerKind: ChunkListOwnerKind,
  json: PackedChunkListJson,
  updatedAt: string,
  guard: SqlGuard
) => {
  const list = chunkListRow(opType, json);
  b.playback.add(
    `INSERT OR REPLACE INTO media_chunk_lists (owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql};`,
    [ownerId, ownerKind, list.placementId, list.keyMode, list.keyData, list.count, list.sizes, list.starts, updatedAt, ...guard.params]
  );
};

/**
 * `media.file.playback.set`: replaces one file group's playback, guarded by that group's clock (LIB-SYNC-08): an
 * older set than the stored one changes nothing; an equal one applies (the later arrival wins a tie).
 */
const appendFilePlaybackSet = (b: Builders, op: MediaFilePlaybackSetOp) => {
  const { mediaId, fileId, updatedAt, formats, audioTracks, subtitles, chapters } = op.payload;
  const formatIds = new Set(formats.map((format) => format.id));
  for (const row of [...formats, ...audioTracks, ...subtitles]) {
    if ((row.fileId ?? null) !== fileId) throw new LibraryOpShapeError(op.type, `row ${row.id} names file ${String(row.fileId)}, not ${String(fileId)}`);
  }
  for (const chapter of chapters) {
    if (!formatIds.has(chapter.formatId)) throw new LibraryOpShapeError(op.type, `chapter ${chapter.id} names format ${chapter.formatId} outside this file`);
  }
  const fileKey = playbackFileKey(fileId);
  b.playback.add(
    `INSERT INTO media_file_playback (media_id, file_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(media_id, file_id) DO UPDATE SET updated_at = excluded.updated_at
     WHERE excluded.updated_at >= media_file_playback.updated_at;`,
    [mediaId, fileKey, updatedAt]
  );
  const guard: SqlGuard = {
    sql: "EXISTS (SELECT 1 FROM media_file_playback WHERE media_id = ? AND file_id = ? AND updated_at = ?)",
    params: [mediaId, fileKey, updatedAt],
  };
  appendFileListsClear(b, mediaId, fileId, guard);

  for (const format of formats) {
    // Seek-bar previews (MPV-PREV-01): a format without the field keeps what is stored, as in `appendMediaPlayback`.
    const keepPreviews = format.previewSheets === undefined;
    b.playback.add(
      `INSERT OR REPLACE INTO media_formats (
        id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, duration_seconds, total_size, size_mb, is_source,
        preview_sheets
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${
        keepPreviews
          ? "(SELECT preview_sheets FROM media_formats WHERE media_id = ? AND (id = ? OR (file_id = ? AND quality = ?)) ORDER BY id = ? DESC LIMIT 1)"
          : "?"
      } WHERE ${guard.sql};`,
      [
        format.id,
        mediaId,
        format.fileId,
        format.quality,
        format.codec,
        format.codecString ?? null,
        format.bitrateKbps ?? null,
        format.initKey ?? null,
        format.initSize ?? null,
        format.durationSeconds ?? null,
        format.totalSize ?? null,
        format.sizeMb,
        format.isSource ? 1 : 0,
        ...(keepPreviews
          ? [mediaId, format.id, format.fileId, format.quality, format.id]
          : [format.previewSheets ? JSON.stringify(format.previewSheets) : null]),
        ...guard.params,
      ]
    );
    appendChunkListInsert(b, op.type, format.id, CHUNK_LIST_OWNER_KIND.format, format.chunkList, updatedAt, guard);
  }
  b.playback.add(
    `DELETE FROM media_formats WHERE media_id = ? AND file_id IS ? AND id NOT IN (${formats.map(() => "?").join(", ")}) AND ${guard.sql};`,
    [mediaId, fileId, ...formats.map((format) => format.id), ...guard.params]
  );

  b.playback.add(`DELETE FROM media_audio_tracks WHERE media_id = ? AND file_id IS ? AND ${guard.sql};`, [
    mediaId,
    fileId,
    ...guard.params,
  ]);
  for (const track of audioTracks) {
    b.playback.add(
      `INSERT OR REPLACE INTO media_audio_tracks (
        id, media_id, file_id, episode_id, language, label, is_default, source, codec, codec_string, init_key, init_size, duration_seconds, total_size, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql};`,
      [
        track.id,
        mediaId,
        fileId,
        track.episodeId ?? null,
        track.language,
        track.label,
        track.isDefault ? 1 : 0,
        track.source,
        track.codec ?? null,
        track.codecString ?? null,
        track.initKey ?? null,
        track.initSize ?? null,
        track.durationSeconds ?? null,
        track.totalSize ?? null,
        updatedAt,
        ...guard.params,
      ]
    );
    appendChunkListInsert(b, op.type, track.id, CHUNK_LIST_OWNER_KIND.audioTrack, track.chunkList, updatedAt, guard);
  }

  b.playback.add(`DELETE FROM media_subtitles WHERE media_id = ? AND file_id IS ? AND ${guard.sql};`, [
    mediaId,
    fileId,
    ...guard.params,
  ]);
  for (const subtitle of subtitles) {
    b.playback.add(
      `INSERT OR REPLACE INTO media_subtitles (
        id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, created_at,
        derived_from_subtitle_id
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql};`,
      [
        subtitle.id,
        mediaId,
        fileId,
        subtitle.episodeId ?? null,
        subtitle.language,
        subtitle.label,
        subtitle.objectKey ?? null,
        subtitle.format ?? null,
        subtitle.isDefault ? 1 : 0,
        subtitle.source,
        subtitle.createdAt ?? updatedAt,
        subtitle.derivedFromSubtitleId ?? null,
        ...guard.params,
      ]
    );
  }

  for (const chapter of chapters) {
    b.playback.add(
      `INSERT OR REPLACE INTO media_chapters (id, format_id, title, start_seconds) SELECT ?, ?, ?, ? WHERE ${guard.sql};`,
      [chapter.id, chapter.formatId, chapter.title, chapter.startSeconds, ...guard.params]
    );
  }
};

/** One file group's playback gone, with its offline copy bookkeeping and its clock (no clock guards a delete). */
const appendFilePlaybackDelete = (b: Builders, mediaId: string, fileId: string | null) => {
  appendFileListsClear(b, mediaId, fileId, NO_GUARD);
  b.playback.add("DELETE FROM media_formats WHERE media_id = ? AND file_id IS ?;", [mediaId, fileId]);
  b.playback.add("DELETE FROM media_audio_tracks WHERE media_id = ? AND file_id IS ?;", [mediaId, fileId]);
  b.playback.add("DELETE FROM media_subtitles WHERE media_id = ? AND file_id IS ?;", [mediaId, fileId]);
  if (fileId !== null) b.playback.add("DELETE FROM media_local_downloads WHERE file_id = ?;", [fileId]);
  b.playback.add("DELETE FROM media_file_playback WHERE media_id = ? AND file_id = ?;", [mediaId, playbackFileKey(fileId)]);
};

/** `media.episode.delete`: the episode and only its rows, in every group (the writer names its files). */
const appendEpisodeDelete = (b: Builders, op: MediaEpisodeDeleteOp) => {
  const { mediaId, episodeId, seasonNumber, episodeNumber, fileIds } = op.payload;
  const fileList = fileIds.map(() => "?").join(", ");
  const episodeFiles = `media_id = ? AND (id IN (${fileList}) OR (season = ? AND episode = ?))`;
  const episodeFileParams = [mediaId, ...fileIds, seasonNumber, episodeNumber];
  b.metadata.add("DELETE FROM media_episodes WHERE media_id = ? AND season_number = ? AND episode_number = ?;", [
    mediaId,
    seasonNumber,
    episodeNumber,
  ]);
  if (episodeId !== null) {
    b.metadata.add("DELETE FROM media_skip_markers WHERE media_id = ? AND episode_id = ?;", [mediaId, episodeId]);
  }
  b.metadata.add(
    `DELETE FROM media_file_desired_formats WHERE file_id IN (SELECT id FROM media_files WHERE ${episodeFiles});`,
    episodeFileParams
  );
  b.metadata.add(`DELETE FROM media_files WHERE ${episodeFiles};`, episodeFileParams);
  b.metadata.add("DELETE FROM media_editions WHERE media_id = ? AND season = ? AND episode = ?;", [
    mediaId,
    seasonNumber,
    episodeNumber,
  ]);
  for (const fileId of fileIds) appendFilePlaybackDelete(b, mediaId, fileId);
  if (episodeId !== null) {
    b.playback.add(
      "DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ? AND episode_id = ?);",
      [mediaId, episodeId]
    );
    b.playback.add("DELETE FROM media_audio_tracks WHERE media_id = ? AND episode_id = ?;", [mediaId, episodeId]);
    b.playback.add("DELETE FROM media_subtitles WHERE media_id = ? AND episode_id = ?;", [mediaId, episodeId]);
  }
};

/**
 * The prune of a translated old upsert: the title's rows of files it no longer names, unless that file's playback
 * clock is newer than the upsert. Rows that name no file are the no-file set's, never pruned here.
 */
const appendTranslatedPrune = (b: Builders, prune: TranslatedMediaUpsert["prune"]) => {
  const { mediaId, updatedAt, keepFileIds } = prune;
  const keep = keepFileIds.map(() => "?").join(", ");
  const scope = (table: string): SqlGuard => ({
    sql: `${table}.media_id = ? AND ${table}.file_id IS NOT NULL AND ${table}.file_id NOT IN (${keep})
      AND NOT EXISTS (SELECT 1 FROM media_file_playback c WHERE c.media_id = ${table}.media_id AND c.file_id = ${table}.file_id AND c.updated_at > ?)`,
    params: [mediaId, ...keepFileIds, updatedAt],
  });
  const formats = scope("media_formats");
  const tracks = scope("media_audio_tracks");
  const subtitles = scope("media_subtitles");
  b.playback.add(`DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_formats WHERE ${formats.sql});`, formats.params);
  b.playback.add(`DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_audio_tracks WHERE ${tracks.sql});`, tracks.params);
  b.playback.add(`DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE ${formats.sql});`, formats.params);
  b.playback.add(`DELETE FROM media_formats WHERE ${formats.sql};`, formats.params);
  b.playback.add(`DELETE FROM media_audio_tracks WHERE ${tracks.sql};`, tracks.params);
  b.playback.add(`DELETE FROM media_subtitles WHERE ${subtitles.sql};`, subtitles.params);
  b.playback.add(
    `DELETE FROM media_file_playback WHERE media_id = ? AND file_id <> '' AND file_id NOT IN (${keep}) AND updated_at <= ?;`,
    [mediaId, ...keepFileIds, updatedAt]
  );
};

const appendMediaUpsert = (
  b: Builders,
  op: MediaUpsertOp | MediaUpsertV4Op,
  newId: IdGenerator,
  options: BuildOpOptions
) => {
  if (!isV3MediaUpsert(op)) {
    // A version-4 upsert: core and metadata only. Playback travels in `media.file.playback.*` and is never pruned
    // here. An op of op stream v1–v2 with no playback key has this shape too, so its old catalog keys are still read.
    const details = neutralMediaDetails(op.payload.details);
    appendMediaCore(b, details, newId);
    appendMediaMetadata(b, details, newId);
  } else {
    const raw = op.payload.details;
    for (const key of ["formats", "audioTracks"] as const) {
      const rows: ReadonlyArray<object> | undefined = raw[key];
      if (Array.isArray(rows) && rows.some((row) => "chunkList" in row)) {
        throw new LibraryOpShapeError(op.type, `${key} carry packed chunkList; a version-4 upsert carries no playback`);
      }
    }
    if (!options.packedPlayback) {
      const details = neutralMediaDetails(raw);
      appendMediaCore(b, details, newId);
      appendMediaMetadata(b, details, newId);
      appendMediaPlayback(b, details, newId);
    } else {
      const translated = translateV3MediaUpsert(op);
      const details = translated.upsert.payload.details;
      appendMediaCore(b, details, newId);
      appendMediaMetadata(b, details, newId);
      appendTranslatedPrune(b, translated.prune);
      for (const set of translated.playbackSets) appendFilePlaybackSet(b, set);
    }
  }
  // Stale ML analysis must be cleared whenever the media payload is rewritten.
  // The templates group is desktop-only — mobile silently drops it.
  b.templates.add("DELETE FROM media_skip_analysis WHERE media_id = ?;", [op.payload.details.id]);
};

const appendMediaDelete = (b: Builders, op: MediaDeleteOp, options: BuildOpOptions) => {
  const mediaId = op.payload.mediaId;
  b.core.add("DELETE FROM media_external_ids WHERE media_id = ?;", [mediaId]);
  b.core.add("DELETE FROM media_genres WHERE media_id = ?;", [mediaId]);
  b.core.add("DELETE FROM playlist_items WHERE media_id = ?;", [mediaId]);
  b.core.add("DELETE FROM media_items WHERE id = ?;", [mediaId]);

  b.metadata.add("DELETE FROM media_roles WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_crew WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_trailers WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_seasons WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_episodes WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_skip_markers WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_file_desired_formats WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_files WHERE media_id = ?;", [mediaId]);
  b.metadata.add("DELETE FROM media_editions WHERE media_id = ?;", [mediaId]);

  if (options.packedPlayback) {
    b.playback.add(
      "DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
      [mediaId]
    );
    b.playback.add(
      "DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);",
      [mediaId]
    );
    b.playback.add("DELETE FROM media_file_playback WHERE media_id = ?;", [mediaId]);
  }
  b.playback.add(
    "DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
    [mediaId]
  );
  b.playback.add(
    "DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
    [mediaId]
  );
  b.playback.add("DELETE FROM media_formats WHERE media_id = ?;", [mediaId]);
  b.playback.add(
    "DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);",
    [mediaId]
  );
  b.playback.add("DELETE FROM media_audio_tracks WHERE media_id = ?;", [mediaId]);
  b.playback.add("DELETE FROM media_subtitles WHERE media_id = ?;", [mediaId]);
  // Phase 2 offline downloads: `media_local_downloads` is in the playback
  // group; the FK to `media_files` (in the metadata group) cannot cascade
  // across SQLite files when each group's connection has
  // `PRAGMA foreign_keys=OFF`. Drop the rows explicitly so the
  // cross-group-cascade-lint passes and so the runtime's media-delete
  // handler isn't left guessing about residual bookkeeping. The actual
  // on-disk file unlinks are handled by `apps/runtime/src/modules/badger.ts`
  // `runMediaDelete` BEFORE this op stream runs.
  b.playback.add("DELETE FROM media_local_downloads WHERE media_id = ?;", [mediaId]);

  b.ingest.add(
    "DELETE FROM ingest_job_events WHERE job_id IN (SELECT id FROM ingest_jobs WHERE media_id = ?);",
    [mediaId]
  );
  b.ingest.add("DELETE FROM ingest_jobs WHERE media_id = ?;", [mediaId]);

  b.templates.add("DELETE FROM media_skip_analysis WHERE media_id = ?;", [mediaId]);
  // Local-only OCR retry state (PLAY-TRACK-05) of the deleted media.
  b.templates.add("DELETE FROM subtitle_ocr_attempts WHERE media_id = ?;", [mediaId]);
};

const appendMediaProgress = (b: Builders, op: MediaProgressOp) => {
  const p = op.payload;
  // Progress has its own clock: the row's `last_watched_at` (every progress
  // write sets it to the op's time). An older progress op is ignored; an equal
  // one applies (the later arrival wins a tie). `updated_at` is the clock of
  // the media's details and is deliberately left alone (LIB-SYNC-08).
  b.core.add(
    `UPDATE media_items SET progress_pct = ?, last_watched_at = ?
     WHERE id = ? AND (last_watched_at IS NULL OR last_watched_at <= ?);`,
    [p.progressPct, p.lastWatchedAt, p.mediaId, p.updatedAt]
  );
};

const appendSettingSet = (b: Builders, op: SettingSetOp) => {
  const p = op.payload;
  b.core.add(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= app_settings.updated_at;`,
    [p.key, p.value, p.updatedAt]
  );
};

const appendIngestJobUpsert = (b: Builders, op: IngestJobUpsertOp) => {
  const job: IngestJob = op.payload.job;
  b.ingest.add(
    `INSERT INTO ingest_jobs (
      id, media_id, file_id, worker_peer_id, owner_client_id, kind, status, progress_pct,
      error_code, error_message, meta_json, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      media_id = excluded.media_id,
      file_id = excluded.file_id,
      worker_peer_id = excluded.worker_peer_id,
      owner_client_id = excluded.owner_client_id,
      kind = excluded.kind,
      status = excluded.status,
      progress_pct = excluded.progress_pct,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      meta_json = excluded.meta_json,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at;`,
    [
      job.id,
      job.mediaId,
      job.fileId ?? null,
      job.workerPeerId,
      job.ownerClientId ?? null,
      job.kind,
      job.status,
      clampProgressPct(job.progressPct),
      job.errorCode ?? null,
      job.errorMessage ?? null,
      metaJson(job.meta),
      job.createdAt,
      job.updatedAt,
      job.completedAt ?? null,
    ]
  );
};

const appendIngestJobDelete = (b: Builders, op: IngestJobDeleteOp) => {
  b.ingest.add("DELETE FROM ingest_job_events WHERE job_id = ?;", [op.payload.jobId]);
  b.ingest.add("DELETE FROM ingest_jobs WHERE id = ?;", [op.payload.jobId]);
};

const appendIngestJobEventAdd = (b: Builders, op: IngestJobEventAddOp) => {
  const event: IngestJobEvent = op.payload.event;
  b.ingest.add(
    `INSERT OR IGNORE INTO ingest_job_events (id, job_id, level, message, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [event.id, event.jobId, event.level, event.message, metaJson(event.meta), event.createdAt]
  );
};

const appendIngestJobHistoryClear = (b: Builders, op: IngestJobHistoryClearOp) => {
  const mediaId = op.payload.mediaId;
  const placeholders = TERMINAL_INGEST_STATUSES.map(() => "?").join(", ");
  b.ingest.add(
    `DELETE FROM ingest_job_events
     WHERE job_id IN (
       SELECT id FROM ingest_jobs WHERE media_id = ? AND status IN (${placeholders})
     );`,
    [mediaId, ...TERMINAL_INGEST_STATUSES]
  );
  b.ingest.add(
    `DELETE FROM ingest_jobs WHERE media_id = ? AND status IN (${placeholders});`,
    [mediaId, ...TERMINAL_INGEST_STATUSES]
  );
};

/**
 * Build the SQL statements one op should execute against the appropriate
 * per-group SQLite files. The returned map only contains keys for groups that
 * have at least one statement to run, so callers can iterate it directly.
 *
 * @param op  one LibraryOp from the shared wire format
 * @param idGen  produces fresh UUIDs for inserts whose primary key is server-derived
 *               (external_ids, genres, trailers, chunks, desired-format rows)
 */
export const buildOpStatements = (
  op: LibraryOp,
  idGen: IdGenerator,
  options: BuildOpOptions = {}
): OpStatementsByGroup => {
  const b = newBuilders();
  switch (op.type) {
    case "playlist.create":
      appendPlaylistCreate(b, op);
      break;
    case "playlist.delete":
      appendPlaylistDelete(b, op);
      break;
    case "playlist.item.add":
      appendPlaylistItemAdd(b, op);
      break;
    case "playlist.item.remove":
      appendPlaylistItemRemove(b, op);
      break;
    case "media.upsert":
      appendMediaUpsert(b, op, idGen, options);
      break;
    case "media.delete":
      appendMediaDelete(b, op, options);
      break;
    case "media.file.playback.set":
      if (!options.packedPlayback) throw new PlaybackLayoutError(op.type);
      appendFilePlaybackSet(b, op);
      break;
    case "media.file.playback.delete":
      if (!options.packedPlayback) throw new PlaybackLayoutError(op.type);
      appendFilePlaybackDelete(b, op.payload.mediaId, op.payload.fileId);
      break;
    case "media.episode.delete":
      if (!options.packedPlayback) throw new PlaybackLayoutError(op.type);
      appendEpisodeDelete(b, op);
      break;
    case "media.progress":
      appendMediaProgress(b, op);
      break;
    case "setting.set":
      appendSettingSet(b, op);
      break;
    case "ingest.job.upsert":
      appendIngestJobUpsert(b, op);
      break;
    case "ingest.job.delete":
      appendIngestJobDelete(b, op);
      break;
    case "ingest.job.event.add":
      appendIngestJobEventAdd(b, op);
      break;
    case "ingest.job.history.clear":
      appendIngestJobHistoryClear(b, op);
      break;
    default:
      // Within a supported `opStreamVersion` every op type above is known. The
      // Part D version gate refuses a too-new stream *before* this runs, so an
      // op type reaching this `default` is a genuine bug — a new variant added
      // without a builder, or a corrupt op — not version skew. Fail loud
      // instead of silently dropping it (which would advance the version
      // counter without applying the change → silent state divergence).
      throw new UnknownOpTypeError((op as { type: string }).type);
  }
  return finalize(b);
};

/**
 * Convenience: per-op-class entry points for tests and targeted use. Each
 * returns the same shape as `buildOpStatements`.
 */
export const buildMediaCoreStatements = (
  details: MediaDetails,
  idGen: IdGenerator
): OpStatementsByGroup => {
  const b = newBuilders();
  appendMediaCore(b, details, idGen);
  return finalize(b);
};

export const buildMediaMetadataStatements = (
  details: MediaDetails,
  idGen: IdGenerator
): OpStatementsByGroup => {
  const b = newBuilders();
  appendMediaMetadata(b, details, idGen);
  return finalize(b);
};

export const buildMediaPlaybackStatements = (
  details: MediaDetails,
  idGen: IdGenerator
): OpStatementsByGroup => {
  const b = newBuilders();
  appendMediaPlayback(b, details, idGen);
  return finalize(b);
};

export const buildMediaDeleteStatements = (mediaId: string, options: BuildOpOptions = {}): OpStatementsByGroup => {
  const b = newBuilders();
  appendMediaDelete(
    b,
    {
      id: "synthetic",
      type: "media.delete",
      createdAt: "",
      payload: { mediaId },
    },
    options
  );
  return finalize(b);
};
