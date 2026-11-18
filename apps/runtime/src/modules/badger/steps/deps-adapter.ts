/**
 * Phase F adapter: wires the `BadgerStepDeps` registry to the split ingest
 * primitives (`probeMediaFile`, `parseFilename`, `produceMediaOutputs`,
 * `uploadProducedMedia`) and to `BadgerLibraryDbService`.
 *
 * Step ownership (post-split):
 *
 *   - `probe`           → `probeMediaFile` (unchanged)
 *   - `identify`        → `parseFilename`  (unchanged)
 *   - `extractSource`   → `produceMediaOutputs(includeSource=true,
 *                          includeFallback=false)`. Encodes only — segments
 *                          land on disk with `uploaded:false`. The returned
 *                          `produced` (chunks-empty metadata view) is cached
 *                          in the per-job slot keyed by `(userId,jobId,scope)`.
 *   - `transcodeFormat` → `produceMediaOutputs(includeSource=false,
 *                          includeFallback=true)`. Same as extract but the
 *                          variant scope. Caches the encode-side `produced`.
 *   - `uploadOutputs`   → `uploadProducedMedia(scope, variant?)`. Encrypts +
 *                          uploads each pending chunk via the runtime gateway,
 *                          flips `uploaded:true` per chunk, and persists.
 *                          Returns the fully-populated `ProducedMedia` for
 *                          the commit step. The cache + disk-recovery chain
 *                          on the extract side stays for restart-after-crash.
 *   - `commit`          → writes library rows via BadgerLibraryDbService
 *                          (linkFileToMedia / addMediaFormat /
 *                           setMediaFormatChunks / addAudioTracksForFile /
 *                           addSubtitleTracksForFile). For source jobs, also
 *                          flips playability via markMediaPlayable.
 *
 * Backward compatibility: tests can still inject `processMediaJob` (the
 * legacy single-call entrypoint) instead of the split pair. When only the
 * legacy hook is provided, the adapter falls back to the pre-split behavior
 * — extract/transcode call `processMediaJob` (which does encode + upload in
 * one call) and the upload step becomes a no-op pass-through that exposes
 * the cached `ProducedMedia` to commit. This keeps tens of pre-existing tests
 * green while production wires up the real split.
 *
 * All deps are constructed via {@link buildBadgerStepDeps}. Tests can either
 * call this with a stub libraryDb, or skip it entirely and inject a
 * hand-rolled `BadgerStepDeps` object via `configureBadgerStepDeps()`.
 */

import { existsSync, promises as fs } from "node:fs";
import { join as joinPath } from "node:path";
import {
  probeMediaFile,
  type ProducedMedia,
  type ProducedMediaOutputs,
  type UploadProducedMediaArgs,
  type UploadProducedMediaResult,
} from "@space/ingest-core/mediaProcessor";
import { QUALITY_ORDER, type QualityPreset } from "@space/ingest-core/quality";
import { parseFilename } from "@space/ingest-core/parseMediaFilename";
import { isValidPlacementId } from "@space/shared/storagePlacement";
import { PICTURE_SUBTITLE_FORMATS } from "@space/shared/libraryTypes";
import { isTransientStorageTransportError } from "@space/shared/storageTunnel";
import { loadJobStateSync, type JobState } from "@space/content-core";
import type {
  BadgerStepDeps,
  ExtractInput,
  ExtractResult,
  TranscodeInput,
  TranscodeResult,
  RetranscodeInput,
  RetranscodeResult,
  UploadInput,
  UploadResult,
  CommitInput,
  CommitResult,
  ProbeResult,
  IdentifyResult,
  LibraryReadyWait,
  DiscardJobOutputsInput,
} from "./deps";
import {
  createAuthWaiter,
  sleepOrAbort,
  type AuthWaitContext,
} from "./authWait";
import type {
  BadgerIngestSkipMarker,
  BadgerIngestShowSkipCache,
} from "@space/runtime-contracts/badger/ingest";
import type { BadgerLibraryDbService } from "../../badgerLibraryDb";
import type { EngineV2 } from "../../../core/jobs/engineV2";
import {
  warmStorageCache,
  type WarmStorageCacheArgs,
  type WarmStorageCacheResult,
} from "./cacheWarmup";
import { createPreviewSheetsRunner, type ProducePreviewSheetsFn } from "./previewSheetsAfterCommit";

/**
 * Cache of `ProducedMedia` per `(userId, jobId, scope, variant)`. The legacy
 * `processMediaJob` returns produced after upload completes; the engine's
 * `upload` step needs that object to forward to `commit`. We stash it here
 * between steps.
 *
 * Round-11 K1: the cache lives on a `globalThis`-keyed slot so a `bun --hot`
 * re-evaluation of THIS file does not wipe its contents. Same anti-pattern as
 * round-8 deps registry and round-9 badgerModule slot — module-scoped state
 * that HMR re-eval would reset to an empty Map, which surfaces at commit time
 * as the loud `STEP_COMMIT_PRODUCED_MISSING` error and overwrites
 * runtime_jobs.db with status=failed even though the actual library write
 * already succeeded in the prior pass.
 *
 * The slot identity from `Symbol.for(...)` is stable across re-evals; tests
 * clear it via `__resetBadgerStepDepsAdapter()`. The cache is still
 * process-local — round-11 K2 layers a disk-fallback on top of it for
 * cross-process / restart durability.
 */
type ProducedKey = string;
const cacheKey = (userId: string, jobId: string, scope: "source" | "format", variant?: string) =>
  `${userId}::${jobId}::${scope}::${variant ?? "_"}`;

const PRODUCED_CACHE_SLOT = Symbol.for(
  "@space/runtime/badger-step-deps/produced-cache/v1"
);
type ProducedCacheState = { current: Map<ProducedKey, ProducedMedia> };
const producedCacheState: ProducedCacheState = (() => {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[PRODUCED_CACHE_SLOT] as ProducedCacheState | undefined;
  if (existing) return existing;
  const fresh: ProducedCacheState = { current: new Map<ProducedKey, ProducedMedia>() };
  g[PRODUCED_CACHE_SLOT] = fresh;
  return fresh;
})();
const producedCache: Map<ProducedKey, ProducedMedia> = producedCacheState.current;

/**
 * Test-only helper: clear the produced cache between runs. Clears the slot's
 * Map in place so the same Map reference (and any module-local `producedCache`
 * binding from a prior re-eval) sees the reset.
 */
export const __resetBadgerStepDepsAdapter = (): void => {
  producedCacheState.current.clear();
};

export type ProcessMediaJobFn = (input: {
  token: string;
  userId: string;
  jobId: string;
  inputPath: string;
  /** Per-media silo placement (#145) for the objects this call uploads. */
  placementId: string;
  libraryKeyBase64?: string | null;
  sourceQualityOverride?: string;
  includeSource?: boolean;
  includeFallback: boolean;
  /** Phase 3 — explicit transcode variants (replaces `includeFallback` when set). */
  targetVariants?: QualityPreset[];
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
  audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  signal?: AbortSignal;
  onProgress?: (stage: "transcoding" | "uploading", progress: number) => void;
  onLog?: (line: string) => void;
}) => Promise<{ produced: ProducedMedia; encoder: string }>;

/**
 * Phase F split — encode-only delegate. Production wires
 * `produceBadgerMediaOutputs` (a thin wrapper around `produceMediaOutputs`
 * with library-key plumbing). Tests can pass a mock that returns whatever
 * `ProducedMediaOutputs` shape the test needs.
 */
export type ProduceMediaOutputsFn = (input: {
  userId: string;
  jobId: string;
  inputPath: string;
  /**
   * Optional source-bytes stream for the post-ingest retranscode pipeline.
   * When set, probe is skipped (caller MUST set `sourceQualityOverride`),
   * the encode loop pipes the iterable to ffmpeg via stdin instead of
   * reading `inputPath` from disk. The CPU-retry fallback needs
   * `reopenInputStream` (a stream is consumable once). Mirrors the corresponding field on
   * `produceMediaOutputs` in `@space/ingest-core/mediaProcessor`.
   */
  inputStream?: AsyncIterable<Uint8Array> | null;
  /**
   * Factory returning a fresh iterable of the same source bytes. Lets the
   * encoder replay the source on CPU after a hardware encode failure.
   */
  reopenInputStream?: (() => AsyncIterable<Uint8Array>) | null;
  /**
   * Optional duration hint in seconds. When `inputStream` is provided,
   * probe is skipped so the caller threads the known duration here.
   */
  inputDurationSeconds?: number | null;
  libraryKeyBase64?: string | null;
  sourceQualityOverride?: string;
  includeSource?: boolean;
  includeFallback: boolean;
  /** Phase 3 — explicit transcode variants (replaces `includeFallback` when set). */
  targetVariants?: QualityPreset[];
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
  audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  signal?: AbortSignal;
  onProgress?: (stage: "transcoding" | "uploading", progress: number) => void;
  onLog?: (line: string) => void;
}) => Promise<ProducedMediaOutputs>;

/**
 * Phase F split — upload-only delegate. Production wires
 * `uploadBadgerProducedMedia` (a thin wrapper around `uploadProducedMedia`
 * with library-key plumbing). Tests can pass a mock that flips state on
 * disk and returns a known `ProducedMedia` shape.
 */
export type UploadProducedMediaFn = (
  input: UploadProducedMediaArgs & { libraryKeyBase64?: string | null }
) => Promise<UploadProducedMediaResult>;

