import type { RuntimeCommandRequest, RuntimeCommandResponse, RuntimeErrorCode } from "../types";
import { parsePayload } from "@space/runtime-contracts/helpers";
import {
  badgerDbOpen,
  badgerDbOpenLocal,
  badgerDbCall,
  badgerDbClearLocalCache,
  badgerDbSnapshot,
} from "@space/runtime-contracts/badger/db";
import { badgerLibraryUpsertSnapshot, badgerLibraryListSnapshots, badgerLibraryGetSnapshot } from "@space/runtime-contracts/badger/library";
import { badgerIngestOpen, badgerIngestClose, badgerIngestApply, badgerIngestListJobs } from "@space/runtime-contracts/badger/ingest";
import { badgerDummyIngestStart, badgerDummyIngestUpsertJob, badgerDummyIngestGetJob, badgerDummyIngestListJobs } from "@space/runtime-contracts/badger/dummy-ingest";
import { badgerPlaybackPrepareStream, badgerPlaybackReleaseStream, badgerPlaybackListActiveSessions, badgerPlaybackRecordSignedUrlRequest, badgerPlaybackSetUploadPolicy } from "@space/runtime-contracts/badger/playback";
import { uploadPlaybackGate } from "@space/content-core/storageTransport";
import { badgerCapabilitiesTestFfmpeg } from "@space/runtime-contracts/badger/capabilities";
import { badgerStorageGc } from "@space/runtime-contracts/badger/storage";
import { badgerMediaDelete } from "@space/runtime-contracts/badger/media";
import crypto from "node:crypto";
import { existsSync, promises as fsPromises } from "node:fs";
import { loadJobStateSync } from "@space/content-core";
import { dirname as pathDirname, join as joinPath } from "node:path";
import { deleteOfflinePieceItem, offlinePieceItemPath } from "@space/library-db-runtime/offlinePieceStore";
import { isValidPlacementId, parseMediaPlacementIdFromObjectKey } from "@space/shared/storagePlacement";
import { collectMediaKeysInUse } from "@space/library-db-definition/mediaDetails";
import {
  buildTracks,
  resolveTranscodeOutputs,
  type QueuePreset,
} from "@space/ingest-core/labQueueShared";
import type { SourceCodec } from "@space/ingest-core/quality";
import { parseFilename } from "@space/ingest-core/parseMediaFilename";
import {
  getRuntimeFfmpegCapabilities,
  runRuntimeFfmpegCapabilityTest,
  type RuntimeFfmpegCapability,
} from "./badgerFfmpeg";
import { processBadgerMediaJob } from "./badgerIngest";
import { runtimeJobsStore } from "../core/jobs/store";
import { BadgerLibraryDbService, type LibraryClosedListener } from "./badgerLibraryDb";
import { LibraryFormatTooNewError } from "@space/library-db-runtime";
import { onAppUpdateRefusal } from "@space/library-db-runtime/api";
import { configureMediaIngestRuntime } from "@space/ingest-core/mediaProcessor";
import { backgroundEncodePriority } from "@space/ffmpeg/resourcePolicy";
import {
  createRuntimeContentStorageBridge,
  createRuntimeMediaStorageTransport,
} from "../core/content/storageBridge";

// --- Fault injection (test-only; all four flags must be no-ops when unset) ---
// Activated by SF_FAULT_* env vars at job start.
//
// Exported so the engineV2 step handlers (transcode/retranscode/upload) can
// honor the same flags as the legacy `runIngestJob`. Without these hooks on the
// V2 path, fault E2Es (quit-during-ingest, runtime-crash-recovery) silently
// succeed and produce `jobStatus=done` even though the flag was armed — the
// legacy `runIngestJob` is dead code for V2 ingestion. See
// `apps/runtime/src/modules/badger/steps/transcode.ts` + `upload.ts`.
export const parseFaultPct = (envValue: string | undefined): number | null => {
  if (!envValue || !envValue.trim()) return null;
  const v = Number(envValue);
  return Number.isFinite(v) ? v : null;
};

// Module-level upload-fault state (only mutated when an SF_FAULT_*_UPLOAD_* var is set).
let faultUploadActive: { failAtChunk: number | null; hangMs: number | null } = {
  failAtChunk: null,
  hangMs: null,
};
let faultUploadChunkCounter = 0;
let faultUploadHangApplied = false;
let faultUploadWrapperInstalled = false;

export const installFaultUploadWrapperIfNeeded = () => {
  if (faultUploadWrapperInstalled) return;
  faultUploadWrapperInstalled = true;
  // Build a parallel bridge so we can call the underlying upload while the
  // mediaProcessor's runtime singleton points at our wrapper. Two bridges hit
  // the same gateway HTTP path; the duplicate is acceptable for test-only use.
  const bridge = createRuntimeContentStorageBridge("badger");
  const passthroughTransport = createRuntimeMediaStorageTransport(bridge);
  const passthroughUpload = passthroughTransport.uploadStorageObject;
  configureMediaIngestRuntime({
    uploadStorageObject: async (token, objectKey, payload, options) => {
      const failAt = faultUploadActive.failAtChunk;
      if (failAt !== null && faultUploadChunkCounter === failAt) {
        throw new Error(
          `sf_fault: STORAGE_GATEWAY_UNREACHABLE (synthetic, SF_FAULT_FAIL_UPLOAD_AT_CHUNK=${failAt})`
        );
      }
      const hangMs = faultUploadActive.hangMs;
      if (hangMs !== null && !faultUploadHangApplied) {
        faultUploadHangApplied = true;
        await new Promise((resolve) => setTimeout(resolve, hangMs));
      }
      faultUploadChunkCounter += 1;
      return passthroughUpload(token, objectKey, payload, options);
    },
  });
};

/**
 * V2 entry-point for arming the upload-fault wrapper. Called by the V2 upload
 * step (and the legacy `runIngestJob`) at the start of a job. Sets up the
 * module-level state used by the wrapper. Idempotent — safe to call from
 * multiple paths in the same process.
 *
 * The wrapper itself is installed once via `configureMediaIngestRuntime` so it
 * sits in front of BOTH the V2 `uploadProducedMedia` path and the legacy
 * `processMediaJob` path.
 */
export const armUploadFaultForJob = (): void => {
  const failAtChunk = parseFaultPct(process.env.SF_FAULT_FAIL_UPLOAD_AT_CHUNK);
  const hangMs = parseFaultPct(process.env.SF_FAULT_HANG_UPLOAD_MS);
  if (failAtChunk !== null || hangMs !== null) {
    installFaultUploadWrapperIfNeeded();
    faultUploadActive = { failAtChunk, hangMs };
    faultUploadChunkCounter = 0;
    faultUploadHangApplied = false;
  } else if (faultUploadWrapperInstalled) {
    // Wrapper installed by an earlier fault-injected job; pass-through now.
    faultUploadActive = { failAtChunk: null, hangMs: null };
    faultUploadChunkCounter = 0;
  }
};

/**
 * V2 progress-fault check. Called from step handlers' `onProgress` callback.
 * Fires the configured fault when transcode/upload progress crosses the
 * threshold:
 *
 *   - `SF_FAULT_KILL_FFMPEG_AT_PCT` — aborts the step controller (kills the
 *     in-flight ffmpeg child); the engine marks the step failed.
 *   - `SF_FAULT_PROCESS_EXIT_AFTER_PCT` — hard `process.exit(137)` to simulate
 *     a runtime crash.
 *
 * Returns `true` if a fault was triggered (callers can short-circuit). State
 * is per-call-site via the provided refs so the same job doesn't fire twice.
 */
export const checkProgressFault = (
  state: { ffmpegAborted: boolean; processExitFired: boolean },
  stage: "transcoding" | "uploading",
  progress: number,
  controller: AbortController | undefined,
  jobIdForLog: string
): boolean => {
  const faultKillFfmpegAtPct = parseFaultPct(process.env.SF_FAULT_KILL_FFMPEG_AT_PCT);
  const faultProcessExitAfterPct = parseFaultPct(process.env.SF_FAULT_PROCESS_EXIT_AFTER_PCT);

  // Kill ffmpeg at configured pct (transcoding only).
  if (
    !state.ffmpegAborted &&
    faultKillFfmpegAtPct !== null &&
    stage === "transcoding" &&
    progress >= faultKillFfmpegAtPct
  ) {
    state.ffmpegAborted = true;
    const msg = `sf_fault: ffmpeg aborted at ${faultKillFfmpegAtPct}% via SF_FAULT_KILL_FFMPEG_AT_PCT (jobId=${jobIdForLog})`;
    // eslint-disable-next-line no-console
    console.log(msg);
    controller?.abort(new Error(msg));
    return true;
  }

  // Hard process exit at configured pct (any stage).
  if (
    !state.processExitFired &&
    faultProcessExitAfterPct !== null &&
    progress >= faultProcessExitAfterPct
  ) {
    state.processExitFired = true;
    // eslint-disable-next-line no-console
    console.log(
      `sf_fault: process.exit(137) at ${faultProcessExitAfterPct}% via SF_FAULT_PROCESS_EXIT_AFTER_PCT (jobId=${jobIdForLog}, stage=${stage})`
    );
    process.exit(137);
  }
  return false;
};

type LabQueueConfig = {
  enableCodecSelection: boolean;
  transcodeOutputs: Array<{ quality: string; codec: string }>;
  maxParallelTranscodes?: number;
  uiLanguage: string;
  token?: string | null;
  libraryKeyBase64?: string | null;
};

type LabJob = {
  id: string;
  filename: string;
  /** Per-media silo placement (#145); minted on first run when `id` is not a valid placement id. */
  placementId?: string;
  queueSequence?: number;
  status: "waiting" | "identifying" | "needs_match" | "ready" | "transcoding" | "uploading" | "done" | "failed" | "cancelled";
  progress: number;
  completedAt?: string;
  sourceQuality?: string;
  groupId?: string;
  jobType?: "source" | "transcode";
  includeSource?: boolean;
  includeFallback?: boolean;
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
  audioTrackIndexes?: number[];
  subtitleTrackIndexes?: number[];
  audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  pendingKey?: string;
  pendingDetails?: {
    seasons: { id: string; seasonNumber: number; name: string | null }[];
    episodes: { id: string; seasonNumber: number; episodeNumber: number; name: string | null }[];
  };
  sizeMb?: number;
  videoMeta?: {
    width: number;
    height: number;
    durationSec: number;
    codec: SourceCodec;
  } | null;
  encoder?: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu";
  selectedFormats?: { quality: string; codec: string }[];
  expanded?: boolean;
  manualQuery?: string;
  manualSelectedId?: string;
  manualSeason?: number;
  manualEpisode?: number;
  detectedTitle?: string;
  detectedYear?: string;
  detectedSeason?: number;
  detectedEpisode?: number;
  matchedMediaId?: string;
  matchedTo?: { title: string; year: string | null; posterPath: string | null; type: "movie" | "tv" };
  linked?: boolean;
  fileId?: string;
  createdAt: string;
  logs?: string[];
  uploadSpeedMbps?: number;
  error?: string;
  audioLangs?: { code: string; keep: boolean }[];
  subtitleLangs?: { code: string; keep: boolean }[];
  formatsCreated?: boolean;
  tracksAdded?: boolean;
  produced?: {
    videoFormats: Array<{
      quality: string;
      codec: string;
      codecString?: string | null;
      initKey: string;
      initSize: number;
      durationSeconds: number | null;
      totalSize: number;
      chunks: Array<{ key: string; sizeBytes: number; startSeconds?: number | null }>;
      chapters?: Array<{ title: string; startSeconds: number }>;
    }>;
    audioTracks: Array<{
      language: string;
      label: string;
      codec: string | null;
      codecString?: string | null;
      initKey: string;
      initSize: number;
      durationSeconds: number | null;
      totalSize: number;
      chunks: Array<{ key: string; sizeBytes: number; startSeconds?: number | null }>;
      isDefault?: boolean;
    }>;
    subtitleTracks: Array<{
      language: string;
      label: string;
      objectKey: string;
      format: string | null;
      isDefault?: boolean;
    }>;
  };
};

type LabQueueAction =
  | { type: "queue_files"; files: Array<{
      id: string;
      filename: string;
      sizeMb: number | null;
      sourceQuality?: string;
      videoMeta?: LabJob["videoMeta"] | null;
      groupId?: string;
      jobType?: "source" | "transcode";
      includeSource?: boolean;
      includeFallback?: boolean;
      includeAudio?: boolean;
      includeSubtitles?: boolean;
      includeChapters?: boolean;
      audioTrackIndexes?: number[];
      subtitleTrackIndexes?: number[];
      audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
      subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
      selectedFormats?: Array<{ quality: string; codec: string }>;
    }>; preset?: QueuePreset | null }
  | { type: "queue_format_jobs"; jobs: Array<{
      id: string;
      mediaId: string;
      fileId: string;
      filename: string;
      season?: number | null;
      episode?: number | null;
      formats: Array<{ quality: string; codec: string }>;
    }> }
  | { type: "attach_pending_media"; pendingKey: string; mediaId: string }
  | { type: "remove_media_jobs"; mediaId: string }
  | { type: "start_job"; jobId: string }
  | { type: "cancel_job"; jobId: string }
  | { type: "toggle_job_format"; jobId: string; quality: string; codec: string; enabled: boolean }
  | { type: "toggle_job_track"; jobId: string; trackType: "audio" | "subtitle"; code: string; keep: boolean }
  | { type: "remove_job"; jobId: string }
  | { type: "toggle_expanded"; jobId: string }
  | { type: "set_manual_query"; jobId: string; value: string }
  | { type: "set_manual_selection"; jobId: string; mediaId: string }
  | { type: "set_manual_season"; jobId: string; season: number }
  | { type: "set_manual_episode"; jobId: string; episode: number }
  | { type: "clear_match"; jobId: string }
  | { type: "clear_completed" }
  | { type: "update_job_meta"; jobId: string; videoMeta: LabJob["videoMeta"] | null };

