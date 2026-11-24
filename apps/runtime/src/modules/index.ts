import type { RuntimeCommandContext, RuntimeCommandRequest, RuntimeCommandResponse, RuntimeErrorCode } from "../types";
import type { AppId } from "../types";
import { parseRuntimeJobId, type ParsedRuntimeJobId } from "@space/runtime-jobs";
import type { RuntimeJobFilter, RuntimeJobRecord } from "@space/runtime-jobs";
import { BadgerModule } from "./badger";
import type { LibraryClosedListener } from "./badgerLibraryDb";
import type { EngineV2 } from "../core/jobs/engineV2";
import {
  createBadgerIngestSubmitHandler,
  createBadgerIngestAttachMetadataHandler,
  createBadgerIngestPlanOutputsHandler,
} from "./badger/ingestSubmit";
import { createBadgerMediaReplanQualitiesHandler } from "./badger/mediaReplan";
import {
  createBadgerOfflineEstimateHandler,
  createBadgerOfflineSubmitHandler,
  createBadgerOfflineDeleteHandler,
  createBadgerOfflineListHandler,
  createBadgerOfflineReconcileHandler,
  sweepOrphanedStagingDirs,
  type BadgerOfflineHandlerDeps,
} from "./badger/offlineDownload";
import { migrateLegacyOfflineFiles } from "./badger/offlineMigration";
import {
  badgerIngestSubmitSources,
  badgerIngestAttachMetadata,
  badgerIngestPlanOutputs,
  badgerIngestConfigureScheduling,
  badgerMediaReplanQualities,
} from "@space/runtime-contracts/badger/ingest";
import {
  badgerOfflineEstimateSize,
  badgerOfflineDownloadSubmit,
  badgerOfflineDeleteLocal,
  badgerOfflineListLocal,
  badgerOfflineReconcile,
} from "@space/runtime-contracts/badger/offline";
import { badgerExportEstimate, badgerExportSubmit } from "@space/runtime-contracts/badger/export";
import { createBadgerExportEstimateHandler, createBadgerExportSubmitHandler } from "./badger/export";
import {
  badgerPreviewsGetCatchUp,
  badgerPreviewsGetStatus,
  badgerPreviewsRetryCatchUp,
  badgerPreviewsSetCatchUpVideo,
} from "@space/runtime-contracts/badger/previews";
import {
  configureBadgerOfflineDeps,
  createOfflineAwaitCredentials,
  createOfflineDownloadObject,
  offlineDefaultDecrypt,
} from "./badger/offlineDownloadDeps";
import { parsePayload } from "@space/runtime-contracts/helpers";
import { join as joinPath } from "node:path";
import { getDesktopPlatform } from "@space/desktop-platform";
import { runtimeJobsStore } from "../core/jobs/store";
import { syncRuntimeJobsFromModuleCommand, syncRuntimeJobsFromModuleEvent } from "../core/jobs/adapters";
import { runtimeJobEngine } from "../core/jobs/engine";
import { getHostRuntimeSchedulerPolicy } from "../core/jobs/scheduler";
import {
  buildBadgerRuntimeJobMutation,
  buildRuntimeJobMutationRequestId,
} from "../core/jobs/mutations";
import {
  configureBadgerStepDeps,
  configureBadgerStepDepsFactory,
  getBadgerStepDeps,
  __resetBadgerStepDeps,
} from "./badger/steps/deps";
import { buildBadgerStepDeps, resolveTranscodeRoot } from "./badger/steps/deps-adapter";
import {
  processBadgerMediaJob,
  produceBadgerMediaOutputs,
  uploadBadgerProducedMedia,
  downloadAndDecryptBadgerObject,
  probeBadgerBackend,
  uploadEncryptedBadgerFile,
} from "./badgerIngest";
import { createSubtitleOcrWorker, type SubtitleOcrWorker } from "./badger/subtitleOcrWorker";
import { createPreviewSheetsCatchUp, type PreviewCatchUp } from "./badger/previewSheetsCatchUp";
import { uploadPlaybackGate } from "@space/content-core/storageTransport";
import { ocrPictureSubtitleFile } from "@space/ingest-core/subtitleOcr";
import { tmpdir } from "node:os";
import { createRuntimeContentStorageBridge, resolveRuntimeContentApiBaseUrl } from "../core/content/storageBridge";
import { deleteStorageObjects } from "@space/library-db-runtime/api";
import {
  getEngineV2BootStatus,
  resolveEngineV2UnavailableError,
} from "../core/jobs/engineV2BootStatus";

export type ModuleCommandResult = {
  response: RuntimeCommandResponse;
  event?: {
    channel: string;
    event: string;
    payload: Record<string, unknown>;
  };
};

export type ModuleEventPublisher = (
  module: RuntimeCommandRequest["module"],
  channel: string,
  event: string,
  payload: Record<string, unknown>
) => void;

type RuntimeJobMutationResult = {
  job: RuntimeJobRecord | null;
  app: AppId | null;
};

/**
 * Per-library offline dir: `SF_BADGER_OFFLINE_DIR` (the desktop main forwards
 * its userData) else `<runtime data dir>/offline`. Mirrors
 * apps/badger/desktop/src/main/playbackServer.ts's candidate roots.
 */
const resolveBadgerOfflineDir = (libraryId: string): string => {
  const root =
    process.env.SF_BADGER_OFFLINE_DIR?.trim() ||
    joinPath(getDesktopPlatform().paths.runtimeDataDir(process.env), "offline");
  return joinPath(root, String(libraryId).trim() || "default");
};