export interface BuildBadgerStepDepsOptions {
  /**
   * The BadgerLibraryDbService instance to write library rows from `commit`
   * and to flip playability on source-job completion. Required.
   */
  libraryDb: BadgerLibraryDbService;
  /**
   * The processMediaJob delegate. Optional in the Phase F split — when
   * `produceMediaOutputs` + `uploadProducedMedia` are both wired, the
   * adapter uses the split model and `processMediaJob` is unused. Production
   * leaves this for backward compatibility with tests that haven't migrated
   * to the split injection yet (badger-ingest-lifecycle, badger-cancel-*,
   * etc.); those tests inject ONLY `processMediaJob` and the adapter falls
   * back to the legacy behavior (extract/transcode runs encode+upload in
   * one call; upload step is a pass-through that exposes the cached
   * ProducedMedia for commit).
   */
  processMediaJob?: ProcessMediaJobFn;
  /**
   * Phase F encode-only delegate. When provided alongside
   * `uploadProducedMedia`, the adapter splits extract/transcode (encode
   * only) from upload (real upload). When omitted, falls back to
   * `processMediaJob`.
   */
  produceMediaOutputs?: ProduceMediaOutputsFn;
  /**
   * Phase F upload-only delegate. See `produceMediaOutputs` above. Both
   * must be provided to enable the split; providing only one is a config
   * error (the adapter logs a warning at build time and falls back to
   * legacy mode).
   */
  uploadProducedMedia?: UploadProducedMediaFn;
  /**
   * Auth token for storage uploads + library DB calls. Production reads it
   * from the active session at submit time; for now, the runtime caller
   * threads it via `payload.token`. If absent the adapter falls back to "".
   */
  resolveToken?: (userId: string) => string | null;
  /**
   * Library key base64 for media encryption. Same plumbing as token.
   */
  resolveLibraryKey?: (userId: string) => string | null;
  /**
   * Forwards object keys to the storage delete path (`/storage/delete`).
   * `discardJobOutputs` uses it to release what a cancelled job had already
   * uploaded; without it those objects only leave storage via the storage
   * GC after its grace window.
   */
  deleteStorageKeys?: (
    token: string,
    keys: string[]
  ) => Promise<{ deleted: number; reclaimedBytes: number }>;
  /**
   * Makes and uploads the seek-bar preview sheets after a source commit (MPV-PREV-02). Test seam; defaults to
   * ingest-core's `producePreviewSheets`.
   */
  producePreviewSheets?: ProducePreviewSheetsFn;
  /** How often a running preview decode checks its format still exists (MPV-PREV-02). Test seam; default 5 s. */
  previewFormatCheckMs?: number;
  /** The user of the runtime's open session; a pending preview run of another user is kept on resume. */
  resolveActiveUserId?: () => string | null;
  /**
   * Upper bound (ms) a step waits for the backend token / library key /
   * re-opened library DB before failing with its original error code. Covers
   * a runtime respawn (guardian restart + desktop re-attach). Defaults to
   * `SF_BADGER_AUTH_WAIT_MS` or 120 000. `0` disables waiting (fail fast).
   */
  authWaitMs?: number;
  /** Poll interval (ms) while waiting for auth readiness. Default 250. */
  authPollMs?: number;
  /**
   * Engine handle used by format-job commits to look up the parent
   * source-job's committed file_id. When omitted, the deps will throw at
   * format-commit time — fine for source-only test setups, required in
   * production wiring (Bug #11).
   */
  engine?: EngineV2;
  /**
   * Round-13 #2: storage-gateway cache warmup hook, invoked fire-and-forget
   * after a successful commit-step library write. Default is the real
   * `warmStorageCache` (HTTP HEAD batch against the storage-gateway).
   *
   * Tests inject a synchronous mock to assert (a) the warmup is called
   * exactly once per commit and (b) commit succeeds even when warmup throws
   * — see badger-deps-cache-warmup.test.ts.
   *
   * Failures inside the warmup function are caught at the call site and
   * logged via `onLog` (when provided); they NEVER propagate to commit.
   */
  warmStorageCacheImpl?: (args: WarmStorageCacheArgs) => Promise<WarmStorageCacheResult>;
  /**
   * PLAY-TRACK-05: called after a commit wrote picture subtitle rows (PGS /
   * VobSub / DVB), so the subtitle OCR worker makes their text twins. Must
   * not throw; a throw is logged and never fails the commit.
   */
  onPictureSubtitlesCommitted?: (info: { mediaId: string; count: number }) => void;
  /**
   * Phase 7 — fetch an encrypted DASH object's raw bytes from storage and
   * decrypt them with the active library key. Used by the retranscode step
   * to stage the source format's chunks before feeding the manifest to
   * ffmpeg. Production wires this to `storageBridge.downloadObject` +
   * `decryptMediaObject` (the symmetric inverse of `encryptMediaObject`
   * used at ingest time). Optional so source-only test setups don't have
   * to wire it; retranscode jobs fail loud with
   * `STEP_RETRANSCODE_DEP_MISSING` when absent.
   */
  downloadAndDecryptObject?: (
    token: string,
    objectKey: string,
    libraryKeyBase64: string
  ) => Promise<Buffer>;
  /**
   * Backoff (ms) before each retry of one retranscode source-object
   * download that failed on a transient storage-gateway error (see
   * `isTransientStorageTransportError`); its length is the retry budget.
   * Defaults to `DEFAULT_SOURCE_DOWNLOAD_RETRY_DELAYS_MS` (~60 s, sized to
   * ride out a gateway restart). Tests inject zero-length schedules.
   */
  sourceDownloadRetryDelaysMs?: readonly number[];
}

export const resolveTranscodeRoot = (): string => {
  // Read at call-time. The legacy BadgerModule.resolveIngestJobStatePath does
  // the same; module-eval-time capture broke round-11 K2 disk-fallback tests
  // that set `SF_TRANSCODE_DIR` per-test, and there's no production reason to
  // freeze the value. Tests change directories between runs; production sets
  // the var once at boot, so the runtime cost (one env read) is negligible.
  const baseEnv = process.env.SF_TRANSCODE_DIR?.trim();
  return baseEnv && baseEnv.length > 0
    ? baseEnv
    : joinPath(process.cwd(), ".runtime", "transcode");
};

const resolveJobDir = (userId: string, jobId: string): string =>
  joinPath(resolveTranscodeRoot(), userId, jobId);

/** Total bytes of the regular files under `dir` (0 when missing); for the removal log line only. */
const dirSizeBytes = async (dir: string): Promise<number> => {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = joinPath(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          // file vanished mid-walk: ignore
        }
      }
    }
  };
  await walk(dir);
  return total;
};

// ---------------------------------------------------------------------------
// Round-11 K2: disk-backed reconstruction of `ProducedMedia` from
// `${jobDir}/job_state.json`. Mirrors `recoverProducedMediaFromState` on the
// legacy BadgerModule class (apps/runtime/src/modules/badger.ts:1497-1584) but
// extracted as a standalone helper so the deps adapter can use it without a
// BadgerModule dependency.
//
// The on-disk state is written by the legacy `processMediaJob` /
// `mediaFinalize` pipeline as outputs are encoded + uploaded. Each
// successfully-uploaded segment lands as `{ key, sizeBytes, uploaded: true }`;
// the final `init` segment lands the same way. When all outputs in the file
// have `encodingComplete: true` and at least one valid segment + init, we can
// rebuild a `ProducedMedia` shape that's structurally equivalent to what
// `processMediaJob` returned in-memory.
//
// Returns null on any of:
//   - missing state file
//   - JSON parse failure
//   - any output is incomplete (missing init / no segments / encodingComplete=false)
//   - any subtitle entry is not yet uploaded
// All "null" cases mean "not enough on-disk evidence to reconstruct" — caller
// must fall through to the next path (typically: throw the missing-produced
// error so the engine surfaces it).
// ---------------------------------------------------------------------------
type PersistedSegmentLike = {
  key?: string;
  uploaded?: boolean;
  sizeBytes?: number;
  startSeconds?: number | null;
};

type PersistedOutputLike = {
  id?: string;
  kind: "video" | "audio";
  quality?: string;
  codec?: string | null;
  codecString?: string | null;
  init?: PersistedSegmentLike | null;
  segments?: PersistedSegmentLike[];
  durationSeconds?: number | null;
  totalSize?: number;
  language?: string;
  label?: string;
  chapters?: Array<{ title: string; startSeconds: number }>;
  encodingComplete?: boolean;
};

type PersistedSubtitleLike = {
  key?: string;
  uploaded?: boolean;
  language: string;
  label: string;
  format: string | null;
  isDefault?: boolean;
};

type PersistedJobStateLike = {
  outputs?: PersistedOutputLike[];
  subtitles?: PersistedSubtitleLike[];
};

/**
 * Every object key `${jobDir}/job_state.json` records as uploaded: video and
 * audio init segments + chunks, and subtitles. Unlike
 * {@link recoverProducedMediaFromState} it accepts a partial (mid-upload)
 * state, because it feeds the cancel cleanup. A missing or unreadable state
 * file yields no keys.
 */
