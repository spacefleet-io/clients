import RNFS from "react-native-fs";
import { Buffer } from "buffer";
import SQLite from "react-native-sqlite-storage";
import crypto from "react-native-quick-crypto";
import {
  ApiError,
  deleteStorageObjects,
  listStorageObjects,
  putLibraryDb,
  putLibraryOp,
  type LibraryDbPutResult,
  type LibraryMeta,
  type LibraryWriterFormats,
  TitleDetails,
} from "@space/shared/api";
import { isLibraryOpStreamSwitch, requireLibraryUpdate } from "@space/shared/appVersion";
import { LIBRARY_SYNC_STUCK_AFTER_409S, LIBRARY_SYNC_STUCK_RETRY_MS, libraryRefusalFields } from "@space/shared/apiFailure";
import { fetchLibraryOpsPage, type LibraryOpsPage } from "./library/opsPage";
import { readLibraryMeta } from "./library/libraryReads";
import { inlineBlobParams, PACKED_LIST_SELECT, packedListFromRow, packedRowWithBytes } from "./library/packedChunkRows";
import { chunkListToJson, unpackChunkList, type PackedChunkList } from "@space/library-db-definition/chunkLists";
import { convertChunkLists } from "../native/LibrarySync";
import {
  CHUNK_SIZE_BYTES,
  uploadObjectViaTunnel,
  downloadObjectViaTunnel,
  fetchManifestBytes,
  fetchRemoteManifestWithRetry,
  uploadChunksFromFile,
  downloadChunksToFile,
  uploadMediaObjectViaTunnel,
} from "./library/transport";
import { findMediaPlacementId } from "@space/shared/mediaPlacement";
import {
  TITLE_VARIANTS_KEY_PREFIX,
  isTitleVariantsKey,
  parseTitleVariants,
  type TitleArt,
  type TitleVariants,
} from "@space/shared/titleLanguage";
import { encryptMediaObject } from "./mediaCrypto";
import { bumpLibraryRevision, bumpSyncedLibraryRevision } from "./libraryRevision";
import {
  CORE_DB_NAME,
  METADATA_DB_NAME,
  PLAYBACK_DB_NAME,
  INGEST_DB_NAME,
  SNAPSHOT_DB_NAME,
  IntegrityCheckFailedError,
  openCoreDb,
  openMetadataDb,
  openPlaybackDb,
  openIngestDb,
  openSnapshotDb,
  ensureLibraryDir,
  removeDbFile,
  resetSplitDbFiles,
  removeSnapshotDbFile,
  runIntegrityCheck,
} from "./library/dbFiles";
import { healSystemPlaylists, takeHealedSystemPlaylists } from "./library/systemPlaylists";
import { CATALOG_ID_SOURCE } from "@space/library-db-definition/catalogId";
import { CATALOG_ID_SOURCES_SQL } from "@space/library-db-definition/legacyFormat";
import { systemPlaylistForSlug } from "@space/library-db-definition/systemPlaylists";
import { listDetailsArtworkSlots, type ArtworkApplyResult, type ArtworkCopy, type ArtworkSlot } from "@space/library-db-definition/artworkCopy";
import {
  type LibrarySnapshotChunk,
  type LibrarySnapshotManifest,
  isSqliteHeader,
  decodeUtf8,
  encodeUtf8,
  buildChunkIndexFromFile,
  buildManifest,
  decodeStoredManifest,
  fetchManifestChunks,
  decryptFileToDb,
  hashDbFile,
  exportDbBytes,
  createKeyProbe,
  createSnapshotId,
  encryptDbToBinaryFile,
  getLatestSnapshotMs,
  selectSnapshotsForRetention,
} from "./library/snapshot";
import { buildCombinedCopyStatements, buildSplitCopyPlan, declaredSplitColumns, SPLIT_SOURCE_ALIAS } from "./library/libraryCopy";
import { compactLibraryOps } from "@space/library-db/opCompaction";
import {
  buildEpisodeResumeValue,
  collectEpisodeResume,
  episodeResumeKey,
  type EpisodeResume,
} from "@space/shared/playbackResume";
import {
  buildOpStatements,
  isV3MediaUpsert,
  OP_STREAM_VERSION,
  playbackFileKey,
  translateV3MediaUpsert,
  UnknownOpTypeError,
  writeOpStreamVersion,
  type LibrarySqlStatement,
  type OpStatementsByGroup,
} from "@space/library-db-definition/ops";
import { isProgressClassOp, SNAPSHOT_TAIL_BYTES_THRESHOLD } from "@space/library-db-definition/opClass";
import { readMediaDetails } from "@space/library-db-definition/mediaDetails";
import { mediaFilesAndEditionsStatements } from "@space/library-db-definition/editionDdl";
import type { SearchEpisode } from "./phoneSearch";
import type { LibrarySyncProgressEvent } from "./librarySyncStatus";
import {
  assertLibraryCompatible,
  currentLibrarySupport,
  LibraryFormatTooNewError,
  type LibrarySupport,
} from "@space/library-db-definition/compatibility";
import type { LibraryDbGroup } from "@space/library-db-definition/manifest";
import { removeDownloadsOfDeletedMedia, removeDownloadsOutsideLibrary } from "./downloads/mediaDeleted";
import { encryptOpPayload } from "./library/opPayload";
import { SEASON_COUNT_SQL, buildLibraryExtras, type LibraryExtras } from "./libraryExtras";
import type { LibraryOp, MediaFilePlaybackDeleteOp, MediaFilePlaybackSetOp, MediaUpsertV4Op } from "@space/shared/libraryOps";
import type {
  LibrarySnapshot,
  MediaCastDraft,
  MediaDetails,
  MediaEpisodeDraft,
  MediaRow,
  MediaSeasonDraft,
  MediaType,
  PlaylistRow,
} from "@space/shared/libraryTypes";
import { decryptBase64ToBytes, decryptBytesToBytes, encryptBytesToBase64, encryptBytesToBytes } from "./crypto";
import { keptLibraryKeyIsStale, keptLibraryKeyVerdict } from "@space/mobile-shell/kept-library-key";
import {
  convertPlaybackToPacked,
  ensureSchema,
  ensureCoreSchema,
  ensureMetadataSchema,
  ensurePlaybackSchema,
} from "./librarySchema";
import { leaveWalForExport } from "./library/leaveWal";
import {
  clearCache,
  clearPending,
  clearCacheOwner,
  clearPendingOps,
  getCoreDbPath,
  getMetadataDbPath,
  getPlaybackDbPath,
  getIngestDbPath,
  getSnapshotDbPath,
  getCacheBlobPath,
  getPendingSnapshotPath,
  loadCache,
  loadCacheOwner,
  loadPending,
  loadPendingOps,
  LibraryCache,
  PendingSync,
  PendingOp,
  saveCache,
  saveSnapshotOpCount,
  loadSnapshotOpCount,
  removeCacheBlob,
  type SnapshotOpCount,
  saveCacheOwner,
  savePendingOps,
  savePendingManifestBytes,
  savePending,
} from "./libraryStorage";
import {
  coreMigrations,
  metadataMigrations,
  PACKED_PLAYBACK_LAYOUT_VERSION,
  playbackMigrationsPacked,
  readPlaybackLayoutVersion,
  ingestMigrations,
} from "./libraryMigrations";
import { TRUSTED_CHUNK_REFS_VERSION, type ChunkRefsSource } from "@space/shared/contracts/library";
import { airDateToday, showProgressAggregate, type ShowEpisodeRow } from "@space/shared/showProgress";
import {
  mergeTrackPrefs,
  parseTrackPrefs,
  serializeTrackPrefs,
  trackPrefsKey,
  type TrackPrefs,
  type TrackPrefsPatch,
} from "@space/shared/trackPrefs";
import {
  isProfileSettingsKey,
  mergeProfileSettings,
  mergeProfileSettingsOps,
  parseProfileSettings,
  readProfileSettingsRow,
  resetProfileSettingsValue,
  scopedProfileSettingsKey,
  serializeProfileSettings,
  type ProfileSettings,
  type ProfileSettingsPatch,
} from "@space/shared/profileSettings";
import { getViewingScope } from "./profiles/activeViewingScope";
import {
  EPISODE_RESUME_KEY_PREFIX,
  normalizeProgressPct,
  FAVORITES_PLAYLIST_ID,
  WATCHLIST_PLAYLIST_ID,
  addProfilePlaylistItem,
  buildMediaProgressValue,
  collectMediaProgress,
  defaultProfilePlaylist,
  isMainScope,
  listProfilePlaylists,
  overlayProfileProgress,
  parseProfilePlaylist,
  MAIN_PROFILE_SETTING_KEY,
  needsMainPromotion,
  planMainPromotion,
  planMediaDeleteProfileCleanup,
  planProfileWipe,
  removeProfilePlaylistItem,
  viewingProfileIds,
  scopedEpisodeResumeKey,
  scopedMediaProgressKey,
  scopedPlaylistKey,
  scopedTrackPrefsKey,
  serializeProfilePlaylist,
  type ViewingScope,
} from "@space/shared/profileViewing";

SQLite.enablePromise(true);

/**
 * The compatibility descriptor for this mobile build — the versions it
 * supports across the three library surfaces (the cross-client
 * `assertLibraryCompatible` funnel). `currentLibrarySupport` folds the four
 * mobile per-group migration registries to their highest `user_version`;
 * the storage/op-stream versions are build constants. Mobile opens four
 * groups (core/metadata/playback/ingest) — there is no `templates` group.
 * Playback folds the registry WITH the conversion step (LIB-FMT-12): this
 * build opens a converted library, though it converts only a switched one.
 * Computed once — the registries and constants are static for the process.
 */
const MOBILE_LIBRARY_SUPPORT: LibrarySupport = currentLibrarySupport({
  core: coreMigrations,
  metadata: metadataMigrations,
  playback: playbackMigrationsPacked(async () => undefined),
  ingest: ingestMigrations,
});

/**
 * Stamped on publishes whose chunkRefs are exactly the published manifest's
 * chunks (PR #143). Older mobile builds sent none, so the orphan sweep keeps
 * their users' buckets.
 */
const MOBILE_CHUNK_REFS_SOURCE: ChunkRefsSource = { client: "badger-mobile", refsVersion: TRUSTED_CHUNK_REFS_VERSION };

/** The op-stream version the account is switched to (`/library/db/meta` `targetOpStreamVersion`); 3 when absent. */
const metaTargetOpStreamVersion = (meta: unknown): 3 | 4 => {
  const raw = meta && typeof meta === "object" && "targetOpStreamVersion" in meta ? meta.targetOpStreamVersion : null;
  return typeof raw === "number" && raw >= 4 ? 4 : 3;
};

/** Op types that exist only in op stream 4 (LIB-FMT-11); a `media.upsert` without playback keys is one too. */
const isVersion4Op = (op: LibraryOp) =>
  op.type === "media.file.playback.set" ||
  op.type === "media.file.playback.delete" ||
  op.type === "media.episode.delete" ||
  (op.type === "media.upsert" && !isV3MediaUpsert(op));

/**
 * Version-4 ops whose rows live only in the metadata / playback files. They carry their own clock guards
 * (LIB-SYNC-08), so the secondary apply runs them all, in op order, beside the upserts the core row holds.
 */
const isSecondaryOnlyOp = (op: LibraryOp) =>
  op.type === "media.file.playback.set" || op.type === "media.file.playback.delete" || op.type === "media.episode.delete";