type PersistedSegmentState = {
  key?: string;
  uploaded?: boolean;
  sizeBytes?: number;
  startSeconds?: number | null;
};

type PersistedOutputState = {
  id: string;
  kind: "video" | "audio";
  quality?: string;
  codec?: string | null;
  codecString?: string | null;
  init?: PersistedSegmentState | null;
  segments?: PersistedSegmentState[];
  durationSeconds?: number | null;
  totalSize?: number;
  language?: string;
  label?: string;
  chapters?: Array<{ title: string; startSeconds: number }>;
  encodingComplete?: boolean;
};

type PersistedSubtitleState = {
  key?: string;
  uploaded?: boolean;
  language: string;
  label: string;
  format: string | null;
  isDefault?: boolean;
};

type PersistedJobState = {
  outputs?: PersistedOutputState[];
  subtitles?: PersistedSubtitleState[];
  encoder?: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu";
};

const DEFAULT_INGEST_CONFIG: LabQueueConfig = {
  enableCodecSelection: false,
  transcodeOutputs: [],
  maxParallelTranscodes: 1,
  uiLanguage: "en",
  token: null,
  libraryKeyBase64: null,
};

const shouldExposeLiveIngestLogs = () => process.env.SF_BADGER_INGEST_DEBUG_LOGS === "1";

type IngestUserState = {
  userId: string;
  config: LabQueueConfig;
  jobs: LabJob[];
  nextQueueSequence: number;
  openedAt: string;
  updatedAt: string;
};

type DummyIngestJobStatus = "queued" | "running" | "done" | "error";