const readUploadedKeysFromState = (dir: string): string[] => {
  const statePath = joinPath(dir, "job_state.json");
  const parsed = loadJobStateSync<PersistedJobStateLike>(statePath);
  if (!parsed) return [];
  const keys = new Set<string>();
  const add = (entry: { key?: string; uploaded?: boolean } | null | undefined) => {
    const key = entry?.uploaded === true && typeof entry.key === "string" ? entry.key.trim() : "";
    if (key) keys.add(key);
  };
  for (const output of Array.isArray(parsed.outputs) ? parsed.outputs : []) {
    add(output.init);
    for (const segment of output.segments ?? []) add(segment);
  }
  for (const subtitle of Array.isArray(parsed.subtitles) ? parsed.subtitles : []) add(subtitle);
  return [...keys];
};

export const recoverProducedMediaFromState = (
  userId: string,
  jobId: string
): ProducedMedia | null => {
  const statePath = joinPath(resolveJobDir(userId, jobId), "job_state.json");
  if (!existsSync(statePath)) return null;
  try {
    // Includes the upload ledger: parts uploaded since the last full save.
    const parsed = loadJobStateSync<PersistedJobStateLike>(statePath) as PersistedJobStateLike;
    const outputs = Array.isArray(parsed.outputs) ? parsed.outputs : [];
    const subtitles = Array.isArray(parsed.subtitles) ? parsed.subtitles : [];
    if (!outputs.length) return null;

    const videoFormats: ProducedMedia["videoFormats"] = [];
    const audioTracks: ProducedMedia["audioTracks"] = [];
    const subtitleTracks: ProducedMedia["subtitleTracks"] = [];

    for (const output of outputs) {
      const initKey =
        output.init?.uploaded && output.init?.key ? output.init.key : null;
      const initSize =
        typeof output.init?.sizeBytes === "number" ? output.init.sizeBytes : null;
      const segments = Array.isArray(output.segments)
        ? output.segments
            .filter(
              (segment) =>
                segment.uploaded === true &&
                typeof segment.key === "string" &&
                (segment.key as string).trim().length > 0 &&
                typeof segment.sizeBytes === "number"
            )
            .map((segment) => ({
              key: segment.key as string,
              sizeBytes: segment.sizeBytes as number,
              startSeconds: segment.startSeconds ?? null,
            }))
        : [];
      if (
        !output.encodingComplete ||
        !initKey ||
        initSize === null ||
        segments.length === 0
      ) {
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
};

const emptyState = (userId: string, inputPath: string): JobState => ({
  version: 1,
  inputPath,
  userId,
  createdAt: new Date().toISOString(),
  outputs: [],
  subtitles: [],
});

/**
 * Retry schedule for one retranscode source-object download hit by a
 * transient storage-gateway failure (restart: connection refused/reset,
 * 5xx while it boots, 404 invalid_session for a session it forgot). Seven
 * retries over 1+2+4+8+15+15+15 = 60 s cover a gateway restart; a longer
 * outage surfaces the original error and fails the job.
 */
const DEFAULT_SOURCE_DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000,
];

export function buildBadgerStepDeps(
  opts: BuildBadgerStepDepsOptions
): BadgerStepDeps {
  const {
    libraryDb,
    processMediaJob,
    produceMediaOutputs: produceMediaOutputsFn,
    uploadProducedMedia: uploadProducedMediaFn,
    resolveToken,
    resolveLibraryKey,
    engine,
  } = opts;

  // Resume-after-restart readiness waits. Jobs persisted across a runtime
  // SIGKILL are re-queued at boot, i.e. BEFORE the desktop re-attaches the
  // user session (backend token via badger.db.open / keys/set, library DB
  // re-open). Failing terminally there loses the job; instead each step waits
  // (bounded, abortable, logged) for the prerequisite and only then surfaces
  // its original error code.
  const { authWaitMs, waitForReady } = createAuthWaiter({
    authWaitMs: opts.authWaitMs,
    authPollMs: opts.authPollMs,
  });
  /** Backend token, or "" once the bounded wait expires. */
  const awaitToken = async (ctx: AuthWaitContext): Promise<string> =>
    (await waitForReady("backend token", () => resolveToken?.(ctx.userId) ?? "", ctx)) ?? "";
  /** Library key, or null once the bounded wait expires. */
  const awaitLibraryKey = (ctx: AuthWaitContext): Promise<string | null> =>
    waitForReady("library key", () => resolveLibraryKey?.(ctx.userId) ?? null, ctx);
  /** True once the library DB is open; false when the bounded wait expires. */
  const awaitLibraryDbOpen = async (ctx: AuthWaitContext): Promise<boolean> => {
    // Test doubles without isOpen() are treated as always open.
    if (typeof libraryDb.isOpen !== "function") return true;
    return (await waitForReady("library db open", () => libraryDb.isOpen(), ctx)) === true;
  };
  // Seek-bar previews after the source commit (MPV-PREV-02). Their pending runs sit beside the job dirs (which the
  // succeeded-job cleanup removes while a run may still go on) and are re-queued at start (RT-LIFE-04).
  const previewShutdown = new AbortController();
  const previewSheets = createPreviewSheetsRunner({
    libraryDb,
    resolveToken,
    deleteStorageKeys: opts.deleteStorageKeys,
    produce: opts.producePreviewSheets,
    transcodeRoot: resolveTranscodeRoot,
    formatCheckMs: opts.previewFormatCheckMs,
    activeUserId: opts.resolveActiveUserId,
    resolveLibraryKey: (userId) => resolveLibraryKey?.(userId) ?? null,
    awaitReady: async (job) => {
      const ctx: AuthWaitContext = { stage: "preview-sheets", userId: job.userId, jobId: job.jobId, signal: previewShutdown.signal };
      return (await awaitToken(ctx)) !== "" && (await awaitLibraryKey(ctx)) !== null && (await awaitLibraryDbOpen(ctx));
    },
  });
  /** Bounded wait for the library DB; throws STEP_COMMIT_LIBRARY_NOT_READY on timeout. */
  const requireLibraryDbOpenForCommit = async (ctx: AuthWaitContext): Promise<void> => {
    if (await awaitLibraryDbOpen(ctx)) return;
    throw new Error(
      `STEP_COMMIT_LIBRARY_NOT_READY: library db not open for userId=${ctx.userId} after ${authWaitMs}ms — desktop library re-open must run before commit`
    );
  };
  // Round-13 #2: warmup hook — defaults to the real HTTP-driven implementation.
  // Tests pass a vi.fn() spy via `warmStorageCacheImpl` so they can assert
  // exact invocation count + that throwing here doesn't break commit.
  const warmStorageCacheImpl: (
    args: WarmStorageCacheArgs
  ) => Promise<WarmStorageCacheResult> =
    opts.warmStorageCacheImpl ?? warmStorageCache;

  // Phase F split: both `produceMediaOutputs` and `uploadProducedMedia` must
  // be wired together to enable the real split. A half-configured adapter
  // (only one of the pair) would either skip uploads or skip encode — fail
  // loud at construction so it can't ship to production via silent fallback
  // to the legacy path.
  const useSplit = Boolean(produceMediaOutputsFn && uploadProducedMediaFn);
  if (
    (produceMediaOutputsFn && !uploadProducedMediaFn) ||
    (!produceMediaOutputsFn && uploadProducedMediaFn)
  ) {
    throw new Error(
      "BADGER_DEPS_HALF_SPLIT — buildBadgerStepDeps requires BOTH produceMediaOutputs AND uploadProducedMedia to enable the split model; got " +
        (produceMediaOutputsFn
          ? "produceMediaOutputs only"
          : "uploadProducedMedia only")
    );
  }
  if (!useSplit && !processMediaJob) {
    throw new Error(
      "BADGER_DEPS_NO_INGEST_HOOK — buildBadgerStepDeps requires either (produceMediaOutputs + uploadProducedMedia) for the split model OR processMediaJob for the legacy path"
    );
  }

  const probe: BadgerStepDeps["probe"] = async (
    inputPath: string,
    signal: AbortSignal
  ): Promise<ProbeResult> => {
    if (signal.aborted) throw new Error("CANCELLED");
    const result = await probeMediaFile(inputPath);
    if (signal.aborted) throw new Error("CANCELLED");

    const streams = result.streams.map((s, i) => ({
      index: i,
      codecType: String(s.codec_type ?? ""),
      codecName: (s.codec_name as string | undefined) ?? null,
      language: ((s.tags as Record<string, unknown> | undefined)?.language as
        | string
        | undefined) ?? null,
      label: ((s.tags as Record<string, unknown> | undefined)?.title as
        | string
        | undefined) ?? null,
      width: (s.width as number | undefined) ?? null,
      height: (s.height as number | undefined) ?? null,
    }));
    const video = streams.find((s) => s.codecType === "video");
    const audioStreamCount = streams.filter((s) => s.codecType === "audio").length;
    const subtitleStreamCount = streams.filter(
      (s) => s.codecType === "subtitle"
    ).length;
    const durationSeconds =
      Number(
        (result.data.format as { duration?: string | number } | undefined)?.duration ?? 0
      ) || null;
    const chapters =
      (result.data as {
        chapters?: Array<{ start_time?: string; tags?: Record<string, unknown> }>;
      }).chapters?.map((c) => ({
        title: String(c.tags?.title ?? "Chapter"),
        startSeconds: Number(c.start_time ?? 0),
      })) ?? [];
    const heightNum = video?.height ?? null;
    const sourceQuality =
      heightNum && heightNum >= 1080
        ? "1080p"
        : heightNum && heightNum >= 720
        ? "720p"
        : heightNum && heightNum >= 480
        ? "480p"
        : heightNum && heightNum > 0
        ? "360p"
        : null;

    return {
      durationSeconds,
      videoCodec: video?.codecName ?? null,
      videoWidth: video?.width ?? null,
      videoHeight: heightNum,
      sourceQuality,
      audioStreamCount,
      subtitleStreamCount,
      streams,
      chapters,
    };
  };

  const identify: BadgerStepDeps["identify"] = async ({ filename, hint }): Promise<IdentifyResult> => {
    const parsed = parseFilename(filename);
    return {
      mediaId: hint.mediaId ?? null,
      parsedTitle: parsed.title ?? null,
      season: hint.season ?? parsed.season ?? null,
      episode: hint.episode ?? parsed.episode ?? null,
      year: parsed.year ?? null,
      preexistingHint: Boolean(hint.mediaId),
    };
  };

  const extractSource: BadgerStepDeps["extractSource"] = async (
    input: ExtractInput
  ): Promise<ExtractResult> => {
    if (input.signal.aborted) throw new Error("CANCELLED");
    // Resume-after-restart: wait (bounded) for the desktop to re-attach the
    // session before declaring auth not ready.
    const token = await awaitToken({
      stage: "extract",
      userId: input.userId,
      jobId: input.jobId,
      signal: input.signal,
    });
    if (!token) {
      // Fail-loud BEFORE we descend into the ingest pipeline (which throws
      // a generic AUTH_REQUIRED with no actionable context). Common cause:
      // the desktop's auth-attach IPC hasn't fired yet — runtime spawned,
      // ingest submitted, but `setBackendToken` not called. The error
      // message points at the deps-attach lifecycle so operators don't
      // chase the mediaProcessor token check.
      throw new Error(
        `BADGER_AUTH_NOT_READY: no backend token for userId=${input.userId} at extract time. ` +
          `Desktop auth-attach (onKeySet → setBackendToken) must run before ingest dispatch.`
      );
    }
    const libraryKeyBase64 = resolveLibraryKey?.(input.userId) ?? null;

    if (useSplit) {
      // Phase F split: extract runs encode only. The upload step does the
      // real upload + flips `uploaded:true` per chunk.
      const outputs = await produceMediaOutputsFn!({
        userId: input.userId,
        jobId: input.jobId,
        inputPath: input.inputPath,
        libraryKeyBase64,
        includeSource: true,
        includeFallback: false,
        includeAudio: true,
        includeSubtitles: true,
        includeChapters: true,
        audioTrackOverrides: input.audioOverrides,
        subtitleTrackOverrides: input.subtitleOverrides,
        signal: input.signal,
        onProgress: (stage, pct) => {
          input.onProgress?.(stage, pct);
        },
        onLog: input.onLog,
      });
      // Cache the encode-side `produced` shape (chunks empty). The upload
      // step replaces this with the post-upload `produced` (chunks
      // populated). Both shapes are compatible with the commit step's
      // ProducedMedia signature.
      producedCache.set(
        cacheKey(input.userId, input.jobId, "source"),
        outputs.produced
      );
      const segmentCount = outputs.stateStore.getState().outputs.reduce(
        (n, o) => n + o.segments.length,
        0
      );
      return {
        jobDir: outputs.jobDir,
        state: emptyState(input.userId, input.inputPath),
        segmentCount,
      };
    }

    // Legacy path: processMediaJob runs encode + upload + finalize in one
    // call. Kept for backward compatibility with tests that haven't migrated
    // to the split injection.
    const result = await processMediaJob!({
      token,
      userId: input.userId,
      jobId: input.jobId,
      inputPath: input.inputPath,
      placementId: input.placementId,
      libraryKeyBase64,
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: true,
      includeChapters: true,
      audioTrackOverrides: input.audioOverrides,
      subtitleTrackOverrides: input.subtitleOverrides,
      signal: input.signal,
      onProgress: (stage, pct) => {
        input.onProgress?.(stage, pct);
      },
      onLog: input.onLog,
    });
    producedCache.set(
      cacheKey(input.userId, input.jobId, "source"),
      result.produced
    );
    const segmentCount = result.produced.videoFormats.reduce(
      (n, f) => n + f.chunks.length,
      0
    );
    return {
      jobDir: resolveJobDir(input.userId, input.jobId),
      state: emptyState(input.userId, input.inputPath),
      segmentCount,
    };
  };

  const transcodeFormat: BadgerStepDeps["transcodeFormat"] = async (
    input: TranscodeInput
  ): Promise<TranscodeResult> => {
    if (input.signal.aborted) throw new Error("CANCELLED");
    if (!QUALITY_ORDER.includes(input.variant as QualityPreset)) {
      // Variant must be one of the canonical QualityPreset values. Fail loud
      // so callers passing garbage (typo, stale settings row) see a clear
      // error instead of an encoder silently producing nothing.
      throw new Error(
        `STEP_TRANSCODE_VARIANT_UNSUPPORTED:${input.variant} — not a known quality preset`
      );
    }
    const variant = input.variant as QualityPreset;
    const token = await awaitToken({
      stage: "transcode",
      userId: input.userId,
      jobId: input.jobId,
      signal: input.signal,
    });
    if (!token) {
      throw new Error(
        `BADGER_AUTH_NOT_READY: no backend token for userId=${input.userId} at transcode time. ` +
          `Desktop auth-attach (onKeySet → setBackendToken) must run before ingest dispatch.`
      );
    }
    const libraryKeyBase64 = resolveLibraryKey?.(input.userId) ?? null;

    // Phase 3: explicit single-variant transcode. `targetVariants: [variant]`
    // replaces the legacy `includeFallback: true` (which only ever produced
    // 360p). For variant === "360p" the encoder produces byte-identical
    // ffmpeg args via the preserved hardcoded recipe in
    // `buildVideoEncoderArgs`. `includeFallback: false` is passed explicitly
    // so the legacy 360p output is NOT also produced for non-360p variants.
    if (useSplit) {
      const outputs = await produceMediaOutputsFn!({
        userId: input.userId,
        jobId: input.jobId,
        inputPath: input.inputPath,
        libraryKeyBase64,
        includeSource: false,
        includeFallback: false,
        targetVariants: [variant],
        includeAudio: false,
        includeSubtitles: false,
        includeChapters: false,
        signal: input.signal,
        onProgress: (stage, pct) => {
          input.onProgress?.(stage, pct);
        },
        onLog: input.onLog,
      });
      producedCache.set(
        cacheKey(input.userId, input.jobId, "format", variant),
        outputs.produced
      );
      const segmentCount = outputs.stateStore.getState().outputs.reduce(
        (n, o) => n + o.segments.length,
        0
      );
      return {
        jobDir: outputs.jobDir,
        state: emptyState(input.userId, input.inputPath),
        segmentCount,
        variant,
      };
    }

    // Legacy path.
    const result = await processMediaJob!({
      token,
      userId: input.userId,
      jobId: input.jobId,
      inputPath: input.inputPath,
      placementId: input.placementId,
      libraryKeyBase64,
      includeSource: false,
      includeFallback: false,
      targetVariants: [variant],
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
      signal: input.signal,
      onProgress: (stage, pct) => {
        input.onProgress?.(stage, pct);
      },
      onLog: input.onLog,
    });
    producedCache.set(
      cacheKey(input.userId, input.jobId, "format", variant),
      result.produced
    );
    const segmentCount = result.produced.videoFormats.reduce(
      (n, f) => n + f.chunks.length,
      0
    );
    return {
      jobDir: resolveJobDir(input.userId, input.jobId),
      state: emptyState(input.userId, input.inputPath),
      segmentCount,
      variant,
    };
  };

  // Phase 7 — retranscode dep. Streams encrypted DASH chunks from object
  // storage through the runtime decryptor straight into ffmpeg's stdin —
  // no temp-dir staging, no contiguous file on disk. The Phase 3 encoder
  // (`produceMediaOutputs` with `targetVariants: [<variant>]` +
  // `inputStream`) skips probe, derives sourceQuality from the override,
  // and reads its input from `pipe:0`.
  //
  // Why streaming: a 1080p source format can be 20+ GB; staging to disk
  // doubles peak disk pressure and serialises download-then-encode when
  // they could pipeline. Streaming starts the encode as soon as init +
  // first media segment arrive, and disk footprint is bounded by the
  // encode's own DASH output.
  //
  // CPU-retry: a hardware-encode failure (or an unusable hardware encoder,
  // see `detectEncoder`'s probe) retries on CPU. The one-shot stream is
  // replayed through `reopenInputStream`, which re-downloads and
  // re-decrypts the source chunks.
  //
  // Bail-out semantics: a missing `downloadAndDecryptObject` dep, missing
  // token, missing library key, or empty source chunk list each surface a
  // distinct error code so the engine's failed-event payload narrows the
  // diagnostic surface for the renderer.
  const retranscodeFormat: NonNullable<BadgerStepDeps["retranscodeFormat"]> =
    async (input: RetranscodeInput): Promise<RetranscodeResult> => {
      if (input.signal.aborted) throw new Error("CANCELLED");
      if (!QUALITY_ORDER.includes(input.targetVariant as QualityPreset)) {
        throw new Error(
          `STEP_RETRANSCODE_VARIANT_UNSUPPORTED:${input.targetVariant} — not a known quality preset`
        );
      }
      if (!opts.downloadAndDecryptObject) {
        throw new Error(
          "STEP_RETRANSCODE_DOWNLOAD_DEP_MISSING — buildBadgerStepDeps must wire downloadAndDecryptObject for post-ingest replan jobs"
        );
      }
      if (!produceMediaOutputsFn) {
        throw new Error(
          "STEP_RETRANSCODE_PRODUCE_DEP_MISSING — buildBadgerStepDeps must wire produceMediaOutputs (Phase F split) for post-ingest replan jobs"
        );
      }
      const targetVariant = input.targetVariant as QualityPreset;
      // Resume-after-restart: a job re-queued at boot runs before the desktop
      // has re-attached the session. Wait (bounded, logged) for the backend
      // token, library key and re-opened library DB instead of failing the
      // job terminally; only a wait that expires surfaces the original error.
      const waitCtx = {
        stage: "retranscode",
        userId: input.userId,
        jobId: input.jobId,
        signal: input.signal,
      };
      const token = await awaitToken(waitCtx);
      if (!token) {
        throw new Error(
          `STEP_RETRANSCODE_AUTH_NOT_READY: no backend token for userId=${input.userId} after ${authWaitMs}ms — desktop auth-attach must run before retranscode dispatch`
        );
      }
      const libraryKeyBase64 = await awaitLibraryKey(waitCtx);
      if (!libraryKeyBase64) {
        throw new Error(
          "STEP_RETRANSCODE_LIBRARY_KEY_MISSING — active user has no library key, cannot decrypt source chunks"
        );
      }
      if (!(await awaitLibraryDbOpen(waitCtx))) {
        throw new Error(
          `STEP_RETRANSCODE_LIBRARY_NOT_READY: library db not open after ${authWaitMs}ms — desktop library re-open must run before retranscode dispatch`
        );
      }

      // 1. Read the source format's chunk list from library-db. The library
      //    DB doesn't currently expose a by-fileId helper, so we use the
      //    media-keyed list (`listMediaFormats(mediaId)`) and filter by
      //    fileId + formatId. The chunk array on each row is already ordered
      //    by `order_index` (see libraryDb.loadFormatChunks).
      const allFormatsForMedia = (await libraryDb
        .call("listMediaFormats", [input.mediaId])
        .catch(() => null)) as
        | Array<{
            id: string;
            fileId: string;
            initKey: string | null;
            durationSeconds?: number | null;
            chunks: Array<{ key: string }>;
          }>
        | null;
      const sourceRow = (allFormatsForMedia ?? []).find(
        (row) => row.id === input.sourceFormatId && row.fileId === input.fileId
      );
      if (!sourceRow) {
        throw new Error(
          `STEP_RETRANSCODE_SOURCE_FORMAT_NOT_FOUND:${input.sourceFormatId} — no media_formats row for fileId=${input.fileId}`
        );
      }
      if (!sourceRow.initKey || sourceRow.chunks.length === 0) {
        throw new Error(
          `STEP_RETRANSCODE_SOURCE_FORMAT_EMPTY:${input.sourceFormatId} — missing initKey or no chunks`
        );
      }

      // 2. Build the streaming source iterator. Yields the init segment
      //    first, then each media segment in order. Each yield triggers a
      //    download + decrypt; ffmpeg starts encoding as soon as init +
      //    first segment arrive. Signal-abort is checked between yields
      //    so a mid-stream cancel stops download immediately (the ffmpeg
      //    child is killed by the engine's existing abort plumbing,
      //    which causes the helper's pump-then-end path to close stdin).
      const downloadAndDecrypt = opts.downloadAndDecryptObject;
      const initKey = sourceRow.initKey;
      const chunks = sourceRow.chunks;
      const totalPieces = chunks.length + 1;
      // Progress (#25 P14): a stream has no probe, so ffmpeg's out_time can
      // only become a percentage against a known duration. Pre-fix none was
      // passed and a replan encode sat at 1 % for its whole 5-15 min run.
      // The source format row carries its duration; when an older row lacks
      // it, fall back to the share of source pieces fed to ffmpeg (stdin
      // back-pressure keeps that within a segment or two of the encoder).
      const sourceDurationSeconds =
        typeof sourceRow.durationSeconds === "number" &&
        Number.isFinite(sourceRow.durationSeconds) &&
        sourceRow.durationSeconds > 0
          ? sourceRow.durationSeconds
          : null;
      const progressFromPieces = sourceDurationSeconds === null;
      console.info(
        JSON.stringify({
          event: "badger.deps.retranscode.progress_source",
          jobId: input.jobId,
          sourceFormatId: input.sourceFormatId,
          targetVariant,
          source: progressFromPieces ? "streamed-pieces" : "ffmpeg-out-time",
          sourceDurationSeconds,
          totalPieces,
        })
      );
      input.onLog?.(
        `[retranscode] streaming ${chunks.length} chunks + init from ${input.sourceVariant} → ffmpeg stdin (no temp dir)`
      );

      const toUint8 = (bytes: Uint8Array | ArrayBuffer | Buffer): Uint8Array =>
        bytes instanceof Uint8Array
          ? bytes
          : new Uint8Array(bytes as ArrayBuffer);

      // Each source object is an independent, idempotent download with its
      // own tunnel session, so a storage-gateway restart mid-stream (#25 N5:
      // connection refused/reset, 5xx while booting, 404 invalid_session)
      // retries just that object on the bounded schedule instead of killing
      // ffmpeg and failing the job. Non-transient errors (decrypt/GCM,
      // other 4xx, quota) and an exhausted budget rethrow the original error.
      const retryDelaysMs =
        opts.sourceDownloadRetryDelaysMs ?? DEFAULT_SOURCE_DOWNLOAD_RETRY_DELAYS_MS;
      const downloadSourceObject = async (objectKey: string) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await downloadAndDecrypt(token, objectKey, libraryKeyBase64);
          } catch (err) {
            const delayMs = retryDelaysMs[attempt];
            if (delayMs === undefined || !isTransientStorageTransportError(err)) throw err;
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              JSON.stringify({
                event: "badger.deps.retranscode.source_download_retry",
                jobId: input.jobId,
                sourceFormatId: input.sourceFormatId,
                objectKey,
                attempt: attempt + 1,
                maxRetries: retryDelaysMs.length,
                delayMs,
                error: message,
              })
            );
            input.onLog?.(
              `[retranscode] retrying source download ${objectKey} in ${delayMs}ms (retry ${attempt + 1}/${retryDelaysMs.length}) after transient storage error: ${message}`
            );
            if (input.signal.aborted) throw new Error("CANCELLED");
            await sleepOrAbort(delayMs, input.signal);
            if (input.signal.aborted) throw new Error("CANCELLED");
          }
        }
      };

      const makeSourceStream = (): AsyncIterable<Uint8Array> => (async function* () {
        if (input.signal.aborted) throw new Error("CANCELLED");
        const initBytes = await downloadSourceObject(initKey);
        yield toUint8(initBytes);
        for (let i = 0; i < chunks.length; i += 1) {
          if (input.signal.aborted) throw new Error("CANCELLED");
          const bytes = await downloadSourceObject(chunks[i].key);
          yield toUint8(bytes);
          if (progressFromPieces) {
            input.onProgress?.("transcoding", Math.floor(((i + 2) / totalPieces) * 99));
          }
          if (i === 0 || (i + 1) % 25 === 0 || i === chunks.length - 1) {
            input.onLog?.(
              `[retranscode] streamed ${i + 2}/${totalPieces} source pieces`
            );
          }
        }
      })();

      // 3. Run the Phase 3 encoder in streaming mode. `inputPath` is
      //    unused when `inputStream` is set; the value satisfies the
      //    type. produceMediaOutputs skips probe (we provide
      //    sourceQualityOverride), enforces single-variant, and the
      //    underlying ffmpeg invocation uses `-i pipe:0`.
      const outputs = await produceMediaOutputsFn({
        userId: input.userId,
        jobId: input.jobId,
        inputPath: `retranscode-stream:${input.sourceFormatId}`,
        inputStream: makeSourceStream(),
        inputDurationSeconds: sourceDurationSeconds,
        // A hardware encode failure retries on CPU; the spent stream is
        // replayed by re-downloading + re-decrypting the source chunks.
        reopenInputStream: makeSourceStream,
        libraryKeyBase64,
        sourceQualityOverride: input.sourceVariant,
        includeSource: false,
        includeFallback: false,
        targetVariants: [targetVariant],
        includeAudio: false,
        includeSubtitles: false,
        includeChapters: false,
        signal: input.signal,
        onProgress: (stage, pct) => {
          input.onProgress?.(stage, pct);
        },
        onLog: input.onLog,
      });
      producedCache.set(
        cacheKey(input.userId, input.jobId, "format", targetVariant),
        outputs.produced
      );
      const segmentCount = outputs.stateStore.getState().outputs.reduce(
        (n, o) => n + o.segments.length,
        0
      );

      return {
        jobDir: outputs.jobDir,
        state: emptyState(input.userId, `retranscode-stream:${input.sourceFormatId}`),
        segmentCount,
        variant: targetVariant,
      };
    };

  const uploadOutputs: BadgerStepDeps["uploadOutputs"] = async (
    input: UploadInput
  ): Promise<UploadResult> => {
    if (input.signal.aborted) throw new Error("CANCELLED");

    if (useSplit) {
      // Phase F honest upload path. The previous extract/transcode step
      // wrote DASH segments to disk with `uploaded:false` everywhere; this
      // step encrypts each pending chunk via the runtime gateway, flips
      // the per-chunk uploaded flag, and persists `job_state.json` after
      // each. Resume-after-crash is automatic — a chunk already flagged
      // uploaded by a prior process is skipped.
      // Resume-after-restart: an empty token used to reach uploadProducedMedia
      // and fail terminally with AUTH_REQUIRED. Wait (bounded) for the
      // desktop to re-attach the session first.
      const waitCtx: AuthWaitContext = {
        stage: "upload",
        userId: input.userId,
        jobId: input.jobId,
        signal: input.signal,
      };
      const uploadToken = input.token || (await awaitToken(waitCtx));
      // Read the library key only AFTER the session wait. Before the desktop
      // re-attaches, the only key present is the startup replay's last
      // persisted entry (possibly another user's) or none at all: encrypting
      // with it makes the media undecryptable, and null fails terminally with
      // media_key_missing. auth-attach sets token + key together, so the key
      // is normally immediate here; awaitLibraryKey covers a split attach.
      // No token after the bounded wait → upload fails with AUTH_REQUIRED
      // anyway; don't stack a second full wait on top.
      const libraryKeyBase64 = uploadToken
        ? await awaitLibraryKey(waitCtx)
        : (resolveLibraryKey?.(input.userId) ?? null);
      console.info(
        JSON.stringify({
          event: "badger.deps.upload.session_ready",
          jobId: input.jobId,
          userId: input.userId,
          scope: input.scope,
          variant: input.variant ?? null,
          hasToken: Boolean(uploadToken),
          hasLibraryKey: Boolean(libraryKeyBase64),
        })
      );
      const result = await uploadProducedMediaFn!({
        token: uploadToken,
        userId: input.userId,
        jobId: input.jobId,
        scope: input.scope,
        variant: input.variant,
        placementId: input.placementId,
        libraryKeyBase64,
        signal: input.signal,
        onProgress: (_stage, pct) => input.onProgress?.(pct),
        onLog: input.onLog,
      });
      // Refresh the cache with the post-upload `produced` (chunks populated
      // with real keys) so a later commit-step lookup gets the live shape.
      producedCache.set(
        cacheKey(input.userId, input.jobId, input.scope, input.variant),
        result.produced
      );
      return result;
    }

    // Legacy fallback: extract/transcode already pushed every chunk inside
    // their single processMediaJob call, so this step has nothing to upload
    // — it just exposes the cached `ProducedMedia` to commit. Chain
    // `cache → disk-recover → throw` keeps HMR / cross-process resume
    // working: a second runtime spawned mid-job rebuilds the `ProducedMedia`
    // from `${jobDir}/job_state.json` rather than failing loud.
    const key = cacheKey(input.userId, input.jobId, input.scope, input.variant);
    const produced =
      producedCache.get(key) ??
      recoverProducedMediaFromState(input.userId, input.jobId);
    if (!produced) {
      throw new Error(
        `STEP_UPLOAD_PRODUCED_MISSING:${key} — extract/transcode must run first ` +
          `(cache miss + disk reconstruction failed)`
      );
    }
    const uploadedKeys: string[] = [];
    for (const fmt of produced.videoFormats) {
      if (fmt.initKey) uploadedKeys.push(fmt.initKey);
      for (const c of fmt.chunks) uploadedKeys.push(c.key);
    }
    for (const a of produced.audioTracks) {
      if (a.initKey) uploadedKeys.push(a.initKey);
      for (const c of a.chunks) uploadedKeys.push(c.key);
    }
    for (const s of produced.subtitleTracks) {
      if (s.objectKey) uploadedKeys.push(s.objectKey);
    }
    input.onProgress?.(100);
    return { produced, uploadedKeys };
  };

  /**
   * Releases the uploads of a format commit that reused an existing row (#2438). A key the library still
   * references for the media (a retried commit re-sending the committed row's own keys) is never released.
   * Failures are logged only: the commit stands and the storage GC reclaims what is left.
   */
  const releaseDuplicateFormatKeys = async (input: CommitInput, uploaded: Array<string | null | undefined>): Promise<void> => {
    const keys = uploaded.filter((key): key is string => typeof key === "string" && key.length > 0);
    if (keys.length === 0) return;
    const logBase = { event: "badger.deps.commit.duplicate_release", jobId: input.jobId, mediaId: input.mediaId };
    const token = resolveToken?.(input.userId) ?? "";
    if (!opts.deleteStorageKeys || !token) {
      console.warn(JSON.stringify({ ...logBase, skipped: !token ? "no_token" : "no_delete_hook", keys }));
      return;
    }
    try {
      const listed = (await libraryDb.call("getMediaObjectKeys", [input.mediaId])) as unknown;
      const referenced = new Set(Array.isArray(listed) ? listed.map(String) : []);
      const unreferenced = keys.filter((key) => !referenced.has(key));
      if (unreferenced.length === 0) return;
      const result = await opts.deleteStorageKeys(token, unreferenced);
      console.info(JSON.stringify({ ...logBase, keys: unreferenced.length, deleted: result.deleted, reclaimedBytes: result.reclaimedBytes }));
    } catch (err) {
      console.warn(JSON.stringify({ ...logBase, failed: err instanceof Error ? err.message : String(err), keys }));
    }
  };

  const commit: BadgerStepDeps["commit"] = async (
    input: CommitInput
  ): Promise<CommitResult> => {
    if (input.signal.aborted) throw new Error("CANCELLED");

    // Round-11 K2: chain `input.produced → cache → disk-recover → throw`.
    // The user-visible failure mode pre-fix: a second runtime process spawned
    // mid-job (HMR re-eval, port-conflicting respawn) hit the empty in-memory
    // cache, threw `STEP_COMMIT_PRODUCED_MISSING`, and overwrote
    // runtime_jobs.db with status=failed — even though the FIRST runtime had
    // already written the library rows correctly (hence "failed-but-playable"
    // user reports). The disk fallback rebuilds `ProducedMedia` from
    // `${jobDir}/job_state.json` so commit semantics survive a process
    // restart between extract/upload and commit.
    const produced =
      input.produced ??
      producedCache.get(cacheKey(input.userId, input.jobId, input.scope, input.variant)) ??
      recoverProducedMediaFromState(input.userId, input.jobId);
    if (!produced) {
      throw new Error(
        "STEP_COMMIT_PRODUCED_MISSING — upload step must precede commit " +
          "(cache miss + disk reconstruction failed)"
      );
    }

    // Resume-after-restart: the desktop re-opens the library a moment after
    // the guardian respawns the runtime. Wait (bounded) instead of failing the
    // job terminally on LIBRARY_DB_NOT_OPEN.
    await requireLibraryDbOpenForCommit({
      stage: "commit",
      userId: input.userId,
      jobId: input.jobId,
      signal: input.signal,
    });

    if (input.scope === "source") {
      // Round-12 #1: pre-check the media_items row exists BEFORE linkFileToMedia
      // INSERTs against the FK (`media_files.media_id → media_items(id)`,
      // defined in packages/library-db-definition/src/migrations.ts:323).
      // Pre-fix the FK violation surfaced as the cryptic SQLite chain
      // `errno: 787 / SQLITE_CONSTRAINT_FOREIGNKEY / FOREIGN KEY constraint
      // failed` and stalled the source job in "Committing" with no actionable
      // operator hint. Reproduces when the desktop's addMediaFromTmdb hasn't
      // been called for hints.mediaId yet, or the row was deleted before
      // commit ran (logout, attachMetadata-vs-engine race). The format-job
      // branch does NOT need this check — its parent source job already
      // pre-checked + wrote the row, and adding a round-trip per format would
      // double calls without catching anything new (see fk-guard test).
      const mediaDetails = await libraryDb.call("getMediaDetails", [input.mediaId]);
      if (!mediaDetails) {
        throw new Error(
          `STEP_COMMIT_MEDIA_ITEM_MISSING:${input.mediaId} — library_media row absent at commit time. ` +
            `The desktop addMediaFromTmdb / attach_metadata pipeline must persist this row before the runtime ` +
            `engine reaches the commit step. Common causes: (a) attachMetadata never fired for this ingest, ` +
            `(b) the row was deleted mid-job (logout, library reset), (c) a race where the engine raced ` +
            `attachMetadata. Check the desktop main-process logs for addMediaFromTmdb activity around jobId=${input.jobId}.`
        );
      }

      // Link a file row + add formats + audio tracks + subtitle tracks. Mirror
      // of `commitLabQueueLinkedFile` + `commitLabQueueFormats` +
      // `commitLabQueueTracksAndSkipMarkers` in
      // `apps/badger/desktop/src/main/labQueueLibraryCommit.ts`.
      // TV episodes: pass through (season, episode) from `input` so the
      // `media_files` row + ensured `media_episodes` row land with the
      // correct coordinates. For movies, both are null (no-op). See
      // CommitInput JSDoc for the play-button regression this closes.
      const fileId = (await libraryDb.call("linkFileToMedia", [
        input.mediaId,
        input.filename,
        input.season ?? null,
        input.episode ?? null,
        // STOR-USE-02: the size the user's computer showed for the file (source jobs only).
        { originalSizeBytes: input.produced?.originalSizeBytes ?? null },
      ])) as string;

      // Phase 2: identify the source-extracted row inside this source-job's
      // produced.videoFormats. The source extraction (mediaProcessor's
      // `video-source` output) produces exactly one row whose `quality`
      // matches the probe-derived `sourceQuality` threaded through the job
      // payload. Fallback variants are deliberately picked to be BELOW
      // source quality (see `effectiveVariants` in mediaProcessor —
      // qualities are never upscaled), so the (quality === sourceQuality)
      // match singles out the source. We also tie-break on the FIRST match
      // for defensive safety if a future variant configuration ever collides
      // — the source row is appended to `state.outputs` first, so it lands
      // at the lowest index in `produced.videoFormats` (see
      // `buildProducedMedia` in mediaFinalize.ts which iterates in append
      // order). When `input.sourceQuality` is null or absent (legacy
      // payloads pre-Phase-2), no row is flagged — `addMediaFormat` falls
      // back to the column DEFAULT 0, and the Phase 1 schema backfill (in
      // `library-db-definition/src/migrations.ts`) handles libraries that
      // existed before this code shipped.
      const expectedSourceQuality =
        typeof input.sourceQuality === "string" && input.sourceQuality.length > 0
          ? input.sourceQuality
          : null;
      let sourceMarked = false;
      // The row the seek-bar previews go on: the source, or the first row when the job names no source quality.
      let previewFormat: { id: string; initKey: string | null; durationSeconds: number | null } | null = null;

      const formatIds: string[] = [];
      for (const format of produced.videoFormats) {
        const sizeMb = Math.max(1, Math.round(format.totalSize / (1024 * 1024)));
        const bitrateKbps =
          format.durationSeconds && format.durationSeconds > 0
            ? Math.round((format.totalSize * 8) / 1000 / format.durationSeconds)
            : null;
        const isSourceRow =
          !sourceMarked &&
          expectedSourceQuality !== null &&
          format.quality === expectedSourceQuality;
        if (isSourceRow) sourceMarked = true;
        const formatId = (await libraryDb.call("addMediaFormat", [
          input.mediaId,
          fileId,
          format.quality,
          format.codec,
          sizeMb,
          format.chunks,
          bitrateKbps,
          {
            codecString: format.codecString ?? null,
            initKey: format.initKey,
            initSize: format.initSize,
            durationSeconds: format.durationSeconds ?? null,
            totalSize: format.totalSize,
            isSource: isSourceRow,
          },
        ])) as string;
        formatIds.push(String(formatId));
        if (isSourceRow || (expectedSourceQuality === null && previewFormat === null)) {
          previewFormat = { id: String(formatId), initKey: format.initKey ?? null, durationSeconds: format.durationSeconds ?? null };
        }
        if (format.chapters?.length) {
          await libraryDb.call("addChaptersForFormat", [
            String(formatId),
            format.chapters,
          ]);
        }
      }

      for (const audio of produced.audioTracks) {
        await libraryDb.call("addAudioTrackWithChunks", [
          {
            mediaId: input.mediaId,
            fileId,
            season: input.season ?? null,
            episode: input.episode ?? null,
            language: audio.language,
            label: audio.label,
            codec: audio.codec ?? null,
            codecString: audio.codecString ?? null,
            initKey: audio.initKey,
            initSize: audio.initSize,
            durationSeconds: audio.durationSeconds ?? null,
            totalSize: audio.totalSize,
            chunks: audio.chunks,
            isDefault: audio.isDefault ?? false,
            source: "upload",
          },
        ]);
      }
      let pictureSubtitles = 0;
      for (const sub of produced.subtitleTracks) {
        await libraryDb.call("addSubtitleTrackWithObject", [
          {
            mediaId: input.mediaId,
            fileId,
            season: input.season ?? null,
            episode: input.episode ?? null,
            language: sub.language,
            label: sub.label,
            objectKey: sub.objectKey,
            format: sub.format ?? null,
            isDefault: sub.isDefault ?? false,
            source: "upload",
          },
        ]);
        if (PICTURE_SUBTITLE_FORMATS.includes(String(sub.format ?? "").toLowerCase())) pictureSubtitles += 1;
      }
      if (pictureSubtitles > 0) {
        console.info(
          `[subtitle-ocr] commit.picture_subtitles ${JSON.stringify({ jobId: input.jobId, mediaId: input.mediaId, fileId, count: pictureSubtitles })}`
        );
        try {
          opts.onPictureSubtitlesCommitted?.({ mediaId: input.mediaId, count: pictureSubtitles });
        } catch (hookError) {
          console.warn(
            `[subtitle-ocr] commit.kick_failed ${JSON.stringify({ jobId: input.jobId, error: hookError instanceof Error ? hookError.message : String(hookError) })}`
          );
        }
      }

      // Round-13 #2: storage-gateway cache warmup — fire-and-forget BEFORE
      // returning. The intent is "started warmup", not "warmup finished" — we
      // explicitly do NOT await the inner Promise so commit returns as soon
      // as the library writes are durable.
      //
      // Failure-mode guarantees (covered by the @bugfix @regression-proof
      // test suite):
      //   - Synchronous throws from `warmStorageCacheImpl` are caught here.
      //   - Async rejections are caught via the inner `.catch`.
      //   - In neither case does the commit step's success/failure semantics
      //     change. The user-visible commit result depends ONLY on the
      //     library DB writes above this line.
      //
      // The test suite asserts exactly one warmup invocation per source-job
      // commit, and that commit returns success even when the warmup
      // implementation throws synchronously OR rejects asynchronously.
      try {
        const token = resolveToken?.(input.userId) ?? "";
        const warmupPromise = warmStorageCacheImpl({
          produced,
          token,
          userId: input.userId,
          jobId: input.jobId,
        });
        // Detach: log async rejections without bubbling.
        void warmupPromise.catch(() => {
          /* fire-and-forget — see commentary above */
        });
      } catch {
        /* synchronous throw — see commentary above */
      }

      // Seek-bar previews (MPV-PREV-02): kicked, never awaited, so the video is playable without waiting on them.
      if (previewFormat) {
        void previewSheets.schedule({
          userId: input.userId,
          jobId: input.jobId,
          mediaId: input.mediaId,
          formatId: previewFormat.id,
          inputPath: input.filename,
          durationSeconds: previewFormat.durationSeconds,
          initKey: previewFormat.initKey,
        });
      }

      // Resolve episodeId for TV source-jobs so the commit step can address
      // skip-marker writes at the right `media_episodes` row. `linkFileToMedia`
      // ensures the episode row exists; we just look up its id here.
      const episodeId =
        input.season !== null &&
        input.season !== undefined &&
        input.episode !== null &&
        input.episode !== undefined
          ? ((await libraryDb.call("resolveEpisodeId", [
              input.mediaId,
              input.season,
              input.episode,
            ])) as string | null)
          : null;

      return { fileId, formatIds, episodeId };
    }

    // Format-job commit: register an additional mediaFormats row attached to
    // the parent source-job's committed file_id. The commit step handler
    // looks up the parent file_id via deps.lookupParentSourceFileId and
    // threads it through input.sourceFileId. We fail loud here if it's
    // absent rather than substituting mediaId (which would FK-fail or store
    // a corrupt row — Bug #11).
    if (!input.sourceFileId) {
      throw new Error(
        "STEP_COMMIT_FORMAT_MISSING_SOURCE_FILE_ID — format-job commit requires the parent source job's media_files.id"
      );
    }
    const sourceFileId = input.sourceFileId;
    const formatIds: string[] = [];
    const duplicateKeys: string[] = [];
    // Idempotent per (file_id, quality): media_formats has no unique index
    // on that pair and addMediaFormat is a plain INSERT. A retried commit
    // step, or a fallback job whose quality equals the source's, would
    // otherwise add a second row for a quality the file already has.
    // Reuse the committed row instead and release the duplicate's uploads
    // (#2438): no library row names them, so deleting the media could not
    // free them and they counted against the user's space until the GC.
    const committedForFile = (
      ((await libraryDb.call("listMediaFormats", [input.mediaId])) as Array<{
        id: string;
        fileId: string;
        quality: string;
      }> | null) ?? []
    ).filter((row) => row.fileId === sourceFileId);
    for (const format of produced.videoFormats) {
      const existing = committedForFile.find((row) => row.quality === format.quality);
      if (existing) {
        console.warn(
          JSON.stringify({
            event: "badger.deps.commit.format_exists",
            jobId: input.jobId,
            mediaId: input.mediaId,
            fileId: sourceFileId,
            quality: format.quality,
            existingFormatId: existing.id,
            orphanedChunkCount: format.chunks.length,
          })
        );
        formatIds.push(existing.id);
        duplicateKeys.push(format.initKey, ...format.chunks.map((chunk) => chunk.key));
        continue;
      }
      const sizeMb = Math.max(1, Math.round(format.totalSize / (1024 * 1024)));
      const bitrateKbps =
        format.durationSeconds && format.durationSeconds > 0
          ? Math.round((format.totalSize * 8) / 1000 / format.durationSeconds)
          : null;
      const formatId = (await libraryDb.call("addMediaFormat", [
        input.mediaId,
        sourceFileId,
        format.quality,
        format.codec,
        sizeMb,
        format.chunks,
        bitrateKbps,
        {
          codecString: format.codecString ?? null,
          initKey: format.initKey,
          initSize: format.initSize,
          durationSeconds: format.durationSeconds ?? null,
          totalSize: format.totalSize,
        },
      ])) as string;
      formatIds.push(String(formatId));
    }
    await releaseDuplicateFormatKeys(input, duplicateKeys);
    // Round-13 #2: warm the new variant's chunk keys too. Format-scope
    // commits are typically the 360p fallback; the user may switch to that
    // variant immediately after the source variant's launch-stalled timer
    // fires, so warming its leading chunks pre-empts a second cold-cache
    // tax on the fallback path. Same fire-and-forget guarantees as above.
    try {
      const token = resolveToken?.(input.userId) ?? "";
      const warmupPromise = warmStorageCacheImpl({
        produced,
        token,
        userId: input.userId,
        jobId: input.jobId,
      });
      void warmupPromise.catch(() => {
        /* fire-and-forget — see source-scope commentary */
      });
    } catch {
      /* synchronous throw — see source-scope commentary */
    }
    return { fileId: sourceFileId, formatIds };
  };

  const markMediaPlayable: BadgerStepDeps["markMediaPlayable"] = async (
    mediaId: string
  ) => {
    await libraryDb.call("markMediaPlayable", [mediaId]);
  };

  const lookupParentSourceFileId: BadgerStepDeps["lookupParentSourceFileId"] =
    engine
      ? async (parentSourceJobId: string): Promise<string | null> => {
          const found = await engine.get(parentSourceJobId);
          if (!found) return null;
          const commitStep = found.steps.find((s) => s.kind === "commit");
          if (!commitStep) return null;
          const commitResult = (commitStep.outputs as Record<string, unknown>)
            .commitResult as { fileId?: unknown } | undefined;
          if (!commitResult || typeof commitResult.fileId !== "string") {
            return null;
          }
          return commitResult.fileId;
        }
      : undefined;

  const lookupJobPlacementId: BadgerStepDeps["lookupJobPlacementId"] = engine
    ? async (jobId: string): Promise<string | null> => {
        const found = await engine.get(jobId);
        const placementId = found?.job.payload.placementId;
        return typeof placementId === "string" && isValidPlacementId(placementId) ? placementId : null;
      }
    : undefined;

  const persistJobPlacementId: BadgerStepDeps["persistJobPlacementId"] = engine
    ? async (jobId: string, placementId: string): Promise<void> => {
        await engine.updateJobPayload(jobId, { placementId });
      }
    : undefined;

  /**
   * Release what a cancelled job already pushed to storage. Its
   * `job_state.json` is the only record of those keys, so this runs BEFORE
   * the directory goes. A failed or impossible delete is logged with the keys
   * and left to the storage GC.
   *
   * Data safety first: the keys are released only when no committed library
   * row can be serving them. A job whose commit step ever started (the batch
   * may have landed its media_formats row before the process died), an
   * unknown mediaId, a library that cannot be read, or any uploaded key the
   * library references for the media all release NOTHING.
   */
  const releaseUploadedObjects = async (
    input: DiscardJobOutputsInput,
    dir: string
  ): Promise<void> => {
    const logBase = { reason: input.reason, jobId: input.jobId, userId: input.userId, mediaId: input.mediaId ?? null };
    let keys: string[];
    try {
      keys = readUploadedKeysFromState(dir);
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "badger.deps.discard.release_skipped",
          ...logBase,
          cause: "job_state_unreadable",
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return;
    }
    if (keys.length === 0) return;
    if (!opts.deleteStorageKeys) {
      console.warn(
        JSON.stringify({ event: "badger.deps.discard.release_skipped", ...logBase, cause: "no_delete_hook", keys })
      );
      return;
    }
    if (input.commitStarted) {
      console.info(
        JSON.stringify({ event: "badger.deps.discard.release_skipped", ...logBase, cause: "commit_started", keys: keys.length })
      );
      return;
    }
    if (!input.mediaId) {
      console.warn(
        JSON.stringify({ event: "badger.deps.discard.release_skipped", ...logBase, cause: "media_unknown", keys: keys.length })
      );
      return;
    }
    const waitCtx = {
      stage: "discard",
      userId: input.userId,
      jobId: input.jobId,
      signal: new AbortController().signal,
    };
    if (!(await awaitLibraryDbOpen(waitCtx))) {
      console.warn(
        JSON.stringify({ event: "badger.deps.discard.release_skipped", ...logBase, cause: "library_not_open", keys: keys.length })
      );
      return;
    }
    let committedKeys: Set<string>;
    try {
      const listed = (await libraryDb.call("getMediaObjectKeys", [input.mediaId])) as unknown;
      committedKeys = new Set(Array.isArray(listed) ? listed.map(String) : []);
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "badger.deps.discard.release_skipped",
          ...logBase,
          cause: "library_lookup_failed",
          keys: keys.length,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return;
    }
    const referenced = keys.filter((key) => committedKeys.has(key));
    if (referenced.length > 0) {
      console.info(
        JSON.stringify({
          event: "badger.deps.discard.release_skipped",
          ...logBase,
          cause: "committed_format",
          keys: keys.length,
          referencedKeys: referenced.slice(0, 10),
          referencedCount: referenced.length,
        })
      );
      return;
    }
    const token = await awaitToken(waitCtx);
    if (!token) {
      console.warn(
        JSON.stringify({ event: "badger.deps.discard.release_skipped", ...logBase, cause: "no_token", keys })
      );
      return;
    }
    const batchSize = 100;
    let deleted = 0;
    let reclaimedBytes = 0;
    const failedKeys: string[] = [];
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      try {
        const result = await opts.deleteStorageKeys(token, batch);
        deleted += result.deleted;
        reclaimedBytes += result.reclaimedBytes;
      } catch (err) {
        failedKeys.push(...batch);
        console.warn(
          JSON.stringify({
            event: "badger.deps.discard.release_failed",
            ...logBase,
            keys: batch,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }
    console.info(
      JSON.stringify({
        event: "badger.deps.discard.released",
        ...logBase,
        keys: keys.length,
        deleted,
        reclaimedBytes,
        failedKeys: failedKeys.length,
      })
    );
  };

  const discardJobOutputs: BadgerStepDeps["discardJobOutputs"] = async (input) => {
    const dir = resolveJobDir(input.userId, input.jobId);
    await releaseUploadedObjects(input, dir);
    // P26: every removal of an encode outputs tree is logged with its reason.
    console.info("[badger.deps] removing transcode dir", {
      reason: input.reason,
      jobId: input.jobId,
      dir,
    });
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn("[badger.deps] transcode dir removal failed", {
        reason: input.reason,
        jobId: input.jobId,
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const removeJobDir: BadgerStepDeps["removeJobDir"] = async (input) => {
    const dir = resolveJobDir(input.userId, input.jobId);
    const keyPrefix = `${input.userId}::${input.jobId}::`;
    for (const key of [...producedCache.keys()]) {
      if (key.startsWith(keyPrefix)) producedCache.delete(key);
    }
    const bytes = await dirSizeBytes(dir);
    console.info("[badger.deps] removing transcode dir", {
      reason: input.reason,
      jobId: input.jobId,
      dir,
      bytes,
    });
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn("[badger.deps] transcode dir removal failed", {
        reason: input.reason,
        jobId: input.jobId,
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const runLibraryBatch: BadgerStepDeps["runLibraryBatch"] = async <T,>(
    label: string,
    fn: () => Promise<T>,
    readyWait?: LibraryReadyWait
  ): Promise<T> => {
    // libraryDb.runBatch throws LIBRARY_DB_NOT_OPEN up front on a closed DB,
    // BEFORE `fn` (and the commit dep's own wait) ever runs — so a job
    // resumed at boot failed terminally 0.4-0.9 s before the desktop's
    // library re-open landed (#25 P3). Wait here, in front of the batch.
    if (readyWait) await requireLibraryDbOpenForCommit(readyWait);
    return libraryDb.runBatch(label, fn);
  };

  const getLibraryVersion: BadgerStepDeps["getLibraryVersion"] = () =>
    libraryDb.getVersion();

  const replaceSkipMarkers: BadgerStepDeps["replaceSkipMarkers"] = async (
    mediaId: string,
    episodeId: string | null,
    markers: BadgerIngestSkipMarker[]
  ): Promise<void> => {
    await libraryDb.replaceSkipMarkers(mediaId, episodeId, markers);
  };

  const upsertShowSkipCache: BadgerStepDeps["upsertShowSkipCache"] = async (
    showMediaId: string,
    payload: BadgerIngestShowSkipCache
  ): Promise<void> => {
    await libraryDb.upsertShowSkipCache(showMediaId, payload);
  };

  const listExistingEpisodeIds: BadgerStepDeps["listExistingEpisodeIds"] =
    async (showMediaId: string): Promise<Map<string, string>> => {
      return libraryDb.listExistingEpisodeIds(showMediaId);
    };

  return {
    probe,
    identify,
    extractSource,
    transcodeFormat,
    retranscodeFormat,
    uploadOutputs,
    commit,
    markMediaPlayable,
    runLibraryBatch,
    getLibraryVersion,
    lookupParentSourceFileId,
    lookupJobPlacementId,
    persistJobPlacementId,
    discardJobOutputs,
    removeJobDir,
    replaceSkipMarkers,
    upsertShowSkipCache,
    listExistingEpisodeIds,
    resumePreviewSheets: previewSheets.resume,
    runPreviewSheetsCatchUp: previewSheets.runCatchUp,
    queuedPreviewImportFormatIds: previewSheets.queuedImportFormatIds,
    stopPreviewSheets: () => {
      previewShutdown.abort();
      previewSheets.stop();
    },
  };
}
