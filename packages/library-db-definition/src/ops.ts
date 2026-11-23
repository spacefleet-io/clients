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
import type {
  IngestJob,
  IngestJobEvent,
  IngestJobStatus,
  MediaDetails,
} from "@space/shared";
import type {
  LibraryOp,
  MediaUpsertOp,
  MediaDeleteOp,
  MediaProgressOp,
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
 * Lowest op-stream version this build can still apply. A stream whose
 * `opStreamVersion` exceeds this build's `OP_STREAM_VERSION` is too new and
 * must be refused *before* `buildOpStatements` runs. Raising this lower bound
 * is the deliberate act that drops support for an old op vocabulary.
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

const appendMediaCore = (b: Builders, details: MediaDetails, newId: IdGenerator) => {
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

const appendMediaMetadata = (b: Builders, details: MediaDetails, newId: IdGenerator) => {
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

const appendMediaUpsert = (b: Builders, op: MediaUpsertOp, newId: IdGenerator) => {
  const details = neutralMediaDetails(op.payload.details);
  appendMediaCore(b, details, newId);
  appendMediaMetadata(b, details, newId);
  appendMediaPlayback(b, details, newId);
  // Stale ML analysis must be cleared whenever the media payload is rewritten.
  // The templates group is desktop-only — mobile silently drops it.
  b.templates.add("DELETE FROM media_skip_analysis WHERE media_id = ?;", [details.id]);
};

const appendMediaDelete = (b: Builders, op: MediaDeleteOp) => {
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
  idGen: IdGenerator
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
      appendMediaUpsert(b, op, idGen);
      break;
    case "media.delete":
      appendMediaDelete(b, op);
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

export const buildMediaDeleteStatements = (mediaId: string): OpStatementsByGroup => {
  const b = newBuilders();
  appendMediaDelete(b, {
    id: "synthetic",
    type: "media.delete",
    createdAt: "",
    payload: { mediaId },
  });
  return finalize(b);
};