let libraryClosedListener: LibraryClosedListener | null = null;
let sessionChangedListener: (() => void) | null = null;
/** The badger module's options: a closed library tells the tool access manager through the settable listener. */
const badgerModuleDependencies = () => ({
  countUnfinishedEngineJobs: countUnfinishedBadgerEngineJobs,
  onLibraryClosed: ((reason) => libraryClosedListener?.(reason)) satisfies LibraryClosedListener,
  onLibraryOpened: (mode: "online" | "local") => {
    if (badgerEngineV2) void runOfflineLibraryMaintenance(badgerEngineV2, mode);
    // MPV-PREV-07: a re-open paused the skip catch-up; it resumes with the same video.
    previewCatchUp?.kick("library_opened");
  },
  onSessionChanged: () => sessionChangedListener?.(),
});
/** RT-JOBS-07: whether a job of `userId` belongs to the session's account (a job without a user always does). */
const sessionOwnsJob = (userId: string) => !userId || userId === badgerModuleState.current.getActiveIngestUserId();
/** The session's backend token for a job step; null for another account's job, whose step then waits for it. */
const sessionToken = (userId: string) => (sessionOwnsJob(userId) ? badgerModuleState.current.getActiveIngestToken() : null);
/** The session's library key for a job step; null for another account's job. */
const sessionLibraryKey = (userId: string) =>
  sessionOwnsJob(userId) ? badgerModuleState.current.getActiveLibraryKey() : null;
let badgerModule = new BadgerModule(badgerModuleDependencies());
let moduleEventPublisher: ModuleEventPublisher | null = null;

// ---------------------------------------------------------------------------
// Round 9 I2: globalThis-backed slot holding the LIVE `badgerModule`.
//
// Closures stored on the globalThis deps registry (round-8 H2 v2) capture the
// `badgerModule` *value* at registration time. When `bun --hot` re-evaluates
// this module, the local `badgerModule` binding rebinds to a new instance —
// but the factory closure still holds the old one. The new instance has no
// library-key wired, so the upload step throws `media_key_missing`.
//
// The slot identity from Symbol.for(...) is stable across re-evals; the
// `current` field is rewritten on every module evaluation (and on every
// `setBadgerModuleForTests` / `resetModulesForTests`). The factory captures
// `badgerModuleState`, never the underlying module — so it always sees the
// latest instance.
// ---------------------------------------------------------------------------
/** `/storage/delete` forward shared by the step deps (cancel cleanup) and replan. */
const deleteBadgerStorageKeys = async (token: string, keys: string[]) => {
  const result = await deleteStorageObjects(token, keys);
  return { deleted: result.deleted ?? 0, reclaimedBytes: result.reclaimedBytes ?? 0 };
};

const BADGER_MODULE_SLOT = Symbol.for("@space/runtime/badger-module/v1");
type BadgerModuleState = { current: BadgerModule };
const badgerModuleState: BadgerModuleState = (() => {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[BADGER_MODULE_SLOT] as BadgerModuleState | undefined;
  if (existing) return existing;
  const fresh: BadgerModuleState = { current: undefined as unknown as BadgerModule };
  g[BADGER_MODULE_SLOT] = fresh;
  return fresh;
})();
badgerModuleState.current = badgerModule;

const resolveRuntimeSchedulingPolicy = () => {
  const policy = getHostRuntimeSchedulerPolicy();
  const hostCpuConcurrency = policy.laneConcurrency.cpu;
  const maxParallelTranscodes = Math.max(1, Math.min(3, Math.trunc(badgerModule.getSchedulingHints().maxParallelTranscodes ?? 1)));
  policy.laneConcurrency.cpu = Math.min(policy.maxConcurrentJobs, hostCpuConcurrency, maxParallelTranscodes);
  policy.resourceLimits.cpuHeavy = policy.laneConcurrency.cpu;
  return policy;
};

const buildBadgerRuntimeJobStartRequest = (job: RuntimeJobRecord): RuntimeCommandRequest | null => {
  const parsed = parseRuntimeJobId(job.jobId);
  if (!parsed || parsed.app !== "badger") return null;
  const userId =
    typeof job.payload.userId === "string" && job.payload.userId.trim().length > 0
      ? job.payload.userId.trim()
      : parsed.ownerId;
  if (!userId || userId === "active") return null;
  return {
    requestId: `runtime-job-start:${job.jobId}:${Date.now()}`,
    module: "badger",
    command: "badger.ingest.apply",
    payload: {
      userId,
      actions: [
        {
          type: "start_job",
          jobId: parsed.rawId,
        },
      ],
    },
  };
};

const installRuntimeJobExecutors = () => {
  runtimeJobEngine.registerHandler(
    "badger.ingest.media_file",
    async (job) => {
      const request = buildBadgerRuntimeJobStartRequest(job);
      if (!request) {
        return {
          status: "failed",
          stageCode: "failed",
          stageLabel: "Failed",
          errorCode: "executor_payload_invalid",
          errorMessage: "Badger runtime job is missing a valid user scope",
          retryable: false,
        };
      }
      const executed = await badgerModule.execute(request);
      const response = executed.response;
      if (!response.ok) {
        return {
          status: "failed",
          stageCode: "failed",
          stageLabel: "Failed",
          errorCode: response.error.code,
          errorMessage: response.error.message,
          retryable: response.error.retryable,
          retryAfterMs: response.error.retryable ? 1_000 : null,
        };
      }
      syncRuntimeJobsFromModuleCommand(request, response);
      if (executed.event) {
        syncRuntimeJobsFromModuleEvent(request.module, executed.event.channel, executed.event.event, executed.event.payload);
      }
      const current = runtimeJobsStore.get(job.jobId);
      return current
        ? {
            status: current.status,
            stageCode: current.stageCode,
            stageLabel: current.stageLabel,
            progress: current.progress,
            outputs: current.outputs,
            errorCode: current.errorCode,
            errorMessage: current.errorMessage,
            retryable: current.retryable,
          }
        : {
            status: "running",
            stageCode: "running",
            stageLabel: "Running",
          };
    },
    {
      canRun: (job) => {
        const hasUserId = typeof job.payload.userId === "string" && job.payload.userId.trim().length > 0;
        if (!hasUserId) return false;
        if (job.stageCode === "ready" || job.stageCode === "waiting") {
          return typeof job.payload.matchedMediaId === "string" && job.payload.matchedMediaId.trim().length > 0;
        }
        if (job.stageCode === "queued" || job.stageCode === "retry_scheduled") {
          return typeof job.payload.filename === "string" && job.payload.filename.trim().length > 0;
        }
        return false;
      },
    }
  );
};

