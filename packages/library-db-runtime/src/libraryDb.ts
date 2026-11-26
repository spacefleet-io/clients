import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db";
import {
  ApiError,
  deleteStorageObjects,
  getLibraryDb,
  getLibraryMeta,
  getLibraryOps,
  LibraryMeta,
  putLibraryDb,
  putLibraryOp,
  TitleDetails,
} from "./api";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { encryptBytesToBytes } from "./crypto";
import { decryptLibraryPayload, encryptOpPayload, encryptSnapshotBytes } from "./payloadCodec";
import { artworkDisplaySource, isCatalogImagePath, type ArtworkApplyResult, type ArtworkCopy, type ArtworkSlot } from "@space/library-db-definition/artworkCopy";
import { CATALOG_ID_SOURCE } from "@space/library-db-definition/catalogId";
import { CATALOG_ID_SOURCES } from "@space/library-db-definition/legacyFormat";
import {
  assertAccountLibraryKey,
  buildChunks,
  buildManifest,
  CHUNK_SIZE_BYTES,
  createKeyProbe,
  decodeStoredManifest,
  DESKTOP_CHUNK_REFS_SOURCE,
  downloadChunks,
  downloadObjectViaDedicatedSession,
  fetchManifestBytes,
  fetchManifestWithRetry,
  hashBytes,
  syncDebug,
  sealLibrarySnapshot,
  type RotationOwnLibrary,
  uploadChunks,
  type LibrarySnapshotManifest,
} from "./snapshotTransport";
import { isProgressClassOp, SNAPSHOT_TAIL_BYTES_THRESHOLD } from "@space/library-db-definition/opClass";
import {
  addProfilePlaylistItem,
  buildMediaProgressValue,
  collectMediaProgress,
  defaultProfilePlaylist,
  emptyPromotionPlan,
  EPISODE_RESUME_KEY_PREFIX,
  FAVORITES_PLAYLIST_ID,
  isMainScope,
  isPlaybackProgressSettingKey,
  isResumeSpotKey,
  listProfilePlaylists,
  MAIN_PROFILE_SETTING_KEY,
  MAIN_VIEWING_SCOPE,
  needsMainPromotion,
  parseProfilePlaylist,
  planMainPromotion,
  planMediaDeleteProfileCleanup,
  planProfileWipe,
  removeProfilePlaylistItem,
  viewingProfileIds,
  scopedEditionResumeKey,
  scopedEpisodeResumeKey,
  scopedMediaProgressKey,
  scopedPlaylistKey,
  scopedTrackPrefsKey,
  serializeProfilePlaylist,
  viewingScopeFor,
  type MediaProgress,
  type ProfilePlaylist,
  type ViewingScope,
} from "@space/shared/profileViewing";
import { isProfileSettingsKey, mergeProfileSettingsOps, resetProfileSettingsValue } from "@space/shared/profileSettings";
import { defaultEditionId, editionResumeValue } from "@space/shared/mediaEditions";
import { isLocalizedTextKey } from "@space/shared/localizedTexts";
import { LIBRARY_SYNC_STUCK_AFTER_409S, libraryRefusalFields } from "@space/shared/apiFailure";
import { createOrm, MainSqliteDatabase, openDatabase } from "./db";
import { abandonPreparedOffLoopWals, enableOffLoopWal, prepareOffLoopWal, registerOffLoopWal, releaseOffLoopWals } from "./walCheckpointer";
import {
  appSettings,
  ingestJobEvents,
  ingestJobs,
  mediaAudioChunks,
  mediaAudioTracks,
  mediaChapters,
  mediaEpisodes,
  mediaExternalIds,
  mediaFiles,
  mediaFileDesiredFormats,
  mediaFormats,
  mediaFormatChunks,
  mediaGenres,
  mediaItems,
  mediaLocalDownloads,
  mediaRoles,
  mediaCrew,
  mediaEditions,
  mediaSeasons,
  mediaSkipAnalysis,
  mediaSkipMarkers,
  mediaSubtitles,
  mediaTemplateAudioChunks,
  mediaTemplateAudioTracks,
  mediaTemplateChapters,
  mediaTemplateFormatChunks,
  mediaTemplateFormats,
  mediaTemplates,
  mediaTemplateSubtitles,
  mediaTrailers,
  people,
  peopleExternalIds,
  playlistItems,
  playlists,
  subtitleOcrAttempts,
} from "@space/library-db-definition/schema";
import {
  ensureLibrarySchema,
  ensureSystemPlaylists,
  rankQualityForSourceBackfill,
} from "@space/library-db-definition/migrations";
import { systemPlaylistForSlug } from "@space/library-db-definition/systemPlaylists";
import { runMigrations } from "@space/library-db-definition/migrationRunner";
import { backfillOriginalSizeFromSourceFormats } from "@space/library-db-definition/originalSize";
import { compactLibraryOps } from "@space/library-db-definition/opCompaction";
import { PACKED_PLAYBACK_DDL } from "@space/library-db-definition/packedPlayback";
import { artworkStorageKey, collectMediaDeleteKeys, collectMediaStorageKeys } from "@space/library-db-definition/mediaDetails";
import {
  buildOpStatements,
  isSecondaryOnlyOp,
  isV3MediaUpsert,
  OP_STREAM_VERSION,
  playbackFileKey,
  READ_OP_STREAM_VERSION,
  translateV3MediaUpsert,
  writeOpStreamVersion,
  type LibrarySqlStatement,
  type OpStatementsByGroup,
} from "@space/library-db-definition/ops";
import {
  base64ToBytes,
  chunkListKeys,
  chunkListToJson,
  CHUNK_LIST_OWNER_KIND,
  ChunkListFormatError,
  packChunkList,
  packSeededChunkList,
  unpackChunkList,
  type ChunkListKeyMode,
  type ChunkListOwnerKind,
  type ChunkRef,
  type PackedChunkList,
} from "@space/library-db-definition/chunkLists";
export { decodeStoredManifest };
import {
  assertLibraryCompatible,
  currentLibrarySupport,
  LibraryFormatTooNewError,
  type LibrarySupport,
} from "@space/library-db-definition/compatibility";
import type { LibraryDbGroup } from "@space/library-db-definition/manifest";

// Re-export the typed format-skew error so consumers that only depend on
// @space/library-db-runtime (e.g. the runtime's badger module) can catch it
// without taking a direct dependency on @space/library-db-definition. The
// runtime open path throws it *through* this package, so surfacing it here is
// part of this package's public contract.
export { LibraryFormatTooNewError };
import {
  desktopCoreMigrations,
  desktopIngestMigrations,
  desktopMetadataMigrations,
  desktopPlaybackMigrations,
  desktopPlaybackMigrationsPacked,
  desktopTemplatesMigrations,
  PACKED_PLAYBACK_LAYOUT_VERSION,
} from "./desktopMigrations";
import { splitGroupFromLegacy } from "./librarySplitMigration";
import {
  clearPending,
  getCacheDbPath,
  getCoreDbPath,
  getIngestDbPath,
  getMetadataDbPath,
  getPlaybackDbPath,
  getPreSplitBackupPath,
  getTemplatesDbPath,
  loadCache,
  loadPending,
  PendingSync,
  PendingOp,
  saveCache,
  savePending,
  savePendingOps,
  savePendingManifestBytes,
  savePendingSnapshotBytes,
  loadPendingOps,
  loadOpsSinceSnapshot,
  saveOpsSinceSnapshot,
  writeFileAtomicSync,
} from "./libraryDbStorage";
import { getApiBaseUrl } from "./apiHost";
import {
  getActiveLibraryOwner,
  libraryDir,
  libraryDirOwnedBy,
  libraryOwnerFor,
  migrateFlatLibrary,
  removeAccountLibrary,
  removeFlatLibraryFiles,
  selectLibraryOwner,
  setAsideLibraryFiles,
  type LibraryAccount,
  type LibraryOwner,
} from "./libraryAccount";
import type {
  LibraryOp,
  MediaFilePlaybackDeleteOp,
  MediaFilePlaybackSetOp,
  MediaUpsertV4Op,
} from "@space/shared/libraryOps";
import {
  mergeTrackPrefs,
  parseTrackPrefs,
  serializeTrackPrefs,
  TRACK_PREFS_KEY_PREFIX,
  type TrackPrefs,
  type TrackPrefsPatch,
} from "@space/shared/trackPrefs";
import type {
  AudioTrack,
  IngestJob,
  IngestJobEvent,
  IngestJobEventLevel,
  IngestJobKind,
  IngestJobStatus,
  MediaCastDraft,
  MediaCrewDraft,
  MediaCastMember,
  MediaChapter,
  MediaDetails,
  MediaEpisode,
  MediaEpisodeDraft,
  MediaFile,
  MediaFormat,
  MediaRow,
  MediaSeason,
  MediaSeasonDraft,
  MediaSkipMarker,
  MediaSkipMarkerType,
  MediaTrailer,
  MediaType,
  LibrarySnapshot,
  PlaylistRow,
  SubtitleTrack,
  SubtitleOcrCandidate,
  PreviewSheetCandidate,
  AddOcrSubtitleTwinResult,
  ShowEpisodeRefreshResult,
  ShowEpisodeNotListed,
  DelistedEpisodeRemovalResult,
  EpisodeMoveResult,
} from "@space/shared/libraryTypes";
import { suggestEpisodeMoves, type EpisodeForMatch } from "./episodeMoves";
import { PICTURE_SUBTITLE_FORMATS } from "@space/shared/libraryTypes";
import { pickLibraryCrew } from "@space/shared/libraryCrew";
import { airDateToday, showEpisodeTotal, showWatchedPct, type EpisodeAirInfo } from "@space/shared/showProgress";
import { parsePreviewSheets, previewSheetKeys, type MediaPreviewSheets } from "@space/shared/previewSheets";
import { scopeLogger } from "./logger";

const nowIso = () => new Date().toISOString();
const logger = scopeLogger("library-sync");
/**
 * The compatibility descriptor for this desktop/headless build — the versions
 * it supports on all three library surfaces (Part D's `assertLibraryCompatible`
 * funnel). `currentLibrarySupport` folds the five desktop per-group migration
 * registries to their highest `user_version`; the storage/op-stream versions
 * are build constants. Computed once — the registries and constants are static
 * for the process lifetime. Playback folds the registry WITH the gated
 * conversion step (LIB-FMT-12): this build opens a converted library even
 * though it runs the step only on a switched account.
 */
const DESKTOP_LIBRARY_SUPPORT: LibrarySupport = currentLibrarySupport({
  core: desktopCoreMigrations,
  metadata: desktopMetadataMigrations,
  playback: desktopPlaybackMigrationsPacked,
  ingest: desktopIngestMigrations,
  templates: desktopTemplatesMigrations,
});

/** The op-stream version the account is switched to (`/library/db/meta` `targetOpStreamVersion`); 3 when absent. */
export const metaTargetOpStreamVersion = (meta: unknown): 3 | 4 => {
  const raw = (meta as { targetOpStreamVersion?: unknown } | null | undefined)?.targetOpStreamVersion;
  return typeof raw === "number" && raw >= 4 ? 4 : 3;
};

/** Op types that exist only in op stream 4 (LIB-FMT-11); a `media.upsert` without playback keys is one too. */
const isVersion4Op = (op: LibraryOp) =>
  op.type === "media.file.playback.set" ||
  op.type === "media.file.playback.delete" ||
  op.type === "media.episode.delete" ||
  (op.type === "media.upsert" && !isV3MediaUpsert(op));

/** Ops whose statements reach the metadata/playback/templates files (applied after core, LIB-SYNC-08, LIB-SYNC-22). */
const isPlaybackBearingOp = (op: LibraryOp) => op.type === "media.upsert" || isSecondaryOnlyOp(op);

/**
 * Largest plaintext op this writer sends after the switch (vault v4 plan §1.1: every op ≤ 1 MiB of ciphertext;
 * the payload codec never grows a JSON payload past its plaintext size by more than the AEAD overhead, so the
 * plaintext cap leaves room for it).
 */
export const MAX_V4_OP_PLAINTEXT_BYTES = 1024 * 1024 - 4096;

/** A single file's playback that does not fit in one op (LIB-FMT-11): surfaced to the caller, never truncated. */
export class PlaybackOpTooLargeError extends Error {
  constructor(readonly mediaId: string, readonly fileId: string | null, readonly bytes: number) {
    super(`PLAYBACK_OP_TOO_LARGE: ${mediaId}/${fileId ?? "-"} is ${bytes} bytes (max ${MAX_V4_OP_PLAINTEXT_BYTES})`);
    this.name = "PlaybackOpTooLargeError";
  }
}

type ChunkEntryInput = { key: string; sizeBytes?: number | null; startSeconds?: number | null };

const finiteOrNull = (value: unknown) =>
  value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

const normalizeChunkEntries = (chunks: ReadonlyArray<ChunkEntryInput> | ReadonlyArray<string>): ChunkRef[] =>
  typeof chunks[0] === "string"
    ? (chunks as ReadonlyArray<string>).map((key) => ({ key, sizeBytes: null, startSeconds: null }))
    : (chunks as ReadonlyArray<ChunkEntryInput>).map((entry) => ({
        key: String(entry.key ?? ""),
        sizeBytes: finiteOrNull(entry.sizeBytes),
        startSeconds: finiteOrNull(entry.startSeconds),
      }));

const MEDIA_CHUNK_PLACEMENT = /^media\/([^/]+)\//;

/**
 * The packed row an uploader's chunks are stored as (LIB-FMT-11): key mode 2 when the uploader names the seed it
 * derived the keys from (`chunkKeySeed`, base64, 16 bytes) and every derived key equals the uploaded one; otherwise
 * the explicit keys (mode 1 or 0). A seed that does not reproduce the keys is ignored, never trusted.
 */
export const packUploadedChunks = (chunks: ReadonlyArray<ChunkRef>, chunkKeySeed?: string | null): PackedChunkList => {
  if (chunkKeySeed && chunks.length > 0) {
    const placementId = MEDIA_CHUNK_PLACEMENT.exec(chunks[0]!.key)?.[1];
    if (placementId) {
      try {
        const seeded = packSeededChunkList({
          placementId,
          seed: base64ToBytes(chunkKeySeed),
          sizes: chunks.map((chunk) => chunk.sizeBytes),
          starts: chunks.map((chunk) => chunk.startSeconds),
        });
        const keys = chunkListKeys(seeded);
        if (keys.every((key, index) => key === chunks[index]!.key)) return seeded;
        logger.warn({ placementId, count: chunks.length }, "chunk key seed does not reproduce the uploaded keys; storing explicit keys");
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "chunk key seed unusable; storing explicit keys");
      }
    }
  }
  return packChunkList(chunks);
};

/** A BLOB column as bytes, whatever the driver hands back. */
const blobBytes = (value: unknown, column: string): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new ChunkListFormatError(`media_chunk_lists.${column} is not a blob`);
};

type PackedChunkListRow = {
  owner_id: string;
  placement_id: string;
  key_mode: number;
  key_data: unknown;
  count: number;
  sizes: unknown;
  starts: unknown;
};

/** A stored `media_chunk_lists` row as the packed list (LIB-OPS-01: a row that does not decode throws). */
const packedListFromRow = (row: PackedChunkListRow): PackedChunkList => {
  const keyMode = Number(row.key_mode);
  if (keyMode !== 0 && keyMode !== 1 && keyMode !== 2) {
    throw new ChunkListFormatError(`unknown key_mode ${keyMode} for owner ${row.owner_id}`);
  }
  return {
    placementId: String(row.placement_id),
    keyMode: keyMode as ChunkListKeyMode,
    keyData: blobBytes(row.key_data, "key_data"),
    count: Number(row.count),
    sizes: blobBytes(row.sizes, "sizes"),
    starts: row.starts === null || row.starts === undefined ? null : blobBytes(row.starts, "starts"),
  };
};

const TEMPLATE_FORMAT_PREFIX = "tmpl-format:";
const TEMPLATE_AUDIO_PREFIX = "tmpl-audio:";
const TEMPLATE_SUBTITLE_PREFIX = "tmpl-sub:";

const buildTemplateFormatId = (templateFormatId: string, fileId: string) =>
  `${TEMPLATE_FORMAT_PREFIX}${templateFormatId}:${fileId}`;
const buildTemplateAudioId = (templateAudioId: string, fileId: string) =>
  `${TEMPLATE_AUDIO_PREFIX}${templateAudioId}:${fileId}`;
const buildTemplateSubtitleId = (templateSubtitleId: string, fileId: string) =>
  `${TEMPLATE_SUBTITLE_PREFIX}${templateSubtitleId}:${fileId}`;
const isTemplateFormatId = (formatId: string) => formatId.startsWith(TEMPLATE_FORMAT_PREFIX);
const isValidDbValue = (value: unknown) => {
  if (value === null) return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "bigint") return true;
  if (Buffer.isBuffer(value)) return true;
  return false;
};

const validateDbRow = (label: string, row: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(row)) {
    if (!isValidDbValue(value)) {
      logger.error({
        label,
        key,
        valueType: typeof value,
        value,
      }, "invalid bind value");
      throw new Error(`DB_BIND_INVALID:${label}.${key}`);
    }
  }
};

const SQLITE_HEADER = "SQLite format 3\u0000";
const normalizeOptionalNumber = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
// A catalog person id is a positive integer. `Number(null)` is 0, so a cast member without an id (the metadata service
// answers some without) must stay "no id": as 0 every such member matched one person (LIB-CAST-01).
const catalogPersonId = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const scheduleIdle = (callback: () => void) => setTimeout(callback, 0);

const cancelIdle = (handle: NodeJS.Timeout) => {
  clearTimeout(handle);
};

const normalizeIdentityText = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

const isSqliteHeader = (bytes: Uint8Array) => {
  if (bytes.length < SQLITE_HEADER.length) return false;
  for (let i = 0; i < SQLITE_HEADER.length; i += 1) {
    if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) return false;
  }
  return true;
};

// LIB-STORE-06: `libraryDir()` is the signed-in account's dir (`library/<server>/<userId>`) once open/openLocal selected it.
const resolveLibraryDbPath = () => joinPath(libraryDir(), "library.sqlite");
const resolveLibraryQuarantineLogPath = () => joinPath(libraryDir(), "quarantine-log.jsonl");

const ensureLibraryDir = () => {
  const dir = libraryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const escapeSqlitePath = (filePath: string) => filePath.replace(/'/g, "''");

// Identity of the on-disk file at `filePath` (device + inode), or null when
// the path no longer exists. Filesystems that report no inode number (ino 0)
// degrade to an existence-only identity.
const sqliteFileIdentity = (filePath: string): string | null => {
  const stat = statSync(filePath, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  return stat.ino === 0n ? "exists" : `${stat.dev}:${stat.ino}`;
};

const exportDbBytes = (db: SqliteDatabase) => {
  ensureLibraryDir();
  const snapshotPath = joinPath(libraryDir(), `library-export-${Date.now()}.sqlite`);
  db.exec(`VACUUM INTO '${escapeSqlitePath(snapshotPath)}';`);
  const bytes = new Uint8Array(readFileSync(snapshotPath));
  rmSync(snapshotPath, { force: true });
  return bytes;
};

/**
 * Open the scratch file `buildCombinedSnapshotBytes` assembles the export in.
 * #25 P1: it is read back into memory and deleted right after, so it needs no
 * rollback journal and no fsync. With the defaults every DDL/INSERT below was
 * an autocommit with a journal and several fsyncs on the runtime's event
 * loop; under a busy disk that stalled /runtime/health for seconds.
 *
 * The combined snapshot is a read-only serialization of state already
 * validated by the per-group live DBs. better-sqlite3 enables foreign_keys=ON
 * by default; with cross-DB references (media_items in coreDb referenced by
 * media_files in metadataDb), an INSERT-OR-REPLACE copy can transiently
 * violate FKs while tables are being filled in order. FKs stay off during the
 * bulk copy — the live DBs are still the authoritative integrity boundary.
 */
export const openSnapshotScratchDb = (snapshotPath: string): SqliteDatabase => {
  const db = openDatabase(snapshotPath);
  // MEMORY, not OFF: bun:sqlite runs SQLite in defensive mode, which silently
  // refuses journal_mode=OFF. A RAM journal still writes and fsyncs no file.
  db.exec("PRAGMA journal_mode = MEMORY");
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
};

/**
 * Phase 3.6: build a single-file snapshot containing rows from every
 * per-group SQLite file. The on-the-wire snapshot format is still a single
 * SQLite file, so uploads + local caches keep working without server-side
 * changes.
 *
 * Implementation: open a fresh empty SQLite file, ATTACH each per-group
 * file, recreate the group's tables (+ their indexes) in the combined image
 * via the DDL captured from `sqlite_master`, then INSERT rows from each
 * attached DB. We don't need the legacy DB anymore — the legacy file has
 * been retired by `retireLegacyDb()`.
 */
const buildCombinedSnapshotBytes = (
  legacyDb: SqliteDatabase | null,
  splits: ReadonlyArray<{ db: SqliteDatabase; path: string; tables: ReadonlyArray<string> }>
) => {
  ensureLibraryDir();
  const snapshotPath = joinPath(libraryDir(), `library-export-${Date.now()}.sqlite`);

  // Start from a clean SQLite file. If we still have an open legacy handle
  // (defensive — partial-construction path before retireLegacyDb runs), use
  // VACUUM INTO as the starting image so any straggler non-grouped tables
  // get captured. Otherwise the combine loop below builds the file from
  // scratch by replaying DDL out of each per-group file's sqlite_master.
  let legacyUsable = false;
  if (legacyDb) {
    try {
      legacyDb.exec(`VACUUM INTO '${escapeSqlitePath(snapshotPath)}';`);
      legacyUsable = true;
    } catch {
      // legacyDb closed (post-retire) — fall through to the empty-file path.
    }
  }
  if (!legacyUsable) {
    // Touch an empty SQLite file by opening + closing it. A file built from
    // scratch holds no free pages, so the snapshot ships none (LIB-FMT-07).
    openDatabase(snapshotPath).close();
  }

  if (splits.length === 0) {
    const bytes = new Uint8Array(readFileSync(snapshotPath));
    rmSync(snapshotPath, { force: true });
    return bytes;
  }

  const combined = openSnapshotScratchDb(snapshotPath);
  try {
    for (let index = 0; index < splits.length; index += 1) {
      const split = splits[index];
      const alias = `split_${index}`;
      combined.exec(`ATTACH DATABASE '${escapeSqlitePath(split.path)}' AS ${alias};`);
      try {
        for (const table of split.tables) {
          // Recreate the table structure by copying the CREATE TABLE
          // statement from the split DB.
          const createRows = split.db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? AND sql IS NOT NULL;"
            )
            .all(table) as Array<{ sql?: string }>;
          for (const row of createRows) {
            const ddl = String(row?.sql ?? "").trim();
            if (!ddl) continue;
            try {
              combined.exec(`${ddl};`);
            } catch {
              // Table may already exist from the legacy VACUUM INTO path.
            }
          }
          // Bring over any indexes attached to this table.
          const indexRows = split.db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL;"
            )
            .all(table) as Array<{ sql?: string }>;
          for (const row of indexRows) {
            const ddl = String(row?.sql ?? "").trim();
            if (!ddl) continue;
            try {
              combined.exec(`${ddl};`);
            } catch {
              // Index already present.
            }
          }
          if (LOCAL_ONLY_TABLES[table]) continue;
          combined.exec(
            `INSERT OR REPLACE INTO "${table.replace(/"/g, '""')}" SELECT * FROM ${alias}."${table.replace(/"/g, '""')}";`
          );
        }
      } finally {
        combined.exec(`DETACH DATABASE ${alias};`);
      }
    }
    // The legacy VACUUM INTO image may carry free pages from rows it dropped.
    if (legacyUsable) combined.exec("VACUUM;");
  } finally {
    combined.close();
  }

  const bytes = new Uint8Array(readFileSync(snapshotPath));
  rmSync(snapshotPath, { force: true });
  return bytes;
};

const CORE_TABLES: ReadonlyArray<string> = [
  "media_items",
  "media_genres",
  "media_external_ids",
  "app_settings",
  "playlists",
  "playlist_items",
];

const METADATA_TABLES: ReadonlyArray<string> = [
  "media_files",
  "media_file_desired_formats",
  "people",
  "people_external_ids",
  "media_roles",
  "media_seasons",
  "media_episodes",
  "media_trailers",
  "media_skip_markers",
  "media_editions",
  "media_crew",
];

const PLAYBACK_TABLES: ReadonlyArray<string> = [
  "media_formats",
  "media_format_chunks",
  "media_audio_tracks",
  "media_audio_chunks",
  "media_subtitles",
  "media_chapters",
  "media_local_downloads",
  // Vault v4 (LIB-FMT-11): empty until the account is switched.
  "media_chunk_lists",
  "media_file_playback",
];

/**
 * Tables whose rows are per-device (saved files on THIS disk) and never
 * travel in a snapshot (LIB-FMT-07): another device would only see paths that
 * mean nothing to it. The empty table is still exported so every reader finds
 * the schema it expects.
 */
const LOCAL_ONLY_TABLES: Readonly<Record<string, true>> = {
  media_local_downloads: true,
  // OCR catch-up bookkeeping (PLAY-TRACK-05): this device's own retry state.
  subtitle_ocr_attempts: true,
};

const INGEST_TABLES: ReadonlyArray<string> = [
  "ingest_jobs",
  "ingest_job_events",
];

const TEMPLATES_TABLES: ReadonlyArray<string> = [
  "media_templates",
  "media_template_formats",
  "media_template_format_chunks",
  "media_template_audio_tracks",
  "media_template_audio_chunks",
  "media_template_subtitles",
  "media_template_chapters",
  "media_skip_analysis",
  "subtitle_ocr_attempts",
];

/**
 * Delete a SQLite file together with every sidecar it may own. A leftover
 * `-wal` next to a file recreated at the same path is replayed into it on the
 * next open (SQLite opens the WAL whenever one exists, whatever the header
 * says), and a leftover `-journal` is rolled back into it. Removing the main
 * file alone is never enough.
 */
const removeSqliteFiles = (path: string) => {
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try { rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
};

/**
 * The legacy `library.sqlite` is a staging file: open() loads it from the
 * cache bytes, the remote snapshot or an empty schema (or finds a pre-split
 * install's file), and the constructor splits it into the per-group files
 * and retires it. #25: with
 * the default synchronous=FULL each autocommit fsynced the journal and the
 * file; a fresh account's empty-schema bootstrap spent 8 s there on a busy CI
 * disk. synchronous=OFF survives an app crash (the OS still holds the
 * writes).
 *
 * Sidecars: new bytes replace the whole file, so any `-wal`/`-shm`/`-journal`
 * left by the previous file is stale and is deleted first. Mobile uploads
 * WAL-header images (its snapshot DB runs in WAL), so the journal mode is
 * forced back to DELETE: this staging file never owns a WAL.
 */
export const openSqliteDb = (bytes?: Uint8Array) => {
  ensureLibraryDir();
  const dbPath = resolveLibraryDbPath();
  if (bytes) {
    removeSqliteFiles(dbPath);
    writeFileSync(dbPath, bytes);
  }
  const db = openDatabase(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
  } catch (error) {
    // Leaving WAL needs the only connection to the file; a still-open
    // handle keeps it WAL for this open, which is what it was before.
    logger.warn({ dbPath, error: error instanceof Error ? error.message : String(error) }, "library.sqlite: could not switch to journal_mode=DELETE");
  }
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};

/**
 * Open a per-group library file (the durable store). #25: in the default
 * rollback-journal mode every autocommit (each split copy/drop, each
 * migration statement, every later write) fsynced the journal and the DB;
 * a fresh account's first open spent 57 s in the constructor on a busy CI
 * disk. WAL + synchronous=NORMAL keeps it consistent after a crash or power
 * loss (only the newest commits may roll back) — the same policy as the
 * runtime jobs DB. #25 P10: under the runtime the
 * file is prepared by the checkpoint worker ({@link prepareLibraryGroupFiles})
 * and, once migrated ({@link registerLibraryGroupDb}), its checkpoints and
 * their fsyncs run on that worker, see `walCheckpointer.ts`. Close it with
 * {@link closeLibraryGroupDbs}.
 */
const openLibraryGroupDb = (path: string, foreignKeys: boolean) => {
  const db = openDatabase(path);
  enableOffLoopWal(db, { path, driver: "bun:sqlite", label: "library" });
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  return db;
};

/** Call once the group file's migrations have run. */
const registerLibraryGroupDb = (db: SqliteDatabase, path: string) => {
  registerOffLoopWal(db, { path, driver: "bun:sqlite", label: "library" });
};

const libraryGroupPaths = () => [getCoreDbPath(), getMetadataDbPath(), getPlaybackDbPath(), getIngestDbPath(), getTemplatesDbPath()];

/** Call right before the group files are opened (no-op outside Bun). */
const prepareLibraryGroupFiles = async () => {
  await Promise.all(libraryGroupPaths().map((path) => prepareOffLoopWal(path, { driver: "bun:sqlite", label: "library" })));
};

/** Call when the open that prepared the group files failed. */
const abandonLibraryGroupFiles = () => {
  abandonPreparedOffLoopWals(libraryGroupPaths());
};

/** Closes group DBs together: their final checkpoints (fsyncs) run in parallel, not one wait each. */
const closeLibraryGroupDbs = (dbs: ReadonlyArray<SqliteDatabase | null>) => {
  const open = dbs.filter((db): db is SqliteDatabase => db !== null);
  releaseOffLoopWals(open);
  for (const db of open) db.close();
};

// Phase 3.6: for callers that need a throwaway SqliteDatabase to pass to the
// LibraryDb constructor without touching the legacy `library.sqlite` file on
// disk. Used by openLocal / openCacheFallback when the post-split state holds
// — the constructor's initialize<Group>Db wires up the real per-group ORMs
// from their dedicated files and never queries `this.db` again.
const openInMemorySqliteDb = () => {
  const db = openDatabase(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};

/**
 * Publish-guard integrity verdicts (#25).
 *
 * `ensurePublishableState` exists so a structurally corrupt local SQLite file
 * is never published — not as an op, and above all not as a snapshot that
 * every other device would then download. A full `PRAGMA integrity_check`
 * reads every page of every group file, and the guard runs before EVERY ops
 * flush (about once a second while playback progress is saved), synchronously
 * on the runtime main thread. Re-proving an unchanged file each second is the
 * waste; the guarantee only needs a proof per state of the file that SQL
 * through our own handle did not produce.
 *
 * So a passed check is remembered per open handle, keyed on
 * `PRAGMA data_version`. data_version moves when the file was changed by
 * anything OTHER than this connection (another connection, another process,
 * bytes written to the file directly), and stays put for our own writes —
 * which cannot corrupt the b-tree structure. The full check therefore runs:
 *   - on the first publish after every open / reopen: a handle is a new
 *     WeakMap key, so cold boot, crash recovery and the snapshot-apply
 *     reopen all get a fresh proof;
 *   - whenever the file changed under the handle (data_version moved);
 *   - on every snapshot publish (`force`), which ships the whole file image
 *     and is rare (compaction threshold + minimum interval);
 *   - every time, when data_version cannot be read (no cacheable key).
 * A failed check is never cached.
 */
const integrityVerifiedAtDataVersion = new WeakMap<SqliteDatabase, number>();

const readDataVersion = (db: SqliteDatabase): number | null => {
  const row = db.prepare("PRAGMA data_version;").get() as { data_version?: unknown } | undefined;
  const value = Number(row?.data_version);
  return Number.isFinite(value) ? value : null;
};

/**
 * Run `PRAGMA integrity_check` on `db` unless a passed verdict is cached for
 * its current data_version (and `force` is off). Throws
 * `integrity_check_failed:<name>` on a failed check.
 */
const verifyDbIntegrity = (
  name: string,
  db: SqliteDatabase,
  opts: { force: boolean; stage: string },
): void => {
  const dataVersion = readDataVersion(db);
  const cached = integrityVerifiedAtDataVersion.get(db);
  if (!opts.force && dataVersion !== null && cached === dataVersion) return;
  const reason = opts.force
    ? "forced"
    : dataVersion === null
      ? "data_version_unreadable"
      : cached === undefined
        ? "first_check_on_handle"
        : "file_changed_externally";
  const startedAt = performance.now();
  const rows = db.prepare("PRAGMA integrity_check;").all() as Array<{
    integrity_check?: string;
    [key: string]: unknown;
  }>;
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const ok = rows.every((row) => String(row.integrity_check ?? "").toLowerCase() === "ok");
  if (!ok) {
    integrityVerifiedAtDataVersion.delete(db);
    logger.error(
      {
        db: name,
        stage: opts.stage,
        reason,
        durationMs,
        dataVersion,
        detail: rows.slice(0, 5).map((row) => String(row.integrity_check ?? JSON.stringify(row))),
      },
      "publish guard integrity_check FAILED",
    );
    throw new Error(`integrity_check_failed:${name}`);
  }
  if (dataVersion !== null) integrityVerifiedAtDataVersion.set(db, dataVersion);
  logger.info(
    { db: name, stage: opts.stage, reason, durationMs, dataVersion },
    "publish guard integrity_check passed",
  );
};

const extractAssetObjectKey = (value: string | null) => {
  if (!value) return null;
  if (value.startsWith("asset:")) {
    const payload = value.slice("asset:".length);
    const splitIndex = payload.indexOf("::");
    if (splitIndex > 0) {
      return payload.slice(splitIndex + 2) || null;
    }
  }
  return value;
};

const parseGenres = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (typeof entry === "number" ? entry : Number((entry as { id?: number }).id)))
      .filter((entry) => Number.isFinite(entry));
  } catch {
    return [];
  }
};

const parseRecordJson = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const mapMediaRows = (
  rows: any[],
  catalogIdById: ReadonlyMap<string, number>,
  genresById: Map<string, number[]>
): MediaRow[] =>
  rows.map((row) => {
    const id = String(row.id);
    return {
      id,
      type: (row.type === "tv" ? "tv" : "movie") as MediaType,
      catalogId: catalogIdById.get(id) ?? null,
      title: String(row.title),
      originalTitle: row.originalTitle ? String(row.originalTitle) : null,
      originalLanguage: row.originalLanguage ? String(row.originalLanguage) : null,
      overview: row.overview ? String(row.overview) : null,
      year: row.year ? String(row.year) : null,
      rating: typeof row.rating === "number" ? row.rating : row.rating ? Number(row.rating) : null,
      posterPath: row.posterPath ? String(row.posterPath) : null,
      backdropPath: row.backdropPath ? String(row.backdropPath) : null,
      genres: genresById.get(id) ?? [],
      addedAt: String(row.addedAt),
      updatedAt: String(row.updatedAt),
      hasFiles: Number(row.hasFiles) === 1,
      progressPct: Number.isFinite(Number(row.progressPct)) ? Number(row.progressPct) : 0,
      lastWatchedAt: row.lastWatchedAt ? String(row.lastWatchedAt) : null,
      totalEpisodes: Number.isFinite(Number(row.totalEpisodes)) ? Number(row.totalEpisodes) : null,
      episodeCount: Number.isFinite(Number(row.episodeCount)) ? Number(row.episodeCount) : 0,
    };
  });

const OPS_SNAPSHOT_THRESHOLD = 250;
const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000;
// One statement answers "did anything write to this SQLite file since I last
// looked": `total_changes()` counts every row this connection changed
// (including trigger / FK-action rows and rolled-back ones, which only costs
// a spurious invalidation), `data_version` moves when ANOTHER connection
// committed. Schema replacement swaps the handle object, compared by identity.
const FILE_CHANGE_PROBE_SQL = "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version;";

type TvProgressStamp = {
  core: object;
  metadata: object;
  coreChanges: number;
  coreVersion: number;
  metadataChanges: number;
  metadataVersion: number;
};

type TvProgressState = {
  /** Number(media_items.total_episodes): the catalog's count, used when the episode list has no air dates (LIB-PROG-01). */
  configuredTotalEpisodes: number;
  /** Season and air date of every listed episode: the show's total is its aired regular episodes. */
  episodes: EpisodeAirInfo[];
  /** Season of each episode's resume key: specials never count. */
  seasonByKey: Map<string, number>;
  /** Parsable episode_resume_v1 values of the show's episodes by setting key, in table order. */
  resume: Map<string, { progressPct: number; updatedAt: string | null }>;
};

/** One playlist of a non-main profile as `listProfilePlaylists` returns it: its id plus its items. */
type ScopedPlaylist = PlaylistRow & { items: ProfilePlaylist["items"] };

/** The active non-main profile's progress by media id and its playlists (live titles only); both null on main. */
type ScopedViewingReads = {
  progress: Map<string, MediaProgress> | null;
  playlists: ScopedPlaylist[] | null;
};

/**
 * Result of `LibraryDb.prepareRemoteSync` — the network half of a remote
 * sync, ready for `applyPreparedRemoteSync`. `fromVersion` is the
 * `remoteVersion` the fetch started from; apply refuses (`"stale"`) when
 * it moved in between.
 */
export type PreparedRemoteSync =
  | { kind: "none" }
  | {
      kind: "ops";
      meta: LibraryMeta;
      fromVersion: number;
      toVersion: number;
      /** LIB-SYNC-19: the server's state hash at `toVersion` and the last op id up to it */
      stateHash: string | null;
      lastOpId: string | null;
      ops: LibraryOp[];
      opSizes: number[];
    }
  | {
      kind: "snapshot";
      meta: LibraryMeta;
      fromVersion: number;
      snapshotVersion: number;
      updatedAt: string | null;
      bytes: Uint8Array;
    };

const normalizeStateHash = (value?: string | null) => {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
};

const deriveNextStateHash = (prevStateHash: string | null, opId: string, payload: Uint8Array) => {
  const payloadHash = hashBytes(payload);
  const prev = prevStateHash ?? "root";
  return createHash("sha256").update(`${prev}|${opId}|${payloadHash}`).digest("hex");
};

const getLatestSnapshotMs = (history?: Array<{ createdAt: string }>) => {
  if (!history?.length) return null;
  const sorted = history
    .map((entry) => Date.parse(entry.createdAt))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);
  return sorted[0] ?? null;
};

export const shouldBootstrapFromMissingSnapshot = (meta: {
  exists: boolean;
  bootstrapRequired: boolean;
  syncUnavailable: boolean;
  consistency: "ok" | "missing_snapshot";
}) =>
  !meta.exists &&
  !meta.bootstrapRequired &&
  !meta.syncUnavailable &&
  meta.consistency === "missing_snapshot";

export const resolveBootstrapBaseVersion = (meta?: { version?: number } | null) => {
  const parsed = Number(meta?.version ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

export const shouldTreatSyncUnavailable = (error: unknown) =>
  error instanceof ApiError && (error.status === 502 || error.status === 503);

/**
 * Why the local cache cannot be this server's library for this account (LIB-STORE-06), or null when it can be: it
 * is stamped with another API origin (a dev and a release build used to share the dir), or the account dir is not
 * stamped with this owner. Its version alone proves nothing: cache.json counts unsent local changes too, so a cache
 * ahead of the server is this device's own pending work, which a reopen must keep.
 */
const foreignCacheReason = (cache: { apiOrigin?: string | null }, owner: LibraryOwner | null): string | null => {
  if (cache.apiOrigin && cache.apiOrigin !== getApiBaseUrl()) return "other_server";
  if (owner && !libraryDirOwnedBy(owner)) return "other_owner";
  return null;
};

const pickBlob = async (token: string, owner: LibraryOwner | null) => {
  // A 502/503 means the API could not confirm the library (e.g. the storage
  // gateway is down), never "no library": surface SYNC_UNAVAILABLE so the
  // caller keeps the local library instead of treating the remote as gone.
  const meta = await getLibraryMeta(token).catch((error: unknown) => {
    if (!shouldTreatSyncUnavailable(error)) throw error;
    syncDebug("pick-blob:meta-unavailable", {
      apiBaseUrl: getApiBaseUrl(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("SYNC_UNAVAILABLE");
  });
  if (owner) {
    // The server head is known only now: the one-time move of the old flat dir needs it (LIB-STORE-06).
    const migration = migrateFlatLibrary(owner, meta);
    syncDebug("pick-blob:flat-migration", { apiBaseUrl: getApiBaseUrl(), userId: owner.userId, ...migration });
    selectLibraryOwner(owner);
  }
  const localCache = await loadCache();
  const foreignReason = localCache ? foreignCacheReason(localCache, owner) : null;
  if (localCache && foreignReason) {
    // The per-group files next to that cache hold the same foreign library and their split marker would keep them
    // under the downloaded snapshot: set them aside so the server's library opens on an empty dir.
    const setAsideTo = setAsideLibraryFiles(`cache_${foreignReason}`);
    syncDebug("pick-blob:cache-rejected", {
      apiBaseUrl: getApiBaseUrl(),
      reason: foreignReason,
      cacheVersion: localCache.version,
      cacheLastOpId: localCache.lastOpId ?? null,
      cacheApiOrigin: localCache.apiOrigin ?? null,
      metaVersion: meta.version,
      metaLastOpId: meta.lastOpId,
      setAsideTo,
    });
  }
  const cache = foreignReason ? null : localCache;

  let source: "cache" | "unavailable" | "none" | "remote" = "remote";

  const shouldRecoverFromMissingSnapshot = shouldBootstrapFromMissingSnapshot(meta);

  if (!meta.exists) {
    if (!meta.bootstrapRequired) {
      if (cache) {
        source = "cache";
        syncDebug("pick-blob", {
          apiBaseUrl: getApiBaseUrl(),
          metaExists: meta.exists,
          bootstrapRequired: meta.bootstrapRequired,
          metaVersion: meta.version,
          cacheVersion: cache.version,
          selected: source,
        });
        return { source, cache, meta };
      }
      if (shouldRecoverFromMissingSnapshot) {
        source = "none";
        syncDebug("pick-blob", {
          apiBaseUrl: getApiBaseUrl(),
          metaExists: meta.exists,
          bootstrapRequired: meta.bootstrapRequired,
          metaVersion: meta.version,
          cacheVersion: null,
          selected: source,
          recovery: "missing_snapshot",
        });
        return { source, cache, meta };
      }
      source = "unavailable";
      syncDebug("pick-blob", {
        apiBaseUrl: getApiBaseUrl(),
        metaExists: meta.exists,
        bootstrapRequired: meta.bootstrapRequired,
        metaVersion: meta.version,
        cacheVersion: null,
        selected: source,
      });
      return { source, cache, meta };
    }
    // bootstrapRequired=true means the API has no record of this user. Any
    // local cache here is stale — either from a previous account on this
    // install or from an openLocal fallback that wrote a fresh empty SQLite
    // before the user's first successful bootstrap. Using it makes the new
    // user open with someone else's data AND skips the bootstrap upload, so
    // every subsequent op runs on top of a missing user_app_state row and
    // any local writes are lost on next logout/clearLocalCache. Force the
    // bootstrap path so the API gets a fresh row and the runtime starts
    // from a clean slate keyed to this user.
    source = "none";
    syncDebug("pick-blob", {
      apiBaseUrl: getApiBaseUrl(),
      metaExists: meta.exists,
      bootstrapRequired: meta.bootstrapRequired,
      metaVersion: meta.version,
      cacheVersion: cache?.version ?? null,
      cacheIgnored: Boolean(cache),
      selected: source,
    });
    return { source, cache: null, meta };
  }

  const cacheFresh = cache && cache.version === meta.version;

  const cacheAhead = cache && cache.version > meta.version;

  if (cacheFresh || cacheAhead) {
    source = "cache";
    syncDebug("pick-blob", {
      apiBaseUrl: getApiBaseUrl(),
      metaExists: meta.exists,
      bootstrapRequired: meta.bootstrapRequired,
      metaVersion: meta.version,
      cacheVersion: cache?.version ?? null,
      cacheFresh: Boolean(cacheFresh),
      cacheAhead: Boolean(cacheAhead),
      selected: source,
    });
    return { source, cache, meta };
  }

  source = "remote";
  syncDebug("pick-blob", {
    apiBaseUrl: getApiBaseUrl(),
    metaExists: meta.exists,
    bootstrapRequired: meta.bootstrapRequired,
    metaVersion: meta.version,
    cacheVersion: cache?.version ?? null,
    cacheFresh: Boolean(cacheFresh),
    cacheAhead: Boolean(cacheAhead),
    cacheRejected: foreignReason,
    selected: source,
  });
  return { source, cache, meta };
};

type IngestJobUpsertInput = {
  id: string;
  mediaId: string;
  fileId?: string | null;
  workerPeerId: string;
  ownerClientId?: string | null;
  kind: IngestJobKind;
  status: IngestJobStatus;
  progressPct?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
};

type IngestJobPatchInput = {
  status?: IngestJobStatus;
  progressPct?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  meta?: Record<string, unknown> | null;
  completedAt?: string | null;
  workerPeerId?: string | null;
  ownerClientId?: string | null;
};

type IngestJobEventInput = {
  jobId: string;
  level: IngestJobEventLevel;
  message: string;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
};

export class LibraryDb {
  /**
   * How long a queue holding ONLY progress-class ops (media.progress,
   * episode resume setting.set) waits before uploading (#25 write storm).
   * Saves arriving meanwhile coalesce into one op per key; any other op
   * flushes on the normal debounce and takes them along. Pending ops are
   * on disk (pending_ops.json), so a kill inside the window loses nothing;
   * other devices see resume positions up to this much later.
   */
  static progressOpsFlushDelayMs = 10_000;
  private token: string;
  private keyBase64: string;
  private db: SqliteDatabase;
  private orm: MainSqliteDatabase;
  // Phase 3.1: dedicated SQLite file for the core group. When non-null, all
  // queries against media_items / media_genres / media_external_ids /
  // app_settings / playlists / playlist_items route through `coreOrm` and the
  // legacy `this.db` no longer owns those rows. Stays null until the legacy
  // split migration has copied core tables into `library.core.sqlite`.
  private coreDb: SqliteDatabase | null = null;
  private coreOrm: MainSqliteDatabase | null = null;
  // Phase 3.2: dedicated SQLite file for the metadata group. Holds
  // media_files / media_file_desired_formats / people / people_external_ids /
  // media_roles / media_seasons / media_episodes / media_trailers /
  // media_skip_markers. Wired but not yet routed — the flip commit will
  // reroute these queries.
  private metadataDb: SqliteDatabase | null = null;
  private metadataOrm: MainSqliteDatabase | null = null;
  // Phase 3.3: dedicated SQLite file for the playback group. Holds
  // media_formats / media_format_chunks / media_audio_tracks /
  // media_audio_chunks / media_subtitles / media_chapters — the format/chunk/
  // track tables needed once a media item is selected for playback. Wired
  // but not yet routed.
  private playbackDb: SqliteDatabase | null = null;
  private playbackOrm: MainSqliteDatabase | null = null;
  // Phase 3.4: dedicated SQLite file for the ingest group. Holds
  // ingest_jobs / ingest_job_events — visible to both clients (mobile shows
  // job state without progress %). Wired but not yet routed.
  private ingestDb: SqliteDatabase | null = null;
  private ingestOrm: MainSqliteDatabase | null = null;
  // Phase 3.5: dedicated SQLite file for the templates group. Desktop-only —
  // holds encoding profile definitions + intermediate ML output
  // (media_templates × 7 + media_skip_analysis). Mobile never opens this
  // file. Wired but not yet routed.
  private templatesDb: SqliteDatabase | null = null;
  private templatesOrm: MainSqliteDatabase | null = null;
  // Phase 3.6: store the resolved per-group file paths at the time their
  // SQLite handle was opened. `buildCombinedExportBytes` needs to ATTACH each
  // per-group file as `split_<n>` when stitching the upload snapshot back
  // together. Re-resolving via `getCoreDbPath()` etc. at call time depends
  // on `SF_USER_DATA_PATH` (or Electron's userData), which the desktop holds
  // constant — but the E2E harness flips it per client between sequential
  // open/setSetting calls, so a deferred-timer-driven `runPersist` resolves
  // a path that no longer matches the open handle. The ATTACH then creates an
  // empty file (or opens an unrelated one), and the subsequent SELECT throws
  // `no such table: split_0.media_items`. Capture paths once at handle-open
  // time and reuse them so the ATTACH always targets the file that the open
  // `coreDb`/etc. handle is actually backed by. @bugfix
  // runpersist-split-attached-table-missing
  private coreDbPath: string | null = null;
  private metadataDbPath: string | null = null;
  private playbackDbPath: string | null = null;
  private ingestDbPath: string | null = null;
  private templatesDbPath: string | null = null;
  // Device+inode of each bound per-group file, captured when the handle was
  // opened. `ATTACH` re-opens the PATH, so if the file behind an open handle
  // was unlinked (library directory wiped) or replaced (another LibraryDb
  // opened fresh files at the same path), the ATTACH would silently create an
  // empty file — `no such table: split_0.media_items` — or stitch ANOTHER
  // library's rows into this instance's snapshot. buildCombinedExportBytes
  // refuses both. @bugfix runpersist-split-file-detached
  private readonly splitFileIdentities = new Map<string, string | null>();
  private version: number;
  private remoteVersion: number;
  /** LIB-FMT-13: the account's switch, from the last meta read (`targetOpStreamVersion`); 3 until one says 4. */
  private targetOpStreamVersion: 3 | 4;
  /** LIB-FMT-11: the playback file holds packed chunk lists (its conversion step ran, user_version >= 2). */
  private packedPlayback = false;
  /** Statements of op application, prepared once per group file (vault v4 audit: one page 528 → 349 ms). */
  private readonly opStatementCache = new WeakMap<SqliteDatabase, Map<string, { run(...params: unknown[]): unknown }>>();
  /** File keys (`playbackFileKey`) whose playback this device removed, by title; the next v4 upsert sends their deletes. */
  private readonly removedPlaybackFiles = new Map<string, Set<string>>();
  private pendingSync: PendingSync | null;
  private pendingOps: PendingOp[];
  /** Non-progress ops since the last snapshot (LIB-SYNC-07), persisted across restarts. */
  private opsSinceSnapshot = loadOpsSinceSnapshot();
  private syncEnabled: boolean;
  private stateHash: string | null;
  private lastOpId: string | null;
  private persistInFlight = false;
  private persistScheduled = false;
  private persistIdleHandle: NodeJS.Timeout | null = null;
  private persistState: { version: number; updatedAt: string; generation: number } | null = null;
  private persistGeneration = 0;
  // Change tracking for the runtime's `library.updated` delta (#671 R3): the
  // media whose details a write touched since the last takeChangedMedia().
  // `changeUnattributed` means some write moved the library without naming
  // its media (or replaced it wholesale), so the consumer must refetch all.
  private readonly changedMediaIds = new Set<string>();
  private changeUnattributed = false;
  // Media notes since the previous persist(); a persist that sees none (and is
  // not declared media-free) is unattributed.
  private mediaNotesSincePersist = 0;
  // Per-show inputs of getTvProgressAggregate (null = show has no episodes),
  // valid only while tvProgressStamp matches the library files; see
  // syncTvProgressStates.
  private readonly tvProgressStates = new Map<string, TvProgressState | null>();
  private tvProgressStamp: TvProgressStamp | null = null;
  // Profile chosen on this device (ACCT-SQUAD-02, profiles.md "Desktop"): never synced, null until the app picks one.
  // Its viewing scope says where viewing state reads and writes go (main = the library's own storage).
  private activeProfile: { id: string; isMain: boolean } | null = null;
  private viewingScope: ViewingScope = MAIN_VIEWING_SCOPE;
  private opsFlushInFlight = false;
  private opsFlushTimer: NodeJS.Timeout | null = null;
  /** True while `opsFlushTimer` is a progress-only deferral a real op may pull forward. */
  private opsFlushTimerIsProgressDeferral = false;
  private opsFlushDueAt = 0;
  /** Earliest time the armed flush's caller allowed (retry backoff floor). */
  private opsFlushFloorAt = 0;
  /** Pending ops dropped because a later op of the same key superseded them (#25). */
  private opsCoalescedTotal = 0;
  /** media.upsert ops not queued because the details had not changed (#25). */
  private opsSkippedNoopUpserts = 0;
  /**
   * Per media: sha256 of the details (minus updatedAt) of the last
   * media.upsert this instance queued. Cleared whenever remote state is
   * applied locally, so a write after a remote change always uploads.
   */
  private lastQueuedUpsertSignature = new Map<string, { signature: string; updatedAt: string }>();
  private opsFlushConsecutiveFailures = 0;
  private opsFlushBackoffMs = 2000;
  private opsFlushCircuitOpen = false;
  private opsFlushCircuitCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private opsFlushQuotaExceeded = false;
  /** LIB-SYNC-16: op uploads in a row the server refused with 409; reset by an accepted op. */
  private opsFlushConsecutive409 = 0;
  private applyingRemoteOps = false;
  /** LIB-SYNC-10: system playlists whose items the heal moved onto the fixed id and still must re-send. */
  private healedSystemPlaylists = new Set<string>();
  /**
   * Once close() runs, any scheduled timer callback (opsFlush, persist,
   * circuit-breaker cooldown) that still fires must become a no-op. Without
   * this flag, a late-firing timer would call `this.db.prepare(...)` on a
   * closed SQLite handle — surfacing as
   * `Cannot use a closed database` in ensurePublishableState() and
   * quarantining the local state unnecessarily during logout.
   */
  private closed = false;
  private datasetStatus = { core: true, metadata: true, playback: true };
  private datasetListeners = new Set<(status: { core: boolean; metadata: boolean; playback: boolean }) => void>();
  private secondaryOpsInFlight: Promise<void> | null = null;

  private constructor(
    token: string,
    keyBase64: string,
    db: SqliteDatabase,
    version: number,
    remoteVersion: number,
    pendingSync: PendingSync | null,
    pendingOps: PendingOp[],
    stateHash: string | null,
    lastOpId: string | null,
    targetOpStreamVersion: 3 | 4
  ) {
    this.token = token;
    this.keyBase64 = keyBase64;
    this.db = db;
    this.orm = createOrm(db);
    this.version = version;
    this.remoteVersion = remoteVersion;
    this.targetOpStreamVersion = targetOpStreamVersion;
    this.pendingSync = pendingSync;
    this.pendingOps = pendingOps;
    this.syncEnabled = true;
    this.stateHash = normalizeStateHash(stateHash);
    this.lastOpId = lastOpId ?? null;
    // Phase 3.1: split core tables out of the legacy single-file DB into
    // `library.core.sqlite`. After this returns, all core-group queries go
    // through `this.coreOrm`. Idempotent — on reopen, the legacy file has
    // no core tables and the dedicated file already holds the rows.
    this.initializeCoreDb();
    // Phase 3.2: same for the metadata group, into `library.metadata.sqlite`.
    this.initializeMetadataDb();
    // Phase 3.3: same for the playback group, into `library.playback.sqlite`.
    this.initializePlaybackDb();
    // Phase 3.4: same for the ingest group, into `library.ingest.sqlite`.
    this.initializeIngestDb();
    // Phase 3.5: same for the templates group, into `library.templates.sqlite`.
    this.initializeTemplatesDb();
    // Phase 3.6: now that every group's tables live in their dedicated file,
    // close + rename the (empty) legacy `library.sqlite` to
    // `library.sqlite.pre-split.bak`. Idempotent — on subsequent boots the
    // legacy file no longer exists and `openSqliteDb()` writes a fresh empty
    // one we just-as-quickly retire here.
    this.retireLegacyDb();
  }

  /**
   * #25 P10: every open builds through here. Under the runtime the checkpoint
   * worker first creates and WAL-switches the group files and writes their
   * first WAL frame (`prepareOffLoopWal`), so those fsyncs stay off the event
   * loop. It runs right before the constructor because the factories decide
   * pre- vs post-split from whether the core file exists.
   */
  private static async construct(
    token: string,
    keyBase64: string,
    db: SqliteDatabase,
    version: number,
    remoteVersion: number,
    pendingSync: PendingSync | null,
    pendingOps: PendingOp[],
    stateHash: string | null,
    lastOpId: string | null,
    // LIB-FMT-12: the account's switch as the open's meta read says (3 offline): a switched account converts the
    // playback group while it opens, before any op is applied.
    targetOpStreamVersion: 3 | 4
  ): Promise<LibraryDb> {
    await prepareLibraryGroupFiles();
    try {
      const instance = new LibraryDb(
        token,
        keyBase64,
        db,
        version,
        remoteVersion,
        pendingSync,
        pendingOps,
        stateHash,
        lastOpId,
        targetOpStreamVersion
      );
      instance.resendHealedSystemPlaylists();
      return instance;
    } catch (error) {
      abandonLibraryGroupFiles();
      throw error;
    }
  }

  /**
   * Phase 3.6: per-group ORM accessors. After construction every group's
   * DB is open and routed — the `?? this.orm` fallback only triggers on
   * a partial-failure construction path and would point at the legacy
   * file (still open in that state). Code that calls a per-group accessor
   * MUST be calling it after `initialize<Group>Db()` has completed for
   * its group.
   *
   * core owns media_items / media_genres / media_external_ids /
   * app_settings / playlists / playlist_items.
   */
  private get core(): MainSqliteDatabase {
    return this.coreOrm ?? this.orm;
  }

  private get coreSqlite(): SqliteDatabase {
    return this.coreDb ?? this.db;
  }

  /**
   * metadata owns media_files / media_file_desired_formats / people /
   * people_external_ids / media_roles / media_seasons / media_episodes /
   * media_trailers / media_skip_markers.
   */
  private get metadata(): MainSqliteDatabase {
    return this.metadataOrm ?? this.orm;
  }

  private get metadataSqlite(): SqliteDatabase {
    return this.metadataDb ?? this.db;
  }

  /**
   * playback owns media_formats / media_format_chunks / media_audio_tracks /
   * media_audio_chunks / media_subtitles / media_chapters.
   */
  private get playback(): MainSqliteDatabase {
    return this.playbackOrm ?? this.orm;
  }

  private get playbackSqlite(): SqliteDatabase {
    return this.playbackDb ?? this.db;
  }

  /**
   * ingest owns ingest_jobs / ingest_job_events. Mirrored to mobile (mobile
   * opens this file too) so job state surfaces there.
   */
  private get ingest(): MainSqliteDatabase {
    return this.ingestOrm ?? this.orm;
  }

  private get ingestSqlite(): SqliteDatabase {
    return this.ingestDb ?? this.db;
  }

  /**
   * templates owns media_templates × 7 + media_skip_analysis. Desktop-only —
   * mobile never opens the templates file.
   */
  private get templates(): MainSqliteDatabase {
    return this.templatesOrm ?? this.orm;
  }

  private get templatesSqlite(): SqliteDatabase {
    return this.templatesDb ?? this.db;
  }

  /**
   * Phase 3.1: produce a single-file snapshot containing all library tables.
   * While Phase 3.1–3.4 keep the legacy `this.db` as the source of truth for
   * still-unrouted groups (legacy core tables remain in place after a copy-
   * only split), this returns the legacy snapshot directly. Once a later
   * commit flips routing for a group and drops its legacy copies, the
   * combine path stitches the per-group file's rows back in via ATTACH so
   * the on-the-wire snapshot format stays a single file.
   */
  private buildCombinedExportBytes(): Uint8Array {
    // Phase 3.6: stitch all five per-group SQLite files back into a single
    // snapshot for upload/cache. After `retireLegacyDb()` runs the legacy
    // handle is closed, so we pass null and let the combiner start from a
    // fresh empty SQLite file.
    //
    // Use the paths captured at handle-open time (`this.<group>DbPath`) — NOT
    // a fresh `getCoreDbPath()` call — so the ATTACH always targets the file
    // backing the open SQLite handle. Re-resolving paths here would depend
    // on `SF_USER_DATA_PATH` at call time, which the E2E harness flips per
    // client between sequential open/setSetting invocations. A deferred-timer
    // `runPersist` resolving against the now-restored env would ATTACH an
    // unrelated (or empty) file, surfacing as
    // `no such table: split_0.media_items`. @bugfix
    // runpersist-split-attached-table-missing
    const splits: Array<{ db: SqliteDatabase; path: string; tables: ReadonlyArray<string> }> = [];
    if (this.coreDb && this.coreDbPath) {
      splits.push({ db: this.coreDb, path: this.coreDbPath, tables: CORE_TABLES });
    }
    if (this.metadataDb && this.metadataDbPath) {
      splits.push({ db: this.metadataDb, path: this.metadataDbPath, tables: METADATA_TABLES });
    }
    if (this.playbackDb && this.playbackDbPath) {
      splits.push({ db: this.playbackDb, path: this.playbackDbPath, tables: PLAYBACK_TABLES });
    }
    if (this.ingestDb && this.ingestDbPath) {
      splits.push({ db: this.ingestDb, path: this.ingestDbPath, tables: INGEST_TABLES });
    }
    if (this.templatesDb && this.templatesDbPath) {
      splits.push({ db: this.templatesDb, path: this.templatesDbPath, tables: TEMPLATES_TABLES });
    }
    for (const split of splits) {
      const bound = this.splitFileIdentities.get(split.path) ?? null;
      const current = sqliteFileIdentity(split.path);
      if (current === null || (bound !== null && current !== bound)) {
        throw new Error(
          `library per-group file ${split.path} no longer backs the open handle ` +
            `(bound=${bound ?? "unknown"} on-disk=${current ?? "missing"}); refusing to build a snapshot from it`
        );
      }
    }
    return buildCombinedSnapshotBytes(null, splits);
  }

  private bindSplitFile(filePath: string) {
    this.splitFileIdentities.set(filePath, sqliteFileIdentity(filePath));
    return filePath;
  }

  /**
   * Phase 3.6: close the legacy DB handle and rename `library.sqlite` to
   * `library.sqlite.pre-split.bak`. Called once from the constructor after
   * all five per-group inits run. Idempotent — if the legacy file is
   * already missing, we skip silently.
   *
   * Note: after this returns, `this.db` is closed. Any subsequent reference
   * to `this.db` (including `this.orm`) will throw "Cannot use a closed
   * database". The per-group accessors no longer fall back to `this.orm`
   * in practice because every `<group>Orm` is now set.
   *
   * Some export paths (`buildCombinedSnapshotBytes`) call `VACUUM INTO`
   * against `this.db` as their starting point — but the legacy is empty
   * post-flip, so the resulting temp file is just the SQLite header. We
   * leave it alone and let the combine loop overlay per-group rows on top.
   */
  private retireLegacyDb() {
    try {
      this.db.close();
    } catch {
      // Defensive — best-effort close; bun:sqlite and better-sqlite3 both
      // tolerate double-close.
    }
    const legacyPath = resolveLibraryDbPath();
    const backupPath = getPreSplitBackupPath();
    try {
      // LIB-FMT-07 cleanup: once every group's split marker is recorded the
      // per-group files are the truth, and a leftover pre-split backup is a
      // full extra copy of the library on disk. The boot that CREATES the
      // backup (below) has none yet, so a fresh split keeps its safety net for
      // one more boot.
      let removedStaleBackup = false;
      if (existsSync(backupPath)) {
        const groupMarkers = (["core", "metadata", "playback", "ingest", "templates"] as const).map(
          (group) => `migration_phase3_${group}_split`
        );
        const recorded = this.coreDb
          ?.prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE key IN (${groupMarkers.map(() => "?").join(", ")});`)
          .get(...groupMarkers) as { n?: number } | undefined;
        if (Number(recorded?.n ?? 0) === groupMarkers.length) {
          rmSync(backupPath, { force: true });
          removedStaleBackup = true;
        }
      }
      if (!existsSync(legacyPath)) return;
      // Phase 3.6 backup protection: on re-boots after the original split, the
      // legacy file may be a freshly-written empty placeholder (openLocal's
      // missing-cache-file branch writes `library.sqlite` before constructing
      // LibraryDb). If the per-group core split marker is already present, the
      // real user data lives in the per-group files (and the backup, until the
      // cleanup above removes it) — discard the placeholder, and never turn it
      // into a fresh backup.
      if ((existsSync(backupPath) || removedStaleBackup) && this.coreSplitMarkerPresent()) {
        removeSqliteFiles(legacyPath);
        return;
      }
      if (existsSync(backupPath)) {
        rmSync(backupPath, { force: true });
      }
      copyFileSync(legacyPath, backupPath);
      removeSqliteFiles(legacyPath);
    } catch {
      // If the rename fails (e.g. another process holds the file open on
      // Windows), leave the file in place — the markers in
      // `core.app_settings.migration_phase3_<group>_split` already record
      // success of the per-group splits, so app behavior is unaffected.
    }
  }

  private coreSplitMarkerPresent(): boolean {
    if (!this.coreDb) return false;
    try {
      const rows = this.coreDb
        .prepare(
          "SELECT 1 FROM app_settings WHERE key = 'migration_phase3_core_split' LIMIT 1;"
        )
        .all();
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Phase 3.1: open `library.core.sqlite`, run the one-time legacy-split
   * migration for the core group (copy rows + drop legacy copies), and wire
   * `this.coreDb` / `this.coreOrm`. Subsequent core-table queries route to
   * the dedicated file. Idempotent — safe to call on every open.
   *
   * Fresh installs (no legacy data) end up with empty core tables in the
   * legacy file (nothing to copy) and an empty `library.core.sqlite` ready
   * for new rows. After this completes, `this.orm` no longer owns core
   * tables — they live in `coreOrm` only.
   */
  private initializeCoreDb() {
    const coreDbPath = getCoreDbPath();
    const coreDb = openLibraryGroupDb(coreDbPath, true);

    splitGroupFromLegacy({
      legacyDb: this.db,
      targetDb: coreDb,
      coreDb,
      group: "core",
      dropFromLegacy: true,
    });

    runMigrations(coreDb, "core", desktopCoreMigrations);
    for (const slug of ensureSystemPlaylists(coreDb)) this.healedSystemPlaylists.add(slug);
    registerLibraryGroupDb(coreDb, coreDbPath);

    this.coreDb = coreDb;
    this.coreOrm = createOrm(coreDb);
    this.coreDbPath = this.bindSplitFile(coreDbPath);
  }

  /**
   * Phase 3.2: open `library.metadata.sqlite` and copy metadata-group tables
   * out of the legacy DB. Like Phase 3.1, this is copy-only — the legacy file
   * keeps the metadata rows so the unrouted `this.orm` queries continue to
   * behave correctly until the flip commit. Idempotent via marker stored in
   * `core.app_settings.migration_phase3_metadata_split`.
   *
   * Off-by-default FK semantics: cross-group FKs (e.g. media_files.media_id
   * references media_items in the core file) cannot be enforced once the
   * tables live in separate SQLite files, so the new metadata DB opens with
   * foreign_keys OFF — app-level fan-out enforces referential integrity in
   * the flip commit's ops router.
   */
  private initializeMetadataDb() {
    if (!this.coreDb) return;
    const metadataDbPath = getMetadataDbPath();
    const metadataDb = openLibraryGroupDb(metadataDbPath, false);

    splitGroupFromLegacy({
      legacyDb: this.db,
      targetDb: metadataDb,
      coreDb: this.coreDb,
      group: "metadata",
      dropFromLegacy: true,
    });

    runMigrations(metadataDb, "metadata", desktopMetadataMigrations);
    registerLibraryGroupDb(metadataDb, metadataDbPath);

    this.metadataDb = metadataDb;
    this.metadataOrm = createOrm(metadataDb);
    this.metadataDbPath = this.bindSplitFile(metadataDbPath);
  }

  /**
   * Phase 3.3: open `library.playback.sqlite` and copy playback-group tables
   * out of the legacy DB. Copy-only; legacy keeps the rows. Idempotent via
   * `core.app_settings.migration_phase3_playback_split`.
   *
   * Foreign-keys OFF because playback tables FK-reference media_files
   * (metadata group) and media_items (core group) — cross-file FKs are
   * unenforceable without ATTACH.
   */
  private initializePlaybackDb() {
    if (!this.coreDb) return;
    const playbackDbPath = getPlaybackDbPath();
    const playbackDb = openLibraryGroupDb(playbackDbPath, false);

    splitGroupFromLegacy({
      legacyDb: this.db,
      targetDb: playbackDb,
      coreDb: this.coreDb,
      group: "playback",
      dropFromLegacy: true,
    });

    this.migratePlaybackDb(playbackDb);
    registerLibraryGroupDb(playbackDb, playbackDbPath);

    this.playbackDb = playbackDb;
    this.playbackOrm = createOrm(playbackDb);
    this.playbackDbPath = this.bindSplitFile(playbackDbPath);
    this.backfillOriginalSizes();
  }

  /**
   * The playback group's migrations (LIB-FMT-12). The conversion step (`desktopPlaybackMigrationsPacked`) runs only
   * when the account is switched (LIB-FMT-13) or the file is already converted (an unswitched open of a converted
   * file must not read as "too new"). Steps and the `user_version` bump commit in one transaction: a crash leaves
   * the file either unconverted or converted, never half.
   */
  private migratePlaybackDb(playbackDb: SqliteDatabase) {
    const userVersion = Number(playbackDb.prepare("PRAGMA user_version;").get()?.user_version ?? 0);
    const convert = this.targetOpStreamVersion >= 4 || userVersion >= PACKED_PLAYBACK_LAYOUT_VERSION;
    const startedAt = performance.now();
    const result = playbackDb.transaction(() =>
      runMigrations(playbackDb, "playback", convert ? desktopPlaybackMigrationsPacked : desktopPlaybackMigrations)
    )();
    this.packedPlayback = convert;
    if (result.applied.includes(PACKED_PLAYBACK_LAYOUT_VERSION)) {
      logger.info(
        { from: result.from, to: result.to, ms: Math.round(performance.now() - startedAt) },
        "library.v4.convert: playback group converted to packed chunk lists (LIB-FMT-12)"
      );
    }
  }

  /**
   * LIB-FMT-12: adopt the account's switch from a meta read; a switched account converts this device's playback
   * group in place (never by downloading the library again). Synchronous, so no other library call interleaves.
   */
  // tla: LibrarySync/CompactMeta
  // tla: LibrarySync/SyncMeta
  private adoptTargetOpStreamVersion(meta: unknown) {
    const target = metaTargetOpStreamVersion(meta);
    // The switch is one-way (LIB-FMT-13): a meta without the field (an older server copy mid-update) never undoes it.
    if (target <= this.targetOpStreamVersion) return;
    this.targetOpStreamVersion = target;
    if (this.playbackDb && !this.packedPlayback) {
      this.migratePlaybackDb(this.playbackDb);
      this.changeUnattributed = true;
    }
  }

  /**
   * The op-stream version this library's writes are in (LIB-FMT-13): 4 only once the account is switched AND this
   * device's playback group is converted; a version-3 layout writes version 3, whatever the switch.
   */
  // tla: LibrarySync/FlushBuild
  private writtenOpStreamVersion() {
    return this.packedPlayback ? writeOpStreamVersion(this.targetOpStreamVersion) : OP_STREAM_VERSION;
  }

  /** LIB-FMT-13: the op-stream version the account is switched to, as last read (3 until a meta says 4). */
  getTargetOpStreamVersion(): 3 | 4 {
    return this.targetOpStreamVersion;
  }

  /** LIB-FMT-11: whether this device's playback group holds packed chunk lists (uploaders then send a key seed). */
  isPackedPlaybackLayout(): boolean {
    return this.packedPlayback;
  }

  /** Reads meta now and adopts its switch (converting the playback group when it just switched). */
  async refreshTargetOpStreamVersion(): Promise<3 | 4> {
    this.adoptTargetOpStreamVersion(await getLibraryMeta(this.token));
    return this.targetOpStreamVersion;
  }

  /**
   * STOR-USE-02: fills `media_files.original_size_bytes` for files stored before it was recorded, from their source
   * copy (`media_formats` lives in the playback file, `media_files` in the metadata file, so this runs once both are
   * open). Runs once per library (marker in core's `app_settings`); a failure leaves the sizes empty and never stops the
   * library from opening.
   */
  private backfillOriginalSizes() {
    const { coreDb, metadataDb, playbackDb } = this;
    if (!coreDb || !metadataDb || !playbackDb) return;
    try {
      const filled = backfillOriginalSizeFromSourceFormats(coreDb, metadataDb, playbackDb);
      if (filled > 0) console.info("[library-db] original_size.backfill", JSON.stringify({ filled }));
    } catch (error) {
      console.warn("[library-db] original_size.backfill_failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Phase 3.4: open `library.ingest.sqlite` and copy ingest-group tables
   * (ingest_jobs + ingest_job_events) out of the legacy DB. Copy-only;
   * legacy keeps the rows. Idempotent via
   * `core.app_settings.migration_phase3_ingest_split`.
   *
   * Foreign-keys OFF because ingest_jobs.media_id references core's
   * media_items (cross-group FK, unenforceable across files).
   */
  private initializeIngestDb() {
    if (!this.coreDb) return;
    const ingestDbPath = getIngestDbPath();
    const ingestDb = openLibraryGroupDb(ingestDbPath, false);

    splitGroupFromLegacy({
      legacyDb: this.db,
      targetDb: ingestDb,
      coreDb: this.coreDb,
      group: "ingest",
      dropFromLegacy: true,
    });

    runMigrations(ingestDb, "ingest", desktopIngestMigrations);
    registerLibraryGroupDb(ingestDb, ingestDbPath);

    this.ingestDb = ingestDb;
    this.ingestOrm = createOrm(ingestDb);
    this.ingestDbPath = this.bindSplitFile(ingestDbPath);
  }

  /**
   * Phase 3.5: open `library.templates.sqlite` and copy templates-group
   * tables out of the legacy DB. Desktop-only — mobile never reaches this
   * code because its `LibraryDb` opens four files, not five. Copy-only.
   * Idempotent via `core.app_settings.migration_phase3_templates_split`.
   *
   * Foreign-keys OFF because media_skip_analysis FK-references media_items
   * and media_episodes (cross-file FKs).
   */
  private initializeTemplatesDb() {
    if (!this.coreDb) return;
    const templatesDbPath = getTemplatesDbPath();
    const templatesDb = openLibraryGroupDb(templatesDbPath, false);

    splitGroupFromLegacy({
      legacyDb: this.db,
      targetDb: templatesDb,
      coreDb: this.coreDb,
      group: "templates",
      dropFromLegacy: true,
    });

    runMigrations(templatesDb, "templates", desktopTemplatesMigrations);
    registerLibraryGroupDb(templatesDb, templatesDbPath);

    this.templatesDb = templatesDb;
    this.templatesOrm = createOrm(templatesDb);
    this.templatesDbPath = this.bindSplitFile(templatesDbPath);
  }

  getDatasetStatus() {
    return { ...this.datasetStatus };
  }

  onDatasetStatus(callback: (status: { core: boolean; metadata: boolean; playback: boolean }) => void) {
    this.datasetListeners.add(callback);
    callback(this.getDatasetStatus());
    return () => {
      this.datasetListeners.delete(callback);
    };
  }

  private setDatasetStatus(next: Partial<{ core: boolean; metadata: boolean; playback: boolean }>) {
    const updated = { ...this.datasetStatus, ...next };
    const changed =
      updated.core !== this.datasetStatus.core ||
      updated.metadata !== this.datasetStatus.metadata ||
      updated.playback !== this.datasetStatus.playback;
    this.datasetStatus = updated;
    if (!changed) return;
    this.datasetListeners.forEach((listener) => listener(this.getDatasetStatus()));
  }

  private async ensurePublishableState(stage: "ops" | "snapshot" | "pending-snapshot") {
    // A timer callback can race a close() — if we're already closed we bail
    // out silently rather than quarantining the local state. See `closed`
    // field docs.
    if (this.closed) return false;
    try {
      // Phase 3.6: integrity-check every per-group SQLite file. The legacy
      // file is retired (closed + renamed to .pre-split.bak) after the
      // constructor's `retireLegacyDb()` runs, so we check the per-group
      // handles instead. If no per-group DB is set (defensive fallback in
      // tests that mock `this.db` directly), fall back to checking the
      // legacy handle so the integrity contract still holds.
      //
      // #25: the full check is cached per handle + data_version (see
      // `verifyDbIntegrity`), so an ops flush on an unchanged file costs one
      // `PRAGMA data_version` per group instead of reading every page.
      // Snapshot publishes ship the whole file image and always re-check.
      const force = stage !== "ops";
      const integrityChecks: Array<[string, SqliteDatabase | null]> = [
        ["core", this.coreDb],
        ["metadata", this.metadataDb],
        ["playback", this.playbackDb],
        ["ingest", this.ingestDb],
        ["templates", this.templatesDb],
      ];
      let anyGroupDb = false;
      for (const [name, db] of integrityChecks) {
        if (!db) continue;
        anyGroupDb = true;
        verifyDbIntegrity(name, db, { force, stage });
      }
      if (!anyGroupDb) {
        verifyDbIntegrity("legacy", this.db, { force, stage });
      }

      // EXISTS stops at the first row; COUNT(1) walked the whole table on
      // every flush only to compare the result with zero.
      const mediaRow = this.coreSqlite
        .prepare("SELECT EXISTS(SELECT 1 FROM media_items) AS c;")
        .get() as { c?: number } | undefined;
      const hasMediaRows = Number(mediaRow?.c ?? 0) > 0;

      const formatsRow = this.playbackSqlite
        .prepare("SELECT EXISTS(SELECT 1 FROM media_formats) AS c;")
        .get() as { c?: number } | undefined;
      const audioRow = this.playbackSqlite
        .prepare("SELECT EXISTS(SELECT 1 FROM media_audio_tracks) AS c;")
        .get() as { c?: number } | undefined;
      const hasPlayableRows = Number(formatsRow?.c ?? 0) > 0 || Number(audioRow?.c ?? 0) > 0;

      if (hasPlayableRows && !hasMediaRows) {
        // LIB-SYNC-22: a device that applied another device's delete before the fix kept that title's playback rows.
        // Once it deletes its own last title the library is empty for a reason this device can name (the deletes it
        // is about to send), so the leftovers are cleared and the deletes go out. Without such a delete the empty
        // core is unexplained (a lost or replaced core file) and publishing stays blocked.
        const ownDeletes = this.pendingOps.filter((op) => op.type === "media.delete").length;
        if (ownDeletes === 0) throw new Error("semantic_orphaned_playback_rows");
        const pruned = this.pruneOrphanedSecondaryRows();
        logger.warn({ stage, ownDeletes, pruned }, "library.publish.orphaned_rows_pruned");
      }

      return true;
    } catch (error) {
      this.quarantineSync(stage, error);
      return false;
    }
  }

  private quarantineSync(stage: string, error: unknown) {
    this.syncEnabled = false;
    const timestamp = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    try {
      const quarantinePath = joinPath(libraryDir(), `quarantine-${timestamp}.sqlite`);
      writeFileSync(quarantinePath, this.buildCombinedExportBytes());
    } catch {
      // The image is built on demand; if the per-group files are what went
      // wrong it cannot be built, and the log line below still records why.
    }
    try {
      const logLine = JSON.stringify({
        at: new Date(timestamp).toISOString(),
        stage,
        message,
      });
      writeFileSync(resolveLibraryQuarantineLogPath(), `${logLine}\n`, { flag: "a" });
    } catch {
      // Best-effort quarantine logging.
    }
    logger.error({
      stage,
      message,
    }, "publish blocked; local state quarantined");
  }

  /**
   * Open the library of `account` on the server this process talks to (LIB-STORE-06): its files live in
   * `library/<server>/<userId>/`, never in another account's. Without `account` the flat `library/` dir is used
   * (single-account embedders, tests); the desktop runtime always passes it.
   */
  // tla: VaultKeys/PutFails
  static async open(token: string, keyBase64: string, account?: LibraryAccount): Promise<LibraryDb> {
    const openStartedAt = performance.now();
    const selection = await pickBlob(token, account ? libraryOwnerFor(account) : null);
    const pending = await loadPending();
    const pendingOps = await loadPendingOps();
    const pickBlobMs = Math.round(performance.now() - openStartedAt);
    if (selection.source === "unavailable") {
      throw new Error("SYNC_UNAVAILABLE");
    }
    // LIB-FMT-12: a switched account's library is converted while it opens, before any op is applied.
    const targetOpStreamVersion = metaTargetOpStreamVersion(selection.meta);
    const openCacheFallback = async (
      cache:
        | { version: number; dbPath?: string; stateHash?: string | null; lastOpId?: string | null }
        | null
        | undefined,
      remoteVersionHint?: number
    ) => {
      if (!cache) {
        syncDebug("cache-fallback:missing-cache", {
          remoteVersionHint: remoteVersionHint ?? null,
        });
        throw new Error("SYNC_UNAVAILABLE");
      }
      const cachePath = cache.dbPath ?? getCacheDbPath();
      // Phase 3.6: legacy cache file may be absent after the per-group split.
      // Per-group files hold the truth — open an empty in-memory db and let
      // the constructor's initialize<Group>Db wire up the real ORMs.
      const postSplit = existsSync(getCoreDbPath());
      if (!existsSync(cachePath) && !postSplit) {
        syncDebug("cache-fallback:missing-cache-file", {
          cachePath,
          cacheVersion: cache.version,
          remoteVersionHint: remoteVersionHint ?? null,
        });
        throw new Error("SYNC_UNAVAILABLE");
      }
      const db = existsSync(cachePath)
        ? openSqliteDb(readFileSync(cachePath))
        : openInMemorySqliteDb();
      try {
        ensureLibrarySchema(db);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("media_format_chunks") || message.includes("format_id")) {
          db.exec("DROP TABLE IF EXISTS media_format_chunks;");
          ensureLibrarySchema(db);
        } else {
          throw error;
        }
      }
      const remoteVersion = Number.isFinite(Number(remoteVersionHint))
        ? Number(remoteVersionHint)
        : cache.version;
      return await LibraryDb.construct(
        token,
        keyBase64,
        db,
        cache.version,
        remoteVersion,
        pending,
        pendingOps,
        normalizeStateHash(cache.stateHash ?? null),
        cache.lastOpId ?? null,
        targetOpStreamVersion
      );
    };

    if (selection.source === "remote") {
      syncDebug("open:remote-start", {
        apiBaseUrl: getApiBaseUrl(),
        metaVersion: selection.meta?.version ?? null,
        cacheVersion: selection.cache?.version ?? null,
      });
      const remote = await getLibraryDb(token);
      if (!remote.exists || !remote.manifestKey) {
        syncDebug("open:remote-missing", {
          exists: remote.exists,
          hasManifestKey: Boolean(remote.manifestKey),
          version: remote.version,
          snapshotVersion: remote.snapshotVersion,
        });
        throw new Error("LIBRARY_MISSING");
      }
      let manifestBytes: Uint8Array;
      try {
        manifestBytes = await fetchManifestWithRetry(token, remote.manifestKey);
      } catch (error) {
        syncDebug("open:remote-manifest-fetch-failed", {
          error: error instanceof Error ? error.message : String(error),
          manifestKey: remote.manifestKey,
          remoteVersion: remote.version,
          remoteSnapshotVersion: remote.snapshotVersion,
        });
        if (error instanceof Error && error.message === "REMOTE_MISSING") {
          return openCacheFallback(selection.cache, selection.meta?.version);
        }
        throw error;
      }
      const manifestPlain = await decodeStoredManifest(keyBase64, manifestBytes);
      const manifest = JSON.parse(new TextDecoder().decode(manifestPlain)) as LibrarySnapshotManifest;
      let encryptedSnapshot: Uint8Array;
      try {
        encryptedSnapshot = await downloadChunks(token, manifest);
      } catch (error) {
        syncDebug("open:remote-chunk-download-failed", {
          error: error instanceof Error ? error.message : String(error),
          chunkCount: manifest.chunks.length,
        });
        throw error;
      }
      const bytes = await decryptLibraryPayload(keyBase64, encryptedSnapshot).catch(() => {
        throw new Error("DECRYPT_FAILED");
      });
      const db = openSqliteDb(bytes);
      try {
        ensureLibrarySchema(db);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("media_format_chunks") || message.includes("format_id")) {
          db.exec("DROP TABLE IF EXISTS media_format_chunks;");
          ensureLibrarySchema(db);
        } else {
          throw error;
        }
      }
      const snapshotVersion = remote.snapshotVersion ?? remote.version;
      await saveCache({
        version: snapshotVersion,
        dbPath: getCacheDbPath(),
        updatedAt: remote.updatedAt ?? null,
        stateHash: normalizeStateHash(selection.meta?.stateHash),
        lastOpId: selection.meta?.lastOpId ?? null,
      });
      const instance = await LibraryDb.construct(
        token,
        keyBase64,
        db,
        snapshotVersion,
        snapshotVersion,
        pending,
        pendingOps,
        normalizeStateHash(selection.meta?.stateHash),
        selection.meta?.lastOpId ?? null,
        targetOpStreamVersion
      );
      // The remote snapshot is at snapshotVersion, but meta.version may be
      // ahead of that when ops have been uploaded since the last snapshot
      // upload (the common case after addMedia* writes — putLibraryOp bumps
      // version but does not produce a new manifest). Without this catch-up
      // the freshly-opened db is missing those ops until the SSE stream
      // delivers a meta event, which the renderer can't always rely on
      // (network errors, slow connect, headless environments). Apply pending
      // remote ops here so the open contract is "after open returns, the db
      // matches the API's authoritative version".
      if (selection.meta && selection.meta.version > snapshotVersion) {
        await instance.syncFromRemoteIfNewer(selection.meta).catch(() => undefined);
      }
      return instance;
    }

    if (selection.source === "cache" && selection.cache) {
      const cachePath = selection.cache.dbPath ?? getCacheDbPath();
      // Phase 3.6: post-split state may have a missing legacy cache file. The
      // per-group SQLite files hold the truth — pass an empty in-memory db
      // and let the constructor's initialize<Group>Db wire up the real
      // per-group ORMs.
      const postSplit = existsSync(getCoreDbPath());
      if (!existsSync(cachePath) && !postSplit) {
        throw new Error("LIBRARY_CACHE_MISSING");
      }
      try {
        let db: SqliteDatabase;
        if (existsSync(cachePath)) {
          const bytes = readFileSync(cachePath);
          db = openSqliteDb(bytes);
        } else {
          db = openInMemorySqliteDb();
        }
        try {
          ensureLibrarySchema(db);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message.includes("media_format_chunks") || message.includes("format_id")) {
            db.exec("DROP TABLE IF EXISTS media_format_chunks;");
            ensureLibrarySchema(db);
          } else {
            throw error;
          }
        }
        const remoteVersion = selection.meta?.version ?? selection.cache.version;
        return await LibraryDb.construct(
          token,
          keyBase64,
          db,
          selection.cache.version,
          remoteVersion,
          pending,
          pendingOps,
          normalizeStateHash(selection.cache.stateHash ?? selection.meta?.stateHash),
          selection.cache.lastOpId ?? selection.meta?.lastOpId ?? null,
          targetOpStreamVersion
        );
      } catch (error) {
        // A LibraryFormatTooNewError from the constructor's per-group
        // initialize (initialize<Group>Db → runMigrations) means this build
        // cannot safely open the library at any version — the cache is fine,
        // the user needs to update. Clearing the cache + recursing into open()
        // would translate the typed error into a `pickBlob: "unavailable"`
        // signal, which the renderer surfaces as the generic
        // "Library unavailable" copy instead of the blocking
        // LibraryFormatTooNewModal. Rethrow so the renderer's
        // `parseLibraryFormatTooNew` catches it and the modal takes over.
        if (error instanceof LibraryFormatTooNewError) {
          throw error;
        }
        // Fallback: Clear cache and retry as a fresh remote sync
        await LibraryDb.clearLocalCache(account);
        return LibraryDb.open(token, keyBase64, account);
      }
    }

    // No remote DB yet; initialize a fresh one and upload.
    // Stage timings, always logged: a first-run bootstrap is a one-off per
    // account, and when onboarding stalls on "Creating…" this line names
    // the stage that held it (issue #25: 25 s open with an idle gate).
    const bootstrapStartedAt = performance.now();
    const bootstrapStages: Record<string, number> = {};
    const markBootstrap = (stage: string) => {
      bootstrapStages[stage] = Math.round(performance.now() - bootstrapStartedAt);
    };
    const db = openSqliteDb();
    try {
      ensureLibrarySchema(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("media_format_chunks") || message.includes("format_id")) {
        db.exec("DROP TABLE IF EXISTS media_format_chunks;");
        ensureLibrarySchema(db);
      } else {
        throw error;
      }
    }
    const rawBytes = exportDbBytes(db);
    markBootstrap("schema");

    try {
      // The account's probe may come from Parrot (or a key saved after an erase): a first Badger library must be
      // published under that key, never under another one (PRIV-KEY-01).
      const checkedKeyProbe = await assertAccountLibraryKey(token, keyBase64, undefined, selection.meta);
      const encrypted = await encryptSnapshotBytes(keyBase64, rawBytes);
      const snapshotId = randomUUID();
      const manifest = buildManifest(snapshotId, encrypted, rawBytes);
      const chunks = buildChunks(encrypted);
      markBootstrap("encrypt");
      await uploadChunks(token, chunks);
      markBootstrap("uploadChunks");
      const manifestPayload = await encryptBytesToBytes(
        keyBase64,
        new TextEncoder().encode(JSON.stringify(manifest))
      );
      const created = await putLibraryDb(
        token,
        resolveBootstrapBaseVersion(selection.meta),
        Buffer.from(manifestPayload).toString("base64"),
        snapshotId,
        CHUNK_SIZE_BYTES,
        await createKeyProbe(keyBase64).finally(() => markBootstrap("keyProbe")),
        undefined,
        undefined,
        undefined,
        undefined,
        chunks.map((entry) => entry.hash),
        DESKTOP_CHUNK_REFS_SOURCE,
        // An empty library holds no playback rows: it is as valid in op stream 4 as in 3, so it declares what the
        // account's writers declare (a switched account refuses a version-3 write, LIB-FMT-13).
        writeOpStreamVersion(targetOpStreamVersion),
        checkedKeyProbe
      );
      markBootstrap("putLibraryDb");
      await saveCache({
        version: created.version,
        dbPath: getCacheDbPath(),
        updatedAt: nowIso(),
        stateHash: normalizeStateHash(created.stateHash ?? null),
        lastOpId: created.lastOpId ?? null,
      });
      markBootstrap("saveCache");
      const instance = await LibraryDb.construct(
        token,
        keyBase64,
        db,
        created.version,
        created.version,
        pending,
        pendingOps,
        normalizeStateHash(created.stateHash ?? null),
        created.lastOpId ?? null,
        targetOpStreamVersion
      );
      markBootstrap("construct");
      logger.info(
        { pickBlobMs, stages: bootstrapStages, chunkCount: chunks.length, rawBytes: rawBytes.byteLength },
        "bootstrap open timings"
      );
      return instance;
    } catch (error) {
      if (shouldTreatSyncUnavailable(error)) {
        throw new Error("SYNC_UNAVAILABLE");
      }
      if (error instanceof ApiError && error.status === 409) {
        // Someone else created it between our meta check and upload; retry remote.
        logger.info(
          libraryRefusalFields(error, { baseVersion: resolveBootstrapBaseVersion(selection.meta), consecutive409: 1 }),
          "bootstrap: server refused the first library upload (409) — opening the server's library instead"
        );
        const remote = await getLibraryDb(token);
        if (!remote.exists || !remote.manifestKey) {
          throw new Error("LIBRARY_MISSING");
        }
        let manifestBytes: Uint8Array;
        try {
          manifestBytes = await fetchManifestBytes(token, remote.manifestKey);
        } catch (error) {
          if (error instanceof Error && error.message === "REMOTE_MISSING") {
            db.close();
            return openCacheFallback(selection.cache, selection.meta?.version);
          }
          throw error;
        }
        const manifestPlain = await decodeStoredManifest(keyBase64, manifestBytes);
        const manifest = JSON.parse(new TextDecoder().decode(manifestPlain)) as LibrarySnapshotManifest;
        const encryptedSnapshot = await downloadChunks(token, manifest);
        const bytes = await decryptLibraryPayload(keyBase64, encryptedSnapshot).catch(() => {
          throw new Error("DECRYPT_FAILED");
        });
        const retryDb = openSqliteDb(bytes);
        try {
          ensureLibrarySchema(retryDb);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message.includes("media_format_chunks") || message.includes("format_id")) {
            retryDb.exec("DROP TABLE IF EXISTS media_format_chunks;");
            ensureLibrarySchema(retryDb);
          } else {
            throw error;
          }
        }
        await saveCache({
          version: remote.version,
          dbPath: getCacheDbPath(),
          updatedAt: remote.updatedAt ?? null,
          stateHash: normalizeStateHash(selection.meta?.stateHash),
          lastOpId: selection.meta?.lastOpId ?? null,
        });
        db.close();
        return await LibraryDb.construct(
          token,
          keyBase64,
          retryDb,
          remote.version,
          remote.version,
          pending,
          pendingOps,
          normalizeStateHash(selection.meta?.stateHash),
          selection.meta?.lastOpId ?? null,
          targetOpStreamVersion
        );
      }
      throw error;
    }
  }

  /** Offline open of `account`'s local library (see `open`); the old flat dir is never opened offline, nothing can prove whose it is. */
  static async openLocal(token: string, keyBase64: string, account?: LibraryAccount) {
    if (account) {
      const owner = libraryOwnerFor(account);
      migrateFlatLibrary(owner, null);
      selectLibraryOwner(owner);
    }
    const cache = await loadCache();
    const pending = await loadPending();
    const pendingOps = await loadPendingOps();
    // Phase 3.6: per-group files are the canonical store after the split. The
    // legacy single-file `library.sqlite` may not exist on disk anymore —
    // `loadCache` tolerates that, and we must avoid writing a fresh empty
    // placeholder that would reset version/stateHash to 0 (and trigger a
    // backup-overwrite race in retireLegacyDb).
    const postSplit = existsSync(getCoreDbPath());
    if (!cache) {
      if (postSplit) {
        // Post-split rehydrate without legacy cache: per-group files hold the
        // canonical data and the constructor wires up real ORMs from them.
        const db = openInMemorySqliteDb();
        ensureLibrarySchema(db);
        await saveCache({ version: 0, dbPath: getCacheDbPath(), updatedAt: nowIso() });
        // Offline: the switch is unknown (3); a file converted earlier stays converted (migratePlaybackDb).
        return await LibraryDb.construct(token, keyBase64, db, 0, 0, pending, pendingOps, null, null, 3);
      }
      const db = openSqliteDb();
      ensureLibrarySchema(db);
      const dbPath = getCacheDbPath();
      writeFileSync(dbPath, exportDbBytes(db));
      await saveCache({ version: 0, dbPath, updatedAt: nowIso() });
      return await LibraryDb.construct(token, keyBase64, db, 0, 0, pending, pendingOps, null, null, 3);
    }
    const cachePath = cache.dbPath ?? getCacheDbPath();
    if (!existsSync(cachePath)) {
      if (!postSplit) {
        // Pre-Phase-3 upgrade boot where legacy file was lost but cache survived
        // — restore an empty legacy file and reset the cache. Keeps the older
        // boot semantics intact.
        const db = openSqliteDb();
        ensureLibrarySchema(db);
        writeFileSync(cachePath, exportDbBytes(db));
        await saveCache({ version: 0, dbPath: cachePath, updatedAt: nowIso() });
        return await LibraryDb.construct(token, keyBase64, db, 0, 0, pending, pendingOps, null, null, 3);
      }
      // Post-split: per-group files hold the truth, the legacy file is gone for
      // good. Use an in-memory `this.db` (the constructor's initialize<Group>Db
      // wires real per-group ORMs and retireLegacyDb's marker check protects
      // the existing backup). Preserve the cache's version + sync state.
      const db = openInMemorySqliteDb();
      ensureLibrarySchema(db);
      return await LibraryDb.construct(
        token,
        keyBase64,
        db,
        cache.version,
        cache.version,
        pending,
        pendingOps,
        normalizeStateHash(cache.stateHash ?? null),
        cache.lastOpId ?? null,
        3
      );
    }
    const bytes = readFileSync(cachePath);
    const db = openSqliteDb(bytes);
    ensureLibrarySchema(db);
    return await LibraryDb.construct(
      token,
      keyBase64,
      db,
      cache.version,
      cache.version,
      pending,
      pendingOps,
      normalizeStateHash(cache.stateHash ?? null),
      cache.lastOpId ?? null,
      3
    );
  }

  static async getLocalCacheBytes(keyBase64?: string) {
    const cache = await loadCache();
    if (!cache) return null;
    // LIB-STORE-05: after the split the per-group files are the only local
    // copy; the single-file image is assembled here, on demand.
    if (existsSync(getCoreDbPath())) {
      const groups: Array<{ path: string; tables: ReadonlyArray<string> }> = [
        { path: getCoreDbPath(), tables: CORE_TABLES },
        { path: getMetadataDbPath(), tables: METADATA_TABLES },
        { path: getPlaybackDbPath(), tables: PLAYBACK_TABLES },
        { path: getIngestDbPath(), tables: INGEST_TABLES },
        { path: getTemplatesDbPath(), tables: TEMPLATES_TABLES },
      ].filter((group) => existsSync(group.path));
      const opened = groups.map((group) => ({ ...group, db: openDatabase(group.path) }));
      try {
        // A playback file no instance of this build has opened yet (last written before LIB-FMT-11) lacks the
        // packed tables `PLAYBACK_TABLES` copies. Create them empty, as every open does; no `user_version` bump.
        const playback = opened.find((group) => group.tables === PLAYBACK_TABLES);
        if (playback) for (const statement of PACKED_PLAYBACK_DDL) playback.db.exec(statement);
        return buildCombinedSnapshotBytes(null, opened);
      } finally {
        for (const group of opened) group.db.close();
      }
    }
    const cachePath = cache.dbPath ?? getCacheDbPath();
    if (!existsSync(cachePath)) return null;
    const raw = readFileSync(cachePath);
    return isSqliteHeader(raw) ? raw : null;
  }

  static async hasLocalCache() {
    const cache = await loadCache();
    return Boolean(cache);
  }

  /**
   * Forget this computer's copy of a library (sign-out, a reset; LIB-STORE-06): `account`'s whole dir (else the
   * selected account's), or every file of the flat dir when no account was ever selected. The server copy stays.
   */
  static async clearLocalCache(account?: LibraryAccount) {
    const owner = account ? libraryOwnerFor(account) : getActiveLibraryOwner();
    if (owner) {
      removeAccountLibrary(owner);
      return;
    }
    removeFlatLibraryFiles();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    // Disable sync FIRST so any in-flight async op that yields back to this
    // instance observes !syncEnabled before touching this.db. flushOps and
    // schedulePersist both early-return on !syncEnabled.
    this.syncEnabled = false;
    if (this.persistState || this.persistScheduled) {
      // LIB-STORE-05: the per-group files already hold every write; only the
      // cache version stamp is left to flush.
      void saveCache({
        version: this.version,
        dbPath: getCacheDbPath(),
        updatedAt: nowIso(),
        stateHash: this.stateHash,
        lastOpId: this.lastOpId,
      });
    }
    // Clear every scheduled callback that could later touch this.db. A
    // late-firing timer on a closed handle throws "Cannot use a closed
    // database" inside ensurePublishableState and quarantines local state.
    if (this.persistIdleHandle !== null) {
      cancelIdle(this.persistIdleHandle);
      this.persistIdleHandle = null;
    }
    if (this.opsFlushTimer) {
      clearTimeout(this.opsFlushTimer);
      this.opsFlushTimer = null;
    }
    if (this.opsFlushCircuitCooldownTimer) {
      clearTimeout(this.opsFlushCircuitCooldownTimer);
      this.opsFlushCircuitCooldownTimer = null;
    }
    this.persistScheduled = false;
    this.persistState = null;
    try {
      // Phase 3.6: `this.db` was already retired by `retireLegacyDb()` in
      // the constructor, but double-close is tolerated by both bun:sqlite
      // and better-sqlite3 — wrap defensively so a binding-specific quirk
      // doesn't break the rest of teardown.
      this.db?.close?.();
    } catch {
      // ignore
    }
    const groupDbs = [this.coreDb, this.metadataDb, this.playbackDb, this.ingestDb, this.templatesDb];
    this.coreDb = null;
    this.coreOrm = null;
    this.metadataDb = null;
    this.metadataOrm = null;
    this.playbackDb = null;
    this.playbackOrm = null;
    this.ingestDb = null;
    this.ingestOrm = null;
    this.templatesDb = null;
    this.templatesOrm = null;
    closeLibraryGroupDbs(groupDbs);
  }

  isClosed() {
    return this.closed;
  }

  getVersion() {
    return this.version;
  }

  /** A shared `people` row changed: every media whose cast lists it changed too. */
  private noteMediaOfPerson(personId: string) {
    const rows = this.metadata
      .selectDistinct({ mediaId: mediaRoles.mediaId })
      .from(mediaRoles)
      .where(eq(mediaRoles.personId, personId))
      .all();
    for (const row of rows) this.noteMediaChanged(String(row.mediaId));
  }

  /** Records that a write touched `mediaId`'s details (see `changedMediaIds`). */
  private noteMediaChanged(mediaId: string) {
    this.changedMediaIds.add(mediaId);
    this.mediaNotesSincePersist += 1;
  }

  /**
   * The media whose details changed since the previous call, then resets.
   * `all: true` when a write could not say which (the consumer refetches the
   * whole library). Version-only moves (an upload acknowledgement adopting the
   * server version) change no content and report no media.
   */
  takeChangedMedia(): { mediaIds: string[]; all: boolean } {
    const taken = { mediaIds: [...this.changedMediaIds], all: this.changeUnattributed };
    this.changedMediaIds.clear();
    this.changeUnattributed = false;
    return taken;
  }

  exportBytes() {
    return this.buildCombinedExportBytes();
  }

  /**
   * PRIV-KEY-13: this library sealed under the new key for the rotation, as a snapshot (chunks uploaded), declaring
   * the op stream its writes are in.
   */
  async sealForRotation(newKeyBase64: string): Promise<RotationOwnLibrary> {
    const sealed = await sealLibrarySnapshot(this.token, newKeyBase64, this.buildCombinedExportBytes());
    return { ...sealed, opStreamVersion: this.writtenOpStreamVersion() };
  }

  /**
   * PRIV-KEY-13: the local cache (no library open: onboarding's "recover from this device") sealed under the new key.
   * Its op stream is what its playback file's layout holds: a converted (packed) file is version 4, else 3.
   */
  static async sealLocalCacheForRotation(token: string, newKeyBase64: string): Promise<RotationOwnLibrary | null> {
    const rawBytes = await LibraryDb.getLocalCacheBytes();
    if (!rawBytes) return null;
    let opStreamVersion = OP_STREAM_VERSION;
    if (existsSync(getPlaybackDbPath())) {
      const playback = openDatabase(getPlaybackDbPath());
      try {
        const userVersion = Number(playback.prepare("PRAGMA user_version;").get()?.user_version ?? 0);
        if (userVersion >= PACKED_PLAYBACK_LAYOUT_VERSION) opStreamVersion = READ_OP_STREAM_VERSION;
      } finally {
        playback.close();
      }
    }
    return { ...(await sealLibrarySnapshot(token, newKeyBase64, rawBytes)), opStreamVersion };
  }

  setSyncEnabled(enabled: boolean) {
    this.syncEnabled = enabled;
    if (enabled) this.resendHealedSystemPlaylists();
  }

  /**
   * LIB-SYNC-10: after the heal moved a system playlist an older build created under a random id onto its fixed
   * id, re-send its items under that id. The other devices dropped them (they name a playlist they do not hold);
   * re-adding an item a device already has changes nothing there.
   */
  private resendHealedSystemPlaylists() {
    if (!this.syncEnabled || this.healedSystemPlaylists.size === 0) return;
    const now = nowIso();
    for (const slug of this.healedSystemPlaylists) {
      const system = systemPlaylistForSlug(slug);
      if (!system) continue;
      const items = this.core
        .select({ id: playlistItems.id, mediaId: playlistItems.mediaId, addedAt: playlistItems.addedAt })
        .from(playlistItems)
        .where(eq(playlistItems.playlistId, system.id))
        .all();
      logger.info({ slug, playlistId: system.id, items: items.length }, "system playlist healed: re-sending its items");
      for (const item of items) {
        void this.queueOp({
          id: randomUUID(),
          type: "playlist.item.add",
          createdAt: now,
          payload: { id: item.id, playlistId: system.id, mediaId: item.mediaId, addedAt: item.addedAt },
        });
      }
    }
    this.healedSystemPlaylists.clear();
  }

  resetQuotaBlock() {
    this.opsFlushQuotaExceeded = false;
    if (this.pendingOps.length > 0) this.scheduleOpsFlush(2000);
  }

  // tla: LibrarySync/TimerFlush
  private scheduleOpsFlush(delayMs = 250) {
    if (this.closed) return;
    if (this.opsFlushInFlight) return;
    if (this.opsFlushCircuitOpen || this.opsFlushQuotaExceeded) return;
    // A queue of progress-class ops only waits for more saves to coalesce
    // into; anything else keeps the normal debounce (and carries the
    // coalesced progress along with it).
    const progressOnly = this.pendingOps.length > 0 && this.pendingOps.every((op) => isProgressClassOp(op));
    const now = Date.now();
    let effectiveDelay = progressOnly ? Math.max(delayMs, LibraryDb.progressOpsFlushDelayMs) : delayMs;
    if (this.opsFlushTimer) {
      // Only a progress deferral may be pulled forward, and never before the
      // delay its caller asked for (a retry backoff stays a backoff).
      if (!this.opsFlushTimerIsProgressDeferral) return;
      effectiveDelay = Math.max(effectiveDelay, this.opsFlushFloorAt - now);
      if (now + effectiveDelay >= this.opsFlushDueAt) return;
      clearTimeout(this.opsFlushTimer);
      this.opsFlushTimer = null;
      logger.debug({ pendingOps: this.pendingOps.length, delayMs: effectiveDelay }, "scheduleOpsFlush: non-progress op pulls the progress deferral forward");
    } else {
      this.opsFlushFloorAt = now + delayMs;
    }
    this.opsFlushTimerIsProgressDeferral = progressOnly && effectiveDelay > delayMs;
    this.opsFlushDueAt = now + effectiveDelay;
    this.opsFlushTimer = setTimeout(() => {
      this.opsFlushTimer = null;
      this.opsFlushTimerIsProgressDeferral = false;
      if (this.closed) return;
      void this.flushOps();
    }, effectiveDelay);
  }

  private queueOp(op: LibraryOp) {
    return this.queueOps([op]);
  }

  // tla: LibrarySync/Edit
  private async queueOps(ops: LibraryOp[]) {
    if (!this.syncEnabled || this.applyingRemoteOps || !ops.length) return;
    const op = ops[ops.length - 1]!;
    this.pendingOps.push(...ops);
    // Coalesce the ops still waiting for upload with the latest-state-wins
    // rule every receiver applies anyway (compactLibraryOps in
    // applyLibraryOps here and on mobile): a later media.upsert /
    // media.progress / setting.set of the same key supersedes an earlier
    // one, so uploading the earlier one only costs a server version, an SSE
    // meta fan-out and (for media.upsert) tens of KB. The head op is left
    // alone while a flush is uploading it — flushOps shift()s it on success.
    const keep = this.opsFlushInFlight ? 1 : 0;
    const before = this.pendingOps.length;
    if (before - keep > 1) {
      // PendingOp is the persisted JSON shape of a LibraryOp (queueOp's input).
      const compacted = compactLibraryOps(this.pendingOps.slice(keep) as unknown as LibraryOp[]);
      if (compacted.length < before - keep) {
        this.pendingOps.splice(keep, before - keep, ...compacted);
        this.opsCoalescedTotal += before - this.pendingOps.length;
        logger.debug({
          opType: op.type,
          dropped: before - this.pendingOps.length,
          pendingOps: this.pendingOps.length,
          coalescedTotal: this.opsCoalescedTotal,
        }, "queueOp: coalesced superseded pending ops");
      }
    }
    await savePendingOps(this.pendingOps);
    this.scheduleOpsFlush();
  }

  private queueMediaUpsert(mediaId: string) {
    this.noteMediaChanged(mediaId);
    if (!this.syncEnabled || this.applyingRemoteOps) return;
    const details = this.getMediaDetails(mediaId);
    if (!details) return;
    if (this.targetOpStreamVersion === 4 && this.packedPlayback) {
      this.queueMediaUpsertV4(details);
      return;
    }
    // A write that changed nothing but the row's updatedAt (markMediaPlayable
    // on a playable title, a replace with identical rows) must not upload the
    // full details again — 45-137 KB per op in the ultimate run. Compared
    // without the top-level updatedAt; any real change still differs.
    const { updatedAt: _updatedAt, ...comparable } = details;
    const serialized = JSON.stringify(comparable);
    // A digest, not the JSON: the memo is per media and a large library would
    // otherwise pin ~100 KB per title.
    const signature = createHash("sha256").update(serialized).digest("base64");
    const lastQueued = this.lastQueuedUpsertSignature.get(mediaId);
    if (lastQueued?.signature === signature) {
      // The writer moved the row's updated_at but nothing is sent: put the
      // clock back to the one the last queued upsert carries, or this device
      // would reject a newer details edit from elsewhere (LIB-SYNC-08).
      this.core.update(mediaItems).set({ updatedAt: lastQueued.updatedAt }).where(eq(mediaItems.id, mediaId)).run();
      this.opsSkippedNoopUpserts += 1;
      logger.debug({ mediaId, bytes: serialized.length, skippedTotal: this.opsSkippedNoopUpserts }, "queueMediaUpsert: details unchanged since the last queued upsert — skipped");
      return;
    }
    this.lastQueuedUpsertSignature.set(mediaId, { signature, updatedAt: details.updatedAt });
    void this.queueOp({
      id: randomUUID(),
      type: "media.upsert",
      createdAt: nowIso(),
      payload: { details },
    });
  }

  /**
   * A title's change as op stream 4 (LIB-FMT-11): its details as a `media.upsert` without playback, one
   * `media.file.playback.set` per file (and the no-file group) whose playback changed since it was last queued, and a
   * `media.file.playback.delete` per file whose playback is gone. Each part is compared with what was last queued for
   * it, so adding one format to one file of a show uploads that file's playback only.
   */
  private queueMediaUpsertV4(details: MediaDetails) {
    const mediaId = details.id;
    const createdAt = nowIso();
    const translated = translateV3MediaUpsert({ id: mediaId, type: "media.upsert", createdAt, payload: { details } });
    const ownerIds = translated.playbackSets.flatMap((set) => [
      ...set.payload.formats.map((format) => format.id),
      ...set.payload.audioTracks.map((track) => track.id),
    ]);
    // The stored rows, not a re-pack of the keys: a seeded list (key mode 2) stays a seed on the wire.
    const stored = this.loadPackedChunkLists(ownerIds);
    const ops: LibraryOp[] = [];
    let unchanged = 0;
    /** The clock last queued for `key` when `payload` is what was queued then; null when it changed (and is memoed now). */
    const unchangedSince = (key: string, payload: unknown, updatedAt: string) => {
      const signature = createHash("sha256").update(JSON.stringify(payload)).digest("base64");
      const lastQueued = this.lastQueuedUpsertSignature.get(key);
      if (lastQueued?.signature === signature) {
        unchanged += 1;
        return lastQueued.updatedAt;
      }
      this.lastQueuedUpsertSignature.set(key, { signature, updatedAt });
      return null;
    };

    const core = translated.upsert.payload.details;
    const { updatedAt: _coreUpdatedAt, ...comparableCore } = core;
    const lastCoreUpdatedAt = unchangedSince(mediaId, comparableCore, core.updatedAt);
    if (lastCoreUpdatedAt === null) {
      ops.push({ id: randomUUID(), type: "media.upsert", createdAt, payload: { details: core } } satisfies MediaUpsertV4Op);
    } else {
      // Nothing but the row's updated_at moved: put the clock back to the one last queued (LIB-SYNC-08).
      this.core.update(mediaItems).set({ updatedAt: lastCoreUpdatedAt }).where(eq(mediaItems.id, mediaId)).run();
    }

    const playbackClock = this.playbackSqlite.prepare(
      `INSERT INTO media_file_playback (media_id, file_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(media_id, file_id) DO UPDATE SET updated_at = excluded.updated_at`
    );
    const announcedKeys = new Set(
      (this.playbackSqlite.prepare("SELECT file_id FROM media_file_playback WHERE media_id = ?").all(mediaId) as Array<{
        file_id: string;
      }>).map((row) => String(row.file_id))
    );
    const currentKeys = new Set<string>();
    let tooLarge: PlaybackOpTooLargeError | null = null;
    for (const set of translated.playbackSets) {
      const fileKey = playbackFileKey(set.payload.fileId);
      currentKeys.add(fileKey);
      const payload = {
        ...set.payload,
        formats: set.payload.formats.map((format) => {
          const list = stored.get(format.id);
          return list ? { ...format, chunkList: chunkListToJson(list) } : format;
        }),
        audioTracks: set.payload.audioTracks.map((track) => {
          const list = stored.get(track.id);
          return list ? { ...track, chunkList: chunkListToJson(list) } : track;
        }),
      };
      const { updatedAt: _setUpdatedAt, ...comparableSet } = payload;
      if (unchangedSince(`${mediaId}:playback:${fileKey}`, comparableSet, payload.updatedAt) !== null) continue;
      const op: MediaFilePlaybackSetOp = { id: randomUUID(), type: "media.file.playback.set", createdAt, payload };
      const bytes = Buffer.byteLength(JSON.stringify(op), "utf8");
      if (bytes > MAX_V4_OP_PLAINTEXT_BYTES) {
        // Never truncated: the rest of the change still goes, this file's set is refused to the caller.
        this.lastQueuedUpsertSignature.delete(`${mediaId}:playback:${fileKey}`);
        tooLarge = new PlaybackOpTooLargeError(mediaId, set.payload.fileId, bytes);
        continue;
      }
      // This device's own playback clock, so an older remote set never replaces what it just wrote.
      playbackClock.run(mediaId, fileKey, payload.updatedAt);
      ops.push(op);
    }
    const removedKeys = new Set([...announcedKeys, ...(this.removedPlaybackFiles.get(mediaId) ?? [])]);
    this.removedPlaybackFiles.delete(mediaId);
    for (const fileKey of removedKeys) {
      if (currentKeys.has(fileKey)) continue;
      const fileId = fileKey === "" ? null : fileKey;
      this.lastQueuedUpsertSignature.delete(`${mediaId}:playback:${fileKey}`);
      this.playbackSqlite.prepare("DELETE FROM media_file_playback WHERE media_id = ? AND file_id = ?").run(mediaId, fileKey);
      ops.push({
        id: randomUUID(),
        type: "media.file.playback.delete",
        createdAt,
        payload: { mediaId, fileId },
      } satisfies MediaFilePlaybackDeleteOp);
    }
    if (ops.length) {
      logger.debug({ mediaId, ops: ops.map((op) => op.type), unchanged }, "queueMediaUpsertV4: queued");
      void this.queueOps(ops);
    } else {
      this.opsSkippedNoopUpserts += 1;
      logger.debug({ mediaId, skippedTotal: this.opsSkippedNoopUpserts }, "queueMediaUpsertV4: nothing changed since last queued — skipped");
    }
    if (tooLarge) {
      logger.error({ mediaId, fileId: tooLarge.fileId, bytes: tooLarge.bytes }, "queueMediaUpsertV4: file playback exceeds one op");
      throw tooLarge;
    }
  }

  async clearPendingSync() {
    this.pendingSync = null;
    await clearPending();
  }

  hasPendingSync() {
    return Boolean(this.pendingSync);
  }

  listMedia(type?: MediaType) {
    const baseQuery = this.core
      .select({
        id: mediaItems.id,
        type: mediaItems.type,
        title: mediaItems.title,
        originalTitle: mediaItems.originalTitle,
        originalLanguage: mediaItems.originalLanguage,
        overview: mediaItems.overview,
        year: mediaItems.year,
        rating: mediaItems.rating,
        posterPath: mediaItems.posterPath,
        backdropPath: mediaItems.backdropPath,
        addedAt: mediaItems.addedAt,
        updatedAt: mediaItems.updatedAt,
        hasFiles: mediaItems.hasFiles,
        progressPct: mediaItems.progressPct,
        lastWatchedAt: mediaItems.lastWatchedAt,
        totalEpisodes: mediaItems.totalEpisodes,
        episodeCount: sql<number>`COALESCE(${mediaItems.totalEpisodes}, 0)`.as("episodeCount"),
      })
      .from(mediaItems);
    const query = type ? baseQuery.where(eq(mediaItems.type, type)) : baseQuery;

    const rows = query.orderBy(desc(mediaItems.addedAt)).all();
    const ownProgress = this.readScopedMediaProgress();
    rows.forEach((row) => {
      if (ownProgress) this.overlayOwnProgress(row, ownProgress);
      if (String(row.type) !== "tv") return;
      const aggregate = this.getTvProgressAggregate(String(row.id));
      if (!aggregate) return;
      row.progressPct = aggregate.progressPct;
      if (aggregate.lastWatchedAt) {
        row.lastWatchedAt = aggregate.lastWatchedAt;
      }
    });
    const mediaIds = rows.map((row) => String(row.id));
    const genresById = this.loadMediaGenres(mediaIds);
    const catalogIdById = this.loadMediaCatalogIds(mediaIds);
    return mapMediaRows(rows, catalogIdById, genresById);
  }

  /**
   * A non-main profile sees its own progress on every title, never the main profile's: a title it never started
   * reads as not started (as `overlayProfileProgress` on phone/TV). A show's watched % is then recomputed from the
   * profile's own episode resume points by the caller.
   */
  private overlayOwnProgress(
    row: { id: unknown; progressPct: number | null; lastWatchedAt: string | null },
    ownProgress: ReadonlyMap<string, MediaProgress>
  ) {
    const own = ownProgress.get(String(row.id));
    row.progressPct = own?.progressPct ?? 0;
    row.lastWatchedAt = own?.lastWatchedAt ?? null;
  }

  hasAnyMedia() {
    const row = this.core
      .select({ count: sql<number>`COUNT(*)`.as("count") })
      .from(mediaItems)
      .all()[0];
    return (row?.count ?? 0) > 0;
  }

  private loadMediaGenres(mediaIds: string[]) {
    const map = new Map<string, number[]>();
    if (!mediaIds.length) return map;
    const rows = this.core
      .select({ mediaId: mediaGenres.mediaId, genreId: mediaGenres.genreId })
      .from(mediaGenres)
      .where(inArray(mediaGenres.mediaId, mediaIds))
      .all();
    rows.forEach((row) => {
      const id = String(row.mediaId);
      const next = map.get(id) ?? [];
      const genreId = Number(row.genreId);
      if (Number.isFinite(genreId)) next.push(genreId);
      map.set(id, next);
    });
    return map;
  }

  /** The catalog id of each title that has one (META-SRC-09: rows of older libraries under the old source too). */
  private loadMediaCatalogIds(mediaIds: string[]) {
    const map = new Map<string, number>();
    if (!mediaIds.length) return map;
    const rows = this.core
      .select({ mediaId: mediaExternalIds.mediaId, externalId: mediaExternalIds.externalId })
      .from(mediaExternalIds)
      .where(and(inArray(mediaExternalIds.mediaId, mediaIds), inArray(mediaExternalIds.source, CATALOG_ID_SOURCES)))
      .all();
    rows.forEach((row) => {
      const value = Number(row.externalId);
      if (Number.isFinite(value)) map.set(String(row.mediaId), value);
    });
    return map;
  }

  /** The catalog id of each person that has one (META-SRC-09: rows of older libraries under the old source too). */
  private loadPeopleCatalogIds(personIds: string[]) {
    const map = new Map<string, number>();
    if (!personIds.length) return map;
    const rows = this.metadata
      .select({ personId: peopleExternalIds.personId, externalId: peopleExternalIds.externalId })
      .from(peopleExternalIds)
      .where(and(inArray(peopleExternalIds.personId, personIds), inArray(peopleExternalIds.source, CATALOG_ID_SOURCES)))
      .all();
    rows.forEach((row) => {
      const value = Number(row.externalId);
      if (Number.isFinite(value)) map.set(String(row.personId), value);
    });
    return map;
  }

  private loadDesiredFormats(fileIds: string[]) {
    const map = new Map<string, { quality: string; codec: string; bitrateKbps?: number | null }[]>();
    if (!fileIds.length) return map;
    const rows = this.metadata
      .select({
        fileId: mediaFileDesiredFormats.fileId,
        quality: mediaFileDesiredFormats.quality,
        codec: mediaFileDesiredFormats.codec,
        bitrateKbps: mediaFileDesiredFormats.bitrateKbps,
      })
      .from(mediaFileDesiredFormats)
      .where(inArray(mediaFileDesiredFormats.fileId, fileIds))
      .orderBy(asc(mediaFileDesiredFormats.quality), asc(mediaFileDesiredFormats.codec))
      .all();
    rows.forEach((row) => {
      const id = String(row.fileId);
      const next = map.get(id) ?? [];
      next.push({
        quality: String(row.quality),
        codec: String(row.codec),
        bitrateKbps: row.bitrateKbps === null || row.bitrateKbps === undefined ? null : Number(row.bitrateKbps),
      });
      map.set(id, next);
    });
    return map;
  }

  /**
   * Packed chunk lists of the given formats or audio tracks (LIB-FMT-11), by owner id; empty before the conversion.
   * Owners without a packed row keep their per-chunk rows (a list stored by an older writer before an op rewrote it).
   */
  private loadPackedChunkLists(ownerIds: string[]) {
    const map = new Map<string, PackedChunkList>();
    if (!this.packedPlayback || !ownerIds.length) return map;
    const sqlite = this.playbackSqlite;
    for (let offset = 0; offset < ownerIds.length; offset += 500) {
      const page = ownerIds.slice(offset, offset + 500);
      const rows = sqlite
        .prepare(
          `SELECT owner_id, placement_id, key_mode, key_data, count, sizes, starts FROM media_chunk_lists WHERE owner_id IN (${page.map(() => "?").join(",")})`
        )
        .all(...page) as PackedChunkListRow[];
      for (const row of rows) map.set(String(row.owner_id), packedListFromRow(row));
    }
    return map;
  }

  /** A file whose playback this device just dropped: the next v4 upsert of its title sends `media.file.playback.delete`. */
  private notePlaybackFileRemoved(mediaId: string, fileId: string) {
    const keys = this.removedPlaybackFiles.get(mediaId) ?? new Set<string>();
    keys.add(playbackFileKey(fileId));
    this.removedPlaybackFiles.set(mediaId, keys);
  }

  /** Stores one owner's chunks as its packed row and drops its per-chunk rows (LIB-FMT-11 layout). */
  private writePackedChunkList(
    ownerId: string,
    ownerKind: ChunkListOwnerKind,
    chunks: ReadonlyArray<ChunkEntryInput> | ReadonlyArray<string>,
    chunkKeySeed: string | null | undefined,
    updatedAt: string
  ) {
    const sqlite = this.playbackSqlite;
    const legacyTable = ownerKind === CHUNK_LIST_OWNER_KIND.format ? "media_format_chunks" : "media_audio_chunks";
    const legacyColumn = ownerKind === CHUNK_LIST_OWNER_KIND.format ? "format_id" : "track_id";
    sqlite.prepare(`DELETE FROM ${legacyTable} WHERE ${legacyColumn} = ?`).run(ownerId);
    if (!chunks.length) {
      sqlite.prepare("DELETE FROM media_chunk_lists WHERE owner_id = ?").run(ownerId);
      return;
    }
    const list = packUploadedChunks(normalizeChunkEntries(chunks), chunkKeySeed);
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO media_chunk_lists (owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run(ownerId, ownerKind, list.placementId, list.keyMode, list.keyData, list.count, list.sizes, list.starts, updatedAt);
  }

  private loadFormatChunks(formatIds: string[]) {
    const map = new Map<
      string,
      Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>
    >();
    if (!formatIds.length) return map;
    for (const [ownerId, list] of this.loadPackedChunkLists(formatIds)) map.set(ownerId, unpackChunkList(list));
    const unpackedIds = map.size ? formatIds.filter((id) => !map.has(id)) : formatIds;
    if (!unpackedIds.length) return map;
    const rows = this.playback
      .select({
        formatId: mediaFormatChunks.formatId,
        chunkKey: mediaFormatChunks.chunkKey,
        orderIndex: mediaFormatChunks.orderIndex,
        sizeBytes: mediaFormatChunks.sizeBytes,
        startSeconds: mediaFormatChunks.startSeconds,
      })
      .from(mediaFormatChunks)
      .where(inArray(mediaFormatChunks.formatId, unpackedIds))
      .orderBy(asc(mediaFormatChunks.formatId), asc(mediaFormatChunks.orderIndex))
      .all();
    rows.forEach((row) => {
      const id = String(row.formatId);
      const next = map.get(id) ?? [];
      next.push({
        key: String(row.chunkKey),
        sizeBytes:
          row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
        startSeconds:
          row.startSeconds === null || row.startSeconds === undefined ? null : Number(row.startSeconds),
      });
      map.set(id, next);
    });
    return map;
  }

  private loadAudioChunks(trackIds: string[]) {
    const map = new Map<
      string,
      Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>
    >();
    if (!trackIds.length) return map;
    for (const [ownerId, list] of this.loadPackedChunkLists(trackIds)) map.set(ownerId, unpackChunkList(list));
    const unpackedIds = map.size ? trackIds.filter((id) => !map.has(id)) : trackIds;
    if (!unpackedIds.length) return map;
    const rows = this.playback
      .select({
        trackId: mediaAudioChunks.trackId,
        chunkKey: mediaAudioChunks.chunkKey,
        orderIndex: mediaAudioChunks.orderIndex,
        sizeBytes: mediaAudioChunks.sizeBytes,
        startSeconds: mediaAudioChunks.startSeconds,
      })
      .from(mediaAudioChunks)
      .where(inArray(mediaAudioChunks.trackId, unpackedIds))
      .orderBy(asc(mediaAudioChunks.trackId), asc(mediaAudioChunks.orderIndex))
      .all();
    rows.forEach((row) => {
      const id = String(row.trackId);
      const next = map.get(id) ?? [];
      next.push({
        key: String(row.chunkKey),
        sizeBytes:
          row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
        startSeconds:
          row.startSeconds === null || row.startSeconds === undefined ? null : Number(row.startSeconds),
      });
      map.set(id, next);
    });
    return map;
  }

  private loadTemplateFormats(templateIds: string[]) {
    const map = new Map<
      string,
      Array<{
        id: string;
        quality: string;
        codec: string;
        codecString: string | null;
        bitrateKbps: number | null;
        initKey: string | null;
        initSize: number | null;
        durationSeconds: number | null;
        totalSize: number | null;
        sizeMb: number;
      }>
    >();
    if (!templateIds.length) return map;
    const rows = this.templates
      .select({
        id: mediaTemplateFormats.id,
        templateId: mediaTemplateFormats.templateId,
        quality: mediaTemplateFormats.quality,
        codec: mediaTemplateFormats.codec,
        codecString: mediaTemplateFormats.codecString,
        bitrateKbps: mediaTemplateFormats.bitrateKbps,
        initKey: mediaTemplateFormats.initKey,
        initSize: mediaTemplateFormats.initSize,
        durationSeconds: mediaTemplateFormats.durationSeconds,
        totalSize: mediaTemplateFormats.totalSize,
        sizeMb: mediaTemplateFormats.sizeMb,
      })
      .from(mediaTemplateFormats)
      .where(inArray(mediaTemplateFormats.templateId, templateIds))
      .orderBy(desc(mediaTemplateFormats.quality), asc(mediaTemplateFormats.codec))
      .all();
    rows.forEach((row) => {
      const id = String(row.templateId);
      const next = map.get(id) ?? [];
      next.push({
        id: String(row.id),
        quality: String(row.quality),
        codec: String(row.codec),
        codecString: row.codecString ? String(row.codecString) : null,
        bitrateKbps:
          row.bitrateKbps === null || row.bitrateKbps === undefined ? null : Number(row.bitrateKbps),
        initKey: row.initKey ? String(row.initKey) : null,
        initSize: row.initSize === null || row.initSize === undefined ? null : Number(row.initSize),
        durationSeconds:
          row.durationSeconds === null || row.durationSeconds === undefined
            ? null
            : Number(row.durationSeconds),
        totalSize: row.totalSize === null || row.totalSize === undefined ? null : Number(row.totalSize),
        sizeMb: Number(row.sizeMb),
      });
      map.set(id, next);
    });
    return map;
  }

  private loadTemplateFormatChunks(formatIds: string[]) {
    const map = new Map<
      string,
      Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>
    >();
    if (!formatIds.length) return map;
    const rows = this.templates
      .select({
        formatId: mediaTemplateFormatChunks.formatId,
        chunkKey: mediaTemplateFormatChunks.chunkKey,
        orderIndex: mediaTemplateFormatChunks.orderIndex,
        sizeBytes: mediaTemplateFormatChunks.sizeBytes,
        startSeconds: mediaTemplateFormatChunks.startSeconds,
      })
      .from(mediaTemplateFormatChunks)
      .where(inArray(mediaTemplateFormatChunks.formatId, formatIds))
      .orderBy(asc(mediaTemplateFormatChunks.formatId), asc(mediaTemplateFormatChunks.orderIndex))
      .all();
    rows.forEach((row) => {
      const id = String(row.formatId);
      const next = map.get(id) ?? [];
      next.push({
        key: String(row.chunkKey),
        sizeBytes:
          row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
        startSeconds:
          row.startSeconds === null || row.startSeconds === undefined ? null : Number(row.startSeconds),
      });
      map.set(id, next);
    });
    return map;
  }

  private loadTemplateAudioTracks(templateIds: string[]) {
    const map = new Map<
      string,
      Array<{
        id: string;
        language: string;
        label: string;
        isDefault: boolean;
        source: string;
        codec: string | null;
        codecString: string | null;
        initKey: string | null;
        initSize: number | null;
        durationSeconds: number | null;
        totalSize: number | null;
      }>
    >();
    if (!templateIds.length) return map;
    const rows = this.templates
      .select({
        id: mediaTemplateAudioTracks.id,
        templateId: mediaTemplateAudioTracks.templateId,
        language: mediaTemplateAudioTracks.language,
        label: mediaTemplateAudioTracks.label,
        isDefault: mediaTemplateAudioTracks.isDefault,
        source: mediaTemplateAudioTracks.source,
        codec: mediaTemplateAudioTracks.codec,
        codecString: mediaTemplateAudioTracks.codecString,
        initKey: mediaTemplateAudioTracks.initKey,
        initSize: mediaTemplateAudioTracks.initSize,
        durationSeconds: mediaTemplateAudioTracks.durationSeconds,
        totalSize: mediaTemplateAudioTracks.totalSize,
      })
      .from(mediaTemplateAudioTracks)
      .where(inArray(mediaTemplateAudioTracks.templateId, templateIds))
      .orderBy(desc(mediaTemplateAudioTracks.isDefault), asc(mediaTemplateAudioTracks.language))
      .all();
    rows.forEach((row) => {
      const id = String(row.templateId);
      const next = map.get(id) ?? [];
      next.push({
        id: String(row.id),
        language: String(row.language),
        label: String(row.label),
        isDefault: Boolean(row.isDefault),
        source: String(row.source),
        codec: row.codec ? String(row.codec) : null,
        codecString: row.codecString ? String(row.codecString) : null,
        initKey: row.initKey ? String(row.initKey) : null,
        initSize: row.initSize === null || row.initSize === undefined ? null : Number(row.initSize),
        durationSeconds:
          row.durationSeconds === null || row.durationSeconds === undefined
            ? null
            : Number(row.durationSeconds),
        totalSize: row.totalSize === null || row.totalSize === undefined ? null : Number(row.totalSize),
      });
      map.set(id, next);
    });
    return map;
  }

  private loadTemplateAudioChunks(trackIds: string[]) {
    const map = new Map<
      string,
      Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>
    >();
    if (!trackIds.length) return map;
    const rows = this.templates
      .select({
        trackId: mediaTemplateAudioChunks.trackId,
        chunkKey: mediaTemplateAudioChunks.chunkKey,
        orderIndex: mediaTemplateAudioChunks.orderIndex,
        sizeBytes: mediaTemplateAudioChunks.sizeBytes,
        startSeconds: mediaTemplateAudioChunks.startSeconds,
      })
      .from(mediaTemplateAudioChunks)
      .where(inArray(mediaTemplateAudioChunks.trackId, trackIds))
      .orderBy(asc(mediaTemplateAudioChunks.trackId), asc(mediaTemplateAudioChunks.orderIndex))
      .all();
    rows.forEach((row) => {
      const id = String(row.trackId);
      const next = map.get(id) ?? [];
      next.push({
        key: String(row.chunkKey),
        sizeBytes:
          row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
        startSeconds:
          row.startSeconds === null || row.startSeconds === undefined ? null : Number(row.startSeconds),
      });
      map.set(id, next);
    });
    return map;
  }

  private loadTemplateSubtitles(templateIds: string[]) {
    const map = new Map<
      string,
      Array<{
        id: string;
        language: string;
        label: string;
        objectKey: string | null;
        format: string | null;
        isDefault: boolean;
        source: string;
      }>
    >();
    if (!templateIds.length) return map;
    const rows = this.templates
      .select({
        id: mediaTemplateSubtitles.id,
        templateId: mediaTemplateSubtitles.templateId,
        language: mediaTemplateSubtitles.language,
        label: mediaTemplateSubtitles.label,
        objectKey: mediaTemplateSubtitles.objectKey,
        format: mediaTemplateSubtitles.format,
        isDefault: mediaTemplateSubtitles.isDefault,
        source: mediaTemplateSubtitles.source,
      })
      .from(mediaTemplateSubtitles)
      .where(inArray(mediaTemplateSubtitles.templateId, templateIds))
      .orderBy(desc(mediaTemplateSubtitles.isDefault), asc(mediaTemplateSubtitles.language))
      .all();
    rows.forEach((row) => {
      const id = String(row.templateId);
      const next = map.get(id) ?? [];
      next.push({
        id: String(row.id),
        language: String(row.language),
        label: String(row.label),
        objectKey: row.objectKey ? String(row.objectKey) : null,
        format: row.format ? String(row.format) : null,
        isDefault: Boolean(row.isDefault),
        source: String(row.source),
      });
      map.set(id, next);
    });
    return map;
  }

  private loadTemplateChapters(formatIds: string[]) {
    const map = new Map<string, Array<{ title: string; startSeconds: number }>>();
    if (!formatIds.length) return map;
    const rows = this.templates
      .select({
        formatId: mediaTemplateChapters.formatId,
        title: mediaTemplateChapters.title,
        startSeconds: mediaTemplateChapters.startSeconds,
      })
      .from(mediaTemplateChapters)
      .where(inArray(mediaTemplateChapters.formatId, formatIds))
      .orderBy(asc(mediaTemplateChapters.formatId), asc(mediaTemplateChapters.startSeconds))
      .all();
    rows.forEach((row) => {
      const id = String(row.formatId);
      const next = map.get(id) ?? [];
      next.push({ title: String(row.title), startSeconds: Number(row.startSeconds) });
      map.set(id, next);
    });
    return map;
  }

  private ensurePerson(member: { catalogId: number | null; name: string; profilePath: string | null }) {
    const name = member.name.trim();
    const profilePath = member.profilePath ?? null;
    const catalogId = catalogPersonId(member.catalogId);

    if (catalogId !== null) {
      const match = this.metadata
        .select({ id: people.id, name: people.name, profilePath: people.profilePath })
        .from(peopleExternalIds)
        .innerJoin(people, eq(peopleExternalIds.personId, people.id))
        .where(and(inArray(peopleExternalIds.source, CATALOG_ID_SOURCES), eq(peopleExternalIds.externalId, String(catalogId))))
        .limit(1)
        .all()[0];
      if (match?.id) {
        const updates: { name?: string; profilePath?: string | null } = {};
        if (name && String(match.name) !== name) updates.name = name;
        // META-ART-01: a person's photo already copied into the user's storage is shared by every title they are
        // in; importing or refreshing another title keeps that copy instead of putting the provider path back,
        // which would fetch and store the same photo once more for each title.
        const keepsCopy = isCatalogImagePath(profilePath) && artworkDisplaySource(match.profilePath === null ? null : String(match.profilePath)) === "vault";
        if (profilePath && !keepsCopy && String(match.profilePath ?? "") !== profilePath) updates.profilePath = profilePath;
        if (Object.keys(updates).length > 0) {
          this.noteMediaOfPerson(String(match.id));
          this.metadata.update(people).set(updates).where(eq(people.id, String(match.id))).run();
        }
        this.metadata
          .insert(peopleExternalIds)
          .values({ id: randomUUID(), personId: String(match.id), source: CATALOG_ID_SOURCE, externalId: String(catalogId) })
          .onConflictDoNothing()
          .run();
        this.dropCatalogPersonZero(String(match.id));
        return String(match.id);
      }
    }

    const existingByName = this.metadata
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.name, name), profilePath ? eq(people.profilePath, profilePath) : isNull(people.profilePath)))
      .limit(1)
      .all()[0];

    if (existingByName?.id) {
      if (catalogId !== null) {
        this.metadata
          .insert(peopleExternalIds)
          .values({ id: randomUUID(), personId: String(existingByName.id), source: CATALOG_ID_SOURCE, externalId: String(catalogId) })
          .onConflictDoNothing()
          .run();
        this.dropCatalogPersonZero(String(existingByName.id));
      }
      return String(existingByName.id);
    }

    const personId = randomUUID();
    this.metadata
      .insert(people)
      .values({
        id: personId,
        name,
        profilePath,
      })
      .run();
    if (catalogId !== null) {
      this.metadata
        .insert(peopleExternalIds)
        .values({ id: randomUUID(), personId, source: CATALOG_ID_SOURCE, externalId: String(catalogId) })
        .onConflictDoNothing()
        .run();
    }
    return personId;
  }

  /** LIB-CREW-01: the title's stored crew becomes `crew`, in the given order. */
  private replaceMediaCrew(mediaId: string, crew: ReadonlyArray<MediaCrewDraft>) {
    this.metadata.delete(mediaCrew).where(eq(mediaCrew.mediaId, mediaId)).run();
    crew.forEach((member, index) => {
      if (!member.job || !member.name.trim()) return;
      const personId = this.ensurePerson({
        catalogId: member.catalogId ?? null,
        name: member.name,
        profilePath: member.profilePath ?? null,
      });
      this.metadata
        .insert(mediaCrew)
        .values({ id: randomUUID(), mediaId, personId, job: member.job, orderIndex: index })
        .run();
    });
  }

  /**
   * LIB-CAST-01: catalog person id 0 only ever came from the old `Number(null)` bug. Once a person gets a real id, the
   * 0 goes, so the details read (`catalogId`) shows the real one after a cast refetch.
   */
  private dropCatalogPersonZero(personId: string) {
    this.metadata
      .delete(peopleExternalIds)
      .where(
        and(
          eq(peopleExternalIds.personId, personId),
          inArray(peopleExternalIds.source, CATALOG_ID_SOURCES),
          eq(peopleExternalIds.externalId, "0")
        )
      )
      .run();
  }

  private ensurePersonFromDraft(member: MediaCastDraft) {
    const name = member.name.trim();
    const profilePath = member.profilePath ?? null;
    const catalogId = catalogPersonId(member.catalogId);

    if (member.personId) {
      const updates: { name?: string; profilePath?: string | null } = {};
      if (name) updates.name = name;
      if (profilePath !== undefined) updates.profilePath = profilePath;
      if (Object.keys(updates).length > 0) {
        this.noteMediaOfPerson(String(member.personId));
        this.metadata.update(people).set(updates).where(eq(people.id, String(member.personId))).run();
      }
      if (catalogId !== null) {
        this.metadata
          .insert(peopleExternalIds)
          .values({ id: randomUUID(), personId: String(member.personId), source: CATALOG_ID_SOURCE, externalId: String(catalogId) })
          .onConflictDoNothing()
          .run();
        this.dropCatalogPersonZero(String(member.personId));
      }
      return String(member.personId);
    }

    return this.ensurePerson({ catalogId, name, profilePath });
  }

  private mergeMediaRecords(targetMediaId: string, sourceMediaId: string) {
    if (targetMediaId === sourceMediaId) return;

    const target = this.core
      .select({
        id: mediaItems.id,
        hasFiles: mediaItems.hasFiles,
        progressPct: mediaItems.progressPct,
        lastWatchedAt: mediaItems.lastWatchedAt,
        addedAt: mediaItems.addedAt,
        updatedAt: mediaItems.updatedAt,
        totalEpisodes: mediaItems.totalEpisodes,
      })
      .from(mediaItems)
      .where(eq(mediaItems.id, targetMediaId))
      .limit(1)
      .all()[0];
    const source = this.core
      .select({
        id: mediaItems.id,
        hasFiles: mediaItems.hasFiles,
        progressPct: mediaItems.progressPct,
        lastWatchedAt: mediaItems.lastWatchedAt,
        addedAt: mediaItems.addedAt,
        updatedAt: mediaItems.updatedAt,
        totalEpisodes: mediaItems.totalEpisodes,
      })
      .from(mediaItems)
      .where(eq(mediaItems.id, sourceMediaId))
      .limit(1)
      .all()[0];
    if (!target || !source) return;

    this.metadata.update(mediaFiles).set({ mediaId: targetMediaId }).where(eq(mediaFiles.mediaId, sourceMediaId)).run();
    this.metadata.update(mediaEditions).set({ mediaId: targetMediaId }).where(eq(mediaEditions.mediaId, sourceMediaId)).run();
    this.metadata
      .update(mediaFileDesiredFormats)
      .set({ mediaId: targetMediaId })
      .where(eq(mediaFileDesiredFormats.mediaId, sourceMediaId))
      .run();
    this.playback.update(mediaFormats).set({ mediaId: targetMediaId }).where(eq(mediaFormats.mediaId, sourceMediaId)).run();
    this.playback.update(mediaAudioTracks).set({ mediaId: targetMediaId }).where(eq(mediaAudioTracks.mediaId, sourceMediaId)).run();
    this.playback.update(mediaSubtitles).set({ mediaId: targetMediaId }).where(eq(mediaSubtitles.mediaId, sourceMediaId)).run();
    this.templates.update(mediaSkipAnalysis).set({ mediaId: targetMediaId }).where(eq(mediaSkipAnalysis.mediaId, sourceMediaId)).run();
    this.templates.update(subtitleOcrAttempts).set({ mediaId: targetMediaId }).where(eq(subtitleOcrAttempts.mediaId, sourceMediaId)).run();
    this.metadata.update(mediaSkipMarkers).set({ mediaId: targetMediaId }).where(eq(mediaSkipMarkers.mediaId, sourceMediaId)).run();
    this.core.update(mediaGenres).set({ mediaId: targetMediaId }).where(eq(mediaGenres.mediaId, sourceMediaId)).run();
    this.metadata.update(mediaRoles).set({ mediaId: targetMediaId }).where(eq(mediaRoles.mediaId, sourceMediaId)).run();
    this.metadata.update(mediaCrew).set({ mediaId: targetMediaId }).where(eq(mediaCrew.mediaId, sourceMediaId)).run();
    this.metadata.update(mediaTrailers).set({ mediaId: targetMediaId }).where(eq(mediaTrailers.mediaId, sourceMediaId)).run();
    this.metadata.update(mediaSeasons).set({ mediaId: targetMediaId }).where(eq(mediaSeasons.mediaId, sourceMediaId)).run();
    this.metadata.update(mediaEpisodes).set({ mediaId: targetMediaId }).where(eq(mediaEpisodes.mediaId, sourceMediaId)).run();
    this.core.update(playlistItems).set({ mediaId: targetMediaId }).where(eq(playlistItems.mediaId, sourceMediaId)).run();

    const externalRows = this.core
      .select({
        source: mediaExternalIds.source,
        externalId: mediaExternalIds.externalId,
        mediaType: mediaExternalIds.mediaType,
      })
      .from(mediaExternalIds)
      .where(eq(mediaExternalIds.mediaId, sourceMediaId))
      .all();
    externalRows.forEach((row) => {
      this.core
        .insert(mediaExternalIds)
        .values({
          id: randomUUID(),
          mediaId: targetMediaId,
          source: String(row.source),
          externalId: String(row.externalId),
          mediaType: String(row.mediaType),
        })
        .onConflictDoNothing()
        .run();
    });
    this.core.delete(mediaExternalIds).where(eq(mediaExternalIds.mediaId, sourceMediaId)).run();

    const targetProgress = Number.isFinite(Number(target.progressPct)) ? Number(target.progressPct) : 0;
    const sourceProgress = Number.isFinite(Number(source.progressPct)) ? Number(source.progressPct) : 0;
    const mergedProgress = Math.max(targetProgress, sourceProgress);
    const mergedLastWatchedAt =
      target.lastWatchedAt && source.lastWatchedAt
        ? target.lastWatchedAt > source.lastWatchedAt
          ? target.lastWatchedAt
          : source.lastWatchedAt
        : target.lastWatchedAt ?? source.lastWatchedAt ?? null;
    const mergedAddedAt = target.addedAt < source.addedAt ? target.addedAt : source.addedAt;
    const mergedUpdatedAt = target.updatedAt > source.updatedAt ? target.updatedAt : source.updatedAt;
    const mergedTotalEpisodes =
      Number.isFinite(Number(target.totalEpisodes)) && Number.isFinite(Number(source.totalEpisodes))
        ? Math.max(Number(target.totalEpisodes), Number(source.totalEpisodes))
        : target.totalEpisodes ?? source.totalEpisodes ?? null;

    this.core
      .update(mediaItems)
      .set({
        hasFiles: Boolean(target.hasFiles || source.hasFiles),
        progressPct: mergedProgress,
        lastWatchedAt: mergedLastWatchedAt,
        addedAt: mergedAddedAt,
        updatedAt: mergedUpdatedAt,
        totalEpisodes: mergedTotalEpisodes,
      })
      .where(eq(mediaItems.id, targetMediaId))
      .run();

    // The source's remembered tracks follow its files unless the target already has its own.
    const sourcePrefs = this.getTrackPrefs(sourceMediaId);
    if (sourcePrefs && !this.getTrackPrefs(targetMediaId)) this.writeTrackPrefs(targetMediaId, sourcePrefs);

    this.core.delete(mediaItems).where(eq(mediaItems.id, sourceMediaId)).run();
    void this.queueOp({
      id: randomUUID(),
      type: "media.delete",
      createdAt: nowIso(),
      payload: { mediaId: sourceMediaId },
    });
  }

  private reconcileOrphanedMediaRowsForCatalog(
    targetMediaId: string,
    type: MediaType,
    title: string,
    year: string | null,
    originalTitle: string | null
  ) {
    const normalizedTitle = normalizeIdentityText(title);
    const normalizedOriginalTitle = normalizeIdentityText(originalTitle);
    if (!normalizedTitle) return;

    const yearFilter = year === null ? isNull(mediaItems.year) : eq(mediaItems.year, year);
    const originalTitleFilter = originalTitle === null ? isNull(mediaItems.originalTitle) : eq(mediaItems.originalTitle, originalTitle);

    const candidates = this.core
      .select({
        id: mediaItems.id,
        title: mediaItems.title,
        originalTitle: mediaItems.originalTitle,
      })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.type, type),
          yearFilter,
          originalTitleFilter,
          sql`${mediaItems.id} <> ${targetMediaId}`
        )
      )
      .all();

    candidates.forEach((candidate) => {
      if (normalizeIdentityText(candidate.title) !== normalizedTitle) return;
      if (normalizeIdentityText(candidate.originalTitle) !== normalizedOriginalTitle) return;
      const hasCatalogId = this.core
        .select({ id: mediaExternalIds.id })
        .from(mediaExternalIds)
        .where(and(eq(mediaExternalIds.mediaId, String(candidate.id)), inArray(mediaExternalIds.source, CATALOG_ID_SOURCES)))
        .limit(1)
        .all()[0];
      if (hasCatalogId) return;
      this.mergeMediaRecords(targetMediaId, String(candidate.id));
    });
  }

  /**
   * LIB-SHOW-01: merges a show's catalog season + episode lists into its stored rows instead of replacing them.
   * Rows are matched by (season number, episode number) and keep their id, because everything per episode is
   * keyed by that id — resume progress (`episode_resume_v1:<episodeId>`), skip markers, subtitle and audio rows,
   * and the same rows on the TV / phone / Kodi, which get the ids through the `media.upsert` op. New seasons and
   * episodes are added; nothing stored is ever deleted. An episode or season missing from the catalog answer is not
   * proof it is gone: both fetchers drop entries whose name is empty in the requested language, and a failed
   * season fetch comes back empty. Whether a truly delisted episode should leave the library is LIB-SHOW-02.
   * `mode: "ingest"` takes every catalog field the catalog filled in. `mode: "refresh"` (the background refresh and the
   * Restore follow-up) always updates air dates and episode counts, replaces an episode's name, overview and
   * still only while the episode is provisional (our own `Episode N` placeholder or an empty title, or an air
   * date today or later), and otherwise only fills fields stored empty.
   */
  private mergeShowSeasonsAndEpisodes(
    mediaId: string,
    seasons: TitleDetails["seasons"],
    episodes: TitleDetails["episodes"],
    mode: "ingest" | "refresh"
  ) {
    const result = { addedSeasons: 0, updatedSeasons: 0, addedEpisodes: 0, updatedEpisodes: 0 };
    const today = nowIso().slice(0, 10);

    const storedEpisodes = this.metadata.select().from(mediaEpisodes).where(eq(mediaEpisodes.mediaId, mediaId)).all();
    const storedByKey = new Map<string, (typeof storedEpisodes)[number]>();
    for (const row of storedEpisodes) {
      const key = `${row.seasonNumber}:${row.episodeNumber}`;
      if (!storedByKey.has(key)) storedByKey.set(key, row);
    }
    const seenEpisodes = new Set<string>();
    for (const episode of episodes) {
      const key = `${episode.seasonNumber}:${episode.episodeNumber}`;
      if (seenEpisodes.has(key)) continue;
      seenEpisodes.add(key);
      const stored = storedByKey.get(key);
      if (!stored) {
        this.metadata
          .insert(mediaEpisodes)
          .values({
            id: randomUUID(),
            mediaId,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            title: episode.name,
            overview: episode.overview,
            stillPath: episode.stillPath,
            airDate: episode.airDate,
          })
          .run();
        result.addedEpisodes += 1;
        continue;
      }
      const placeholderTitle = !stored.title || stored.title === `Episode ${stored.episodeNumber}`;
      const provisional = mode === "ingest" || placeholderTitle || (stored.airDate !== null && stored.airDate >= today);
      // An empty or missing catalog value never blanks a stored one.
      const next = provisional
        ? {
            title: episode.name || stored.title,
            overview: episode.overview ?? stored.overview,
            stillPath: episode.stillPath ?? stored.stillPath,
            airDate: episode.airDate ?? stored.airDate,
          }
        : {
            title: stored.title,
            overview: stored.overview ?? episode.overview,
            stillPath: stored.stillPath ?? episode.stillPath,
            airDate: episode.airDate ?? stored.airDate,
          };
      if (
        next.title === stored.title &&
        next.overview === stored.overview &&
        next.stillPath === stored.stillPath &&
        next.airDate === stored.airDate
      ) {
        continue;
      }
      this.metadata.update(mediaEpisodes).set(next).where(eq(mediaEpisodes.id, stored.id)).run();
      result.updatedEpisodes += 1;
    }

    const storedSeasons = this.metadata.select().from(mediaSeasons).where(eq(mediaSeasons.mediaId, mediaId)).all();
    const storedSeasonByNumber = new Map<number, (typeof storedSeasons)[number]>();
    for (const row of storedSeasons) {
      if (!storedSeasonByNumber.has(row.seasonNumber)) storedSeasonByNumber.set(row.seasonNumber, row);
    }
    const seenSeasons = new Set<number>();
    for (const season of seasons) {
      if (seenSeasons.has(season.seasonNumber)) continue;
      seenSeasons.add(season.seasonNumber);
      const stored = storedSeasonByNumber.get(season.seasonNumber);
      if (!stored) {
        this.metadata
          .insert(mediaSeasons)
          .values({
            id: randomUUID(),
            mediaId,
            seasonNumber: season.seasonNumber,
            title: season.name,
            overview: season.overview,
            posterPath: season.posterPath,
            episodeCount: season.episodeCount,
            airDate: season.airDate,
          })
          .run();
        result.addedSeasons += 1;
        continue;
      }
      const next =
        mode === "ingest"
          ? {
              title: season.name || stored.title,
              overview: season.overview ?? stored.overview,
              posterPath: season.posterPath ?? stored.posterPath,
              episodeCount: season.episodeCount,
              airDate: season.airDate ?? stored.airDate,
            }
          : {
              title: stored.title || season.name,
              overview: stored.overview ?? season.overview,
              posterPath: stored.posterPath ?? season.posterPath,
              episodeCount: season.episodeCount,
              airDate: season.airDate ?? stored.airDate,
            };
      if (
        next.title === stored.title &&
        next.overview === stored.overview &&
        next.posterPath === stored.posterPath &&
        next.episodeCount === stored.episodeCount &&
        next.airDate === stored.airDate
      ) {
        continue;
      }
      this.metadata.update(mediaSeasons).set(next).where(eq(mediaSeasons.id, stored.id)).run();
      result.updatedSeasons += 1;
    }
    return result;
  }

  /**
   * LIB-SHOW-01: the background refresh of a show still airing. Merges the fresh catalog season + episode lists
   * (`mergeShowSeasonsAndEpisodes`, refresh mode) and the episode total; the show's own title, artwork, cast and
   * the like are left alone (the user may have edited them). A change is published as one `media.upsert`, so the
   * TV / phone / Kodi get the new episodes with the desktop's ids.
   */
  async refreshShowEpisodes(mediaId: string, item: TitleDetails): Promise<ShowEpisodeRefreshResult> {
    const mediaRow = this.core
      .select({ type: mediaItems.type, totalEpisodes: mediaItems.totalEpisodes })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaId))
      .limit(1)
      .all()[0];
    if (!mediaRow || mediaRow.type !== "tv") {
      return { changed: false, addedSeasons: 0, updatedSeasons: 0, addedEpisodes: 0, updatedEpisodes: 0, notListed: [] };
    }
    const seasons = (Array.isArray(item.seasons) ? item.seasons : []).map((season) => ({
      seasonNumber: Number.isFinite(Number(season.seasonNumber)) ? Number(season.seasonNumber) : 0,
      name: season.name ?? "",
      overview: season.overview ?? null,
      posterPath: season.posterPath ?? null,
      episodeCount: Number.isFinite(Number(season.episodeCount)) ? Number(season.episodeCount) : 0,
      airDate: season.airDate ?? null,
    }));
    const episodes = (Array.isArray(item.episodes) ? item.episodes : []).map((episode) => ({
      seasonNumber: Number.isFinite(Number(episode.seasonNumber)) ? Number(episode.seasonNumber) : 0,
      episodeNumber: Number.isFinite(Number(episode.episodeNumber)) ? Number(episode.episodeNumber) : 0,
      name: episode.name ?? "",
      overview: episode.overview ?? null,
      stillPath: episode.stillPath ?? null,
      airDate: episode.airDate ?? null,
    }));
    const merged = this.mergeShowSeasonsAndEpisodes(mediaId, seasons, episodes, "refresh");
    const total = Number(item.totalEpisodes);
    const totalChanged = Number.isFinite(total) && total > 0 && total !== Number(mediaRow.totalEpisodes);
    const timestamp = nowIso();
    const changed = totalChanged || merged.addedSeasons + merged.updatedSeasons + merged.addedEpisodes + merged.updatedEpisodes > 0;
    if (changed) {
      this.core
        .update(mediaItems)
        .set(totalChanged ? { totalEpisodes: total, updatedAt: timestamp } : { updatedAt: timestamp })
        .where(eq(mediaItems.id, mediaId))
        .run();
      this.queueMediaUpsert(mediaId);
      await this.persist();
    }
    const notListed = this.episodesNotListedByCatalog(mediaId, seasons, episodes);
    logger.info({ mediaId, changed, totalChanged, ...merged, notListed: notListed.length }, "refreshShowEpisodes");
    return { changed, ...merged, notListed };
  }

  /**
   * LIB-SHOW-02 / LIB-SHOW-04: stored episodes that the catalog no longer lists, as far as the answer can prove it. The
   * fetchers drop episodes whose name is empty in the requested language and a failed season fetch comes back
   * empty, so an episode only counts when its season is in the answer and the answer holds exactly as many
   * episodes for it as the catalog's own `episode_count` (language-independent): then the season list is complete. A
   * season missing from the answer proves nothing (its name may be empty too). An episode with a file carries the
   * change suggested for it (`suggestEpisodeMoves`); it is never offered for removal.
   */
  private episodesNotListedByCatalog(
    mediaId: string,
    seasons: TitleDetails["seasons"],
    episodes: TitleDetails["episodes"]
  ): ShowEpisodeNotListed[] {
    const answered = new Map<number, Set<number>>();
    for (const episode of episodes) {
      const set = answered.get(episode.seasonNumber) ?? new Set<number>();
      set.add(episode.episodeNumber);
      answered.set(episode.seasonNumber, set);
    }
    const completeSeasons = new Set<number>();
    for (const season of seasons) {
      const count = answered.get(season.seasonNumber)?.size ?? 0;
      if (season.episodeCount > 0 && count === season.episodeCount) completeSeasons.add(season.seasonNumber);
    }
    if (completeSeasons.size === 0) return [];
    const fileKeys = this.episodeFileKeys(mediaId);
    const stored: EpisodeForMatch[] = this.metadata
      .select()
      .from(mediaEpisodes)
      .where(eq(mediaEpisodes.mediaId, mediaId))
      .orderBy(asc(mediaEpisodes.seasonNumber), asc(mediaEpisodes.episodeNumber))
      .all()
      .map((row) => ({
        id: row.id,
        seasonNumber: row.seasonNumber,
        episodeNumber: row.episodeNumber,
        title: row.title,
        airDate: row.airDate,
        hasFile: fileKeys.has(`${row.seasonNumber}:${row.episodeNumber}`),
      }));
    const isListed = (row: EpisodeForMatch) => answered.get(row.seasonNumber)?.has(row.episodeNumber) === true;
    const delisted = stored.filter((row) => completeSeasons.has(row.seasonNumber) && !isListed(row));
    const moves = suggestEpisodeMoves(delisted, stored.filter(isListed));
    return delisted.map((row) => {
      const entry: ShowEpisodeNotListed = {
        id: row.id,
        seasonNumber: row.seasonNumber,
        episodeNumber: row.episodeNumber,
        title: row.title,
      };
      const move = moves.get(row.id);
      if (move) entry.move = move;
      return entry;
    });
  }

  private episodeFileKeys(mediaId: string) {
    return new Set(
      this.metadata
        .select({ season: mediaFiles.season, episode: mediaFiles.episode })
        .from(mediaFiles)
        .where(eq(mediaFiles.mediaId, mediaId))
        .all()
        .filter((row) => row.season !== null && row.episode !== null)
        .map((row) => `${Number(row.season)}:${Number(row.episode)}`)
    );
  }

  /**
   * LIB-SHOW-02: removes the episodes the user agreed to drop after the catalog stopped listing them. Only episodes of
   * this show without a file are removed (with their skip markers); one that has a file is kept and counted. The
   * change goes out as one `media.upsert`, whose episode list the TV / phone / Kodi apply.
   */
  async removeEpisodesNotInCatalog(mediaId: string, episodeIds: string[]): Promise<DelistedEpisodeRemovalResult> {
    if (episodeIds.length === 0) return { removed: 0, keptWithFile: 0 };
    const rows = this.metadata
      .select({ id: mediaEpisodes.id, seasonNumber: mediaEpisodes.seasonNumber, episodeNumber: mediaEpisodes.episodeNumber })
      .from(mediaEpisodes)
      .where(and(eq(mediaEpisodes.mediaId, mediaId), inArray(mediaEpisodes.id, episodeIds)))
      .all();
    const fileKeys = this.episodeFileKeys(mediaId);
    const removable = rows.filter((row) => !fileKeys.has(`${row.seasonNumber}:${row.episodeNumber}`)).map((row) => row.id);
    const result = { removed: removable.length, keptWithFile: rows.length - removable.length };
    if (removable.length > 0) {
      this.metadata.delete(mediaSkipMarkers).where(inArray(mediaSkipMarkers.episodeId, removable)).run();
      this.metadata.delete(mediaEpisodes).where(inArray(mediaEpisodes.id, removable)).run();
      this.core.update(mediaItems).set({ updatedAt: nowIso() }).where(eq(mediaItems.id, mediaId)).run();
      this.queueMediaUpsert(mediaId);
      await this.persist();
    }
    logger.info({ mediaId, requested: episodeIds.length, ...result }, "removeEpisodesNotInCatalog");
    return result;
  }

  /**
   * LIB-SHOW-04: moves an episode the user has a file for to another episode slot of the same show, once they said
   * yes. The episode keeps its id and takes the slot's numbers and catalog fields, and the slot's own empty row goes,
   * so everything keyed by the id moves with it on every device: watched state and resume spots
   * (`episode_resume_v1:<id>`, every profile), skip markers, subtitle and audio rows. Every version's file is
   * renumbered to the slot. A slot that has a file is refused: a move never adds a file to an episode that has one.
   * Published as one `media.upsert`.
   */
  async moveEpisodeToSlot(mediaId: string, episodeId: string, targetEpisodeId: string): Promise<EpisodeMoveResult> {
    const fail = (reason: Extract<EpisodeMoveResult, { moved: false }>["reason"]): EpisodeMoveResult => {
      logger.info({ mediaId, episodeId, targetEpisodeId, reason }, "moveEpisodeToSlot: refused");
      return { moved: false, reason };
    };
    if (episodeId === targetEpisodeId) return fail("same-episode");
    const rows = this.metadata
      .select()
      .from(mediaEpisodes)
      .where(and(eq(mediaEpisodes.mediaId, mediaId), inArray(mediaEpisodes.id, [episodeId, targetEpisodeId])))
      .all();
    const source = rows.find((row) => row.id === episodeId);
    const target = rows.find((row) => row.id === targetEpisodeId);
    if (!source || !target) return fail("not-found");
    const fileKeys = this.episodeFileKeys(mediaId);
    if (!fileKeys.has(`${source.seasonNumber}:${source.episodeNumber}`)) return fail("no-file");
    if (fileKeys.has(`${target.seasonNumber}:${target.episodeNumber}`)) return fail("target-has-file");
    const files = this.metadata
      .update(mediaFiles)
      .set({ season: target.seasonNumber, episode: target.episodeNumber })
      .where(
        and(eq(mediaFiles.mediaId, mediaId), eq(mediaFiles.season, source.seasonNumber), eq(mediaFiles.episode, source.episodeNumber))
      )
      .returning({ id: mediaFiles.id })
      .all().length;
    // LIB-EDIT-01: the moved files' editions move with them (a slot with no file holds no edition worth keeping).
    this.metadata
      .delete(mediaEditions)
      .where(and(eq(mediaEditions.mediaId, mediaId), eq(mediaEditions.season, target.seasonNumber), eq(mediaEditions.episode, target.episodeNumber)))
      .run();
    this.metadata
      .update(mediaEditions)
      .set({ season: target.seasonNumber, episode: target.episodeNumber })
      .where(and(eq(mediaEditions.mediaId, mediaId), eq(mediaEditions.season, source.seasonNumber), eq(mediaEditions.episode, source.episodeNumber)))
      .run();
    this.metadata.delete(mediaSkipMarkers).where(eq(mediaSkipMarkers.episodeId, target.id)).run();
    this.templates.delete(mediaSkipAnalysis).where(eq(mediaSkipAnalysis.episodeId, target.id)).run();
    this.metadata.delete(mediaEpisodes).where(eq(mediaEpisodes.id, target.id)).run();
    this.metadata
      .update(mediaEpisodes)
      .set({
        seasonNumber: target.seasonNumber,
        episodeNumber: target.episodeNumber,
        title: target.title || source.title,
        overview: target.overview ?? source.overview,
        stillPath: target.stillPath ?? source.stillPath,
        airDate: target.airDate ?? source.airDate,
      })
      .where(eq(mediaEpisodes.id, source.id))
      .run();
    this.core.update(mediaItems).set({ updatedAt: nowIso() }).where(eq(mediaItems.id, mediaId)).run();
    this.queueMediaUpsert(mediaId);
    await this.persist();
    logger.info(
      {
        mediaId,
        episodeId,
        from: `S${source.seasonNumber}E${source.episodeNumber}`,
        to: `S${target.seasonNumber}E${target.episodeNumber}`,
        droppedSlotId: target.id,
        files,
      },
      "moveEpisodeToSlot"
    );
    return { moved: true, files };
  }

  async addMediaFromCatalog(item: TitleDetails) {
    const normalized: TitleDetails = {
      ...item,
      title: item.title ?? "",
      originalTitle: item.originalTitle ?? null,
      originalLanguage: item.originalLanguage ?? null,
      overview: item.overview ?? null,
      year: item.year ?? null,
      rating: item.rating ?? null,
      posterPath: item.posterPath ?? null,
      backdropPath: item.backdropPath ?? null,
      totalEpisodes: item.totalEpisodes ?? null,
      genres: Array.isArray(item.genres) ? item.genres.filter((id) => Number.isFinite(Number(id))) : [],
      cast: Array.isArray(item.cast)
        ? item.cast.map((member) => ({
            personId: member.personId ?? null,
            name: member.name ?? "",
            role: member.role ?? null,
            profilePath: member.profilePath ?? null,
            order: member.order ?? null,
          }))
        : [],
      trailers: Array.isArray(item.trailers)
        ? item.trailers.map((trailer) => ({
            provider: trailer.provider ?? "youtube",
            key: trailer.key ?? "",
            name: trailer.name ?? null,
            language: trailer.language ?? "en",
            official: Boolean(trailer.official),
          }))
        : [],
      seasons: Array.isArray(item.seasons)
        ? item.seasons.map((season) => ({
            seasonNumber: Number.isFinite(Number(season.seasonNumber)) ? season.seasonNumber : 0,
            name: season.name ?? "",
            overview: season.overview ?? null,
            posterPath: season.posterPath ?? null,
            episodeCount: Number.isFinite(Number(season.episodeCount)) ? season.episodeCount : 0,
            airDate: season.airDate ?? null,
          }))
        : [],
      episodes: Array.isArray(item.episodes)
        ? item.episodes.map((episode) => ({
            seasonNumber: Number.isFinite(Number(episode.seasonNumber)) ? episode.seasonNumber : 0,
            episodeNumber: Number.isFinite(Number(episode.episodeNumber)) ? episode.episodeNumber : 0,
            name: episode.name ?? "",
            overview: episode.overview ?? null,
            stillPath: episode.stillPath ?? null,
            airDate: episode.airDate ?? null,
          }))
        : [],
    };

    const externalId = String(normalized.id);
    const existing = this.core
      .select({ mediaId: mediaExternalIds.mediaId, mediaType: mediaExternalIds.mediaType })
      .from(mediaExternalIds)
      .where(
        and(
          eq(mediaExternalIds.mediaType, normalized.type),
          inArray(mediaExternalIds.source, CATALOG_ID_SOURCES),
          eq(mediaExternalIds.externalId, externalId)
        )
      )
      .limit(1)
      .all();
    const fallback =
      existing.length > 0
        ? null
        : this.core
            .select({ mediaId: mediaExternalIds.mediaId, mediaType: mediaExternalIds.mediaType })
            .from(mediaExternalIds)
            .where(
              and(
                inArray(mediaExternalIds.source, CATALOG_ID_SOURCES),
                eq(mediaExternalIds.externalId, externalId),
                or(isNull(mediaExternalIds.mediaType), eq(mediaExternalIds.mediaType, normalized.type))
              )
            )
            .limit(1)
            .all()[0];
    const resolved = existing[0] ?? fallback ?? null;
    let id = resolved?.mediaId ? String(resolved.mediaId) : null;

    if (!id) {
      const candidateId = randomUUID();
      const claimTimestamp = nowIso();
      this.core
        .insert(mediaItems)
        .values({
          id: candidateId,
          type: normalized.type,
          title: normalized.title,
          originalTitle: normalized.originalTitle,
          originalLanguage: normalized.originalLanguage,
          overview: normalized.overview,
          year: normalized.year,
          rating: normalized.rating,
          posterPath: normalized.posterPath,
          backdropPath: normalized.backdropPath,
          addedAt: claimTimestamp,
          updatedAt: claimTimestamp,
          hasFiles: false,
          progressPct: 0,
          lastWatchedAt: null,
          totalEpisodes: normalized.totalEpisodes,
        })
        .onConflictDoNothing()
        .run();
      this.core
        .insert(mediaExternalIds)
        .values({
          id: randomUUID(),
          mediaId: candidateId,
          mediaType: normalized.type,
          source: CATALOG_ID_SOURCE,
          externalId,
        })
        .onConflictDoNothing()
        .run();
      const claimed = this.core
        .select({ mediaId: mediaExternalIds.mediaId, mediaType: mediaExternalIds.mediaType })
        .from(mediaExternalIds)
        .where(
          and(
            inArray(mediaExternalIds.source, CATALOG_ID_SOURCES),
            eq(mediaExternalIds.externalId, externalId),
            or(isNull(mediaExternalIds.mediaType), eq(mediaExternalIds.mediaType, normalized.type))
          )
        )
        .limit(1)
        .all()[0];
      if (!claimed?.mediaId) {
        throw new Error("MEDIA_EXTERNAL_ID_CLAIM_FAILED");
      }
      id = String(claimed.mediaId);
      if (id !== candidateId) {
        this.core.delete(mediaItems).where(eq(mediaItems.id, candidateId)).run();
      }
      if (claimed.mediaType === null) {
        this.core
          .update(mediaExternalIds)
          .set({ mediaType: normalized.type })
          .where(
            and(
              eq(mediaExternalIds.mediaId, id),
              inArray(mediaExternalIds.source, CATALOG_ID_SOURCES),
              eq(mediaExternalIds.externalId, externalId),
              isNull(mediaExternalIds.mediaType)
            )
          )
          .run();
      }
    } else if (resolved?.mediaType === null) {
      this.core
        .update(mediaExternalIds)
        .set({ mediaType: normalized.type })
        .where(
          and(
            eq(mediaExternalIds.mediaId, id),
            inArray(mediaExternalIds.source, CATALOG_ID_SOURCES),
            eq(mediaExternalIds.externalId, externalId),
            isNull(mediaExternalIds.mediaType)
          )
        )
        .run();
    }
    if (!id) {
      throw new Error("MEDIA_EXTERNAL_ID_RESOLUTION_FAILED");
    }
    const timestamp = nowIso();
    const hasMediaRow = this.core
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.id, id))
      .limit(1)
      .all()[0];

    if (hasMediaRow) {
      this.core
        .update(mediaItems)
        .set({
          title: normalized.title,
          originalTitle: normalized.originalTitle,
          originalLanguage: normalized.originalLanguage,
          overview: normalized.overview,
          year: normalized.year,
          rating: normalized.rating,
          posterPath: normalized.posterPath,
          backdropPath: normalized.backdropPath,
          totalEpisodes: normalized.totalEpisodes,
          updatedAt: timestamp,
        })
        .where(eq(mediaItems.id, id))
        .run();
    } else {
      this.core
        .insert(mediaItems)
        .values({
          id,
          type: normalized.type,
          title: normalized.title,
          originalTitle: normalized.originalTitle,
          originalLanguage: normalized.originalLanguage,
          overview: normalized.overview,
          year: normalized.year,
          rating: normalized.rating,
          posterPath: normalized.posterPath,
          backdropPath: normalized.backdropPath,
          addedAt: timestamp,
          updatedAt: timestamp,
          hasFiles: false,
          progressPct: 0,
          lastWatchedAt: null,
          totalEpisodes: normalized.totalEpisodes,
        })
        .run();
    }

    this.core
      .insert(mediaExternalIds)
      .values({
        id: randomUUID(),
        mediaId: id,
        mediaType: normalized.type,
        source: CATALOG_ID_SOURCE,
        externalId,
      })
      .onConflictDoNothing()
      .run();

    this.reconcileOrphanedMediaRowsForCatalog(
      id,
      normalized.type,
      normalized.title,
      normalized.year,
      normalized.originalTitle
    );

    this.core.delete(mediaGenres).where(eq(mediaGenres.mediaId, id)).run();
    normalized.genres.forEach((genreId) => {
      this.core
        .insert(mediaGenres)
        .values({ id: randomUUID(), mediaId: id, genreId })
        .onConflictDoNothing()
        .run();
    });

    this.metadata.delete(mediaRoles).where(eq(mediaRoles.mediaId, id)).run();
    normalized.cast.forEach((member, index) => {
      const personId = this.ensurePerson({ catalogId: member.personId, name: member.name, profilePath: member.profilePath });
      // `Number(null)` is 0: a cast without billing order kept as 0 everywhere lists alphabetically, not as billed.
      const orderIndex = normalizeOptionalNumber(member.order) ?? index;
      this.metadata
        .insert(mediaRoles)
        .values({
          id: randomUUID(),
          mediaId: id,
          personId,
          role: member.role,
          orderIndex,
        })
        .run();
    });
    this.replaceMediaCrew(id, pickLibraryCrew(item.crew ?? []));

    this.metadata.delete(mediaTrailers).where(eq(mediaTrailers.mediaId, id)).run();
    normalized.trailers.forEach((trailer) => {
      this.metadata
        .insert(mediaTrailers)
        .values({
          id: randomUUID(),
          mediaId: id,
          provider: trailer.provider,
          key: trailer.key,
          name: trailer.name,
          language: trailer.language,
        })
        .run();
    });

    // Merge, never replace: a show added again (or restored) keeps its episode ids (LIB-SHOW-01).
    const merged = this.mergeShowSeasonsAndEpisodes(id, normalized.seasons, normalized.episodes, "ingest");
    logger.info({ mediaId: id, type: normalized.type, ...merged }, "addMediaFromCatalog: seasons + episodes merged");

    this.queueMediaUpsert(id);
    await this.persist();
    return id;
  }

  updateMediaMetadata({
    mediaId,
    media,
    cast,
    crew,
    seasons,
    episodes,
  }: {
    mediaId: string;
    media?: {
      title?: string;
      originalTitle?: string | null;
      originalLanguage?: string | null;
      overview?: string | null;
      year?: string | null;
      rating?: number | null;
      posterPath?: string | null;
      backdropPath?: string | null;
      genres?: number[];
      totalEpisodes?: number | null;
    };
    cast?: MediaCastDraft[];
    crew?: MediaCrewDraft[];
    seasons?: MediaSeasonDraft[];
    episodes?: MediaEpisodeDraft[];
  }) {
    const timestamp = nowIso();
    let touched = false;

    if (media) {
      const updates: Record<string, unknown> = {};
      if ("title" in media) updates.title = media.title ?? "";
      if ("originalTitle" in media) updates.originalTitle = media.originalTitle ?? null;
      if ("originalLanguage" in media) updates.originalLanguage = media.originalLanguage ?? null;
      if ("overview" in media) updates.overview = media.overview ?? null;
      if ("year" in media) updates.year = media.year ?? null;
      if ("rating" in media) updates.rating = media.rating ?? null;
      if ("posterPath" in media) updates.posterPath = media.posterPath ?? null;
      if ("backdropPath" in media) updates.backdropPath = media.backdropPath ?? null;
      if ("totalEpisodes" in media) updates.totalEpisodes = media.totalEpisodes ?? null;
      updates.updatedAt = timestamp;
      this.core.update(mediaItems).set(updates).where(eq(mediaItems.id, mediaId)).run();
      if ("genres" in media) {
        this.core.delete(mediaGenres).where(eq(mediaGenres.mediaId, mediaId)).run();
        const genres = Array.isArray(media.genres) ? media.genres : [];
        genres.forEach((genreId) => {
          this.core
            .insert(mediaGenres)
            .values({ id: randomUUID(), mediaId, genreId })
            .onConflictDoNothing()
            .run();
        });
      }
      touched = true;
    }

    if (cast) {
      this.metadata.delete(mediaRoles).where(eq(mediaRoles.mediaId, mediaId)).run();
      cast.forEach((member, index) => {
        const personId = this.ensurePersonFromDraft(member);
        this.metadata
          .insert(mediaRoles)
          .values({
            id: randomUUID(),
            mediaId,
            personId,
            role: member.role ?? null,
            orderIndex: index,
          })
          .run();
      });
      touched = true;
    }

    if (crew) {
      this.replaceMediaCrew(mediaId, crew);
      touched = true;
    }

    if (seasons) {
      seasons.forEach((season) => {
        this.metadata
          .update(mediaSeasons)
          .set({
            title: season.name,
            overview: season.overview ?? null,
            posterPath: season.posterPath ?? null,
            episodeCount: season.episodeCount ?? null,
            airDate: season.airDate ?? null,
          })
          .where(eq(mediaSeasons.id, season.id))
          .run();
      });
      touched = true;
    }

    if (episodes) {
      episodes.forEach((episode) => {
        this.metadata
          .update(mediaEpisodes)
          .set({
            title: episode.name,
            overview: episode.overview ?? null,
            stillPath: episode.stillPath ?? null,
            airDate: episode.airDate ?? null,
          })
          .where(eq(mediaEpisodes.id, episode.id))
          .run();
      });
      touched = true;
    }

    if (touched && !media) {
      this.core.update(mediaItems).set({ updatedAt: timestamp }).where(eq(mediaItems.id, mediaId)).run();
    }

    if (touched) {
      this.queueMediaUpsert(mediaId);
    }
    return this.persist();
  }

  /**
   * META-ART-01: every image of `mediaId` still stored as a catalog path, in display order (title poster and backdrop,
   * season posters, cast photos, episode stills). Asset keys, user URLs and empty values are left out.
   */
  listArtworkToCopy(mediaId: string): ArtworkSlot[] {
    const slots: ArtworkSlot[] = [];
    const media = this.core
      .select({ posterPath: mediaItems.posterPath, backdropPath: mediaItems.backdropPath })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaId))
      .limit(1)
      .all()[0];
    if (!media) return slots;
    if (isCatalogImagePath(media.posterPath)) slots.push({ target: "mediaPoster", id: mediaId, path: media.posterPath });
    if (isCatalogImagePath(media.backdropPath)) slots.push({ target: "mediaBackdrop", id: mediaId, path: media.backdropPath });
    const seasons = this.metadata
      .select({ id: mediaSeasons.id, posterPath: mediaSeasons.posterPath })
      .from(mediaSeasons)
      .where(eq(mediaSeasons.mediaId, mediaId))
      .orderBy(asc(mediaSeasons.seasonNumber))
      .all();
    for (const season of seasons) {
      if (isCatalogImagePath(season.posterPath)) slots.push({ target: "seasonPoster", id: String(season.id), path: season.posterPath });
    }
    const cast = this.metadata
      .select({ id: people.id, profilePath: people.profilePath })
      .from(mediaRoles)
      .innerJoin(people, eq(people.id, mediaRoles.personId))
      .where(eq(mediaRoles.mediaId, mediaId))
      .orderBy(asc(mediaRoles.orderIndex))
      .all();
    const seenPeople = new Set<string>();
    for (const person of cast) {
      const id = String(person.id);
      if (seenPeople.has(id)) continue;
      seenPeople.add(id);
      if (isCatalogImagePath(person.profilePath)) slots.push({ target: "personProfile", id, path: person.profilePath });
    }
    const episodes = this.metadata
      .select({ id: mediaEpisodes.id, stillPath: mediaEpisodes.stillPath })
      .from(mediaEpisodes)
      .where(eq(mediaEpisodes.mediaId, mediaId))
      .orderBy(asc(mediaEpisodes.seasonNumber), asc(mediaEpisodes.episodeNumber))
      .all();
    for (const episode of episodes) {
      if (isCatalogImagePath(episode.stillPath)) slots.push({ target: "episodeStill", id: String(episode.id), path: episode.stillPath });
    }
    return slots;
  }

  /**
   * META-ART-01: swaps copied artwork in. Compare-and-set: a field is written only while it still holds the catalog
   * path the copy was made from, so an edit, restore or refresh that ran meanwhile wins. Safe to repeat.
   * STOR-PLACE-09: `path` may also be a stored artwork reference whose object is gone, swapped for its fetched-back copy.
   */
  applyArtworkCopies(mediaId: string, copies: ArtworkCopy[]): Promise<ArtworkApplyResult> {
    let applied = 0;
    const unapplied: ArtworkCopy[] = [];
    const touchedPeople = new Set<string>();
    for (const copy of copies) {
      if (!isCatalogImagePath(copy.path) && !artworkStorageKey(copy.path)) {
        unapplied.push(copy);
        continue;
      }
      // Drizzle's `.run()` reports no row count on every driver, so each swap checks the current value first.
      let swapped = false;
      switch (copy.target) {
        case "mediaPoster":
        case "mediaBackdrop": {
          if (copy.id !== mediaId) break;
          const column = copy.target === "mediaPoster" ? mediaItems.posterPath : mediaItems.backdropPath;
          const where = and(eq(mediaItems.id, mediaId), eq(column, copy.path));
          if (this.core.select({ id: mediaItems.id }).from(mediaItems).where(where).limit(1).all().length === 0) break;
          const field = copy.target === "mediaPoster" ? "posterPath" : "backdropPath";
          this.core.update(mediaItems).set({ [field]: copy.value }).where(where).run();
          swapped = true;
          break;
        }
        case "seasonPoster": {
          const where = and(eq(mediaSeasons.id, copy.id), eq(mediaSeasons.mediaId, mediaId), eq(mediaSeasons.posterPath, copy.path));
          if (this.metadata.select({ id: mediaSeasons.id }).from(mediaSeasons).where(where).limit(1).all().length === 0) break;
          this.metadata.update(mediaSeasons).set({ posterPath: copy.value }).where(where).run();
          swapped = true;
          break;
        }
        case "episodeStill": {
          const where = and(eq(mediaEpisodes.id, copy.id), eq(mediaEpisodes.mediaId, mediaId), eq(mediaEpisodes.stillPath, copy.path));
          if (this.metadata.select({ id: mediaEpisodes.id }).from(mediaEpisodes).where(where).limit(1).all().length === 0) break;
          this.metadata.update(mediaEpisodes).set({ stillPath: copy.value }).where(where).run();
          swapped = true;
          break;
        }
        case "personProfile": {
          const where = and(eq(people.id, copy.id), eq(people.profilePath, copy.path));
          if (this.metadata.select({ id: people.id }).from(people).where(where).limit(1).all().length === 0) break;
          this.metadata.update(people).set({ profilePath: copy.value }).where(where).run();
          touchedPeople.add(copy.id);
          swapped = true;
          break;
        }
      }
      if (swapped) applied += 1;
      else unapplied.push(copy);
    }
    const result: ArtworkApplyResult = { applied, skipped: unapplied.length, unapplied };
    // Counts only: the copies carry storage keys.
    logger.info({ mediaId, applied, skipped: unapplied.length }, "applyArtworkCopies");
    if (applied === 0) return Promise.resolve(result);
    // A person's photo shows in every title they play in: those titles changed too.
    for (const personId of touchedPeople) this.noteMediaOfPerson(personId);
    this.core.update(mediaItems).set({ updatedAt: nowIso() }).where(eq(mediaItems.id, mediaId)).run();
    this.queueMediaUpsert(mediaId);
    return this.persist().then(() => result);
  }

  /**
   * ACCT-PROF-03: puts the account-language title, poster and backdrop on a media row (the title-variants pass).
   * Compare-and-set: written only while the row still holds `expected`, so an edit made meanwhile wins. Returns false
   * when the row changed or is gone.
   */
  replaceMediaTitleArt(
    mediaId: string,
    expected: { title: string; posterPath: string | null; backdropPath: string | null },
    next: { title: string; posterPath: string | null; backdropPath: string | null },
  ): Promise<boolean> {
    const [row] = this.core
      .select({ title: mediaItems.title, posterPath: mediaItems.posterPath, backdropPath: mediaItems.backdropPath })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaId))
      .limit(1)
      .all();
    const holds =
      !!row &&
      row.title === expected.title &&
      (row.posterPath ?? null) === expected.posterPath &&
      (row.backdropPath ?? null) === expected.backdropPath;
    logger.info({ mediaId, replaced: holds }, "replaceMediaTitleArt");
    if (!holds) return Promise.resolve(false);
    this.core
      .update(mediaItems)
      .set({ title: next.title, posterPath: next.posterPath, backdropPath: next.backdropPath, updatedAt: nowIso() })
      .where(eq(mediaItems.id, mediaId))
      .run();
    this.queueMediaUpsert(mediaId);
    return this.persist().then(() => true);
  }

  replaceMediaTrailers(mediaId: string, trailers: MediaTrailer[]) {
    const timestamp = nowIso();
    this.metadata.delete(mediaTrailers).where(eq(mediaTrailers.mediaId, mediaId)).run();
    trailers.forEach((trailer) => {
      this.metadata
        .insert(mediaTrailers)
        .values({
          id: randomUUID(),
          mediaId,
          provider: trailer.provider,
          key: trailer.key,
          name: trailer.name,
          language: trailer.language,
        })
        .run();
    });
    this.core.update(mediaItems).set({ updatedAt: timestamp }).where(eq(mediaItems.id, mediaId)).run();
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  /**
   * META-ART-01 migration: every title that still holds a catalog image path in any slot `listArtworkToCopy` lists
   * (poster, backdrop, season posters, cast photos, episode stills), in library order. One scan per table, so a
   * library of thousands of titles is listed without one call per title.
   */
  listMediaWithArtworkToCopy(): string[] {
    const catalogPath = (column: unknown) => sql`(${column} like '/%' and ${column} not like '//%')`;
    const ids = new Set<string>();
    const add = (rows: { mediaId: string | number }[]) => {
      for (const row of rows) ids.add(String(row.mediaId));
    };
    add(
      this.core
        .select({ mediaId: mediaItems.id })
        .from(mediaItems)
        .where(or(catalogPath(mediaItems.posterPath), catalogPath(mediaItems.backdropPath)))
        .all()
    );
    add(this.metadata.selectDistinct({ mediaId: mediaSeasons.mediaId }).from(mediaSeasons).where(catalogPath(mediaSeasons.posterPath)).all());
    add(this.metadata.selectDistinct({ mediaId: mediaEpisodes.mediaId }).from(mediaEpisodes).where(catalogPath(mediaEpisodes.stillPath)).all());
    add(
      this.metadata
        .selectDistinct({ mediaId: mediaRoles.mediaId })
        .from(mediaRoles)
        .innerJoin(people, eq(people.id, mediaRoles.personId))
        .where(catalogPath(people.profilePath))
        .all()
    );
    return [...ids];
  }

  /**
   * LIB-CAST-01: titles whose cast looks merged into one person by the old code (details without person ids
   * became catalog person 0, so every role matched one person): more roles than distinct people. This also matches an
   * actor the catalog credits twice; `refetchCollapsedCasts` fetches each title once, so that costs one fetch. The person
   * id 0 itself is not tested: a refetch may keep that row for one of the roles.
   */
  listMediaWithCollapsedCast(): string[] {
    return this.metadata
      .select({ mediaId: mediaRoles.mediaId })
      .from(mediaRoles)
      .groupBy(mediaRoles.mediaId)
      .having(sql`count(*) > count(distinct ${mediaRoles.personId})`)
      .all()
      .map((row) => row.mediaId);
  }

  /**
   * LIB-CREW-01 backfill: titles the catalog knows (a catalog id) that hold no crew at all, in a stable order. A title
   * with any stored crew (fetched, restored or edited by the user) is never listed, so the backfill cannot overwrite it.
   */
  listMediaMissingCrew(): string[] {
    const withCrew = new Set(
      this.metadata
        .selectDistinct({ mediaId: mediaCrew.mediaId })
        .from(mediaCrew)
        .all()
        .map((row) => String(row.mediaId))
    );
    return this.core
      .selectDistinct({ mediaId: mediaExternalIds.mediaId })
      .from(mediaExternalIds)
      .innerJoin(mediaItems, eq(mediaItems.id, mediaExternalIds.mediaId))
      .where(inArray(mediaExternalIds.source, CATALOG_ID_SOURCES))
      .orderBy(asc(mediaExternalIds.mediaId))
      .all()
      .map((row) => String(row.mediaId))
      .filter((mediaId) => !withCrew.has(mediaId));
  }

  getSetting(key: string) {
    const row = this.core
      .select({ value: appSettings.value, updatedAt: appSettings.updatedAt })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1)
      .all()[0];
    if (!row) return null;
    return { value: String(row.value), updatedAt: String(row.updatedAt) };
  }

  /**
   * `updatedAt` stamps the row and the op (default now): a profile settings seed passes the epoch so the profile's
   * real record wins when it arrives, however old (ACCT-SQUAD-03). The op's `createdAt` stays now.
   */
  setSetting(key: string, value: string, updatedAt?: string) {
    const createdAt = nowIso();
    const timestamp = updatedAt ?? createdAt;
    this.core
      .insert(appSettings)
      .values({ key, value, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: timestamp },
      })
      .run();
    void this.queueOp({
      id: randomUUID(),
      type: "setting.set",
      createdAt,
      payload: { key, value, updatedAt: timestamp },
    });
    // Resume points and a non-main profile's title progress move a title's watched state: never media-free.
    return this.persist({ mediaFree: !isPlaybackProgressSettingKey(key) });
  }

  /**
   * ACCT-SQUAD-02: the profile chosen on this device ("Who's watching?" on desktop). Viewing state reads and writes
   * follow it: the main profile's go to the library's own storage, any other profile's to its `p:<profileId>:` keys
   * (`packages/shared/src/profileViewing.ts`, the same keys phone and TV write). Device-local, never synced. A scope
   * change moves every title's progress, the playlists and the renderer snapshot's resume/track keys, so it is
   * published unattributed (the consumer refetches the whole snapshot).
   */
  setActiveProfile(profile: { id: string; isMain: boolean } | null) {
    const next = profile ? { id: profile.id, isMain: profile.isMain } : null;
    const scope = viewingScopeFor(next);
    const scopeChanged = scope.prefix !== this.viewingScope.prefix;
    this.activeProfile = next;
    this.viewingScope = scope;
    logger.info({ profileId: next?.id ?? null, isMain: next?.isMain ?? null, scopeChanged }, "library.profile.active");
    if (!scopeChanged) return false;
    return this.persist();
  }

  getActiveProfile(): { id: string; isMain: boolean } | null {
    return this.activeProfile;
  }

  private readSettingRows(prefix: string): Array<{ key: string; value: string | null }> {
    return this.core
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(prefix ? sql`${appSettings.key} LIKE ${`${prefix}%`}` : undefined)
      .all()
      .map((row) => ({ key: String(row.key), value: row.value === null ? null : String(row.value) }));
  }

  /** Upserts one `app_settings` row and queues its `setting.set` op (callers persist). */
  private writeSettingRow(key: string, value: string, updatedAt: string) {
    this.core
      .insert(appSettings)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } })
      .run();
    void this.queueOp({ id: randomUUID(), type: "setting.set", createdAt: updatedAt, payload: { key, value, updatedAt } });
  }

  /** A non-main profile's own progress by media id (`p:<pid>:media_progress_v1:`), or null for the main profile. */
  private readScopedMediaProgress(): Map<string, MediaProgress> | null {
    const scope = this.viewingScope;
    if (isMainScope(scope)) return null;
    return collectMediaProgress(scope, this.readSettingRows(scopedMediaProgressKey(scope, "")));
  }

  /** The active non-main profile's playlists (stored ones plus its default favorites/watchlist), or null on main. */
  private readScopedPlaylists(): ScopedPlaylist[] | null {
    const scope = this.viewingScope;
    if (isMainScope(scope)) return null;
    const liveMedia = new Set(
      this.core
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .all()
        .map((row) => String(row.id))
    );
    // Entries of a title deleted before the cleanup reached this device are not shown (mobile does the same).
    return listProfilePlaylists(scope, this.readSettingRows(scopedPlaylistKey(scope, ""))).map((playlist) => ({
      ...playlist,
      items: playlist.items.filter((item) => liveMedia.has(item.mediaId)),
    }));
  }

  private readScopedPlaylist(playlistId: string, now: string): ProfilePlaylist | null {
    const stored = this.getSetting(scopedPlaylistKey(this.viewingScope, playlistId));
    // Never written: the default favorites/watchlist. Written "" = deleted.
    if (!stored) return defaultProfilePlaylist(playlistId, now);
    return parseProfilePlaylist(stored.value);
  }

  /**
   * ACCT-PROF-02, a non-main profile was deleted: every one of its `p:<profileId>:` keys is overwritten with ""
   * (no delete op exists; the other devices follow with the ops). Returns how many keys were blanked.
   */
  wipeProfileViewing(profileId: string) {
    const now = nowIso();
    const keys = planProfileWipe(profileId, this.readSettingRows(`p:${profileId}:`));
    for (const key of keys) this.writeSettingRow(key, "", now);
    logger.info({ profileId, keys: keys.length }, "profiles.wipe");
    if (keys.length > 0) void this.persist();
    return keys.length;
  }

  /**
   * ACCT-PROF-02, the main profile was deleted: the oldest remaining profile (`newMainId`) becomes main, and main is
   * where a profile's data is stored, so its `p:<id>:` state replaces the deleted main profile's state in the
   * library's own storage (`planMainPromotion`, the same move phone and TV run). Every write is a normal op. The
   * marker and the new main's blanks go last, so a move cut short reruns whole (`healMainPromotion`). A finished move
   * (the marker already names `newMainId`) is never run again: heal and the delete flow can both reach here for one
   * delete, and a second run would clear the library's own storage, which by then holds the new main's state.
   */
  promoteProfileToMain(newMainId: string) {
    if (this.getSetting(MAIN_PROFILE_SETTING_KEY)?.value === newMainId) {
      logger.info({ newMainId }, "profiles.promote.already_done");
      return emptyPromotionPlan();
    }
    const playlistRows = this.core
      .select({ id: playlists.id, slug: playlists.slug, isSystem: playlists.isSystem })
      .from(playlists)
      .all();
    const itemRows = this.core
      .select({ playlistId: playlistItems.playlistId, mediaId: playlistItems.mediaId })
      .from(playlistItems)
      .all();
    const progressRows = this.core
      .select({ id: mediaItems.id, progressPct: mediaItems.progressPct, lastWatchedAt: mediaItems.lastWatchedAt })
      .from(mediaItems)
      .where(or(sql`${mediaItems.progressPct} > 0`, isNotNull(mediaItems.lastWatchedAt)))
      .all();
    const plan = planMainPromotion({
      newMainId,
      settingRows: this.readSettingRows(""),
      mainProgress: progressRows.map((row) => ({
        mediaId: String(row.id),
        progressPct: Number(row.progressPct) || 0,
        lastWatchedAt: row.lastWatchedAt ? String(row.lastWatchedAt) : null,
      })),
      mainPlaylists: playlistRows.map((row) => ({
        id: String(row.id),
        slug: row.slug ? String(row.slug) : null,
        isSystem: Boolean(row.isSystem),
        mediaIds: itemRows.filter((item) => String(item.playlistId) === String(row.id)).map((item) => String(item.mediaId)),
      })),
    });
    logger.info(
      {
        newMainId,
        settings: plan.settings.length,
        progress: plan.progress.length,
        playlistDeletes: plan.playlistDeletes.length,
        itemRemoves: plan.playlistItemRemoves.length,
        creates: plan.playlistCreates.length,
        itemAdds: plan.playlistItemAdds.length,
        finish: plan.finish.length,
      },
      "profiles.promote.plan"
    );
    const now = nowIso();
    for (const { key, value } of plan.settings) {
      // The new main's settings replace the deleted main's whole set, so a field merge elsewhere drops the old fields.
      this.writeSettingRow(key, isProfileSettingsKey(key) && value ? resetProfileSettingsValue(value, now) : value, now);
    }
    for (const entry of plan.progress) {
      this.core
        .update(mediaItems)
        .set({ progressPct: entry.progressPct, lastWatchedAt: entry.lastWatchedAt })
        .where(eq(mediaItems.id, entry.mediaId))
        .run();
      void this.queueOp({
        id: randomUUID(),
        type: "media.progress",
        createdAt: now,
        payload: { mediaId: entry.mediaId, progressPct: entry.progressPct, lastWatchedAt: entry.lastWatchedAt, updatedAt: now },
      });
    }
    for (const id of plan.playlistDeletes) {
      this.core.delete(playlists).where(eq(playlists.id, id)).run();
      void this.queueOp({ id: randomUUID(), type: "playlist.delete", createdAt: now, payload: { id } });
    }
    for (const { playlistId, mediaId } of plan.playlistItemRemoves) {
      this.core
        .delete(playlistItems)
        .where(and(eq(playlistItems.playlistId, playlistId), eq(playlistItems.mediaId, mediaId)))
        .run();
      void this.queueOp({ id: randomUUID(), type: "playlist.item.remove", createdAt: now, payload: { playlistId, mediaId } });
    }
    const adds = [...plan.playlistItemAdds];
    for (const created of plan.playlistCreates) {
      const id = systemPlaylistForSlug(created.slug)?.id ?? randomUUID(); // LIB-SYNC-10
      const row = { id, name: created.name, slug: created.slug, isSystem: created.isSystem, createdAt: now };
      this.core.insert(playlists).values(row).run();
      void this.queueOp({ id: randomUUID(), type: "playlist.create", createdAt: now, payload: { ...row } });
      for (const mediaId of created.mediaIds) adds.push({ playlistId: id, mediaId });
    }
    for (const { playlistId, mediaId } of adds) {
      const id = randomUUID();
      this.core.insert(playlistItems).values({ id, playlistId, mediaId, addedAt: now }).onConflictDoNothing().run();
      void this.queueOp({ id: randomUUID(), type: "playlist.item.add", createdAt: now, payload: { id, playlistId, mediaId, addedAt: now } });
    }
    for (const { key, value } of plan.finish) this.writeSettingRow(key, value, now);
    void this.persist();
    return plan;
  }

  /**
   * ACCT-PROF-02: finishes the move of a main profile whose promotion never completed (`needsMainPromotion`), e.g.
   * the deleting device went offline after the API delete. Call only on a library just synced with the server.
   * Returns whether a move ran.
   */
  /** ACCT-PROF-02: ids of the profiles holding viewing data under their own `p:<id>:` prefix (`viewingProfileIds`). */
  listViewingProfileIds() {
    return viewingProfileIds(this.readSettingRows("p:"));
  }

  healMainPromotion(mainId: string) {
    const marker = this.getSetting(MAIN_PROFILE_SETTING_KEY);
    const rows = [...this.readSettingRows(`p:${mainId}:`), ...(marker ? [{ key: MAIN_PROFILE_SETTING_KEY, value: marker.value }] : [])];
    if (!needsMainPromotion(mainId, rows)) return false;
    logger.info({ mainId, rows: rows.length }, "profiles.promote.heal");
    this.promoteProfileToMain(mainId);
    return true;
  }

  ensureDummyTemplate(manifest: {
    version: string;
    createdAt: string;
    videos: Array<{
      quality: string;
      codec: string;
      codecString?: string | null;
      bitrateKbps: number | null;
      sizeMb: number;
      chunkMap: {
        initKey: string;
        initSize: number;
        durationSeconds: number;
        totalSize: number;
        chunks: Array<{ key: string; size: number; startSeconds: number }>;
      };
      chapters: Array<{ title: string; startSeconds: number }>;
    }>;
    audio: Array<{
      language: string;
      label: string;
      codec: string;
      codecString?: string | null;
      bitrateKbps: number | null;
      isDefault?: boolean;
      chunkMap: {
        initKey: string;
        initSize: number;
        durationSeconds: number;
        totalSize: number;
        chunks: Array<{ key: string; size: number; startSeconds: number }>;
      };
    }>;
    subtitles: Array<{
      language: string;
      label: string;
      format: "srt" | "sup";
      objectKey: string;
      isDefault?: boolean;
    }>;
  }) {
    const signature = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const storedTemplateId = this.getSetting("dummy_template_id")?.value ?? null;
    const storedSignature = this.getSetting("dummy_template_signature")?.value ?? null;
    if (storedTemplateId && storedSignature === signature) {
      const existing = this.templates
        .select({ id: mediaTemplates.id })
        .from(mediaTemplates)
        .where(eq(mediaTemplates.id, storedTemplateId))
        .limit(1)
        .all()[0];
      if (existing?.id) {
        return Promise.resolve(String(existing.id));
      }
    }

    const templateId = randomUUID();
    const timestamp = nowIso();
    const upsertSetting = (key: string, value: string) => {
      this.core
        .insert(appSettings)
        .values({ key, value, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value, updatedAt: timestamp },
        })
        .run();
    };

    // Phase 3.6: was wrapped in `this.db.transaction(...)` — but the inserts
    // span the templates DB and (via upsertSetting) the core DB, so a
    // single-DB transaction couldn't atomically span both anyway. We split
    // the templates work into its own transaction and let the two trailing
    // `upsertSetting` calls commit through the core DB independently.
    this.templatesSqlite.transaction(() => {
      this.templates
        .insert(mediaTemplates)
        .values({
          id: templateId,
          name: "Dummy content",
          source: "dummy",
          signature,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();

      manifest.videos.forEach((video) => {
        const formatId = randomUUID();
        const sizeMb = Number.isFinite(Number(video.sizeMb)) ? Math.max(1, Math.round(video.sizeMb)) : 1;
        const bitrateKbps =
          video.bitrateKbps !== null && Number.isFinite(Number(video.bitrateKbps))
            ? Number(video.bitrateKbps)
            : null;
        const row = {
          id: formatId,
          templateId,
          quality: video.quality,
          codec: video.codec,
          codecString: video.codecString ?? null,
          bitrateKbps,
          initKey: video.chunkMap.initKey ?? null,
          initSize: Number.isFinite(Number(video.chunkMap.initSize)) ? Number(video.chunkMap.initSize) : null,
          durationSeconds: Number.isFinite(Number(video.chunkMap.durationSeconds))
            ? Number(video.chunkMap.durationSeconds)
            : null,
          totalSize: Number.isFinite(Number(video.chunkMap.totalSize)) ? Number(video.chunkMap.totalSize) : null,
          sizeMb,
        };
        validateDbRow("mediaTemplateFormats", row);
        this.templates.insert(mediaTemplateFormats).values(row).run();

        video.chunkMap.chunks.forEach((chunk, index) => {
          const chunkRow = {
            id: randomUUID(),
            formatId,
            chunkKey: chunk.key,
            orderIndex: index,
            sizeBytes: Number.isFinite(Number(chunk.size)) ? Number(chunk.size) : null,
            startSeconds: Number.isFinite(Number(chunk.startSeconds)) ? Number(chunk.startSeconds) : null,
          };
          validateDbRow("mediaTemplateFormatChunks", chunkRow);
          this.templates.insert(mediaTemplateFormatChunks).values(chunkRow).run();
        });

        video.chapters.forEach((chapter) => {
          const chapterRow = {
            id: randomUUID(),
            formatId,
            title: chapter.title,
            startSeconds: Number(chapter.startSeconds),
          };
          validateDbRow("mediaTemplateChapters", chapterRow);
          this.templates.insert(mediaTemplateChapters).values(chapterRow).run();
        });
      });

      manifest.audio.forEach((track) => {
        const trackId = randomUUID();
        const bitrateKbps =
          track.bitrateKbps !== null && Number.isFinite(Number(track.bitrateKbps))
            ? Number(track.bitrateKbps)
            : null;
        const row = {
          id: trackId,
          templateId,
          language: track.language,
          label: track.label,
          isDefault: Boolean(track.isDefault),
          source: "dummy",
          codec: track.codec,
          codecString: track.codecString ?? null,
          initKey: track.chunkMap.initKey ?? null,
          initSize: Number.isFinite(Number(track.chunkMap.initSize)) ? Number(track.chunkMap.initSize) : null,
          durationSeconds: Number.isFinite(Number(track.chunkMap.durationSeconds))
            ? Number(track.chunkMap.durationSeconds)
            : null,
          totalSize: Number.isFinite(Number(track.chunkMap.totalSize)) ? Number(track.chunkMap.totalSize) : null,
          createdAt: timestamp,
        };
        validateDbRow("mediaTemplateAudioTracks", row);
        this.templates.insert(mediaTemplateAudioTracks).values(row).run();

        track.chunkMap.chunks.forEach((chunk, index) => {
          const chunkRow = {
            id: randomUUID(),
            trackId,
            chunkKey: chunk.key,
            orderIndex: index,
            sizeBytes: Number.isFinite(Number(chunk.size)) ? Number(chunk.size) : null,
            startSeconds: Number.isFinite(Number(chunk.startSeconds)) ? Number(chunk.startSeconds) : null,
          };
          validateDbRow("mediaTemplateAudioChunks", chunkRow);
          this.templates.insert(mediaTemplateAudioChunks).values(chunkRow).run();
        });
      });

      manifest.subtitles.forEach((track) => {
        const row = {
          id: randomUUID(),
          templateId,
          language: track.language,
          label: track.label,
          objectKey: track.objectKey,
          format: track.format,
          isDefault: Boolean(track.isDefault),
          source: "dummy",
          createdAt: timestamp,
        };
        validateDbRow("mediaTemplateSubtitles", row);
        this.templates.insert(mediaTemplateSubtitles).values(row).run();
      });

      upsertSetting("dummy_template_id", templateId);
      upsertSetting("dummy_template_signature", signature);
    })();

    return this.persist().then(() => templateId);
  }

  setMediaFileTemplate(fileId: string, templateId: string | null) {
    this.metadata.update(mediaFiles).set({ templateId }).where(eq(mediaFiles.id, fileId)).run();
    return this.persist();
  }

  /**
   * LIB-EDIT-01: adds a named edition (cut) to a film (`season`/`episode` null) or an episode, with its length; files
   * join it through `linkFileToMedia(..., { editionId })`. The import does not name editions yet (INGS-EDIT-01): the
   * dev seed and tests make them. Returns the edition id.
   */
  addMediaEdition(
    mediaId: string,
    input: { name: string; durationSeconds?: number | null; season?: number | null; episode?: number | null }
  ): string {
    const id = randomUUID();
    this.metadata
      .insert(mediaEditions)
      .values({
        id,
        mediaId,
        season: normalizeOptionalNumber(input.season ?? null),
        episode: normalizeOptionalNumber(input.episode ?? null),
        name: input.name,
        nameUserSet: true,
        durationSeconds: input.durationSeconds ?? null,
        createdAt: nowIso(),
      })
      .run();
    this.queueMediaUpsert(mediaId);
    return id;
  }

  linkFileToMedia(
    mediaId: string,
    filename: string,
    season?: number | null,
    episode?: number | null,
    options?: { editionId?: string | null; originalSizeBytes?: number | null }
  ) {
    const fileId = randomUUID();
    const timestamp = nowIso();
    const seasonValue = normalizeOptionalNumber(season ?? null);
    const episodeValue = normalizeOptionalNumber(episode ?? null);

    // A file linked into a named edition replaces only that edition's files; otherwise every file of the slot.
    const targetEdition = options?.editionId ?? null;
    const existingFiles = this.metadata
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(
        and(
          seasonValue === null || episodeValue === null
            ? and(eq(mediaFiles.mediaId, mediaId), isNull(mediaFiles.season), isNull(mediaFiles.episode))
            : and(
                eq(mediaFiles.mediaId, mediaId),
                eq(mediaFiles.season, seasonValue),
                eq(mediaFiles.episode, episodeValue)
              ),
          targetEdition ? eq(mediaFiles.editionId, targetEdition) : undefined
        )
      )
      .all();

    existingFiles.forEach((row) => {
      const existingId = String(row.id);
      if (this.packedPlayback) {
        const sqlite = this.playbackSqlite;
        sqlite.prepare("DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_formats WHERE file_id = ?)").run(existingId);
        sqlite.prepare("DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_audio_tracks WHERE file_id = ?)").run(existingId);
        this.notePlaybackFileRemoved(mediaId, existingId);
      }
      this.playback.delete(mediaFormats).where(eq(mediaFormats.fileId, existingId)).run();
      this.playback.delete(mediaAudioTracks).where(eq(mediaAudioTracks.fileId, existingId)).run();
      this.playback.delete(mediaSubtitles).where(eq(mediaSubtitles.fileId, existingId)).run();
      this.metadata.delete(mediaFiles).where(eq(mediaFiles.id, existingId)).run();
    });

    // LIB-EDIT-01: a linked file belongs to its unit's unnamed edition until the import names editions (INGS-EDIT),
    // unless the caller names an edition made by addMediaEdition.
    const editionId = targetEdition ?? defaultEditionId(mediaId, seasonValue, episodeValue);
    if (!targetEdition) {
      this.metadata
        .insert(mediaEditions)
        .values({ id: editionId, mediaId, season: seasonValue, episode: episodeValue, name: "", nameUserSet: false, createdAt: timestamp })
        .onConflictDoNothing()
        .run();
    }
    this.metadata.insert(mediaFiles).values({
      id: fileId,
      mediaId,
      filename,
      season: seasonValue,
      episode: episodeValue,
      addedAt: timestamp,
      status: "local",
      editionId,
      originalSizeBytes: normalizeOptionalNumber(options?.originalSizeBytes ?? null),
    }).run();
    this.ensureEpisodeEntry(mediaId, seasonValue, episodeValue);
    // NOTE: hasFiles is intentionally NOT flipped here. Linking a file row is a
    // partial step — the source-ingest job's commit step is the only place that
    // marks media playable, via markMediaPlayable(mediaId). Coupling these used
    // to cause "delete cancelled job → movie became playable" because partial
    // file rows from a mid-flight monolithic ingest pre-flipped the flag.
    this.core.update(mediaItems).set({ updatedAt: timestamp }).where(eq(mediaItems.id, mediaId)).run();
    this.queueMediaUpsert(mediaId);
    return this.persist().then(() => fileId);
  }

  /**
   * Marks a media item as playable. Idempotent. This is the ONLY place outside
   * of the merge / backfill paths that should set hasFiles=true; callers are
   * the source-ingest job's commit step (after chunks are uploaded and the
   * library projection has been written) and equivalent commit paths in the
   * legacy lab-queue / headless / dummy-ingest flows.
   */
  markMediaPlayable(mediaId: string) {
    const timestamp = nowIso();
    this.core
      .update(mediaItems)
      .set({ hasFiles: true, updatedAt: timestamp })
      .where(eq(mediaItems.id, mediaId))
      .run();
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  /**
   * Returns true iff the media item has at least one media_files row joined to
   * a media_formats row. In this codebase media_formats is the video-format
   * table (audio is a separate media_audio_tracks table), so any media_formats
   * row implies a video-bearing file. Used by orphan-detection auto-delete.
   */
  mediaHasVideoFiles(mediaId: string): boolean {
    // Phase 3.6: cross-group join split — media_files lives in the metadata
    // DB while media_formats lives in the playback DB, so the single
    // innerJoin can no longer span both. We resolve the media's file IDs
    // first (metadata DB, indexed by media_id), then probe for any matching
    // format row (playback DB, indexed by file_id). Both lookups are O(log n).
    const fileIds = this.metadata
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaId, mediaId))
      .all()
      .map((row) => String(row.id));
    if (fileIds.length === 0) return false;
    const row = this.playback
      .select({ id: mediaFormats.id })
      .from(mediaFormats)
      .where(inArray(mediaFormats.fileId, fileIds))
      .limit(1)
      .all()[0];
    return Boolean(row);
  }

  /**
   * Removes uploaded chunk objects from storage. Thin wrapper over the
   * /storage/delete API; primarily used by callers that already have a list of
   * uploaded keys in hand and want to release them without going through
   * `deleteMedia` (e.g. mid-flight cleanup paths inside the library DB).
   *
   * The runtime-side cancellation pipeline (Layer 2 of the
   * storage-tracker-refactor; plan even-with-only-a-zesty-nest.md) is wired in
   * apps/runtime/src/modules/badger.ts via `releaseUploadedChunksForJob`,
   * which reads `job_state.json` directly and calls /storage/delete. That
   * path does NOT route through this helper because the runtime owns the
   * job-state file and the library DB does not.
   */
  async removeUploadedChunks(keys: string[]): Promise<void> {
    const filtered = keys.filter((key) => typeof key === "string" && key.length > 0);
    if (filtered.length === 0) return;
    if (!this.token) {
      console.warn(
        `[libraryDb] removeUploadedChunks: no token — pending deletes deferred for ${filtered.length} key(s)`
      );
      return;
    }
    try {
      await deleteStorageObjects(this.token, filtered);
    } catch (error) {
      console.warn(
        `[libraryDb] removeUploadedChunks failed for ${filtered.length} key(s):`,
        error
      );
    }
  }

  deleteMediaFile(fileId: string) {
    const row = this.metadata
      .select({ mediaId: mediaFiles.mediaId, season: mediaFiles.season, episode: mediaFiles.episode })
      .from(mediaFiles)
      .where(eq(mediaFiles.id, fileId))
      .get();
    if (!row) return this.persist();

    const mediaId = String(row.mediaId);
    const season = row.season === null ? null : Number(row.season);
    const episode = row.episode === null ? null : Number(row.episode);
    const episodeId = this.resolveEpisodeId(mediaId, season, episode);
    const scopeFilter = episodeId ? eq(mediaAudioTracks.episodeId, episodeId) : isNull(mediaAudioTracks.episodeId);
    const subtitleScopeFilter = episodeId ? eq(mediaSubtitles.episodeId, episodeId) : isNull(mediaSubtitles.episodeId);

    if (this.packedPlayback) {
      const sqlite = this.playbackSqlite;
      sqlite.prepare("DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_formats WHERE file_id = ?)").run(fileId);
      sqlite
        .prepare(
          `DELETE FROM media_chunk_lists WHERE owner_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ? AND ${episodeId ? "episode_id = ?" : "episode_id IS NULL"})`
        )
        .run(...(episodeId ? [mediaId, episodeId] : [mediaId]));
      this.notePlaybackFileRemoved(mediaId, fileId);
    }
    this.playback.delete(mediaFormats).where(eq(mediaFormats.fileId, fileId)).run();
    this.playback
      .delete(mediaAudioTracks)
      .where(and(eq(mediaAudioTracks.mediaId, mediaId), scopeFilter))
      .run();
    this.playback
      .delete(mediaSubtitles)
      .where(and(eq(mediaSubtitles.mediaId, mediaId), subtitleScopeFilter))
      .run();
    this.metadata.delete(mediaFiles).where(eq(mediaFiles.id, fileId)).run();

    // Phase 3.6: was a single SQL with cross-group EXISTS — media_items lives
    // in coreSqlite and media_files lives in metadataSqlite, so we can't use
    // a single statement. Two indexed queries + an in-process diff give the
    // same result.
    const mediaIdsWithFiles = new Set<string>(
      (this.metadataSqlite
        .prepare("SELECT DISTINCT media_id AS mediaId FROM media_files;")
        .all() as Array<{ mediaId?: string }>)
        .map((row) => String(row?.mediaId ?? ""))
        .filter((id) => id.length > 0)
    );
    const mediaIdRows = this.coreSqlite
      .prepare("SELECT id, has_files AS hasFiles FROM media_items;")
      .all() as Array<{ id?: string; hasFiles?: number }>;
    const toggleStmt = this.coreSqlite.prepare(
      "UPDATE media_items SET has_files = ? WHERE id = ?;"
    );
    for (const row of mediaIdRows) {
      const id = String(row?.id ?? "");
      if (!id) continue;
      const want = mediaIdsWithFiles.has(id) ? 1 : 0;
      if (Number(row?.hasFiles ?? 0) !== want) {
        toggleStmt.run(want, id);
      }
    }
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  private parseEpisodeResumeSetting(raw: string | null | undefined) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { progressPct?: number; updatedAt?: string };
      const value = Number(parsed.progressPct);
      if (!Number.isFinite(value)) return null;
      return {
        progressPct: Math.max(0, Math.min(100, value)),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } catch {
      return null;
    }
  }

  private readTvProgressStamp(): TvProgressStamp {
    const core = this.coreSqlite;
    const metadata = this.metadataSqlite;
    const coreProbe = core.prepare(FILE_CHANGE_PROBE_SQL).get() as { changes: number; version: number };
    const metadataProbe =
      metadata === core ? coreProbe : (metadata.prepare(FILE_CHANGE_PROBE_SQL).get() as { changes: number; version: number });
    return {
      core,
      metadata,
      coreChanges: coreProbe.changes,
      coreVersion: coreProbe.version,
      metadataChanges: metadataProbe.changes,
      metadataVersion: metadataProbe.version,
    };
  }

  /**
   * Drops every cached aggregate input unless the core + metadata files are
   * exactly as the last cached read or this instance's own tracked write
   * (noteEpisodeResumeWrite) left them. Detecting changes at the file level
   * means no write site (remote op apply, snapshot replace, episode replace,
   * setSetting, a foreign connection...) has to remember to invalidate.
   */
  private syncTvProgressStates() {
    const stamp = this.readTvProgressStamp();
    const last = this.tvProgressStamp;
    if (
      last &&
      last.core === stamp.core &&
      last.metadata === stamp.metadata &&
      last.coreChanges === stamp.coreChanges &&
      last.coreVersion === stamp.coreVersion &&
      last.metadataChanges === stamp.metadataChanges &&
      last.metadataVersion === stamp.metadataVersion
    ) {
      return;
    }
    this.tvProgressStates.clear();
    this.tvProgressStamp = stamp;
  }

  /**
   * Folds this instance's own episode-resume upsert into the cached
   * aggregates and re-stamps, so repeated saves of an already-cached episode
   * (every playback tick) neither invalidate nor re-read. Callers MUST have
   * run syncTvProgressStates before the write. A key the show's cached state
   * has not seen may be a new member: that state is dropped and rebuilt on
   * its next read.
   */
  private noteEpisodeResumeWrite(key: string, value: string) {
    const parsed = this.parseEpisodeResumeSetting(value);
    for (const [cacheKey, state] of this.tvProgressStates) {
      if (state === null) continue;
      if (parsed && state.resume.has(key)) state.resume.set(key, parsed);
      else this.tvProgressStates.delete(cacheKey);
    }
    this.adoptOwnCoreWrite();
  }

  /**
   * Re-stamps after this instance's own write to the core file. Only the core
   * connection's total_changes may have moved (that is the write itself); a
   * moved data_version (another connection committed in the gap) or any
   * metadata change means someone else wrote too, so nothing cached can be
   * trusted and everything is dropped. Callers MUST have run
   * syncTvProgressStates before their write.
   */
  private adoptOwnCoreWrite() {
    const before = this.tvProgressStamp;
    const after = this.readTvProgressStamp();
    if (
      !before ||
      before.core !== after.core ||
      before.metadata !== after.metadata ||
      before.coreVersion !== after.coreVersion ||
      before.metadataVersion !== after.metadataVersion ||
      before.metadataChanges !== after.metadataChanges
    ) {
      this.tvProgressStates.clear();
    }
    this.tvProgressStamp = after;
  }

  private loadTvProgressState(mediaId: string, scopePrefix: string): TvProgressState | null {
    const mediaRow = this.core
      .select({ totalEpisodes: mediaItems.totalEpisodes })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaId))
      .limit(1)
      .all()[0];
    const episodeRows = this.metadata
      .select({ id: mediaEpisodes.id, seasonNumber: mediaEpisodes.seasonNumber, airDate: mediaEpisodes.airDate })
      .from(mediaEpisodes)
      .where(eq(mediaEpisodes.mediaId, mediaId))
      .all();
    if (episodeRows.length === 0) return null;
    const settingKeys = episodeRows.map((row) => `${scopePrefix}${EPISODE_RESUME_KEY_PREFIX}${String(row.id)}`);
    const settingRows = this.core
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(inArray(appSettings.key, settingKeys))
      .all();
    const resume: TvProgressState["resume"] = new Map();
    for (const row of settingRows) {
      const parsed = this.parseEpisodeResumeSetting(row.value ? String(row.value) : null);
      if (parsed) resume.set(String(row.key), parsed);
    }
    const episodes = episodeRows.map((row) => ({ seasonNumber: Number(row.seasonNumber), airDate: row.airDate ? String(row.airDate) : null }));
    const seasonByKey = new Map(episodeRows.map((row, index) => [settingKeys[index], episodes[index].seasonNumber]));
    return { configuredTotalEpisodes: Number(mediaRow?.totalEpisodes), episodes, seasonByKey, resume };
  }

  /** A show's watched % in the active profile, from that profile's episode resume points. */
  private getTvProgressAggregate(mediaId: string) {
    this.syncTvProgressStates();
    // Cached per profile: the main profile's entry keeps the bare media id.
    const scopePrefix = this.viewingScope.prefix;
    const cacheKey = `${scopePrefix}${mediaId}`;
    let state = this.tvProgressStates.get(cacheKey);
    if (state === undefined) {
      state = this.loadTvProgressState(mediaId, scopePrefix);
      this.tvProgressStates.set(cacheKey, state);
    }
    if (state === null) return null;
    // LIB-PROG-01: out of every aired regular episode, never the episodes that happen to be in the vault.
    const total = showEpisodeTotal({ episodes: state.episodes, totalEpisodes: state.configuredTotalEpisodes, today: airDateToday() });
    if (!total) return null;
    let latestWatchedAt: string | null = null;
    const watched: { seasonNumber: number; progressPct: number }[] = [];
    for (const [key, parsed] of state.resume) {
      watched.push({ seasonNumber: state.seasonByKey.get(key) ?? 0, progressPct: parsed.progressPct });
      if (parsed.updatedAt && (!latestWatchedAt || parsed.updatedAt > latestWatchedAt)) {
        latestWatchedAt = parsed.updatedAt;
      }
    }
    const progressPct = showWatchedPct(watched, total.total);
    return { progressPct, lastWatchedAt: latestWatchedAt };
  }

  setProgress(
    mediaId: string,
    progressPct: number,
    episodeId?: string | null,
    // Phase 2 optional 4th arg: absolute positionSeconds + durationSeconds.
    // When supplied, they are persisted inside the episode_resume_v1 JSON
    // payload (additive — older readers ignore unknown fields). The
    // credits-aware completion check on the renderer prefers
    // positionSeconds when present; falls back to pct * duration otherwise.
    // `editionId`: the edition playing, on a title with two or more editions; its own resume spot is saved too
    // (PLAY-RESUME-05), and cleared once the edition is finished.
    timing?: { positionSeconds?: number | null; durationSeconds?: number | null; editionId?: string | null } | null,
  ) {
    const normalized = Math.max(0, Math.min(100, progressPct));
    const pct = normalized > 0 ? Math.max(0.0001, Math.round(normalized * 10000) / 10000) : 0;
    const timestamp = nowIso();
    const mediaTypeRow = this.core
      .select({ type: mediaItems.type })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaId))
      .limit(1)
      .all()[0];
    if (episodeId) {
      // The active profile's resume point: the main profile's own key, `p:<profileId>:` for any other (ACCT-SQUAD-02).
      const key = scopedEpisodeResumeKey(this.viewingScope, episodeId);
      // Phase 2 additive payload: include seconds when supplied + finite.
      // Older readers (parseEpisodeResumeSetting below, renderer
      // buildEpisodeResumeMap) ignore unknown keys, so old/new clients
      // interop cleanly.
      const positionSeconds =
        timing &&
        typeof timing.positionSeconds === "number" &&
        Number.isFinite(timing.positionSeconds) &&
        timing.positionSeconds >= 0
          ? timing.positionSeconds
          : null;
      const durationSeconds =
        timing &&
        typeof timing.durationSeconds === "number" &&
        Number.isFinite(timing.durationSeconds) &&
        timing.durationSeconds > 0
          ? timing.durationSeconds
          : null;
      const payload: Record<string, unknown> = { progressPct: pct, updatedAt: timestamp };
      if (positionSeconds !== null) payload.positionSeconds = positionSeconds;
      if (durationSeconds !== null) payload.durationSeconds = durationSeconds;
      const value = JSON.stringify(payload);
      this.syncTvProgressStates();
      this.core
        .insert(appSettings)
        .values({ key, value, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value, updatedAt: timestamp },
        })
        .run();
      this.noteEpisodeResumeWrite(key, value);
      void this.queueOp({
        id: randomUUID(),
        type: "setting.set",
        createdAt: timestamp,
        payload: { key, value, updatedAt: timestamp },
      });
    }
    if (timing?.editionId) {
      this.writeSettingRow(
        scopedEditionResumeKey(this.viewingScope, timing.editionId),
        editionResumeValue({
          progressPct: pct,
          updatedAt: timestamp,
          positionSeconds: timing.positionSeconds,
          durationSeconds: timing.durationSeconds,
        }),
        timestamp
      );
    }
    const isEpisodeScopedTv = Boolean(episodeId) && mediaTypeRow?.type === "tv";
    if (!isMainScope(this.viewingScope)) {
      // A non-main profile's title progress lives in its own key, never in media_items: the main profile's progress
      // stays as it was. A show's is its watched % over the profile's own episodes, as phone/TV write it.
      const aggregate = isEpisodeScopedTv ? this.getTvProgressAggregate(mediaId) : null;
      const progress = isEpisodeScopedTv
        ? { progressPct: aggregate?.progressPct ?? 0, lastWatchedAt: aggregate?.lastWatchedAt ?? timestamp }
        : { progressPct: pct, lastWatchedAt: timestamp };
      this.writeSettingRow(
        scopedMediaProgressKey(this.viewingScope, mediaId),
        buildMediaProgressValue({ ...progress, updatedAt: timestamp }),
        timestamp
      );
    } else if (isEpisodeScopedTv) {
      const aggregate = this.getTvProgressAggregate(mediaId);
      const aggregateProgress = aggregate?.progressPct ?? 0;
      const aggregateLastWatchedAt = aggregate?.lastWatchedAt ?? timestamp;

      this.core
        .update(mediaItems)
        .set({ progressPct: aggregateProgress, lastWatchedAt: aggregateLastWatchedAt })
        .where(eq(mediaItems.id, mediaId))
        .run();
      this.adoptOwnCoreWrite();
      void this.queueOp({
        id: randomUUID(),
        type: "media.progress",
        createdAt: timestamp,
        payload: {
          mediaId,
          progressPct: aggregateProgress,
          lastWatchedAt: aggregateLastWatchedAt,
          updatedAt: timestamp,
        },
      });
    } else {
      this.core
        .update(mediaItems)
        .set({ progressPct: pct, lastWatchedAt: timestamp })
        .where(eq(mediaItems.id, mediaId))
        .run();
      void this.queueOp({
        id: randomUUID(),
        type: "media.progress",
        createdAt: timestamp,
        payload: { mediaId, progressPct: pct, lastWatchedAt: timestamp, updatedAt: timestamp },
      });
    }
    this.noteMediaChanged(mediaId);
    return this.persist();
  }

  addMediaFormat(
    mediaId: string,
    fileId: string,
    quality: string,
    codec: string,
    sizeMb: number,
    chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> | string[],
    bitrateKbps: number | null,
    options: {
      codecString?: string | null;
      initKey?: string | null;
      initSize?: number | null;
      durationSeconds?: number | null;
      totalSize?: number | null;
      // True only when the caller is the source-job commit step writing the
      // source-extracted variant (highest available resolution). The
      // post-ingest replan_qualities handler reads this flag to refuse
      // deleting the only source row and to pick which format to stream from
      // when re-transcoding a missing quality. Defaults to false for every
      // other call site (fallback variant, format-job, retranscode upload).
      isSource?: boolean;
      // LIB-FMT-11: base64 16-byte seed the uploader derived the chunk keys from; sent only after `isPackedPlaybackLayout()`.
      chunkKeySeed?: string | null;
    } = {}
  ) {
    const normalizedSizeMb = Number.isFinite(sizeMb) ? Math.max(1, Math.round(sizeMb)) : 1;
    const normalizedBitrate =
      bitrateKbps !== null && Number.isFinite(Number(bitrateKbps)) ? Number(bitrateKbps) : null;
    const normalizedInitSize =
      options.initSize !== null && Number.isFinite(Number(options.initSize)) ? Number(options.initSize) : null;
    const normalizedDuration =
      options.durationSeconds !== null && Number.isFinite(Number(options.durationSeconds))
        ? Number(options.durationSeconds)
        : null;
    const normalizedTotalSize =
      options.totalSize !== null && Number.isFinite(Number(options.totalSize)) ? Number(options.totalSize) : null;
    const normalizedIsSource = options.isSource === true ? 1 : 0;
    const formatId = randomUUID();
    this.playback
      .insert(mediaFormats)
      .values(
        (() => {
          const row = {
            id: formatId,
            mediaId,
            fileId,
            quality,
            codec,
            bitrateKbps: normalizedBitrate,
            codecString: options.codecString ?? null,
            initKey: options.initKey ?? null,
            initSize: normalizedInitSize,
            durationSeconds: normalizedDuration,
            totalSize: normalizedTotalSize,
            sizeMb: normalizedSizeMb,
            isSource: normalizedIsSource,
          };
          validateDbRow("mediaFormats", row);
          return row;
        })()
      )
      .run();
    if (this.packedPlayback) {
      this.writePackedChunkList(formatId, CHUNK_LIST_OWNER_KIND.format, chunks, options.chunkKeySeed, nowIso());
      this.queueMediaUpsert(mediaId);
      return this.persist().then(() => formatId);
    }
    const entries: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> =
      typeof chunks[0] === "string"
        ? (chunks as string[]).map((key) => ({ key, sizeBytes: null, startSeconds: null }))
        : (chunks as Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }>);
    entries.forEach((entry, index) => {
      const normalizedSize =
        entry.sizeBytes !== null && Number.isFinite(Number(entry.sizeBytes)) ? Number(entry.sizeBytes) : null;
      const normalizedStart =
        entry.startSeconds !== null && Number.isFinite(Number(entry.startSeconds)) ? Number(entry.startSeconds) : null;
      const row = {
        id: randomUUID(),
        formatId,
        chunkKey: String(entry.key ?? ""),
        orderIndex: index,
        sizeBytes: normalizedSize,
        startSeconds: normalizedStart,
      };
      validateDbRow("mediaFormatChunks", row);
      this.playback
        .insert(mediaFormatChunks)
        .values(row)
        .onConflictDoNothing()
        .run();
    });
    this.queueMediaUpsert(mediaId);
    return this.persist().then(() => formatId);
  }

  /** A format's preview record (MPV-PREV-02), or null when the format is gone; a resumed preview run checks it. */
  getMediaFormatPreviewSheets(formatId: string): { previewSheets: MediaPreviewSheets | null } | null {
    const row = this.playback
      .select({ previewSheets: mediaFormats.previewSheets })
      .from(mediaFormats)
      .where(eq(mediaFormats.id, formatId))
      .limit(1)
      .all()[0];
    return row ? { previewSheets: parsePreviewSheets(row.previewSheets) } : null;
  }

  /**
   * Videos still owed seek-bar preview sheets (MPV-PREV-03): for every video file none of whose formats holds a
   * record, its source format, newest file first (`media_files.added_at`), minus `excludeFormatIds` (the runtime's
   * exhausted retries). The source format is the `is_source` row, or the highest quality when none is flagged: an
   * import that named no source quality flags no row and records its sheets on the first (highest) one, and synced
   * rows land unflagged until the next open's backfill (`backfillMissingIsSourceFlags`), which picks the same row.
   * Template-projected formats are never listed (they are not this library's source copy).
   */
  listPreviewSheetCandidates(input: { limit: number; excludeFormatIds: string[] }): PreviewSheetCandidate[] {
    const excluded = new Set(input.excludeFormatIds);
    const rows = this.playback
      .select({
        id: mediaFormats.id,
        mediaId: mediaFormats.mediaId,
        fileId: mediaFormats.fileId,
        quality: mediaFormats.quality,
        isSource: mediaFormats.isSource,
        previewSheets: mediaFormats.previewSheets,
        durationSeconds: mediaFormats.durationSeconds,
        initKey: mediaFormats.initKey,
      })
      .from(mediaFormats)
      .all();
    const rank = (row: (typeof rows)[number]) =>
      Number(row.isSource ?? 0) === 1 ? -1 : rankQualityForSourceBackfill(String(row.quality));
    const sourceByFile = new Map<string, (typeof rows)[number]>();
    const filesWithSheets = new Set<string>();
    for (const row of rows) {
      const fileId = String(row.fileId);
      if (row.previewSheets !== null && row.previewSheets !== undefined) filesWithSheets.add(fileId);
      const current = sourceByFile.get(fileId);
      if (!current || rank(row) < rank(current) || (rank(row) === rank(current) && String(row.id) < String(current.id))) {
        sourceByFile.set(fileId, row);
      }
    }
    const formats = Array.from(sourceByFile.entries())
      .filter(([fileId, row]) => !filesWithSheets.has(fileId) && !excluded.has(String(row.id)))
      .map(([, row]) => row);
    if (formats.length === 0) return [];
    const files = this.metadata
      .select({ id: mediaFiles.id, season: mediaFiles.season, episode: mediaFiles.episode, addedAt: mediaFiles.addedAt })
      .from(mediaFiles)
      .where(inArray(mediaFiles.id, Array.from(new Set(formats.map((row) => String(row.fileId))))))
      .all();
    const fileById = new Map(files.map((row) => [String(row.id), row]));
    const out: PreviewSheetCandidate[] = [];
    for (const row of formats) {
      const file = fileById.get(String(row.fileId));
      // A format whose file row is gone is no video of the library any more.
      if (!file) continue;
      out.push({
        formatId: String(row.id),
        mediaId: String(row.mediaId),
        fileId: String(row.fileId),
        season: file.season === null || file.season === undefined ? null : Number(file.season),
        episode: file.episode === null || file.episode === undefined ? null : Number(file.episode),
        addedAt: String(file.addedAt),
        durationSeconds: row.durationSeconds === null || row.durationSeconds === undefined ? null : Number(row.durationSeconds),
        initKey: row.initKey ? String(row.initKey) : null,
      });
    }
    out.sort((a, b) => (a.addedAt === b.addedAt ? a.formatId.localeCompare(b.formatId) : a.addedAt < b.addedAt ? 1 : -1));
    return out.slice(0, input.limit);
  }

  /**
   * Record the seek-bar preview sheets (MPV-PREV-02) on a committed source format; the runtime makes them after
   * the commit. False when the format is gone (media deleted or replaced meanwhile): the caller then releases the
   * sheets it uploaded.
   */
  setMediaFormatPreviewSheets(formatId: string, previews: MediaPreviewSheets) {
    const format = this.playback
      .select({ mediaId: mediaFormats.mediaId })
      .from(mediaFormats)
      .where(eq(mediaFormats.id, formatId))
      .limit(1)
      .all()[0];
    if (!format) return Promise.resolve(false);
    this.playback
      .update(mediaFormats)
      .set({ previewSheets: JSON.stringify(previews) })
      .where(eq(mediaFormats.id, formatId))
      .run();
    this.queueMediaUpsert(String(format.mediaId));
    return this.persist().then(() => true);
  }

  setMediaFormatChunks(
    formatId: string,
    chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> | string[],
    options: { chunkKeySeed?: string | null } = {}
  ) {
    if (isTemplateFormatId(formatId)) return this.persist();
    const formatRow = this.playback
      .select({ mediaId: mediaFormats.mediaId })
      .from(mediaFormats)
      .where(eq(mediaFormats.id, formatId))
      .limit(1)
      .all()[0];
    if (this.packedPlayback) {
      this.writePackedChunkList(formatId, CHUNK_LIST_OWNER_KIND.format, chunks, options.chunkKeySeed, nowIso());
      if (formatRow?.mediaId) this.queueMediaUpsert(String(formatRow.mediaId));
      return this.persist();
    }
    this.playback.delete(mediaFormatChunks).where(eq(mediaFormatChunks.formatId, formatId)).run();
    const entries: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> =
      typeof chunks[0] === "string"
        ? (chunks as string[]).map((key) => ({ key, sizeBytes: null, startSeconds: null }))
        : (chunks as Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }>);
    entries.forEach((entry, index) => {
      const normalizedSize =
        entry.sizeBytes !== null && Number.isFinite(Number(entry.sizeBytes)) ? Number(entry.sizeBytes) : null;
      const normalizedStart =
        entry.startSeconds !== null && Number.isFinite(Number(entry.startSeconds)) ? Number(entry.startSeconds) : null;
      const row = {
        id: randomUUID(),
        formatId,
        chunkKey: String(entry.key ?? ""),
        orderIndex: index,
        sizeBytes: normalizedSize,
        startSeconds: normalizedStart,
      };
      validateDbRow("mediaFormatChunks", row);
      this.playback
        .insert(mediaFormatChunks)
        .values(row)
        .onConflictDoNothing()
        .run();
    });
    if (formatRow?.mediaId) {
      this.queueMediaUpsert(String(formatRow.mediaId));
    }
    return this.persist();
  }

  removeMediaFormat(formatId: string) {
    if (isTemplateFormatId(formatId)) return this.persist();
    const formatRow = this.playback
      .select({ mediaId: mediaFormats.mediaId })
      .from(mediaFormats)
      .where(eq(mediaFormats.id, formatId))
      .limit(1)
      .all()[0];
    this.playback.delete(mediaFormats).where(eq(mediaFormats.id, formatId)).run();
    if (this.packedPlayback) this.playbackSqlite.prepare("DELETE FROM media_chunk_lists WHERE owner_id = ?").run(formatId);
    if (formatRow?.mediaId) {
      this.queueMediaUpsert(String(formatRow.mediaId));
    }
    return this.persist();
  }

  setMediaFileDesiredFormats(fileId: string, formats: Array<{ quality: string; codec: string; bitrateKbps?: number | null }>) {
    const mediaRow = this.metadata
      .select({ mediaId: mediaFiles.mediaId })
      .from(mediaFiles)
      .where(eq(mediaFiles.id, fileId))
      .limit(1)
      .all()[0];
    if (!mediaRow) return this.persist();
    const mediaId = String(mediaRow.mediaId);
    this.metadata.delete(mediaFileDesiredFormats).where(eq(mediaFileDesiredFormats.fileId, fileId)).run();
    formats.forEach((format) => {
      if (!format.quality || !format.codec) return;
      const row = {
        id: randomUUID(),
        mediaId,
        fileId,
        quality: format.quality,
        codec: format.codec,
        bitrateKbps: format.bitrateKbps ?? null,
      };
      validateDbRow("mediaFileDesiredFormats", row);
      this.metadata
        .insert(mediaFileDesiredFormats)
        .values(row)
        .onConflictDoNothing()
        .run();
    });
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  private ensureSeasonEntry(mediaId: string, seasonNumber: number) {
    const existing = this.metadata
      .select({ id: mediaSeasons.id })
      .from(mediaSeasons)
      .where(and(eq(mediaSeasons.mediaId, mediaId), eq(mediaSeasons.seasonNumber, seasonNumber)))
      .limit(1)
      .all()[0];
    if (existing?.id) return String(existing.id);
    const seasonId = randomUUID();
    const row = {
      id: seasonId,
      mediaId,
      seasonNumber,
      title: `Season ${seasonNumber}`,
      overview: null,
      posterPath: null,
      episodeCount: null,
      airDate: null,
    };
    validateDbRow("mediaSeasons", row);
    this.metadata.insert(mediaSeasons).values(row).run();
    return seasonId;
  }

  private ensureEpisodeEntry(mediaId: string, season?: number | null, episode?: number | null) {
    const normalizedSeason = normalizeOptionalNumber(season ?? null);
    const normalizedEpisode = normalizeOptionalNumber(episode ?? null);
    if (normalizedSeason === null || normalizedEpisode === null) {
      return null;
    }
    const seasonNumber = normalizedSeason;
    const episodeNumber = normalizedEpisode;
    const existing = this.metadata
      .select({ id: mediaEpisodes.id })
      .from(mediaEpisodes)
      .where(
        and(
          eq(mediaEpisodes.mediaId, mediaId),
          eq(mediaEpisodes.seasonNumber, seasonNumber),
          eq(mediaEpisodes.episodeNumber, episodeNumber)
        )
      )
      .limit(1)
      .all()[0];
    if (existing?.id) return String(existing.id);
    this.ensureSeasonEntry(mediaId, seasonNumber);
    const episodeId = randomUUID();
    const row = {
      id: episodeId,
      mediaId,
      seasonNumber,
      episodeNumber,
      title: `Episode ${episodeNumber}`,
      overview: null,
      stillPath: null,
      airDate: null,
    };
    validateDbRow("mediaEpisodes", row);
    this.metadata.insert(mediaEpisodes).values(row).run();
    this.queueMediaUpsert(mediaId);
    return episodeId;
  }

  resolveEpisodeId(mediaId: string, season?: number | null, episode?: number | null) {
    const normalizedSeason = normalizeOptionalNumber(season ?? null);
    const normalizedEpisode = normalizeOptionalNumber(episode ?? null);
    if (normalizedSeason === null || normalizedEpisode === null) {
      return null;
    }
    const row = this.metadata
      .select({ id: mediaEpisodes.id })
      .from(mediaEpisodes)
      .where(
        and(
          eq(mediaEpisodes.mediaId, mediaId),
          eq(mediaEpisodes.seasonNumber, normalizedSeason),
          eq(mediaEpisodes.episodeNumber, normalizedEpisode)
        )
      )
      .limit(1)
      .all()[0];
    return row?.id ? String(row.id) : null;
  }

  /**
   * List all episode rows for a show, returning a `{ "<season>:<episode>" →
   * episodeId }` map. Used by the ingest commit pipeline to back-fill
   * skip-marker rows for previously-imported episodes of the same show when
   * a new file from that show is committed.
   */
  listEpisodeIdsByKey(mediaId: string): Map<string, string> {
    const rows = this.metadata
      .select({
        id: mediaEpisodes.id,
        seasonNumber: mediaEpisodes.seasonNumber,
        episodeNumber: mediaEpisodes.episodeNumber,
      })
      .from(mediaEpisodes)
      .where(eq(mediaEpisodes.mediaId, mediaId))
      .all();
    const out = new Map<string, string>();
    for (const row of rows) {
      const season = Number(row.seasonNumber);
      const episode = Number(row.episodeNumber);
      if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
      out.set(`${season}:${episode}`, String(row.id));
    }
    return out;
  }

  addAudioTracksForFile(
    mediaId: string,
    fileId: string,
    season: number | null,
    episode: number | null,
    tracks: Array<{ language: string; label: string }>,
    defaultLanguage?: string | null
  ) {
    if (!tracks.length) return this.persist();
    const episodeId = this.ensureEpisodeEntry(mediaId, season, episode);
    const targetLanguage = defaultLanguage?.trim() || tracks[0].language;
    const defaultIndex = Math.max(0, tracks.findIndex((track) => track.language === targetLanguage));
    const scopeFilter = episodeId ? eq(mediaAudioTracks.episodeId, episodeId) : isNull(mediaAudioTracks.episodeId);

    this.playback
      .update(mediaAudioTracks)
      .set({ isDefault: false })
      .where(and(eq(mediaAudioTracks.mediaId, mediaId), scopeFilter))
      .run();

    const timestamp = nowIso();
    tracks.forEach((track, index) => {
      const row = {
        id: randomUUID(),
        mediaId,
        fileId,
        episodeId,
        language: track.language,
        label: track.label,
        isDefault: index === defaultIndex,
        source: "embedded",
        createdAt: timestamp,
      };
      validateDbRow("mediaAudioTracks", row);
      this.playback.insert(mediaAudioTracks).values(row).run();
    });
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  addAudioTrackWithChunks(input: {
    mediaId: string;
    fileId: string;
    season: number | null;
    episode: number | null;
    language: string;
    label: string;
    codec: string | null;
    codecString?: string | null;
    initKey: string | null;
    initSize: number | null;
    durationSeconds: number | null;
    totalSize: number | null;
    chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }>;
    isDefault?: boolean;
    source?: string;
    // LIB-FMT-11: base64 16-byte seed the uploader derived the chunk keys from; sent only after `isPackedPlaybackLayout()`.
    chunkKeySeed?: string | null;
  }) {
    const episodeId = this.ensureEpisodeEntry(input.mediaId, input.season, input.episode);
    const trackId = randomUUID();
    const timestamp = nowIso();
    const normalizedInitSize =
      input.initSize !== null && Number.isFinite(Number(input.initSize)) ? Number(input.initSize) : null;
    const normalizedDuration =
      input.durationSeconds !== null && Number.isFinite(Number(input.durationSeconds))
        ? Number(input.durationSeconds)
        : null;
    const normalizedTotalSize =
      input.totalSize !== null && Number.isFinite(Number(input.totalSize)) ? Number(input.totalSize) : null;
      const row = {
        id: trackId,
        mediaId: input.mediaId,
        fileId: input.fileId,
        episodeId,
        language: String(input.language ?? ""),
        label: String(input.label ?? ""),
        isDefault: Boolean(input.isDefault),
        source: input.source ?? "dummy",
        codec: input.codec ?? null,
        codecString: input.codecString ?? null,
      initKey: input.initKey,
      initSize: normalizedInitSize,
      durationSeconds: normalizedDuration,
      totalSize: normalizedTotalSize,
      createdAt: timestamp,
    };
    validateDbRow("mediaAudioTracks", row);
    this.playback.insert(mediaAudioTracks).values(row).run();
    if (this.packedPlayback) {
      this.writePackedChunkList(trackId, CHUNK_LIST_OWNER_KIND.audioTrack, input.chunks, input.chunkKeySeed, timestamp);
      this.queueMediaUpsert(input.mediaId);
      return this.persist();
    }
    input.chunks.forEach((entry, index) => {
      const normalizedSize =
        entry.sizeBytes !== null && Number.isFinite(Number(entry.sizeBytes)) ? Number(entry.sizeBytes) : null;
      const normalizedStart =
        entry.startSeconds !== null && Number.isFinite(Number(entry.startSeconds)) ? Number(entry.startSeconds) : null;
      const chunkRow = {
        id: randomUUID(),
        trackId,
        chunkKey: String(entry.key ?? ""),
        orderIndex: index,
        sizeBytes: normalizedSize,
        startSeconds: normalizedStart,
      };
      validateDbRow("mediaAudioChunks", chunkRow);
      this.playback
        .insert(mediaAudioChunks)
        .values(chunkRow)
        .run();
    });
    this.queueMediaUpsert(input.mediaId);
    return this.persist();
  }

  addSubtitleTracksForFile(
    mediaId: string,
    fileId: string,
    season: number | null,
    episode: number | null,
    tracks: Array<{ language: string; label: string }>,
    defaultLanguage?: string | null
  ) {
    if (!tracks.length) return this.persist();
    const episodeId = this.ensureEpisodeEntry(mediaId, season, episode);
    const targetLanguage = defaultLanguage?.trim() || tracks[0].language;
    const defaultIndex = Math.max(0, tracks.findIndex((track) => track.language === targetLanguage));
    const scopeFilter = episodeId ? eq(mediaSubtitles.episodeId, episodeId) : isNull(mediaSubtitles.episodeId);

    this.playback
      .update(mediaSubtitles)
      .set({ isDefault: false })
      .where(and(eq(mediaSubtitles.mediaId, mediaId), scopeFilter))
      .run();

    const timestamp = nowIso();
    tracks.forEach((track, index) => {
      const row = {
        id: randomUUID(),
        mediaId,
        fileId,
        episodeId,
        language: track.language,
        label: track.label,
        objectKey: null,
        format: null,
        isDefault: index === defaultIndex,
        source: "embedded",
        createdAt: timestamp,
      };
      validateDbRow("mediaSubtitles", row);
      this.playback.insert(mediaSubtitles).values(row).run();
    });
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  addSubtitleTrackWithObject(input: {
    mediaId: string;
    fileId: string;
    season: number | null;
    episode: number | null;
    language: string;
    label: string;
    objectKey: string;
    format?: string | null;
    isDefault?: boolean;
    source?: string;
    /** Caller-chosen row id, so a following OCR twin can name this row (PLAY-TRACK-05). */
    id?: string;
  }) {
    const episodeId = this.ensureEpisodeEntry(input.mediaId, input.season, input.episode);
    const timestamp = nowIso();
    const row = {
      id: input.id ?? randomUUID(),
      mediaId: input.mediaId,
      fileId: input.fileId,
      episodeId,
      language: String(input.language ?? ""),
      label: String(input.label ?? ""),
      objectKey: String(input.objectKey ?? ""),
      format: input.format ?? null,
      isDefault: Boolean(input.isDefault),
      source: input.source ?? "dummy",
      createdAt: timestamp,
    };
    validateDbRow("mediaSubtitles", row);
    this.playback.insert(mediaSubtitles).values(row).run();
    this.queueMediaUpsert(input.mediaId);
    return this.persist();
  }

  /**
   * Picture subtitle rows (PGS / VobSub / DVB) that still need an OCR text
   * twin (PLAY-TRACK-05): stored object, not themselves OCR output, no twin
   * yet, and no failed attempt still inside its retry window. Oldest first so
   * the catch-up pass works through the library in a stable order.
   */
  listSubtitleOcrCandidates(input: {
    limit: number;
    /** Attempts with status `failed` older than this ISO time are retried. */
    failedRetryBefore: string;
    /** Attempts with status `no_text` older than this ISO time are retried. */
    noTextRetryBefore: string;
  }): SubtitleOcrCandidate[] {
    const twinRows = this.playback
      .select({ derivedFrom: mediaSubtitles.derivedFromSubtitleId })
      .from(mediaSubtitles)
      .where(isNotNull(mediaSubtitles.derivedFromSubtitleId))
      .all();
    const twinned = new Set(twinRows.map((row) => String(row.derivedFrom)));
    const attemptRows = this.templates.select().from(subtitleOcrAttempts).all();
    const attemptsById = new Map(attemptRows.map((row) => [String(row.subtitleId), row]));
    const pictureRows = this.playback
      .select({
        id: mediaSubtitles.id,
        mediaId: mediaSubtitles.mediaId,
        fileId: mediaSubtitles.fileId,
        episodeId: mediaSubtitles.episodeId,
        language: mediaSubtitles.language,
        label: mediaSubtitles.label,
        objectKey: mediaSubtitles.objectKey,
        format: mediaSubtitles.format,
        source: mediaSubtitles.source,
      })
      .from(mediaSubtitles)
      .where(
        and(
          inArray(sql`lower(${mediaSubtitles.format})`, [...PICTURE_SUBTITLE_FORMATS]),
          isNotNull(mediaSubtitles.objectKey),
          sql`${mediaSubtitles.objectKey} <> ''`,
          sql`${mediaSubtitles.source} <> 'ocr'`
        )
      )
      .orderBy(asc(mediaSubtitles.createdAt), asc(mediaSubtitles.id))
      .all();
    const out: SubtitleOcrCandidate[] = [];
    for (const row of pictureRows) {
      if (out.length >= input.limit) break;
      const id = String(row.id);
      if (twinned.has(id)) continue;
      const attempt = attemptsById.get(id);
      if (attempt) {
        const retryBefore = attempt.status === "no_text" ? input.noTextRetryBefore : input.failedRetryBefore;
        if (String(attempt.lastAttemptAt) > retryBefore) continue;
      }
      out.push({
        id,
        mediaId: String(row.mediaId),
        fileId: row.fileId ? String(row.fileId) : null,
        episodeId: row.episodeId ? String(row.episodeId) : null,
        language: String(row.language),
        label: String(row.label),
        objectKey: String(row.objectKey),
        format: String(row.format).toLowerCase(),
        attempts: attempt ? Number(attempt.attempts) : 0,
      });
    }
    return out;
  }

  /**
   * Store the OCR text twin of one picture subtitle row (PLAY-TRACK-05): same
   * media / file / episode / language / label, `format: "srt"`,
   * `source: "ocr"`, never default, linked by `derived_from_subtitle_id`.
   * Idempotent: a picture row that already has a twin keeps it. Clears the
   * row's attempt bookkeeping. Syncs through the usual media upsert.
   */
  addOcrSubtitleTwin(input: { pictureSubtitleId: string; objectKey: string }): AddOcrSubtitleTwinResult {
    const picture = this.playback
      .select()
      .from(mediaSubtitles)
      .where(eq(mediaSubtitles.id, input.pictureSubtitleId))
      .limit(1)
      .all()[0];
    if (!picture) return { created: false, reason: "picture_missing", id: null };
    const existing = this.playback
      .select({ id: mediaSubtitles.id })
      .from(mediaSubtitles)
      .where(eq(mediaSubtitles.derivedFromSubtitleId, input.pictureSubtitleId))
      .limit(1)
      .all()[0];
    this.templates.delete(subtitleOcrAttempts).where(eq(subtitleOcrAttempts.subtitleId, input.pictureSubtitleId)).run();
    if (existing) return { created: false, reason: "twin_exists", id: String(existing.id) };
    const row = {
      id: randomUUID(),
      mediaId: String(picture.mediaId),
      fileId: picture.fileId,
      episodeId: picture.episodeId,
      language: String(picture.language),
      label: String(picture.label),
      objectKey: String(input.objectKey),
      format: "srt",
      isDefault: false,
      source: "ocr",
      createdAt: nowIso(),
      derivedFromSubtitleId: input.pictureSubtitleId,
    };
    validateDbRow("mediaSubtitles", row);
    this.playback.insert(mediaSubtitles).values(row).run();
    this.queueMediaUpsert(row.mediaId);
    void this.persist();
    return { created: true as const, reason: null, id: row.id };
  }

  /**
   * Note one OCR attempt that produced no twin (local-only, never synced, no
   * library version bump): `failed` (decode / OCR / upload error) or
   * `no_text` (the track holds no readable picture). The catch-up pass waits
   * out a retry window per status.
   */
  recordSubtitleOcrAttempt(input: {
    subtitleId: string;
    mediaId: string;
    status: "failed" | "no_text";
    error?: string | null;
  }) {
    const now = nowIso();
    const lastError = input.error ? String(input.error).slice(0, 2000) : null;
    this.templates
      .insert(subtitleOcrAttempts)
      .values({
        subtitleId: input.subtitleId,
        mediaId: input.mediaId,
        status: input.status,
        attempts: 1,
        lastError,
        lastAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: subtitleOcrAttempts.subtitleId,
        set: {
          mediaId: input.mediaId,
          status: input.status,
          attempts: sql`${subtitleOcrAttempts.attempts} + 1`,
          lastError,
          lastAttemptAt: now,
        },
      })
      .run();
    const row = this.templates
      .select({ attempts: subtitleOcrAttempts.attempts })
      .from(subtitleOcrAttempts)
      .where(eq(subtitleOcrAttempts.subtitleId, input.subtitleId))
      .all()[0];
    return { attempts: row ? Number(row.attempts) : 1 };
  }

  addChaptersForFormat(formatId: string, chapters: Array<{ title: string; startSeconds: number }>) {
    if (isTemplateFormatId(formatId)) return this.persist();
    if (!chapters.length) return this.persist();
    const formatRow = this.playback
      .select({ mediaId: mediaFormats.mediaId })
      .from(mediaFormats)
      .where(eq(mediaFormats.id, formatId))
      .limit(1)
      .all()[0];
    chapters.forEach((chapter) => {
      const normalizedStart = Number.isFinite(Number(chapter.startSeconds))
        ? Number(chapter.startSeconds)
        : null;
      if (normalizedStart === null) return;
      const row = {
        id: randomUUID(),
        formatId,
        title: String(chapter.title ?? ""),
        startSeconds: normalizedStart,
      };
      validateDbRow("mediaChapters", row);
      this.playback.insert(mediaChapters).values(row).run();
    });
    if (formatRow?.mediaId) {
      this.queueMediaUpsert(String(formatRow.mediaId));
    }
    return this.persist();
  }

  replaceSkipMarkers(
    mediaId: string,
    episodeId: string | null,
    markers: Array<{
      type: MediaSkipMarkerType;
      startSeconds: number;
      endSeconds: number;
      source: string;
      confidence?: number | null;
    }>
  ) {
    const scopeFilter = episodeId ? eq(mediaSkipMarkers.episodeId, episodeId) : isNull(mediaSkipMarkers.episodeId);
    this.metadata
      .delete(mediaSkipMarkers)
      .where(and(eq(mediaSkipMarkers.mediaId, mediaId), scopeFilter))
      .run();
    const timestamp = nowIso();
    markers.forEach((marker) => {
      const normalizedStart = Number(marker.startSeconds);
      const normalizedEnd = Number(marker.endSeconds);
      if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd) || normalizedEnd <= normalizedStart) {
        return;
      }
      const row = {
        id: randomUUID(),
        mediaId,
        episodeId,
        type: String(marker.type ?? ""),
        startSeconds: normalizedStart,
        endSeconds: normalizedEnd,
        source: String(marker.source ?? "internal"),
        confidence: normalizeOptionalNumber(marker.confidence),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      validateDbRow("mediaSkipMarkers", row);
      this.metadata.insert(mediaSkipMarkers).values(row).run();
    });
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  // -------------------------------------------------------------------------
  // media_local_downloads — per-device offline saved files (Phase 2 of the
  // let-s-talk-about-offline plan).
  //
  // Local-only (library storage format) —
  // NO op-stream sync (`queueMediaUpsert` deliberately omitted), NO version
  // bump (`persist()` deliberately omitted). The renderer hydrates via
  // `badger.offline.list_local`; getSnapshot() does not traverse this table.
  //
  // The runtime is the only writer — the desktop renderer goes through
  // `badger.offline.*` commands, not direct `library-db-call` writes.
  // -------------------------------------------------------------------------

  /**
   * Record one just-completed offline save. The runtime's offlineDownload step calls this only after every piece
   * and the item manifest (`localPath`) are in place (OFFL-SAFE-01), so the row only exists for a complete copy.
   *
   * `schemaVersion` 2 = sealed pieces (OFFL-FILE-03, `container` "pieces", `localPath` = item manifest); 1 = the plain
   * MKV/MP4 older desktop builds saved, kept only until the upgrade re-saves it (OFFL-MIGR-01). A row for the same
   * file is replaced (UNIQUE file_id), which is how that re-save swaps the old row for the new one in one write.
   */
  registerLocalDownload(input: {
    id: string;
    fileId: string;
    mediaId: string;
    quality: string;
    formatId: string;
    container: string;
    localPath: string;
    totalBytes: number;
    downloadedAt: string;
    runtimeJobId: string | null;
    schemaVersion?: number;
  }) {
    const row = {
      id: String(input.id),
      fileId: String(input.fileId),
      mediaId: String(input.mediaId),
      quality: String(input.quality),
      formatId: String(input.formatId),
      container: String(input.container),
      localPath: String(input.localPath),
      totalBytes: Math.max(0, Math.trunc(Number(input.totalBytes))),
      downloadedAt: String(input.downloadedAt),
      lastVerifiedAt: null as string | null,
      runtimeJobId: input.runtimeJobId === null ? null : String(input.runtimeJobId),
      schemaVersion: Math.trunc(Number(input.schemaVersion ?? 1)),
    };
    const { fileId: _fileId, ...update } = row;
    this.playback
      .insert(mediaLocalDownloads)
      .values(row)
      .onConflictDoUpdate({ target: mediaLocalDownloads.fileId, set: update })
      .run();
    return { inserted: 1 };
  }

  /**
   * Drop matching rows for a scope (whole media / single file id / multiple
   * files). Returns the number of rows actually deleted so the caller can
   * report `deleted` back to the renderer. NO version bump — local-only.
   *
   * The on-disk file unlink is the runtime handler's responsibility; this
   * method only touches the SQLite row.
   */
  dropLocalDownloads(scope:
    | { type: "media"; mediaId: string }
    | { type: "file"; fileId: string }
    | { type: "files"; fileIds: string[] }
  ): { deleted: number } {
    // Drizzle SQLite's `.run()` returns void on the wrapper level — we
    // can't read `changes` directly off the result. Instead, count the
    // pre-existing matches via a SELECT, then issue the DELETE. The two
    // statements run on the same connection and (because we're not inside
    // an explicit BEGIN) operate on stable snapshots in practice; the
    // count is a UI hint (the renderer surfaces it in a toast), not a
    // correctness contract, so a sub-millisecond race is acceptable.
    if (scope.type === "files") {
      const ids = scope.fileIds.map((id) => String(id)).filter((id) => id.length > 0);
      if (ids.length === 0) return { deleted: 0 };
      const preCount = this.playback
        .select({ id: mediaLocalDownloads.id })
        .from(mediaLocalDownloads)
        .where(inArray(mediaLocalDownloads.fileId, ids))
        .all()
        .length;
      this.playback
        .delete(mediaLocalDownloads)
        .where(inArray(mediaLocalDownloads.fileId, ids))
        .run();
      return { deleted: preCount };
    }
    if (scope.type === "file") {
      const preCount = this.playback
        .select({ id: mediaLocalDownloads.id })
        .from(mediaLocalDownloads)
        .where(eq(mediaLocalDownloads.fileId, String(scope.fileId)))
        .all()
        .length;
      this.playback
        .delete(mediaLocalDownloads)
        .where(eq(mediaLocalDownloads.fileId, String(scope.fileId)))
        .run();
      return { deleted: preCount };
    }
    const preCount = this.playback
      .select({ id: mediaLocalDownloads.id })
      .from(mediaLocalDownloads)
      .where(eq(mediaLocalDownloads.mediaId, String(scope.mediaId)))
      .all()
      .length;
    this.playback
      .delete(mediaLocalDownloads)
      .where(eq(mediaLocalDownloads.mediaId, String(scope.mediaId)))
      .run();
    return { deleted: preCount };
  }

  /**
   * List offline-download rows, optionally filtered to a set of mediaIds.
   * The renderer uses this to hydrate Saved-offline badges on the dashboard
   * / library / media-modal surfaces.
   */
  listLocalDownloads(mediaIds?: string[]): Array<{
    id: string;
    fileId: string;
    mediaId: string;
    quality: string;
    formatId: string;
    container: string;
    localPath: string;
    totalBytes: number;
    downloadedAt: string;
    lastVerifiedAt: string | null;
    runtimeJobId: string | null;
    /** 2 = sealed pieces (OFFL-FILE-03), 1 = an old plain file awaiting its re-save (OFFL-MIGR-01). */
    schemaVersion: number;
  }> {
    const filtered = mediaIds && mediaIds.length > 0;
    const baseSelect = this.playback
      .select({
        id: mediaLocalDownloads.id,
        fileId: mediaLocalDownloads.fileId,
        mediaId: mediaLocalDownloads.mediaId,
        quality: mediaLocalDownloads.quality,
        formatId: mediaLocalDownloads.formatId,
        container: mediaLocalDownloads.container,
        localPath: mediaLocalDownloads.localPath,
        totalBytes: mediaLocalDownloads.totalBytes,
        downloadedAt: mediaLocalDownloads.downloadedAt,
        lastVerifiedAt: mediaLocalDownloads.lastVerifiedAt,
        runtimeJobId: mediaLocalDownloads.runtimeJobId,
        schemaVersion: mediaLocalDownloads.schemaVersion,
      })
      .from(mediaLocalDownloads);
    const rows = filtered
      ? baseSelect.where(inArray(mediaLocalDownloads.mediaId, mediaIds!.map((id) => String(id)))).all()
      : baseSelect.all();
    return rows.map((row) => ({
      id: String(row.id),
      fileId: String(row.fileId),
      mediaId: String(row.mediaId),
      quality: String(row.quality),
      formatId: String(row.formatId),
      container: String(row.container),
      localPath: String(row.localPath),
      totalBytes: Number(row.totalBytes),
      downloadedAt: String(row.downloadedAt),
      lastVerifiedAt: row.lastVerifiedAt ? String(row.lastVerifiedAt) : null,
      runtimeJobId: row.runtimeJobId ? String(row.runtimeJobId) : null,
      schemaVersion: Number(row.schemaVersion ?? 1),
    }));
  }

  /**
   * Stamp `last_verified_at` for the supplied file ids. Called by the
   * reconcile handler after the file's existence + size are confirmed.
   * Silently does nothing for unknown file ids.
   */
  touchLocalDownloadsVerified(fileIds: string[], verifiedAt: string): { touched: number } {
    const ids = fileIds.map((id) => String(id)).filter((id) => id.length > 0);
    if (ids.length === 0) return { touched: 0 };
    // Same .run()-returns-void caveat as `dropLocalDownloads`. SELECT
    // matching rows first to compute the touched count, then UPDATE.
    const preCount = this.playback
      .select({ id: mediaLocalDownloads.id })
      .from(mediaLocalDownloads)
      .where(inArray(mediaLocalDownloads.fileId, ids))
      .all()
      .length;
    this.playback
      .update(mediaLocalDownloads)
      .set({ lastVerifiedAt: String(verifiedAt) })
      .where(inArray(mediaLocalDownloads.fileId, ids))
      .run();
    return { touched: preCount };
  }

  upsertSkipAnalysis(
    mediaId: string,
    episodeId: string | null,
    kind: string,
    payload: Record<string, unknown>
  ) {
    const timestamp = nowIso();
    const id = `skip-analysis:${kind}:${episodeId ?? mediaId}`;
    const row = {
      id,
      mediaId,
      episodeId,
      kind,
      payloadJson: JSON.stringify(payload),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    validateDbRow("mediaSkipAnalysis", row);
    this.templates
      .insert(mediaSkipAnalysis)
      .values(row)
      .onConflictDoUpdate({
        target: mediaSkipAnalysis.id,
        set: {
          mediaId,
          episodeId,
          kind,
          payloadJson: row.payloadJson,
          updatedAt: timestamp,
        },
      })
      .run();
    this.noteMediaChanged(mediaId);
    return this.persist();
  }

  listSkipAnalysis(mediaId: string, kind?: string) {
    const whereClause = kind
      ? and(eq(mediaSkipAnalysis.mediaId, mediaId), eq(mediaSkipAnalysis.kind, kind))
      : eq(mediaSkipAnalysis.mediaId, mediaId);
    return this.templates
      .select({
        id: mediaSkipAnalysis.id,
        mediaId: mediaSkipAnalysis.mediaId,
        episodeId: mediaSkipAnalysis.episodeId,
        kind: mediaSkipAnalysis.kind,
        payloadJson: mediaSkipAnalysis.payloadJson,
        createdAt: mediaSkipAnalysis.createdAt,
        updatedAt: mediaSkipAnalysis.updatedAt,
      })
      .from(mediaSkipAnalysis)
      .where(whereClause)
      .orderBy(asc(mediaSkipAnalysis.episodeId), asc(mediaSkipAnalysis.kind))
      .all()
      .map((row) => ({
        id: String(row.id),
        mediaId: String(row.mediaId),
        episodeId: row.episodeId ? String(row.episodeId) : null,
        kind: String(row.kind),
        payload: JSON.parse(String(row.payloadJson ?? "{}")) as Record<string, unknown>,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
      }));
  }

  addSubtitleTrack(
    mediaId: string,
    episodeId: string | null,
    language: string,
    label: string,
    objectKey: string,
    format?: string | null,
    /** Where the subtitle came from: "srt" for a file the user added, "fetched" for a fetched one (PLAY-SUBGET-17). */
    source?: string | null
  ) {
    const timestamp = nowIso();
    this.playback.insert(mediaSubtitles).values({
      id: randomUUID(),
      mediaId,
      fileId: null,
      episodeId,
      language,
      label,
      objectKey,
      format: format ?? null,
      isDefault: false,
      source: source || "srt",
      createdAt: timestamp,
    }).run();
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  removeSubtitleTrack(trackId: string) {
    const row = this.playback
      .select({ mediaId: mediaSubtitles.mediaId })
      .from(mediaSubtitles)
      .where(eq(mediaSubtitles.id, trackId))
      .limit(1)
      .all()[0];
    this.playback.delete(mediaSubtitles).where(eq(mediaSubtitles.id, trackId)).run();
    if (row?.mediaId) {
      this.queueMediaUpsert(String(row.mediaId));
    }
    return this.persist();
  }

  removeAudioTrack(trackId: string) {
    const row = this.playback
      .select({
        mediaId: mediaAudioTracks.mediaId,
        episodeId: mediaAudioTracks.episodeId,
        isDefault: mediaAudioTracks.isDefault,
      })
      .from(mediaAudioTracks)
      .where(eq(mediaAudioTracks.id, trackId))
      .limit(1)
      .all()[0];
    if (!row?.mediaId) return this.persist();

    const mediaId = String(row.mediaId);
    const episodeId = row.episodeId ? String(row.episodeId) : null;
    const scopeFilter = episodeId ? eq(mediaAudioTracks.episodeId, episodeId) : isNull(mediaAudioTracks.episodeId);
    const scopedTracks = this.playback
      .select({ id: mediaAudioTracks.id, isDefault: mediaAudioTracks.isDefault })
      .from(mediaAudioTracks)
      .where(and(eq(mediaAudioTracks.mediaId, mediaId), scopeFilter))
      .all();
    if (scopedTracks.length <= 1) {
      throw new Error("AUDIO_TRACK_LAST");
    }

    this.playback.delete(mediaAudioTracks).where(eq(mediaAudioTracks.id, trackId)).run();

    const remaining = this.playback
      .select({ id: mediaAudioTracks.id, isDefault: mediaAudioTracks.isDefault })
      .from(mediaAudioTracks)
      .where(and(eq(mediaAudioTracks.mediaId, mediaId), scopeFilter))
      .orderBy(asc(mediaAudioTracks.createdAt))
      .all();
    const hasDefault = remaining.some((track) => Boolean(track.isDefault));
    if (!hasDefault && remaining[0]?.id) {
      this.playback.update(mediaAudioTracks).set({ isDefault: true }).where(eq(mediaAudioTracks.id, String(remaining[0].id))).run();
    } else if (Boolean(row.isDefault) && remaining[0]?.id) {
      this.playback
        .update(mediaAudioTracks)
        .set({ isDefault: false })
        .where(and(eq(mediaAudioTracks.mediaId, mediaId), scopeFilter))
        .run();
      this.playback.update(mediaAudioTracks).set({ isDefault: true }).where(eq(mediaAudioTracks.id, String(remaining[0].id))).run();
    }

    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  updateAudioTrack(trackId: string, language: string, label: string) {
    const row = this.playback
      .select({ mediaId: mediaAudioTracks.mediaId, label: mediaAudioTracks.label, language: mediaAudioTracks.language })
      .from(mediaAudioTracks)
      .where(eq(mediaAudioTracks.id, trackId))
      .limit(1)
      .all()[0];
    if (!row?.mediaId) return this.persist();
    const normalizedLanguage = language.trim().toLowerCase() || "und";
    // Empty label is a valid state — under the track display rule, a tagged
    // language with no descriptor displays as just the language name, and an
    // "und" track with no label displays as "Undefined". Do not silently fall
    // back to the previous label or the language code.
    const normalizedLabel = label.trim();
    this.playback
      .update(mediaAudioTracks)
      .set({ language: normalizedLanguage, label: normalizedLabel })
      .where(eq(mediaAudioTracks.id, trackId))
      .run();
    this.queueMediaUpsert(String(row.mediaId));
    return this.persist();
  }

  updateSubtitleTrack(trackId: string, language: string, label: string) {
    const row = this.playback
      .select({
        mediaId: mediaSubtitles.mediaId,
        label: mediaSubtitles.label,
        language: mediaSubtitles.language,
      })
      .from(mediaSubtitles)
      .where(eq(mediaSubtitles.id, trackId))
      .limit(1)
      .all()[0];
    if (!row?.mediaId) return this.persist();
    const normalizedLanguage = language.trim().toLowerCase() || "und";
    const normalizedLabel = label.trim();
    this.playback
      .update(mediaSubtitles)
      .set({ language: normalizedLanguage, label: normalizedLabel })
      .where(eq(mediaSubtitles.id, trackId))
      .run();
    this.queueMediaUpsert(String(row.mediaId));
    return this.persist();
  }

  setDefaultAudioTrack(mediaId: string, episodeId: string | null, trackId: string | null) {
    const scopeFilter = episodeId ? eq(mediaAudioTracks.episodeId, episodeId) : isNull(mediaAudioTracks.episodeId);
    this.playback
      .update(mediaAudioTracks)
      .set({ isDefault: false })
      .where(and(eq(mediaAudioTracks.mediaId, mediaId), scopeFilter))
      .run();
    if (trackId) {
      this.playback.update(mediaAudioTracks).set({ isDefault: true }).where(eq(mediaAudioTracks.id, trackId)).run();
    } else {
      const fallback = this.playback
        .select({ id: mediaAudioTracks.id })
        .from(mediaAudioTracks)
        .where(and(eq(mediaAudioTracks.mediaId, mediaId), scopeFilter))
        .orderBy(asc(mediaAudioTracks.createdAt))
        .limit(1)
        .all()[0];
      if (fallback?.id) {
        this.playback.update(mediaAudioTracks).set({ isDefault: true }).where(eq(mediaAudioTracks.id, String(fallback.id))).run();
      }
    }
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  setDefaultSubtitleTrack(mediaId: string, episodeId: string | null, trackId: string | null) {
    const scopeFilter = episodeId ? eq(mediaSubtitles.episodeId, episodeId) : isNull(mediaSubtitles.episodeId);
    this.playback
      .update(mediaSubtitles)
      .set({ isDefault: false })
      .where(and(eq(mediaSubtitles.mediaId, mediaId), scopeFilter))
      .run();
    if (trackId) {
      this.playback.update(mediaSubtitles).set({ isDefault: true }).where(eq(mediaSubtitles.id, trackId)).run();
    }
    this.queueMediaUpsert(mediaId);
    return this.persist();
  }

  /**
   * The remembered audio + subtitle choice of one movie / TV show (PLAY-TRACK-04),
   * or null when the user never picked. `mediaId` is the movie or the SHOW id,
   * never an episode id. Synced between devices as a `setting.set`.
   */
  getTrackPrefs(mediaId: string): TrackPrefs | null {
    return parseTrackPrefs(this.getSetting(scopedTrackPrefsKey(this.viewingScope, mediaId))?.value);
  }

  /** Read-modify-write: only the fields named in `patch` change; the record syncs like resume. */
  setTrackPrefs(mediaId: string, patch: TrackPrefsPatch) {
    this.writeTrackPrefs(mediaId, mergeTrackPrefs(this.getTrackPrefs(mediaId), patch, nowIso()));
    this.noteMediaChanged(mediaId);
    return this.persist();
  }

  /** The active profile's record (ACCT-SQUAD-02): the main profile's own key, `p:<profileId>:` for any other. */
  private writeTrackPrefs(mediaId: string, prefs: TrackPrefs) {
    this.writeSettingRow(scopedTrackPrefsKey(this.viewingScope, mediaId), serializeTrackPrefs(prefs), prefs.updatedAt);
  }

  /** Audio-only entry point kept for the headless integration runtime; stored as a track pref. */
  setPreferredAudioLanguage(mediaId: string, language: string | null) {
    return this.setTrackPrefs(mediaId, { audioLanguage: language });
  }

  listMediaFormats(mediaId: string) {
    const fileRows = this.metadata
      .select({ id: mediaFiles.id, templateId: mediaFiles.templateId })
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaId, mediaId))
      .all();
    const templateFileRows = fileRows.filter((row) => row.templateId);
    const templateIds = Array.from(new Set(templateFileRows.map((row) => String(row.templateId))));

    const rows = this.playback
      .select({
        id: mediaFormats.id,
        mediaId: mediaFormats.mediaId,
        fileId: mediaFormats.fileId,
        quality: mediaFormats.quality,
        codec: mediaFormats.codec,
        codecString: mediaFormats.codecString,
        bitrateKbps: mediaFormats.bitrateKbps,
        initKey: mediaFormats.initKey,
        initSize: mediaFormats.initSize,
        durationSeconds: mediaFormats.durationSeconds,
        totalSize: mediaFormats.totalSize,
        sizeMb: mediaFormats.sizeMb,
        isSource: mediaFormats.isSource,
        previewSheets: mediaFormats.previewSheets,
      })
      .from(mediaFormats)
      .where(eq(mediaFormats.mediaId, mediaId))
      .orderBy(desc(mediaFormats.quality), asc(mediaFormats.codec))
      .all();
    const formatIds = rows.map((row) => String(row.id));
    const chunkKeysById = this.loadFormatChunks(formatIds);
    const directFormats = rows.map((row) => ({
      id: String(row.id),
      mediaId: String(row.mediaId),
      fileId: String(row.fileId),
      quality: String(row.quality),
      codec: String(row.codec),
      codecString: row.codecString ? String(row.codecString) : null,
      bitrateKbps: row.bitrateKbps === null || row.bitrateKbps === undefined ? null : Number(row.bitrateKbps),
      initKey: row.initKey ? String(row.initKey) : null,
      initSize: row.initSize === null || row.initSize === undefined ? null : Number(row.initSize),
      durationSeconds:
        row.durationSeconds === null || row.durationSeconds === undefined ? null : Number(row.durationSeconds),
      totalSize: row.totalSize === null || row.totalSize === undefined ? null : Number(row.totalSize),
      sizeMb: Number(row.sizeMb),
      chunks: chunkKeysById.get(String(row.id)) ?? [],
      isSource: Number(row.isSource ?? 0) === 1,
      previewSheets: parsePreviewSheets(row.previewSheets),
    }));

    if (templateIds.length === 0) {
      return directFormats;
    }

    const templateFormatsByTemplateId = this.loadTemplateFormats(templateIds);
    const templateFormatIds = Array.from(
      new Set(
        templateIds.flatMap((templateId) =>
          (templateFormatsByTemplateId.get(templateId) ?? []).map((format) => format.id)
        )
      )
    );
    const templateChunksById = this.loadTemplateFormatChunks(templateFormatIds);
    const templateFormats = templateFileRows.flatMap((file) => {
      const templateId = String(file.templateId);
      const formats = templateFormatsByTemplateId.get(templateId) ?? [];
      return formats.map((format) => ({
        id: buildTemplateFormatId(format.id, String(file.id)),
        mediaId,
        fileId: String(file.id),
        quality: format.quality,
        codec: format.codec,
        codecString: format.codecString,
        bitrateKbps: format.bitrateKbps,
        initKey: format.initKey,
        initSize: format.initSize,
        durationSeconds: format.durationSeconds,
        totalSize: format.totalSize,
        sizeMb: format.sizeMb,
        chunks: templateChunksById.get(format.id) ?? [],
        // Template-projected formats are never the source-of-record for a
        // file's media_formats — they are a stand-in derived from the
        // canonical template row. The post-ingest delete guard treats them
        // the same as a non-source media_formats row.
        isSource: false,
        // Previews live on the file's source format only (MPV-PREV-02).
        previewSheets: null,
      }));
    });
    return [...directFormats, ...templateFormats];
  }

  getMediaStorageBytes(mediaId: string): number {
    const formatTotal = this.playback
      .select({ totalSize: mediaFormats.totalSize })
      .from(mediaFormats)
      .where(eq(mediaFormats.mediaId, mediaId))
      .all()
      .reduce((sum, row) => sum + Number(row.totalSize ?? 0), 0);
    const audioTotal = this.playback
      .select({ totalSize: mediaAudioTracks.totalSize })
      .from(mediaAudioTracks)
      .where(eq(mediaAudioTracks.mediaId, mediaId))
      .all()
      .reduce((sum, row) => sum + Number(row.totalSize ?? 0), 0);
    return formatTotal + audioTotal;
  }

  /** A person another title than `mediaId` lists in its cast or crew: their stored photo is that title's too. */
  private personInOtherTitle(personId: string, mediaId: string): boolean {
    const inOtherRole = this.metadata
      .select({ id: mediaRoles.id })
      .from(mediaRoles)
      .where(and(eq(mediaRoles.personId, personId), ne(mediaRoles.mediaId, mediaId)))
      .limit(1)
      .all();
    if (inOtherRole.length > 0) return true;
    return (
      this.metadata
        .select({ id: mediaCrew.id })
        .from(mediaCrew)
        .where(and(eq(mediaCrew.personId, personId), ne(mediaCrew.mediaId, mediaId)))
        .limit(1)
        .all().length > 0
    );
  }

  getMediaObjectKeys(mediaId: string) {
    const keys: string[] = [];
    const mediaRow = this.core
      .select({ posterPath: mediaItems.posterPath, backdropPath: mediaItems.backdropPath })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaId))
      .limit(1)
      .all()[0];
    if (mediaRow?.posterPath) keys.push(String(mediaRow.posterPath));
    if (mediaRow?.backdropPath) keys.push(String(mediaRow.backdropPath));

    // A person's photo is shared by every title they are in (META-ART-01): it goes with this title only when no
    // other title lists that person, in its cast or its crew.
    const castRows = this.metadata
      .select({ personId: people.id, profilePath: people.profilePath })
      .from(mediaRoles)
      .innerJoin(people, eq(mediaRoles.personId, people.id))
      .where(eq(mediaRoles.mediaId, mediaId))
      .all();
    castRows.forEach((row) => {
      if (row.profilePath && !this.personInOtherTitle(String(row.personId), mediaId)) keys.push(String(row.profilePath));
    });

    const seasonRows = this.metadata
      .select({ posterPath: mediaSeasons.posterPath })
      .from(mediaSeasons)
      .where(eq(mediaSeasons.mediaId, mediaId))
      .all();
    seasonRows.forEach((row) => {
      if (row.posterPath) keys.push(String(row.posterPath));
    });

    const episodeRows = this.metadata
      .select({ stillPath: mediaEpisodes.stillPath })
      .from(mediaEpisodes)
      .where(eq(mediaEpisodes.mediaId, mediaId))
      .all();
    episodeRows.forEach((row) => {
      if (row.stillPath) keys.push(String(row.stillPath));
    });

    const formatRows = this.playback
      .select({ id: mediaFormats.id, initKey: mediaFormats.initKey, previewSheets: mediaFormats.previewSheets })
      .from(mediaFormats)
      .where(eq(mediaFormats.mediaId, mediaId))
      .all();
    const formatIds = formatRows.map((row) => String(row.id));
    const chunkKeysById = this.loadFormatChunks(formatIds);
    formatRows.forEach((row) => {
      if (row.initKey) keys.push(String(row.initKey));
      const chunks = chunkKeysById.get(String(row.id)) ?? [];
      chunks.forEach((chunk) => keys.push(String(chunk.key)));
      keys.push(...previewSheetKeys(parsePreviewSheets(row.previewSheets)));
    });

    const audioRows = this.playback
      .select({ id: mediaAudioTracks.id, initKey: mediaAudioTracks.initKey })
      .from(mediaAudioTracks)
      .where(eq(mediaAudioTracks.mediaId, mediaId))
      .all();
    const audioIds = audioRows.map((row) => String(row.id));
    const audioChunksById = this.loadAudioChunks(audioIds);
    audioRows.forEach((row) => {
      if (row.initKey) keys.push(String(row.initKey));
      const chunks = audioChunksById.get(String(row.id)) ?? [];
      chunks.forEach((chunk) => keys.push(String(chunk.key)));
    });

    const subtitleRows = this.playback
      .select({ objectKey: mediaSubtitles.objectKey })
      .from(mediaSubtitles)
      .where(eq(mediaSubtitles.mediaId, mediaId))
      .all();
    subtitleRows.forEach((row) => {
      if (row.objectKey) keys.push(String(row.objectKey));
    });

    const templateRows = this.metadata
      .select({ templateId: mediaFiles.templateId })
      .from(mediaFiles)
      .where(and(eq(mediaFiles.mediaId, mediaId), isNotNull(mediaFiles.templateId)))
      .all();
    const templateIds = Array.from(new Set(templateRows.map((row) => String(row.templateId))));
    if (templateIds.length > 0) {
      const templateFormatsByTemplateId = this.loadTemplateFormats(templateIds);
      const templateFormatRows = templateIds.flatMap(
        (templateId) => templateFormatsByTemplateId.get(templateId) ?? []
      );
      const templateFormatIds = templateFormatRows.map((row) => row.id);
      const templateChunksById = this.loadTemplateFormatChunks(templateFormatIds);
      templateFormatRows.forEach((row) => {
        if (row.initKey) keys.push(String(row.initKey));
        const chunks = templateChunksById.get(String(row.id)) ?? [];
        chunks.forEach((chunk) => keys.push(String(chunk.key)));
      });

      const templateAudioTracksByTemplateId = this.loadTemplateAudioTracks(templateIds);
      const templateAudioRows = templateIds.flatMap(
        (templateId) => templateAudioTracksByTemplateId.get(templateId) ?? []
      );
      const templateAudioIds = templateAudioRows.map((row) => row.id);
      const templateAudioChunksById = this.loadTemplateAudioChunks(templateAudioIds);
      templateAudioRows.forEach((row) => {
        if (row.initKey) keys.push(String(row.initKey));
        const chunks = templateAudioChunksById.get(String(row.id)) ?? [];
        chunks.forEach((chunk) => keys.push(String(chunk.key)));
      });

      const templateSubtitlesByTemplateId = this.loadTemplateSubtitles(templateIds);
      templateIds.forEach((templateId) => {
        const subs = templateSubtitlesByTemplateId.get(templateId) ?? [];
        subs.forEach((track) => {
          if (track.objectKey) keys.push(String(track.objectKey));
        });
      });
    }

    return keys;
  }

  purgeMissingObjects(missingKeys: string[]) {
    if (missingKeys.length === 0) return this.persist();
    const missing = new Set(missingKeys);

    const mediaRows = this.core
      .select({ id: mediaItems.id, posterPath: mediaItems.posterPath, backdropPath: mediaItems.backdropPath })
      .from(mediaItems)
      .all();
    mediaRows.forEach((row) => {
      const posterKey = extractAssetObjectKey(row.posterPath ? String(row.posterPath) : null);
      const backdropKey = extractAssetObjectKey(row.backdropPath ? String(row.backdropPath) : null);
      const updates: { poster: string | null; backdrop: string | null } = {
        poster: row.posterPath,
        backdrop: row.backdropPath,
      };
      if (posterKey && missing.has(posterKey)) updates.poster = null;
      if (backdropKey && missing.has(backdropKey)) updates.backdrop = null;
      if (updates.poster !== row.posterPath || updates.backdrop !== row.backdropPath) {
        this.core
          .update(mediaItems)
          .set({ posterPath: updates.poster, backdropPath: updates.backdrop })
          .where(eq(mediaItems.id, String(row.id)))
          .run();
      }
    });

    const peopleRows = this.metadata.select({ id: people.id, profilePath: people.profilePath }).from(people).all();
    peopleRows.forEach((row) => {
      const key = extractAssetObjectKey(row.profilePath ? String(row.profilePath) : null);
      if (key && missing.has(key)) {
        this.metadata.update(people).set({ profilePath: null }).where(eq(people.id, String(row.id))).run();
      }
    });

    const seasonRows = this.metadata
      .select({ id: mediaSeasons.id, posterPath: mediaSeasons.posterPath })
      .from(mediaSeasons)
      .all();
    seasonRows.forEach((row) => {
      const key = extractAssetObjectKey(row.posterPath ? String(row.posterPath) : null);
      if (key && missing.has(key)) {
        this.metadata.update(mediaSeasons).set({ posterPath: null }).where(eq(mediaSeasons.id, String(row.id))).run();
      }
    });

    const episodeRows = this.metadata
      .select({ id: mediaEpisodes.id, stillPath: mediaEpisodes.stillPath })
      .from(mediaEpisodes)
      .all();
    episodeRows.forEach((row) => {
      const key = extractAssetObjectKey(row.stillPath ? String(row.stillPath) : null);
      if (key && missing.has(key)) {
        this.metadata.update(mediaEpisodes).set({ stillPath: null }).where(eq(mediaEpisodes.id, String(row.id))).run();
      }
    });

    const subtitleRows = this.playback
      .select({ id: mediaSubtitles.id, objectKey: mediaSubtitles.objectKey })
      .from(mediaSubtitles)
      .all();
    subtitleRows.forEach((row) => {
      const key = row.objectKey ? String(row.objectKey) : null;
      if (key && missing.has(key)) {
        this.playback.delete(mediaSubtitles).where(eq(mediaSubtitles.id, String(row.id))).run();
      }
    });

    const formatRows = this.playback
      .select({
        id: mediaFormats.id,
        fileId: mediaFormats.fileId,
        initKey: mediaFormats.initKey,
        previewSheets: mediaFormats.previewSheets,
      })
      .from(mediaFormats)
      .all();
    const formatIds = formatRows.map((row) => String(row.id));
    const chunkKeysById = this.loadFormatChunks(formatIds);
    const removedFormats = new Set<string>();
    formatRows.forEach((row) => {
      const chunkKeys = chunkKeysById.get(String(row.id)) ?? [];
      const hasMissing =
        (row.initKey && missing.has(String(row.initKey))) ||
        chunkKeys.some((chunk) => missing.has(String(chunk.key)));
      if (hasMissing) {
        removedFormats.add(String(row.id));
        this.playback.delete(mediaFormats).where(eq(mediaFormats.id, String(row.id))).run();
        return;
      }
      // Preview sheets are optional (MPV-PREV-01): a missing sheet drops the previews, never the playable format.
      if (previewSheetKeys(parsePreviewSheets(row.previewSheets)).some((key) => missing.has(key))) {
        this.playback.update(mediaFormats).set({ previewSheets: null }).where(eq(mediaFormats.id, String(row.id))).run();
      }
    });

    const audioRows = this.playback
      .select({ id: mediaAudioTracks.id, initKey: mediaAudioTracks.initKey })
      .from(mediaAudioTracks)
      .all();
    const audioIds = audioRows.map((row) => String(row.id));
    const audioChunksById = this.loadAudioChunks(audioIds);
    audioRows.forEach((row) => {
      const chunks = audioChunksById.get(String(row.id)) ?? [];
      const hasMissing =
        (row.initKey && missing.has(String(row.initKey))) ||
        chunks.some((chunk) => missing.has(String(chunk.key)));
      if (hasMissing) {
        this.playback.delete(mediaAudioTracks).where(eq(mediaAudioTracks.id, String(row.id))).run();
      }
    });

    const templateRows = this.metadata
      .select({ templateId: mediaFiles.templateId })
      .from(mediaFiles)
      .where(isNotNull(mediaFiles.templateId))
      .all();
    const templateIds = Array.from(new Set(templateRows.map((row) => String(row.templateId))));
    if (templateIds.length > 0) {
      const templatesWithMissing = new Set<string>();
      const templateFormatRows = this.templates
        .select({ id: mediaTemplateFormats.id, templateId: mediaTemplateFormats.templateId, initKey: mediaTemplateFormats.initKey })
        .from(mediaTemplateFormats)
        .where(inArray(mediaTemplateFormats.templateId, templateIds))
        .all();
      const templateFormatIds = templateFormatRows.map((row) => String(row.id));
      const templateChunksById = this.loadTemplateFormatChunks(templateFormatIds);
      templateFormatRows.forEach((row) => {
        const initKey = row.initKey ? String(row.initKey) : null;
        const chunks = templateChunksById.get(String(row.id)) ?? [];
        const hasMissing =
          (initKey && missing.has(initKey)) || chunks.some((chunk) => missing.has(String(chunk.key)));
        if (hasMissing) {
          templatesWithMissing.add(String(row.templateId));
        }
      });

      const templateAudioRows = this.templates
        .select({ id: mediaTemplateAudioTracks.id, templateId: mediaTemplateAudioTracks.templateId, initKey: mediaTemplateAudioTracks.initKey })
        .from(mediaTemplateAudioTracks)
        .where(inArray(mediaTemplateAudioTracks.templateId, templateIds))
        .all();
      const templateAudioIds = templateAudioRows.map((row) => String(row.id));
      const templateAudioChunksById = this.loadTemplateAudioChunks(templateAudioIds);
      templateAudioRows.forEach((row) => {
        const initKey = row.initKey ? String(row.initKey) : null;
        const chunks = templateAudioChunksById.get(String(row.id)) ?? [];
        const hasMissing =
          (initKey && missing.has(initKey)) || chunks.some((chunk) => missing.has(String(chunk.key)));
        if (hasMissing) {
          templatesWithMissing.add(String(row.templateId));
        }
      });

      const templateSubtitleRows = this.templates
        .select({ templateId: mediaTemplateSubtitles.templateId, objectKey: mediaTemplateSubtitles.objectKey })
        .from(mediaTemplateSubtitles)
        .where(inArray(mediaTemplateSubtitles.templateId, templateIds))
        .all();
      templateSubtitleRows.forEach((row) => {
        const key = row.objectKey ? String(row.objectKey) : null;
        if (key && missing.has(key)) {
          templatesWithMissing.add(String(row.templateId));
        }
      });

      if (templatesWithMissing.size > 0) {
        const templateIdsToDelete = Array.from(templatesWithMissing);
        const formatIdsToDelete = templateFormatRows
          .filter((row) => templatesWithMissing.has(String(row.templateId)))
          .map((row) => String(row.id));
        const audioIdsToDelete = templateAudioRows
          .filter((row) => templatesWithMissing.has(String(row.templateId)))
          .map((row) => String(row.id));

        if (formatIdsToDelete.length > 0) {
          this.templates.delete(mediaTemplateFormatChunks).where(inArray(mediaTemplateFormatChunks.formatId, formatIdsToDelete)).run();
          this.templates.delete(mediaTemplateChapters).where(inArray(mediaTemplateChapters.formatId, formatIdsToDelete)).run();
        }
        if (audioIdsToDelete.length > 0) {
          this.templates.delete(mediaTemplateAudioChunks).where(inArray(mediaTemplateAudioChunks.trackId, audioIdsToDelete)).run();
        }
        this.templates.delete(mediaTemplateFormats).where(inArray(mediaTemplateFormats.templateId, templateIdsToDelete)).run();
        this.templates.delete(mediaTemplateAudioTracks).where(inArray(mediaTemplateAudioTracks.templateId, templateIdsToDelete)).run();
        this.templates.delete(mediaTemplateSubtitles).where(inArray(mediaTemplateSubtitles.templateId, templateIdsToDelete)).run();
        this.templates.delete(mediaTemplates).where(inArray(mediaTemplates.id, templateIdsToDelete)).run();
        this.metadata.update(mediaFiles).set({ templateId: null }).where(inArray(mediaFiles.templateId, templateIdsToDelete)).run();
      }
    }

    if (removedFormats.size > 0) {
      // Phase 3.6: was four `this.db.exec(...)` cross-table statements. The
      // legacy DB is empty post-flip, so we split each into the corresponding
      // per-group DB query + in-process filter.
      const liveFileIds = new Set<string>(
        (this.playbackSqlite
          .prepare("SELECT DISTINCT file_id AS fileId FROM media_formats;")
          .all() as Array<{ fileId?: string }>)
          .map((row) => String(row?.fileId ?? ""))
          .filter((id) => id.length > 0)
      );
      const fileIdRows = this.metadataSqlite
        .prepare("SELECT id FROM media_files;")
        .all() as Array<{ id?: string }>;
      const orphanFileIds = fileIdRows
        .map((row) => String(row?.id ?? ""))
        .filter((id) => id.length > 0 && !liveFileIds.has(id));
      if (orphanFileIds.length > 0) {
        const fileDel = this.metadataSqlite.prepare(
          "DELETE FROM media_files WHERE id = ?;"
        );
        const audioDel = this.playbackSqlite.prepare(
          "DELETE FROM media_audio_tracks WHERE file_id = ?;"
        );
        const subDel = this.playbackSqlite.prepare(
          "DELETE FROM media_subtitles WHERE file_id = ?;"
        );
        for (const id of orphanFileIds) {
          fileDel.run(id);
          audioDel.run(id);
          subDel.run(id);
        }
      }
      // Recompute has_files across media_items (core) using media_files
      // (metadata) as the source of truth.
      const mediaIdsWithFiles = new Set<string>(
        (this.metadataSqlite
          .prepare("SELECT DISTINCT media_id AS mediaId FROM media_files;")
          .all() as Array<{ mediaId?: string }>)
          .map((row) => String(row?.mediaId ?? ""))
          .filter((id) => id.length > 0)
      );
      const mediaIdRows = this.coreSqlite
        .prepare("SELECT id, has_files AS hasFiles FROM media_items;")
        .all() as Array<{ id?: string; hasFiles?: number }>;
      const toggleStmt = this.coreSqlite.prepare(
        "UPDATE media_items SET has_files = ? WHERE id = ?;"
      );
      for (const row of mediaIdRows) {
        const id = String(row?.id ?? "");
        if (!id) continue;
        const want = mediaIdsWithFiles.has(id) ? 1 : 0;
        if (Number(row?.hasFiles ?? 0) !== want) {
          toggleStmt.run(want, id);
        }
      }
    }

    return this.persist();
  }

  getMediaDetails(mediaId: string): MediaDetails | null {
    return this.buildMediaDetails(mediaId, { progress: this.readScopedMediaProgress(), playlists: this.readScopedPlaylists() });
  }

  /**
   * `scoped`: the active non-main profile's progress and playlists (null on main). Both scan every row of their kind,
   * so `buildSnapshot` reads them once for all titles, like `listMedia`.
   */
  private buildMediaDetails(mediaId: string, scoped: ScopedViewingReads): MediaDetails | null {
    const mediaRow = this.core
      .select({
        id: mediaItems.id,
        type: mediaItems.type,
        title: mediaItems.title,
        originalTitle: mediaItems.originalTitle,
        originalLanguage: mediaItems.originalLanguage,
        overview: mediaItems.overview,
        year: mediaItems.year,
        rating: mediaItems.rating,
        posterPath: mediaItems.posterPath,
        backdropPath: mediaItems.backdropPath,
        addedAt: mediaItems.addedAt,
        updatedAt: mediaItems.updatedAt,
        hasFiles: mediaItems.hasFiles,
        progressPct: mediaItems.progressPct,
        lastWatchedAt: mediaItems.lastWatchedAt,
        totalEpisodes: mediaItems.totalEpisodes,
        episodeCount: sql<number>`COALESCE(${mediaItems.totalEpisodes}, 0)`.as("episodeCount"),
      })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaId))
      .limit(1)
      .all()[0];
    if (!mediaRow) return null;
    if (scoped.progress) this.overlayOwnProgress(mediaRow, scoped.progress);
    if (String(mediaRow.type) === "tv") {
      const aggregate = this.getTvProgressAggregate(mediaId);
      if (aggregate) {
        mediaRow.progressPct = aggregate.progressPct;
        if (aggregate.lastWatchedAt) {
          mediaRow.lastWatchedAt = aggregate.lastWatchedAt;
        }
      }
    }
    const catalogIdById = this.loadMediaCatalogIds([mediaId]);
    const genresById = this.loadMediaGenres([mediaId]);
    const media = mapMediaRows([mediaRow], catalogIdById, genresById)[0];

    const castRows = this.metadata
      .select({
        id: mediaRoles.id,
        personId: mediaRoles.personId,
        name: people.name,
        role: mediaRoles.role,
        profilePath: people.profilePath,
        orderIndex: mediaRoles.orderIndex,
      })
      .from(mediaRoles)
      .innerJoin(people, eq(mediaRoles.personId, people.id))
      .where(eq(mediaRoles.mediaId, mediaId))
      .orderBy(asc(mediaRoles.orderIndex), asc(people.name))
      .all();
    const personIds = castRows.map((row) => String(row.personId));
    const castCatalogIds = this.loadPeopleCatalogIds(personIds);
    const cast = castRows.map((row) => ({
      id: String(row.id),
      personId: String(row.personId),
      catalogId: castCatalogIds.get(String(row.personId)) ?? null,
      name: String(row.name),
      role: row.role ? String(row.role) : null,
      profilePath: row.profilePath ? String(row.profilePath) : null,
    }));

    const crewRows = this.metadata
      .select({
        id: mediaCrew.id,
        personId: mediaCrew.personId,
        name: people.name,
        job: mediaCrew.job,
        profilePath: people.profilePath,
      })
      .from(mediaCrew)
      .innerJoin(people, eq(mediaCrew.personId, people.id))
      .where(eq(mediaCrew.mediaId, mediaId))
      .orderBy(asc(mediaCrew.orderIndex))
      .all();
    const crewCatalogIds = this.loadPeopleCatalogIds(crewRows.map((row) => String(row.personId)));
    const crew = crewRows.map((row) => {
      return {
        id: String(row.id),
        personId: String(row.personId),
        catalogId: crewCatalogIds.get(String(row.personId)) ?? null,
        name: String(row.name),
        job: String(row.job),
        profilePath: row.profilePath ? String(row.profilePath) : null,
      };
    });

    const trailerRows = this.metadata
      .select({ provider: mediaTrailers.provider, key: mediaTrailers.key, name: mediaTrailers.name, language: mediaTrailers.language })
      .from(mediaTrailers)
      .where(eq(mediaTrailers.mediaId, mediaId))
      .all();
    const trailers: MediaTrailer[] = trailerRows.map((row) => ({
      provider: "youtube",
      key: String(row.key),
      name: row.name ? String(row.name) : null,
      language: row.language ? String(row.language) : "und",
    }));

    const seasonRows = this.metadata
      .select({
        id: mediaSeasons.id,
        seasonNumber: mediaSeasons.seasonNumber,
        title: mediaSeasons.title,
        overview: mediaSeasons.overview,
        posterPath: mediaSeasons.posterPath,
        episodeCount: mediaSeasons.episodeCount,
        airDate: mediaSeasons.airDate,
      })
      .from(mediaSeasons)
      .where(eq(mediaSeasons.mediaId, mediaId))
      .orderBy(asc(mediaSeasons.seasonNumber))
      .all();
    const seasons = seasonRows.map((row) => ({
      id: String(row.id),
      seasonNumber: Number(row.seasonNumber),
      name: String(row.title),
      overview: row.overview ? String(row.overview) : null,
      posterPath: row.posterPath ? String(row.posterPath) : null,
      episodeCount: Number.isFinite(Number(row.episodeCount)) ? Number(row.episodeCount) : 0,
      airDate: row.airDate ? String(row.airDate) : null,
    }));

    const episodeRows = this.metadata
      .select({
        id: mediaEpisodes.id,
        seasonNumber: mediaEpisodes.seasonNumber,
        episodeNumber: mediaEpisodes.episodeNumber,
        title: mediaEpisodes.title,
        overview: mediaEpisodes.overview,
        stillPath: mediaEpisodes.stillPath,
        airDate: mediaEpisodes.airDate,
      })
      .from(mediaEpisodes)
      .where(eq(mediaEpisodes.mediaId, mediaId))
      .orderBy(asc(mediaEpisodes.seasonNumber), asc(mediaEpisodes.episodeNumber))
      .all();
    const episodes = episodeRows.map((row) => ({
      id: String(row.id),
      seasonNumber: Number(row.seasonNumber),
      episodeNumber: Number(row.episodeNumber),
      name: String(row.title),
      overview: row.overview ? String(row.overview) : null,
      stillPath: row.stillPath ? String(row.stillPath) : null,
      airDate: row.airDate ? String(row.airDate) : null,
    }));

    const fileRows = this.metadata
      .select({
        id: mediaFiles.id,
        filename: mediaFiles.filename,
        season: mediaFiles.season,
        episode: mediaFiles.episode,
        templateId: mediaFiles.templateId,
        editionId: mediaFiles.editionId,
        contentSha256: mediaFiles.contentSha256,
        originalSizeBytes: mediaFiles.originalSizeBytes,
      })
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaId, mediaId))
      .all();
    const fileIds = fileRows.map((row) => String(row.id));
    const desiredFormatsById = this.loadDesiredFormats(fileIds);
    const files = fileRows.map((row) => ({
      id: String(row.id),
      filename: String(row.filename),
      season: row.season === null ? null : Number(row.season),
      episode: row.episode === null ? null : Number(row.episode),
      desiredFormats: desiredFormatsById.get(String(row.id)) ?? [],
      editionId: row.editionId ?? null,
      contentSha256: row.contentSha256 ?? null,
      originalSizeBytes: row.originalSizeBytes ?? null,
    }));
    // LIB-EDIT-01: each film / episode's editions, oldest first (the chooser orders them, PLAY-OPEN-02).
    const editions = this.metadata
      .select()
      .from(mediaEditions)
      .where(eq(mediaEditions.mediaId, mediaId))
      .orderBy(asc(mediaEditions.createdAt), asc(mediaEditions.id))
      .all()
      .map((row) => ({
        id: row.id,
        season: row.season ?? null,
        episode: row.episode ?? null,
        name: row.name,
        nameUserSet: Boolean(row.nameUserSet),
        durationSeconds: row.durationSeconds ?? null,
        createdAt: row.createdAt,
      }));
    const templateFileRows = fileRows.filter((row) => row.templateId);
    const templateIds = Array.from(new Set(templateFileRows.map((row) => String(row.templateId))));
    const templateFormatsByTemplateId = this.loadTemplateFormats(templateIds);
    const templateFormatIds = Array.from(
      new Set(
        templateIds.flatMap((templateId) =>
          (templateFormatsByTemplateId.get(templateId) ?? []).map((format) => format.id)
        )
      )
    );
    const templateChunksById = this.loadTemplateFormatChunks(templateFormatIds);
    const templateChaptersByFormatId = this.loadTemplateChapters(templateFormatIds);
    const templateAudioTracksByTemplateId = this.loadTemplateAudioTracks(templateIds);
    const templateAudioTrackIds = Array.from(
      new Set(
        templateIds.flatMap((templateId) =>
          (templateAudioTracksByTemplateId.get(templateId) ?? []).map((track) => track.id)
        )
      )
    );
    const templateAudioChunksById = this.loadTemplateAudioChunks(templateAudioTrackIds);
    const templateSubtitlesByTemplateId = this.loadTemplateSubtitles(templateIds);

    const formatRows = this.playback
      .select({
        id: mediaFormats.id,
        mediaId: mediaFormats.mediaId,
        fileId: mediaFormats.fileId,
        quality: mediaFormats.quality,
        codec: mediaFormats.codec,
        codecString: mediaFormats.codecString,
        bitrateKbps: mediaFormats.bitrateKbps,
        initKey: mediaFormats.initKey,
        initSize: mediaFormats.initSize,
        durationSeconds: mediaFormats.durationSeconds,
        totalSize: mediaFormats.totalSize,
        sizeMb: mediaFormats.sizeMb,
        isSource: mediaFormats.isSource,
        previewSheets: mediaFormats.previewSheets,
      })
      .from(mediaFormats)
      .where(eq(mediaFormats.mediaId, mediaId))
      .orderBy(desc(mediaFormats.quality), asc(mediaFormats.codec))
      .all();
    const formatIds = formatRows.map((row) => String(row.id));
    const chunkKeysById = this.loadFormatChunks(formatIds);
    const directFormats = formatRows.map((row) => ({
      id: String(row.id),
      mediaId: String(row.mediaId),
      fileId: String(row.fileId),
      quality: String(row.quality),
      codec: String(row.codec),
      codecString: row.codecString ? String(row.codecString) : null,
      bitrateKbps: row.bitrateKbps === null || row.bitrateKbps === undefined ? null : Number(row.bitrateKbps),
      initKey: row.initKey ? String(row.initKey) : null,
      initSize: row.initSize === null || row.initSize === undefined ? null : Number(row.initSize),
      durationSeconds:
        row.durationSeconds === null || row.durationSeconds === undefined ? null : Number(row.durationSeconds),
      totalSize: row.totalSize === null || row.totalSize === undefined ? null : Number(row.totalSize),
      sizeMb: Number(row.sizeMb),
      // Carry the source flag through to the renderer (mirrors
      // listMediaFormats). The MediaDetailsDialog quality chips gate their
      // delete button on `format.isSource === true`; without this projection
      // every chip (including the source) reads undefined and shows a delete
      // button — letting the user attempt to orphan their highest/only copy.
      isSource: Number(row.isSource ?? 0) === 1,
      previewSheets: parsePreviewSheets(row.previewSheets),
      chunks: chunkKeysById.get(String(row.id)) ?? [],
    }));
    const templateFormats = templateFileRows.flatMap((file) => {
      const templateId = String(file.templateId);
      const entries = templateFormatsByTemplateId.get(templateId) ?? [];
      return entries.map((format) => ({
        id: buildTemplateFormatId(format.id, String(file.id)),
        mediaId,
        fileId: String(file.id),
        quality: format.quality,
        codec: format.codec,
        codecString: format.codecString,
        bitrateKbps: format.bitrateKbps,
        initKey: format.initKey,
        initSize: format.initSize,
        durationSeconds: format.durationSeconds,
        totalSize: format.totalSize,
        sizeMb: format.sizeMb,
        // Template-projected formats are never the source-of-record (mirrors
        // listMediaFormats); the delete guard treats them as non-source.
        isSource: false,
        chunks: templateChunksById.get(format.id) ?? [],
      }));
    });
    const formats = [...directFormats, ...templateFormats];

    const audioRows = this.playback
      .select({
        id: mediaAudioTracks.id,
        mediaId: mediaAudioTracks.mediaId,
        fileId: mediaAudioTracks.fileId,
        episodeId: mediaAudioTracks.episodeId,
        language: mediaAudioTracks.language,
        label: mediaAudioTracks.label,
        isDefault: mediaAudioTracks.isDefault,
        source: mediaAudioTracks.source,
        codec: mediaAudioTracks.codec,
        codecString: mediaAudioTracks.codecString,
        initKey: mediaAudioTracks.initKey,
        initSize: mediaAudioTracks.initSize,
        durationSeconds: mediaAudioTracks.durationSeconds,
        totalSize: mediaAudioTracks.totalSize,
      })
      .from(mediaAudioTracks)
      .where(eq(mediaAudioTracks.mediaId, mediaId))
      .orderBy(desc(mediaAudioTracks.isDefault), asc(mediaAudioTracks.language))
      .all();
    const audioTrackIds = audioRows.map((row) => String(row.id));
    const audioChunksById = this.loadAudioChunks(audioTrackIds);
    const directAudioTracks = audioRows.map((row) => ({
      id: String(row.id),
      mediaId: String(row.mediaId),
      fileId: row.fileId ? String(row.fileId) : null,
      episodeId: row.episodeId ? String(row.episodeId) : null,
      language: String(row.language),
      label: String(row.label),
      isDefault: Boolean(row.isDefault),
      source: String(row.source),
      codec: row.codec ? String(row.codec) : null,
      codecString: row.codecString ? String(row.codecString) : null,
      initKey: row.initKey ? String(row.initKey) : null,
      initSize: row.initSize === null || row.initSize === undefined ? null : Number(row.initSize),
      durationSeconds:
        row.durationSeconds === null || row.durationSeconds === undefined ? null : Number(row.durationSeconds),
      totalSize: row.totalSize === null || row.totalSize === undefined ? null : Number(row.totalSize),
      chunks: audioChunksById.get(String(row.id)) ?? [],
    }));
    const templateAudioTracks = templateFileRows.flatMap((file) => {
      const templateId = String(file.templateId);
      const entries = templateAudioTracksByTemplateId.get(templateId) ?? [];
      const episodeId = this.resolveEpisodeId(
        mediaId,
        file.season === null ? null : Number(file.season),
        file.episode === null ? null : Number(file.episode)
      );
      return entries.map((track) => ({
        id: buildTemplateAudioId(track.id, String(file.id)),
        mediaId,
        fileId: String(file.id),
        episodeId,
        language: track.language,
        label: track.label,
        isDefault: track.isDefault,
        source: track.source,
        codec: track.codec,
        codecString: track.codecString,
        initKey: track.initKey,
        initSize: track.initSize,
        durationSeconds: track.durationSeconds,
        totalSize: track.totalSize,
        chunks: templateAudioChunksById.get(track.id) ?? [],
      }));
    });
    const audioTracks = [...directAudioTracks, ...templateAudioTracks];

    const subtitleRows = this.playback
      .select({
        id: mediaSubtitles.id,
        mediaId: mediaSubtitles.mediaId,
        fileId: mediaSubtitles.fileId,
        episodeId: mediaSubtitles.episodeId,
        language: mediaSubtitles.language,
        label: mediaSubtitles.label,
        objectKey: mediaSubtitles.objectKey,
        format: mediaSubtitles.format,
        isDefault: mediaSubtitles.isDefault,
        source: mediaSubtitles.source,
        createdAt: mediaSubtitles.createdAt,
        derivedFromSubtitleId: mediaSubtitles.derivedFromSubtitleId,
      })
      .from(mediaSubtitles)
      .where(eq(mediaSubtitles.mediaId, mediaId))
      .orderBy(desc(mediaSubtitles.isDefault), asc(mediaSubtitles.language))
      .all();
    const directSubtitleTracks = subtitleRows.map((row) => ({
      id: String(row.id),
      mediaId: String(row.mediaId),
      fileId: row.fileId ? String(row.fileId) : null,
      episodeId: row.episodeId ? String(row.episodeId) : null,
      language: String(row.language),
      label: String(row.label),
      objectKey: row.objectKey ? String(row.objectKey) : null,
      format: row.format ? String(row.format) : null,
      isDefault: Boolean(row.isDefault),
      source: String(row.source),
      createdAt: row.createdAt ? String(row.createdAt) : nowIso(),
      derivedFromSubtitleId: row.derivedFromSubtitleId ? String(row.derivedFromSubtitleId) : null,
    }));
    const templateSubtitleTracks = templateFileRows.flatMap((file) => {
      const templateId = String(file.templateId);
      const entries = templateSubtitlesByTemplateId.get(templateId) ?? [];
      const episodeId = this.resolveEpisodeId(
        mediaId,
        file.season === null ? null : Number(file.season),
        file.episode === null ? null : Number(file.episode)
      );
      return entries.map((track) => ({
        id: buildTemplateSubtitleId(track.id, String(file.id)),
        mediaId,
        fileId: String(file.id),
        episodeId,
        language: track.language,
        label: track.label,
        objectKey: track.objectKey,
        format: track.format,
        isDefault: track.isDefault,
        source: track.source,
        createdAt: nowIso(),
        derivedFromSubtitleId: null,
      }));
    });
    const subtitleTracks = [...directSubtitleTracks, ...templateSubtitleTracks];

    const ownPlaylists = scoped.playlists;
    const playlistIds = ownPlaylists
      ? ownPlaylists.filter((playlist) => playlist.items.some((item) => item.mediaId === mediaId)).map((playlist) => playlist.id)
      : this.core
          .select({ playlistId: playlistItems.playlistId })
          .from(playlistItems)
          .where(eq(playlistItems.mediaId, mediaId))
          .all()
          .map((row) => String(row.playlistId));

    const chapterRows = this.playback
      .select({
        id: mediaChapters.id,
        formatId: mediaChapters.formatId,
        title: mediaChapters.title,
        startSeconds: mediaChapters.startSeconds,
      })
      .from(mediaChapters)
      .where(inArray(mediaChapters.formatId, formatIds))
      .orderBy(asc(mediaChapters.startSeconds))
      .all();
    const directChapters = chapterRows.map((row) => ({
      id: String(row.id),
      formatId: String(row.formatId),
      title: String(row.title),
      startSeconds: Number(row.startSeconds),
    }));
    const templateChapters = templateFileRows.flatMap((file) => {
      const templateId = String(file.templateId);
      const entries = templateFormatsByTemplateId.get(templateId) ?? [];
      return entries.flatMap((format) => {
        const chapters = templateChaptersByFormatId.get(format.id) ?? [];
        const virtualFormatId = buildTemplateFormatId(format.id, String(file.id));
        return chapters.map((chapter, index) => ({
          id: `${virtualFormatId}:${index}`,
          formatId: virtualFormatId,
          title: chapter.title,
          startSeconds: chapter.startSeconds,
        }));
      });
    });
    const chapters = [...directChapters, ...templateChapters];

    const skipMarkerRows = this.metadata
      .select({
        id: mediaSkipMarkers.id,
        mediaId: mediaSkipMarkers.mediaId,
        episodeId: mediaSkipMarkers.episodeId,
        type: mediaSkipMarkers.type,
        startSeconds: mediaSkipMarkers.startSeconds,
        endSeconds: mediaSkipMarkers.endSeconds,
        source: mediaSkipMarkers.source,
        confidence: mediaSkipMarkers.confidence,
        createdAt: mediaSkipMarkers.createdAt,
        updatedAt: mediaSkipMarkers.updatedAt,
      })
      .from(mediaSkipMarkers)
      .where(eq(mediaSkipMarkers.mediaId, mediaId))
      .orderBy(asc(mediaSkipMarkers.startSeconds), asc(mediaSkipMarkers.type))
      .all();
    const skipMarkers = skipMarkerRows.map((row) => ({
      id: String(row.id),
      mediaId: String(row.mediaId),
      episodeId: row.episodeId ? String(row.episodeId) : null,
      type: String(row.type) as MediaSkipMarkerType,
      startSeconds: Number(row.startSeconds),
      endSeconds: Number(row.endSeconds),
      source: String(row.source),
      confidence:
        row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    }));

    return {
      ...media,
      cast,
      crew,
      editions,
      trailers,
      playlistIds,
      seasons,
      episodes,
      files,
      formats,
      audioTracks,
      subtitleTracks,
      subtitles: subtitleTracks,
      chapters,
      skipMarkers,
      hasLocalFiles: Boolean(media.hasFiles),
    };
  }

  listPlaylists(): PlaylistRow[] {
    const ownPlaylists = this.readScopedPlaylists();
    if (ownPlaylists) return ownPlaylists.map(({ items: _items, ...row }) => row);
    const rows = this.core
      .select({ id: playlists.id, name: playlists.name, slug: playlists.slug, isSystem: playlists.isSystem, createdAt: playlists.createdAt })
      .from(playlists)
      .orderBy(desc(playlists.isSystem), asc(playlists.name))
      .all();
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      slug: row.slug ? String(row.slug) : null,
      isSystem: Boolean(row.isSystem),
      createdAt: String(row.createdAt),
    }));
  }

  // Cheap SELECT COUNT(*) variants — for callers that only need totals and
  // must NOT pay the O(media×tracks) cost of getSnapshot(). Used by the
  // runtime mirror push, which previously serialized the full library on
  // every write and blocked the main process event loop for 5–10s.
  getCountSummary(): { mediaCount: number; playlistCount: number } {
    const media = this.core
      .select({ value: sql<number>`COUNT(*)` })
      .from(mediaItems)
      .get();
    const lists = this.core
      .select({ value: sql<number>`COUNT(*)` })
      .from(playlists)
      .get();
    return {
      mediaCount: Number(media?.value ?? 0),
      playlistCount: Number(lists?.value ?? 0),
    };
  }

  private listPlaylistItemsMap(): Record<string, string[]> {
    const ownPlaylists = this.readScopedPlaylists();
    if (ownPlaylists) {
      // Newest first, like the main profile's `added_at DESC`.
      return Object.fromEntries(ownPlaylists.map((playlist) => [playlist.id, playlist.items.map((item) => item.mediaId).reverse()]));
    }
    const rows = this.core
      .select({ playlistId: playlistItems.playlistId, mediaId: playlistItems.mediaId })
      .from(playlistItems)
      .orderBy(desc(playlistItems.addedAt))
      .all();
    const map: Record<string, string[]> = {};
    rows.forEach((row) => {
      const playlistId = String(row.playlistId);
      if (!map[playlistId]) {
        map[playlistId] = [];
      }
      map[playlistId].push(String(row.mediaId));
    });
    return map;
  }

  /**
   * Every setting, as the active profile sees them: for a non-main profile the main profile's resume points and
   * track choices give way to the profile's own, at the same plain keys (`episode_resume_v1:<id>`,
   * `track_prefs_v1:<id>`), so every reader of those keys follows the active profile. Its `p:` rows stay listed.
   * Kept per-language texts (`localized_text_v1:`, LIB-LANG-02) are left out: one row per title and language,
   * read one at a time with `getSetting`, never through the snapshot.
   */
  private listSettingsMap(): Record<string, { value: string; updatedAt: string }> {
    const rows = this.core
      .select({ key: appSettings.key, value: appSettings.value, updatedAt: appSettings.updatedAt })
      .from(appSettings)
      .all();
    const map: Record<string, { value: string; updatedAt: string }> = {};
    const scope = this.viewingScope;
    const ownView = !isMainScope(scope);
    const isViewingKey = (key: string) => isResumeSpotKey(key) || key.startsWith(TRACK_PREFS_KEY_PREFIX);
    const own: Array<[string, { value: string; updatedAt: string }]> = [];
    rows.forEach((row) => {
      const key = String(row.key);
      if (isLocalizedTextKey(key)) return;
      const entry = { value: String(row.value), updatedAt: String(row.updatedAt) };
      if (ownView && isViewingKey(key)) return;
      map[key] = entry;
      if (!ownView || !key.startsWith(scope.prefix)) return;
      const bare = key.slice(scope.prefix.length);
      // "" = deleted: absent at the plain key, like a key never written.
      if (isViewingKey(bare) && entry.value !== "") own.push([bare, entry]);
    });
    for (const [key, entry] of own) map[key] = entry;
    return map;
  }

  /**
   * The library state the renderer mirrors. Deliberately excludes ingest job
   * EVENTS: they accumulate for the life of the library and nothing reads
   * them from the snapshot (#25) — per-job history is `listIngestJobEvents`.
   */
  getSnapshot(): LibrarySnapshot {
    return this.buildSnapshot(null);
  }

  /**
   * The snapshot with `mediaDetails` limited to `mediaIds`: every other list
   * (media rows, playlists, playlist items, ingest jobs, settings) is still
   * complete, so a consumer holding the previous snapshot can merge it. The
   * per-media detail reads dominate `getSnapshot` (~13 queries each).
   */
  getSnapshotDelta(mediaIds: string[]): LibrarySnapshot {
    return this.buildSnapshot(new Set(mediaIds));
  }

  private buildSnapshot(detailIds: Set<string> | null): LibrarySnapshot {
    const media = this.listMedia();
    const playlists = this.listPlaylists();
    const playlistItems = this.listPlaylistItemsMap();
    const snapshotIngestJobs = this.listIngestJobs();
    const scoped: ScopedViewingReads = { progress: this.readScopedMediaProgress(), playlists: this.readScopedPlaylists() };
    const mediaDetails = media
      .filter((item) => detailIds === null || detailIds.has(item.id))
      .map((item) => this.buildMediaDetails(item.id, scoped))
      .filter((item): item is MediaDetails => Boolean(item));
    const settings = this.listSettingsMap();
    return {
      media,
      playlists,
      playlistItems,
      mediaDetails,
      ingestJobs: snapshotIngestJobs,
      settings,
    };
  }

  private deleteMediaRecords(mediaId: string) {
    const ingestJobIds = this.ingest
      .select({ id: ingestJobs.id })
      .from(ingestJobs)
      .where(eq(ingestJobs.mediaId, mediaId))
      .all()
      .map((row) => String(row.id));
    if (ingestJobIds.length > 0) {
      this.ingest.delete(ingestJobEvents).where(inArray(ingestJobEvents.jobId, ingestJobIds)).run();
      this.ingest.delete(ingestJobs).where(inArray(ingestJobs.id, ingestJobIds)).run();
    }
    this.core.delete(mediaExternalIds).where(eq(mediaExternalIds.mediaId, mediaId)).run();
    this.core.delete(mediaGenres).where(eq(mediaGenres.mediaId, mediaId)).run();
    this.core.delete(playlistItems).where(eq(playlistItems.mediaId, mediaId)).run();
    this.metadata.delete(mediaRoles).where(eq(mediaRoles.mediaId, mediaId)).run();
    this.metadata.delete(mediaCrew).where(eq(mediaCrew.mediaId, mediaId)).run();
    this.metadata.delete(mediaTrailers).where(eq(mediaTrailers.mediaId, mediaId)).run();
    // Read before the tracks go, so their chunk lists go with them.
    const audioTrackIds = this.playback
      .select({ id: mediaAudioTracks.id })
      .from(mediaAudioTracks)
      .where(eq(mediaAudioTracks.mediaId, mediaId))
      .all()
      .map((row) => String(row.id));
    this.playback.delete(mediaAudioTracks).where(eq(mediaAudioTracks.mediaId, mediaId)).run();
    this.playback.delete(mediaSubtitles).where(eq(mediaSubtitles.mediaId, mediaId)).run();
    this.metadata.delete(mediaSkipMarkers).where(eq(mediaSkipMarkers.mediaId, mediaId)).run();
    this.templates.delete(mediaSkipAnalysis).where(eq(mediaSkipAnalysis.mediaId, mediaId)).run();
    this.templates.delete(subtitleOcrAttempts).where(eq(subtitleOcrAttempts.mediaId, mediaId)).run();
    this.metadata.delete(mediaSeasons).where(eq(mediaSeasons.mediaId, mediaId)).run();
    this.metadata.delete(mediaEpisodes).where(eq(mediaEpisodes.mediaId, mediaId)).run();
    const formatIds = this.playback
      .select({ id: mediaFormats.id })
      .from(mediaFormats)
      .where(eq(mediaFormats.mediaId, mediaId))
      .all()
      .map((row) => String(row.id));
    if (formatIds.length > 0) {
      this.playback.delete(mediaChapters).where(inArray(mediaChapters.formatId, formatIds)).run();
      this.playback.delete(mediaFormatChunks).where(inArray(mediaFormatChunks.formatId, formatIds)).run();
    }
    if (audioTrackIds.length > 0) {
      this.playback.delete(mediaAudioChunks).where(inArray(mediaAudioChunks.trackId, audioTrackIds)).run();
    }
    if (this.packedPlayback) {
      const sqlite = this.playbackSqlite;
      const ownerIds = [...formatIds, ...audioTrackIds];
      for (let offset = 0; offset < ownerIds.length; offset += 500) {
        const page = ownerIds.slice(offset, offset + 500);
        sqlite.prepare(`DELETE FROM media_chunk_lists WHERE owner_id IN (${page.map(() => "?").join(",")})`).run(...page);
      }
      sqlite.prepare("DELETE FROM media_file_playback WHERE media_id = ?").run(mediaId);
    }
    this.playback.delete(mediaFormats).where(eq(mediaFormats.mediaId, mediaId)).run();
    this.metadata.delete(mediaFileDesiredFormats).where(eq(mediaFileDesiredFormats.mediaId, mediaId)).run();
    this.metadata.delete(mediaFiles).where(eq(mediaFiles.mediaId, mediaId)).run();
    this.metadata.delete(mediaEditions).where(eq(mediaEditions.mediaId, mediaId)).run();
    this.core.delete(mediaItems).where(eq(mediaItems.id, mediaId)).run();
  }

  /**
   * Phase 5.2: route a per-op statement map into the right per-group SQLite
   * file via raw prepare/run. Drizzle is intentionally bypassed here — the
   * statement strings come from the shared builder and are the canonical
   * source of truth for both clients.
   */
  private executeOpStatementGroups(
    statements: OpStatementsByGroup,
    groups: ReadonlyArray<LibraryDbGroup>
  ) {
    for (const group of groups) {
      const list = statements[group];
      if (!list || list.length === 0) continue;
      const db = this.sqliteForGroup(group);
      // A remote page repeats the same few statement texts thousands of times: prepare each once per file.
      let cache = this.opStatementCache.get(db);
      if (!cache) {
        cache = new Map();
        this.opStatementCache.set(db, cache);
      }
      for (const stmt of list) {
        let prepared = cache.get(stmt.sql);
        if (!prepared) {
          prepared = db.prepare(stmt.sql) as { run(...params: unknown[]): unknown };
          cache.set(stmt.sql, prepared);
        }
        prepared.run(...stmt.params);
      }
    }
  }

  private sqliteForGroup(group: LibraryDbGroup): SqliteDatabase {
    switch (group) {
      case "core":
        return this.coreSqlite;
      case "metadata":
        return this.metadataSqlite;
      case "playback":
        return this.playbackSqlite;
      case "ingest":
        return this.ingestSqlite;
      case "templates":
        return this.templatesSqlite;
    }
  }

  /**
   * Legacy desktop guard from the pre-Phase-5 inline playback-apply path
   * (the `applyMedia*` helpers, removed once the shared op builder owned
   * apply). A media.upsert that claims hasFiles=true but carries no
   * files/formats/audio/subs/chapters is *suspected* corrupt — the shared
   * builder unconditionally emits `DELETE FROM media_audio_tracks WHERE
   * media_id = ?` etc. (see appendMediaMetadata / appendMediaPlayback in
   * library-db-definition/ops.ts), so applying such an op with empty
   * children would silently wipe existing rows.
   *
   * The guard is conditional on actual data being at risk: if the local
   * secondary tables have no rows for this mediaId, the delete-then-empty
   * insert pattern is a no-op and we MUST allow it. Suppressing
   * unconditionally blocks initial population from a fresh snapshot or
   * op-log replay against an empty per-group DB (the silent data-loss
   * bug fixed by this commit) — see @bugfix #library-secondary-suppress-empty-target.
   *
   * The shared builder doesn't know about this safety net (mobile doesn't
   * have it). We gate the secondary-group execution at the call site so
   * the same effect is preserved without leaking client policy into the
   * cross-client builder.
   */
  private shouldSuppressMediaUpsertSecondary(
    details: MediaDetails,
    existingMediaIds: ReadonlySet<string>
  ): boolean {
    const incomingPlaybackEmpty =
      details.files.length === 0 &&
      details.formats.length === 0 &&
      details.audioTracks.length === 0 &&
      details.subtitles.length === 0 &&
      details.chapters.length === 0;
    if (!incomingPlaybackEmpty) return false;
    if (!details.hasFiles) return false;
    return existingMediaIds.has(details.id);
  }

  /**
   * Snapshot the set of mediaIds with existing secondary-table data. Used
   * once per applySecondary invocation to gate the hasFiles-without-children
   * guard — see shouldSuppressMediaUpsertSecondary.
   *
   * Cost: one SELECT DISTINCT per probed table (5 total). Acceptable as a
   * pre-batch fixed cost; per-op set lookups stay O(1).
   */
  private collectMediaIdsWithSecondaryData(): ReadonlySet<string> {
    const ids = new Set<string>();
    const collect = (db: SqliteDatabase, table: string) => {
      try {
        const rows = db
          .prepare(`SELECT DISTINCT media_id FROM ${table};`)
          .all() as Array<{ media_id?: string }>;
        for (const row of rows) {
          if (row.media_id) ids.add(String(row.media_id));
        }
      } catch {
        // Table may not exist on certain surfaces — treat as no existing
        // data (the guard then permits the write).
      }
    };
    collect(this.metadataSqlite, "media_files");
    collect(this.playbackSqlite, "media_audio_tracks");
    collect(this.playbackSqlite, "media_subtitles");
    collect(this.playbackSqlite, "media_formats");
    collect(this.playbackSqlite, "media_chapters");
    return ids;
  }

  /**
   * LIB-SYNC-22: clears the metadata / playback / templates rows of every title `media_items` no longer holds, with
   * the statements a `media.delete` runs (so the list of tables stays in one place). Returns the titles cleared.
   */
  private pruneOrphanedSecondaryRows(): number {
    const ids = new Set(this.collectMediaIdsWithSecondaryData());
    try {
      for (const row of this.playbackSqlite.prepare("SELECT DISTINCT media_id FROM media_file_playback;").all() as Array<{ media_id?: string }>) {
        if (row.media_id) ids.add(String(row.media_id));
      }
    } catch {
      // Version-3 layout: no media_file_playback table.
    }
    const inCore = this.coreSqlite.prepare("SELECT 1 FROM media_items WHERE id = ?;");
    const orphans = [...ids].filter((id) => !inCore.get(id));
    if (orphans.length === 0) return 0;
    const packedPlayback = this.packedPlayback;
    const statements = orphans.map((mediaId) =>
      buildOpStatements({ id: randomUUID(), type: "media.delete", createdAt: nowIso(), payload: { mediaId } }, () => randomUUID(), { packedPlayback })
    );
    this.metadataSqlite.transaction(() => {
      for (const entry of statements) this.executeOpStatementGroups(entry, ["metadata"]);
    })();
    this.playbackSqlite.transaction(() => {
      for (const entry of statements) this.executeOpStatementGroups(entry, ["playback"]);
    })();
    this.templatesSqlite.transaction(() => {
      for (const entry of statements) this.executeOpStatementGroups(entry, ["templates"]);
    })();
    return orphans.length;
  }

  /**
   * Profile settings merge field by field (ACCT-SQUAD-03, same as phone/TV): the batch's `setting.set` ops of a
   * profile settings key are folded with this device's own row into one op before the ordinary apply.
   */
  private foldProfileSettingsOps(ops: LibraryOp[]): LibraryOp[] {
    const local = new Map<string, { value: string | null; updatedAt: string }>();
    for (const op of ops) {
      if (op.type !== "setting.set" || !isProfileSettingsKey(op.payload.key) || local.has(op.payload.key)) continue;
      const row = this.getSetting(op.payload.key);
      if (row) local.set(op.payload.key, row);
    }
    if (!ops.some((op) => op.type === "setting.set" && isProfileSettingsKey(op.payload.key))) return ops;
    logger.debug({ keys: [...local.keys()] }, "library.ops.profile_settings.fold");
    return mergeProfileSettingsOps(ops, local);
  }

  private async applyLibraryOps(ops: LibraryOp[]) {
    // Remote ops and snapshot rebases rewrite media the caller cannot name.
    this.changeUnattributed = true;
    if (!ops.length) return;
    // Remote state changes local details: the next local write must upload
    // even if it happens to reproduce what this instance queued before.
    this.lastQueuedUpsertSignature.clear();
    const normalizedOps = compactLibraryOps(this.foldProfileSettingsOps(ops));
    if (!normalizedOps.length) return;
    // LIB-FMT-12: version-4 ops exist only on a switched account (the server refuses them before the switch), so one
    // in the batch is the switch itself: convert first, then apply every op of the batch on the packed layout (the
    // translation makes the version-3 ops of the batch land the same as they would have before the conversion).
    if (!this.packedPlayback && normalizedOps.some(isVersion4Op)) {
      logger.info({ ops: normalizedOps.length }, "library.v4.convert: version-4 op received; converting before apply");
      this.adoptTargetOpStreamVersion({ targetOpStreamVersion: 4 });
    }
    const needsDetails = normalizedOps.some(isPlaybackBearingOp);
    if (needsDetails) {
      this.setDatasetStatus({ metadata: false, playback: false });
    }
    // Phase 5.2: build statement maps once per op; we'll reuse them in the
    // secondary phase below. The `core` and `ingest` groups apply now,
    // `metadata` + `playback` + `templates` defer.
    const packedPlayback = this.packedPlayback;
    const opsWithStatements = normalizedOps.map((op) => ({
      op,
      statements: buildOpStatements(op, () => randomUUID(), { packedPlayback }),
    }));
    this.applyingRemoteOps = true;
    try {
      // Phase 3.6: was `this.db.transaction(() => { ... })`. The ops span
      // every group (core / metadata / playback / ingest / templates) so a
      // single-DB transaction could only cover one of them in isolation —
      // SQLite has no cross-file transaction primitive without ATTACH (which
      // defeats per-file locking). One transaction per file per page (LIB-SYNC-15):
      // a page's statements commit together, and recovery stays with the version/snapshot machinery.
      this.coreSqlite.transaction(() => {
        for (const { statements } of opsWithStatements) this.executeOpStatementGroups(statements, ["core"]);
      })();
      this.ingestSqlite.transaction(() => {
        for (const { statements } of opsWithStatements) this.executeOpStatementGroups(statements, ["ingest"]);
      })();
    } finally {
      this.applyingRemoteOps = false;
    }
    if (!needsDetails) {
      if (!this.secondaryOpsInFlight) {
        this.setDatasetStatus({ metadata: true, playback: true });
      }
      return;
    }

    // LIB-SYNC-08: the core UPSERT ignores a media.upsert older than the stored
    // details. Its metadata/playback/templates statements live in other files
    // (no cross-file guard in SQL), so apply them only for upserts whose
    // `updated_at` the core row now carries. Version-4 playback ops carry their own clock (`media_file_playback`)
    // in their statements and always run, in stream order with the upserts; so does a `media.delete`, which clears
    // the title's rows in every file (LIB-SYNC-22: without it they outlived the title and quarantined publishing).
    const coreRowClock = this.sqliteForGroup("core").prepare("SELECT updated_at FROM media_items WHERE id = ?");
    const secondaryOps = opsWithStatements.filter(({ op }) => {
      if (op.type !== "media.upsert") return isSecondaryOnlyOp(op);
      const row = coreRowClock.get(op.payload.details.id) as { updated_at?: string } | undefined;
      return row?.updated_at === op.payload.details.updatedAt;
    });

    const applySecondary = async () => {
      try {
        // Phase 3.6 + 5.2: route per-DB transactions instead of the legacy
        // single-DB wrapper. Statements come from the shared builder; we
        // group the per-DB writes inside a single SQLite transaction per
        // file to preserve the batching the prior Drizzle implementation
        // had. The hasFiles-without-playback guard suppresses the entire
        // secondary write for that one op (see method comment above).
        //
        // The mediaIds-with-existing-data snapshot is taken ONCE here so
        // every transaction below uses the same baseline. A second batch
        // arriving while the first is still in flight is serialized through
        // `secondaryOpsInFlight`, so re-collecting the set per transaction
        // would buy nothing.
        const existingMediaIds = this.collectMediaIdsWithSecondaryData();
        const applied = secondaryOps.filter(({ op }) => {
          if (op.type !== "media.upsert" || !isV3MediaUpsert(op)) return true;
          if (!this.shouldSuppressMediaUpsertSecondary(op.payload.details, existingMediaIds)) return true;
          logger.warn({
            mediaId: op.payload.details.id,
            hasFiles: op.payload.details.hasFiles,
          }, "skipped incomplete playback payload");
          return false;
        });
        this.metadataSqlite.transaction(() => {
          for (const { statements } of applied) this.executeOpStatementGroups(statements, ["metadata"]);
        })();
        this.setDatasetStatus({ metadata: true });
        await saveCache({
          version: Math.max(this.version, this.remoteVersion),
          dbPath: getCacheDbPath(),
          updatedAt: nowIso(),
          stateHash: this.stateHash,
          lastOpId: this.lastOpId,
        });
        this.playbackSqlite.transaction(() => {
          for (const { statements } of applied) this.executeOpStatementGroups(statements, ["playback"]);
        })();
        // templates is desktop-only; mirror the playback-group transaction.
        this.templatesSqlite.transaction(() => {
          for (const { statements } of applied) this.executeOpStatementGroups(statements, ["templates"]);
        })();
        this.setDatasetStatus({ playback: true });
        await saveCache({
          version: Math.max(this.version, this.remoteVersion),
          dbPath: getCacheDbPath(),
          updatedAt: nowIso(),
          stateHash: this.stateHash,
          lastOpId: this.lastOpId,
        });
      } catch (error) {
        logger.warn({
          error: error instanceof Error ? error.message : String(error),
        }, "secondary dataset apply failed");
      }
    };

    const base = this.secondaryOpsInFlight ?? Promise.resolve();
    const next = base.then(applySecondary);
    const finalPromise = next.finally(() => {
      if (this.secondaryOpsInFlight === finalPromise) {
        this.secondaryOpsInFlight = null;
      }
    });
    this.secondaryOpsInFlight = finalPromise;
  }

  /**
   * Upload pendingOps in order. `maxOps` bounds the drain (#25 N4): a remote
   * sync flushes only what was queued when it started — on a saturated
   * uplink progress saves arrive faster than ops upload, so an unbounded
   * drain never ended and the sync never got to fetch. Ops left over go to
   * the normal debounced flush.
   */
  // tla: LibrarySync/FlushBuild
  // tla: LibrarySync/FlushRecv
  // tla: LibrarySync/FlushDone
  // tla: LibrarySync/FlushAfter409
  private async flushOps(maxOps = Number.POSITIVE_INFINITY) {
    if (this.closed || !this.syncEnabled || this.opsFlushInFlight) return;
    if (!this.pendingOps.length) return;
    if (!(await this.ensurePublishableState("ops"))) return;
    this.opsFlushInFlight = true;
    let flushedCount = 0;
    let stoppedAtLimit = false;
    try {
      while (this.pendingOps.length > 0) {
        if (flushedCount >= maxOps) {
          stoppedAtLimit = true;
          break;
        }
        // A closed instance (runtime re-open: db.close() then LibraryDb.open)
        // must stop uploading: the new instance owns pending_ops.json and
        // cache.json and already re-loaded this queue (issue #25 P7).
        if (this.closed) {
          logger.warn({ pendingOps: this.pendingOps.length }, "flushOps: instance closed — stopping upload loop");
          break;
        }
        const op = this.pendingOps[0];
        const payload = new TextEncoder().encode(JSON.stringify(op));
        const encrypted = await encryptOpPayload(this.keyBase64, payload);
        const prevStateHash = this.stateHash;
        const nextStateHash = deriveNextStateHash(prevStateHash, op.id, encrypted);
        try {
          const result = await putLibraryOp(
            this.token,
            this.remoteVersion,
            op.id,
            encrypted,
            { prevStateHash, nextStateHash },
            this.writtenOpStreamVersion()
          );
          if (this.closed) {
            logger.warn({ version: result.version }, "flushOps: instance closed during upload — leaving queue state to the reopened instance");
            break;
          }
          this.remoteVersion = result.version;
          if (this.pendingOps.length === 1) {
            this.version = Math.max(this.version, result.version);
          }
          this.stateHash = normalizeStateHash(result.stateHash ?? nextStateHash);
          this.lastOpId = result.lastOpId ?? op.id;
          this.pendingOps.shift();
          this.opsFlushConsecutiveFailures = 0;
          this.opsFlushBackoffMs = 2000;
          this.opsFlushConsecutive409 = 0;
          flushedCount += 1;
          this.countOpsTowardSnapshot(result.snapshotVersion, [op], [encrypted.length]);
          await savePendingOps(this.pendingOps);
          await saveCache({
            version: Math.max(this.version, this.remoteVersion),
            dbPath: getCacheDbPath(),
            updatedAt: nowIso(),
            stateHash: this.stateHash,
            lastOpId: this.lastOpId,
          });
        } catch (error) {
          this.opsFlushConsecutiveFailures += 1;
          if (error instanceof ApiError && error.status === 409) {
            this.opsFlushConsecutiveFailures = 0;
            this.opsFlushConsecutive409 += 1;
            // A 409 is routine (another device saved first), but a device stuck behind the server answers it on
            // every flush: log why and how often, and at the LIB-SYNC-16 threshold say once that sync looks stuck.
            // Logging only: the retry pace is unchanged here (LIB-SYNC-17 is pending on the desktop).
            const fields = {
              ...libraryRefusalFields(error, { baseVersion: this.remoteVersion, consecutive409: this.opsFlushConsecutive409 }),
              pendingOps: this.pendingOps.length,
            };
            if (this.opsFlushConsecutive409 === LIBRARY_SYNC_STUCK_AFTER_409S) {
              logger.warn(fields, "flushOps: server keeps refusing the op (409) — library sync looks stuck");
            } else {
              logger.info(fields, "flushOps: server refused the op (409) — syncing from the server before retrying");
            }
            await this.syncFromRemoteIfNewer().catch(() => undefined);
          } else if (
            error instanceof ApiError &&
            error.status === 426 &&
            error.payload.reason === "library_op_stream" &&
            typeof error.payload.opStreamVersion === "number" &&
            error.payload.opStreamVersion <= READ_OP_STREAM_VERSION &&
            this.targetOpStreamVersion < error.payload.opStreamVersion
          ) {
            // LIB-FMT-13: the account switched while this instance was writing version 3. Not "please update": convert
            // the local copy and send the same op again declaring 4.
            this.opsFlushConsecutiveFailures = 0;
            logger.info(
              { opStreamVersion: error.payload.opStreamVersion, requestId: error.requestId },
              "library.v4.convert: server says the account switched — converting before retrying the op"
            );
            this.adoptTargetOpStreamVersion({ targetOpStreamVersion: error.payload.opStreamVersion });
            continue;
          } else if (error instanceof ApiError && error.status === 413) {
            this.opsFlushQuotaExceeded = true;
            logger.error(
              { ...libraryRefusalFields(error, { baseVersion: this.remoteVersion, consecutive409: 0 }), pendingOps: this.pendingOps.length },
              "flushOps: server refused the op (413, quota exceeded) — ops stay queued, no retry until quota is freed"
            );
          } else {
            logger.warn(
              {
                ...libraryRefusalFields(error, { baseVersion: this.remoteVersion, consecutive409: 0 }),
                pendingOps: this.pendingOps.length,
                consecutiveFailures: this.opsFlushConsecutiveFailures,
                nextBackoffMs: Math.min(this.opsFlushBackoffMs, 30_000),
                error: error instanceof Error ? error.message : String(error),
              },
              "flushOps: op upload failed — will retry with backoff"
            );
          }
          break;
        }
      }
    } finally {
      this.opsFlushInFlight = false;
      if (this.pendingOps.length > 0) {
        if (this.opsFlushQuotaExceeded) return;
        if (stoppedAtLimit) {
          this.scheduleOpsFlush();
          return;
        }
        if (this.opsFlushConsecutiveFailures >= 5) {
          this.opsFlushCircuitOpen = true;
          logger.error(
            { pendingOps: this.pendingOps.length, consecutiveFailures: this.opsFlushConsecutiveFailures, cooldownMs: 60_000 },
            "flushOps: circuit open after repeated upload failures — pausing ops upload for 60 s"
          );
          this.opsFlushCircuitCooldownTimer = setTimeout(() => {
            this.opsFlushCircuitCooldownTimer = null;
            if (this.closed) return;
            this.opsFlushCircuitOpen = false;
            this.opsFlushConsecutiveFailures = 0;
            this.opsFlushBackoffMs = 2000;
            if (this.pendingOps.length > 0) this.scheduleOpsFlush(2000);
          }, 60_000);
          return;
        }
        const delay = Math.min(this.opsFlushBackoffMs, 30_000);
        this.opsFlushBackoffMs = Math.min(this.opsFlushBackoffMs * 2, 30_000);
        this.scheduleOpsFlush(delay);
      } else {
        this.opsFlushConsecutiveFailures = 0;
        this.opsFlushBackoffMs = 2000;
      }
    }
    if (flushedCount > 0) {
      await this.maybeCompactAfterOps().catch(() => undefined);
    }
  }

  /**
   * Count `ops` toward the snapshot thresholds (LIB-SYNC-07, LIB-SYNC-12): only
   * ops that are not progress-class count, so watching never causes a full
   * snapshot. `sizes[i]` is the ciphertext size of `ops[i]` as the server
   * stores it. The count belongs to one server `snapshotVersion`; a different
   * one means a snapshot was published since, and the count restarts.
   */
  private countOpsTowardSnapshot(
    snapshotVersion: number,
    ops: ReadonlyArray<{ type: string; payload?: unknown }>,
    sizes: ReadonlyArray<number>
  ) {
    let counted = 0;
    let bytes = 0;
    ops.forEach((op, index) => {
      if (isProgressClassOp(op)) return;
      counted += 1;
      bytes += sizes[index] ?? 0;
    });
    const current = this.opsSinceSnapshot;
    if (current.snapshotVersion === snapshotVersion && counted === 0) return;
    this.opsSinceSnapshot =
      current.snapshotVersion === snapshotVersion
        ? { ...current, count: current.count + counted, bytes: current.bytes + bytes }
        : { snapshotVersion, count: counted, bytes, bytesThreshold: SNAPSHOT_TAIL_BYTES_THRESHOLD };
    saveOpsSinceSnapshot(this.opsSinceSnapshot);
  }

  // tla: LibrarySync/CompactMeta
  // tla: LibrarySync/CompactSkip
  private async maybeCompactAfterOps() {
    // LIB-STORE-05: below the thresholds nothing is asked of the server, so a
    // progress-only flush (which never counts, LIB-SYNC-07) costs no meta GET.
    const counted = this.opsSinceSnapshot;
    const byCount = counted.count >= OPS_SNAPSHOT_THRESHOLD;
    if (!byCount && counted.bytes < counted.bytesThreshold) return;
    const meta = await getLibraryMeta(this.token).catch(() => null);
    if (!meta?.exists) return;
    this.adoptTargetOpStreamVersion(meta);
    if (counted.snapshotVersion !== meta.snapshotVersion) return;
    // LIB-SYNC-20: the full copy is this device's copy. Another device saved since this flush, so meta.version holds a
    // change this copy lacks: publishing on top of it would leave that change out of every copy a new reader gets.
    // The next flush after the sync that brings it in tries again.
    if (meta.version !== this.remoteVersion) return;
    const latestSnapshotMs = getLatestSnapshotMs(meta.snapshotHistory);
    if (latestSnapshotMs && Date.now() - latestSnapshotMs < SNAPSHOT_MIN_INTERVAL_MS) {
      return;
    }
    await this.uploadSnapshot(meta, byCount ? undefined : counted.bytes).catch((error: unknown) => {
      logger.error(
        { baseVersion: meta.version, error: error instanceof Error ? error.message : String(error) },
        "uploadSnapshot: compaction snapshot upload failed — will retry on a later flush"
      );
    });
  }

  /**
   * Publish the compaction snapshot on top of `meta.version`. The key check (PRIV-KEY-01) reuses the meta just read
   * by `maybeCompactAfterOps`, so reaching the threshold costs one meta GET (LIB-STORE-05). `maxBytes` is set when
   * the snapshot is due by tail bytes alone (LIB-SYNC-12): a snapshot larger than the tail it replaces is not
   * published, and the byte threshold rises to its size instead.
   */
  // tla: VaultKeys/Republish
  // tla: LibrarySync/CompactPut
  private async uploadSnapshot(meta: LibraryMeta, maxBytes?: number) {
    const expectedVersion = meta.version;
    if (!(await this.ensurePublishableState("snapshot"))) return;
    const checkedKeyProbe = await assertAccountLibraryKey(this.token, this.keyBase64, undefined, meta);
    const opStreamVersion = this.writtenOpStreamVersion();
    const rawBytes = this.buildCombinedExportBytes();
    const encrypted = await encryptSnapshotBytes(this.keyBase64, rawBytes);
    if (maxBytes !== undefined && encrypted.length > maxBytes) {
      this.opsSinceSnapshot = { ...this.opsSinceSnapshot, bytesThreshold: encrypted.length };
      saveOpsSinceSnapshot(this.opsSinceSnapshot);
      logger.info(
        { tailBytes: maxBytes, snapshotBytes: encrypted.length },
        "uploadSnapshot: snapshot larger than the op tail it would replace — not published (LIB-SYNC-12)"
      );
      return;
    }
    const chunks = buildChunks(encrypted);
    const snapshotId = randomUUID();
    const manifest = buildManifest(snapshotId, encrypted, rawBytes, chunks);
    const manifestPayload = await encryptBytesToBytes(
      this.keyBase64,
      new TextEncoder().encode(JSON.stringify(manifest))
    );
    const keyProbe = await createKeyProbe(this.keyBase64);
    const pending: PendingSync = {
      baseVersion: expectedVersion,
      snapshotId,
      chunkSize: CHUNK_SIZE_BYTES,
      snapshotPath: await savePendingSnapshotBytes(encrypted),
      manifestPath: await savePendingManifestBytes(manifestPayload),
      updatedAt: nowIso(),
      keyProbe,
      stateHash: this.stateHash,
      lastOpId: this.lastOpId,
      chunkRefs: chunks.map((entry) => entry.hash),
      opStreamVersion,
    };
    this.pendingSync = pending;
    await savePending(pending);

    await uploadChunks(this.token, chunks);
    // Send chunk hashes so the API can chunk-GC when this snapshot rotates
    // out of the kept window. Server can't read the encrypted manifest itself.
    const result = await putLibraryDb(
      this.token,
      pending.baseVersion,
      Buffer.from(manifestPayload).toString("base64"),
      pending.snapshotId,
      pending.chunkSize,
      pending.keyProbe,
      false,
      pending.stateHash ?? null,
      pending.lastOpId ?? null,
      undefined,
      pending.chunkRefs,
      DESKTOP_CHUNK_REFS_SOURCE,
      opStreamVersion,
      checkedKeyProbe
    );
    this.remoteVersion = result.version;
    this.stateHash = normalizeStateHash(result.stateHash ?? pending.stateHash ?? null);
    this.lastOpId = result.lastOpId ?? pending.lastOpId ?? null;
    if (!this.pendingOps.length) {
      this.version = Math.max(this.version, result.version);
    }
    this.pendingSync = null;
    await clearPending();
    await saveCache({
      version: Math.max(this.version, this.remoteVersion),
      dbPath: getCacheDbPath(),
      updatedAt: pending.updatedAt,
      stateHash: this.stateHash,
      lastOpId: this.lastOpId,
    });
  }

  listIngestJobs(mediaId?: string): IngestJob[] {
    const rows = (mediaId
      ? this.ingest
          .select()
          .from(ingestJobs)
          .where(eq(ingestJobs.mediaId, mediaId))
          .orderBy(desc(ingestJobs.updatedAt))
          .all()
      : this.ingest.select().from(ingestJobs).orderBy(desc(ingestJobs.updatedAt)).all()) as Array<
      typeof ingestJobs.$inferSelect
    >;
    return rows.map((row) => ({
      id: String(row.id),
      mediaId: String(row.mediaId),
      fileId: row.fileId ? String(row.fileId) : null,
      workerPeerId: String(row.workerPeerId),
      ownerClientId: row.ownerClientId ? String(row.ownerClientId) : null,
      kind: String(row.kind) as IngestJobKind,
      status: String(row.status) as IngestJobStatus,
      progressPct: Math.max(0, Math.min(100, Math.round(Number(row.progressPct ?? 0) || 0))),
      errorCode: row.errorCode ? String(row.errorCode) : null,
      errorMessage: row.errorMessage ? String(row.errorMessage) : null,
      meta: parseRecordJson(row.metaJson),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      completedAt: row.completedAt ? String(row.completedAt) : null,
    }));
  }

  private getIngestJobById(jobId: string): IngestJob | null {
    const row = this.ingest
      .select()
      .from(ingestJobs)
      .where(eq(ingestJobs.id, jobId))
      .limit(1)
      .all()[0] as typeof ingestJobs.$inferSelect | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      mediaId: String(row.mediaId),
      fileId: row.fileId ? String(row.fileId) : null,
      workerPeerId: String(row.workerPeerId),
      ownerClientId: row.ownerClientId ? String(row.ownerClientId) : null,
      kind: String(row.kind) as IngestJobKind,
      status: String(row.status) as IngestJobStatus,
      progressPct: Math.max(0, Math.min(100, Math.round(Number(row.progressPct ?? 0) || 0))),
      errorCode: row.errorCode ? String(row.errorCode) : null,
      errorMessage: row.errorMessage ? String(row.errorMessage) : null,
      meta: parseRecordJson(row.metaJson),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      completedAt: row.completedAt ? String(row.completedAt) : null,
    };
  }

  listIngestJobEvents(jobId: string): IngestJobEvent[] {
    const rows = this.ingest
      .select()
      .from(ingestJobEvents)
      .where(eq(ingestJobEvents.jobId, jobId))
      .orderBy(asc(ingestJobEvents.createdAt))
      .all() as Array<typeof ingestJobEvents.$inferSelect>;
    return rows.map((row) => ({
      id: String(row.id),
      jobId: String(row.jobId),
      level: String(row.level) as IngestJobEventLevel,
      message: String(row.message),
      meta: parseRecordJson(row.metaJson),
      createdAt: String(row.createdAt),
    }));
  }

  upsertIngestJob(input: IngestJobUpsertInput) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    const progressPct = Math.max(0, Math.min(100, Math.round(Number(input.progressPct ?? 0) || 0)));
    const metaJson = input.meta ? JSON.stringify(input.meta) : null;
    this.ingest
      .insert(ingestJobs)
      .values({
        id: input.id,
        mediaId: input.mediaId,
        fileId: input.fileId ?? null,
        workerPeerId: input.workerPeerId,
        ownerClientId: input.ownerClientId ?? null,
        kind: input.kind,
        status: input.status,
        progressPct,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        metaJson,
        createdAt,
        updatedAt,
        completedAt: input.completedAt ?? null,
      })
      .onConflictDoUpdate({
        target: ingestJobs.id,
        set: {
          mediaId: input.mediaId,
          fileId: input.fileId ?? null,
          workerPeerId: input.workerPeerId,
          ownerClientId: input.ownerClientId ?? null,
          kind: input.kind,
          status: input.status,
          progressPct,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          metaJson,
          updatedAt,
          completedAt: input.completedAt ?? null,
        },
      })
      .run();
    const job = this.getIngestJobById(input.id);
    if (job) {
      void this.queueOp({
        id: randomUUID(),
        type: "ingest.job.upsert",
        createdAt: nowIso(),
        payload: { job },
      });
    }
    return this.persist({ mediaFree: true });
  }

  patchIngestJob(jobId: string, patch: IngestJobPatchInput) {
    const setValues: Partial<typeof ingestJobs.$inferInsert> = { updatedAt: nowIso() };
    if (patch.status !== undefined) setValues.status = patch.status;
    if (patch.progressPct !== undefined) {
      setValues.progressPct = Math.max(0, Math.min(100, Math.round(Number(patch.progressPct) || 0)));
    }
    if (patch.errorCode !== undefined) setValues.errorCode = patch.errorCode;
    if (patch.errorMessage !== undefined) setValues.errorMessage = patch.errorMessage;
    if (patch.meta !== undefined) setValues.metaJson = patch.meta ? JSON.stringify(patch.meta) : null;
    if (patch.completedAt !== undefined) setValues.completedAt = patch.completedAt;
    if (patch.workerPeerId !== undefined) setValues.workerPeerId = patch.workerPeerId ?? undefined;
    if (patch.ownerClientId !== undefined) setValues.ownerClientId = patch.ownerClientId;
    this.ingest
      .update(ingestJobs)
      .set(setValues)
      .where(eq(ingestJobs.id, jobId))
      .run();
    const job = this.getIngestJobById(jobId);
    if (job) {
      void this.queueOp({
        id: randomUUID(),
        type: "ingest.job.upsert",
        createdAt: nowIso(),
        payload: { job },
      });
    }
    return this.persist({ mediaFree: true });
  }

  completeIngestJob(
    jobId: string,
    status: Extract<IngestJobStatus, "completed" | "failed" | "cancelled">,
    options?: {
      errorCode?: string | null;
      errorMessage?: string | null;
      progressPct?: number;
      meta?: Record<string, unknown> | null;
    }
  ) {
    return this.patchIngestJob(jobId, {
      status,
      progressPct: options?.progressPct ?? (status === "completed" ? 100 : undefined),
      errorCode: options?.errorCode ?? null,
      errorMessage: options?.errorMessage ?? null,
      meta: options?.meta,
      completedAt: nowIso(),
    });
  }

  deleteIngestJob(jobId: string) {
    this.ingest.delete(ingestJobEvents).where(eq(ingestJobEvents.jobId, jobId)).run();
    this.ingest.delete(ingestJobs).where(eq(ingestJobs.id, jobId)).run();
    void this.queueOp({
      id: randomUUID(),
      type: "ingest.job.delete",
      createdAt: nowIso(),
      payload: { jobId },
    });
    return this.persist({ mediaFree: true });
  }

  clearIngestJobHistory(mediaId: string) {
    const terminal = new Set<IngestJobStatus>(["completed", "failed", "cancelled"]);
    const rows = this.ingest
      .select({ id: ingestJobs.id, status: ingestJobs.status })
      .from(ingestJobs)
      .where(eq(ingestJobs.mediaId, mediaId))
      .all();
    const ids = rows
      .filter((row) => terminal.has(String(row.status) as IngestJobStatus))
      .map((row) => String(row.id));
    if (ids.length === 0) return this.persist({ mediaFree: true });
    this.ingest.delete(ingestJobEvents).where(inArray(ingestJobEvents.jobId, ids)).run();
    this.ingest.delete(ingestJobs).where(inArray(ingestJobs.id, ids)).run();
    void this.queueOp({
      id: randomUUID(),
      type: "ingest.job.history.clear",
      createdAt: nowIso(),
      payload: { mediaId },
    });
    return this.persist({ mediaFree: true });
  }

  addIngestJobEvent(input: IngestJobEventInput) {
    const eventId = randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    this.ingest
      .insert(ingestJobEvents)
      .values({
        id: eventId,
        jobId: input.jobId,
        level: input.level,
        message: input.message,
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
        createdAt,
      })
      .run();
    void this.queueOp({
      id: randomUUID(),
      type: "ingest.job.event.add",
      createdAt: nowIso(),
      payload: {
        event: {
          id: eventId,
          jobId: input.jobId,
          level: input.level,
          message: input.message,
          meta: input.meta ?? null,
          createdAt,
        },
      },
    });
    return this.persist({ mediaFree: true });
  }

  listPlaylistItems(playlistId: string): string[] {
    const ownPlaylists = this.readScopedPlaylists();
    if (ownPlaylists) {
      const items = ownPlaylists.find((playlist) => playlist.id === playlistId)?.items ?? [];
      return items.map((item) => item.mediaId).reverse();
    }
    const rows = this.core
      .select({ mediaId: playlistItems.mediaId })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId))
      .orderBy(desc(playlistItems.addedAt))
      .all();
    return rows.map((row) => String(row.mediaId));
  }

  createPlaylist(name: string) {
    const id = randomUUID();
    const timestamp = nowIso();
    if (!isMainScope(this.viewingScope)) {
      const playlist: ProfilePlaylist = { name, slug: null, isSystem: false, items: [], createdAt: timestamp, updatedAt: timestamp };
      this.writeSettingRow(scopedPlaylistKey(this.viewingScope, id), serializeProfilePlaylist(playlist), timestamp);
      return this.persist({ mediaFree: true });
    }
    this.core.insert(playlists).values({ id, name, slug: null, isSystem: false, createdAt: timestamp }).run();
    void this.queueOp({
      id: randomUUID(),
      type: "playlist.create",
      createdAt: timestamp,
      payload: { id, name, slug: null, isSystem: false, createdAt: timestamp },
    });
    return this.persist({ mediaFree: true });
  }

  deletePlaylist(playlistId: string) {
    if (!isMainScope(this.viewingScope)) {
      const timestamp = nowIso();
      const playlist = this.readScopedPlaylist(playlistId, timestamp);
      // Same rule as the main profile's tables: a system playlist (favorites) is never deleted.
      if (!playlist || playlist.isSystem) return this.persist({ mediaFree: true });
      for (const item of playlist.items) this.noteMediaChanged(item.mediaId);
      this.writeSettingRow(scopedPlaylistKey(this.viewingScope, playlistId), "", timestamp);
      return this.persist({ mediaFree: playlist.items.length === 0 });
    }
    // Removing the playlist drops its items, which changes `playlistIds` in the
    // details of every media that was in it.
    this.core
      .select({ mediaId: playlistItems.mediaId })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId))
      .all()
      .forEach((row) => this.noteMediaChanged(String(row.mediaId)));
    this.core
      .delete(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.isSystem, false)))
      .run();
    void this.queueOp({
      id: randomUUID(),
      type: "playlist.delete",
      createdAt: nowIso(),
      payload: { id: playlistId },
    });
    return this.persist();
  }

  addToPlaylist(playlistId: string, mediaId: string) {
    const timestamp = nowIso();
    if (!isMainScope(this.viewingScope)) return this.writeScopedPlaylistItem(playlistId, mediaId, "add", timestamp);
    const itemId = randomUUID();
    this.core
      .insert(playlistItems)
      .values({ id: itemId, playlistId, mediaId, addedAt: timestamp })
      .onConflictDoNothing()
      .run();
    void this.queueOp({
      id: randomUUID(),
      type: "playlist.item.add",
      createdAt: timestamp,
      payload: { id: itemId, playlistId, mediaId, addedAt: timestamp },
    });
    this.noteMediaChanged(mediaId);
    return this.persist();
  }

  removeFromPlaylist(playlistId: string, mediaId: string) {
    if (!isMainScope(this.viewingScope)) return this.writeScopedPlaylistItem(playlistId, mediaId, "remove", nowIso());
    this.core
      .delete(playlistItems)
      .where(and(eq(playlistItems.playlistId, playlistId), eq(playlistItems.mediaId, mediaId)))
      .run();
    void this.queueOp({
      id: randomUUID(),
      type: "playlist.item.remove",
      createdAt: nowIso(),
      payload: { playlistId, mediaId },
    });
    this.noteMediaChanged(mediaId);
    return this.persist();
  }

  /** A non-main profile's playlist membership change: one rewrite of its `p:<profileId>:playlist_v1:<id>` record. */
  private writeScopedPlaylistItem(playlistId: string, mediaId: string, change: "add" | "remove", timestamp: string) {
    const playlist = this.readScopedPlaylist(playlistId, timestamp);
    if (!playlist) return this.persist({ mediaFree: true });
    const next =
      change === "add" ? addProfilePlaylistItem(playlist, mediaId, timestamp) : removeProfilePlaylistItem(playlist, mediaId, timestamp);
    this.writeSettingRow(scopedPlaylistKey(this.viewingScope, playlistId), serializeProfilePlaylist(next), timestamp);
    this.noteMediaChanged(mediaId);
    return this.persist();
  }

  getSystemPlaylistId(slug: "favorites") {
    // A non-main profile's favorites live at a fixed id (`p:<profileId>:playlist_v1:favorites`), as on phone/TV.
    if (!isMainScope(this.viewingScope)) return FAVORITES_PLAYLIST_ID;
    const row = this.core
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.slug, slug), eq(playlists.isSystem, true)))
      .limit(1)
      .all()[0];
    return row?.id ? String(row.id) : null;
  }

  /**
   * Delete a media item and reclaim its storage.
   *
   * Layer 1 of the storage-tracker-refactor: every
   * chunk-and-object key the media owned must be forwarded to /storage/delete
   * BEFORE the SQLite rows are dropped — otherwise the keys leak (F1) because
   * once mediaFormatChunks/mediaAudioChunks/mediaSubtitles are gone the local
   * snapshot can no longer name them.
   *
   * Returns shape: `{ deletedKeys, reclaimedBytes }` describing what was
   * forwarded to the API. Local SQLite delete proceeds regardless of API
   * outcome (scheduled GC reclaims any orphans left by a transient API
   * failure), so callers don't have to retry.
   */
  async deleteMedia(mediaId: string): Promise<{ deletedKeys: number; reclaimedBytes: number }> {
    // STOR-PLACE-10: the title's own artwork goes with it; a photo another title still shows stays.
    const details = this.getMediaDetails(mediaId);
    const keys = details ? collectMediaDeleteKeys(details, (personId) => this.personInOtherTitle(personId, mediaId)) : [];
    let deletedKeys = 0;
    let reclaimedBytes = 0;
    if (keys.length > 0 && this.token) {
      try {
        const result = await deleteStorageObjects(this.token, keys);
        deletedKeys = result.deleted ?? 0;
        reclaimedBytes = (result as { reclaimedBytes?: number }).reclaimedBytes ?? 0;
      } catch (error) {
        console.warn(
          `[libraryDb] deleteMedia: /storage/delete failed for ${keys.length} key(s), proceeding with local delete (GC will reclaim):`,
          error
        );
      }
    } else if (keys.length > 0) {
      console.warn(
        `[libraryDb] deleteMedia: no token — ${keys.length} key(s) deferred to GC`
      );
    }
    void this.queueOp({
      id: randomUUID(),
      type: "media.delete",
      createdAt: nowIso(),
      payload: { mediaId },
    });
    // Read before the delete: it removes the episode rows the resume keys are named after.
    const episodeIds = this.metadata
      .select({ id: mediaEpisodes.id })
      .from(mediaEpisodes)
      .where(eq(mediaEpisodes.mediaId, mediaId))
      .all()
      .map((row) => String(row.id));
    await this.deleteMediaInternal(mediaId, true);
    // Every non-main profile's state of the title (progress, track choice, its episodes' resume points, playlist
    // entries) is cleared with `setting.set` ops the other devices follow (`planMediaDeleteProfileCleanup`).
    const now = nowIso();
    const writes = planMediaDeleteProfileCleanup({ mediaId, episodeIds, rows: this.readSettingRows("p:"), now });
    for (const { key, value } of writes) this.writeSettingRow(key, value, now);
    logger.info({ mediaId, episodes: episodeIds.length, keys: writes.length }, "library.deleteMedia.profiles");
    if (writes.length > 0) await this.persist();
    return { deletedKeys, reclaimedBytes };
  }

  /**
   * Delete ONE episode of a show (INTG-DEL-01: Kodi / Jellyfin "delete this episode"). Same semantics as
   * `deleteMedia`, scoped to the episode's file: its chunk/object keys are forwarded to /storage/delete first,
   * then `deleteMediaFile` drops the file, formats and the episode's audio/subtitle tracks and queues the media
   * upsert. The show and the episode's metadata row stay (the episode simply has no file any more).
   * Returns zero keys when the episode has no file (already deleted).
   */
  async deleteEpisode(mediaId: string, episodeId: string): Promise<{ deletedKeys: number; reclaimedBytes: number; deletedFile: boolean }> {
    const details = this.getMediaDetails(mediaId);
    const episode = details?.episodes.find((entry) => entry.id === episodeId);
    const file = details && episode ? details.files.find((entry) => entry.season === episode.seasonNumber && entry.episode === episode.episodeNumber) : null;
    if (!details || !episode || !file) return { deletedKeys: 0, reclaimedBytes: 0, deletedFile: false };
    const keys = collectMediaStorageKeys(details, { fileId: file.id, episodeId });
    let deletedKeys = 0;
    let reclaimedBytes = 0;
    if (keys.length > 0 && this.token) {
      try {
        const result = await deleteStorageObjects(this.token, keys);
        deletedKeys = result.deleted ?? 0;
        reclaimedBytes = (result as { reclaimedBytes?: number }).reclaimedBytes ?? 0;
      } catch (error) {
        console.warn(
          `[libraryDb] deleteEpisode: /storage/delete failed for ${keys.length} key(s), proceeding with local delete (GC will reclaim):`,
          error
        );
      }
    }
    this.deleteMediaFile(file.id);
    return { deletedKeys, reclaimedBytes, deletedFile: true };
  }

  /**
   * Gather every chunk-and-object key owned by a media item — formats[].initKey,
   * formats[].chunks[].key, formats[].previewSheets sheet keys, audioTracks[].initKey,
   * audioTracks[].chunks[].key, subtitleTracks[].objectKey. Returned keys are deduplicated. If the media
   * item is gone, returns an empty list.
   */
  collectMediaStorageKeys(mediaId: string): string[] {
    const details = this.getMediaDetails(mediaId);
    return details ? collectMediaStorageKeys(details) : [];
  }

  private deleteMediaInternal(mediaId: string, persist: boolean) {
    this.deleteMediaRecords(mediaId);
    if (persist) {
      this.noteMediaChanged(mediaId);
      return this.persist();
    }
    return true;
  }

  getDebugSnapshot() {
    return {
      version: this.version,
      remoteVersion: this.remoteVersion,
      pendingSync: Boolean(this.pendingSync),
      mediaItems: this.core.select().from(mediaItems).orderBy(desc(mediaItems.addedAt)).all(),
      mediaFiles: this.metadata.select().from(mediaFiles).orderBy(desc(mediaFiles.addedAt)).all(),
      mediaFileDesiredFormats: this.metadata.select().from(mediaFileDesiredFormats).all(),
      mediaGenres: this.core.select().from(mediaGenres).all(),
      mediaExternalIds: this.core.select().from(mediaExternalIds).all(),
      people: this.metadata.select().from(people).all(),
      peopleExternalIds: this.metadata.select().from(peopleExternalIds).all(),
      mediaRoles: this.metadata.select().from(mediaRoles).all(),
      mediaSeasons: this.metadata.select().from(mediaSeasons).orderBy(asc(mediaSeasons.seasonNumber)).all(),
      mediaEpisodes: this.metadata
        .select()
        .from(mediaEpisodes)
        .orderBy(asc(mediaEpisodes.seasonNumber), asc(mediaEpisodes.episodeNumber))
        .all(),
      mediaTrailers: this.metadata.select().from(mediaTrailers).all(),
      mediaFormats: this.playback.select().from(mediaFormats).all(),
      mediaFormatChunks: this.playback.select().from(mediaFormatChunks).all(),
      mediaAudioTracks: this.playback.select().from(mediaAudioTracks).all(),
      mediaAudioChunks: this.playback.select().from(mediaAudioChunks).all(),
      mediaChapters: this.playback.select().from(mediaChapters).all(),
      mediaSkipAnalysis: this.templates.select().from(mediaSkipAnalysis).all(),
      mediaSkipMarkers: this.metadata.select().from(mediaSkipMarkers).all(),
      ingestJobs: this.ingest.select().from(ingestJobs).orderBy(desc(ingestJobs.updatedAt)).all(),
      ingestJobEvents: this.ingest
        .select()
        .from(ingestJobEvents)
        .orderBy(desc(ingestJobEvents.createdAt))
        .all(),
      appSettings: this.core.select().from(appSettings).orderBy(desc(appSettings.updatedAt)).all(),
      playlists: this.core.select().from(playlists).orderBy(desc(playlists.createdAt)).all(),
      playlistItems: this.core.select().from(playlistItems).orderBy(desc(playlistItems.addedAt)).all(),
    };
  }

  // tla: LibrarySync/FlushAfter409
  async syncFromRemoteIfNewer(metaOverride?: LibraryMeta | null) {
    const prepared = await this.prepareRemoteSync(metaOverride);
    if (prepared.kind === "none") return false;
    return this.applyRemoteSync(prepared);
  }

  /**
   * Network half of `syncFromRemoteIfNewer` (#25 N4): drains local writes to
   * the API (flushPending / flushOps), reads meta, and downloads + decrypts
   * the remote ops or snapshot. Touches no library rows, so the runtime runs
   * it OUTSIDE its single op gate — on a throttled uplink this phase held
   * the gate for minutes and every read and write queued behind it. Pair
   * with `applyPreparedRemoteSync`, which the runtime runs inside the gate.
   */
  // tla: LibrarySync/SyncFlush
  // tla: LibrarySync/SyncMeta
  // tla: LibrarySync/SyncFetch
  async prepareRemoteSync(metaOverride?: LibraryMeta | null): Promise<PreparedRemoteSync> {
    if (this.closed || !this.syncEnabled) {
      return { kind: "none" };
    }
    // Upload only what was queued when this sync started (see flushOps).
    const maxOps = this.pendingOps.length;
    if (this.pendingSync && !this.opsFlushQuotaExceeded && !this.opsFlushCircuitOpen) {
      await this.flushPending({ maxOps }).catch(() => undefined);
    }
    if (!this.opsFlushQuotaExceeded && !this.opsFlushCircuitOpen) {
      await this.flushOps(maxOps).catch(() => undefined);
    }
    const meta = metaOverride ?? (await getLibraryMeta(this.token));
    if (meta.syncUnavailable) return { kind: "none" };
    if (!meta.exists) return { kind: "none" };
    // LIB-FMT-12: this device's unsent changes went above in the version it held; a switched account converts the
    // local copy now, before anything newer than the server's head is applied to it.
    this.adoptTargetOpStreamVersion(meta);
    // A meta older than this device's base (read before this sync's own flushOps uploaded, or queued behind a
    // newer one) describes a state the server has left: adopting its hash sent the next op with a stale
    // prevStateHash at the current version, refused 409 lineage_conflict (2026-11-22). The flush already holds
    // the hash the server acknowledged.
    if (meta.version >= this.remoteVersion) {
      this.stateHash = normalizeStateHash(meta.stateHash);
      this.lastOpId = meta.lastOpId ?? this.lastOpId;
    }
    if (meta.version <= this.remoteVersion) {
      await this.publishConvertedCopy(meta);
      return { kind: "none" };
    }

    const fromVersion = this.remoteVersion;
    let opsResult = await getLibraryOps(this.token, fromVersion);
    // Part B — op-stream version gate. Fail fast BEFORE downloading or
    // decrypting any op payload: if the server's op stream is a newer format
    // than this build understands, applying it would silently drop the
    // unknown op types (the pre-versioning bug). LibraryFormatTooNewError
    // propagates out so the renderer shows the "app too old" modal.
    assertLibraryCompatible(
      { opStreamVersion: opsResult.opStreamVersion },
      DESKTOP_LIBRARY_SUPPORT
    );
    // LIB-SYNC-06: only the server saying `tooOld` justifies a snapshot. An
    // empty list with tooOld=false means this device is up to date (the
    // version moved by a snapshot commit, not by any op): fall through, adopt
    // `opsResult.version`, download nothing.
    if (opsResult.tooOld) {
      return this.prepareRemoteSnapshot(meta, fromVersion);
    }
    // The server pages a long op tail (`hasMore`): `version` of a partial page
    // is its last op, the next page starts there. Collect every page before
    // applying so the version/state hash adopted below match what was applied.
    let entries = [...opsResult.ops];
    let toVersion = opsResult.version;
    while (opsResult.hasMore && opsResult.ops.length > 0) {
      opsResult = await getLibraryOps(this.token, toVersion);
      assertLibraryCompatible(
        { opStreamVersion: opsResult.opStreamVersion },
        DESKTOP_LIBRARY_SUPPORT
      );
      if (opsResult.tooOld) {
        return this.prepareRemoteSnapshot(meta, fromVersion);
      }
      entries.push(...opsResult.ops);
      toVersion = opsResult.version;
    }
    // LIB-SYNC-19: the device moves to `toVersion` with the hash AT `toVersion`, never meta's: another device's op
    // can land between the meta read and the ops read, and chaining on meta's older hash had the next op refused
    // 409 lineage_conflict. The last page names that hash; a server from before the field names none, and the
    // device then stops at the version its meta named, whose hash it read (the rest comes with the next sync).
    let toStateHash: string | null;
    if (opsResult.stateHash !== undefined) {
      toStateHash = normalizeStateHash(opsResult.stateHash);
    } else {
      if (toVersion > meta.version) {
        entries = entries.filter((entry) => entry.version <= meta.version);
        toVersion = meta.version;
      }
      toStateHash = normalizeStateHash(meta.stateHash);
    }
    const toLastOpId = entries.at(-1)?.opId ?? meta.lastOpId ?? null;

    const ops: LibraryOp[] = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (entry) => {
          // Prefer the inline ciphertext shipped by the API (postgres copy) so
          // we don't depend on gateway storage having the blob. Tunnel download remains
          // the fallback when older API versions omit the inline field.
          const inlineCiphertext = entry.payloadCiphertext;
          const payload = inlineCiphertext
            ? new Uint8Array(Buffer.from(inlineCiphertext, "base64"))
            : await downloadObjectViaDedicatedSession(this.token, entry.objectKey);
          const decrypted = await decryptLibraryPayload(this.keyBase64, payload).catch(() => {
            throw new Error("DECRYPT_FAILED");
          });
          return JSON.parse(new TextDecoder().decode(decrypted)) as LibraryOp;
        })
      );
      ops.push(...results);
    }
    return {
      kind: "ops",
      meta,
      fromVersion,
      toVersion,
      stateHash: toStateHash,
      lastOpId: toLastOpId,
      ops,
      opSizes: entries.map((entry) => entry.size),
    };
  }

  /**
   * Local half of `syncFromRemoteIfNewer`: applies what `prepareRemoteSync`
   * fetched. Returns `"stale"` when `remoteVersion` moved since the prepare
   * (a concurrent ops flush committed, or another sync applied) — the
   * fetched ops/snapshot no longer start at this instance's base, so the
   * caller must run the full `syncFromRemoteIfNewer` instead.
   */
  // tla: LibrarySync/SyncApply
  async applyPreparedRemoteSync(prepared: PreparedRemoteSync): Promise<boolean | "stale"> {
    if (prepared.kind === "none") return false;
    if (this.closed) return false;
    if (this.remoteVersion !== prepared.fromVersion) {
      logger.info({
        kind: prepared.kind,
        preparedFromVersion: prepared.fromVersion,
        remoteVersion: this.remoteVersion,
      }, "applyPreparedRemoteSync: remote base moved since prepare — stale");
      return "stale";
    }
    return this.applyRemoteSync(prepared);
  }

  private async applyRemoteSync(prepared: Exclude<PreparedRemoteSync, { kind: "none" }>): Promise<boolean> {
    const changed = prepared.kind === "snapshot" ? await this.applyRemoteSnapshot(prepared) : await this.applyRemoteOps(prepared);
    await this.publishConvertedCopy(prepared.meta);
    return changed;
  }

  /**
   * LIB-FMT-12 (c): the first converted device of a switched account publishes its converted library as a full copy
   * declaring op stream 4; from then on the server holds the account at 4. Only from the server's head with nothing
   * unsent, so the copy holds exactly the server's library. Two devices racing are serialised by the base-version
   * check (LIB-SYNC-01): the loser's 409 leaves its converted copy in place, never downloads the winner's.
   */
  // tla: LibrarySync/SyncPublish
  private async publishConvertedCopy(meta: LibraryMeta) {
    if (!this.packedPlayback || this.targetOpStreamVersion < 4 || (meta.opStreamVersion ?? 0) >= 4) return;
    if (this.closed || this.pendingOps.length > 0 || this.remoteVersion !== meta.version) return;
    const startedAt = performance.now();
    try {
      await this.uploadSnapshot(meta);
      logger.info(
        {
          baseVersion: meta.version,
          version: this.remoteVersion,
          published: this.remoteVersion !== meta.version,
          ms: Math.round(performance.now() - startedAt),
        },
        "library.v4.convert: converted full copy upload (op stream 4)"
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        logger.info(
          libraryRefusalFields(error, { baseVersion: meta.version, consecutive409: 1 }),
          "library.v4.convert: another device published first — keeping this converted copy"
        );
        // The loser's copy was built on a base that never comes back (as in flushPending's 409).
        await this.clearPendingSync().catch(() => undefined);
        return;
      }
      logger.error(
        { baseVersion: meta.version, error: error instanceof Error ? error.message : String(error) },
        "library.v4.convert: converted full copy upload failed — retried on the next sync"
      );
    }
  }

  // tla: LibrarySync/SyncApply
  private async applyRemoteOps(prepared: Extract<PreparedRemoteSync, { kind: "ops" }>): Promise<boolean> {
    const { meta, ops } = prepared;
    // Rebase local, not-yet-acknowledged writes on top of the remote ops.
    // `ops` is "everything after remoteVersion", which includes this
    // device's OWN ops whose PUT response this instance has not processed
    // yet (in flight in flushOps, or committed by a just-closed instance
    // after LibraryDb.open read meta). Applying `ops` alone rolled newer
    // local rows (e.g. playback progress) back to those older values, and
    // pendingOps were never re-applied (issue #25 P7). The server orders
    // pendingOps AFTER `ops` (they upload with a base >= opsResult.version),
    // so remote-then-pending is the state the server converges to.
    // PendingOp is the persisted JSON shape of a LibraryOp (queueOp's input).
    const rebasedPending = this.pendingOps as unknown as LibraryOp[];
    logger.info({
      remoteOps: ops.length,
      rebasedPendingOps: rebasedPending.length,
      fromVersion: this.remoteVersion,
      toVersion: prepared.toVersion,
    }, "syncFromRemoteIfNewer: applying remote ops + rebasing pending local ops");
    if (ops.length > 0) await this.applyLibraryOps([...ops, ...rebasedPending]);
    this.countOpsTowardSnapshot(meta.snapshotVersion, ops, prepared.opSizes);
    this.remoteVersion = prepared.toVersion;
    if (!this.pendingOps.length) {
      this.version = Math.max(this.version, prepared.toVersion);
    }
    this.stateHash = prepared.stateHash;
    this.lastOpId = prepared.lastOpId ?? this.lastOpId;
    await saveCache({
      version: Math.max(this.version, this.remoteVersion),
      dbPath: getCacheDbPath(),
      updatedAt: meta.updatedAt ?? nowIso(),
      stateHash: this.stateHash,
      lastOpId: this.lastOpId,
    });
    // `true` = remote data changed local rows (callers reload on it). An empty
    // op list only moved the version (LIB-SYNC-06).
    return ops.length > 0;
  }

  private async prepareRemoteSnapshot(meta: LibraryMeta, fromVersion: number): Promise<PreparedRemoteSync> {
    const remote = await getLibraryDb(this.token);
    if (!remote.exists || !remote.manifestKey) return { kind: "none" };
    // LIB-SYNC-03: the server's version is past this device's (checked in prepareRemoteSync), so a full
    // save at or below the device's version is older than the library it holds — replacing the library
    // with it rolls new media back and moves the version backwards, and the next sync asks again and gets
    // the same old save. It only happens when the server lost ops (a hole in its history): keep the
    // library and its version, and say so loudly.
    const snapshotVersion = remote.snapshotVersion ?? remote.version;
    if (fromVersion > 0 && snapshotVersion <= fromVersion) {
      logger.error(
        { fromVersion, snapshotVersion, serverVersion: meta.version },
        "syncFromSnapshot: server answered tooOld but its full save is not newer than this device's library — keeping the local library (server op history has a gap)"
      );
      return { kind: "none" };
    }
    let manifestBytes: Uint8Array;
    try {
      manifestBytes = await fetchManifestWithRetry(this.token, remote.manifestKey);
    } catch (error) {
      if (error instanceof Error && error.message === "REMOTE_MISSING") {
        return { kind: "none" };
      }
      throw error;
    }
    const manifestPlain = await decodeStoredManifest(this.keyBase64, manifestBytes);
    const manifest = JSON.parse(new TextDecoder().decode(manifestPlain)) as LibrarySnapshotManifest;
    const encryptedSnapshot = await downloadChunks(this.token, manifest);
    const bytes = await decryptLibraryPayload(this.keyBase64, encryptedSnapshot).catch(() => {
      throw new Error("DECRYPT_FAILED");
    });
    return {
      kind: "snapshot",
      meta,
      fromVersion,
      snapshotVersion,
      updatedAt: remote.updatedAt ?? null,
      bytes,
    };
  }

  private async applyRemoteSnapshot(prepared: Extract<PreparedRemoteSync, { kind: "snapshot" }>) {
    // A snapshot replaces every row, with or without pending local ops to
    // re-apply afterwards, so the changed media cannot be named.
    this.changeUnattributed = true;
    const { meta, bytes, snapshotVersion } = prepared;
    this.lastQueuedUpsertSignature.clear();
    const nextDb = openSqliteDb(bytes);
    ensureLibrarySchema(nextDb);
    // `media_local_downloads` is per-device and no longer travels in snapshots
    // (LIB-FMT-07), so the wipe below would drop this device's saved files.
    // Carry its rows across; a snapshot saved by an older app may still hold
    // another device's rows, which are replaced below.
    let localOnlyRows: Array<Record<string, unknown>> = [];
    try {
      localOnlyRows = (this.playbackDb?.prepare("SELECT * FROM media_local_downloads;").all() ?? []) as Array<
        Record<string, unknown>
      >;
    } catch {
      // group file predates the table: nothing to carry
    }
    // Same for the OCR catch-up retry state (PLAY-TRACK-05): without it every
    // remote snapshot would retry each failed picture track at once.
    let ocrAttemptRows: Array<Record<string, unknown>> = [];
    try {
      ocrAttemptRows = (this.templatesDb?.prepare("SELECT * FROM subtitle_ocr_attempts;").all() ?? []) as Array<
        Record<string, unknown>
      >;
    } catch {
      // group file predates the table: nothing to carry
    }
    // Phase 3.6: tear down the per-group SQLite files so the fresh snapshot
    // becomes the new source of truth. The per-group split markers in
    // `core.app_settings` survived inside `bytes`, so the constructor-style
    // initialize<Group>Db calls below detect them and skip recopying —
    // unless we wipe them, which we do, since the new snapshot must
    // re-populate the per-group files from scratch.
    const groupDbs = [this.coreDb, this.metadataDb, this.playbackDb, this.ingestDb, this.templatesDb];
    this.coreDb = null; this.coreOrm = null;
    this.metadataDb = null; this.metadataOrm = null;
    this.playbackDb = null; this.playbackOrm = null;
    this.ingestDb = null; this.ingestOrm = null;
    this.templatesDb = null; this.templatesOrm = null;
    closeLibraryGroupDbs(groupDbs);
    // Delete the per-group files on disk so the next open creates them
    // fresh. The markers stored INSIDE coreDb are gone too.
    // WAL: bun's close() is sqlite3_close_v2, deferred while drizzle's
    // prepared statements live, so the old -wal/-shm may still be on disk
    // here; a -wal left next to a recreated file would be replayed into it.
    // (The deferred close itself never unlinks the NEW sidecars: SQLite skips
    // the WAL delete for a db file that was unlinked — library-wal-sidecar-
    // safety.test.ts pins that.) Delete at the paths the handles were opened
    // with.
    for (const p of [
      this.coreDbPath ?? getCoreDbPath(),
      this.metadataDbPath ?? getMetadataDbPath(),
      this.playbackDbPath ?? getPlaybackDbPath(),
      this.ingestDbPath ?? getIngestDbPath(),
      this.templatesDbPath ?? getTemplatesDbPath(),
    ]) {
      removeSqliteFiles(p);
    }
    try { this.db.close(); } catch { /* may have been retired */ }
    this.db = nextDb;
    this.orm = createOrm(nextDb);
    // Replay the constructor-style per-group inits against the fresh legacy
    // DB. Each will copy its tables from `nextDb` into a freshly-created
    // `library.<group>.sqlite`, then drop from legacy. Finally retire the
    // legacy file again. #25 P10: these files are not prepared off the loop
    // (that would need an await while the group handles are null, letting
    // concurrent writers fall back to the legacy ORM), so this rare replace
    // pays the new files' WAL-setup syncs on the event loop; registration
    // still moves their checkpoints to the worker.
    this.initializeCoreDb();
    this.initializeMetadataDb();
    this.initializePlaybackDb();
    // initializePlaybackDb() reassigns this.playbackDb, which TypeScript cannot see through
    // the `= null` above, so read it back as its declared type.
    const playbackDb = this.playbackDb as SqliteDatabase | null;
    if (playbackDb) {
      playbackDb.exec("DELETE FROM media_local_downloads;");
      playbackDb.transaction(() => {
        for (const row of localOnlyRows) {
          const columns = Object.keys(row);
          playbackDb
            .prepare(
              `INSERT OR REPLACE INTO media_local_downloads (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")});`
            )
            .run(...columns.map((c) => row[c]));
        }
      })();
    }
    this.initializeIngestDb();
    this.initializeTemplatesDb();
    const templatesDb = this.templatesDb as SqliteDatabase | null;
    if (templatesDb) {
      templatesDb.exec("DELETE FROM subtitle_ocr_attempts;");
      templatesDb.transaction(() => {
        for (const row of ocrAttemptRows) {
          const columns = Object.keys(row);
          templatesDb
            .prepare(
              `INSERT OR REPLACE INTO subtitle_ocr_attempts (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")});`
            )
            .run(...columns.map((c) => row[c]));
        }
      })();
    }
    this.retireLegacyDb();
    // Same rebase as syncFromRemoteIfNewer: the snapshot replaced every
    // per-group file, so local writes still in pendingOps must be re-applied
    // or they vanish locally (issue #25 P7).
    logger.info({ rebasedPendingOps: this.pendingOps.length }, "syncFromSnapshot: rebasing pending local ops on the remote snapshot");
    await this.applyLibraryOps(this.pendingOps as unknown as LibraryOp[]);
    this.version = snapshotVersion;
    this.remoteVersion = snapshotVersion;
    this.stateHash = normalizeStateHash(meta.stateHash);
    this.lastOpId = meta.lastOpId ?? null;
    await saveCache({
      version: snapshotVersion,
      dbPath: getCacheDbPath(),
      updatedAt: prepared.updatedAt,
      stateHash: normalizeStateHash(meta.stateHash),
      lastOpId: meta.lastOpId ?? null,
    });
    this.setDatasetStatus({ core: true, metadata: true, playback: true });
    return true;
  }

  /**
   * LIB-STORE-05: the per-group files are the canonical local store and every
   * write already landed in them, so a persist only stamps the cache version
   * (a few hundred bytes) and wakes the ops flush. Its cost does not depend on
   * the library size; the combined single-file image is built on demand only.
   */
  private async persistInline(version: number, updatedAt: string) {
    await saveCache({
      version,
      dbPath: getCacheDbPath(),
      updatedAt,
      stateHash: this.stateHash,
      lastOpId: this.lastOpId,
    });

    if (this.syncEnabled) {
      this.scheduleOpsFlush();
    }
    return { status: "local-only" as const };
  }

  private schedulePersist() {
    if (this.closed || this.persistInFlight || this.persistScheduled) return;
    this.persistScheduled = true;
    this.persistIdleHandle = scheduleIdle(() => {
      this.persistScheduled = false;
      this.persistIdleHandle = null;
      if (this.closed) return;
      this.runPersist();
    });
  }

  private runPersist() {
    if (this.closed || this.persistInFlight || !this.persistState) return;
    const { version, updatedAt, generation } = this.persistState;
    this.persistState = null;
    // The library directory was wiped under the open handles (desktop e2e run
    // 8068): stamping the cache would resurrect the directory around files
    // that no longer back this instance. @bugfix runpersist-split-file-detached
    if (this.coreDbPath !== null && sqliteFileIdentity(this.coreDbPath) === null) {
      logger.error({ version }, "persist skipped: the library core file no longer exists");
      return;
    }
    this.persistInFlight = true;

    const finish = () => {
      if (generation === this.persistGeneration) {
        this.pendingSync = null;
      }
      this.persistInFlight = false;
      if (this.persistState) {
        this.schedulePersist();
      }
    };

    this.persistInline(version, updatedAt)
      .then(() => finish())
      .catch(() => {
        this.persistInFlight = false;
      });
  }

  private async persist(options: { mediaFree?: boolean } = {}) {
    // A persist whose write named no media (and is not declared media-free)
    // cannot say what changed: flag it so the consumer refetches everything.
    if (this.mediaNotesSincePersist === 0 && options.mediaFree !== true) this.changeUnattributed = true;
    this.mediaNotesSincePersist = 0;
    this.version += 1;
    const updatedAt = nowIso();
    this.persistGeneration += 1;
    this.persistState = { version: this.version, updatedAt, generation: this.persistGeneration };
    this.schedulePersist();
    return true;
  }

  /**
   * Drain all still-pending writes to the remote API.
   *
   * This is a "flush everything" call intended for points where the caller is
   * about to discard the local SQLite state (e.g., logout) and needs to ensure
   * durability. It drains three queues, in order:
   *
   *   1. `pendingOps` — per-op records queued by writes (addMedia*, etc.).
   *      These are the primary carriers of data-changing state; without this
   *      step logout-before-sync loses any writes made in the session.
   *   2. An in-flight `persistInline` — if a persist is currently scheduled or
   *      running we wait for it to settle so we don't miss ops queued by the
   *      in-flight persist.
   *   3. `pendingSync` — the most recent full snapshot manifest, if any.
   *
   * Returns `true` when something was actually drained, `false` when nothing
   * needed flushing or when a drain failed. Callers should treat `false` as
   * non-fatal: at logout the user's intent to sign out wins, and any ops still
   * pending will be retried on next login.
   */
  async flushPending(options: { maxOps?: number } = {}) {
    if (this.closed || !this.syncEnabled) return false;

    // Cancel the debounced ops-flush timer up-front. flushPending will drain
    // pendingOps directly — we want to *be* the flush, not race against a
    // separately scheduled one. Leaving the timer armed also means a
    // close() that happens after flushPending returns can't be followed by
    // a surprise late-firing flushOps on a closed db.
    if (this.opsFlushTimer) {
      clearTimeout(this.opsFlushTimer);
      this.opsFlushTimer = null;
    }

    // Wait for any idle-scheduled persist to complete so that writes made just
    // before this call land in pendingOps before we drain them. The idle
    // scheduler means a persist may be scheduled but not yet running even if
    // the write call has returned.
    if (this.persistScheduled || this.persistInFlight) {
      // Give the scheduler a chance to fire, then await any in-flight persist.
      // We bound the wait to avoid hanging logout indefinitely.
      const started = Date.now();
      while (
        (this.persistScheduled || this.persistInFlight) &&
        !this.closed &&
        Date.now() - started < 3_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    if (this.closed) return false;

    let drainedSomething = false;

    // If an ops flush is in flight (started before we cancelled the timer),
    // wait for it to settle so our direct flushOps() isn't short-circuited
    // by opsFlushInFlight.
    {
      const waitStarted = Date.now();
      while (this.opsFlushInFlight && !this.closed && Date.now() - waitStarted < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    if (this.closed) return false;

    // Drain pendingOps. These are the data-changing records; without them a
    // fresh client fetching from the API sees an empty library.
    if (this.pendingOps.length > 0 && !this.opsFlushQuotaExceeded && !this.opsFlushCircuitOpen) {
      const before = this.pendingOps.length;
      await this.flushOps(options.maxOps).catch(() => undefined);
      if (this.pendingOps.length < before) drainedSomething = true;
    }

    if (this.closed) return drainedSomething;

    // Drain pendingSync snapshot if still present.
    if (!this.pendingSync) return drainedSomething;
    if (!(await this.ensurePublishableState("pending-snapshot"))) return drainedSomething;
    const pending = this.pendingSync;
    if (!pending.snapshotPath || !pending.manifestPath) {
      return drainedSomething;
    }
    if ((pending.opStreamVersion ?? OP_STREAM_VERSION) < this.targetOpStreamVersion) {
      // LIB-FMT-13: a compaction snapshot built in version 3 before the account switched. The switched server refuses
      // it, and its data already reached the server as ops; the conversion publishes the converted copy instead.
      logger.info(
        { snapshotId: pending.snapshotId, opStreamVersion: pending.opStreamVersion ?? OP_STREAM_VERSION },
        "library.v4.convert: discarding a version-3 pending snapshot on a switched account"
      );
      this.pendingSync = null;
      await clearPending().catch(() => undefined);
      return drainedSomething;
    }
    try {
      const snapshotBytes = readFileSync(pending.snapshotPath);
      const manifestPayload = readFileSync(pending.manifestPath);
      const pendingChunks = buildChunks(snapshotBytes);
      const fileHashes = pendingChunks.map((entry) => entry.hash);
      // PR #143 re-review P1: the pending files have fixed names, so a crash
      // between rewriting pending.snapshot and pending.json leaves an old
      // record over a new file. Publishing the file's hashes with that
      // record's manifest would protect chunks the manifest never reads.
      const recordedRefs = pending.chunkRefs;
      if (recordedRefs && (recordedRefs.length !== fileHashes.length || recordedRefs.some((ref, i) => ref !== fileHashes[i]))) {
        logger.error({
          snapshotId: pending.snapshotId,
          recordedChunks: recordedRefs.length,
          fileChunks: fileHashes.length,
        }, "flushPending: pending snapshot file no longer matches its recorded chunkRefs — discarding it");
        this.pendingSync = null;
        await clearPending().catch(() => undefined);
        return drainedSomething;
      }
      if (!recordedRefs) {
        logger.warn({ snapshotId: pending.snapshotId }, "flushPending: pre-#143 pending snapshot has no recorded chunkRefs — publishing without a chunkRefs source");
      }
      const checkedKeyProbe = await assertAccountLibraryKey(this.token, this.keyBase64);
      await uploadChunks(this.token, pendingChunks);
      const result = await putLibraryDb(
        this.token,
        pending.baseVersion,
        Buffer.from(manifestPayload).toString("base64"),
        pending.snapshotId,
        pending.chunkSize,
        pending.keyProbe,
        false,
        pending.stateHash ?? null,
        pending.lastOpId ?? null,
        undefined,
        fileHashes,
        recordedRefs ? DESKTOP_CHUNK_REFS_SOURCE : undefined,
        pending.opStreamVersion ?? OP_STREAM_VERSION,
        checkedKeyProbe
      );
      // Like flushOps: an instance closed during the upload (runtime re-open,
      // clearLocalCache) must not rewrite cache.json / pending files the new
      // owner already manages. This drain now runs outside the runtime's op
      // gate (prepareRemoteSync, #25 N4), so that window is real.
      if (this.closed) {
        logger.warn({ snapshotId: pending.snapshotId, version: result.version }, "flushPending: instance closed during snapshot upload — leaving state to the reopened instance");
        return true;
      }
      // Same version guard as uploadSnapshot: a local write may have bumped
      // `version` meanwhile — never move it backwards.
      this.remoteVersion = result.version;
      if (!this.pendingOps.length) {
        this.version = Math.max(this.version, result.version);
      }
      this.stateHash = normalizeStateHash(result.stateHash ?? pending.stateHash ?? null);
      this.lastOpId = result.lastOpId ?? pending.lastOpId ?? null;
      this.pendingSync = null;
      await clearPending();
      await saveCache({
        version: Math.max(this.version, this.remoteVersion),
        dbPath: getCacheDbPath(),
        updatedAt: pending.updatedAt,
        stateHash: this.stateHash,
        lastOpId: this.lastOpId,
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("quota_exceeded")) {
        this.opsFlushQuotaExceeded = true;
      } else if (error instanceof ApiError && error.status === 409) {
        // #25 N4: the pending snapshot was built on `baseVersion`, and the
        // server has moved past it. Its base never comes back, so every later
        // sync re-uploaded every chunk only to get the same 409 — a full
        // snapshot upload per sync, forever, and `hasPendingSync` stayed true
        // so the renderer kept scheduling more. It is a compaction snapshot:
        // the data it carries reached the server as ops (flushOps runs
        // first). Drop it; the next compaction builds a fresh one.
        logger.warn(
          libraryRefusalFields(error, { baseVersion: pending.baseVersion ?? null, consecutive409: 1 }),
          "flushPending: pending snapshot base is stale (409) — discarding it"
        );
        this.pendingSync = null;
        await clearPending().catch(() => undefined);
      }
      return drainedSomething;
    }
  }
}