type DummyIngestJobRecord = {
  id: string;
  userId: string;
  catalogId: number;
  mediaType: "movie" | "tv";
  status: DummyIngestJobStatus;
  progress: number;
  stage: "checking_dummy" | "fetching_metadata" | "uploading_assets" | "writing_library" | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type LibrarySnapshot = {
  snapshotId: string;
  version: number;
  stateHash: string | null;
  mediaCount: number;
  playlistCount: number;
  updatedAt: string;
};

type PlaybackSessionKind = "stream" | "hls";

type PlaybackSession = {
  sessionId: string;
  kind: PlaybackSessionKind;
  url: string | null;
  contentType: string | null;
  totalSize: number | null;
  mode: "vod" | "event" | null;
  videoTrackCount: number | null;
  audioTrackCount: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
};

type PlaybackSignedUrlMetrics = {
  resetAt: string;
  requests: number;
};

type BadgerModuleDependencies = {
  processMediaJob?: typeof processBadgerMediaJob;
  /**
   * Number of engineV2 ingest jobs (source/format) that have not reached a
   * terminal status. Their uploaded objects are not referenced by the library
   * until their commit step runs, so the background storage GC must not sweep
   * while any exist. Engine ingestion never populates `activeIngestTasks`.
   */
  countUnfinishedEngineJobs?: () => Promise<number>;
  /** Called after an open library is closed (sign-out, cache clear, shutdown): grants made against it end. */
  onLibraryClosed?: LibraryClosedListener;
  /**
   * Called once a library DB opened: `online` from `badger.db.open` (remote pull done), `local` from
   * `badger.db.open_local` (no network). The runtime checks the offline copies then (OFFL-SAFE-01, OFFL-MIGR-01).
   */
  onLibraryOpened?: (mode: "online" | "local") => void;
  /** Called when `getActiveIngestUserId()` changes (RT-JOBS-07): the job engine wakes the new account's parked jobs. */
  onSessionChanged?: () => void;
};

export type BadgerModuleEvent = {
  channel: string;
  event: string;
  payload: Record<string, unknown>;
};

type BadgerModuleEventPublisher = (channel: string, event: string, payload: Record<string, unknown>) => void;

const nowIso = () => new Date().toISOString();

const error = (
  requestId: string,
  code: RuntimeErrorCode,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {}
): RuntimeCommandResponse => ({
  requestId,
  ok: false,
  result: null,
  error: {
    code,
    message,
    retryable,
    details,
  },
});

/**
 * Build the error response for a library-DB command failure.
 *
 * `LibraryFormatTooNewError` (a library surface — storage / op-stream / schema
 * — observed at a version newer than this build supports) gets its structured
 * fields lifted into the error envelope's `details`. Without this, the only
 * signal crossing the runtime→renderer boundary is the error *message*, and
 * the renderer would have to string-parse "LIBRARY_FORMAT_TOO_NEW: ..." to
 * decide whether to show the "app too old" modal — fragile coupling that
 * breaks silently if the message is ever reformatted. The runtime error code
 * stays `internal_error` (RUNTIME_ERROR_CODES has no dedicated code and
 * `details` is an open `z.record`, so no envelope contract change is needed);
 * the renderer keys off `details.kind === "library_format_too_new"`.
 */
const libraryDbCommandError = (
  requestId: string,
  e: unknown
): RuntimeCommandResponse => {
  if (e instanceof LibraryFormatTooNewError) {
    return error(requestId, "internal_error", e.message, false, {
      kind: "library_format_too_new",
      surface: e.surface,
      observed: e.observed,
      supported: e.supported,
      ...(e.group !== undefined ? { group: e.group } : {}),
    });
  }
  return error(requestId, "internal_error", e instanceof Error ? e.message : String(e));
};

// The encrypted library namespace is `library/…`, or `shards/<shardId>/library/…` once the
// API pins the object to a silo shard. GC must never treat either as an orphan.
const GC_LIBRARY_KEY = /^(?:shards\/[^/]+\/)?library\//;

export class BadgerModule {
  private ingestUsers = new Map<string, IngestUserState>();
  private activeIngestUserId: string | null = null;
  private dummyIngestJobs = new Map<string, DummyIngestJobRecord>();
  private snapshots = new Map<string, LibrarySnapshot>();
  private headSnapshotId: string | null = null;
  private playbackSessions = new Map<string, PlaybackSession>();
  private playbackSignedUrlMetrics: PlaybackSignedUrlMetrics = {
    resetAt: nowIso(),
    requests: 0,
  };
  private eventPublisher: BadgerModuleEventPublisher | null = null;
  private stopAppUpdateRefusals: (() => void) | null = null;
  private activeIngestTasks = new Map<string, AbortController>();
  private lastIngestEventAt = new Map<string, number>();
  /**
   * Per-job last-published status. Used by `publishIngestJobsUpdate` to
   * bypass the 2s throttle when ANY job's status changed since the last
   * publish — otherwise a state transition emitted within 2s of the prior
   * progress sample is silently dropped, and the renderer never sees
   * intermediate stages like "uploading". Same-status progress updates
   * within the window remain throttled (preserves "no constant refreshes").
   */
  private lastPublishedStatusByJob = new Map<string, string>();
  private readonly processMediaJob: typeof processBadgerMediaJob;
  private readonly countUnfinishedEngineJobs: () => Promise<number>;
  readonly libraryDbService = new BadgerLibraryDbService();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private gcStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private gcRunning = false;
  private gcFailedKeys = new Map<string, number>();
  private backendToken: string | null = null;
  // Auth-attached user id (from onKeySet). Mirrors backendToken: it's the
  // user this runtime is authenticated as, available even when no ingest
  // session is open. getActiveIngestUserId() falls back to this so post-ingest
  // ops (replan_qualities) can stamp jobs on a sync-populated library.
  private backendUserId: string | null = null;
  private readonly onSessionChanged: () => void;
  private readonly onLibraryOpened: (mode: "online" | "local") => void;
  /**
   * Module-level cache of the most recently set library key. Set by
   * `setLibraryKey` and consumed as a fallback by `getActiveLibraryKey` and as
   * a default when `openIngestQueue` creates a new `IngestUserState`. Without
   * this cache, a `keys/set` that arrives before any ingest user exists is a
   * no-op (the for-loop iterates an empty Map) — see runtime.ts:14-21 for the
   * startup replay that triggers this condition. The startup path always calls
   * onKeySet before any client connects, so empty-map setLibraryKey is the norm
   * on every restart.
   */
  private cachedLibraryKey: string | null = null;
  /** Layer 3 of storage-tracker-refactor (plan even-with-only-a-zesty-nest.md):
   * one-shot startup GC fires once per process lifetime on first authenticated
   * heartbeat, so reopening a session inside the same process doesn't burn
   * the safety budget on a redundant immediate sweep. */
  private gcStartupFired = false;
  /** Background GC interval in ms. Layer 3 default = 6h (`6 * 60 * 60 * 1000`).
   * Override with `BADGER_GC_INTERVAL_MS`. Set to 0 to disable. */
  private static readonly DEFAULT_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;

  constructor(deps: BadgerModuleDependencies = {}) {
    this.processMediaJob = deps.processMediaJob ?? processBadgerMediaJob;
    this.countUnfinishedEngineJobs = deps.countUnfinishedEngineJobs ?? (async () => 0);
    this.onSessionChanged = deps.onSessionChanged ?? (() => {});
    this.onLibraryOpened = deps.onLibraryOpened ?? (() => {});
    if (deps.onLibraryClosed) this.libraryDbService.setClosedListener(deps.onLibraryClosed);
  }

  setLibraryKey(keyBase64: string) {
    this.cachedLibraryKey = keyBase64;
    // Update any active ingest user config
    for (const state of this.ingestUsers.values()) {
      state.config.libraryKeyBase64 = keyBase64;
    }
  }

  /**
   * Returns the active ingest user's token (preferred) or the module-level
   * backend token. Used by the engineV2 step-deps adapter to thread auth
   * through to processMediaJob without per-step plumbing.
   */
  getActiveIngestToken(): string | null {
    const ingestToken = this.getActiveIngestUserState()?.config.token?.trim();
    if (ingestToken) return ingestToken;
    return this.backendToken?.trim() || null;
  }

  /**
   * Returns the active user id for stamping post-ingest jobs. Prefers the
   * active ingest user, then falls back to the auth-attached user
   * (`backendUserId`, set by onKeySet) — mirroring how getActiveIngestToken
   * falls back to backendToken. Without the fallback, post-ingest
   * replan_qualities on a sync-populated library (no ingest session) stamps an
   * empty userId and the retranscode step fails with
   * STEP_RETRANSCODE_MISSING_USER_ID.
   */
  getActiveIngestUserId(): string | null {
    return this.activeIngestUserId ?? this.backendUserId;
  }

  /**
   * Returns the active ingest user's library key (base64). Used by the
   * engineV2 step-deps adapter for media encryption.
   */
  getActiveLibraryKey(): string | null {
    const key = this.getActiveIngestUserState()?.config.libraryKeyBase64?.trim();
    if (key && key.length > 0) return key;
    const cached = this.cachedLibraryKey?.trim();
    return cached && cached.length > 0 ? cached : null;
  }

  setBackendToken(token: string) {
    this.backendToken = token;
    this.startGcTimer();
  }

  /**
   * Stores the auth-attached user id (from onKeySet). Used as the fallback in
   * getActiveIngestUserId() so post-ingest jobs resolve a user even when no
   * ingest session is active.
   */
  setBackendUserId(userId: string) {
    this.switchSessionUser(() => {
      this.backendUserId = userId?.trim() || null;
    });
  }

  /** Applies `change` and reports a resulting change of the active session's account (RT-JOBS-07). */
  private switchSessionUser(change: () => void) {
    const before = this.getActiveIngestUserId();
    change();
    const after = this.getActiveIngestUserId();
    if (before === after) return;
    console.info(JSON.stringify({ event: "badger.session.user_changed", before, after }));
    this.onSessionChanged();
  }

  /** The user whose key the runtime last received (null: nobody signed in). */
  getBackendUserId(): string | null {
    return this.backendUserId;
  }

  /**
   * Stops timers, aborts running ingest tasks and closes the library DB, which is
   * where a scheduled cache persist is flushed (RT-LIFE-04). Resolves once the DB
   * is closed; the runtime's shutdown drain awaits it. The close runs even when
   * an earlier stop step throws: it is the step that must not be skipped.
   */
  async shutdown() {
    try {
      this.stopGcTimer();
      this.backendToken = null;
      this.backendUserId = null;
      for (const controller of this.activeIngestTasks.values()) {
        controller.abort();
      }
      this.activeIngestTasks.clear();
      this.lastIngestEventAt.clear();
      this.lastPublishedStatusByJob.clear();
    } finally {
      await this.libraryDbService.close("shutdown");
    }
  }

  private resolveGcIntervalMs(): number {
    const raw = process.env.BADGER_GC_INTERVAL_MS;
    if (raw === undefined || raw === null || raw.trim() === "") {
      return BadgerModule.DEFAULT_GC_INTERVAL_MS;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return BadgerModule.DEFAULT_GC_INTERVAL_MS;
    return Math.trunc(parsed);
  }

  private startGcTimer() {
    if (this.gcTimer || this.gcStartupTimer) return;
    const intervalMs = this.resolveGcIntervalMs();
    if (intervalMs === 0) {
      console.log(
        JSON.stringify({ event: "badger.storage.gc.disabled", reason: "BADGER_GC_INTERVAL_MS=0" })
      );
      return;
    }
    this.gcTimer = setInterval(() => {
      void this.tryBackgroundGc("interval");
    }, intervalMs);
    // One-shot startup run (per process lifetime): kick a sweep shortly after
    // the first authenticated heartbeat so an existing 30 GB-style backlog gets
    // reclaimed without waiting a full interval. The 5 s delay avoids
    // contention with anything still warming up at boot.
    if (!this.gcStartupFired) {
      this.gcStartupTimer = setTimeout(() => {
        this.gcStartupTimer = null;
        this.gcStartupFired = true;
        void this.tryBackgroundGc("startup");
      }, 5_000);
    }
  }

  private stopGcTimer() {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    if (this.gcStartupTimer) {
      clearTimeout(this.gcStartupTimer);
      this.gcStartupTimer = null;
    }
  }

  private resolveGcToken(): string | null {
    const ingestToken = this.getActiveIngestUserState()?.config.token?.trim();
    if (ingestToken) return ingestToken;
    return this.backendToken?.trim() || null;
  }

  private async tryBackgroundGc(trigger: "startup" | "interval") {
    // gcRunning re-entrancy guard is also enforced inside executeStorageGc;
    // checking here lets us emit a structured-log skip line without paying the
    // network round-trip for the inner guard.
    if (this.gcRunning) {
      console.log(
        JSON.stringify({ event: "badger.storage.gc.skipped", trigger, reason: "gc_running" })
      );
      return;
    }
    if (this.activeIngestTasks.size > 0) {
      console.log(
        JSON.stringify({
          event: "badger.storage.gc.skipped",
          trigger,
          reason: "active_ingest_tasks",
          activeIngestTasks: this.activeIngestTasks.size,
        })
      );
      return;
    }
    // engineV2 jobs upload objects well before their commit step adds them to
    // the library snapshot; sweeping in between deletes media that the commit
    // then points at (download_source_missing on playback, issue #25). If the
    // count itself fails, fail closed: skip this sweep rather than risk it.
    // executeStorageGc re-checks right before deleting; this early skip just
    // avoids the listing round-trips.
    const engineBlocker = await this.engineJobsGcBlocker();
    if (engineBlocker) {
      const line = JSON.stringify({ event: "badger.storage.gc.skipped", trigger, ...engineBlocker });
      if (engineBlocker.reason === "engine_jobs_unknown") console.warn(line);
      else console.log(line);
      return;
    }
    const token = this.resolveGcToken();
    if (!token) {
      console.log(
        JSON.stringify({ event: "badger.storage.gc.skipped", trigger, reason: "no_token" })
      );
      return;
    }
    try {
      const result = await this.executeStorageGc(token, false);
      await this.reconcileStorageQuota(token);
      console.log(
        JSON.stringify({
          event: "badger.storage.gc.run",
          trigger,
          orphanedKeys: result.orphanedKeys,
          deletedKeys: result.deletedKeys,
          reclaimedBytes: result.reclaimedBytes,
          failedKeys: result.failedKeys,
          missingKeys: result.missingKeys,
          graceProtectedKeys: result.graceProtectedKeys,
          abortReason: result.abortReason,
        })
      );
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "badger.storage.gc.error",
          trigger,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  setEventPublisher(publisher: BadgerModuleEventPublisher | null) {
    this.eventPublisher = publisher;
    // REL-CD-29 / LIB-FMT-13: a "please update" refusal the runtime's own API calls get (library sync, uploads) reaches
    // the desktop, which owns the update gate; without it the library stalled with no word to the user.
    this.stopAppUpdateRefusals?.();
    this.stopAppUpdateRefusals = publisher
      ? onAppUpdateRefusal((refusal) => this.publishAsyncEvent("badger.library", "badger.app.update_required", refusal))
      : null;
    this.libraryDbService.setEventPublisher(
      publisher
        ? (channel, event, payload) => this.publishAsyncEvent(channel, event, payload)
        : null
    );
  }

  async execute(request: RuntimeCommandRequest): Promise<{ response: RuntimeCommandResponse; event?: BadgerModuleEvent }> {
    const { command } = request;
    if (command === "badger.library.get_state") return this.getLibraryState(request);
    if (command === "badger.library.upsert_snapshot") return this.upsertLibrarySnapshot(request);
    if (command === "badger.library.list_snapshots") return this.listLibrarySnapshots(request);
    if (command === "badger.library.get_snapshot") return this.getLibrarySnapshot(request);
    if (command === "badger.library.clear") return this.clearLibrarySnapshots(request);
    if (command === "badger.ingest.open") return this.openIngestQueue(request);
    if (command === "badger.ingest.close") return this.closeIngestQueue(request);
    if (command === "badger.ingest.get_state") return this.getIngestQueueState(request);
    if (command === "badger.ingest.apply") return this.applyIngestQueueActions(request);
    if (command === "badger.ingest.list_jobs") return this.listJobs(request);
    if (command === "badger.dummy_ingest.start") return this.startDummyIngestJob(request);
    if (command === "badger.dummy_ingest.upsert_job") return this.upsertDummyIngestJob(request);
    if (command === "badger.dummy_ingest.get_job") return this.getDummyIngestJob(request);
    if (command === "badger.dummy_ingest.list_jobs") return this.listDummyIngestJobs(request);
    if (command === "badger.playback.prepare_stream") return this.preparePlaybackSession(request);
    if (command === "badger.playback.release_stream") return this.releasePlaybackSession(request);
    if (command === "badger.playback.set_upload_policy") return this.setUploadPolicy(request);
    if (command === "badger.playback.list_active_sessions") return this.listActivePlaybackSessions(request);
    if (command === "badger.playback.record_signed_url_request") return this.recordPlaybackSignedUrlRequest(request);
    if (command === "badger.playback.get_signed_url_metrics") return this.getPlaybackSignedUrlMetrics(request);
    if (command === "badger.playback.reset_signed_url_metrics") return this.resetPlaybackSignedUrlMetrics(request);
    if (command === "badger.capabilities.get_ffmpeg") return this.getFfmpegCapabilities(request);
    if (command === "badger.capabilities.test_ffmpeg") return this.testFfmpegCapabilities(request);
    if (command === "badger.db.open") return this.openLibraryDb(request);
    if (command === "badger.db.open_local") return this.openLibraryDbLocal(request);
    if (command === "badger.db.close") return this.closeLibraryDb(request);
    if (command === "badger.db.clearLocalCache") return this.clearLibraryDbLocalCache(request);
    if (command === "badger.db.snapshot") return this.getLibraryDbSnapshot(request);
    if (command === "badger.db.call") return this.callLibraryDb(request);
    if (command === "badger.db.status") return this.getLibraryDbStatus(request);
    if (command === "badger.storage.gc") return this.runStorageGc(request);
    if (command === "badger.media.delete") return this.runMediaDelete(request);
    return {
      response: error(request.requestId, "invalid_command", `Unsupported badger command: ${command}`),
    };
  }

  getStateSummary() {
    const head = this.headSnapshotId ? this.snapshots.get(this.headSnapshotId) ?? null : null;
    return {
      library: {
        totalSnapshots: this.snapshots.size,
        headSnapshotId: this.headSnapshotId,
        headVersion: head?.version ?? null,
        updatedAt: head?.updatedAt ?? null,
      },
      ingest: {
        activeUserId: this.activeIngestUserId,
        userCount: this.ingestUsers.size,
        activeJobs:
          this.activeIngestUserId && this.ingestUsers.get(this.activeIngestUserId)
            ? this.ingestUsers.get(this.activeIngestUserId)?.jobs.length ?? 0
            : 0,
        maxParallelTranscodes:
          this.activeIngestUserId && this.ingestUsers.get(this.activeIngestUserId)
            ? Math.max(
                1,
                Math.min(3, Math.trunc(this.ingestUsers.get(this.activeIngestUserId)?.config.maxParallelTranscodes ?? 1))
              )
            : 1,
      },
      dummyIngest: {
        totalJobs: this.dummyIngestJobs.size,
      },
      playback: {
        activeSessions: [...this.playbackSessions.values()].filter((session) => session.releasedAt === null).length,
        totalSessions: this.playbackSessions.size,
        signedUrlRequests: this.playbackSignedUrlMetrics.requests,
        signedUrlResetAt: this.playbackSignedUrlMetrics.resetAt,
      },
    };
  }

  private publishAsyncEvent(channel: string, event: string, payload: Record<string, unknown>) {
    this.eventPublisher?.(channel, event, payload);
  }

  private publishIngestJobsUpdate(state: IngestUserState, force = false) {
    const nowMs = Date.now();
    const lastAt = this.lastIngestEventAt.get(state.userId) ?? 0;
    // Status-transition bypass: if ANY job's status differs from its
    // last-published value, treat this publish as forced regardless of
    // timing. Same-status progress updates keep the 2s throttle so the
    // renderer doesn't see a fire-hose of pct samples.
    const statusChanged = state.jobs.some((job) => {
      const last = this.lastPublishedStatusByJob.get(job.id);
      return last !== job.status;
    });
    if (!force && !statusChanged && nowMs - lastAt < 2000) return;
    this.lastIngestEventAt.set(state.userId, nowMs);
    for (const job of state.jobs) {
      this.lastPublishedStatusByJob.set(job.id, job.status);
    }
    this.publishAsyncEvent("ingest", "ingest.jobs_updated", {
      userId: state.userId,
      changed: true,
      total: state.jobs.length,
      jobs: state.jobs.map((job) => this.toIngestJobView(job)),
    });
  }

  private toPlaybackSessionView(session: PlaybackSession) {
    return { ...session };
  }

  private preparePlaybackSession(request: RuntimeCommandRequest): {
    response: RuntimeCommandResponse;
    event?: BadgerModuleEvent;
  } {
    const parsed = parsePayload(badgerPlaybackPrepareStream, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const sessionId = parsed.data.sessionId ?? crypto.randomUUID();
    const kind: PlaybackSessionKind = parsed.data.kind ?? "stream";
    const totalSize = parsed.data.totalSize ?? null;
    const url = parsed.data.url ?? null;
    const contentType = parsed.data.contentType ?? null;
    const mode = parsed.data.mode ?? null;
    const videoTrackCount = parsed.data.videoTrackCount ?? null;
    const audioTrackCount = parsed.data.audioTrackCount ?? null;
    const metadata = parsed.data.metadata ?? null;
    const now = nowIso();
    const existing = this.playbackSessions.get(sessionId);
    const next: PlaybackSession = {
      sessionId,
      kind,
      url: url ?? existing?.url ?? null,
      contentType: contentType ?? existing?.contentType ?? null,
      totalSize: totalSize ?? existing?.totalSize ?? null,
      mode: mode ?? existing?.mode ?? null,
      videoTrackCount: videoTrackCount ?? existing?.videoTrackCount ?? null,
      audioTrackCount: audioTrackCount ?? existing?.audioTrackCount ?? null,
      metadata: metadata ?? existing?.metadata ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      releasedAt: null,
    };
    this.playbackSessions.set(sessionId, next);
    const activeSessions = this.syncBackgroundEncodePriority("playback.stream_prepared", sessionId);
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: this.toPlaybackSessionView(next),
        error: null,
      },
      event: {
        channel: "playback",
        event: "playback.stream_prepared",
        payload: {
          sessionId,
          kind,
          activeSessions,
        },
      },
    };
  }

  /**
   * P23: while any playback session is open, every background ffmpeg encode
   * (format/retranscode/backfill) drops to the lowest CPU priority so mpv and
   * the UI win contention on a 4-core box; it returns to the normal
   * background level once the last session is released. Returns the active
   * session count.
   */
  private syncBackgroundEncodePriority(reason: string, sessionId: string): number {
    const activeSessions = [...this.playbackSessions.values()].filter((session) => session.releasedAt === null).length;
    backgroundEncodePriority.setPlaybackActive(activeSessions > 0, { reason, sessionId, activeSessions });
    return activeSessions;
  }

  private releasePlaybackSession(request: RuntimeCommandRequest): {
    response: RuntimeCommandResponse;
    event?: BadgerModuleEvent;
  } {
    const parsed = parsePayload(badgerPlaybackReleaseStream, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { sessionId } = parsed.data;
    const current = this.playbackSessions.get(sessionId);
    if (!current) {
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result: { released: false, reason: "session_not_found", sessionId },
          error: null,
        },
      };
    }
    const releasedAt = nowIso();
    const next: PlaybackSession = {
      ...current,
      releasedAt,
      updatedAt: releasedAt,
    };
    this.playbackSessions.set(sessionId, next);
    const activeSessions = this.syncBackgroundEncodePriority("playback.stream_released", sessionId);
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          released: true,
          sessionId,
          releasedAt,
        },
        error: null,
      },
      event: {
        channel: "playback",
        event: "playback.stream_released",
        payload: {
          sessionId,
          kind: current.kind,
          activeSessions,
        },
      },
    };
  }

  /** "Uploads while a video plays" (#25): hands the desktop's setting + mpv-alive lease to the ingest upload gate. */
  private setUploadPolicy(request: RuntimeCommandRequest): { response: RuntimeCommandResponse } {
    const parsed = parsePayload(badgerPlaybackSetUploadPolicy, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { mode, playbackActive, leaseMs } = parsed.data;
    uploadPlaybackGate.update({ mode, playbackActive, leaseMs });
    const state = uploadPlaybackGate.getState();
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: { mode: state.mode, playbackActive: state.playbackActive, effective: state.effective },
        error: null,
      },
    };
  }

  private listActivePlaybackSessions(request: RuntimeCommandRequest): {
    response: RuntimeCommandResponse;
    event?: BadgerModuleEvent;
  } {
    const parsed = parsePayload(badgerPlaybackListActiveSessions, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const includeReleased = parsed.data.includeReleased ?? false;
    const kindFilter: PlaybackSessionKind | null = parsed.data.kind ?? null;
    const sessions = [...this.playbackSessions.values()]
      .filter((session) => (includeReleased ? true : session.releasedAt === null))
      .filter((session) => (kindFilter ? session.kind === kindFilter : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          listedAt: nowIso(),
          total: sessions.length,
          includeReleased,
          sessions: sessions.map((session) => this.toPlaybackSessionView(session)),
        },
        error: null,
      },
      event: {
        channel: "playback",
        event: "playback.sessions_listed",
        payload: {
          total: sessions.length,
          includeReleased,
        },
      },
    };
  }

  private recordPlaybackSignedUrlRequest(request: RuntimeCommandRequest): {
    response: RuntimeCommandResponse;
    event?: BadgerModuleEvent;
  } {
    const parsed = parsePayload(badgerPlaybackRecordSignedUrlRequest, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const increment = parsed.data.increment ?? 1;
    this.playbackSignedUrlMetrics = {
      ...this.playbackSignedUrlMetrics,
      requests: this.playbackSignedUrlMetrics.requests + increment,
    };
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          requests: this.playbackSignedUrlMetrics.requests,
          resetAt: this.playbackSignedUrlMetrics.resetAt,
        },
        error: null,
      },
      event: {
        channel: "playback",
        event: "playback.signed_url_request_recorded",
        payload: {
          requests: this.playbackSignedUrlMetrics.requests,
          increment,
        },
      },
    };
  }

  private getPlaybackSignedUrlMetrics(request: RuntimeCommandRequest): {
    response: RuntimeCommandResponse;
    event?: BadgerModuleEvent;
  } {
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          requests: this.playbackSignedUrlMetrics.requests,
          resetAt: this.playbackSignedUrlMetrics.resetAt,
        },
        error: null,
      },
      event: {
        channel: "playback",
        event: "playback.signed_url_metrics_requested",
        payload: {
          requests: this.playbackSignedUrlMetrics.requests,
        },
      },
    };
  }

  private resetPlaybackSignedUrlMetrics(request: RuntimeCommandRequest): {
    response: RuntimeCommandResponse;
    event?: BadgerModuleEvent;
  } {
    this.playbackSignedUrlMetrics = {
      resetAt: nowIso(),
      requests: 0,
    };
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          requests: this.playbackSignedUrlMetrics.requests,
          resetAt: this.playbackSignedUrlMetrics.resetAt,
        },
        error: null,
      },
      event: {
        channel: "playback",
        event: "playback.signed_url_metrics_reset",
        payload: {
          resetAt: this.playbackSignedUrlMetrics.resetAt,
        },
      },
    };
  }

  private toDummyIngestJobView(job: DummyIngestJobRecord) {
    return { ...job };
  }

  private startDummyIngestJob(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerDummyIngestStart, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { userId, catalogId, mediaType } = parsed.data;
    const jobId = parsed.data.jobId ?? crypto.randomUUID();
    const now = nowIso();
    const existing = this.dummyIngestJobs.get(jobId);
    const next: DummyIngestJobRecord = existing ?? {
      id: jobId,
      userId,
      catalogId,
      mediaType,
      status: "queued",
      progress: 0,
      stage: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.dummyIngestJobs.set(jobId, next);
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          jobId,
          userId,
          status: next.status,
          progress: next.progress,
        },
        error: null,
      },
      event: {
        channel: "dummy_ingest",
        event: "dummy_ingest.started",
        payload: { jobId, userId, status: next.status },
      },
    };
  }

  private upsertDummyIngestJob(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerDummyIngestUpsertJob, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { jobId } = parsed.data;
    const existing = this.dummyIngestJobs.get(jobId);
    const userId = parsed.data.userId ?? existing?.userId ?? "";
    if (!userId) {
      return {
        response: error(request.requestId, "invalid_payload", "userId is required", false, { field: "userId" }),
      };
    }
    const catalogId = parsed.data.catalogId ?? existing?.catalogId ?? Number.NaN;
    if (!Number.isFinite(catalogId) || catalogId <= 0) {
      return {
        response: error(request.requestId, "invalid_payload", "catalogId must be a positive number", false, {
          field: "catalogId",
        }),
      };
    }
    const mediaType = parsed.data.mediaType ?? existing?.mediaType ?? null;
    if (!mediaType) {
      return {
        response: error(request.requestId, "invalid_payload", "mediaType must be movie or tv", false, {
          field: "mediaType",
        }),
      };
    }
    const status = parsed.data.status ?? existing?.status ?? "queued";
    const progress =
      parsed.data.progress !== undefined ? Math.max(0, Math.min(100, parsed.data.progress)) : existing?.progress ?? 0;
    const stageRaw = parsed.data.stage !== undefined ? parsed.data.stage : existing?.stage ?? null;
    const stage: DummyIngestJobRecord["stage"] =
      stageRaw === "checking_dummy" || stageRaw === "fetching_metadata" || stageRaw === "uploading_assets" || stageRaw === "writing_library" || stageRaw === null
        ? stageRaw
        : existing?.stage ?? null;
    const errorValue = parsed.data.error !== undefined ? parsed.data.error : existing?.error ?? null;
    const createdAt = parsed.data.createdAt ?? existing?.createdAt ?? nowIso();
    const updatedAt = parsed.data.updatedAt ?? nowIso();
    const next: DummyIngestJobRecord = {
      id: jobId,
      userId,
      catalogId,
      mediaType,
      status,
      progress,
      stage,
      error: errorValue,
      createdAt,
      updatedAt,
    };
    this.dummyIngestJobs.set(jobId, next);
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: this.toDummyIngestJobView(next),
        error: null,
      },
      event: {
        channel: "dummy_ingest",
        event: "dummy_ingest.job_upserted",
        payload: {
          jobId,
          userId,
          status,
          progress,
        },
      },
    };
  }

  private getDummyIngestJob(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerDummyIngestGetJob, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { jobId } = parsed.data;
    const job = this.dummyIngestJobs.get(jobId);
    if (!job) {
      return {
        response: error(request.requestId, "invalid_payload", "job not found", false, { field: "jobId", jobId }),
      };
    }
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: this.toDummyIngestJobView(job),
        error: null,
      },
      event: {
        channel: "dummy_ingest",
        event: "dummy_ingest.job_read",
        payload: { jobId },
      },
    };
  }

  private listDummyIngestJobs(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerDummyIngestListJobs, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const userId = parsed.data.userId ?? null;
    const statusFilter = parsed.data.status ?? null;
    const jobs = [...this.dummyIngestJobs.values()]
      .filter((job) => (userId ? job.userId === userId : true))
      .filter((job) => (statusFilter ? job.status === statusFilter : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          userId,
          total: jobs.length,
          listedAt: nowIso(),
          jobs: jobs.map((job) => this.toDummyIngestJobView(job)),
        },
        error: null,
      },
      event: {
        channel: "dummy_ingest",
        event: "dummy_ingest.jobs_listed",
        payload: {
          userId,
          total: jobs.length,
        },
      },
    };
  }

  private toIngestJobView(job: LabJob) {
    const { logs, ...rest } = job;
    return {
      ...rest,
      logs: logs?.length ? logs.slice(-5) : undefined,
    };
  }

  private resolveIngestUserId(payload: RuntimeCommandRequest["payload"]) {
    const requestedUserId =
      typeof payload.userId === "string" && payload.userId.trim().length > 0 ? payload.userId.trim() : null;
    return requestedUserId ?? this.activeIngestUserId;
  }

  private getActiveIngestUserState() {
    if (!this.activeIngestUserId) return null;
    return this.ingestUsers.get(this.activeIngestUserId) ?? null;
  }

  getSchedulingHints() {
    const state = this.getActiveIngestUserState();
    return {
      maxParallelTranscodes: Math.max(1, Math.min(3, Math.trunc(state?.config.maxParallelTranscodes ?? 1))),
    };
  }

  private openIngestQueue(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerIngestOpen, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { userId } = parsed.data;
    const now = nowIso();
    const previous = this.ingestUsers.get(userId);
    const config = {
      ...DEFAULT_INGEST_CONFIG,
      libraryKeyBase64: this.cachedLibraryKey,
      ...(previous?.config ?? {}),
      ...(parsed.data.config ? (parsed.data.config as Partial<LabQueueConfig>) : {}),
    };
    const next: IngestUserState = {
      userId,
      config,
      jobs: previous?.jobs ?? this.restorePersistedIngestJobs(userId),
      nextQueueSequence:
        previous?.nextQueueSequence ??
        ((previous?.jobs ?? this.restorePersistedIngestJobs(userId)).reduce(
          (max, job) => Math.max(max, Math.trunc(job.queueSequence ?? 0)),
          0
        ) + 1),
      openedAt: previous?.openedAt ?? now,
      updatedAt: now,
    };
    this.ingestUsers.set(userId, next);
    this.switchSessionUser(() => {
      this.activeIngestUserId = userId;
    });
    this.ensureIngestProcessing(next);
    this.startGcTimer();
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          userId,
          openedAt: next.openedAt,
          updatedAt: now,
          totalJobs: next.jobs.length,
        },
        error: null,
      },
      event: {
        channel: "ingest",
        event: "ingest.queue_opened",
        payload: {
          userId,
          jobs: next.jobs.length,
        },
      },
    };
  }

  private restorePersistedIngestJobs(userId: string): LabJob[] {
    return runtimeJobsStore
      .list(
        {
          app: "badger",
          kind: ["badger.ingest.media_file"],
          includeCompleted: true,
        },
        null
      )
      .filter((job) => job.jobId.startsWith(`badger:ingest:${userId}:`))
      .map((job) => {
        const payload = (job.payload ?? {}) as Partial<LabJob> & { userId?: string | null };
        if (payload.userId && payload.userId !== userId) return null;
        if (typeof payload.id !== "string" || !payload.id.trim() || typeof payload.filename !== "string") {
          return null;
        }
        const status =
          payload.status === "waiting" ||
          payload.status === "identifying" ||
          payload.status === "needs_match" ||
          payload.status === "ready" ||
          payload.status === "transcoding" ||
          payload.status === "uploading" ||
          payload.status === "done" ||
          payload.status === "cancelled" ||
          payload.status === "failed"
            ? payload.status
            : job.status === "queued"
              ? "ready"
              : job.status === "running"
                ? "transcoding"
                : job.status === "succeeded"
                  ? "done"
                  : job.status === "cancelled"
                    ? "cancelled"
                  : "failed";
        return {
          ...(payload as LabJob),
          id: payload.id,
          filename: payload.filename,
          status,
          progress: typeof payload.progress === "number" ? payload.progress : job.progress?.completed ?? 0,
          createdAt: typeof payload.createdAt === "string" ? payload.createdAt : job.createdAt,
          logs: Array.isArray(payload.logs) ? payload.logs : [],
        } satisfies LabJob;
      })
      .filter((job) => Boolean(job))
      .sort((a, b) => {
        const aSequence = Math.trunc(a!.queueSequence ?? Number.MAX_SAFE_INTEGER);
        const bSequence = Math.trunc(b!.queueSequence ?? Number.MAX_SAFE_INTEGER);
        if (aSequence !== bSequence) return aSequence - bSequence;
        return a!.createdAt.localeCompare(b!.createdAt);
      }) as LabJob[];
  }

  private closeIngestQueue(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerIngestClose, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const userId = parsed.data.userId ?? this.activeIngestUserId;
    if (!userId) {
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result: { closed: false, reason: "not_open" },
          error: null,
        },
      };
    }
    const state = this.ingestUsers.get(userId) ?? null;
    for (const job of state?.jobs ?? []) {
      this.abortIngestJob(userId, job.id);
    }
    this.switchSessionUser(() => {
      this.activeIngestUserId = null;
    });
    this.lastIngestEventAt.delete(userId);
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          closed: true,
          userId,
          jobs: state?.jobs.length ?? 0,
          closedAt: nowIso(),
        },
        error: null,
      },
      event: {
        channel: "ingest",
        event: "ingest.queue_closed",
        payload: {
          userId,
        },
      },
    };
  }

  private getIngestQueueState(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const state = this.getActiveIngestUserState();
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          activeUserId: this.activeIngestUserId,
          opened: Boolean(state),
          totalJobs: state?.jobs.length ?? 0,
          statusCounts: (state?.jobs ?? []).reduce<Record<string, number>>((acc, job) => {
            acc[job.status] = (acc[job.status] ?? 0) + 1;
            return acc;
          }, {}),
          updatedAt: state?.updatedAt ?? null,
        },
        error: null,
      },
      event: {
        channel: "ingest",
        event: "ingest.state_requested",
        payload: {
          activeUserId: this.activeIngestUserId,
          opened: Boolean(state),
        },
      },
    };
  }

  private applyIngestQueueActions(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const state = this.getActiveIngestUserState();
    if (!state) {
      return {
        response: error(request.requestId, "invalid_payload", "ingest queue is not open", false, {
          field: "userId",
        }),
      };
    }
    const parsed = parsePayload(badgerIngestApply, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const actions = parsed.data.actions as LabQueueAction[];
    let changed = false;
    for (const action of actions) {
      changed = this.applyIngestAction(state, action) || changed;
    }
    state.updatedAt = nowIso();
    this.ingestUsers.set(state.userId, state);
    this.ensureIngestProcessing(state);
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          userId: state.userId,
          changed,
          updatedAt: state.updatedAt,
          totalJobs: state.jobs.length,
        },
        error: null,
      },
      event: {
        channel: "ingest",
        event: "ingest.jobs_updated",
        payload: {
          userId: state.userId,
          changed,
          total: state.jobs.length,
          jobs: state.jobs.map((job) => this.toIngestJobView(job)),
        },
      },
    };
  }

  private applyIngestAction(state: IngestUserState, action: LabQueueAction): boolean {
    switch (action.type) {
      case "queue_files": {
        const now = nowIso();
        let changed = false;
        for (const file of action.files ?? []) {
          if (!file?.id || !file.filename) continue;
          if (state.jobs.some((job) => job.id === file.id)) continue;
          const preset = action.preset ?? null;
          const parsed = parseFilename(file.filename);
          const baseSeason = parsed?.season ?? preset?.season;
          const baseEpisode = parsed?.episode ?? preset?.episode;
          const isTv = preset?.media?.type === "tv" || preset?.pendingMedia?.type === "tv";
          const needsEpisode = isTv && (!baseSeason || !baseEpisode);
          const tracks = preset?.media
            ? buildTracks(preset.media.originalLanguage ?? null, state.config.uiLanguage)
            : preset?.pendingMedia
            ? buildTracks(preset.pendingMedia.originalLanguage ?? null, state.config.uiLanguage)
            : buildTracks(null, state.config.uiLanguage);
          const includeSource = file.includeSource ?? true;
          const includeFallback = file.includeFallback ?? false;
          const includeAudio = file.includeAudio ?? true;
          const includeSubtitles = file.includeSubtitles ?? true;
          const includeChapters = file.includeChapters ?? true;
          const selectedFormats =
            file.selectedFormats ??
            resolveTranscodeOutputs(state.config.transcodeOutputs, state.config.enableCodecSelection);
          const shouldProcess =
            includeSource || includeFallback || includeAudio || includeSubtitles || includeChapters || selectedFormats.length > 0;
          const queueSequence = state.nextQueueSequence++;
          state.jobs.push({
            id: file.id,
            filename: file.filename,
            queueSequence,
            status: preset ? "ready" : "identifying",
            progress: 0,
            createdAt: now,
            sizeMb: file.sizeMb ?? undefined,
            sourceQuality: file.sourceQuality,
            videoMeta: file.videoMeta ?? null,
            selectedFormats,
            groupId: file.groupId,
            jobType: file.jobType,
            includeSource,
            includeFallback,
            includeAudio,
            includeSubtitles,
            includeChapters,
            audioTrackIndexes: file.audioTrackIndexes,
            subtitleTrackIndexes: file.subtitleTrackIndexes,
            audioTrackOverrides: file.audioTrackOverrides,
            subtitleTrackOverrides: file.subtitleTrackOverrides,
            logs: [],
            audioLangs: tracks.audioLangs,
            subtitleLangs: tracks.subtitleLangs,
            expanded: preset ? needsEpisode || !shouldProcess : true,
            matchedMediaId: preset?.media?.id,
            pendingKey: preset?.pendingKey,
            pendingDetails: preset?.pendingDetails,
            matchedTo: preset?.media
              ? {
                  title: preset.media.title,
                  year: preset.media.year,
                  posterPath: preset.media.posterPath,
                  type: preset.media.type as "movie" | "tv",
                }
              : preset?.pendingMedia
              ? {
                  title: preset.pendingMedia.title,
                  year: preset.pendingMedia.year,
                  posterPath: preset.pendingMedia.posterPath,
                  type: preset.pendingMedia.type as "movie" | "tv",
                }
              : undefined,
            detectedTitle: parsed?.title ?? undefined,
            detectedYear:
              parsed?.year !== undefined && parsed?.year !== null ? String(parsed.year) : undefined,
            detectedSeason: baseSeason,
            detectedEpisode: baseEpisode,
          });
          changed = true;
        }
        return changed;
      }
      case "queue_format_jobs": {
        const now = nowIso();
        let changed = false;
        for (const item of action.jobs ?? []) {
          if (!item?.id || !item.filename) continue;
          if (state.jobs.some((job) => job.id === item.id)) continue;
          state.jobs.push({
            id: item.id,
            filename: item.filename,
            queueSequence: state.nextQueueSequence++,
            status: "ready",
            progress: 0,
            createdAt: now,
            matchedMediaId: item.mediaId,
            fileId: item.fileId,
            linked: true,
            selectedFormats: item.formats,
            detectedSeason: item.season ?? undefined,
            detectedEpisode: item.episode ?? undefined,
            tracksAdded: true,
            formatsCreated: false,
            logs: [],
          });
          changed = true;
        }
        return changed;
      }
      case "start_job":
        return this.updateIngestJob(state, action.jobId, (job) => ({
          ...job,
          status: "transcoding",
          progress: 0,
          error: undefined,
        }));
      case "cancel_job":
        this.abortIngestJob(state.userId, action.jobId);
        return this.updateIngestJob(state, action.jobId, (job) => ({
          ...job,
          status: "cancelled",
          error: undefined,
          completedAt: nowIso(),
        }));
      case "remove_job": {
        this.abortIngestJob(state.userId, action.jobId);
        const before = state.jobs.length;
        state.jobs = state.jobs.filter((job) => job.id !== action.jobId);
        return state.jobs.length !== before;
      }
      case "remove_media_jobs": {
        const shouldRemove = (job: LabJob) =>
          job.matchedMediaId === action.mediaId ||
          job.manualSelectedId === action.mediaId ||
          job.pendingKey === action.mediaId;
        for (const job of state.jobs) {
          if (!shouldRemove(job)) continue;
          this.abortIngestJob(state.userId, job.id);
        }
        const before = state.jobs.length;
        state.jobs = state.jobs.filter((job) => !shouldRemove(job));
        return state.jobs.length !== before;
      }
      case "clear_completed": {
        const before = state.jobs.length;
        state.jobs = state.jobs.filter(
          (job) => job.status !== "done" && job.status !== "failed" && job.status !== "cancelled"
        );
        return state.jobs.length !== before;
      }
      case "update_job_meta":
        return this.updateIngestJob(state, action.jobId, (job) => ({ ...job, videoMeta: action.videoMeta }));
      case "toggle_expanded":
        return this.updateIngestJob(state, action.jobId, (job) => ({ ...job, expanded: !job.expanded }));
      case "set_manual_query":
        return this.updateIngestJob(state, action.jobId, (job) => ({ ...job, manualQuery: action.value }));
      case "set_manual_selection":
        return this.updateIngestJob(state, action.jobId, (job) => ({ ...job, manualSelectedId: action.mediaId }));
      case "set_manual_season":
        return this.updateIngestJob(state, action.jobId, (job) => ({ ...job, manualSeason: action.season }));
      case "set_manual_episode":
        return this.updateIngestJob(state, action.jobId, (job) => ({ ...job, manualEpisode: action.episode }));
      case "clear_match":
        return this.updateIngestJob(state, action.jobId, (job) => ({
          ...job,
          matchedMediaId: undefined,
          matchedTo: undefined,
          pendingKey: undefined,
          pendingDetails: undefined,
          status: "needs_match",
        }));
      case "attach_pending_media":
        return this.updateIngestJobByPendingKey(state, action.pendingKey, (job) => {
          const isTv = job.matchedTo?.type === "tv" || Boolean(job.pendingDetails?.episodes?.length);
          const hasEpisodeIdentity = typeof job.detectedSeason === "number" && typeof job.detectedEpisode === "number";
          const shouldProcess =
            (job.includeSource ?? true) ||
            (job.includeFallback ?? false) ||
            (job.includeAudio ?? true) ||
            (job.includeSubtitles ?? true) ||
            Boolean(job.includeChapters) ||
            (job.selectedFormats?.length ?? 0) > 0;
          return {
            ...job,
            matchedMediaId: action.mediaId,
            pendingKey: undefined,
            status: !isTv || hasEpisodeIdentity ? (shouldProcess ? "transcoding" : "ready") : "ready",
            error: undefined,
          };
        });
      case "toggle_job_format":
      case "toggle_job_track":
      default:
        return false;
    }
  }

  private updateIngestJob(state: IngestUserState, jobId: string, updater: (job: LabJob) => LabJob) {
    const index = state.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) return false;
    state.jobs[index] = updater(state.jobs[index]);
    return true;
  }

  private updateIngestJobByPendingKey(
    state: IngestUserState,
    pendingKey: string,
    updater: (job: LabJob) => LabJob
  ) {
    const index = state.jobs.findIndex((job) => job.pendingKey === pendingKey);
    if (index === -1) return false;
    state.jobs[index] = updater(state.jobs[index]);
    return true;
  }

  private appendIngestJobLog(state: IngestUserState, jobId: string, line: string) {
    if (!shouldExposeLiveIngestLogs()) return;
    this.updateIngestJob(state, jobId, (job) => ({
      ...job,
      logs: [...(job.logs ?? []), line].slice(-20),
    }));
  }

  private ingestTaskKey(userId: string, jobId: string) {
    return `${userId}:${jobId}`;
  }

  private resolveIngestJobStatePath(userId: string, jobId: string) {
    const baseDir = process.env.SF_TRANSCODE_DIR?.trim() || joinPath(process.cwd(), ".runtime", "transcode");
    return joinPath(baseDir, userId, jobId, "job_state.json");
  }

  private recoverProducedMediaFromState(userId: string, jobId: string): LabJob["produced"] | null {
    const statePath = this.resolveIngestJobStatePath(userId, jobId);
    if (!existsSync(statePath)) return null;
    try {
      const parsed = loadJobStateSync<PersistedJobState>(statePath) as PersistedJobState;
      const outputs = Array.isArray(parsed.outputs) ? parsed.outputs : [];
      const subtitles = Array.isArray(parsed.subtitles) ? parsed.subtitles : [];
      if (!outputs.length) return null;

      const videoFormats: NonNullable<LabJob["produced"]>["videoFormats"] = [];
      const audioTracks: NonNullable<LabJob["produced"]>["audioTracks"] = [];
      const subtitleTracks: NonNullable<LabJob["produced"]>["subtitleTracks"] = [];

      for (const output of outputs) {
        const initKey = output.init?.uploaded && output.init?.key ? output.init.key : null;
        const initSize = typeof output.init?.sizeBytes === "number" ? output.init.sizeBytes : null;
        const segments = Array.isArray(output.segments)
          ? output.segments
              .filter(
                (segment) =>
                  segment.uploaded === true &&
                  typeof segment.key === "string" &&
                  segment.key.trim().length > 0 &&
                  typeof segment.sizeBytes === "number"
              )
              .map((segment) => ({
                key: segment.key as string,
                sizeBytes: segment.sizeBytes as number,
                startSeconds: segment.startSeconds ?? null,
              }))
          : [];
        if (!output.encodingComplete || !initKey || initSize === null || segments.length === 0) {
          return null;
        }
        const totalSize =
          typeof output.totalSize === "number"
            ? output.totalSize
            : initSize + segments.reduce((sum, segment) => sum + segment.sizeBytes, 0);

        if (output.kind === "video") {
          videoFormats.push({
            quality: output.quality ?? "unknown",
            codec: output.codec ?? "h264",
            codecString: output.codecString ?? null,
            initKey,
            initSize,
            durationSeconds: output.durationSeconds ?? null,
            totalSize,
            chunks: segments,
            chapters: output.chapters,
          });
        } else {
          audioTracks.push({
            language: output.language ?? "und",
            label: output.label ?? "Audio",
            codec: output.codec ?? "aac",
            codecString: output.codecString ?? null,
            initKey,
            initSize,
            durationSeconds: output.durationSeconds ?? null,
            totalSize,
            chunks: segments,
            isDefault: audioTracks.length === 0,
          });
        }
      }

      for (const subtitle of subtitles) {
        if (!subtitle.uploaded || !subtitle.key) return null;
        subtitleTracks.push({
          language: subtitle.language,
          label: subtitle.label,
          objectKey: subtitle.key,
          format: subtitle.format,
          isDefault: subtitle.isDefault ?? false,
        });
      }

      return {
        videoFormats,
        audioTracks,
        subtitleTracks,
      };
    } catch {
      return null;
    }
  }

  private reconcileCompletedIngestJobs(state: IngestUserState) {
    for (const job of state.jobs) {
      if ((job.status !== "transcoding" && job.status !== "uploading") || job.produced) continue;
      const produced = this.recoverProducedMediaFromState(state.userId, job.id);
      if (!produced) continue;
      this.updateIngestJob(state, job.id, (current) => ({
        ...current,
        status: "done",
        progress: 100,
        completedAt: current.completedAt ?? nowIso(),
        error: undefined,
        produced,
      }));
      this.abortIngestJob(state.userId, job.id);
    }
  }

  private abortIngestJob(userId: string, jobId: string) {
    const key = this.ingestTaskKey(userId, jobId);
    const controller = this.activeIngestTasks.get(key);
    if (!controller) return;
    controller.abort();
    this.activeIngestTasks.delete(key);
  }

  /**
   * Walk job_state.json for `jobId` and forward every uploaded chunk-and-object
   * key (outputs[].init.key, outputs[].segments[].key, subtitles[].key — only
   * those marked `uploaded: true`) to /storage/delete. Layer 2 of the
   * storage-tracker-refactor (plan even-with-only-a-zesty-nest.md): without
   * this hook a cancelled or failed job leaks every chunk it had time to
   * upload before the abort fired (F2). Fire-and-forget on the caller side —
   * if the API call fails the scheduled GC reclaims the orphans.
   */
  private async releaseUploadedChunksForJob(state: IngestUserState, jobId: string, reason: "cancelled" | "failed"): Promise<void> {
    const token = state.config.token?.trim();
    if (!token) {
      console.warn(`[badger] releaseUploadedChunksForJob: no token for ${state.userId}/${jobId} (${reason})`);
      return;
    }
    const statePath = this.resolveIngestJobStatePath(state.userId, jobId);
    if (!existsSync(statePath)) return;
    let parsed: PersistedJobState;
    try {
      parsed = loadJobStateSync<PersistedJobState>(statePath) as PersistedJobState;
    } catch (err) {
      console.warn(
        `[badger] releaseUploadedChunksForJob: failed to read ${statePath}:`,
        err instanceof Error ? err.message : err
      );
      return;
    }
    const keys = new Set<string>();
    const addIfUploaded = (segment: PersistedSegmentState | null | undefined) => {
      if (!segment || segment.uploaded !== true) return;
      const key = typeof segment.key === "string" ? segment.key.trim() : "";
      if (key.length > 0) keys.add(key);
    };
    for (const output of parsed.outputs ?? []) {
      addIfUploaded(output.init);
      for (const segment of output.segments ?? []) addIfUploaded(segment);
    }
    for (const sub of parsed.subtitles ?? []) {
      if (sub.uploaded !== true) continue;
      const key = typeof sub.key === "string" ? sub.key.trim() : "";
      if (key.length > 0) keys.add(key);
    }
    if (keys.size === 0) return;
    const apiBase = (
      process.env.SPACEFLEET_API_BASE_URL ?? process.env.API_BASE_URL ?? process.env.SF_API_BASE_URL ?? "http://127.0.0.1:3000"
    ).replace(/\/+$/, "");
    const allKeys = [...keys];
    const batchSize = 100;
    let totalDeleted = 0;
    let totalReclaimedBytes = 0;
    let failedBatches = 0;
    for (let i = 0; i < allKeys.length; i += batchSize) {
      const batch = allKeys.slice(i, i + batchSize);
      try {
        const res = await fetch(`${apiBase}/storage/delete`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Space-App": "badger",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ keys: batch }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          const result = (await res.json().catch(() => ({}))) as { deleted?: number; reclaimedBytes?: number };
          totalDeleted += Number(result.deleted ?? 0);
          totalReclaimedBytes += Number(result.reclaimedBytes ?? 0);
        } else {
          failedBatches += 1;
        }
      } catch {
        failedBatches += 1;
      }
    }
    console.log(
      JSON.stringify({
        event: "badger.ingest.cleanup",
        userId: state.userId,
        jobId,
        reason,
        keys: allKeys.length,
        deleted: totalDeleted,
        reclaimedBytes: totalReclaimedBytes,
        failedBatches,
      })
    );
  }

  private ensureIngestProcessing(state: IngestUserState) {
    for (const job of state.jobs) {
      if (job.status !== "transcoding" && job.status !== "uploading") continue;
      if (!job.matchedMediaId) continue;
      const key = this.ingestTaskKey(state.userId, job.id);
      if (this.activeIngestTasks.has(key)) continue;
      if (!state.config.token?.trim()) {
        this.updateIngestJob(state, job.id, (current) => ({
          ...current,
          status: "failed",
          error: "lab.errors.authRequired",
          completedAt: nowIso(),
        }));
        continue;
      }
      const controller = new AbortController();
      this.activeIngestTasks.set(key, controller);
      void this.runIngestJob(state, job.id, controller).finally(() => {
        this.activeIngestTasks.delete(key);
        this.ensureIngestProcessing(state);
      });
    }
  }

  private async preflightQuotaCheck(state: IngestUserState, jobId: string): Promise<void> {
    const apiBase = (
      process.env.SPACEFLEET_API_BASE_URL ?? process.env.API_BASE_URL ?? process.env.SF_API_BASE_URL ?? "http://127.0.0.1:3000"
    ).replace(/\/+$/, "");
    try {
      const quotaRes = await fetch(`${apiBase}/storage/quota/status`, {
        method: "GET",
        headers: { Authorization: `Bearer ${state.config.token!}`, "X-Space-App": "badger" },
        signal: AbortSignal.timeout(5_000),
      });
      if (quotaRes.ok) {
        const quota = (await quotaRes.json()) as { usageRatio: number; limitBytes?: number | null };
        // ACCT-PLAN-14: a `null` limit is an unlimited (admin) account, never blocked.
        if (quota.limitBytes !== null && typeof quota.usageRatio === "number" && quota.usageRatio >= 1) {
          throw new Error("storage_quota_blocked");
        }
      }
    } catch (quotaErr) {
      if (quotaErr instanceof Error && quotaErr.message === "storage_quota_blocked") throw quotaErr;
      this.appendIngestJobLog(state, jobId, `[runtime] quota pre-check skipped: ${quotaErr instanceof Error ? quotaErr.message : "unknown"}`);
    }
  }

  /**
   * Per-media silo placement (#145) for a legacy LabJob. A persisted id wins.
   * A `queue_format_jobs` job adds formats to an existing file (it carries
   * `fileId` + `matchedMediaId`), so it joins the silo that file's objects
   * already live on — parsed from its existing format keys. Otherwise (a new
   * source, or a file whose keys are legacy/absent) the job id when it is a
   * valid placement id, else a fresh UUID.
   */
  private async resolveLegacyIngestPlacementId(job: LabJob): Promise<string> {
    if (job.placementId) return job.placementId;
    if (job.fileId && job.matchedMediaId) {
      const formats = (await this.libraryDbService.call("listMediaFormats", [job.matchedMediaId])) as Array<{
        fileId: string;
        initKey: string | null;
        chunks?: Array<{ key: string | null }> | null;
      }> | null;
      const existing = (formats ?? [])
        .filter((format) => format.fileId === job.fileId)
        .flatMap((format) => [format.initKey, ...(format.chunks ?? []).map((chunk) => chunk.key)])
        .map((key) => (key ? parseMediaPlacementIdFromObjectKey(key) : null))
        .find((id): id is string => id !== null);
      console.info(
        "[badger.ingest] placement from existing file keys",
        JSON.stringify({ jobId: job.id, mediaId: job.matchedMediaId, fileId: job.fileId, placementId: existing ?? null })
      );
      if (existing) return existing;
    }
    return isValidPlacementId(job.id) ? job.id : crypto.randomUUID();
  }

  private async runIngestJob(state: IngestUserState, jobId: string, controller: AbortController) {
    const job = state.jobs.find((entry) => entry.id === jobId);
    if (!job || !state.config.token?.trim()) return;
    // Fault-injection env flags. Upload wrapper is armed via the shared helper
    // so the V2 path (apps/runtime/src/modules/badger/steps/upload.ts) and the
    // legacy `runIngestJob` honor the same flags. Kill-ffmpeg / process-exit
    // are still fired inline in `onProgress` below — the V2 path mirrors this
    // via `checkProgressFault()`.
    armUploadFaultForJob();
    const faultKillFfmpegAtPct = parseFaultPct(process.env.SF_FAULT_KILL_FFMPEG_AT_PCT);
    const faultProcessExitAfterPct = parseFaultPct(process.env.SF_FAULT_PROCESS_EXIT_AFTER_PCT);
    let faultFfmpegAbortFired = false;
    let faultProcessExitFired = false;
    try {
      // Pre-flight quota check: fail fast before transcoding if storage is full
      await this.preflightQuotaCheck(state, jobId);
      const placementId = await this.resolveLegacyIngestPlacementId(job);
      if (job.placementId !== placementId) {
        this.updateIngestJob(state, job.id, (current) => ({ ...current, placementId }));
      }
      const result = await this.processMediaJob({
        token: state.config.token,
        userId: state.userId,
        jobId: job.id,
        inputPath: job.filename,
        placementId,
        libraryKeyBase64: state.config.libraryKeyBase64 ?? null,
        sourceQualityOverride: job.sourceQuality,
        includeSource: job.includeSource,
        includeFallback: job.includeFallback ?? false,
        includeAudio: job.includeAudio,
        includeSubtitles: job.includeSubtitles,
        includeChapters: job.includeChapters,
        audioTrackIndexes: job.audioTrackIndexes,
        subtitleTrackIndexes: job.subtitleTrackIndexes,
        audioTrackOverrides: job.audioTrackOverrides,
        subtitleTrackOverrides: job.subtitleTrackOverrides,
        signal: controller.signal,
        onProgress: (stage, progress) => {
          const prevStatus = state.jobs.find((j) => j.id === jobId)?.status;
          if (stage === "uploading" && prevStatus !== "uploading") {
            this.appendIngestJobLog(state, jobId, `[runtime] upload phase started for job ${jobId}`);
          }
          this.updateIngestJob(state, jobId, (current) => ({
            ...current,
            status: stage === "uploading" ? "uploading" : "transcoding",
            progress,
            error: undefined,
          }));
          this.publishIngestJobsUpdate(state);
          // Fault: abort the SAME controller runIngestJob is using when ffmpeg progress crosses the configured pct.
          if (
            !faultFfmpegAbortFired &&
            faultKillFfmpegAtPct !== null &&
            stage === "transcoding" &&
            progress >= faultKillFfmpegAtPct
          ) {
            faultFfmpegAbortFired = true;
            this.appendIngestJobLog(
              state,
              jobId,
              `sf_fault: ffmpeg aborted at ${faultKillFfmpegAtPct}% via SF_FAULT_KILL_FFMPEG_AT_PCT`
            );
            controller.abort(
              new Error(
                `sf_fault: ffmpeg aborted at ${faultKillFfmpegAtPct}% via SF_FAULT_KILL_FFMPEG_AT_PCT`
              )
            );
          }
          // Fault: hard process exit after job progress crosses the configured pct. Logs a single line first.
          if (
            !faultProcessExitFired &&
            faultProcessExitAfterPct !== null &&
            progress >= faultProcessExitAfterPct
          ) {
            faultProcessExitFired = true;
            // eslint-disable-next-line no-console
            console.log(
              `sf_fault: process.exit(137) at ${faultProcessExitAfterPct}% via SF_FAULT_PROCESS_EXIT_AFTER_PCT`
            );
            process.exit(137);
          }
        },
        onEncoder: (encoder) => {
          this.updateIngestJob(state, jobId, (current) => ({ ...current, encoder }));
        },
        onLog: (line) => {
          this.appendIngestJobLog(state, jobId, line);
        },
      });
      this.updateIngestJob(state, jobId, (current) => ({
        ...current,
        status: "done",
        progress: 100,
        completedAt: nowIso(),
        error: undefined,
        produced: result.produced,
        encoder: result.encoder,
      }));
      this.publishIngestJobsUpdate(state, true);
      // Clean up transcode directory after successful upload to free disk space
      const transcodeBase = process.env.SF_TRANSCODE_DIR?.trim() || joinPath(process.cwd(), ".runtime", "transcode");
      const jobDir = joinPath(transcodeBase, state.userId, job.id);
      // P26: every removal of an encode outputs tree is logged with its reason.
      console.info("[badger.ingest] removing transcode dir", {
        reason: "legacy-ingest-succeeded",
        jobId: job.id,
        dir: jobDir,
      });
      fsPromises.rm(jobDir, { recursive: true, force: true }).catch((rmErr: unknown) => {
        console.warn("[badger.ingest] transcode dir removal failed", {
          reason: "legacy-ingest-succeeded",
          jobId: job.id,
          dir: jobDir,
          error: rmErr instanceof Error ? rmErr.message : String(rmErr),
        });
      });
    } catch (error) {
      if (controller.signal.aborted) {
        this.updateIngestJob(state, jobId, (current) => ({
          ...current,
          status: "cancelled",
          error: undefined,
          completedAt: nowIso(),
        }));
        this.publishIngestJobsUpdate(state, true);
        // Layer 2 of storage-tracker-refactor: forward partial-upload chunks
        // to /storage/delete so a cancelled job doesn't leak. Fire-and-forget;
        // errors are logged but don't change job status.
        void this.releaseUploadedChunksForJob(state, jobId, "cancelled");
        return;
      }
      const message = error instanceof Error ? error.message : "lab.errors.processingFailed";
      this.appendIngestJobLog(state, jobId, `[runtime] ${message}`);
      this.updateIngestJob(state, jobId, (current) => ({
        ...current,
        status: "failed",
        error:
          message === "AUDIO_REQUIRED_MISSING"
            ? "lab.errors.audioRequiredMissing"
            : message === "SUBTITLE_REQUIRED_MISSING"
            ? "lab.errors.subtitleRequiredMissing"
            : message === "storage_quota_blocked"
            ? "lab.errors.storageQuotaBlocked"
            : message.includes("upload_quota_exceeded")
            ? "lab.errors.uploadQuotaExceeded"
            : message.includes("upload_quota_unavailable")
            ? "lab.errors.uploadQuotaUnavailable"
            : message.startsWith("UPLOAD_TIMEOUT")
            ? "lab.errors.uploadTimeout"
            : "lab.errors.processingFailed",
        completedAt: nowIso(),
      }));
      this.publishIngestJobsUpdate(state, true);
      // Layer 2 of storage-tracker-refactor: forward partial-upload chunks
      // for a failed job too — same leak-prevention as the cancel branch.
      void this.releaseUploadedChunksForJob(state, jobId, "failed");
    }
  }

  private listJobs(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const state = this.getActiveIngestUserState();
    if (state) {
      this.reconcileCompletedIngestJobs(state);
    }
    const parsed = parsePayload(badgerIngestListJobs, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const statusFilter = parsed.data.status ?? null;
    const limit = parsed.data.limit ?? null;
    const now = nowIso();
    const jobs = state?.jobs ?? [];
    const filtered = jobs.filter((job) => (statusFilter ? job.status === statusFilter : true));
    const sliced = limit !== null ? filtered.slice(0, limit) : filtered;

    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          userId: state?.userId ?? null,
          opened: Boolean(state),
          jobs: sliced.map((job) => this.toIngestJobView(job)),
          total: filtered.length,
          listedAt: now,
        },
        error: null,
      },
      event: {
        channel: "ingest",
        event: "ingest.jobs_listed",
        payload: {
          userId: state?.userId ?? null,
          opened: Boolean(state),
          total: filtered.length,
          returned: sliced.length,
        },
      },
    };
  }

  private getLibraryState(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const head = this.headSnapshotId ? this.snapshots.get(this.headSnapshotId) ?? null : null;
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          listedAt: nowIso(),
          totalSnapshots: this.snapshots.size,
          headSnapshotId: this.headSnapshotId,
          head:
            head === null
              ? null
              : {
                  snapshotId: head.snapshotId,
                  version: head.version,
                  stateHash: head.stateHash,
                  mediaCount: head.mediaCount,
                  playlistCount: head.playlistCount,
                  updatedAt: head.updatedAt,
                },
        },
        error: null,
      },
      event: {
        channel: "library",
        event: "library.state_requested",
        payload: { totalSnapshots: this.snapshots.size },
      },
    };
  }

  private upsertLibrarySnapshot(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerLibraryUpsertSnapshot, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { snapshotId, version, mediaCount, playlistCount } = parsed.data;
    const stateHash = parsed.data.stateHash ?? null;
    const updatedAt = parsed.data.updatedAt ?? nowIso();

    const next: LibrarySnapshot = {
      snapshotId,
      version,
      stateHash,
      mediaCount,
      playlistCount,
      updatedAt,
    };
    this.snapshots.set(snapshotId, next);

    const currentHead = this.headSnapshotId ? this.snapshots.get(this.headSnapshotId) ?? null : null;
    const shouldPromote =
      currentHead === null ||
      next.version > currentHead.version ||
      (next.version === currentHead.version && next.updatedAt >= currentHead.updatedAt);
    if (shouldPromote) this.headSnapshotId = snapshotId;

    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          snapshotId,
          version,
          isHead: this.headSnapshotId === snapshotId,
          totalSnapshots: this.snapshots.size,
          updatedAt,
        },
        error: null,
      },
      event: {
        channel: "library",
        event: "library.snapshot_upserted",
        payload: {
          snapshotId,
          version,
          isHead: this.headSnapshotId === snapshotId,
          totalSnapshots: this.snapshots.size,
        },
      },
    };
  }

  private listLibrarySnapshots(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerLibraryListSnapshots, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const limit = parsed.data.limit ?? null;
    const snapshots = [...this.snapshots.values()].sort((left, right) => {
      if (right.version !== left.version) return right.version - left.version;
      if (right.updatedAt === left.updatedAt) return right.snapshotId.localeCompare(left.snapshotId);
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    const sliced = limit === null ? snapshots : snapshots.slice(0, limit);
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          listedAt: nowIso(),
          totalSnapshots: snapshots.length,
          snapshots: sliced.map((entry) => ({
            snapshotId: entry.snapshotId,
            version: entry.version,
            stateHash: entry.stateHash,
            mediaCount: entry.mediaCount,
            playlistCount: entry.playlistCount,
            updatedAt: entry.updatedAt,
            isHead: this.headSnapshotId === entry.snapshotId,
          })),
        },
        error: null,
      },
      event: {
        channel: "library",
        event: "library.snapshots_listed",
        payload: {
          totalSnapshots: snapshots.length,
          returned: sliced.length,
        },
      },
    };
  }

  private getLibrarySnapshot(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerLibraryGetSnapshot, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const snapshotId = parsed.data.snapshotId ?? this.headSnapshotId;
    if (!snapshotId) {
      return {
        response: error(request.requestId, "invalid_payload", "snapshotId is required when no head exists", false, {
          field: "snapshotId",
        }),
      };
    }
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      return {
        response: error(request.requestId, "invalid_payload", "snapshot not found", false, {
          field: "snapshotId",
          snapshotId,
        }),
      };
    }
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          snapshotId: snapshot.snapshotId,
          version: snapshot.version,
          stateHash: snapshot.stateHash,
          mediaCount: snapshot.mediaCount,
          playlistCount: snapshot.playlistCount,
          updatedAt: snapshot.updatedAt,
          isHead: this.headSnapshotId === snapshot.snapshotId,
        },
        error: null,
      },
      event: {
        channel: "library",
        event: "library.snapshot_read",
        payload: {
          snapshotId: snapshot.snapshotId,
          isHead: this.headSnapshotId === snapshot.snapshotId,
        },
      },
    };
  }

  private clearLibrarySnapshots(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const cleared = this.snapshots.size;
    this.snapshots.clear();
    this.headSnapshotId = null;
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          cleared,
          clearedAt: nowIso(),
        },
        error: null,
      },
      event: {
        channel: "library",
        event: "library.cleared",
        payload: {
          cleared,
        },
      },
    };
  }

  private getFfmpegCapabilities(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const capabilities = getRuntimeFfmpegCapabilities();
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: capabilities as unknown as Record<string, unknown>,
        error: null,
      },
      event: {
        channel: "capabilities",
        event: "capabilities.ffmpeg_reported",
        payload: {
          preferredEncoder: capabilities.preferredEncoder,
          encoders: capabilities.encoders.length,
        },
      },
    };
  }

  private testFfmpegCapabilities(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerCapabilitiesTestFfmpeg, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const encoder = parsed.data.encoder;
    const result = runRuntimeFfmpegCapabilityTest(encoder as RuntimeFfmpegCapability["preferredEncoder"] | undefined);
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: result as unknown as Record<string, unknown>,
        error: null,
      },
      event: {
        channel: "capabilities",
        event: "capabilities.ffmpeg_tested",
        payload: {
          encoder: result?.encoder ?? encoder ?? null,
          ok: result?.ok ?? false,
        },
      },
    };
  }

  // --- Library DB commands (runtime-owned SQLite) ---

  /**
   * Stamp the desktop's session credentials (backend bearer + library key)
   * carried by a `badger.db.open*` command onto the module.
   *
   * After a runtime respawn the desktop re-fires `badger.db.open`
   * (libraryDbRuntimeProxy.reopenAfterRuntimeReady). That is the one command
   * that reliably follows every respawn, and it carries the real token + key.
   * Without this the token only reached the module via `/runtime/keys/set`
   * (renderer-driven), so persisted jobs resumed after a runtime kill found no
   * backend token (`STEP_RETRANSCODE_AUTH_NOT_READY` / `AUTH_REQUIRED`).
   * Stamped BEFORE the open so a failing/slow library open (format-too-new,
   * offline) still leaves resumed jobs with working credentials. The account
   * is stamped with them (RT-JOBS-07): the token is that account's, so its
   * jobs are the ones that may run now.
   */
  private attachSessionCredentials(token: string, keyBase64: string, account: { userId: string }, source: string) {
    const trimmedToken = token?.trim();
    const trimmedKey = keyBase64?.trim();
    console.info(
      JSON.stringify({
        event: "badger.auth.attached_from_db_open",
        source,
        hadToken: this.backendToken !== null,
        tokenChanged: Boolean(trimmedToken) && trimmedToken !== this.backendToken,
        hasToken: Boolean(trimmedToken),
        hasKey: Boolean(trimmedKey),
        userChanged: account.userId !== this.backendUserId,
      })
    );
    if (trimmedToken) this.setBackendToken(trimmedToken);
    if (trimmedKey) this.setLibraryKey(trimmedKey);
    // Last: a changed user wakes that account's parked jobs, which must find its token and key already in place.
    this.setBackendUserId(account.userId);
  }

  /**
   * The account a library open is for (LIB-STORE-06): the one the caller names, else the user of the last
   * `/runtime/keys/set`. Null when neither is known: the open is refused rather than reading a shared dir.
   */
  private libraryAccountFor(requestedUserId: string | undefined, command: string) {
    const userId = requestedUserId?.trim() || this.backendUserId;
    console.info(
      JSON.stringify({
        event: "badger.library.account_resolved",
        command,
        source: requestedUserId?.trim() ? "payload" : userId ? "keys_set" : "none",
        requestedMatchesKeysSet: requestedUserId && this.backendUserId ? requestedUserId.trim() === this.backendUserId : null,
      })
    );
    return userId ? { userId } : null;
  }

  private async openLibraryDb(request: RuntimeCommandRequest): Promise<{ response: RuntimeCommandResponse; event?: BadgerModuleEvent }> {
    const parsed = parsePayload(badgerDbOpen, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { token, keyBase64, userId } = parsed.data;
    const account = this.libraryAccountFor(userId, "badger.db.open");
    if (!account) {
      return { response: error(request.requestId, "invalid_payload", "LIBRARY_USER_ID_MISSING") };
    }
    this.attachSessionCredentials(token, keyBase64, account, "badger.db.open");
    try {
      const result = await this.libraryDbService.open(token, keyBase64, account);
      this.onLibraryOpened("online");
      return {
        response: { requestId: request.requestId, ok: true, result, error: null },
        event: { channel: "library", event: "library.db_opened", payload: result },
      };
    } catch (e) {
      // A LibraryFormatTooNewError thrown by the versioned manifest reader or
      // the op-stream gate propagates here cleanly; libraryDbCommandError
      // lifts its surface/observed/supported into `details` for the renderer.
      return { response: libraryDbCommandError(request.requestId, e) };
    }
  }

  private async openLibraryDbLocal(request: RuntimeCommandRequest): Promise<{ response: RuntimeCommandResponse; event?: BadgerModuleEvent }> {
    const parsed = parsePayload(badgerDbOpenLocal, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { token, keyBase64, userId } = parsed.data;
    const account = this.libraryAccountFor(userId, "badger.db.open_local");
    if (!account) {
      return { response: error(request.requestId, "invalid_payload", "LIBRARY_USER_ID_MISSING") };
    }
    this.attachSessionCredentials(token, keyBase64, account, "badger.db.open_local");
    try {
      // Offline open: on-disk only, no remote pull. Never reaches the backend,
      // so it succeeds even when the API/storage is unreachable.
      const result = await this.libraryDbService.openLocal(token, keyBase64, account);
      this.onLibraryOpened("local");
      return {
        response: { requestId: request.requestId, ok: true, result, error: null },
        event: { channel: "library", event: "library.db_opened", payload: result },
      };
    } catch (e) {
      return { response: libraryDbCommandError(request.requestId, e) };
    }
  }

  private closeLibraryDb(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    this.libraryDbService.close();
    return {
      response: { requestId: request.requestId, ok: true, result: { closed: true }, error: null },
      event: { channel: "library", event: "library.db_closed", payload: {} },
    };
  }

  private async clearLibraryDbLocalCache(request: RuntimeCommandRequest): Promise<{ response: RuntimeCommandResponse; event?: BadgerModuleEvent }> {
    const parsed = parsePayload(badgerDbClearLocalCache, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    await this.libraryDbService.clearLocalCache(parsed.data.userId ? { userId: parsed.data.userId } : undefined);
    this.snapshots.clear();
    this.headSnapshotId = null;
    return {
      response: { requestId: request.requestId, ok: true, result: { cleared: true }, error: null },
      event: { channel: "library", event: "library.db_cache_cleared", payload: {} },
    };
  }

  private getLibraryDbSnapshot(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    const parsed = parsePayload(badgerDbSnapshot, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { mediaIds } = parsed.data;
    const snapshot = mediaIds
      ? this.libraryDbService.getSnapshotDelta(mediaIds)
      : this.libraryDbService.getSnapshot();
    if (!snapshot) {
      return { response: error(request.requestId, "internal_error", "Library DB is not open") };
    }
    // Stamp the version this content is at (read in the same synchronous
    // tick, so no write can land in between) so the desktop proxy can order
    // a fetched snapshot against `library.updated` frames (#25).
    // `partial` tells the caller `mediaDetails` covers only the requested media.
    const result: Record<string, unknown> = {
      ...snapshot,
      version: this.libraryDbService.getVersion(),
      ...(mediaIds ? { partial: true } : {}),
    };
    return {
      response: { requestId: request.requestId, ok: true, result, error: null },
    };
  }

  private async callLibraryDb(request: RuntimeCommandRequest): Promise<{ response: RuntimeCommandResponse; event?: BadgerModuleEvent }> {
    const parsed = parsePayload(badgerDbCall, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const { method, args, deferPublish } = parsed.data;
    try {
      const result = await (deferPublish
        ? this.libraryDbService.call(method, args, { deferPublish })
        : this.libraryDbService.call(method, args));
      // Normalize void/undefined returns (e.g. `setSyncEnabled`) to `null` so
      // the wire envelope keeps the `result` key — JSON.stringify strips
      // `undefined` fields, which would make the client-side Zod parse fail
      // with `Invalid response envelope` (result: nonoptional).
      const wireResult = result === undefined ? null : (result as Record<string, unknown> | null);
      return {
        response: { requestId: request.requestId, ok: true, result: wireResult, error: null },
      };
    } catch (e) {
      // syncFromRemoteIfNewer (a WRITE_METHOD) routes through here; a too-new
      // op stream surfaces as LibraryFormatTooNewError — enrich it like the
      // open path so the renderer can react to a sync-time format skew too.
      return { response: libraryDbCommandError(request.requestId, e) };
    }
  }

  private getLibraryDbStatus(request: RuntimeCommandRequest): { response: RuntimeCommandResponse; event?: BadgerModuleEvent } {
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          open: this.libraryDbService.isOpen(),
          version: this.libraryDbService.getVersion(),
          datasetStatus: this.libraryDbService.getDatasetStatus(),
        },
        error: null,
      },
    };
  }

  private async runStorageGc(request: RuntimeCommandRequest): Promise<{ response: RuntimeCommandResponse; event?: BadgerModuleEvent }> {
    const parsed = parsePayload(badgerStorageGc, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    const token = this.resolveGcToken();
    if (!token) {
      return { response: error(request.requestId, "not_authenticated" as RuntimeErrorCode, "No active session with token") };
    }
    try {
      const result = await this.executeStorageGc(token, parsed.data.dryRun ?? false);
      if (!parsed.data.dryRun) {
        await this.reconcileStorageQuota(token);
      }
      return {
        response: { requestId: request.requestId, ok: true, result, error: null },
      };
    } catch (gcError) {
      return {
        response: error(request.requestId, "gc_failed" as RuntimeErrorCode, gcError instanceof Error ? gcError.message : "GC failed"),
      };
    }
  }

  /**
   * Delete a media item end-to-end: forward the chunk-and-object keys it owned
   * to /storage/delete (the API soft-deletes storageObjects rows and reclaims
   * quota), then drop the local SQLite rows. Layer 1 of the
   * storage-tracker-refactor (plan even-with-only-a-zesty-nest.md): the
   * library-side cleanup is wired in LibraryDb.deleteMedia, so this handler is
   * a thin pass-through that surfaces the delete count + bytes for the caller.
   */
  private async runMediaDelete(request: RuntimeCommandRequest): Promise<{ response: RuntimeCommandResponse; event?: BadgerModuleEvent }> {
    const parsed = parsePayload(badgerMediaDelete, request);
    if (!parsed.ok) {
      return { response: error(request.requestId, "invalid_payload", parsed.error) };
    }
    if (!this.libraryDbService.isOpen()) {
      return { response: error(request.requestId, "internal_error", "Library DB is not open") };
    }
    try {
      // Phase 2 offline cleanup: before the library row is deleted (which
      // would FK-cascade `media_local_downloads` out of existence), unlink
      // any locally-saved files for this media. The on-disk file is owned
      // by the runtime, not the library DB — losing the row without
      // unlinking leaves an orphan in `<userData>/offline/<libraryId>/`.
      //
      // Best-effort: failures are logged but do NOT block library deletion.
      // A subsequent reconcile would catch and drop the orphan row anyway.
      try {
        const localRows = await this.libraryDbService.listLocalDownloads([
          parsed.data.mediaId,
        ]);
        if (localRows.length > 0) {
          console.info(
            `[badger.media.delete] cleaning ${localRows.length} offline file(s) before library delete for media=${parsed.data.mediaId}`
          );
          for (const row of localRows) {
            try {
              // A pieces item (OFFL-FILE-03) sits at `<root>/items/<hash>.json`: drop it and the pieces no other
              // item lists. An old plain file (schema 1) is the file itself.
              const pieceRoot = pathDirname(pathDirname(row.localPath));
              if (row.schemaVersion >= 2 && offlinePieceItemPath(pieceRoot, row.fileId) === row.localPath) {
                await deleteOfflinePieceItem(pieceRoot, row.fileId);
              } else {
                await fsPromises.rm(row.localPath, { force: true });
              }
            } catch (rmErr) {
              console.warn(
                `[badger.media.delete] failed to remove offline copy ${row.localPath}:`,
                rmErr instanceof Error ? rmErr.message : rmErr
              );
            }
          }
          // DB row removal piggy-backs on the FK cascade from deleteMedia →
          // media_files DELETE → media_local_downloads CASCADE. No
          // explicit `dropLocalDownloads` here.
        }
      } catch (offlineErr) {
        console.warn(
          `[badger.media.delete] offline cleanup failed (non-fatal):`,
          offlineErr instanceof Error ? offlineErr.message : offlineErr
        );
      }
      const result = (await this.libraryDbService.call("deleteMedia", [parsed.data.mediaId])) as {
        deletedKeys?: number;
        reclaimedBytes?: number;
      } | null;
      const deletedKeys = Number(result?.deletedKeys ?? 0);
      const reclaimedBytes = Number(result?.reclaimedBytes ?? 0);
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result: { deletedKeys, reclaimedBytes },
          error: null,
        },
      };
    } catch (e) {
      return { response: error(request.requestId, "internal_error", e instanceof Error ? e.message : String(e)) };
    }
  }

  /**
   * Asks the API to recount the user's used bytes from its own records (STOR-QUOTA-06). It never sends the listed keys:
   * a listing can miss a gateway, and the API once soft-deleted every record missing from such a list (STOR-QUOTA-08).
   * A failure is logged, never swallowed.
   */
  private async reconcileStorageQuota(token: string) {
    const apiBase = (
      process.env.SPACEFLEET_API_BASE_URL ?? process.env.API_BASE_URL ?? process.env.SF_API_BASE_URL ?? "http://127.0.0.1:3000"
    ).replace(/\/+$/, "");
    const headers = { Authorization: `Bearer ${token}`, "X-Space-App": "badger" };
    try {
      const res = await fetch(`${apiBase}/storage/quota/reconcile`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.warn(JSON.stringify({ event: "badger.storage.reconcile.failed", status: res.status }));
      }
    } catch (err) {
      console.warn(
        JSON.stringify({ event: "badger.storage.reconcile.failed", message: err instanceof Error ? err.message : String(err) })
      );
    }
  }

  /** Max fraction of total stored keys that GC may delete in a single run (safety cap). */
  private static readonly DEFAULT_GC_MAX_DELETE_RATIO = 0.5;

  private resolveGcMaxDeleteRatio(): number {
    const raw = process.env.BADGER_GC_MAX_DELETE_RATIO;
    if (!raw) return BadgerModule.DEFAULT_GC_MAX_DELETE_RATIO;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      return BadgerModule.DEFAULT_GC_MAX_DELETE_RATIO;
    }
    return parsed;
  }

  /**
   * Grace age for deleting an unreferenced object, measured from its last
   * (re)upload (`storage_objects.updated_at`, via /storage/objects/by-app).
   * An engineV2 format job uploads its objects long before its commit step
   * adds them to the library, and the unfinished-engine-job guard only sees
   * THIS runtime's jobs: a job on another device of the same account, or one
   * whose local job DB failed to load, is invisible to it. 7 days covers a
   * paused/requeued upload on a machine that stays off over a week-end plus
   * margin; real orphans (cancelled jobs, replaced formats) just wait one
   * more week to be reclaimed. Objects with no known upload time are never
   * deleted. Issue #25 P16.
   */
  static readonly GC_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * Why a deleting GC must not run right now because of engineV2 ingest, or
   * null. Unfinished source/format jobs have uploaded objects the library
   * does not reference until their commit step; a count that cannot be read
   * blocks too (fail closed).
   */
  private async engineJobsGcBlocker(): Promise<
    | { reason: "active_engine_jobs"; unfinishedEngineJobs: number }
    | { reason: "engine_jobs_unknown"; message: string }
    | null
  > {
    try {
      const unfinishedEngineJobs = await this.countUnfinishedEngineJobs();
      return unfinishedEngineJobs > 0 ? { reason: "active_engine_jobs", unfinishedEngineJobs } : null;
    } catch (err) {
      return { reason: "engine_jobs_unknown", message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeStorageGc(token: string, dryRun: boolean): Promise<{
    orphanedKeys: number;
    deletedKeys: number;
    reclaimedBytes: number;
    failedKeys: number;
    missingKeys: number;
    graceProtectedKeys?: number;
    abortReason?: string;
  }> {
    if (this.gcRunning) return { orphanedKeys: 0, deletedKeys: 0, reclaimedBytes: 0, failedKeys: 0, missingKeys: 0 };
    this.gcRunning = true;
    try {
      const apiBase = (
        process.env.SPACEFLEET_API_BASE_URL ?? process.env.API_BASE_URL ?? process.env.SF_API_BASE_URL ?? "http://127.0.0.1:3000"
      ).replace(/\/+$/, "");
      const headers = { Authorization: `Bearer ${token}`, "X-Space-App": "badger" };

      // 1. List all objects in the user's vault AND badger-owned keys from DB
      //    (with each one's last upload time, for the grace age).
      const [listRes, ownedRes] = await Promise.all([
        fetch(`${apiBase}/storage/objects`, { method: "GET", headers, signal: AbortSignal.timeout(30_000) }),
        fetch(`${apiBase}/storage/objects/by-app`, { method: "GET", headers, signal: AbortSignal.timeout(30_000) }),
      ]);
      if (!listRes.ok) throw new Error(`listStorageObjects failed: ${listRes.status}`);
      const { keys: storedKeys } = (await listRes.json()) as { keys: string[] };
      // STOR-QUOTA-08: without the by-app listing the GC cannot tell Badger's keys from another app's, so the run
      // fails closed (nothing deleted, warned by the caller) and the next run tries again.
      if (!ownedRes.ok) throw new Error(`listStorageObjects by-app failed: ${ownedRes.status}`);
      const owned = (await ownedRes.json()) as { keys?: unknown; objects?: Array<{ key: string; updatedAt: string }> };
      if (!Array.isArray(owned.keys)) throw new Error("listStorageObjects by-app failed: no key list");
      const badgerOwnedKeys = new Set(owned.keys.filter((key): key is string => typeof key === "string"));
      const lastUploadedAtByKey = new Map<string, number>();
      for (const object of owned.objects ?? []) {
        const at = Date.parse(object.updatedAt);
        if (Number.isFinite(at)) lastUploadedAtByKey.set(object.key, at);
      }

      // 2. Build referenced set from library snapshot
      const snapshot = this.libraryDbService.getSnapshot();
      if (!snapshot) {
        // Library DB not open — cannot determine what's referenced. Abort GC to prevent data loss.
        return { orphanedKeys: 0, deletedKeys: 0, reclaimedBytes: 0, failedKeys: 0, missingKeys: 0, abortReason: "snapshot_unavailable" };
      }
      // STOR-PLACE-08: every piece a media in the library uses, artwork included.
      const referenced = new Set<string>();
      for (const item of snapshot.mediaDetails ?? []) {
        for (const key of collectMediaKeysInUse(item)) referenced.add(key);
      }

      // Safety net: if nothing is referenced but storage has objects, refuse to GC.
      // This prevents mass deletion if the snapshot is unexpectedly empty.
      if (referenced.size === 0 && storedKeys.length > 0) {
        return { orphanedKeys: 0, deletedKeys: 0, reclaimedBytes: 0, failedKeys: 0, missingKeys: 0, abortReason: "empty_reference_set" };
      }

      // 3. Find orphaned keys: must be in storage, owned by badger (or protected-prefix safe),
      //    not referenced by library, and not exhausted retries.
      //    Keys not tracked in storageObjects are left untouched (could belong to another app).
      const unreferencedKeys = storedKeys.filter(
        (key) =>
          !referenced.has(key) &&
          !GC_LIBRARY_KEY.test(key) &&
          !key.startsWith("dummy_") &&
          badgerOwnedKeys.has(key) &&
          (this.gcFailedKeys.get(key) ?? 0) < 3
      );
      // 3b. Grace age: an unreferenced key is only an orphan once its last
      //     upload is older than GC_ORPHAN_GRACE_MS. Unknown age = protected.
      const graceCutoff = Date.now() - BadgerModule.GC_ORPHAN_GRACE_MS;
      const orphanedKeys = unreferencedKeys.filter((key) => {
        const uploadedAt = lastUploadedAtByKey.get(key);
        return uploadedAt !== undefined && uploadedAt <= graceCutoff;
      });
      const graceProtectedKeys = unreferencedKeys.length - orphanedKeys.length;

      const storedKeySet = new Set(storedKeys);
      const missingKeys = Array.from(referenced).filter((key) => !storedKeySet.has(key));

      if (dryRun || orphanedKeys.length === 0) {
        return { orphanedKeys: orphanedKeys.length, deletedKeys: 0, reclaimedBytes: 0, failedKeys: 0, missingKeys: missingKeys.length, graceProtectedKeys };
      }

      // Every deleting path (startup/interval sweep AND the user-triggered
      // badger.storage.gc command) stands down while engineV2 ingest is
      // unfinished. Re-read here, right before deleting, to keep the window
      // after the background pre-check as small as possible.
      const engineBlocker = await this.engineJobsGcBlocker();
      if (engineBlocker) {
        console.log(JSON.stringify({ event: "badger.storage.gc.engine_blocked", dryRun, ...engineBlocker }));
        return {
          orphanedKeys: orphanedKeys.length,
          deletedKeys: 0,
          reclaimedBytes: 0,
          failedKeys: 0,
          missingKeys: missingKeys.length,
          graceProtectedKeys,
          abortReason: engineBlocker.reason,
        };
      }

      // Failsafe: refuse to delete if orphans exceed the safety cap.
      // In normal operation orphans are a small fraction of total storage;
      // a high ratio almost certainly indicates a bug (e.g. stale snapshot).
      const deleteRatio = storedKeys.length > 0 ? orphanedKeys.length / storedKeys.length : 0;
      const maxDeleteRatio = this.resolveGcMaxDeleteRatio();
      if (deleteRatio > maxDeleteRatio) {
        return {
          orphanedKeys: orphanedKeys.length,
          deletedKeys: 0,
          reclaimedBytes: 0,
          failedKeys: 0,
          missingKeys: missingKeys.length,
          graceProtectedKeys,
          abortReason: `delete_ratio_exceeded:${Math.round(deleteRatio * 100)}%`,
        };
      }

      // 4. Delete orphaned keys in batches
      let deletedKeys = 0;
      let reclaimedBytes = 0;
      let failedCount = 0;
      const batchSize = 100;
      for (let i = 0; i < orphanedKeys.length; i += batchSize) {
        const batch = orphanedKeys.slice(i, i + batchSize);
        try {
          const delRes = await fetch(`${apiBase}/storage/delete`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ keys: batch }),
            signal: AbortSignal.timeout(30_000),
          });
          if (delRes.ok) {
            const result = (await delRes.json()) as { deleted: number; reclaimedBytes?: number };
            deletedKeys += result.deleted;
            reclaimedBytes += result.reclaimedBytes ?? 0;
            for (const key of batch) this.gcFailedKeys.delete(key);
          } else {
            failedCount += batch.length;
            for (const key of batch) {
              this.gcFailedKeys.set(key, (this.gcFailedKeys.get(key) ?? 0) + 1);
            }
          }
        } catch {
          failedCount += batch.length;
          for (const key of batch) {
            this.gcFailedKeys.set(key, (this.gcFailedKeys.get(key) ?? 0) + 1);
          }
        }
      }

      return { orphanedKeys: orphanedKeys.length, deletedKeys, reclaimedBytes, failedKeys: failedCount, missingKeys: missingKeys.length, graceProtectedKeys };
    } finally {
      this.gcRunning = false;
    }
  }
}