const installModuleEventPublisher = () => {
  if (!moduleEventPublisher) {
    badgerModule.setEventPublisher(null);
    return;
  }
  badgerModule.setEventPublisher((channel, event, payload) => {
    moduleEventPublisher?.("badger", channel, event, payload);
  });
};
installModuleEventPublisher();
runtimeJobEngine.setPolicyResolver(resolveRuntimeSchedulingPolicy);
installRuntimeJobExecutors();

const error = (
  requestId: string,
  code: RuntimeErrorCode,
  message: string
): RuntimeCommandResponse => ({
  requestId,
  ok: false,
  result: null,
  error: {
    code,
    message,
    retryable: false,
    details: {},
  },
});

// ---------------------------------------------------------------------------
// Phase D engineV2 binding. The runtime bootstrap calls
// `setEngineV2ForBadgerIngest(engine)` after constructing engineV2; if the
// flag is off the binding stays null and the new commands return a clean
// "not_enabled" error so external probes get a deterministic signal.
// ---------------------------------------------------------------------------
let badgerEngineV2: EngineV2 | null = null;
// Read at call time (function declaration, so the BadgerModule constructed
// above can hold it before the engine binding exists). The background storage
// GC stands down while any of these jobs exist: their uploaded objects are not
// in the library snapshot until their commit step runs.
async function countUnfinishedBadgerEngineJobs(): Promise<number> {
  const engine = badgerEngineV2;
  if (!engine) return 0;
  const { jobs } = await engine.list({
    app: "badger",
    kind: ["source", "format"],
    status: ["queued", "running", "interrupted"],
  });
  return jobs.length;
}
/**
 * PLAY-TRACK-05: the subtitle OCR worker (text twins of picture subtitles for
 * the Android TV). Shipped on; `SF_SUBTITLE_OCR=0` turns it off. Started with
 * the engine wiring, kicked by every commit that wrote a picture subtitle.
 */
let subtitleOcrWorker: SubtitleOcrWorker | null = null;
const startSubtitleOcrWorker = () => {
  void subtitleOcrWorker?.stop();
  subtitleOcrWorker = null;
  if (process.env.SF_SUBTITLE_OCR?.trim() === "0") {
    console.info(`[subtitle-ocr] worker.disabled ${JSON.stringify({ env: "SF_SUBTITLE_OCR=0" })}`);
    return;
  }
  const ffprobeRaw = process.env.SF_FFPROBE_PATH?.trim();
  subtitleOcrWorker = createSubtitleOcrWorker({
    libraryDb: badgerModuleState.current.libraryDbService,
    resolveToken: () => badgerModuleState.current.getActiveIngestToken(),
    resolveLibraryKey: () => badgerModuleState.current.getActiveLibraryKey(),
    downloadObject: downloadAndDecryptBadgerObject,
    uploadFile: uploadEncryptedBadgerFile,
    ocrFile: ocrPictureSubtitleFile,
    countBusyIngestJobs: countUnfinishedBadgerEngineJobs,
    langDir: joinPath(getDesktopPlatform().paths.runtimeDataDir(process.env), "ocr", "tessdata"),
    langDataBaseUrl: resolveRuntimeContentApiBaseUrl(),
    workDir: joinPath(tmpdir(), "spacefleet-subtitle-ocr"),
    ffprobePath: ffprobeRaw && ffprobeRaw !== "undefined" && ffprobeRaw !== "null" ? ffprobeRaw : undefined,
    log: (event, payload) => console.info(`${event} ${JSON.stringify(payload)}`),
  });
  subtitleOcrWorker.start();
};

/**
 * MPV-PREV-03: the seek-bar preview catch-up pass for the videos already in the signed-in user's library. Shipped
 * on; `SF_PREVIEW_CATCH_UP=0` turns it off. Started with the engine wiring, kicked once the pending import runs of
 * a previous start were re-queued, and a few seconds after the player closes (the playback lease going inactive).
 */