export class QuotaExceededError extends Error {
  constructor(message = "Storage quota exceeded") {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/** A pending snapshot the server has moved past (LIB-SYNC-14): its changes already reached the server as ops. */
class StaleSnapshotError extends Error {
  constructor(readonly serverVersion: number) {
    super("STALE_SNAPSHOT");
    this.name = "StaleSnapshotError";
  }
}

const isQuotaError = (error: unknown) =>
  error instanceof ApiError &&
  (error.status === 413 ||
    error.payload?.error === "upload_quota_exceeded" ||
    error.payload?.error === "quota_exceeded");

const OPS_SNAPSHOT_THRESHOLD = 500;
/** Bound parameters per statement stay far below SQLite's 999-variable limit. */
const SQL_VARIABLE_CHUNK = 500;
const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Statements per native call. A TV episode's media.upsert carries one playback row per segment: a 57 MB op is ~500k
 * statements, and one bridge call holding them all grew op6's native heap past 1 GB and ran its 256 MB Java heap out
 * (LIB-SYNC-14).
 */
export const SQL_BATCH_ROUND = 2000;

/**
 * Collects SQL statements and executes them in ONE native transaction. This turns N sequential
 * `await executeSql()` round-trips into a batch — critical for applying hundreds of media upserts
 * without N+1 query overhead. Up to `SQL_BATCH_ROUND` statements go in a single `sqlBatch()` call;
 * a larger batch is handed to the native side `SQL_BATCH_ROUND` statements at a time inside that
 * transaction: the plugin runs statements queued from a statement's success callback in the same
 * transaction, before its COMMIT, so the batch stays all-or-nothing.
 */
class SqlBatcher {
  private statements: Array<[string, unknown[]]> = [];
  // The RN SQLite bridge has no BLOB parameter: packed chunk-list bytes (LIB-FMT-11) go into the SQL as X'..'.
  add(sql: string, params: readonly unknown[] = []) {
    this.statements.push(inlineBlobParams(sql, params));
  }
  get length() {
    return this.statements.length;
  }
  async flush(db: SQLite.SQLiteDatabase) {
    const statements = this.statements;
    if (!statements.length) return;
    if (statements.length <= SQL_BATCH_ROUND) {
      await db.sqlBatch(statements);
    } else {
      // A failing statement makes the plugin roll the whole transaction back (its error callback does not return false).
      const rollback = () => true;
      await db.transaction((tx) => {
        const round = (from: number) => {
          const end = Math.min(from + SQL_BATCH_ROUND, statements.length);
          const next = end < statements.length ? () => round(end) : undefined;
          statements.slice(from, end).forEach(([sql, params], offset) => {
            tx.executeSql(sql, params, from + offset === end - 1 ? next : undefined, rollback);
          });
        };
        round(0);
      });
    }
    this.statements = [];
  }
}
const debugLog = (event: string, data?: Record<string, unknown>) => {
  if (!__DEV__) return;
  if (data) {
    console.warn(event, JSON.stringify(data));
  } else {
    console.warn(event);
  }
};
const nowIso = () => new Date().toISOString();
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Closes still in flight. react-native-sqlite-storage keeps ONE native
 * connection per db name, so a close() that lands after a newer open() closes
 * the newer instance's connection too ("database not open" on its first
 * query). Callers do not always await close() (e.g. the key-validation open in
 * OnboardingKeyScreen), so every open waits for the closes started before it.
 */
const pendingCloses = new Set<Promise<void>>();
const waitForPendingCloses = async () => {
  if (!pendingCloses.size) return;
  console.warn("library.db.open.waiting_for_close", JSON.stringify({ count: pendingCloses.size }));
  await Promise.allSettled([...pendingCloses]);
};
// Progress-only op batches wait longer than structural edits (desktop defers them 10 s too).
const PROGRESS_FLUSH_DELAY_MS = 10_000;

const pickBlob = async (token: string, knownMeta?: LibraryMeta) => {
  const [meta, cache] = await Promise.all([knownMeta ?? readLibraryMeta(token), loadCache()]);
  if (!meta.exists) {
    return { source: "none" as const, cache, meta };
  }
  // Decide on VERSIONS only (desktop does the same). The cache's updatedAt is
  // the phone clock and meta.updatedAt the server clock; comparing them
  // discarded an up-to-date cache whenever the clocks differed by a few
  // seconds and re-downloaded the whole snapshot on every cold start.
  // A split cache that is merely BEHIND the server is still the right base:
  // syncFromRemoteIfNewer fetches only the ops after its cursor.
  const cacheUsable = cache && (cache.version >= meta.version || cache.mode === "split");
  console.warn(
    "library.load.pick_blob",
    JSON.stringify({
      source: cacheUsable ? "cache" : "remote",
      cacheVersion: cache?.version ?? null,
      cacheMode: cache?.mode ?? null,
      metaVersion: meta.version,
      metaSnapshotVersion: meta.snapshotVersion ?? null,
    })
  );
  if (cacheUsable) {
    return { source: "cache" as const, cache, meta };
  }
  return { source: "remote" as const, cache, meta };
};

const randomUuid = () => {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type SqlRow = Record<string, unknown>;

const queryAll = async <T extends SqlRow>(
  db: SQLite.SQLiteDatabase,
  sql: string,
  params: unknown[] = []
) => {
  const res = await db.executeSql(sql, params);
  const rows = res[0]?.rows;
  const result: T[] = [];
  if (!rows) return result;
  for (let i = 0; i < rows.length; i += 1) {
    result.push(rows.item(i) as T);
  }
  return result;
};

export type PlaybackChunk = { key: string; sizeBytes: number | null; startSeconds: number | null };

/** Segment rows grouped by `media_formats.id` / `media_audio_tracks.id`. */
export type PlaybackChunks = {
  formats: Record<string, PlaybackChunk[]>;
  audio: Record<string, PlaybackChunk[]>;
};

/** `group_concat` of `order_index|chunk_key|size_bytes|start_seconds` lines for one page of one track's segments. */
type PackedChunkRow = { id: string; packed: string };

/** Segments per packed string (a row of ~100 B each stays far below SQLite's / the CursorWindow's 2 MB). */
const PACK_PAGE = 2000;

let snapshotLock = Promise.resolve();
const withSnapshotLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = snapshotLock.then(task, task);
  snapshotLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

/**
 * Fills the split DBs from the combined snapshot. Each split connection ATTACHes the
 * snapshot file and SQLite copies the rows itself in one native transaction
 * (INSERT..SELECT). Reading every row over the bridge and re-inserting it with one
 * awaited executeSql each costs JS-thread time proportional to the library
 * (LIB-STORE-05); this is `buildCombinedSnapshotDb` in the other direction.
 */
const copySnapshotInto = async (db: SQLite.SQLiteDatabase, snapshotPath: string, statements: string[]) => {
  if (!statements.length) return;
  await db.executeSql(`ATTACH DATABASE '${snapshotPath.replace(/'/g, "''")}' AS ${SPLIT_SOURCE_ALIAS};`);
  try {
    await db.sqlBatch(statements);
  } finally {
    await db.executeSql(`DETACH DATABASE ${SPLIT_SOURCE_ALIAS};`).catch(() => undefined);
  }
};

/** `PRAGMA table_info` of each table: table -> columns. A table that does not exist has no entry. */
const readTableColumns = async (db: SQLite.SQLiteDatabase, tables: ReadonlySet<string>) => {
  const columns = new Map<string, Set<string>>();
  for (const table of tables) {
    const rows = await queryAll<{ name: string }>(db, `PRAGMA table_info(${table});`);
    if (rows.length) columns.set(table, new Set(rows.map((row) => row.name)));
  }
  return columns;
};

const splitSnapshotToLocalDbs = async (snapshotDb: SQLite.SQLiteDatabase) => {
  await resetSplitDbFiles();
  const coreDb = await openCoreDb();
  const metadataDb = await openMetadataDb();
  const playbackDb = await openPlaybackDb();
  const ingestDb = await openIngestDb();

  // A snapshot from an older build lacks tables and columns added since: copy only the columns both
  // the snapshot and the split DB have (the missing ones take their defaults).
  const declared = declaredSplitColumns();
  const groupDbs = { core: coreDb, metadata: metadataDb, playback: playbackDb, ingest: ingestDb };
  const source = await readTableColumns(snapshotDb, new Set(Object.values(declared).flatMap((tables) => [...tables.keys()])));
  const targets = {
    core: await readTableColumns(coreDb, new Set(declared.core.keys())),
    metadata: await readTableColumns(metadataDb, new Set(declared.metadata.keys())),
    playback: await readTableColumns(playbackDb, new Set(declared.playback.keys())),
    ingest: await readTableColumns(ingestDb, new Set(declared.ingest.keys())),
  };
  const plan = buildSplitCopyPlan(source, targets);
  const snapshotPath = getSnapshotDbPath();
  for (const group of ["core", "metadata", "playback", "ingest"] as const) {
    await copySnapshotInto(groupDbs[group], snapshotPath, plan[group]);
  }
  // LIB-SYNC-10: a snapshot an older build wrote can carry Favorites / Watchlist under a random id; the copy above
  // replaced the fixed rows with them, so move them back.
  await healSystemPlaylists(coreDb);

  return { coreDb, metadataDb, playbackDb, ingestDb };
};

/**
 * Builds the combined snapshot DB from the split DBs. SQLite copies the rows
 * itself (ATTACH + INSERT..SELECT in one native transaction): reading every
 * row over the bridge and re-inserting it with one awaited executeSql each
 * (~25k rows for a 3-title library) kept the JS thread saturated for tens of
 * seconds on the phone.
 */
const buildCombinedSnapshotDb = async () => {
  await removeSnapshotDbFile();
  const snapshotDb = await openSnapshotDb();
  const sources = [
    { alias: "src_core", path: getCoreDbPath() },
    { alias: "src_metadata", path: getMetadataDbPath() },
    { alias: "src_playback", path: getPlaybackDbPath() },
  ];
  try {
    for (const { alias, path } of sources) {
      await snapshotDb.executeSql(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS ${alias};`);
    }
    await snapshotDb.sqlBatch(buildCombinedCopyStatements());
  } finally {
    for (const { alias } of sources) {
      await snapshotDb.executeSql(`DETACH DATABASE ${alias};`).catch(() => undefined);
    }
  }
  // LIB-FMT-10: every caller exports this file next (snapshot publish, create, exportBytes).
  await leaveWalForExport(snapshotDb);

  return snapshotDb;
};

const mapGenres = (rows: Array<{ media_id: string; genre_id: number }>) => {
  const map = new Map<string, number[]>();
  rows.forEach((row) => {
    const list = map.get(row.media_id) ?? [];
    list.push(Number(row.genre_id));
    map.set(row.media_id, list);
  });
  return map;
};

/** The library meta a caller already holds (stream event); absent = fetch it fresh. */
type LibraryMetaHint = { exists: boolean; version: number };

export class LibraryDb {
  private token: string;
  private keyBase64: string;
  private coreDb: SQLite.SQLiteDatabase;
  // Metadata + playback + ingest DBs are opened lazily so the warm-start
  // cache.split path returns to the caller as soon as core is ready.
  // listMedia/listPlaylists (the queries the home screen needs) only touch
  // core; the secondary DBs resolve while the user is reading the rendered
  // list. Branches that build their handles synchronously (remote bootstrap,
  // cache.combined fallback) pass plain SQLiteDatabase instances which the
  // resolver returns directly.
  private metadataDbReady: SQLite.SQLiteDatabase | Promise<SQLite.SQLiteDatabase>;
  private playbackDbReady: SQLite.SQLiteDatabase | Promise<SQLite.SQLiteDatabase>;
  private ingestDbReady: SQLite.SQLiteDatabase | Promise<SQLite.SQLiteDatabase>;
  private metadataDbResolved: SQLite.SQLiteDatabase | null = null;
  private playbackDbResolved: SQLite.SQLiteDatabase | null = null;
  private ingestDbResolved: SQLite.SQLiteDatabase | null = null;
  private version: number;
  private remoteVersion: number;
  private pendingSync: PendingSync | null;
  private pendingOps: PendingOp[];
  private syncEnabled = true;
  private opsFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotOps: SnapshotOpCount | null = null;
  private snapshotOpsLoad: Promise<SnapshotOpCount> | null = null;
  private opsFlushInFlight = false;
  /**
   * The server refused this library's token (401: signed out, or the session was revoked). The token is fixed for the
   * instance and a sign-in opens a new library, so uploads stop here: a retry every 2 s only froze the JS thread. The
   * ops stay in pending_ops.json for the next signed-in library.
   */
  private opsFlushUnauthorized = false;
  /** LIB-SYNC-16: op uploads in a row the server refused with 409; reset by an accepted op. */
  private opsFlushConsecutive409 = 0;
  /** LIB-SYNC-17: while stuck behind 409s, no op upload starts before this time (ms since epoch). */
  private opsFlushStuckUntil = 0;
  /** Set while a pending snapshot is being published; a second flush would hash and upload it all again. */
  private flushPendingInFlight: Promise<void> | null = null;
  /**
   * Set while a compaction (meta check + snapshot build + publish) runs. Every ops flush ends with a compaction
   * check; a second one started meanwhile read meta before the first's ops landed, queued on the snapshot lock and
   * rebuilt the whole snapshot again (0.1.17 on op9: two 52 s builds, the first PUT a 409). It now joins the first.
   */
  private compactionInFlight: Promise<void> | null = null;
  /**
   * Single-flight remote sync. The foreground scheduler, the library stream, push and the store's
   * preflight all call syncFromRemoteIfNewer; two overlapping runs read the same remoteVersion and
   * fetched + applied + persisted the same op batch twice. A request made while a sync runs waits
   * for ONE follow-up run queued behind it (shared by every request made meanwhile), because the
   * running sync may already have read its meta before the state that triggered the request.
   */
  private syncInFlight: Promise<boolean> | null = null;
  private syncFollowUp: { promise: Promise<boolean>; meta: LibraryMetaHint | undefined } | null = null;
  private applyingRemoteOps = false;
  private datasetStatus = { core: true, metadata: true, playback: true };
  private datasetListeners = new Set<(status: { core: boolean; metadata: boolean; playback: boolean }) => void>();
  private secondaryOpsInFlight: Promise<void> | null = null;
  // Counts failed secondary (metadata/playback) applies so each sync batch can
  // tell whether ITS rows landed; a boolean reset by the next batch hid it.
  private secondaryFailureCount = 0;
  // Highest op version whose rows are all on disk. The ONLY value the sync
  // cursor (cache.json version) may be written from; `remoteVersion` runs ahead
  // of it while a secondary apply is in flight or after it failed.
  private durableVersion: number;
  // Server library version a snapshot was fetched at, while its download pruning waits for the cursor to
  // reach it (see pruneDownloadsOnceCurrent).
  private pruneDownloadsAtVersion: number | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private dataListeners = new Set<() => void>();
  private syncProgressListeners = new Set<(event: LibrarySyncProgressEvent) => void>();
  /** The running sync found the server newer (emitted `start`) and has not said `end` yet. */
  private syncRunStarted = false;
  /** The op stream the account is switched to (LIB-FMT-13). One-way: once 4, never back to 3. */
  private targetOpStreamVersion: 3 | 4 = 3;
  /** The playback file is converted to packed chunk lists (LIB-FMT-12, `user_version` 6). Known once it opened. */
  private packedPlayback = false;
  private playbackConvert: Promise<void> | null = null;

  private constructor(
    token: string,
    keyBase64: string,
    coreDb: SQLite.SQLiteDatabase,
    metadataDb: SQLite.SQLiteDatabase | Promise<SQLite.SQLiteDatabase>,
    playbackDb: SQLite.SQLiteDatabase | Promise<SQLite.SQLiteDatabase>,
    ingestDb: SQLite.SQLiteDatabase | Promise<SQLite.SQLiteDatabase>,
    version: number,
    remoteVersion: number,
    pendingSync: PendingSync | null,
    pendingOps: PendingOp[]
  ) {
    this.token = token;
    this.keyBase64 = keyBase64;
    this.coreDb = coreDb;
    this.metadataDbReady = metadataDb;
    this.playbackDbReady = playbackDb;
    this.ingestDbReady = ingestDb;
    if (!(metadataDb instanceof Promise)) this.metadataDbResolved = metadataDb;
    // The playback handle resolves through getPlaybackDb even when already open: it reads the layout (LIB-FMT-12).
    if (!(ingestDb instanceof Promise)) this.ingestDbResolved = ingestDb;
    this.version = version;
    this.remoteVersion = remoteVersion;
    this.durableVersion = version;
    this.pendingSync = pendingSync;
    this.pendingOps = pendingOps;
    this.resendHealedSystemPlaylists().catch((error) => {
      console.warn("library.system_playlists.resend_failed", JSON.stringify({ error: errorMessage(error) }));
    });
  }

  private async getMetadataDb(): Promise<SQLite.SQLiteDatabase> {
    if (this.metadataDbResolved) return this.metadataDbResolved;
    this.metadataDbResolved = await this.metadataDbReady;
    return this.metadataDbResolved;
  }

  private async getPlaybackDb(): Promise<SQLite.SQLiteDatabase> {
    if (this.playbackDbResolved) return this.playbackDbResolved;
    const db = await this.playbackDbReady;
    this.packedPlayback = (await readPlaybackLayoutVersion(db)) >= PACKED_PLAYBACK_LAYOUT_VERSION;
    this.playbackDbResolved = db;
    return db;
  }

  /**
   * The op stream this device's writes declare (LIB-FMT-13): 4 only once the account is switched AND the local copy
   * is converted, so an op never carries a shape the rows it was built from do not hold.
   */
  private writtenOpStreamVersion() {
    return this.packedPlayback ? writeOpStreamVersion(this.targetOpStreamVersion) : OP_STREAM_VERSION;
  }

  /** Declared on every write (op POST and snapshot PUT); a declared storage format below the stored one is a 409. */
  private writerFormats(): LibraryWriterFormats {
    return {
      storageFormatVersion: MOBILE_LIBRARY_SUPPORT.storageFormatVersion,
      opStreamVersion: this.writtenOpStreamVersion(),
    };
  }

  /**
   * Takes the account's switch from a meta or ops answer (LIB-FMT-13) and converts the local copy in place when it
   * just became 4. One-way: an answer without the field never switches a device back. A failed conversion leaves the
   * file unchanged and the device writing 3: the server's 426 on the next write, or the next v4 op, tries again.
   */
  private async adoptTargetOpStreamVersion(answer: unknown) {
    if (metaTargetOpStreamVersion(answer) !== 4) return;
    this.targetOpStreamVersion = 4;
    await this.getPlaybackDb();
    if (this.packedPlayback) return;
    await this.convertPlaybackInPlace().catch((error) => {
      console.warn("library.v4.convert_failed", JSON.stringify({ error: errorMessage(error) }));
    });
  }

  /** LIB-FMT-12: packs every chunk list of the playback file (native, own connection), then `user_version` 6. */
  private convertPlaybackInPlace() {
    this.playbackConvert ??= (async () => {
      const playbackDb = await this.getPlaybackDb();
      if (this.packedPlayback) return;
      const started = Date.now();
      const stats = { lists: 0, rows: 0, ms: 0 };
      await convertPlaybackToPacked(playbackDb, async () => {
        Object.assign(stats, await convertChunkLists(getPlaybackDbPath(), nowIso()));
      });
      this.packedPlayback = true;
      console.warn("library.v4.convert", JSON.stringify({ ...stats, totalMs: Date.now() - started }));
    })().finally(() => {
      this.playbackConvert = null;
    });
    return this.playbackConvert;
  }

  /** The combined snapshot is copied from the split DB files, so each must have finished opening (schema applied). */
  private async buildSnapshotDb() {
    await Promise.all([this.getMetadataDb(), this.getPlaybackDb()]);
    return buildCombinedSnapshotDb();
  }

  // Used by applyLibraryOps (the ingest group of each op) and by the snapshot
  // rebuild (close + reopen in syncFromSnapshot).
  private async getIngestDb(): Promise<SQLite.SQLiteDatabase> {
    if (this.ingestDbResolved) return this.ingestDbResolved;
    this.ingestDbResolved = await this.ingestDbReady;
    return this.ingestDbResolved;
  }

  getDatasetStatus() {
    return { ...this.datasetStatus };
  }

  /**
   * Fires after REMOTE ops (or a replacement snapshot) were applied to the
   * local DBs, whoever triggered the sync (initial load, foreground sync, a
   * 409 recovery inside flushOps). The store re-lists media/playlists on it, so
   * the UI never depends on one particular caller seeing the sync's result.
   * Returns an unsubscribe function.
   */
  onDataChanged(callback: () => void) {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  private emitDataChanged(reason: "ops" | "snapshot") {
    bumpLibraryRevision();
    bumpSyncedLibraryRevision();
    console.warn("library.data.changed", JSON.stringify({ reason, listeners: this.dataListeners.size }));
    for (const listener of this.dataListeners) {
      try {
        listener();
      } catch (error) {
        console.warn("library.data.listener_failed", JSON.stringify({ error: errorMessage(error) }));
      }
    }
  }

  /**
   * What a sync is doing while it runs (LIB-SYNC-13): it found the server newer, applied a page of ops, or restores a
   * snapshot. The store's sync tracker turns it into the tab bar's "Updating media library…" sign. Returns an unsubscribe.
   */
  onSyncProgress(callback: (event: LibrarySyncProgressEvent) => void) {
    this.syncProgressListeners.add(callback);
    return () => {
      this.syncProgressListeners.delete(callback);
    };
  }

  private emitSyncProgress(event: LibrarySyncProgressEvent) {
    if (event.kind === "start") this.syncRunStarted = true;
    console.warn("library.sync.progress", JSON.stringify(event));
    for (const listener of this.syncProgressListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn("library.sync.progress.listener_failed", JSON.stringify({ error: errorMessage(error) }));
      }
    }
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
    debugLog("library.dataset.status", {
      core: updated.core,
      metadata: updated.metadata,
      playback: updated.playback,
    });
    this.datasetListeners.forEach((listener) => listener(this.getDatasetStatus()));
  }

  /**
   * Warm-start hot path: open core synchronously and return as soon as it's
   * ready. Metadata + playback opens are kicked off in parallel and resolved
   * lazily by the LibraryDb resolver helpers when a query first needs them.
   * listMedia / listPlaylists (the queries the home screen renders from) only
   * hit core, so the user sees their library ~2 schema-bootstrap roundtrips
   * earlier on cold launch. Makes no network call.
   */
  private static async openSplitCache(
    token: string,
    keyBase64: string,
    cache: LibraryCache,
    pending: PendingSync | null,
    pendingOps: PendingOp[],
    metaVersion: number | null,
    metaSnapshotVersion: number | null
  ): Promise<LibraryDb> {
    const coreDb = await openCoreDb();
    const metadataDbReady = openMetadataDb();
    const playbackDbReady = openPlaybackDb();
    const ingestDbReady = openIngestDb();
    // Nothing awaits these until a query needs them; if the library is
    // closed first (JS reload mid-load) a rejection would surface as an
    // unhandled promise. Observe it here; real consumers still await the
    // original promise and see the same error.
    for (const [name, ready] of [
      ["metadata", metadataDbReady],
      ["playback", playbackDbReady],
      ["ingest", ingestDbReady],
    ] as const) {
      ready.catch((error) => {
        console.warn("library.db.open.lazy_failed", JSON.stringify({ db: name, error: errorMessage(error) }));
      });
    }
    // The split DBs hold every op up to cache.version. Resume exactly
    // there; rewinding to the server's compaction snapshot version replays
    // (downloads + applies) the whole op stream on every cold start.
    const baseVersion = cache.version;
    const remoteVersion = Math.min(baseVersion, metaVersion ?? baseVersion);
    console.warn(
      "library.load.local_hit",
      JSON.stringify({
        cacheVersion: cache.version,
        metaVersion,
        metaSnapshotVersion,
        baseVersion,
        remoteVersion,
      })
    );
    const instance = new LibraryDb(
      token,
      keyBase64,
      coreDb,
      metadataDbReady,
      playbackDbReady,
      ingestDbReady,
      baseVersion,
      remoteVersion,
      pending,
      pendingOps
    );
    if (pendingOps.length) {
      await instance.applyLibraryOps(pendingOps as LibraryOp[]);
    }
    return instance;
  }

  /**
   * Open the on-device split cache with NO network call, so a cold start paints the saved library
   * before any request is answered. Null when there is no split cache (first install, legacy
   * combined cache): the caller falls back to `open`, which fetches the snapshot.
   */
  static async openCachedSplit(token: string, keyBase64: string): Promise<LibraryDb | null> {
    await waitForPendingCloses();
    const cache = await loadCache();
    if (cache?.mode !== "split") return null;
    const [pending, pendingOps] = await Promise.all([loadPending(), loadPendingOps()]);
    return LibraryDb.openSplitCache(token, keyBase64, cache, pending, pendingOps, null, null);
  }

  /** `knownMeta`: the caller already fetched `/library/db/meta` (the store does, to gate and sync), so don't ask twice. */
  static async open(token: string, keyBase64: string, knownMeta?: LibraryMeta): Promise<LibraryDb> {
    await waitForPendingCloses();
    const selection = await pickBlob(token, knownMeta);
    const pending = await loadPending();
    const pendingOps = await loadPendingOps();

    if (selection.source === "remote") {
      const { remote, manifestBytes } = await fetchRemoteManifestWithRetry(token);
      return await withSnapshotLock(async () => {
        // Versioned dual reader (v0 base64-text legacy + v1 0x00-SBL headered).
        // Routes a too-new storage format to LibraryFormatTooNewError.
        const manifestPlain = await decodeStoredManifest(
          keyBase64,
          manifestBytes,
          MOBILE_LIBRARY_SUPPORT
        );
        const manifest = JSON.parse(decodeUtf8(manifestPlain)) as LibrarySnapshotManifest;
        const tempPath = `${RNFS.CachesDirectoryPath}/library-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}.blob`;
        await downloadChunksToFile(token, manifest, tempPath);
        const snapshotDbPath = getSnapshotDbPath();
        await removeSnapshotDbFile();
        await decryptFileToDb(keyBase64, tempPath, snapshotDbPath).catch((error) => {
          console.warn(
            "library.db.decrypt.failed",
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          );
          throw new Error("DECRYPT_FAILED");
        });
        const snapshotDb = await openSnapshotDb();
        const { coreDb, metadataDb, playbackDb, ingestDb } = await splitSnapshotToLocalDbs(snapshotDb);
        await snapshotDb.close();
        await removeSnapshotDbFile();
        const snapshotVersion = remote.snapshotVersion ?? remote.version;
        await saveCache({
          version: snapshotVersion,
          snapshotVersion,
          updatedAt: remote.updatedAt ?? null,
          mode: "split",
        });
        await RNFS.unlink(tempPath).catch(() => undefined);
        const instance = new LibraryDb(
          token,
          keyBase64,
          coreDb,
          metadataDb,
          playbackDb,
          ingestDb,
          snapshotVersion,
          snapshotVersion,
          pending,
          pendingOps
        );
        await instance.adoptTargetOpStreamVersion(selection.meta);
        if (pendingOps.length) {
          await instance.applyLibraryOps(pendingOps as LibraryOp[]);
        }
        await instance.pruneDownloadsOnceCurrent(remote.version);
        await instance.resetSnapshotOps(snapshotVersion);
        return instance;
      });
    }

    if (selection.source === "cache" && selection.cache) {
      if (selection.cache.mode === "split") {
        // Warm-start hot path (see openSplitCache).
        const instance = await LibraryDb.openSplitCache(
          token,
          keyBase64,
          selection.cache,
          pending,
          pendingOps,
          selection.meta?.version ?? null,
          selection.meta?.snapshotVersion ?? null
        );
        await instance.adoptTargetOpStreamVersion(selection.meta);
        return instance;
      }
      const snapshotDbPath = getSnapshotDbPath();
      let cacheBlobPath = selection.cache.blobPath;
      if (!cacheBlobPath && selection.cache.blobBase64) {
        const bytes = new Uint8Array(Buffer.from(selection.cache.blobBase64, "base64"));
        await RNFS.writeFile(snapshotDbPath, Buffer.from(bytes).toString("base64"), "base64");
        await ensureLibraryDir();
        cacheBlobPath = getCacheBlobPath();
        await encryptDbToBinaryFile(snapshotDbPath, keyBase64, cacheBlobPath);
        await saveCache({
          version: selection.cache.version,
          snapshotVersion: selection.cache.snapshotVersion ?? selection.cache.version,
          blobPath: cacheBlobPath,
          encrypted: true,
          encoding: "binary",
          updatedAt: selection.cache.updatedAt ?? null,
          mode: "combined",
        });
      }
      if (!cacheBlobPath) {
        throw new Error("LIBRARY_CACHE_MISSING");
      }
      try {
        return await withSnapshotLock(async () => {
          await removeSnapshotDbFile();
          await decryptFileToDb(keyBase64, cacheBlobPath, snapshotDbPath);
          const snapshotDb = await openSnapshotDb();
          const { coreDb, metadataDb, playbackDb, ingestDb } = await splitSnapshotToLocalDbs(snapshotDb);
          await snapshotDb.close();
          await removeSnapshotDbFile();
          const snapshotVersion =
            selection.meta?.snapshotVersion ??
            selection.cache.snapshotVersion ??
            selection.cache.version;
          const cacheStale = snapshotVersion < selection.cache.version;
          const baseVersion = cacheStale ? snapshotVersion : selection.cache.version;
          const remoteVersion = cacheStale
            ? snapshotVersion
            : selection.meta?.version ?? selection.cache.version;
          await saveCache({
            version: baseVersion,
            snapshotVersion,
            updatedAt: selection.cache.updatedAt ?? null,
            mode: "split",
          });
          const instance = new LibraryDb(
            token,
            keyBase64,
            coreDb,
            metadataDb,
            playbackDb,
            ingestDb,
            baseVersion,
            remoteVersion,
            pending,
            pendingOps
          );
          await instance.adoptTargetOpStreamVersion(selection.meta);
          if (pendingOps.length) {
            await instance.applyLibraryOps(pendingOps as LibraryOp[]);
          }
          return instance;
        });
      } catch (error) {
        // A too-new format surface (e.g. a cached split DB whose per-group
        // user_version exceeds this build, thrown by runMigrationsAsync) is NOT
        // a corrupt-cache condition — clearing the cache and retrying would
        // loop or silently drop the signal. Rethrow it so the store's
        // parseLibraryFormatTooNew routes it to LibraryFormatTooNewScreen.
        if (error instanceof LibraryFormatTooNewError) {
          throw error;
        }
        console.warn(
          "library.db.decrypt.failed",
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        );
        await clearCache();
        return LibraryDb.open(token, keyBase64);
      }
    }

    const coreDb = await openCoreDb();
    const metadataDb = await openMetadataDb();
    const playbackDb = await openPlaybackDb();
    const ingestDb = await openIngestDb();
    try {
      // Under the snapshot lock like every other snapshot build: a second create running at the same time
      // (Continue pressed twice during onboarding, #1074) removed library.snapshot.sqlite under this one's
      // copy, and both then failed reading it for encryption with ENOENT.
      return await withSnapshotLock(async () => {
        const keyProbe = await createKeyProbe(keyBase64);
        await ensureLibraryDir();
        const snapshotDb = await buildCombinedSnapshotDb();
        const snapshotPath = getCacheBlobPath();
        await encryptDbToBinaryFile(getSnapshotDbPath(), keyBase64, snapshotPath);
        const dbHash = await hashDbFile(getSnapshotDbPath());
        const chunkIndex = await buildChunkIndexFromFile(snapshotPath);
        const snapshotId = createSnapshotId();
        const manifest = buildManifest(snapshotId, dbHash, chunkIndex.chunks);
        const manifestPayload = await encryptBytesToBytes(
          keyBase64,
          encodeUtf8(JSON.stringify(manifest))
        );
        await uploadChunksFromFile(token, snapshotPath, chunkIndex.chunks);
        const created = await putLibraryDb(
          token,
          0,
          Buffer.from(manifestPayload).toString("base64"),
          snapshotId,
          CHUNK_SIZE_BYTES,
          keyProbe,
          undefined,
          undefined,
          undefined,
          undefined,
          chunkIndex.chunks.map((entry) => entry.hash),
          MOBILE_CHUNK_REFS_SOURCE,
          // A new library is never switched yet: it writes the op stream this build starts on (LIB-FMT-13).
          { storageFormatVersion: MOBILE_LIBRARY_SUPPORT.storageFormatVersion, opStreamVersion: OP_STREAM_VERSION }
        );
        await saveCache({
          version: created.version,
          snapshotVersion: created.version,
          updatedAt: nowIso(),
          mode: "split",
        });
        await snapshotDb.close();
        await removeSnapshotDbFile();
        const instance = new LibraryDb(
          token,
          keyBase64,
          coreDb,
          metadataDb,
          playbackDb,
          ingestDb,
          created.version,
          created.version,
          pending,
          pendingOps
        );
        if (pendingOps.length) {
          await instance.applyLibraryOps(pendingOps as LibraryOp[]);
        }
        return instance;
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // REL-LOG-31: another device created the library first; say why before opening the server's copy.
        console.warn(
          "library.bootstrap.refused",
          JSON.stringify(libraryRefusalFields(error, { baseVersion: 0, consecutive409: 1 }))
        );
        const { remote, manifestBytes } = await fetchRemoteManifestWithRetry(token);
        return await withSnapshotLock(async () => {
          // Versioned dual reader — see the remote-open site above.
          const manifestPlain = await decodeStoredManifest(
            keyBase64,
            manifestBytes,
            MOBILE_LIBRARY_SUPPORT
          );
          const manifest = JSON.parse(decodeUtf8(manifestPlain)) as LibrarySnapshotManifest;
          const tempPath = `${RNFS.CachesDirectoryPath}/library-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}.blob`;
          await downloadChunksToFile(token, manifest, tempPath);
          const snapshotDbPath = getSnapshotDbPath();
          await removeSnapshotDbFile();
          await decryptFileToDb(keyBase64, tempPath, snapshotDbPath).catch((error) => {
            console.warn(
              "library.db.decrypt.failed",
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
            );
            throw new Error("DECRYPT_FAILED");
          });
          const snapshotDb = await openSnapshotDb();
          const {
            coreDb: retryCore,
            metadataDb: retryMeta,
            playbackDb: retryPlayback,
            ingestDb: retryIngest,
          } = await splitSnapshotToLocalDbs(snapshotDb);
          await snapshotDb.close();
          await removeSnapshotDbFile();
          const snapshotVersion = remote.snapshotVersion ?? remote.version;
          await saveCache({
            version: snapshotVersion,
            snapshotVersion,
            updatedAt: remote.updatedAt ?? null,
            mode: "split",
          });
          await RNFS.unlink(tempPath).catch(() => undefined);
          const instance = new LibraryDb(
            token,
            keyBase64,
            retryCore,
            retryMeta,
            retryPlayback,
            retryIngest,
            snapshotVersion,
            snapshotVersion,
            pending,
            pendingOps
          );
          if (pendingOps.length) {
            await instance.applyLibraryOps(pendingOps as LibraryOp[]);
          }
          await instance.pruneDownloadsOnceCurrent(remote.version);
          return instance;
        });
      }
      throw error;
    }
  }

  static async openLocal(token: string, keyBase64: string) {
    await waitForPendingCloses();
    const cache = await loadCache();
    if (!cache) {
      throw new Error("LIBRARY_CACHE_MISSING");
    }
    if (cache.mode === "split") {
      const coreDb = await openCoreDb();
      const metadataDb = await openMetadataDb();
      const playbackDb = await openPlaybackDb();
      const ingestDb = await openIngestDb();
      try {
        await runIntegrityCheck(coreDb, "core", debugLog);
        await runIntegrityCheck(metadataDb, "metadata", debugLog);
        await runIntegrityCheck(playbackDb, "playback", debugLog);
        await runIntegrityCheck(ingestDb, "ingest", debugLog);
      } catch (error) {
        if (error instanceof IntegrityCheckFailedError) {
          await coreDb.close().catch(() => undefined);
          await metadataDb.close().catch(() => undefined);
          await playbackDb.close().catch(() => undefined);
          await ingestDb.close().catch(() => undefined);
          await resetSplitDbFiles();
          await clearCache();
          debugLog("library.db.integrity.recovery.openLocal", {
            db: error.dbName,
            result: error.result,
          });
          throw new Error("LIBRARY_CACHE_CORRUPT");
        }
        throw error;
      }
      const pending = await loadPending();
      const pendingOps = await loadPendingOps();
      // The split DBs hold every op up to cache.version; never rewind to the
      // server's compaction snapshot version (that replays the whole stream).
      const baseVersion = cache.version;
      const instance = new LibraryDb(
        token,
        keyBase64,
        coreDb,
        metadataDb,
        playbackDb,
        ingestDb,
        baseVersion,
        baseVersion,
        pending,
        pendingOps
      );
      if (pendingOps.length) {
        await instance.applyLibraryOps(pendingOps as LibraryOp[]);
      }
      return instance;
    }
    const snapshotDbPath = getSnapshotDbPath();
    let cacheBlobPath = cache.blobPath;
    if (!cacheBlobPath && cache.blobBase64) {
      const bytes = new Uint8Array(Buffer.from(cache.blobBase64, "base64"));
      await RNFS.writeFile(snapshotDbPath, Buffer.from(bytes).toString("base64"), "base64");
      await ensureLibraryDir();
      cacheBlobPath = getCacheBlobPath();
      await encryptDbToBinaryFile(snapshotDbPath, keyBase64, cacheBlobPath);
      await saveCache({
        version: cache.version,
        snapshotVersion: cache.snapshotVersion ?? cache.version,
        blobPath: cacheBlobPath,
        encrypted: true,
        encoding: "binary",
        updatedAt: cache.updatedAt ?? null,
        mode: "combined",
      });
    }
    if (!cacheBlobPath) {
      throw new Error("LIBRARY_CACHE_MISSING");
    }
    return await withSnapshotLock(async () => {
      await removeSnapshotDbFile();
      await decryptFileToDb(keyBase64, cacheBlobPath, snapshotDbPath).catch((error) => {
        console.warn(
          "library.db.decrypt.failed",
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        );
        throw error;
      });
      const snapshotDb = await openSnapshotDb();
      const { coreDb, metadataDb, playbackDb, ingestDb } = await splitSnapshotToLocalDbs(snapshotDb);
      await snapshotDb.close();
      await removeSnapshotDbFile();
      await saveCache({
        version: cache.version,
        snapshotVersion: cache.snapshotVersion ?? cache.version,
        updatedAt: cache.updatedAt ?? null,
        mode: "split",
      });
      const pending = await loadPending();
      const pendingOps = await loadPendingOps();
      const snapshotVersion = cache.snapshotVersion ?? cache.version;
      const baseVersion = snapshotVersion < cache.version ? snapshotVersion : cache.version;
      const instance = new LibraryDb(
        token,
        keyBase64,
        coreDb,
        metadataDb,
        playbackDb,
        ingestDb,
        baseVersion,
        baseVersion,
        pending,
        pendingOps
      );
      if (pendingOps.length) {
        await instance.applyLibraryOps(pendingOps as LibraryOp[]);
      }
      return instance;
    });
  }

  /**
   * Idempotent: the store closes the instance from the effect cleanup, from
   * reload() and from logout, and a JS reload can race any of them. Closing an
   * already closed react-native-sqlite-storage handle rejects with
   * "database not open"; that must never escape as an unhandled rejection.
   */
  close(): Promise<void> {
    if (!this.closePromise) {
      const closing = this.closeHandles();
      pendingCloses.add(closing);
      const forget = () => {
        pendingCloses.delete(closing);
      };
      closing.then(forget, forget);
      this.closePromise = closing;
    }
    return this.closePromise;
  }

  private async closeHandles() {
    this.closed = true;
    if (this.opsFlushTimer) {
      clearTimeout(this.opsFlushTimer);
      this.opsFlushTimer = null;
    }
    // Pending lazy opens must finish before close; otherwise we leak file handles.
    const [metadataDb, playbackDb, ingestDb] = await Promise.all([
      this.getMetadataDb().catch(() => null),
      this.getPlaybackDb().catch(() => null),
      this.getIngestDb().catch(() => null),
    ]);
    const handles = [
      ["core", this.coreDb],
      ["metadata", metadataDb],
      ["playback", playbackDb],
      ["ingest", ingestDb],
    ] as const;
    await Promise.all(
      handles.map(async ([name, handle]) => {
        if (!handle) return;
        try {
          await handle.close();
        } catch (error) {
          console.warn("library.db.close.failed", JSON.stringify({ db: name, error: errorMessage(error) }));
        }
      })
    );
    console.warn("library.db.closed");
  }

  setSyncEnabled(enabled: boolean) {
    this.syncEnabled = enabled;
  }

  private scheduleOpsFlush(delayMs = 250) {
    if (this.closed || this.opsFlushTimer || this.opsFlushInFlight || this.opsFlushUnauthorized) return;
    this.opsFlushTimer = setTimeout(() => {
      this.opsFlushTimer = null;
      this.flushOps().catch((error) => {
        console.warn("library.ops.flush.failed", JSON.stringify({ error: errorMessage(error) }));
      });
    }, delayMs);
  }

  // Queued ops are durable local state (pending_ops.json, replayed on the next open); the sync
  // switch only gates uploading them. Dropping them while sync is off left older queued ops to be
  // replayed over newer local writes.
  private async queueOp(op: LibraryOp, flushDelayMs = 250) {
    if (this.closed || this.applyingRemoteOps) return;
    bumpLibraryRevision();
    this.pendingOps.push(op);
    await savePendingOps(this.pendingOps);
    this.scheduleOpsFlush(flushDelayMs);
  }

  /**
   * LIB-SYNC-10: after a heal moved Favorites / Watchlist onto their fixed ids, re-send `playlist.item.add` for
   * each of their items under that id. The other devices dropped the items an older build sent under the random
   * id; re-adding one they hold is a no-op (UNIQUE(playlist_id, media_id)). Not an echo of remote ops, so it
   * bypasses queueOp's `applyingRemoteOps` gate.
   */
  private async resendHealedSystemPlaylists() {
    const slugs = takeHealedSystemPlaylists();
    if (!slugs.length || this.closed) return;
    const now = nowIso();
    const ops: LibraryOp[] = [];
    for (const slug of slugs) {
      const system = systemPlaylistForSlug(slug);
      if (!system) continue;
      const res = await this.coreDb.executeSql(
        "SELECT id, media_id, added_at FROM playlist_items WHERE playlist_id = ? ORDER BY added_at, id;",
        [system.id]
      );
      const rows = res[0]?.rows;
      for (let i = 0; i < (rows?.length ?? 0); i += 1) {
        const row = rows!.item(i) as { id: string; media_id: string; added_at: string | null };
        ops.push({
          id: crypto.randomUUID(),
          type: "playlist.item.add",
          createdAt: now,
          payload: { id: row.id, playlistId: system.id, mediaId: row.media_id, addedAt: row.added_at ?? now },
        });
      }
      console.warn("library.system_playlists.resend", JSON.stringify({ slug, playlistId: system.id, items: rows?.length ?? 0 }));
    }
    if (!ops.length || this.closed) return;
    bumpLibraryRevision();
    this.pendingOps.push(...ops);
    await savePendingOps(this.pendingOps);
    this.scheduleOpsFlush();
  }

  /**
   * Queue a progress-style op that supersedes earlier queued ops of the same
   * target (`setting.set` by key, `media.progress` by mediaId). Playback saves
   * every ~5 s; without this the op stream would grow by two ops per tick.
   * The op currently being uploaded (index 0 while a flush is in flight) is
   * left alone because flushOps shifts it off the queue when the PUT returns.
   */
  private async queueSupersedingProgressOp(op: LibraryOp) {
    if (this.closed || this.applyingRemoteOps) return;
    const targetOf = (candidate: { type: string; payload: Record<string, unknown> | object }) => {
      const payload = candidate.payload as { key?: string; mediaId?: string };
      return candidate.type === "setting.set" ? payload.key : candidate.type === "media.progress" ? payload.mediaId : undefined;
    };
    const target = targetOf(op);
    const keep = (existing: PendingOp) => existing.type !== op.type || targetOf(existing) !== target;
    const head = this.opsFlushInFlight ? this.pendingOps.slice(0, 1) : [];
    const rest = this.pendingOps.slice(head.length).filter(keep);
    this.pendingOps = [...head, ...rest];
    await this.queueOp(op, PROGRESS_FLUSH_DELAY_MS);
  }

  private async queueMediaUpsert(mediaId: string) {
    // The upsert op carries the library's own row (main profile progress), never a profile's overlay.
    const details = await this.getMediaDetails(mediaId, { ownStorage: true });
    if (!details) return;
    if (this.writtenOpStreamVersion() === 4) {
      await this.queueMediaUpsertV4(details);
      return;
    }
    void this.queueOp({
      id: crypto.randomUUID(),
      type: "media.upsert",
      createdAt: nowIso(),
      payload: { details },
    });
  }

  /**
   * A title's change as op stream 4 (LIB-FMT-11), as the runtime sends it: its details as a `media.upsert` without
   * playback, one `media.file.playback.set` per file (and the no-file group) carrying the stored packed lists, and a
   * `media.file.playback.delete` per file announced before whose playback is gone. Each set also stamps this device's
   * playback clock for the file, so an older remote set never replaces what it just wrote (LIB-SYNC-08).
   */
  private async queueMediaUpsertV4(details: MediaDetails) {
    const mediaId = details.id;
    const createdAt = nowIso();
    const translated = translateV3MediaUpsert({ id: mediaId, type: "media.upsert", createdAt, payload: { details } });
    const ownerIds = translated.playbackSets.flatMap((set) => [
      ...set.payload.formats.map((format) => format.id),
      ...set.payload.audioTracks.map((track) => track.id),
    ]);
    const playbackDb = await this.getPlaybackDb();
    // The stored rows, not a re-pack of the keys: a seeded list (key mode 2) stays a seed on the wire.
    const stored = new Map<string, PackedChunkList>();
    for (let start = 0; start < ownerIds.length; start += SQL_VARIABLE_CHUNK) {
      const ids = ownerIds.slice(start, start + SQL_VARIABLE_CHUNK);
      const rows = await queryAll<Record<string, unknown>>(
        playbackDb,
        `SELECT ${PACKED_LIST_SELECT} FROM media_chunk_lists WHERE owner_id IN (${ids.map(() => "?").join(",")});`,
        ids
      );
      for (const row of rows) stored.set(String(row.owner_id), packedListFromRow(row));
    }
    const announced = await queryAll<{ file_id: string }>(
      playbackDb,
      "SELECT file_id FROM media_file_playback WHERE media_id = ?;",
      [mediaId]
    );
    const ops: LibraryOp[] = [
      { id: crypto.randomUUID(), type: "media.upsert", createdAt, payload: { details: translated.upsert.payload.details } } satisfies MediaUpsertV4Op,
    ];
    const clocks = new SqlBatcher();
    const currentKeys = new Set<string>();
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
      clocks.add(
        `INSERT INTO media_file_playback (media_id, file_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(media_id, file_id) DO UPDATE SET updated_at = excluded.updated_at;`,
        [mediaId, fileKey, payload.updatedAt]
      );
      ops.push({ id: crypto.randomUUID(), type: "media.file.playback.set", createdAt, payload } satisfies MediaFilePlaybackSetOp);
    }
    for (const { file_id } of announced) {
      const fileKey = String(file_id);
      if (currentKeys.has(fileKey)) continue;
      clocks.add("DELETE FROM media_file_playback WHERE media_id = ? AND file_id = ?;", [mediaId, fileKey]);
      ops.push({
        id: crypto.randomUUID(),
        type: "media.file.playback.delete",
        createdAt,
        payload: { mediaId, fileId: fileKey === "" ? null : fileKey },
      } satisfies MediaFilePlaybackDeleteOp);
    }
    await clocks.flush(playbackDb);
    for (const op of ops) await this.queueOp(op);
  }

  // Op blobs are not touched: ops live in the server's database (LIB-STORE-04), the server removes the old
  // storage copies, and the meta no longer lists every op since the snapshot (LIB-STORE-05).
  private async runLibraryGc() {
    const meta = await readLibraryMeta(this.token).catch(() => null);
    if (!meta?.exists) return;
    const snapshots = selectSnapshotsForRetention(meta.snapshotHistory ?? []);
    const manifestKeys = new Set(snapshots.map((entry) => entry.manifestKey));
    if (meta.manifestKey) {
      manifestKeys.add(meta.manifestKey);
    }
    if (!manifestKeys.size) return;

    let chunkHashes: Set<string>;
    try {
      chunkHashes = await fetchManifestChunks(
        this.token,
        this.keyBase64,
        Array.from(manifestKeys),
        MOBILE_LIBRARY_SUPPORT
      );
    } catch {
      return;
    }

    const { keys } = await listStorageObjects(this.token);
    const deletions = keys.filter((key) => {
      if (key.startsWith("library/manifests/")) {
        return !manifestKeys.has(key);
      }
      if (key.startsWith("library/chunks/")) {
        const hash = key.slice("library/chunks/".length);
        return !chunkHashes.has(hash);
      }
      return false;
    });
    if (deletions.length) {
      await deleteStorageObjects(this.token, deletions);
    }
  }

  getVersion() {
    return this.version;
  }

  getPendingOpsCount() {
    return this.pendingOps.length;
  }

  countMediaItems = async () => {
    const rows = await queryAll<{ count: number }>(
      this.coreDb,
      "SELECT COUNT(*) as count FROM media_items;"
    );
    const value = rows[0]?.count ?? 0;
    return Number(value);
  };

  /** Titles, and episodes that have a file, in the library: read before and after a sync for its result (LIB-SYNC-13). */
  countLibraryContents = async () => {
    const [titleRows, episodeRows] = await Promise.all([
      queryAll<{ count: number }>(this.coreDb, "SELECT COUNT(*) as count FROM media_items;"),
      this.getMetadataDb().then((metadataDb) =>
        queryAll<{ count: number }>(
          metadataDb,
          "SELECT COUNT(*) as count FROM (SELECT DISTINCT media_id, season, episode FROM media_files WHERE episode IS NOT NULL);"
        )
      ),
    ]);
    return { titles: Number(titleRows[0]?.count ?? 0), episodes: Number(episodeRows[0]?.count ?? 0) };
  };

  listMedia = async () => {
    const rows = await queryAll<{
      id: string;
      type: string;
      title: string;
      original_title: string | null;
      original_language: string | null;
      overview: string | null;
      year: string | null;
      rating: number | null;
      poster_path: string | null;
      backdrop_path: string | null;
      added_at: string;
      updated_at: string;
      has_files: number;
      progress_pct: number;
      last_watched_at: string | null;
      total_episodes: number | null;
      genre_ids: string | null;
      catalog_id: string | null;
    }>(
      this.coreDb,
      `SELECT m.*,
        GROUP_CONCAT(DISTINCT g.genre_id) AS genre_ids,
        MAX(e.external_id) AS catalog_id
      FROM media_items m
      LEFT JOIN media_genres g ON g.media_id = m.id
      LEFT JOIN media_external_ids e ON e.media_id = m.id AND e.source IN (${CATALOG_ID_SOURCES_SQL})
      GROUP BY m.id
      ORDER BY m.updated_at DESC;`
    );
    const scope = getViewingScope();
    const mapped = rows.map((row) => {
      const genres = row.genre_ids
        ? row.genre_ids.split(",").map(Number).filter(Number.isFinite)
        : [];
      const catalogIdValue = row.catalog_id === null ? Number.NaN : Number(row.catalog_id);
      const catalogId = Number.isFinite(catalogIdValue) ? catalogIdValue : null;
      return {
        id: String(row.id),
        type: (row.type === "tv" ? "tv" : "movie") as MediaType,
        catalogId,
        title: String(row.title),
        originalTitle: row.original_title ? String(row.original_title) : null,
        originalLanguage: row.original_language ? String(row.original_language) : null,
        overview: row.overview ? String(row.overview) : null,
        year: row.year ? String(row.year) : null,
        rating: typeof row.rating === "number" ? row.rating : row.rating ? Number(row.rating) : null,
        posterPath: row.poster_path ? String(row.poster_path) : null,
        backdropPath: row.backdrop_path ? String(row.backdrop_path) : null,
        genres,
        addedAt: String(row.added_at),
        updatedAt: String(row.updated_at),
        hasFiles: Number(row.has_files) === 1,
        progressPct: Number.isFinite(Number(row.progress_pct)) ? Number(row.progress_pct) : 0,
        lastWatchedAt: row.last_watched_at ? String(row.last_watched_at) : null,
        totalEpisodes: Number.isFinite(Number(row.total_episodes)) ? Number(row.total_episodes) : null,
        episodeCount: Number.isFinite(Number(row.total_episodes)) ? Number(row.total_episodes) : 0,
      } satisfies MediaRow;
    });
    if (isMainScope(scope)) return mapped;
    // ACCT-SQUAD-02: a non-main profile's progress replaces the main profile's (absent = not started).
    return overlayProfileProgress(mapped, collectMediaProgress(scope, await this.readScopedSettings(scope)));
  };

  /** Every `app_settings` row of a non-main profile (its `p:<id>:` keys). The LIKE is a superset; callers match exactly. */
  private async readScopedSettings(scope: ViewingScope) {
    return queryAll<{ key: string; value: string | null }>(
      this.coreDb,
      "SELECT key, value FROM app_settings WHERE key LIKE ?;",
      [`${scope.prefix}%`]
    );
  }

  /** Local `app_settings` write + its coalesced `setting.set` op (the transport of every non-main profile's state). */
  private async writeScopedSetting(key: string, value: string, updatedAt: string) {
    await this.coreDb.executeSql(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;",
      [key, value, updatedAt]
    );
    await this.queueSupersedingProgressOp({
      id: crypto.randomUUID(),
      type: "setting.set",
      createdAt: updatedAt,
      payload: { key, value, updatedAt },
    });
  }

  private async readSettingsByKey(keys: readonly string[]) {
    if (keys.length === 0) return [];
    return queryAll<{ key: string; value: string | null }>(
      this.coreDb,
      `SELECT key, value FROM app_settings WHERE key IN (${keys.map(() => "?").join(", ")});`,
      [...keys]
    );
  }

  private async readProfilePlaylist(scope: ViewingScope, playlistId: string) {
    const rows = await queryAll<{ value: string | null }>(this.coreDb, "SELECT value FROM app_settings WHERE key = ?;", [
      scopedPlaylistKey(scope, playlistId),
    ]);
    const stored = rows[0]?.value;
    // A row that is present but "" was deleted; only a never-written favorites/watchlist falls back to its default.
    if (stored === "") return null;
    return parseProfilePlaylist(stored) ?? defaultProfilePlaylist(playlistId, nowIso());
  }

  listPlaylists = async () => {
    const scope = getViewingScope();
    if (!isMainScope(scope)) {
      return listProfilePlaylists(scope, await this.readScopedSettings(scope)).map(({ items: _items, ...row }) => row);
    }
    const rows = await queryAll<{
      id: string;
      name: string;
      slug: string | null;
      is_system: number;
      created_at: string;
    }>(this.coreDb, "SELECT * FROM playlists ORDER BY created_at ASC;");
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      slug: row.slug ? String(row.slug) : null,
      isSystem: Number(row.is_system) === 1,
      createdAt: String(row.created_at),
    }));
  };

  listPlaylistItems = async (playlistId: string) => {
    const scope = getViewingScope();
    if (!isMainScope(scope)) {
      const playlist = await this.readProfilePlaylist(scope, playlistId);
      if (!playlist) return [];
      // A deleted title leaves every profile's playlists (LIB-OPS-02): drop items whose media is gone.
      const live = new Set(
        (await queryAll<{ id: string }>(this.coreDb, "SELECT id FROM media_items;")).map((row) => String(row.id))
      );
      return playlist.items.map((item) => item.mediaId).filter((mediaId) => live.has(mediaId));
    }
    const rows = await queryAll<{ media_id: string }>(
      this.coreDb,
      "SELECT media_id FROM playlist_items WHERE playlist_id = ? ORDER BY added_at ASC;",
      [playlistId]
    );
    return rows.map((row) => String(row.media_id));
  };

  /**
   * `options.chunks: false` skips the per-segment rows of every format/audio track (thousands of rows per title). The details
   * screen never reads them, and loading them dominated its open time (`library.details.timing` playbackPayload 0.7-1.1 s on a
   * normal phone); the player keeps the default (chunks included). `options.ownStorage` returns the library's own row
   * (main profile progress) whatever profile is active: the `media.upsert` op must never carry a profile's overlay.
   */
  getMediaDetails = async (
    mediaId: string,
    options: { chunks?: boolean; ownStorage?: boolean } = {}
  ): Promise<MediaDetails | null> => {
    const scope = getViewingScope();
    // The reads fan out over the three DB files at once (they used to run one after the other, 12 native round trips
    // in a row: ~1.4 s on the throttled phone). `library.details.timing` keeps the per-query timings.
    const tStart = Date.now();
    const phases: Record<string, number> = {};
    const dbs = { core: this.coreDb, metadata: await this.getMetadataDb(), playback: await this.getPlaybackDb() };
    phases.dbOpen = Date.now() - tStart;
    const details = await readMediaDetails(
      async (query) => {
        const db = dbs[query.group as keyof typeof dbs];
        if (!db) throw new Error(`library.details.group_unknown:${query.group}`);
        // The RN SQLite bridge returns no BLOB column: the packed lists are read as hex and turned back into bytes.
        if (query.name === "chunkLists") {
          const sql = query.sql.replace("SELECT * FROM media_chunk_lists", `SELECT ${PACKED_LIST_SELECT} FROM media_chunk_lists`);
          const rows = (await queryAll<Record<string, unknown>>(db, sql, query.params)).map(packedRowWithBytes);
          phases[query.name] = Date.now() - tStart;
          return rows;
        }
        const rows = await queryAll(db, query.sql, query.params);
        phases[query.name] = Date.now() - tStart;
        return rows;
      },
      mediaId,
      { chunks: options.chunks !== false }
    );
    console.warn("library.details.timing", JSON.stringify({ mediaId, totalMs: Date.now() - tStart, ...phases }));
    if (!details) return null;
    if (options.ownStorage || isMainScope(scope)) return details;
    const [own] = overlayProfileProgress(
      [details],
      collectMediaProgress(scope, await this.readSettingsByKey([scopedMediaProgressKey(scope, details.id)]))
    );
    return own ?? details;
  };

  /**
   * Segment rows of just the given formats / audio tracks, grouped by id and in playback order. The player asks for the
   * chunks of the ONE file it is about to play (after `getMediaDetails(id, { chunks: false })`): loading them for every
   * format and track of the whole title (every episode of a show) cost 2.1 s on the throttled phone for a 3-episode series
   * (`library.details.timing` playbackPayload) and dominated next-episode time-to-first-frame.
   */
  getPlaybackChunks = async (formatIds: string[], audioTrackIds: string[]): Promise<PlaybackChunks> => {
    const tStart = Date.now();
    const playbackDb = await this.getPlaybackDb();
    // One packed string per (track, page of PACK_PAGE rows) instead of one JS row object per segment: the per-row bridge +
    // object cost was 0.17 ms/row on the throttled phone (1 s for a 2-format title). Rows carry their order_index and are
    // sorted here, so the result never depends on group_concat's order. Pages keep each string far below the 2 MB CursorWindow.
    const packed = (table: string, idColumn: string, ids: string[]): Promise<PackedChunkRow[]> =>
      ids.length === 0
        ? Promise.resolve([])
        : queryAll<PackedChunkRow>(
            playbackDb,
            `SELECT ${idColumn} AS id, group_concat(order_index || '|' || chunk_key || '|' || ifnull(size_bytes, '') || '|' || ifnull(start_seconds, ''), char(10)) AS packed
            FROM ${table} WHERE ${idColumn} IN (${ids.map(() => "?").join(",")}) GROUP BY ${idColumn}, order_index / ${PACK_PAGE};`,
            ids
          );
    const allIds = [...formatIds, ...audioTrackIds];
    const [formatRows, audioRows, listRows] = await Promise.all([
      packed("media_format_chunks", "format_id", formatIds),
      packed("media_audio_chunks", "track_id", audioTrackIds),
      // LIB-FMT-11: a converted library holds each track's chunks as one packed row (BLOBs read as hex).
      allIds.length === 0
        ? Promise.resolve([])
        : queryAll<Record<string, unknown>>(
            playbackDb,
            `SELECT ${PACKED_LIST_SELECT} FROM media_chunk_lists WHERE owner_id IN (${allIds.map(() => "?").join(",")});`,
            allIds
          ),
    ]);
    let rowCount = 0;
    const group = (rows: PackedChunkRow[]): Record<string, PlaybackChunk[]> => {
      const ordered: Record<string, Array<PlaybackChunk & { order: number }>> = {};
      for (const row of rows) {
        const list = (ordered[row.id] ??= []);
        for (const line of String(row.packed).split("\n")) {
          const parts = line.split("|");
          const size = parts[parts.length - 2];
          const start = parts[parts.length - 1];
          list.push({
            order: Number(parts[0]),
            key: parts.slice(1, -2).join("|"),
            sizeBytes: size === "" ? null : Number(size),
            startSeconds: start === "" ? null : Number(start),
          });
        }
      }
      const out: Record<string, PlaybackChunk[]> = {};
      for (const [id, list] of Object.entries(ordered)) {
        rowCount += list.length;
        list.sort((a, b) => a.order - b.order);
        out[id] = list.map(({ key, sizeBytes, startSeconds }) => ({ key, sizeBytes, startSeconds }));
      }
      return out;
    };
    const chunks: PlaybackChunks = {
      formats: group(formatRows),
      audio: group(audioRows),
    };
    // A packed list replaces the owner's rows (a converted file keeps none for it).
    const audioIds = new Set(audioTrackIds);
    for (const row of listRows) {
      const ownerId = String(row.owner_id);
      const list = unpackChunkList(packedListFromRow(row));
      rowCount += list.length;
      (audioIds.has(ownerId) ? chunks.audio : chunks.formats)[ownerId] = list;
    }
    console.warn(
      "library.playback.chunks",
      JSON.stringify({ formats: formatIds.length, audioTracks: audioTrackIds.length, rows: rowCount, ms: Date.now() - tStart })
    );
    return chunks;
  };

  /**
   * Ids of the formats / audio tracks of [mediaId] that have at least one segment row: what the next-episode lookup needs
   * (`getNextPlayableEpisode`) without reading the segment rows themselves.
   */
  getPlayableTrackIds = async (mediaId: string): Promise<string[]> => {
    const playbackDb = await this.getPlaybackDb();
    const [formats, audio] = await Promise.all([
      queryAll<{ id: string }>(
        playbackDb,
        "SELECT f.id AS id FROM media_formats f WHERE f.media_id = ? AND (EXISTS (SELECT 1 FROM media_format_chunks c WHERE c.format_id = f.id) OR EXISTS (SELECT 1 FROM media_chunk_lists l WHERE l.owner_id = f.id));",
        [mediaId]
      ),
      queryAll<{ id: string }>(
        playbackDb,
        "SELECT t.id AS id FROM media_audio_tracks t WHERE t.media_id = ? AND (EXISTS (SELECT 1 FROM media_audio_chunks c WHERE c.track_id = t.id) OR EXISTS (SELECT 1 FROM media_chunk_lists l WHERE l.owner_id = t.id));",
        [mediaId]
      ),
    ]);
    return [...formats, ...audio].map((row) => String(row.id));
  };

  /** Cast, season counts, runtimes and Filter facets of every title in set-based queries: feeds the Filter sheet and the details list. */
  getLibraryExtras = async (): Promise<LibraryExtras> => {
    const [metadataDb, playbackDb] = await Promise.all([this.getMetadataDb(), this.getPlaybackDb()]);
    const [castRows, seasonRows, durationRows] = await Promise.all([
      queryAll<{ media_id: string; name: string }>(
        metadataDb,
        "SELECT r.media_id AS media_id, p.name AS name FROM media_roles r JOIN people p ON p.id = r.person_id;",
      ),
      queryAll<{ media_id: string; seasons: number }>(
        metadataDb,
        SEASON_COUNT_SQL,
      ),
      queryAll<{ media_id: string; duration_seconds: number }>(
        playbackDb,
        "SELECT media_id, MAX(duration_seconds) AS duration_seconds FROM media_formats WHERE duration_seconds IS NOT NULL GROUP BY media_id;",
      ),
    ]);
    // UX-LIB-03: the Filter sheet's quality, director, audio / subtitle language values. Older files have no media_crew.
    type FacetRow = { media_id: string; value: string | null };
    const hasCrew = (await queryAll<{ name: string }>(metadataDb, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_crew';")).length > 0;
    const [qualities, directors, audioLanguages, subtitleLanguages] = await Promise.all([
      queryAll<FacetRow>(playbackDb, "SELECT DISTINCT media_id, quality AS value FROM media_formats;"),
      hasCrew
        ? queryAll<FacetRow>(
            metadataDb,
            "SELECT c.media_id AS media_id, p.name AS value FROM media_crew c JOIN people p ON p.id = c.person_id WHERE c.job = 'Director' ORDER BY c.order_index;",
          )
        : Promise.resolve([]),
      queryAll<FacetRow>(playbackDb, "SELECT DISTINCT media_id, language AS value FROM media_audio_tracks;"),
      queryAll<FacetRow>(playbackDb, "SELECT DISTINCT media_id, language AS value FROM media_subtitles;"),
    ]);
    return buildLibraryExtras(castRows, seasonRows, durationRows, { qualities, directors, audioLanguages, subtitleLanguages });
  };

  /** Every episode of the library, for the phone's search (UX-PHONE-12): one query, the show's name is joined by the caller. */
  listEpisodesForSearch = async (): Promise<SearchEpisode[]> => {
    const rows = await queryAll<{ id: string; media_id: string; season_number: number; episode_number: number; title: string; still_path: string | null }>(
      await this.getMetadataDb(),
      "SELECT id, media_id, season_number, episode_number, title, still_path FROM media_episodes ORDER BY media_id, season_number, episode_number;",
    );
    return rows.map((row) => ({
      id: String(row.id),
      mediaId: String(row.media_id),
      seasonNumber: Number(row.season_number),
      episodeNumber: Number(row.episode_number),
      title: row.title,
      stillPath: row.still_path,
    }));
  };

  private applyMediaCoreStatements(details: MediaDetails, batch: SqlBatcher) {
    const mediaId = details.id;
    const genres = details.genres ?? [];
    batch.add(
      `INSERT OR REPLACE INTO media_items (
        id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path,
        added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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

    batch.add("DELETE FROM media_external_ids WHERE media_id = ?;", [mediaId]);
    if (details.catalogId !== null) {
      batch.add(
        "INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id) VALUES (?, ?, ?, ?, ?);",
        [randomUuid(), mediaId, details.type, CATALOG_ID_SOURCE, String(details.catalogId)]
      );
    }

    batch.add("DELETE FROM media_genres WHERE media_id = ?;", [mediaId]);
    for (const genreId of genres) {
      batch.add(
        "INSERT OR IGNORE INTO media_genres (id, media_id, genre_id) VALUES (?, ?, ?);",
        [randomUuid(), mediaId, genreId]
      );
    }
  }

  private async applyMediaCore(details: MediaDetails) {
    const batch = new SqlBatcher();
    this.applyMediaCoreStatements(details, batch);
    await batch.flush(this.coreDb);
  }

  private applyMediaMetadataStatements(details: MediaDetails, batch: SqlBatcher) {
    const mediaId = details.id;
    const cast = details.cast ?? [];
    const trailers = details.trailers ?? [];
    const seasons = details.seasons ?? [];
    const episodes = details.episodes ?? [];

    batch.add("DELETE FROM media_roles WHERE media_id = ?;", [mediaId]);
    for (const [index, member] of cast.entries()) {
      batch.add(
        "INSERT OR REPLACE INTO people (id, name, profile_path) VALUES (?, ?, ?);",
        [member.personId, member.name, member.profilePath]
      );
      if (member.catalogId !== null) {
        batch.add(
          "INSERT OR IGNORE INTO people_external_ids (id, person_id, source, external_id) VALUES (?, ?, ?, ?);",
          [randomUuid(), member.personId, CATALOG_ID_SOURCE, String(member.catalogId)]
        );
      }
      batch.add(
        "INSERT OR REPLACE INTO media_roles (id, media_id, person_id, role, order_index) VALUES (?, ?, ?, ?, ?);",
        [member.id, mediaId, member.personId, member.role, index]
      );
    }

    batch.add("DELETE FROM media_trailers WHERE media_id = ?;", [mediaId]);
    for (const trailer of trailers) {
      batch.add(
        "INSERT INTO media_trailers (id, media_id, provider, key, name, language) VALUES (?, ?, ?, ?, ?, ?);",
        [randomUuid(), mediaId, trailer.provider, trailer.key, trailer.name, trailer.language]
      );
    }

    batch.add("DELETE FROM media_seasons WHERE media_id = ?;", [mediaId]);
    for (const season of seasons) {
      batch.add(
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

    batch.add("DELETE FROM media_episodes WHERE media_id = ?;", [mediaId]);
    for (const episode of episodes) {
      batch.add(
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

    const files = details.files ?? [];
    batch.add("DELETE FROM media_file_desired_formats WHERE media_id = ?;", [mediaId]);
    batch.add("DELETE FROM media_files WHERE media_id = ?;", [mediaId]);
    // LIB-EDIT-01: the title's editions, then each file with its edition (shared with the op applier).
    for (const [sql, params] of mediaFilesAndEditionsStatements(details)) batch.add(sql, params);
    for (const file of files) {
      for (const format of file.desiredFormats) {
        batch.add(
          "INSERT OR IGNORE INTO media_file_desired_formats (id, media_id, file_id, quality, codec, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?);",
          [randomUuid(), mediaId, file.id, format.quality, format.codec, format.bitrateKbps ?? null]
        );
      }
    }
  }

  private async applyMediaMetadata(details: MediaDetails) {
    const batch = new SqlBatcher();
    this.applyMediaMetadataStatements(details, batch);
    await batch.flush((await this.getMetadataDb()));
  }

  private applyMediaPlaybackStatements(details: MediaDetails, batch: SqlBatcher) {
    const mediaId = details.id;
    const formats = details.formats ?? [];
    const audioTracks = details.audioTracks ?? [];
    const subtitles = details.subtitles ?? [];
    const chapters = details.chapters ?? [];

    batch.add(
      "DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
      [mediaId]
    );
    batch.add(
      "DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);",
      [mediaId]
    );
    batch.add("DELETE FROM media_formats WHERE media_id = ?;", [mediaId]);
    batch.add(
      "DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);",
      [mediaId]
    );
    batch.add("DELETE FROM media_audio_tracks WHERE media_id = ?;", [mediaId]);
    batch.add("DELETE FROM media_subtitles WHERE media_id = ?;", [mediaId]);

    for (const format of formats) {
      batch.add(
        `INSERT OR REPLACE INTO media_formats (
          id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, duration_seconds, total_size, size_mb
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
        ]
      );
      const formatChunks = format.chunks ?? [];
      for (let i = 0; i < formatChunks.length; i += 1) {
        const chunk = formatChunks[i]!;
        batch.add(
          "INSERT OR REPLACE INTO media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
          [randomUuid(), format.id, chunk.key, i, chunk.sizeBytes ?? null, chunk.startSeconds ?? null]
        );
      }
    }

    for (const chapter of chapters) {
      batch.add(
        "INSERT OR REPLACE INTO media_chapters (id, format_id, title, start_seconds) VALUES (?, ?, ?, ?);",
        [chapter.id, chapter.formatId, chapter.title, chapter.startSeconds]
      );
    }

    for (const track of audioTracks) {
      batch.add(
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
        batch.add(
          "INSERT OR REPLACE INTO media_audio_chunks (id, track_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
          [randomUuid(), track.id, chunk.key, i, chunk.sizeBytes ?? null, chunk.startSeconds ?? null]
        );
      }
    }

    for (const subtitle of subtitles) {
      batch.add(
        `INSERT OR REPLACE INTO media_subtitles (
          id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, derived_from_subtitle_id,
          created_at
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
          subtitle.derivedFromSubtitleId ?? null,
          subtitle.createdAt ?? details.updatedAt,
        ]
      );
    }
  }

  private async applyMediaPlayback(details: MediaDetails) {
    const batch = new SqlBatcher();
    this.applyMediaPlaybackStatements(details, batch);
    await batch.flush((await this.getPlaybackDb()));
  }

  private async applyMediaDetails(details: MediaDetails) {
    await this.applyMediaCore(details);
    await this.applyMediaMetadata(details);
    await this.applyMediaPlayback(details);
  }

  /**
   * Phase 5.3: drain the per-group statements from an OpStatementsByGroup map
   * into a SqlBatcher so the existing single-sqlBatch() flush model still
   * batches N statements into one native transaction round-trip. The
   * `templates` group never reaches mobile (no DB open); the `ingest` group
   * is applied to the ingest DB by `applyLibraryOps`.
   */
  private appendGroupToBatch(
    batch: SqlBatcher,
    statements: OpStatementsByGroup,
    group: LibraryDbGroup
  ) {
    const list = statements[group];
    if (!list) return;
    for (const stmt of list) {
      batch.add(stmt.sql, [...stmt.params]);
    }
  }

  /**
   * Writes built op statements to every library db and removes what lives outside them, in one place for a change
   * made on this device and for ops from another device (LIB-OPS-02: a local delete and a remote `media.delete`
   * remove exactly the same things). Core rows for every op; for `media.delete` also the metadata and playback rows,
   * the ingest jobs and job events (the ingest group keeps op order, so `ingest.job.*` ops stay in step) and the
   * title's offline downloads. The metadata / playback rows of `media.upsert` are written later by the secondary
   * flush of `applyLibraryOps`.
   */
  private async applyOpStatements(
    opsWithStatements: ReadonlyArray<{ op: LibraryOp; statements: OpStatementsByGroup }>,
    { origin, buildMs }: { origin: "remote" | "local"; buildMs: number }
  ) {
    // Only ops from another device must not be re-queued; a local change keeps queueing concurrent local ops.
    if (origin === "remote") this.applyingRemoteOps = true;
    try {
      const coreBatch = new SqlBatcher();
      for (const { statements } of opsWithStatements) {
        // No empty-map guard: `buildOpStatements` throws `UnknownOpTypeError`
        // for an unrecognized op type rather than returning an empty map, so a
        // statement map here is always populated. An unknown type within a
        // supported `opStreamVersion` is a genuine bug and fails loud — the
        // version gate refuses streams this build is too old for first.
        this.appendGroupToBatch(coreBatch, statements, "core");
      }
      debugLog("library.ops.apply.core.batch", { origin, statements: coreBatch.length });
      const coreStatements = coreBatch.length;
      const coreStartedAt = Date.now();
      await coreBatch.flush(this.coreDb);
      console.warn(
        "library.ops.apply.timing",
        JSON.stringify({ origin, ops: opsWithStatements.length, statements: coreStatements, buildMs, coreFlushMs: Date.now() - coreStartedAt })
      );
    } finally {
      if (origin === "remote") this.applyingRemoteOps = false;
    }

    // Handle media.delete cross-DB cleanup (metadata + playback). The shared
    // builder emits the same correlated-subquery cascades the prior inline
    // code did; we just route them into per-DB SqlBatchers.
    const deletedMediaIds = new Set(
      opsWithStatements.flatMap(({ op }) => (op.type === "media.delete" ? [op.payload.mediaId] : []))
    );
    if (deletedMediaIds.size) {
      const metaDeleteBatch = new SqlBatcher();
      const playbackDeleteBatch = new SqlBatcher();
      for (const { op, statements } of opsWithStatements) {
        if (op.type !== "media.delete") continue;
        this.appendGroupToBatch(metaDeleteBatch, statements, "metadata");
        this.appendGroupToBatch(playbackDeleteBatch, statements, "playback");
      }
      await metaDeleteBatch.flush((await this.getMetadataDb()));
      await playbackDeleteBatch.flush((await this.getPlaybackDb()));
    }

    // Ingest group (LIB-OPS-02): a media.delete also drops the title's ingest
    // jobs and job events; ingest.job.* ops keep the mirror in step. Op order
    // is preserved within the group.
    const ingestBatch = new SqlBatcher();
    for (const { statements } of opsWithStatements) {
      this.appendGroupToBatch(ingestBatch, statements, "ingest");
    }
    if (ingestBatch.length) {
      debugLog("library.ops.apply.ingest.batch", { origin, statements: ingestBatch.length });
      await ingestBatch.flush(await this.getIngestDb());
    }

    // Offline downloads of deleted titles are not library rows: the native
    // queue and its files are removed here (LIB-OPS-02).
    if (deletedMediaIds.size) {
      debugLog("library.ops.apply.media_deleted", { origin, mediaIds: [...deletedMediaIds] });
      await removeDownloadsOfDeletedMedia(deletedMediaIds);
    }
  }

  /**
   * Profile settings merge field by field (ACCT-SQUAD-03): the batch's `setting.set` ops of a profile settings key
   * are folded with this device's own row into one op (`mergeProfileSettingsOps`) before the ordinary apply.
   */
  private async foldProfileSettingsOps(ops: LibraryOp[]): Promise<LibraryOp[]> {
    const keys = [
      ...new Set(ops.flatMap((op) => (op.type === "setting.set" && isProfileSettingsKey(op.payload.key) ? [op.payload.key] : []))),
    ];
    if (keys.length === 0) return ops;
    const rows = await queryAll<{ key: string; value: string | null; updated_at: string | null }>(
      this.coreDb,
      `SELECT key, value, updated_at FROM app_settings WHERE key IN (${keys.map(() => "?").join(", ")});`,
      keys
    );
    const local = new Map(rows.map((row) => [String(row.key), { value: row.value, updatedAt: String(row.updated_at ?? "") }]));
    debugLog("library.ops.profile_settings.fold", { keys, local: rows.length });
    return mergeProfileSettingsOps(ops, local);
  }

  private async applyLibraryOps(ops: LibraryOp[]) {
    if (!ops.length) return;
    const normalizedOps = compactLibraryOps(await this.foldProfileSettingsOps(ops));
    if (!normalizedOps.length) return;
    const opCounts = normalizedOps.reduce<Record<string, number>>((acc, op) => {
      acc[op.type] = (acc[op.type] ?? 0) + 1;
      return acc;
    }, {});
    debugLog("library.ops.apply.start", { count: normalizedOps.length, types: opCounts });
    // LIB-FMT-12: version-4 ops exist only on a switched account (the server refuses them before the switch), so one
    // in the batch is the switch itself: convert first, then apply every op of the batch on the packed layout (the
    // translation lands the version-3 ops of the batch the same as before the conversion).
    await this.getPlaybackDb();
    if (!this.packedPlayback && normalizedOps.some(isVersion4Op)) {
      console.warn("library.v4.convert.on_op", JSON.stringify({ ops: normalizedOps.length }));
      this.targetOpStreamVersion = 4;
      await this.convertPlaybackInPlace();
    }
    const needsDetails = normalizedOps.some((op) => op.type === "media.upsert" || isSecondaryOnlyOp(op));
    if (needsDetails) {
      this.setDatasetStatus({ metadata: false, playback: false });
    }
    // Phase 5.3: build per-op statement maps once and reuse them in both the
    // primary (core) flush and the secondary (metadata + playback) flush.
    const buildStartedAt = Date.now();
    const packedPlayback = this.packedPlayback;
    const opsWithStatements = normalizedOps.map((op) => ({
      op,
      statements: buildOpStatements(op, randomUuid, { packedPlayback }),
    }));
    const buildMs = Date.now() - buildStartedAt;
    await this.applyOpStatements(opsWithStatements, { origin: "remote", buildMs });

    if (!needsDetails) {
      if (!this.secondaryOpsInFlight) {
        this.setDatasetStatus({ metadata: true, playback: true });
      }
      return;
    }

    const applySecondary = async () => {
      // Failures are counted in secondaryFailureCount (per batch, never reset).
      try {
        debugLog("library.ops.secondary.start");
        // The core upsert is guarded by `updated_at` (LIB-SYNC-08) but the metadata/playback files cannot see
        // it, so an older upsert that lost in core must not rewrite formats, files or episodes either: only
        // the upserts whose `updated_at` the core row now carries go on.
        const upsertDetails = opsWithStatements.flatMap(({ op }) => (op.type === "media.upsert" ? [op.payload.details] : []));
        const coreClocks = new Map<string, string>();
        for (let start = 0; start < upsertDetails.length; start += SQL_VARIABLE_CHUNK) {
          const ids = upsertDetails.slice(start, start + SQL_VARIABLE_CHUNK).map((details) => details.id);
          const rows = await queryAll<{ id: string; updated_at: string }>(
            this.coreDb,
            `SELECT id, updated_at FROM media_items WHERE id IN (${ids.map(() => "?").join(", ")});`,
            ids
          );
          for (const row of rows) coreClocks.set(String(row.id), String(row.updated_at));
        }
        // Version-4 playback/episode ops carry their own clock guards and go on in op order beside them.
        const upsertsHeldByCore = opsWithStatements.filter(
          ({ op }) =>
            isSecondaryOnlyOp(op) ||
            (op.type === "media.upsert" && coreClocks.get(op.payload.details.id) === op.payload.details.updatedAt)
        );
        await (await this.getMetadataDb()).executeSql("PRAGMA foreign_keys=OFF;");
        const metaBatch = new SqlBatcher();
        for (const { statements } of upsertsHeldByCore) {
          this.appendGroupToBatch(metaBatch, statements, "metadata");
        }
        debugLog("library.ops.secondary.metadata.batch", { statements: metaBatch.length });
        await metaBatch.flush((await this.getMetadataDb()));
        this.setDatasetStatus({ metadata: true });
        debugLog("library.ops.secondary.metadata.done");
        const playbackBatch = new SqlBatcher();
        for (const { statements } of upsertsHeldByCore) {
          this.appendGroupToBatch(playbackBatch, statements, "playback");
        }
        debugLog("library.ops.secondary.playback.batch", { statements: playbackBatch.length });
        await playbackBatch.flush((await this.getPlaybackDb()));
        this.setDatasetStatus({ playback: true });
        debugLog("library.ops.secondary.playback.done");
      } catch (error) {
        this.secondaryFailureCount += 1;
        // Release builds too: a metadata/playback batch that fails leaves the title's details stale until it applies.
        console.warn("library.ops.secondary.failed", JSON.stringify({ error: errorMessage(error) }));
        return;
      }
      debugLog("library.ops.secondary.done");
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
   * `insideSync`: called from the sync body itself. A 409 then needs no nested sync — the caller
   * pulls the newer remote ops right after this returns — and starting one would wait on the very
   * sync that is waiting on this flush.
   */
  private async flushOps(options: { insideSync?: boolean } = {}) {
    if (!this.syncEnabled || this.opsFlushInFlight || this.opsFlushUnauthorized) return;
    if (!this.pendingOps.length) return;
    // LIB-SYNC-17: stuck behind repeated 409s, only the scheduled slow retry uploads (a sync or a write does not
    // restart the same refused upload at full pace); the retry stays scheduled.
    if (Date.now() < this.opsFlushStuckUntil) {
      this.scheduleOpsFlush(this.opsFlushStuckUntil - Date.now());
      return;
    }
    this.opsFlushInFlight = true;
    // LIB-FMT-13: one re-read of meta + conversion + resend per flush when the server says the account's op stream
    // differs from the one this write declared; a second refusal waits for the next flush.
    let switchRetried = false;
    try {
      // The declared op stream depends on the playback file's layout, known once it opened.
      await this.getPlaybackDb();
      while (this.pendingOps.length > 0) {
        const op = this.pendingOps[0];
        const payload = encodeUtf8(JSON.stringify(op));
        const encrypted = await encryptOpPayload(this.keyBase64, payload);
        try {
          const baseVersion = this.remoteVersion;
          const result = await putLibraryOp(this.token, baseVersion, op.id, encrypted, undefined, undefined, this.writerFormats());
          this.remoteVersion = result.version;
          // Our own op is already applied locally; it only extends the durable
          // cursor when every remote op before it is on disk too.
          if (this.durableVersion >= baseVersion) {
            this.durableVersion = Math.max(this.durableVersion, result.version);
          }
          if (this.pendingOps.length === 1) {
            this.version = Math.max(this.version, result.version);
          }
          this.pendingOps.shift();
          this.opsFlushConsecutive409 = 0;
          this.opsFlushStuckUntil = 0;
          await this.noteSnapshotOps([op], [encrypted.length]);
          await savePendingOps(this.pendingOps);
          await this.persistCursor("own_op");
        } catch (error) {
          const refused409 = error instanceof ApiError && error.status === 409;
          if (refused409) this.opsFlushConsecutive409 += 1;
          // REL-LOG-31 / LIB-SYNC-16: why the server refused (code, request id, versions), never the op or its id.
          const refusal = libraryRefusalFields(error, {
            baseVersion: this.remoteVersion,
            consecutive409: refused409 ? this.opsFlushConsecutive409 : 0,
          });
          console.warn(
            "library.ops.flush.error",
            JSON.stringify({
              type: op.type,
              ...refusal,
              error: errorMessage(error),
              pendingOps: this.pendingOps.length,
            })
          );
          if (refused409 && this.opsFlushConsecutive409 >= LIBRARY_SYNC_STUCK_AFTER_409S) {
            // LIB-SYNC-17: slow down for every refusal of the streak; LIB-SYNC-16: say it is stuck once per streak.
            this.opsFlushStuckUntil = Date.now() + LIBRARY_SYNC_STUCK_RETRY_MS;
            if (this.opsFlushConsecutive409 === LIBRARY_SYNC_STUCK_AFTER_409S) {
              console.warn(
                "library.ops.flush.stuck",
                JSON.stringify({ ...refusal, pendingOps: this.pendingOps.length, retryInMs: LIBRARY_SYNC_STUCK_RETRY_MS })
              );
            }
          }
          if (error instanceof ApiError && error.status === 401) {
            this.opsFlushUnauthorized = true;
            debugLog("library.ops.flush.unauthorized", { pendingOps: this.pendingOps.length });
            break;
          }
          if (isQuotaError(error)) {
            debugLog("library.ops.flush.quota_exceeded");
            break;
          }
          const notSwitched =
            error instanceof ApiError && error.status === 409 && error.payload.error === "op_stream_not_switched";
          if (!switchRetried && (notSwitched || isLibraryOpStreamSwitch(error))) {
            switchRetried = true;
            const declared = this.writtenOpStreamVersion();
            const meta = await readLibraryMeta(this.token).catch(() => null);
            await this.adoptTargetOpStreamVersion(meta);
            console.warn(
              "library.v4.write_retry",
              JSON.stringify({ declared, now: this.writtenOpStreamVersion(), packed: this.packedPlayback, requestId: error instanceof ApiError ? error.requestId : null })
            );
            if (this.writtenOpStreamVersion() !== declared) continue;
            break;
          }
          if (error instanceof ApiError && error.status === 409 && !notSwitched && !options.insideSync) {
            await this.syncFromRemoteIfNewer().catch(() => undefined);
          }
          break;
        }
      }
    } finally {
      this.opsFlushInFlight = false;
      if (this.pendingOps.length > 0) {
        const stuckFor = this.opsFlushStuckUntil - Date.now();
        this.scheduleOpsFlush(stuckFor > 0 ? stuckFor : 2000);
      }
    }
    await this.maybeCompactAfterOps().catch(() => undefined);
  }

  /**
   * LIB-SYNC-07: count only structural ops since the last snapshot. Playback progress is
   * coalesced by the next save, so a long watch session must not trigger a ~MB snapshot upload.
   * LIB-SYNC-12: their ciphertext bytes count too (`sizes[i]` belongs to `ops[i]`).
   * The server sees opaque versions only; the client keeps the count (see SnapshotOpCount).
   */
  private async loadSnapshotOps(): Promise<SnapshotOpCount> {
    this.snapshotOpsLoad ??= loadSnapshotOpCount().then(
      (saved) => saved ?? { snapshotVersion: -1, count: 0, bytes: 0, bytesThreshold: SNAPSHOT_TAIL_BYTES_THRESHOLD }
    );
    this.snapshotOps ??= await this.snapshotOpsLoad;
    return this.snapshotOps;
  }

  private async noteSnapshotOps(ops: ReadonlyArray<{ type: string; payload?: unknown }>, sizes: ReadonlyArray<number>) {
    let added = 0;
    let bytes = 0;
    ops.forEach((op, index) => {
      if (isProgressClassOp(op)) return;
      added += 1;
      bytes += sizes[index] ?? 0;
    });
    if (!added) return;
    const current = await this.loadSnapshotOps();
    this.snapshotOps = { ...current, count: current.count + added, bytes: current.bytes + bytes };
    await saveSnapshotOpCount(this.snapshotOps).catch(() => undefined);
  }

  private async resetSnapshotOps(snapshotVersion: number) {
    this.snapshotOps = { snapshotVersion, count: 0, bytes: 0, bytesThreshold: SNAPSHOT_TAIL_BYTES_THRESHOLD };
    await saveSnapshotOpCount(this.snapshotOps).catch(() => undefined);
  }

  private maybeCompactAfterOps(): Promise<void> {
    this.compactionInFlight ??= this.compactAfterOps().finally(() => {
      this.compactionInFlight = null;
    });
    return this.compactionInFlight;
  }

  private async compactAfterOps() {
    // Below the thresholds nothing is asked of the server at all (no meta round-trip per flush).
    const counted = await this.loadSnapshotOps();
    const byCount = counted.count >= OPS_SNAPSHOT_THRESHOLD;
    if (!byCount && counted.bytes < counted.bytesThreshold) return;
    const meta = await readLibraryMeta(this.token).catch(() => null);
    if (!meta?.exists) return;
    // The snapshot PUT declares the op stream of the rows it carries: a switched account converts first (LIB-FMT-13).
    await this.adoptTargetOpStreamVersion(meta);
    if (counted.snapshotVersion === -1) {
      // No record of which snapshot the count started from (first run on this build, cache cleared):
      // adopt the server's current one and keep counting; never upload on an untagged count.
      this.snapshotOps = { ...counted, snapshotVersion: meta.snapshotVersion };
      await saveSnapshotOpCount(this.snapshotOps).catch(() => undefined);
      return;
    }
    if (counted.snapshotVersion !== meta.snapshotVersion) {
      // Another device published a snapshot: what we counted is already folded into it.
      await this.resetSnapshotOps(meta.snapshotVersion);
      return;
    }
    const latestSnapshotMs = getLatestSnapshotMs(meta.snapshotHistory);
    if (latestSnapshotMs && Date.now() - latestSnapshotMs < SNAPSHOT_MIN_INTERVAL_MS) {
      return;
    }
    await this.uploadSnapshot(meta.version, byCount ? undefined : counted.bytes).catch((error) => {
      console.warn("library.snapshot.compaction.failed", JSON.stringify({ error: errorMessage(error) }));
    });
  }

  /**
   * A snapshot carries a new key probe made with this key, so publishing one with a key the account no longer has
   * (erased or remade on another device) would override the account's key for every device (UX-KEY-01; root cause
   * of ParrotDesktopKey's e2e line b on desktop). Checked right before each snapshot PUT. A failed meta request is no
   * verdict (UX-KEY-01: a network failure keeps the key); the PUT then fails or lands as before. Returns the meta it
   * read (null when the request failed): the server's version right before the PUT.
   */
  private async assertKeyOpensAccount(where: string) {
    const meta = await readLibraryMeta(this.token).catch(() => null);
    const verdict = await keptLibraryKeyVerdict(this.keyBase64, meta, decryptBase64ToBytes);
    if (keptLibraryKeyIsStale(verdict)) {
      console.warn("library.snapshot.key_mismatch", JSON.stringify({ where, verdict }));
      throw new Error("KEY_MISMATCH");
    }
    return meta;
  }

  /**
   * The version a pending snapshot is published on (LIB-SYNC-14). The server takes a snapshot PUT only on its current
   * version, and that moves while the snapshot is built and uploaded (this phone's own ops, other devices' ops). A
   * snapshot that holds every change up to the server's version (`coveredVersion`, the durable cursor when it was
   * built) is just as valid there, so it goes out on that version as it is, never rebuilt. One the server has moved
   * past is stale: its changes already reached the server as ops, it is dropped, the next compaction builds a new one.
   */
  private snapshotBaseVersion(pending: PendingSync, serverVersion: number | null, where: string) {
    if (serverVersion === null || serverVersion === pending.baseVersion) return pending.baseVersion;
    const details = {
      where,
      snapshotId: pending.snapshotId,
      baseVersion: pending.baseVersion,
      coveredVersion: pending.coveredVersion ?? null,
      serverVersion,
    };
    if (pending.coveredVersion !== undefined && pending.coveredVersion >= serverVersion) {
      console.warn("library.snapshot.rebased", JSON.stringify(details));
      return serverVersion;
    }
    console.warn("library.snapshot.stale", JSON.stringify(details));
    throw new StaleSnapshotError(serverVersion);
  }

  /** Key check, then the snapshot PUT on the server's current version; one retry on the version a 409 names. */
  private async putPendingSnapshot(
    pending: PendingSync,
    manifestPayload: Uint8Array,
    publish: { force?: boolean; chunkRefs: string[]; chunkRefsSource?: ChunkRefsSource; where: string }
  ) {
    const meta = await this.assertKeyOpensAccount(publish.where);
    const put = (baseVersion: number) =>
      putLibraryDb(
        this.token,
        baseVersion,
        Buffer.from(manifestPayload).toString("base64"),
        pending.snapshotId,
        pending.chunkSize,
        pending.keyProbe,
        publish.force,
        undefined,
        undefined,
        undefined,
        publish.chunkRefs,
        publish.chunkRefsSource,
        this.writerFormats()
      );
    const baseVersion = this.snapshotBaseVersion(pending, meta?.version ?? null, publish.where);
    try {
      return await put(baseVersion);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409 && error.payload.error === "version_conflict")) throw error;
      const serverVersion = typeof error.payload.version === "number" ? error.payload.version : null;
      console.warn(
        "library.snapshot.version_conflict",
        JSON.stringify({
          where: publish.where,
          ...libraryRefusalFields(error, { baseVersion, consecutive409: 1 }),
          coveredVersion: pending.coveredVersion ?? null,
        })
      );
      const retryVersion = this.snapshotBaseVersion(pending, serverVersion, publish.where);
      if (retryVersion === baseVersion) throw error;
      return await put(retryVersion);
    }
  }

  /**
   * `maxBytes` is set when the snapshot is due by tail bytes alone (LIB-SYNC-12): a snapshot larger than the tail it
   * replaces is not published, and the byte threshold rises to its size instead.
   */
  private async uploadSnapshot(expectedVersion: number, maxBytes?: number) {
    await ensureLibraryDir();
    await withSnapshotLock(async () => {
      // Read before the build: ops applied while it runs only add to what the snapshot holds.
      const coveredVersion = this.durableVersion;
      const snapshotDb = await this.buildSnapshotDb();
      // Its own file (PR #143): the manifest's chunks must outlive any cache rewrite.
      const snapshotPath = getPendingSnapshotPath();
      await encryptDbToBinaryFile(getSnapshotDbPath(), this.keyBase64, snapshotPath);
      const dbHash = await hashDbFile(getSnapshotDbPath());
      const chunkIndex = await buildChunkIndexFromFile(snapshotPath);
      if (maxBytes !== undefined && chunkIndex.totalSize > maxBytes) {
        console.warn("library.snapshot.skipped", JSON.stringify({ reason: "larger_than_tail", tailBytes: maxBytes, snapshotBytes: chunkIndex.totalSize }));
        this.snapshotOps = { ...(await this.loadSnapshotOps()), bytesThreshold: chunkIndex.totalSize };
        await saveSnapshotOpCount(this.snapshotOps).catch(() => undefined);
        await snapshotDb.close();
        await removeSnapshotDbFile();
        await RNFS.unlink(snapshotPath).catch(() => undefined);
        return;
      }
      const chunkRefs = chunkIndex.chunks.map((entry) => entry.hash);
      const snapshotId = createSnapshotId();
      const manifest = buildManifest(snapshotId, dbHash, chunkIndex.chunks);
      const manifestPayload = await encryptBytesToBytes(
        this.keyBase64,
        encodeUtf8(JSON.stringify(manifest))
      );
      const keyProbe = await createKeyProbe(this.keyBase64);
      const pending: PendingSync = {
        baseVersion: expectedVersion,
        snapshotId,
        chunkSize: CHUNK_SIZE_BYTES,
        snapshotPath,
        manifestPath: await savePendingManifestBytes(manifestPayload),
        updatedAt: nowIso(),
        keyProbe,
        chunkRefs,
        coveredVersion,
      };
      this.pendingSync = pending;
      await savePending(pending);

      try {
        await uploadChunksFromFile(this.token, snapshotPath, chunkIndex.chunks);
      } catch (uploadErr) {
        if (isQuotaError(uploadErr)) {
          debugLog("library.snapshot.upload.quota_exceeded");
          this.pendingSync = null;
          await clearPending();
          return;
        }
        throw uploadErr;
      }
      // Send chunk hashes so the API can chunk-GC when this snapshot rotates
      // out of the kept window. Server can't read the encrypted manifest itself.
      let result: LibraryDbPutResult;
      try {
        result = await this.putPendingSnapshot(pending, manifestPayload, {
          force: true,
          chunkRefs,
          chunkRefsSource: MOBILE_CHUNK_REFS_SOURCE,
          where: "upload",
        });
      } catch (error) {
        if (!(error instanceof StaleSnapshotError)) throw error;
        this.pendingSync = null;
        await clearPending();
        await snapshotDb.close();
        await removeSnapshotDbFile();
        return;
      }
      this.remoteVersion = result.version;
      this.durableVersion = Math.max(this.durableVersion, result.version);
      if (!this.pendingOps.length) {
        this.version = Math.max(this.version, result.version);
      }
      this.pendingSync = null;
      // Already inside withSnapshotLock.
      await clearPending();
      await removeCacheBlob();
      await saveCache({
        version: this.durableVersion,
        snapshotVersion: result.version,
        updatedAt: pending.updatedAt,
        mode: "split",
      });
      await this.resetSnapshotOps(result.version);
      await snapshotDb.close();
      await removeSnapshotDbFile();
      await this.runLibraryGc();
    });
  }

  async addMediaFromCatalog(item: TitleDetails) {
    const id = randomUuid();
    const createdAt = nowIso();
    await this.coreDb.executeSql(
      `INSERT INTO media_items (id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path, added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        item.type,
        item.title,
        item.originalTitle,
        item.originalLanguage,
        item.overview,
        item.year,
        item.rating,
        item.posterPath,
        item.backdropPath,
        createdAt,
        createdAt,
        0,
        0,
        null,
        item.totalEpisodes,
      ]
    );
    await this.queueMediaUpsert(id);
    return id;
  }

  async updateMediaMetadata(payload: {
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
    seasons?: MediaSeasonDraft[];
    episodes?: MediaEpisodeDraft[];
  }) {
    if (payload.media) {
      const fields = payload.media;
      await this.coreDb.executeSql(
        `UPDATE media_items SET title = ?, original_title = ?, original_language = ?, overview = ?, year = ?, rating = ?, poster_path = ?, backdrop_path = ?, total_episodes = ?, updated_at = ?
        WHERE id = ?;`,
        [
          fields.title ?? null,
          fields.originalTitle ?? null,
          fields.originalLanguage ?? null,
          fields.overview ?? null,
          fields.year ?? null,
          fields.rating ?? null,
          fields.posterPath ?? null,
          fields.backdropPath ?? null,
          fields.totalEpisodes ?? null,
          nowIso(),
          payload.mediaId,
        ]
      );
    }
    await this.queueMediaUpsert(payload.mediaId);
  }

  async setProgress(mediaId: string, progressPct: number) {
    const scope = getViewingScope();
    const updatedAt = nowIso();
    if (!isMainScope(scope)) {
      await this.writeScopedSetting(
        scopedMediaProgressKey(scope, mediaId),
        buildMediaProgressValue({ progressPct, lastWatchedAt: updatedAt, updatedAt }),
        updatedAt
      );
      return;
    }
    await this.coreDb.executeSql(
      "UPDATE media_items SET progress_pct = ?, last_watched_at = ? WHERE id = ?;",
      [progressPct, updatedAt, mediaId]
    );
    await this.queueOp({
      id: crypto.randomUUID(),
      type: "media.progress",
      createdAt: updatedAt,
      payload: { mediaId, progressPct, lastWatchedAt: updatedAt, updatedAt },
    });
  }

  /**
   * Per-episode resume entries for one show, keyed by episode id (desktop `episode_resume_v1`), of the active
   * profile: the main profile's own keys, or `p:<profileId>:episode_resume_v1:` (ACCT-SQUAD-02).
   */
  async getEpisodeResumeMap(mediaId: string): Promise<Record<string, EpisodeResume>> {
    const scope = getViewingScope();
    const prefix = scopedEpisodeResumeKey(scope, "");
    const episodeRows = await queryAll<{ id: string }>(
      await this.getMetadataDb(),
      "SELECT id FROM media_episodes WHERE media_id = ?;",
      [mediaId]
    );
    const episodeIds = new Set(episodeRows.map((row) => String(row.id)));
    const settingRows = await queryAll<{ key: string; value: string | null }>(
      this.coreDb,
      "SELECT key, value FROM app_settings WHERE key LIKE ?;",
      [`${prefix}%`]
    );
    return collectEpisodeResume(prefix, episodeIds, settingRows);
  }

  /**
   * A show's watched percentage (LIB-PROG-01): its regular episodes' watched parts over every episode it has aired
   * (the metadata's episode list), never over the episodes that happen to be in the vault. Null when the library lists
   * no episode of the show.
   */
  private async getTvProgressAggregate(mediaId: string, now: string) {
    const episodeRows = await queryAll<ShowEpisodeRow>(
      await this.getMetadataDb(),
      "SELECT id, season_number, air_date FROM media_episodes WHERE media_id = ?;",
      [mediaId]
    );
    if (episodeRows.length === 0) return null;
    const totalRows = await queryAll<{ total_episodes: number | null }>(
      this.coreDb,
      "SELECT total_episodes FROM media_items WHERE id = ? LIMIT 1;",
      [mediaId]
    );
    const aggregate = showProgressAggregate({
      episodeRows,
      totalEpisodes: totalRows[0]?.total_episodes,
      resume: await this.getEpisodeResumeMap(mediaId),
      today: airDateToday(),
      now
    });
    if (!aggregate) return null;
    const { progressPct, lastWatchedAt, total, source, listed, withProgress } = aggregate;
    console.info("library.showProgress", JSON.stringify({ mediaId, total, source, listed, withProgress, progressPct }));
    return { progressPct, lastWatchedAt };
  }

  /** The active profile's remembered audio + subtitle choice of a movie / SHOW (PLAY-TRACK-04), or null when none is stored. */
  async getTrackPrefs(mediaId: string): Promise<TrackPrefs | null> {
    if (this.closed) return null;
    const rows = await queryAll<{ value: string | null }>(
      this.coreDb,
      "SELECT value FROM app_settings WHERE key = ?;",
      [scopedTrackPrefsKey(getViewingScope(), mediaId)]
    );
    return parseTrackPrefs(rows[0]?.value);
  }

  /**
   * Record a USER's audio / subtitle pick for a movie / SHOW (never an episode): read-modify-write of
   * `track_prefs_v1:<mediaId>` (`p:<profileId>:track_prefs_v1:<mediaId>` for a non-main profile) in `app_settings`
   * plus a `setting.set` op whose `updatedAt` equals the value's. Automatic selection and fallbacks must not call this.
   */
  async setTrackPrefs(mediaId: string, patch: TrackPrefsPatch): Promise<void> {
    if (this.closed) return;
    const key = scopedTrackPrefsKey(getViewingScope(), mediaId);
    const updatedAt = nowIso();
    const value = serializeTrackPrefs(mergeTrackPrefs(await this.getTrackPrefs(mediaId), patch, updatedAt));
    await this.writeScopedSetting(key, value, updatedAt);
  }

  /** A library-wide setting row (never a profile's `p:` key), or null when none is stored. */
  async readSetting(key: string): Promise<string | null> {
    if (this.closed) return null;
    const rows = await queryAll<{ value: string | null }>(this.coreDb, "SELECT value FROM app_settings WHERE key = ?;", [key]);
    return rows[0]?.value ?? null;
  }

  /** Writes a library-wide setting row and syncs it (`setting.set`), e.g. a title's kept texts (LIB-LANG-02). */
  async writeSetting(key: string, value: string): Promise<void> {
    if (this.closed) return;
    await this.writeScopedSetting(key, value, nowIso());
  }

  /** ACCT-PROF-03: every media's title variant row (`title_variants_v1:<media id>`), parsed, by media id. */
  async readTitleVariants(): Promise<Map<string, TitleVariants>> {
    const out = new Map<string, TitleVariants>();
    if (this.closed) return out;
    const rows = await queryAll<{ key: string; value: string | null }>(
      this.coreDb,
      "SELECT key, value FROM app_settings WHERE key LIKE ?;",
      [`${TITLE_VARIANTS_KEY_PREFIX}%`]
    );
    for (const row of rows) {
      if (!isTitleVariantsKey(row.key)) continue;
      const variants = parseTitleVariants(row.value);
      if (variants) out.set(row.key.slice(TITLE_VARIANTS_KEY_PREFIX.length), variants);
    }
    return out;
  }

  /**
   * ACCT-PROF-03: swaps a media row's title, poster and backdrop for another language's set and syncs the title
   * (`media.upsert`). Compare-and-set: written only while the row still holds `expected`, so an edit or a sync that
   * landed meanwhile wins. Returns whether the row was replaced.
   */
  async replaceTitleArt(mediaId: string, expected: TitleArt, next: TitleArt): Promise<boolean> {
    if (this.closed) return false;
    const [result] = await this.coreDb.executeSql(
      "UPDATE media_items SET title = ?, poster_path = ?, backdrop_path = ?, updated_at = ? WHERE id = ? AND title = ? AND poster_path IS ? AND backdrop_path IS ?;",
      [next.title, next.posterPath, next.backdropPath, nowIso(), mediaId, expected.title, expected.posterPath, expected.backdropPath]
    );
    const replaced = (result?.rowsAffected ?? 0) > 0;
    console.info("library.titleArt.replaced", JSON.stringify({ mediaId, replaced }));
    if (replaced) await this.queueMediaUpsert(mediaId);
    return replaced;
  }

  /**
   * Seals a fetched subtitle's text with the library's media key and stores it in the vault on the media's silo
   * (#145), like an added subtitle file on the computer app (PLAY-SUBGET-01, -03); returns its object key.
   */
  async uploadSubtitleContent(mediaId: string, episodeId: string | null, content: string, format: string): Promise<string> {
    if (this.closed) throw new Error("library_closed");
    const media = await this.getMediaDetails(mediaId, { chunks: false, ownStorage: true });
    if (!media) throw new Error(`media_not_found:${mediaId}`);
    const placementId = findMediaPlacementId(media, episodeId) ?? randomUuid();
    const sealed = encryptMediaObject(new TextEncoder().encode(content));
    const objectKey = await uploadMediaObjectViaTunnel(this.token, sealed, { placementId, logicalRef: `subtitle.${format}` });
    console.info("library.subtitle.uploaded", JSON.stringify({ mediaId, episodeId, placementId, format, bytes: sealed.length }));
    return objectKey;
  }

  /**
   * Adds a subtitle track whose object is already in the vault and syncs the title (`media.upsert`), as the computer
   * app's `addSubtitleTrack` does. `source` is "fetched" for a fetched subtitle (PLAY-SUBGET-17). Returns its id.
   */
  async addSubtitleTrack(track: {
    mediaId: string;
    episodeId: string | null;
    language: string;
    label: string;
    objectKey: string;
    format: string | null;
    source: string;
  }): Promise<string> {
    if (this.closed) throw new Error("library_closed");
    const id = randomUuid();
    await (await this.getPlaybackDb()).executeSql(
      `INSERT INTO media_subtitles (
        id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, derived_from_subtitle_id,
        created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, NULL, ?);`,
      [id, track.mediaId, track.episodeId, track.language, track.label, track.objectKey, track.format, track.source, nowIso()]
    );
    console.info("library.subtitle.added", JSON.stringify({ mediaId: track.mediaId, episodeId: track.episodeId, id, language: track.language, source: track.source }));
    await this.queueMediaUpsert(track.mediaId);
    return id;
  }

  /**
   * Removes a subtitle track and syncs the title (`media.upsert`), as `addSubtitleTrack` adds one: "Try another version"
   * drops the track it replaced (PLAY-SUBGET-07). The vault object stays (see `subtitleObjectInUse`). A track already
   * gone is a no-op.
   */
  async removeSubtitleTrack(trackId: string): Promise<void> {
    if (this.closed) throw new Error("library_closed");
    const db = await this.getPlaybackDb();
    const rows = await queryAll<{ media_id: string }>(db, "SELECT media_id FROM media_subtitles WHERE id = ?;", [trackId]);
    const mediaId = rows[0]?.media_id;
    if (!mediaId) {
      console.warn("library.subtitle.remove_missing", JSON.stringify({ id: trackId }));
      return;
    }
    await db.executeSql("DELETE FROM media_subtitles WHERE id = ?;", [trackId]);
    console.info("library.subtitle.removed", JSON.stringify({ mediaId, id: trackId }));
    await this.queueMediaUpsert(mediaId);
  }

  /** Whether a subtitle track still names this stored file: "Try another version" deletes the old one when none does. */
  async subtitleObjectInUse(objectKey: string): Promise<boolean> {
    if (this.closed) throw new Error("library_closed");
    const db = await this.getPlaybackDb();
    const rows = await queryAll<{ id: string }>(db, "SELECT id FROM media_subtitles WHERE object_key = ? LIMIT 1;", [objectKey]);
    return rows.length > 0;
  }

  /**
   * META-ART-01, existing libraries: titles that still hold a metadata-service image path (`/x.jpg`) in any artwork
   * slot (title poster or backdrop, season poster, cast photo, episode still), titles with a poster first.
   */
  async listMediaWithArtworkToCopy(): Promise<string[]> {
    if (this.closed) return [];
    const pathLike = (column: string) => `(${column} LIKE '/%' AND ${column} NOT LIKE '//%')`;
    const titles = await queryAll<{ id: string }>(
      this.coreDb,
      `SELECT id FROM media_items WHERE ${pathLike("poster_path")} OR ${pathLike("backdrop_path")} ORDER BY added_at DESC;`
    );
    const nested = await queryAll<{ media_id: string }>(
      await this.getMetadataDb(),
      `SELECT media_id FROM media_seasons WHERE ${pathLike("poster_path")}
      UNION SELECT media_id FROM media_episodes WHERE ${pathLike("still_path")}
      UNION SELECT r.media_id FROM media_roles r JOIN people p ON p.id = r.person_id WHERE ${pathLike("p.profile_path")};`
    );
    const known = new Set((await queryAll<{ id: string }>(this.coreDb, "SELECT id FROM media_items;")).map((row) => row.id));
    return [...new Set([...titles.map((row) => row.id), ...nested.map((row) => row.media_id).filter((id) => known.has(id))])];
  }

  /** META-ART-01: every artwork slot of a title still holding a metadata-service image path, as the copy reads it. */
  async listArtworkToCopy(mediaId: string): Promise<ArtworkSlot[]> {
    if (this.closed) return [];
    const details = await this.getMediaDetails(mediaId, { ownStorage: true });
    return details ? listDetailsArtworkSlots(details) : [];
  }

  /**
   * META-ART-01: swaps copied artwork in and syncs the title (`media.upsert`). Compare-and-set: a slot is written only
   * while it still holds the path the copy was made from, so an edit or a sync that landed meanwhile wins.
   */
  async applyArtworkCopies(mediaId: string, copies: ArtworkCopy[]): Promise<ArtworkApplyResult> {
    if (this.closed) return { applied: 0, skipped: copies.length, unapplied: copies };
    const metadataDb = await this.getMetadataDb();
    let applied = 0;
    const unapplied: ArtworkCopy[] = [];
    for (const copy of copies) {
      const swap = (() => {
        switch (copy.target) {
          case "mediaPoster":
            return copy.id === mediaId ? { db: this.coreDb, sql: "UPDATE media_items SET poster_path = ? WHERE id = ? AND poster_path = ?;", params: [copy.value, mediaId, copy.path] } : null;
          case "mediaBackdrop":
            return copy.id === mediaId ? { db: this.coreDb, sql: "UPDATE media_items SET backdrop_path = ? WHERE id = ? AND backdrop_path = ?;", params: [copy.value, mediaId, copy.path] } : null;
          case "seasonPoster":
            return { db: metadataDb, sql: "UPDATE media_seasons SET poster_path = ? WHERE id = ? AND media_id = ? AND poster_path = ?;", params: [copy.value, copy.id, mediaId, copy.path] };
          case "episodeStill":
            return { db: metadataDb, sql: "UPDATE media_episodes SET still_path = ? WHERE id = ? AND media_id = ? AND still_path = ?;", params: [copy.value, copy.id, mediaId, copy.path] };
          case "personProfile":
            return { db: metadataDb, sql: "UPDATE people SET profile_path = ? WHERE id = ? AND profile_path = ?;", params: [copy.value, copy.id, copy.path] };
        }
      })();
      const [result] = swap ? await swap.db.executeSql(swap.sql, swap.params) : [];
      if ((result?.rowsAffected ?? 0) > 0) applied += 1;
      else unapplied.push(copy);
    }
    const outcome: ArtworkApplyResult = { applied, skipped: unapplied.length, unapplied };
    // Counts only: the copies carry storage keys.
    console.info("library.artwork.applied", JSON.stringify({ mediaId, applied, skipped: unapplied.length }));
    if (applied === 0) return outcome;
    await this.coreDb.executeSql("UPDATE media_items SET updated_at = ? WHERE id = ?;", [nowIso(), mediaId]);
    await this.queueMediaUpsert(mediaId);
    return outcome;
  }

  /** Deletes stored files from the vault (`/storage/delete`). */
  async deleteStoredObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await deleteStorageObjects(this.token, keys);
    console.info("library.storage.deleted", JSON.stringify({ keys: keys.length }));
  }

  /**
   * A profile's playback settings and app language (ACCT-SQUAD-03): `profile_settings_v1` for the main profile,
   * `p:<profileId>:profile_settings_v1` for any other. `scope` defaults to the active profile; null = never saved.
   */
  async getProfileSettings(scope: ViewingScope = getViewingScope()): Promise<ProfileSettings | null> {
    if (this.closed) return null;
    const rows = await queryAll<{ value: string | null; updated_at: string | null }>(
      this.coreDb,
      "SELECT value, updated_at FROM app_settings WHERE key = ?;",
      [scopedProfileSettingsKey(scope)]
    );
    const row = rows[0];
    // A blank row (a wipe, or the promotion of a profile with no settings) is a set reset at the row's time.
    return row ? readProfileSettingsRow(row.value, String(row.updated_at ?? "")) : null;
  }

  /**
   * Read-modify-write of the profile's settings value plus its `setting.set` op, so the profile's other devices
   * follow. `updatedAt` stamps the patched fields (default now); a seed passes `PROFILE_SETTINGS_SEED_AT` so any real
   * value from another device beats it. The row and the op carry the record's time, which never goes back.
   */
  async setProfileSettings(
    patch: ProfileSettingsPatch,
    scope: ViewingScope = getViewingScope(),
    options: { updatedAt?: string } = {}
  ): Promise<void> {
    if (this.closed) return;
    const merged = mergeProfileSettings(await this.getProfileSettings(scope), patch, options.updatedAt ?? nowIso());
    console.info(
      "profile_settings.write",
      JSON.stringify({ profileId: scope.profileId, fields: Object.keys(patch), updatedAt: options.updatedAt ?? "now" })
    );
    await this.writeScopedSetting(scopedProfileSettingsKey(scope), serializeProfileSettings(merged), merged.updatedAt);
  }

  /**
   * Playback progress writer. Mirrors desktop `LibraryDb.setProgress`:
   *  - episode: `app_settings` `episode_resume_v1:<id>` + `setting.set` op, and the show's
   *    aggregate `media_items.progress_pct` + `media.progress` op;
   *  - movie (episodeId null): `media_items.progress_pct` + `media.progress` op.
   * A non-main profile (ACCT-SQUAD-02) writes the same values under its `p:<profileId>:` keys
   * (`episode_resume_v1:`, `media_progress_v1:`), never the main profile's row.
   * Ops are coalesced per key and flushed lazily.
   */
  async setPlaybackProgress(
    mediaId: string,
    episodeId: string | null,
    progressPct: number,
    timing: { positionSeconds?: number | null; durationSeconds?: number | null } | null
  ) {
    // The player's exit save can land after the library was torn down (logout, reload): nothing
    // to write to any more, and the handles would throw "database not open".
    if (this.closed) return;
    const scope = getViewingScope();
    const pct = normalizeProgressPct(progressPct);
    const timestamp = nowIso();
    const typeRows = await queryAll<{ type: string }>(this.coreDb, "SELECT type FROM media_items WHERE id = ? LIMIT 1;", [mediaId]);
    const isTv = typeRows[0]?.type === "tv";
    if (episodeId) {
      const value = buildEpisodeResumeValue({
        progressPct: pct,
        updatedAt: timestamp,
        positionSeconds: timing?.positionSeconds,
        durationSeconds: timing?.durationSeconds,
      });
      await this.writeScopedSetting(scopedEpisodeResumeKey(scope, episodeId), value, timestamp);
    }
    let mediaPct = pct;
    let lastWatchedAt = timestamp;
    if (episodeId && isTv) {
      const aggregate = await this.getTvProgressAggregate(mediaId, timestamp);
      mediaPct = aggregate?.progressPct ?? 0;
      lastWatchedAt = aggregate?.lastWatchedAt ?? timestamp;
    }
    if (!isMainScope(scope)) {
      await this.writeScopedSetting(
        scopedMediaProgressKey(scope, mediaId),
        buildMediaProgressValue({ progressPct: mediaPct, lastWatchedAt, updatedAt: timestamp }),
        timestamp
      );
      return;
    }
    await this.coreDb.executeSql(
      "UPDATE media_items SET progress_pct = ?, last_watched_at = ? WHERE id = ?;",
      [mediaPct, lastWatchedAt, mediaId]
    );
    await this.queueSupersedingProgressOp({
      id: crypto.randomUUID(),
      type: "media.progress",
      createdAt: timestamp,
      payload: { mediaId, progressPct: mediaPct, lastWatchedAt, updatedAt: timestamp },
    });
  }

  async createPlaylist(name: string) {
    const scope = getViewingScope();
    const id = randomUuid();
    const createdAt = nowIso();
    if (!isMainScope(scope)) {
      const playlist = { name, slug: null, isSystem: false, items: [], createdAt, updatedAt: createdAt };
      await this.writeScopedSetting(scopedPlaylistKey(scope, id), serializeProfilePlaylist(playlist), createdAt);
      return;
    }
    await this.insertMainPlaylist({ id, name, slug: null, isSystem: false, createdAt });
  }

  private async insertMainPlaylist(playlist: { id: string; name: string; slug: string | null; isSystem: boolean; createdAt: string }) {
    await this.coreDb.executeSql(
      "INSERT INTO playlists (id, name, slug, is_system, created_at) VALUES (?, ?, ?, ?, ?);",
      [playlist.id, playlist.name, playlist.slug, playlist.isSystem ? 1 : 0, playlist.createdAt]
    );
    await this.queueOp({
      id: crypto.randomUUID(),
      type: "playlist.create",
      createdAt: playlist.createdAt,
      payload: { ...playlist },
    });
  }

  async deletePlaylist(playlistId: string) {
    const scope = getViewingScope();
    if (!isMainScope(scope)) {
      await this.writeScopedSetting(scopedPlaylistKey(scope, playlistId), "", nowIso());
      return;
    }
    await this.coreDb.executeSql("DELETE FROM playlists WHERE id = ?;", [playlistId]);
    await this.queueOp({
      id: crypto.randomUUID(),
      type: "playlist.delete",
      createdAt: nowIso(),
      payload: { id: playlistId },
    });
  }

  async addToPlaylist(playlistId: string, mediaId: string) {
    const scope = getViewingScope();
    const addedAt = nowIso();
    if (!isMainScope(scope)) {
      const playlist = await this.readProfilePlaylist(scope, playlistId);
      if (!playlist) return;
      const next = addProfilePlaylistItem(playlist, mediaId, addedAt);
      await this.writeScopedSetting(scopedPlaylistKey(scope, playlistId), serializeProfilePlaylist(next), addedAt);
      return;
    }
    const id = randomUuid();
    await this.coreDb.executeSql(
      "INSERT OR IGNORE INTO playlist_items (id, playlist_id, media_id, added_at) VALUES (?, ?, ?, ?);",
      [id, playlistId, mediaId, addedAt]
    );
    await this.queueOp({
      id: crypto.randomUUID(),
      type: "playlist.item.add",
      createdAt: addedAt,
      payload: { id, playlistId, mediaId, addedAt },
    });
  }

  async removeFromPlaylist(playlistId: string, mediaId: string) {
    const scope = getViewingScope();
    if (!isMainScope(scope)) {
      const playlist = await this.readProfilePlaylist(scope, playlistId);
      if (!playlist) return;
      const now = nowIso();
      await this.writeScopedSetting(
        scopedPlaylistKey(scope, playlistId),
        serializeProfilePlaylist(removeProfilePlaylistItem(playlist, mediaId, now)),
        now
      );
      return;
    }
    await this.coreDb.executeSql(
      "DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?;",
      [playlistId, mediaId]
    );
    await this.queueOp({
      id: crypto.randomUUID(),
      type: "playlist.item.remove",
      createdAt: nowIso(),
      payload: { playlistId, mediaId },
    });
  }

  /**
   * ACCT-PROF-02, a deleted non-main profile: overwrites every `p:<profileId>:` key with "" (there is no delete op),
   * so its viewing state and playlists are gone on every device after sync. Returns how many keys were blanked.
   */
  async wipeProfileViewing(profileId: string): Promise<number> {
    if (this.closed) throw new Error("LIBRARY_CLOSED");
    const scope: ViewingScope = { profileId, prefix: `p:${profileId}:` };
    const keys = planProfileWipe(profileId, await this.readScopedSettings(scope));
    const now = nowIso();
    for (const key of keys) await this.writeScopedSetting(key, "", now);
    console.info("profiles.wipe", JSON.stringify({ profileId, keys: keys.length }));
    this.emitDataChanged("ops");
    return keys.length;
  }

  /**
   * ACCT-PROF-02, the main profile was deleted: the oldest remaining profile (`newMainId`) becomes main, and main is
   * where a profile's data is stored, so its `p:<id>:` state replaces the deleted main profile's state in the library's
   * own storage (`planMainPromotion`). Every write is a normal op, so the other devices follow on their next sync.
   */
  async promoteProfileToMain(newMainId: string) {
    if (this.closed) throw new Error("LIBRARY_CLOSED");
    const settingRows = await queryAll<{ key: string; value: string | null }>(this.coreDb, "SELECT key, value FROM app_settings;");
    const progressRows = await queryAll<{ id: string; progress_pct: number | null; last_watched_at: string | null }>(
      this.coreDb,
      "SELECT id, progress_pct, last_watched_at FROM media_items WHERE progress_pct > 0 OR last_watched_at IS NOT NULL;"
    );
    const playlistRows = await queryAll<{ id: string; slug: string | null; is_system: number }>(
      this.coreDb,
      "SELECT id, slug, is_system FROM playlists;"
    );
    const itemRows = await queryAll<{ playlist_id: string; media_id: string }>(
      this.coreDb,
      "SELECT playlist_id, media_id FROM playlist_items;"
    );
    const plan = planMainPromotion({
      newMainId,
      settingRows,
      mainProgress: progressRows.map((row) => ({
        mediaId: String(row.id),
        progressPct: Number(row.progress_pct) || 0,
        lastWatchedAt: row.last_watched_at ? String(row.last_watched_at) : null,
      })),
      mainPlaylists: playlistRows.map((row) => ({
        id: String(row.id),
        slug: row.slug ? String(row.slug) : null,
        isSystem: Number(row.is_system) === 1,
        mediaIds: itemRows.filter((item) => String(item.playlist_id) === String(row.id)).map((item) => String(item.media_id)),
      })),
    });
    console.info(
      "profiles.promote.plan",
      JSON.stringify({
        newMainId,
        settings: plan.settings.length,
        progress: plan.progress.length,
        playlistDeletes: plan.playlistDeletes.length,
        itemRemoves: plan.playlistItemRemoves.length,
        creates: plan.playlistCreates.length,
        itemAdds: plan.playlistItemAdds.length,
        finish: plan.finish.length,
      })
    );
    const now = nowIso();
    for (const { key, value } of plan.settings) {
      // The new main's settings replace the deleted main's whole set, so a field merge elsewhere drops the old fields.
      await this.writeScopedSetting(key, isProfileSettingsKey(key) && value ? resetProfileSettingsValue(value, now) : value, now);
    }
    for (const entry of plan.progress) {
      await this.coreDb.executeSql("UPDATE media_items SET progress_pct = ?, last_watched_at = ? WHERE id = ?;", [
        entry.progressPct,
        entry.lastWatchedAt,
        entry.mediaId,
      ]);
      await this.queueSupersedingProgressOp({
        id: crypto.randomUUID(),
        type: "media.progress",
        createdAt: now,
        payload: { mediaId: entry.mediaId, progressPct: entry.progressPct, lastWatchedAt: entry.lastWatchedAt, updatedAt: now },
      });
    }
    // Playlist moves run on the library's own tables whatever profile is active right now.
    for (const id of plan.playlistDeletes) {
      await this.coreDb.executeSql("DELETE FROM playlists WHERE id = ?;", [id]);
      await this.queueOp({ id: crypto.randomUUID(), type: "playlist.delete", createdAt: now, payload: { id } });
    }
    for (const { playlistId, mediaId } of plan.playlistItemRemoves) {
      await this.coreDb.executeSql("DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?;", [playlistId, mediaId]);
      await this.queueOp({ id: crypto.randomUUID(), type: "playlist.item.remove", createdAt: now, payload: { playlistId, mediaId } });
    }
    const adds = [...plan.playlistItemAdds];
    for (const created of plan.playlistCreates) {
      const id = systemPlaylistForSlug(created.slug)?.id ?? randomUuid(); // LIB-SYNC-10
      await this.insertMainPlaylist({ id, name: created.name, slug: created.slug, isSystem: created.isSystem, createdAt: now });
      for (const mediaId of created.mediaIds) adds.push({ playlistId: id, mediaId });
    }
    for (const { playlistId, mediaId } of adds) {
      const id = randomUuid();
      await this.coreDb.executeSql(
        "INSERT OR IGNORE INTO playlist_items (id, playlist_id, media_id, added_at) VALUES (?, ?, ?, ?);",
        [id, playlistId, mediaId, now]
      );
      await this.queueOp({
        id: crypto.randomUUID(),
        type: "playlist.item.add",
        createdAt: now,
        payload: { id, playlistId, mediaId, addedAt: now },
      });
    }
    // Last: the new main's `p:` blanks and the marker. Cut short before this, the move reruns whole (`needsMainPromotion`).
    for (const { key, value } of plan.finish) await this.writeScopedSetting(key, value, now);
    this.emitDataChanged("ops");
    return plan;
  }

  /**
   * ACCT-PROF-02: finishes the move of a main profile whose promotion never completed (`needsMainPromotion`), e.g.
   * the deleting device went offline after the API delete. Call only on a library just synced with the server, so
   * a promotion another device finished is already here. Returns whether a move ran.
   */
  /** ACCT-PROF-02: ids of the profiles holding viewing data under their own `p:<id>:` prefix (`viewingProfileIds`). */
  async listViewingProfileIds(): Promise<string[]> {
    if (this.closed) return [];
    return viewingProfileIds(await this.readScopedSettings({ profileId: null, prefix: "p:" }));
  }

  async healMainPromotion(mainId: string): Promise<boolean> {
    if (this.closed) return false;
    const settingRows = await queryAll<{ key: string; value: string | null }>(
      this.coreDb,
      "SELECT key, value FROM app_settings WHERE key = ? OR key LIKE ?;",
      [MAIN_PROFILE_SETTING_KEY, `p:${mainId}:%`]
    );
    if (!needsMainPromotion(mainId, settingRows)) return false;
    console.info("profiles.promote.heal", JSON.stringify({ mainId, rows: settingRows.length }));
    await this.promoteProfileToMain(mainId);
    return true;
  }

  /**
   * Deletes a title and everything attached to it (files, qualities, progress, playlist entries, ingest jobs,
   * offline downloads: LIB-OPS-02) through the same `applyOpStatements` a `media.delete` from another device runs,
   * and queues the op so the other devices follow. Every non-main profile's `p:<profileId>:` state of the title
   * (progress, track choices, its episodes' resume points, playlist entries) is cleared with `setting.set` ops
   * (`planMediaDeleteProfileCleanup`), which reach the other devices the same way. The encrypted pieces it leaves on
   * the server are reclaimed by the orphaned-object sweep after the next sync, not here.
   */
  async deleteMedia(mediaId: string) {
    const op: LibraryOp = {
      id: crypto.randomUUID(),
      type: "media.delete",
      createdAt: nowIso(),
      payload: { mediaId },
    };
    // Read before the delete: the statements remove the episode rows the resume keys are named after.
    const episodeRows = await queryAll<{ id: string }>(await this.getMetadataDb(), "SELECT id FROM media_episodes WHERE media_id = ?;", [
      mediaId,
    ]);
    const profileRows = await queryAll<{ key: string; value: string | null }>(
      this.coreDb,
      "SELECT key, value FROM app_settings WHERE key LIKE 'p:%';"
    );
    const buildStartedAt = Date.now();
    await this.getPlaybackDb();
    const statements = buildOpStatements(op, randomUuid, { packedPlayback: this.packedPlayback });
    await this.applyOpStatements([{ op, statements }], { origin: "local", buildMs: Date.now() - buildStartedAt });
    await this.queueOp(op);
    const now = nowIso();
    const writes = planMediaDeleteProfileCleanup({
      mediaId,
      episodeIds: episodeRows.map((row) => String(row.id)),
      rows: profileRows,
      now,
    });
    for (const { key, value } of writes) await this.writeScopedSetting(key, value, now);
    console.info("library.deleteMedia.profiles", JSON.stringify({ mediaId, episodes: episodeRows.length, keys: writes.length }));
    if (writes.length > 0) this.emitDataChanged("ops");
  }

  getSystemPlaylistId = async (slug: "favorites" | "watchlist") => {
    // A non-main profile's favorites/watchlist live at fixed ids (`p:<profileId>:playlist_v1:favorites`).
    if (!isMainScope(getViewingScope())) return slug === "favorites" ? FAVORITES_PLAYLIST_ID : WATCHLIST_PLAYLIST_ID;
    const rows = await queryAll<{ id: string }>(
      this.coreDb,
      "SELECT id FROM playlists WHERE slug = ? LIMIT 1;",
      [slug]
    );
    return rows[0]?.id ?? null;
  };

  async setSyncEnabledAndFlush(enabled: boolean) {
    this.syncEnabled = enabled;
    if (enabled) {
      await this.flushPending();
      await this.flushOps();
    }
  }

  /**
   * Writes only the sync cursor (cache.json version) — a few hundred bytes. This is the whole
   * per-change at-rest cost (LIB-STORE-05): the split databases are written by the change
   * itself and nothing re-encrypts the library until a snapshot is published.
   * Monotonic: never moves the persisted cursor backwards.
   */
  private async persistCursor(reason: string) {
    try {
      const cache = await loadCache();
      if (!cache || cache.mode !== "split") {
        debugLog("library.cursor.skipped", { reason, cacheMode: cache?.mode ?? null });
        return;
      }
      const version = Math.max(this.durableVersion, cache.version);
      await saveCache({
        ...cache,
        version,
        snapshotVersion: version,
        updatedAt: nowIso(),
      });
      console.warn("library.cursor.persisted", JSON.stringify({ version, reason }));
    } catch (error) {
      console.warn("library.cursor.failed", JSON.stringify({ reason, error: errorMessage(error) }));
    }
  }

  flushPending(): Promise<void> {
    this.flushPendingInFlight ??= this.publishPending().finally(() => {
      this.flushPendingInFlight = null;
    });
    return this.flushPendingInFlight;
  }

  private async publishPending() {
    if (!this.pendingSync) return;
    try {
      const pending = this.pendingSync;
      const startedAt = Date.now();
      const manifestStartedAt = Date.now();
      const manifestBase64 = await RNFS.readFile(pending.manifestPath, "base64");
      const manifestPayload = new Uint8Array(Buffer.from(manifestBase64, "base64"));
      console.warn("library.db.flush.manifest.done", JSON.stringify({ ms: Date.now() - manifestStartedAt }));
      const indexStartedAt = Date.now();
      const chunkIndex = await buildChunkIndexFromFile(pending.snapshotPath);
      const fileHashes = chunkIndex.chunks.map((entry) => entry.hash);
      console.warn(
        "library.db.flush.index.done",
        JSON.stringify({ ms: Date.now() - indexStartedAt, chunks: chunkIndex.chunks.length })
      );
      // PR #143 re-review P1: publish the hashes recorded with the manifest,
      // and only while the file still hashes to them. A mismatch (the fixed
      // pending files rewritten under an old record) means the manifest no
      // longer describes this file: drop the compaction snapshot; its data
      // already reached the server as ops and the next compaction rebuilds it.
      const recordedRefs = pending.chunkRefs;
      if (
        recordedRefs &&
        (recordedRefs.length !== fileHashes.length || recordedRefs.some((ref, i) => ref !== fileHashes[i]))
      ) {
        console.error(
          "library.db.flush.pending_mismatch",
          JSON.stringify({ snapshotId: pending.snapshotId, recorded: recordedRefs.length, file: fileHashes.length })
        );
        this.pendingSync = null;
        await clearPending();
        return;
      }
      if (!recordedRefs) {
        // Written by an older build: its file may have been re-encrypted by
        // persist(), so these refs are not vouched for (no chunkRefsSource).
        console.warn("library.db.flush.pending_unvouched", JSON.stringify({ snapshotId: pending.snapshotId }));
      }
      const uploadStartedAt = Date.now();
      await uploadChunksFromFile(this.token, pending.snapshotPath, chunkIndex.chunks);
      console.warn("library.db.flush.upload.done", JSON.stringify({ ms: Date.now() - uploadStartedAt }));
      const commitStartedAt = Date.now();
      const result = await this.putPendingSnapshot(pending, manifestPayload, {
        chunkRefs: fileHashes,
        chunkRefsSource: recordedRefs ? MOBILE_CHUNK_REFS_SOURCE : undefined,
        where: "flush_pending",
      });
      console.warn("library.db.flush.commit.done", JSON.stringify({ ms: Date.now() - commitStartedAt }));
      console.warn("library.db.flush.done", JSON.stringify({ ms: Date.now() - startedAt }));
      this.version = result.version;
      this.remoteVersion = result.version;
      this.durableVersion = Math.max(this.durableVersion, result.version);
      this.pendingSync = null;
      await clearPending();
      await removeCacheBlob();
      await saveCache({
        version: result.version,
        snapshotVersion: result.version,
        updatedAt: nowIso(),
        mode: "split",
      });
      await this.resetSnapshotOps(result.version);
      await this.runLibraryGc();
    } catch (error) {
      const refused409 = error instanceof ApiError && error.status === 409;
      console.warn(
        "library.db.flush.failed",
        JSON.stringify({
          ...libraryRefusalFields(error, {
            baseVersion: this.pendingSync?.baseVersion ?? null,
            consecutive409: refused409 ? 1 : 0,
          }),
          error: errorMessage(error),
        })
      );
      if ((error instanceof ApiError && error.status === 409) || error instanceof StaleSnapshotError) {
        // The pending snapshot was built on `baseVersion` and the server has moved past it (our
        // own ops advance it), so its base never comes back. It is a compaction snapshot: its
        // data already reached the server as ops. Disabling sync here (the old behaviour) turned
        // one stale snapshot into "no op is ever queued, flushed or synced again" and, because
        // pending.json survived, repeated on every cold start. Drop it (same as desktop #25 N4);
        // the next compaction builds a fresh one.
        this.pendingSync = null;
        await clearPending().catch(() => undefined);
      }
    }
  }

  syncFromRemoteIfNewer(metaOverride?: LibraryMetaHint): Promise<boolean> {
    if (!this.syncInFlight) return this.startSync(metaOverride);
    if (this.syncFollowUp) {
      // Every request made during this run shares the one follow-up. A request without a hint
      // means "read meta fresh", which is never staler than any hint.
      const queued = this.syncFollowUp.meta;
      this.syncFollowUp.meta =
        queued && metaOverride ? (metaOverride.version > queued.version ? metaOverride : queued) : undefined;
      debugLog("library.sync.joined_follow_up", { metaVersion: metaOverride?.version ?? null });
      return this.syncFollowUp.promise;
    }
    debugLog("library.sync.follow_up_queued", {
      metaVersion: metaOverride?.version ?? null,
      remoteVersion: this.remoteVersion,
    });
    const running = this.syncInFlight;
    const followUp: { promise: Promise<boolean>; meta: LibraryMetaHint | undefined } = {
      meta: metaOverride,
      promise: running
        // The running sync's own caller gets its error; the follow-up retries regardless.
        .catch(() => false)
        .then(async (firstChanged) => {
          // Requests from here on queue behind the follow-up, not onto it.
          this.syncFollowUp = null;
          const changed = await this.startSync(followUp.meta);
          // The joiner asked "is my library current, and did it change?": the run it waited
          // through may be the one that changed it.
          return firstChanged || changed;
        }),
    };
    this.syncFollowUp = followUp;
    return followUp.promise;
  }

  private startSync(metaOverride: LibraryMetaHint | undefined): Promise<boolean> {
    this.syncRunStarted = false;
    // LIB-SYNC-13: a run that found the server newer says when it ends, whoever started it (a caller the store tracks,
    // or this db's own re-sync after a rejected publish), so the sign never outlives the sync.
    const ended = (error: string | null) => {
      if (!this.syncRunStarted) return;
      this.syncRunStarted = false;
      this.emitSyncProgress({ kind: "end", error });
    };
    const run = this.runSyncFromRemoteIfNewer(metaOverride)
      .then(
        (changed) => {
          ended(null);
          return changed;
        },
        (error: unknown) => {
          ended(errorMessage(error));
          throw error;
        }
      )
      .finally(() => {
        if (this.syncInFlight === run) this.syncInFlight = null;
      });
    this.syncInFlight = run;
    return run;
  }

  private async runSyncFromRemoteIfNewer(metaOverride: LibraryMetaHint | undefined): Promise<boolean> {
    if (!this.syncEnabled) return false;
    if (this.pendingSync) {
      await this.flushPending().catch(() => undefined);
      return false;
    }
    if (this.secondaryOpsInFlight) {
      await this.secondaryOpsInFlight.catch(() => undefined);
    }
    await this.flushOps({ insideSync: true }).catch(() => undefined);
    const meta = metaOverride ?? (await readLibraryMeta(this.token));
    if (!meta || typeof meta.version !== "number") {
      return false;
    }
    if (!meta.exists) return false;
    await this.adoptTargetOpStreamVersion(meta);
    if (meta.version <= this.remoteVersion) return false;
    this.emitSyncProgress({ kind: "start", fromVersion: this.remoteVersion, toVersion: meta.version });
    debugLog("library.ops.meta", {
      metaVersion: meta.version,
      remoteVersion: this.remoteVersion,
      pendingOps: this.pendingOps.length,
    });

    let pageStartedAt = Date.now();
    let page = await fetchLibraryOpsPage(this.token, this.keyBase64, this.remoteVersion);
    // Op-stream version gate — fail fast BEFORE downloading or decrypting any
    // op payload. If the server's op stream is a newer format than this build
    // understands, applying it would silently drop the unknown op types;
    // LibraryFormatTooNewError propagates out so the UI shows the
    // "app too old" screen instead.
    const assertOpStreamSupported = (opsPage: { opStreamVersion: number }) =>
      assertLibraryCompatible({ opStreamVersion: opsPage.opStreamVersion }, MOBILE_LIBRARY_SUPPORT);
    // LIB-SYNC-11: a long tail comes in pages (`hasMore`, at most a few MB each). Each page is applied and the cursor
    // moved before the next one is asked for, so a failed page costs only that page: the next sync resumes after the
    // last applied one. Collecting every page first made a 40 MB tail of large media.upsert ops one all-or-nothing step.
    let changed = false;
    for (;;) {
      if (!page || !Array.isArray(page.ops)) {
        throw new Error("OPS_RESPONSE_INVALID");
      }
      assertOpStreamSupported(page);
      await this.adoptTargetOpStreamVersion(page);
      const listMs = Date.now() - pageStartedAt;
      debugLog("library.ops.list", {
        version: page.version,
        snapshotVersion: page.snapshotVersion,
        tooOld: page.tooOld,
        hasMore: page.hasMore ?? false,
        count: page.ops.length,
      });
      // LIB-SYNC-06: a snapshot is only for a cursor older than the op window (`tooOld`). An empty
      // list with `tooOld` false means nothing new for us (e.g. the other writer's ops were
      // superseded or the head moved by a snapshot): advance the cursor, never refetch the snapshot.
      if (page.tooOld) {
        debugLog("library.ops.snapshot", { reason: "too_old" });
        this.emitSyncProgress({ kind: "snapshot" });
        return (await this.syncFromSnapshot(meta)) || changed;
      }
      if (!page.ops.length) {
        debugLog("library.ops.empty", { version: page.version, remoteVersion: this.remoteVersion });
        if (typeof page.version === "number" && page.version > this.remoteVersion) {
          this.remoteVersion = page.version;
          if (!this.pendingOps.length) {
            this.version = Math.max(this.version, page.version);
          }
          this.durableVersion = Math.max(this.durableVersion, page.version);
          await this.persistCursor("sync_empty");
        }
        return changed;
      }
      // LIB-SYNC-13: the page's size lets the sign show before a large page holds the thread.
      this.emitSyncProgress({ kind: "fetch", bytes: page.bytes });
      if (!(await this.applyOpPage(page, listMs))) return true;
      changed = true;
      this.emitSyncProgress({ kind: "page", version: page.version });
      if (!page.hasMore) return true;
      pageStartedAt = Date.now();
      page = await fetchLibraryOpsPage(this.token, this.keyBase64, page.version);
    }
  }

  /**
   * Applies one page of the op tail and moves the cursor to its `version`. False when a media.upsert's rows failed
   * to land: the cursor is then rewound so the next sync fetches this page again.
   */
  private async applyOpPage(page: LibraryOpsPage, listMs: number): Promise<boolean> {
    // The native page read fetched, decrypted and inflated every op off the JS thread (LIB-SYNC-14, LIB-FMT-13).
    const timing = { fetchMs: page.ms, applyMs: 0, count: page.ops.length };
    const ops = page.ops.map((entry) => entry.op);

    const failuresBefore = this.secondaryFailureCount;
    const applyStartedAt = Date.now();
    try {
      await this.applyLibraryOps(ops);
    } catch (error) {
      if (!(error instanceof UnknownOpTypeError)) throw error;
      // LIB-FMT-13: an op type this build does not know. Every statement is built before any is written, so nothing
      // of the page was applied and the cursor stays put; the app asks for an update (the #3484 screen).
      console.warn("library.ops.unknown_type", JSON.stringify({ opType: error.opType, version: page.version }));
      requireLibraryUpdate();
      throw error;
    }
    timing.applyMs = Date.now() - applyStartedAt;
    console.warn(
      "library.ops.sync.timing",
      JSON.stringify({ count: timing.count, listMs, fetchMs: timing.fetchMs, applyMs: timing.applyMs, version: page.version })
    );
    this.emitDataChanged("ops");
    this.remoteVersion = page.version;
    if (!this.pendingOps.length) {
      this.version = Math.max(this.version, page.version);
    }
    // media.upsert metadata/playback rows land asynchronously; the cursor may
    // only move once they are on disk, otherwise a restart would skip them.
    await this.secondaryOpsInFlight?.catch(() => undefined);
    if (this.secondaryFailureCount !== failuresBefore) {
      // Rewind so the next sync re-fetches this batch; durableVersion (and so
      // the persisted cursor) never moved past it.
      console.warn(
        "library.cursor.skipped",
        JSON.stringify({ reason: "secondary_apply_failed", version: page.version, durableVersion: this.durableVersion })
      );
      this.remoteVersion = this.durableVersion;
      return false;
    }
    this.durableVersion = Math.max(this.durableVersion, page.version);
    await this.persistCursor("sync");
    await this.pruneDownloadsOnceCurrent();
    // Counted once the batch is durably applied: a rewound batch is fetched again and must not count twice.
    // The native page states each op's JSON size, not its ciphertext: an upper bound (ops are deflated before sealing).
    await this.noteSnapshotOps(ops, page.ops.map((entry) => entry.jsonBytes));
    return true;
  }

  /**
   * A snapshot compacts `media.delete` ops away, so the downloads of titles it no longer holds are removed
   * here (LIB-OPS-02). Only once the library is the server's current one (`serverVersion` = the server
   * library version at the snapshot fetch): a snapshot older than that may lack titles downloaded since,
   * so the check waits until the ops on top of it are durable (`runSyncFromRemoteIfNewer` calls again).
   */
  private async pruneDownloadsOnceCurrent(serverVersion?: number) {
    if (serverVersion !== undefined) this.pruneDownloadsAtVersion = serverVersion;
    if (this.pruneDownloadsAtVersion === null || this.durableVersion < this.pruneDownloadsAtVersion) return;
    this.pruneDownloadsAtVersion = null;
    let libraryMediaIds: Set<string>;
    try {
      const rows = await queryAll<{ id: string }>(this.coreDb, "SELECT id FROM media_items;");
      libraryMediaIds = new Set(rows.map((row) => row.id));
    } catch (error) {
      console.warn(
        "library.downloads.prune.failed",
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      );
      return;
    }
    await removeDownloadsOutsideLibrary(libraryMediaIds);
  }

  private async syncFromSnapshot(metaOverride?: { exists: boolean; version: number }) {
    return withSnapshotLock(async () => {
      if (this.secondaryOpsInFlight) {
        await this.secondaryOpsInFlight.catch(() => undefined);
      }
      const meta = metaOverride ?? (await readLibraryMeta(this.token));
      if (metaTargetOpStreamVersion(meta) === 4) this.targetOpStreamVersion = 4;
      if (!meta.exists) return false;
      const { remote, manifestBytes } = await fetchRemoteManifestWithRetry(this.token);
      // Versioned dual reader — see the remote-open site in LibraryDb.open.
      const manifestPlain = await decodeStoredManifest(
        this.keyBase64,
        manifestBytes,
        MOBILE_LIBRARY_SUPPORT
      );
      const manifest = JSON.parse(decodeUtf8(manifestPlain)) as LibrarySnapshotManifest;
      const snapshotDbPath = getSnapshotDbPath();
      const nextDbPath = `${snapshotDbPath}.next`;
      const tempPath = `${RNFS.CachesDirectoryPath}/library-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.blob`;
      try {
        await downloadChunksToFile(this.token, manifest, tempPath);
        await decryptFileToDb(this.keyBase64, tempPath, nextDbPath);
        await this.coreDb.close();
        await (await this.getMetadataDb()).close();
        await (await this.getPlaybackDb()).close();
        await (await this.getIngestDb()).close();
        await removeSnapshotDbFile();
        await RNFS.moveFile(nextDbPath, snapshotDbPath);
        const snapshotDb = await openSnapshotDb();
        const { coreDb, metadataDb, playbackDb, ingestDb } = await splitSnapshotToLocalDbs(snapshotDb);
        await snapshotDb.close();
        await removeSnapshotDbFile();
        await this.resetSnapshotOps(remote.snapshotVersion ?? remote.version);
        this.coreDb = coreDb;
        this.metadataDbReady = metadataDb;
        this.metadataDbResolved = metadataDb;
        this.playbackDbReady = playbackDb;
        // Re-read the split file's layout on the next use; a switched account converts it right here (LIB-FMT-12).
        this.playbackDbResolved = null;
        if (this.targetOpStreamVersion === 4) await this.convertPlaybackInPlace();
        this.ingestDbReady = ingestDb;
        this.ingestDbResolved = ingestDb;
        const snapshotVersion = remote.snapshotVersion ?? remote.version;
        this.version = snapshotVersion;
        this.remoteVersion = snapshotVersion;
        this.durableVersion = snapshotVersion;
        await this.resendHealedSystemPlaylists();
        await saveCache({
          version: snapshotVersion,
          snapshotVersion,
          updatedAt: remote.updatedAt ?? null,
          mode: "split",
        });
        this.setDatasetStatus({ core: true, metadata: true, playback: true });
        this.emitDataChanged("snapshot");
        await this.pruneDownloadsOnceCurrent(remote.version);
        return true;
      } catch (error) {
        await RNFS.unlink(tempPath).catch(() => undefined);
        await RNFS.unlink(nextDbPath).catch(() => undefined);
        throw error;
      }
    });
  }

  async exportSnapshot(): Promise<LibrarySnapshot> {
    return {
      version: this.version,
      media: await this.listMedia(),
      playlists: await this.listPlaylists(),
    };
  }

  async exportBytes() {
    return await withSnapshotLock(async () => {
      const snapshotDb = await this.buildSnapshotDb();
      const bytes = await exportDbBytes(getSnapshotDbPath());
      await snapshotDb.close();
      await removeSnapshotDbFile();
      return bytes;
    });
  }

  async clearLocalCache() {
    await LibraryDb.clearLocalCache();
  }

  static async clearLocalCache() {
    await clearCache();
    await clearCacheOwner();
    await clearPendingOps();
    await clearPending();
    await resetSplitDbFiles();
    await removeSnapshotDbFile();
  }

  /**
   * Bind the local library to `userId` before opening it. The local files are global to the app
   * install, so a different account signing in (e.g. after a revoked session, which never ran
   * logout's cleanup) must not open — or push the pending ops of — the previous account's library.
   * A legacy cache with no recorded owner is adopted.
   */
  static async claimLocalCache(userId: string) {
    const owner = await loadCacheOwner();
    if (owner !== null && owner !== userId) {
      console.warn("library.cache.owner_mismatch_cleared");
      await LibraryDb.clearLocalCache();
    }
    if (owner !== userId) await saveCacheOwner(userId);
  }
}