let previewCatchUp: PreviewCatchUp | null = null;
let unsubscribePreviewCatchUpPlayback: (() => void) | null = null;
const stopPreviewCatchUp = () => {
  unsubscribePreviewCatchUpPlayback?.();
  unsubscribePreviewCatchUpPlayback = null;
  void previewCatchUp?.stop();
  previewCatchUp = null;
};
const startPreviewCatchUp = () => {
  stopPreviewCatchUp();
  if (process.env.SF_PREVIEW_CATCH_UP?.trim() === "0") {
    console.info(`[preview-catch-up] worker.disabled ${JSON.stringify({ env: "SF_PREVIEW_CATCH_UP=0" })}`);
    return;
  }
  const startDelayRaw = Number(process.env.SF_PREVIEW_CATCH_UP_START_DELAY_MS);
  previewCatchUp = createPreviewSheetsCatchUp({
    libraryDb: badgerModuleState.current.libraryDbService,
    runCatchUp: async (job, options) => {
      const run = getBadgerStepDeps().runPreviewSheetsCatchUp;
      if (!run) throw new Error("PREVIEW_CATCH_UP_NOT_WIRED");
      return run(job, options);
    },
    resolveUserId: () => badgerModuleState.current.getActiveIngestUserId(),
    resolveToken: () => badgerModuleState.current.getActiveIngestToken(),
    resolveLibraryKey: () => badgerModuleState.current.getActiveLibraryKey(),
    countBusyIngestJobs: countUnfinishedBadgerEngineJobs,
    isPlaybackActive: () => uploadPlaybackGate.getState().playbackActive,
    downloadObject: downloadAndDecryptBadgerObject,
    // A video with no init object has nothing stored to head; its run's own uploads still classify an outage.
    probeBackend: async (token, objectKey) => {
      if (objectKey) await probeBadgerBackend(token, objectKey);
    },
    queuedImportFormatIds: () => getBadgerStepDeps().queuedPreviewImportFormatIds?.() ?? [],
    stateRoot: resolveTranscodeRoot,
    log: (event, payload) => console.info(`${event} ${JSON.stringify(payload)}`),
    startDelayMs: Number.isFinite(startDelayRaw) && startDelayRaw >= 0 ? startDelayRaw : undefined,
  });
  previewCatchUp.start();
  const catchUp = previewCatchUp;
  unsubscribePreviewCatchUpPlayback = uploadPlaybackGate.subscribe(() =>
    catchUp.playbackChanged(uploadPlaybackGate.getState().playbackActive)
  );
};

export const setEngineV2ForBadgerIngest = (engine: EngineV2 | null) => {
  badgerEngineV2 = engine;
  if (!engine) {
    __resetBadgerStepDeps();
    void subtitleOcrWorker?.stop();
    subtitleOcrWorker = null;
    stopPreviewCatchUp();
    return;
  }
  startSubtitleOcrWorker();
  startPreviewCatchUp();
  // Wire the BadgerStepDeps registry to the legacy ingestion helpers + the
  // active BadgerModule's libraryDb. Read through `badgerModuleState.current`
  // (round-9 I2) — never capture `badgerModule` directly. After a `bun --hot`
  // reload of this module, the local `badgerModule` binding rebinds to a new
  // instance; the slot identity stays the same and `current` is rewritten at
  // module-eval time, so this closure always sees the live instance.
  // Phase F split: wire BOTH `produceMediaOutputs` (encode-only) AND
  // `uploadProducedMedia` (upload-only) so the engineV2 lane model is
  // honest end-to-end. The legacy `processMediaJob` is kept as a fallback
  // for tests that haven't migrated to the split injection — production
  // takes the split path because both new hooks are provided.
  configureBadgerStepDeps(
    buildBadgerStepDeps({
      libraryDb: badgerModuleState.current.libraryDbService,
      processMediaJob: processBadgerMediaJob,
      produceMediaOutputs: produceBadgerMediaOutputs,
      uploadProducedMedia: uploadBadgerProducedMedia,
      downloadAndDecryptObject: downloadAndDecryptBadgerObject,
      resolveToken: sessionToken,
      resolveLibraryKey: sessionLibraryKey,
      resolveActiveUserId: () => badgerModuleState.current.getActiveIngestUserId(),
      deleteStorageKeys: deleteBadgerStorageKeys,
      onPictureSubtitlesCommitted: () => subtitleOcrWorker?.kick("import"),
      engine,
    })
  );
  // Seek-bar preview runs a stopped or crashed runtime left pending (MPV-PREV-02, RT-LIFE-04): their cut work dirs
  // are removed and the runs re-queued in the background; each waits (bounded) for the session to come back.
  void getBadgerStepDeps()
    .resumePreviewSheets?.()
    .catch((err: unknown) => console.warn("[preview-sheets] resume failed", err instanceof Error ? err.message : String(err)))
    .finally(() => previewCatchUp?.kick("resume"));
  // Round 8 H2: register the SAME inputs as a factory so getBadgerStepDeps()
  // can lazy-rebuild after `bun --hot` reloads deps.ts and resets the
  // `configured` singleton. Round 9 I2: factory reads via
  // `badgerModuleState.current` so a re-eval of this module (which rebinds
  // the local `badgerModule`) doesn't leave the closure pointing at a dead
  // instance. The slot ref is stable; `.current` is the live module.
  configureBadgerStepDepsFactory(() =>
    buildBadgerStepDeps({
      libraryDb: badgerModuleState.current.libraryDbService,
      processMediaJob: processBadgerMediaJob,
      produceMediaOutputs: produceBadgerMediaOutputs,
      uploadProducedMedia: uploadBadgerProducedMedia,
      downloadAndDecryptObject: downloadAndDecryptBadgerObject,
      resolveToken: sessionToken,
      resolveLibraryKey: sessionLibraryKey,
      resolveActiveUserId: () => badgerModuleState.current.getActiveIngestUserId(),
      deleteStorageKeys: deleteBadgerStorageKeys,
      onPictureSubtitlesCommitted: () => subtitleOcrWorker?.kick("import"),
      engine,
    })
  );

  // Phase 2 (offline downloads). Same `globalThis`-slot pattern via
  // `configureBadgerOfflineDeps`. The wiring stays alive across HMR re-evals
  // because the slot is keyed on `Symbol.for(...)`. The storage bridge is
  // app-scoped to badger (matches the rest of the runtime's badger work).
  const offlineStorageBridge = createRuntimeContentStorageBridge("badger");
  configureBadgerOfflineDeps({
    awaitCredentials: createOfflineAwaitCredentials({
      resolveToken: () => badgerModuleState.current.getActiveIngestToken(),
      resolveLibraryKey: () => badgerModuleState.current.getActiveLibraryKey(),
    }),
    downloadObject: createOfflineDownloadObject(offlineStorageBridge),
    traffic: offlineStorageBridge.traffic,
    decrypt: offlineDefaultDecrypt,
    resolveOfflineDir: resolveBadgerOfflineDir,
    resolveFfmpegPath: () => {
      const raw = process.env.SF_FFMPEG_PATH?.trim();
      if (!raw || raw === "undefined" || raw === "null") return undefined;
      return raw;
    },
    registerLocalDownload: async (input) => {
      return badgerModuleState.current.libraryDbService.registerLocalDownload(input);
    },
  });
  // The engine may come up after the library opened: check the offline copies now too (no migration: whether the
  // network is up is only known from how the library opened).
  void runOfflineLibraryMaintenance(engine, null);
};

let offlineMaintenanceChain: Promise<void> = Promise.resolve();
/**
 * Offline copies check, best-effort, once the library DB is open (on open, or on the engine wiring if the library
 * opened first): drop rows whose pieces are gone (reconcile), sweep `.tmp-*` staging dirs of older builds, `.part`
 * leftovers and pieces no item lists (OFFL-SAFE-01), then, on an online open, re-save old plain files as pieces
 * (OFFL-MIGR-01). Runs one after the other; a repeat is harmless (the migration skips files already being re-saved).
 */
const runOfflineLibraryMaintenance = (engine: EngineV2, mode: "online" | "local" | null): Promise<void> => {
  offlineMaintenanceChain = offlineMaintenanceChain.then(async () => {
    if (!badgerModuleState.current.libraryDbService.isOpen()) return;
    const deps = buildOfflineHandlerDeps(engine);
    try {
      const result = await createBadgerOfflineReconcileHandler(deps)({});
      console.info(`[badger.offline] library-open reconcile complete: dropped=${result.dropped.length}`);
    } catch (err) {
      console.warn("[badger.offline] library-open reconcile failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    try {
      const sweep = await sweepOrphanedStagingDirs({ engine, resolveOfflineDir: deps.resolveOfflineDir });
      console.info("[badger.offline] library-open sweep complete", sweep);
    } catch (err) {
      console.warn("[badger.offline] library-open sweep failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    if (mode !== "online") {
      console.info(`[badger.offline] migration of old plain files skipped: library opened ${mode ?? "before the engine"}`);
      return;
    }
    try {
      await migrateLegacyOfflineFiles(deps);
    } catch (err) {
      console.warn("[badger.offline] migration failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  });
  return offlineMaintenanceChain;
};

const engineV2NotEnabledResponse = (
  requestId: string
): RuntimeCommandResponse => {
  const reason =
    resolveEngineV2UnavailableError() ?? {
      error: "engine_v2_not_ready",
      message: "EngineV2 handler is missing despite ready boot status",
    };
  return error(requestId, "invalid_command", `${reason.error}: ${reason.message}`);
};

/**
 * Legacy badger ingest commands (`badger.ingest.apply`,
 * `badger.ingest.submit_sources`) flow through `processMediaJob` which is the
 * V2-aware path. When V2 is the required mode but the engine is not live
 * (boot failed, or explicitly disabled), short-circuit the request with a
 * loud error envelope so the renderer never sees a partial success.
 */
const isLegacyBadgerIngestCommand = (command: string): boolean =>
  command === "badger.ingest.apply";

const shouldShortCircuitLegacyBadgerIngest = (): boolean => {
  if (badgerEngineV2) return false;
  const status = getEngineV2BootStatus();
  // Only short-circuit when V2 was attempted and either opted out or
  // failed to boot. `not_booted` is the test/hosted state where the
  // bootstrap simply hasn't run yet — keep the legacy in-memory module
  // available so existing tests and the legacy ingest flow keep working.
  return status.state === "disabled" || status.state === "boot_failed";
};

const isV2BadgerIngestCommand = (command: string): boolean =>
  command === badgerIngestSubmitSources.name ||
  command === badgerIngestAttachMetadata.name ||
  command === badgerIngestPlanOutputs.name ||
  command === badgerIngestConfigureScheduling.name ||
  command === badgerMediaReplanQualities.name ||
  command === badgerOfflineEstimateSize.name ||
  command === badgerOfflineDownloadSubmit.name ||
  command === badgerOfflineDeleteLocal.name ||
  command === badgerOfflineListLocal.name ||
  command === badgerOfflineReconcile.name ||
  command === badgerExportEstimate.name ||
  command === badgerExportSubmit.name;

// Shared dep factory for the offline command handlers. All five
// `createBadgerOffline*Handler` functions take the same shape; building it
// once at dispatch time keeps the wiring trivial. The closure captures
// `badgerEngineV2` lazily — the V2 router guarantees the engine is non-null
// when this is invoked (see the `!badgerEngineV2` short-circuit below).
const buildOfflineHandlerDeps = (engine: EngineV2): BadgerOfflineHandlerDeps => ({
  engine,
  libraryDb: badgerModuleState.current.libraryDbService,
  resolveToken: () => badgerModuleState.current.getActiveIngestToken(),
  resolveLibraryKey: () => badgerModuleState.current.getActiveLibraryKey(),
  resolveOfflineDir: resolveBadgerOfflineDir,
});

const executeV2BadgerIngestCommand = async (
  request: RuntimeCommandRequest
): Promise<ModuleCommandResult> => {
  // `configure_scheduling` is graceful-by-design: when engineV2 is
  // unavailable (boot failed / disabled / not yet booted) the renderer's
  // mount-time settings sync should get a clean `{ applied: false }` rather
  // than an error envelope — there is nothing for the user to act on, the
  // caps simply default to DEFAULT_LANE_CAPS once the engine is up. This
  // branch therefore runs BEFORE the `!badgerEngineV2` error short-circuit
  // below.
  if (request.command === badgerIngestConfigureScheduling.name) {
    const parsed = parsePayload(badgerIngestConfigureScheduling, {
      payload: request.payload as Record<string, unknown>,
    });
    if (!parsed.ok) {
      return {
        response: error(request.requestId, "invalid_payload", parsed.error),
      };
    }
    if (!badgerEngineV2) {
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result: { applied: false },
          error: null,
        },
      };
    }
    const effective = badgerEngineV2.setLaneCaps({
      format: parsed.data.maxParallelTranscodes,
      source: parsed.data.maxParallelExtractions,
    });
    console.info("[ingest.configure_scheduling] applied", {
      requested: {
        format: parsed.data.maxParallelTranscodes,
        source: parsed.data.maxParallelExtractions,
      },
      effective: { format: effective.format, source: effective.source },
    });
    return {
      response: {
        requestId: request.requestId,
        ok: true,
        result: {
          applied: true,
          caps: {
            format: effective.format,
            source: effective.source,
          },
        },
        error: null,
      },
    };
  }
  if (!badgerEngineV2) {
    return { response: engineV2NotEnabledResponse(request.requestId) };
  }
  try {
    if (request.command === badgerIngestSubmitSources.name) {
      const handler = createBadgerIngestSubmitHandler({
        engine: badgerEngineV2,
      });
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
    if (request.command === badgerIngestAttachMetadata.name) {
      const handler = createBadgerIngestAttachMetadataHandler({
        engine: badgerEngineV2,
      });
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
    if (request.command === badgerIngestPlanOutputs.name) {
      const handler = createBadgerIngestPlanOutputsHandler({
        engine: badgerEngineV2,
      });
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
    if (request.command === badgerMediaReplanQualities.name) {
      const handler = createBadgerMediaReplanQualitiesHandler({
        engine: badgerEngineV2,
        libraryDb: badgerModuleState.current.libraryDbService,
        resolveActiveUserId: () =>
          badgerModuleState.current.getActiveIngestUserId(),
        deleteStorageKeys: async (keys) => {
          // Reuse the existing /storage/delete forward (same primitive
          // LibraryDb.deleteMedia uses). The token comes from the active
          // ingest user — same source as the rest of the engineV2 path.
          const token = badgerModuleState.current.getActiveIngestToken();
          if (!token) {
            // No token = defer to storage GC (matches deleteMedia's
            // fallback). Return zeros so the handler proceeds to drop the
            // library row.
            return { deleted: 0, reclaimedBytes: 0 };
          }
          return deleteBadgerStorageKeys(token, keys);
        },
      });
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
    // ---- badger.export.* (OFFL-FILE-01 / ACCT-EXPORT-01) ----
    if (request.command === badgerExportEstimate.name) {
      const parsed = parsePayload(badgerExportEstimate, { payload: request.payload as Record<string, unknown> });
      if (!parsed.ok) return { response: error(request.requestId, "invalid_payload", parsed.error) };
      const result = await createBadgerExportEstimateHandler(buildOfflineHandlerDeps(badgerEngineV2))(parsed.data);
      return { response: { requestId: request.requestId, ok: true, result, error: null } };
    }
    if (request.command === badgerExportSubmit.name) {
      const parsed = parsePayload(badgerExportSubmit, { payload: request.payload as Record<string, unknown> });
      if (!parsed.ok) return { response: error(request.requestId, "invalid_payload", parsed.error) };
      const result = await createBadgerExportSubmitHandler(buildOfflineHandlerDeps(badgerEngineV2))(parsed.data);
      return { response: { requestId: request.requestId, ok: true, result, error: null } };
    }
    // ---- badger.offline.* (Phase 2) ----
    if (request.command === badgerOfflineEstimateSize.name) {
      const handler = createBadgerOfflineEstimateHandler(
        buildOfflineHandlerDeps(badgerEngineV2)
      );
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
    if (request.command === badgerOfflineDownloadSubmit.name) {
      const handler = createBadgerOfflineSubmitHandler(
        buildOfflineHandlerDeps(badgerEngineV2)
      );
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
    if (request.command === badgerOfflineDeleteLocal.name) {
      const handler = createBadgerOfflineDeleteHandler(
        buildOfflineHandlerDeps(badgerEngineV2)
      );
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
    if (request.command === badgerOfflineListLocal.name) {
      const handler = createBadgerOfflineListHandler(
        buildOfflineHandlerDeps(badgerEngineV2)
      );
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
    if (request.command === badgerOfflineReconcile.name) {
      const handler = createBadgerOfflineReconcileHandler(
        buildOfflineHandlerDeps(badgerEngineV2)
      );
      const result = await handler(
        request.payload as Parameters<typeof handler>[0]
      );
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result,
          error: null,
        },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The 500/invalid_payload reply carries only the message; the stack is
    // otherwise lost (RT-LOG-01).
    console.error(
      `[runtime] v2 ingest command failed ${JSON.stringify({ command: request.command, requestId: request.requestId, message })}`,
      err instanceof Error ? err.stack : undefined
    );
    return {
      response: error(request.requestId, "invalid_payload", message),
    };
  }
  return {
    response: error(
      request.requestId,
      "invalid_command",
      `unsupported v2 ingest command ${request.command}`
    ),
  };
};

/**
 * MPV-PREV-06: `badger.previews.get_status`, asked by the desktop player for a video with no preview record yet:
 * whether the catch-up pass (MPV-PREV-03) still means to make them. Without a running pass nothing has given up.
 */
const executePreviewStatusCommand = (request: RuntimeCommandRequest): ModuleCommandResult => {
  const parsed = parsePayload(badgerPreviewsGetStatus, { payload: request.payload as Record<string, unknown> });
  if (!parsed.ok) return { response: error(request.requestId, "invalid_payload", parsed.error) };
  const { formatId } = parsed.data;
  const status = previewCatchUp?.previewStatus(formatId) ?? { state: "pending" as const, failures: 0, maxAttempts: 0 };
  const result = { formatId, ...status };
  console.info(`[preview-catch-up] status ${JSON.stringify({ ...result, worker: previewCatchUp !== null })}`);
  return { response: { requestId: request.requestId, ok: true, result, error: null } };
};

/**
 * MPV-PREV-07: `badger.previews.get_catch_up`, polled by the desktop Jobs tab ("Skip detection: N of M videos").
 * Without a running pass there is nothing to show: `done`, zeros.
 */
const executeCatchUpStatusCommand = async (request: RuntimeCommandRequest): Promise<ModuleCommandResult> => {
  const parsed = parsePayload(badgerPreviewsGetCatchUp, { payload: (request.payload ?? {}) as Record<string, unknown> });
  if (!parsed.ok) return { response: error(request.requestId, "invalid_payload", parsed.error) };
  const result = previewCatchUp
    ? await previewCatchUp.catchUpStatus()
    : { state: "done" as const, handled: 0, total: 0, current: null, failed: [], cancelled: [], videos: [], finishedAt: null };
  return { response: { requestId: request.requestId, ok: true, result, error: null } };
};

/** MPV-PREV-07: `badger.previews.retry_catch_up`, the Jobs card's "Try again" (one video, or all of them). */
const executeCatchUpRetryCommand = async (request: RuntimeCommandRequest): Promise<ModuleCommandResult> => {
  const parsed = parsePayload(badgerPreviewsRetryCatchUp, { payload: (request.payload ?? {}) as Record<string, unknown> });
  if (!parsed.ok) return { response: error(request.requestId, "invalid_payload", parsed.error) };
  const reset = previewCatchUp?.retry(parsed.data.formatId ?? null) ?? 0;
  return { response: { requestId: request.requestId, ok: true, result: { reset }, error: null } };
};

/** MPV-PREV-07: `badger.previews.set_catch_up_video`, a skip job's Cancel or Remove from history in the Jobs queue. */
const executeCatchUpSetVideoCommand = async (request: RuntimeCommandRequest): Promise<ModuleCommandResult> => {
  const parsed = parsePayload(badgerPreviewsSetCatchUpVideo, { payload: (request.payload ?? {}) as Record<string, unknown> });
  if (!parsed.ok) return { response: error(request.requestId, "invalid_payload", parsed.error) };
  const ok = previewCatchUp?.setVideo(parsed.data.formatId, parsed.data.action) ?? false;
  return { response: { requestId: request.requestId, ok: true, result: { ok }, error: null } };
};

export const executeModuleCommand = async (
  request: RuntimeCommandRequest,
  context: RuntimeCommandContext = { backendToken: null }
): Promise<ModuleCommandResult> => {
  if (request.module === "badger" && request.command === badgerPreviewsGetStatus.name) {
    return executePreviewStatusCommand(request);
  }
  if (request.module === "badger" && request.command === badgerPreviewsGetCatchUp.name) {
    return executeCatchUpStatusCommand(request);
  }
  if (request.module === "badger" && request.command === badgerPreviewsRetryCatchUp.name) {
    return executeCatchUpRetryCommand(request);
  }
  if (request.module === "badger" && request.command === badgerPreviewsSetCatchUpVideo.name) {
    return executeCatchUpSetVideoCommand(request);
  }
  if (request.module === "badger" && isV2BadgerIngestCommand(request.command)) {
    return executeV2BadgerIngestCommand(request);
  }
  if (
    request.module === "badger" &&
    isLegacyBadgerIngestCommand(request.command) &&
    shouldShortCircuitLegacyBadgerIngest()
  ) {
    return { response: engineV2NotEnabledResponse(request.requestId) };
  }
  if (request.module === "badger") return badgerModule.execute(request);

  return {
    response: error(
      request.requestId,
      "invalid_command",
      `No command handlers implemented for module ${request.module}`
    ),
  };
};

/** Runtime shutdown drain step (RT-LIFE-04): stops the Badger module and closes
 *  its library DB, flushing the pending cache persist that only `close()` writes. */
export const shutdownBadgerModule = () => {
  // Stop the catch-up pass (no next video starts), then the preview decode (its ffmpeg is aborted on every OS);
  // an import's run stays pending for the next start.
  stopPreviewCatchUp();
  try {
    getBadgerStepDeps().stopPreviewSheets?.();
  } catch {
    // Deps never configured (no engine wired): no preview run to stop.
  }
  return badgerModule.shutdown();
};

export const resetModulesForTests = () => {
  badgerModule.shutdown();
  badgerModule = new BadgerModule(badgerModuleDependencies());
  badgerModuleState.current = badgerModule;
  installModuleEventPublisher();
  installRuntimeJobExecutors();
};

export const setBadgerModuleForTests = (module: BadgerModule) => {
  badgerModule.shutdown();
  badgerModule = module;
  badgerModuleState.current = badgerModule;
  installModuleEventPublisher();
  installRuntimeJobExecutors();
};

/** The live badger library service, for the allowlisted tool operations (DEV-LIB-01). */
export const getBadgerLibraryDbService = () => badgerModuleState.current.libraryDbService;

/** The user whose library the runtime has open, or null when nobody is signed in (DEV-LIB-01 grants bind to it). */
export const getBadgerActiveUserId = () => badgerModuleState.current.getBackendUserId();

/** The account whose jobs may run now (RT-JOBS-07): the open ingest session's user, else the signed-in one. */
export const getBadgerSessionUserId = () => badgerModuleState.current.getActiveIngestUserId();

/** Run `listener` whenever the session's account changes (RT-JOBS-07: parked jobs of the new account may start). */
export const setBadgerSessionChangedListener = (listener: (() => void) | null) => {
  sessionChangedListener = listener;
};

/** Run `listener` whenever an open badger library is closed, with why (also when the module is replaced: "shutdown"). */
export const setBadgerLibraryClosedListener = (listener: LibraryClosedListener | null) => {
  libraryClosedListener = listener;
};

export const getModuleStateSummary = (app: RuntimeCommandRequest["module"]) => {
  if (app === "badger") return badgerModule.getStateSummary();
  return null;
};

export const setModuleEventPublisher = (publisher: ModuleEventPublisher | null) => {
  moduleEventPublisher = publisher;
  installModuleEventPublisher();
};

/**
 * Apply a (userId, masterKey [, backendToken]) tuple to the modules.
 *
 * `source` distinguishes the two call sites:
 * - `"replay"` is the startup replay over persisted keys in runtime.ts (no
 *   authenticated desktop, no live session). It MUST NOT stamp `backendUserId`
 *   because the persisted key store can hold multiple users (including
 *   leftover E2E fixtures). The last entry would win and silently impersonate
 *   the wrong user for any post-restart fallback. Library keys are applied
 *   regardless — they are per-user storage and the desktop narrows to its
 *   own user once it logs in.
 * - `"live"` is the /runtime/keys/set route, called only after the desktop
 *   has authenticated. The userId IS the active user, so stamp it.
 *
 * @bugfix all-newly-added-jobs-cuddly-cookie — Bug A
 */
export const onKeySet = (
  userId: string,
  masterKeyBase64: string,
  backendToken?: string,
  source: "replay" | "live" = "live",
) => {
  badgerModule.setLibraryKey(masterKeyBase64);
  if (backendToken) {
    badgerModule.setBackendToken(backendToken);
  }
  if (source === "live") {
    // Stamp the auth-attached user so post-ingest jobs (replan_qualities) can
    // resolve a userId without an active ingest session — see
    // badgerModule.getActiveIngestUserId fallback. Skipped during replay
    // because we cannot know which persisted entry corresponds to the
    // user who will authenticate next. Last: a changed user wakes that
    // account's parked jobs (RT-JOBS-07), which must find its token in place.
    badgerModule.setBackendUserId(userId);
  }
};

export const driveRuntimeJobsOnce = async (limit = 10) => {
  let ran = false;
  for (let index = 0; index < limit; index += 1) {
    const result = await runtimeJobEngine.runNext();
    if (!result) break;
    ran = true;
  }
  return ran;
};

export const reconcileActiveRuntimeJobsFromModules = async () => {
  const syncedJobs: RuntimeJobRecord[] = [];
  const hasBadgerJobs = runtimeJobsStore
    .list(
      {
        app: "badger",
        includeCompleted: true,
      },
      ["badger"]
    )
    .some((job) => job.kind === "badger.ingest.media_file" && job.status === "running");
  if (!hasBadgerJobs) return syncedJobs;

  const request: RuntimeCommandRequest = {
    requestId: `runtime-job-reconcile:${Date.now()}`,
    module: "badger",
    command: "badger.ingest.list_jobs",
    payload: {},
  };
  const executed = await badgerModule.execute(request);
  if (!executed.response.ok) return syncedJobs;
  syncedJobs.push(...syncRuntimeJobsFromModuleCommand(request, executed.response));
  if (executed.event) {
    syncRuntimeJobsFromModuleEvent(request.module, executed.event.channel, executed.event.event, executed.event.payload);
  }
  return syncedJobs;
};

export const listRuntimeJobs = async (filter: RuntimeJobFilter = {}, allowedApps: AppId[] | null = null) => {
  return runtimeJobsStore.list(filter, allowedApps);
};

export const getRuntimeJob = async (jobId: string, allowedApps: AppId[] | null = null) => {
  return runtimeJobsStore.get(jobId, allowedApps);
};

export const cancelRuntimeJob = async (
  jobId: string,
  allowedApps: AppId[] | null = null
): Promise<RuntimeJobMutationResult> => {
  const parsed = parseRuntimeJobId(jobId);
  if (!parsed) return { job: null, app: null };
  if (allowedApps && !allowedApps.includes(parsed.app)) return { job: null, app: parsed.app };
  const current = await getRuntimeJob(jobId, allowedApps);
  if (current?.status === "queued") {
    return {
      app: "badger",
      job: runtimeJobEngine.requestCancel(jobId),
    };
  }
  const request = buildBadgerRuntimeJobMutation("cancel", parsed, current);
  const executed = await badgerModule.execute(request);
  const response = executed.response;
  if (!response.ok) return { job: null, app: "badger" };
  syncRuntimeJobsFromModuleCommand(request, response);
  if (executed.event) {
    syncRuntimeJobsFromModuleEvent("badger", executed.event.channel, executed.event.event, executed.event.payload);
  }
  return {
    app: "badger",
    job: runtimeJobsStore.get(jobId, allowedApps),
  };
};

export const retryRuntimeJob = async (
  jobId: string,
  allowedApps: AppId[] | null = null
): Promise<RuntimeJobMutationResult> => {
  const parsed = parseRuntimeJobId(jobId);
  if (!parsed) return { job: null, app: null };
  if (allowedApps && !allowedApps.includes(parsed.app)) return { job: null, app: parsed.app };
  return {
    app: parsed.app,
    job: runtimeJobEngine.retry(jobId),
  };
};
