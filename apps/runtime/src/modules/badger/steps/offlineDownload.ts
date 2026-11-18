/**
 * Step: offline_download — fetch encrypted chunks for a media file, decrypt
 * them, concat per-track intermediate files, mux into a single MKV/MP4
 * container, atomic-rename to a human-readable filename under the user's
 * offline dir, and insert one `media_local_downloads` row.
 *
 * One step per file (not one per chunk). The step supports resume from
 * partial download via a `.resume.json` sidecar persisted inside the staging
 * dir after every successful chunk write. On cancellation OR failure the
 * staging dir + sidecar are LEFT INTACT so a retry can pick up where the
 * prior attempt stopped (skipping the storage-bridge fetch + decrypt for
 * any chunk whose orderIndex is in the sidecar). Only the explicit
 * `badger.offline.delete_local` path (different command) actively wipes
 * staging dirs.
 *
 * Sidecar shape (RESUME_SCHEMA_VERSION=1):
 *   {
 *     schemaVersion: 1,
 *     jobId: string,
 *     outputs: {
 *       [intermediateFilename]: {
 *         completedOrderIndices: number[],  // sorted ascending
 *         onDiskBytes: number,              // cumulative size after the
 *                                           // last appended chunk
 *       }
 *     }
 *   }
 *
 * Init segments (video + audio) are tracked as sentinel orderIndex = -1
 * because the manifest's `*InitKey` does not carry an explicit orderIndex.
 * Subtitles are single-object so they use orderIndex = 0.
 *
 * Stale-staging-dir sweep (orphans): if a `.tmp-<jobId>/` directory exists
 * but the engine has no non-terminal job with that jobId, the dir is an
 * orphan from a crashed prior process. Cleanup happens via the runtime
 * startup hook in `apps/runtime/src/modules/index.ts` (not this file).
 *
 * Lane: `upload` (network-heavy chunk downloads dominate; shares the upload
 * lane's budget with ingest upload work). See engineV2.ts `stepLaneFor`.
 *
 * Output shape (`step.outputs.downloadResult`):
 *   { localPath, totalBytes, container, skippedSubsForContainer: string[] }
 *
 * Honors abort: ctx.signal.aborted causes the loop to propagate a
 * `CANCELLED` Error up to engineV2 which CAS-marks the job cancelled. The
 * staging dir is preserved so retry can resume.
 *
 * Per-track stage labels emitted via `ctx.reportProgress`:
 *   - "Downloading video"
 *   - "Downloading audio (<lang>)"
 *   - "Downloading subtitles"
 *   - "Muxing tracks"
 *
 * Progress is held at <=95% during mux because `-c copy` is so fast there's
 * no meaningful intra-mux progress signal — the user sees a brief hold then
 * the final 100%.
 */

import { promises as fs } from "node:fs";
import { join as joinPath, dirname } from "node:path";
import crypto from "node:crypto";
import { runFfmpeg } from "@space/ffmpeg";
import type { StepHandler, StepHandlerCtx } from "../../../core/jobs/engineV2";
import { getBadgerOfflineDeps } from "../offlineDownloadDeps";
import { HELD_SATURATED_STAGE_CODE, SLOWED_HIGH_TRAFFIC_STAGE_CODE } from "@space/shared/storageTrafficStage";
import {
  HELD_SATURATED_STAGE_LABEL,
  SLOWED_HIGH_TRAFFIC_STAGE_LABEL,
  createSaturationGate,
  createSlowdownGate,
} from "../offlineTrafficGate";
import {
  buildOfflineFilename,
  sanitizeOfflineFilename,
  resolveOfflineFilenameCollision,
} from "@space/shared/offlineFilename";

// Stable extension for per-track intermediates. Container == "mkv" copies
// everything in; container == "mp4" needs `-c:s mov_text` for SRT/VTT and
// must skip ASS/PGS subs (recorded on outputs as skippedSubsForContainer).
const isPassthroughSubFormat = (raw: string | null | undefined): boolean => {
  const fmt = (raw ?? "").toLowerCase();
  return fmt === "srt" || fmt === "vtt" || fmt === "webvtt" || fmt === "ass" || fmt === "ssa" || fmt === "pgs" || fmt === "sup";
};

const isMp4CompatibleSub = (raw: string | null | undefined): boolean => {
  const fmt = (raw ?? "").toLowerCase();
  return fmt === "srt" || fmt === "vtt" || fmt === "webvtt";
};

const subtitleExtensionFor = (raw: string | null | undefined): string => {
  const fmt = (raw ?? "").toLowerCase();
  if (fmt === "vtt" || fmt === "webvtt") return "vtt";
  if (fmt === "ass" || fmt === "ssa") return "ass";
  if (fmt === "pgs" || fmt === "sup") return "sup";
  return "srt";
};

interface ManifestVideoChunk {
  key: string;
  sizeBytes: number;
  orderIndex: number;
}

interface ManifestAudioTrack {
  trackId: string;
  language: string;
  label: string;
  isDefault: boolean;
  initKey: string | null;
  initSize: number | null;
  chunks: ManifestVideoChunk[];
}

interface ManifestSubtitleTrack {
  subtitleId: string;
  language: string;
  label: string;
  format: string | null;
  objectKey: string;
  sizeBytes: number;
  isDefault: boolean;
}

interface OfflineDownloadManifest {
  videoInitKey: string | null;
  videoInitSize: number | null;
  videoChunks: ManifestVideoChunk[];
  audioTracks: ManifestAudioTrack[];
  subtitles: ManifestSubtitleTrack[];
  /** Source filename hint (used for buildOfflineFilename when title fallback). */
  filenameHint?: string | null;
  /** Movie/episode metadata that drives `buildOfflineFilename`. */
  filenameInputs:
    | {
        kind: "movie";
        title: string;
        year?: number | null;
      }
    | {
        kind: "episode";
        showTitle: string;
        seasonNumber: number;
        episodeNumber: number;
        episodeTitle?: string | null;
      };
}

const requireString = (
  payload: Record<string, unknown>,
  key: string,
  errorCode: string
): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(errorCode);
  }
  return value;
};

const requireNumber = (
  payload: Record<string, unknown>,
  key: string,
  errorCode: string
): number => {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(errorCode);
  }
  return value;
};

const requireManifest = (
  payload: Record<string, unknown>
): OfflineDownloadManifest => {
  const m = payload.manifest;
  if (!m || typeof m !== "object") {
    throw new Error("STEP_OFFLINE_DOWNLOAD_MISSING_MANIFEST");
  }
  return m as OfflineDownloadManifest;
};

const ensureNotAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error("CANCELLED");
};

const rmSilent = async (path: string) => {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[offline_download] best-effort rm failed for ${path}:`,
      err instanceof Error ? err.message : err
    );
  }
};

// ---------------------------------------------------------------------------
// Resume sidecar
//
// Filesystem-only per-staging-dir checkpoint so an interrupted download can
// pick up where it left off without re-fetching completed chunks. Lives at
// `<stagingDir>/.resume.json` and is rewritten atomically (`.tmp` + rename)
// after every successful chunk append. See the module-level docstring for
// the schema rationale.
// ---------------------------------------------------------------------------

export const RESUME_SCHEMA_VERSION = 1 as const;
export const RESUME_SIDECAR_NAME = ".resume.json";

/** Sentinel orderIndex used for init segments (video + audio). */
export const INIT_ORDER_INDEX = -1;

/** Sentinel orderIndex used for the single-object subtitle write. */
export const SUBTITLE_ORDER_INDEX = 0;

interface ResumeSidecarOutput {
  completedOrderIndices: number[];
  onDiskBytes: number;
}

interface ResumeSidecar {
  schemaVersion: typeof RESUME_SCHEMA_VERSION;
  jobId: string;
  outputs: Record<string, ResumeSidecarOutput>;
}

/** Build a fresh in-memory sidecar for a new run. */
const emptySidecar = (jobId: string): ResumeSidecar => ({
  schemaVersion: RESUME_SCHEMA_VERSION,
  jobId,
  outputs: {},
});

/**
 * Read and parse the sidecar at `<stagingDir>/.resume.json`. Returns null if
 * the file is missing, unreadable, fails JSON parse, has the wrong schema
 * version, or fails a structural shape check. Caller treats null as "no
 * usable resume state — start fresh".
 */
const readResumeSidecar = async (
  stagingDir: string
): Promise<ResumeSidecar | null> => {
  const sidecarPath = joinPath(stagingDir, RESUME_SIDECAR_NAME);
  try {
    const raw = await fs.readFile(sidecarPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== RESUME_SCHEMA_VERSION
    ) {
      console.warn(
        `[offline_download] resume sidecar schema mismatch at ${sidecarPath} — ignoring`
      );
      return null;
    }
    const obj = parsed as Partial<ResumeSidecar>;
    if (typeof obj.jobId !== "string" || !obj.outputs || typeof obj.outputs !== "object") {
      console.warn(
        `[offline_download] resume sidecar shape invalid at ${sidecarPath} — ignoring`
      );
      return null;
    }
    // Defensive: coerce each output entry to the expected shape and drop
    // any malformed entries silently.
    const sanitizedOutputs: Record<string, ResumeSidecarOutput> = {};
    for (const [k, v] of Object.entries(obj.outputs)) {
      if (!v || typeof v !== "object") continue;
      const o = v as Partial<ResumeSidecarOutput>;
      if (
        !Array.isArray(o.completedOrderIndices) ||
        typeof o.onDiskBytes !== "number" ||
        !Number.isFinite(o.onDiskBytes)
      ) continue;
      // Filter to numeric entries; sort ascending so callers can rely on
      // an ordered list when seeking through chunks.
      const idxs = (o.completedOrderIndices as unknown[])
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        .map(Number);
      idxs.sort((a, b) => a - b);
      sanitizedOutputs[k] = {
        completedOrderIndices: idxs,
        onDiskBytes: Number(o.onDiskBytes),
      };
    }
    return {
      schemaVersion: RESUME_SCHEMA_VERSION,
      jobId: obj.jobId,
      outputs: sanitizedOutputs,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(
        `[offline_download] resume sidecar read failed at ${sidecarPath} (code=${code ?? "?"}):`,
        err instanceof Error ? err.message : err
      );
    }
    return null;
  }
};

/**
 * Atomically rewrite the sidecar. Writes to `<stagingDir>/.resume.json.tmp`
 * first then renames; rename is atomic on POSIX and Windows for same-volume
 * targets, so a mid-rewrite crash never leaves a partial sidecar.
 */
const writeResumeSidecar = async (
  stagingDir: string,
  sidecar: ResumeSidecar
): Promise<void> => {
  const tmpPath = joinPath(stagingDir, `${RESUME_SIDECAR_NAME}.tmp`);
  const finalPath = joinPath(stagingDir, RESUME_SIDECAR_NAME);
  const payload = JSON.stringify(sidecar);
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, finalPath);
};

/**
 * Hydrate a `completedByOutput` map from a sidecar AND verify the on-disk
 * intermediate files match the recorded sizes. Three outcomes:
 *
 *   - `{ kind: "fresh" }` — staging dir doesn't exist or sidecar absent →
 *     callers start a brand-new run.
 *   - `{ kind: "resume", completedByOutput }` — sidecar parsed and the
 *     intermediates check out (sizes equal or exceed recorded — see below).
 *     If a file is OVER-sized (mid-flight crash that wrote some bytes after
 *     the last sidecar update), the file is `truncate()`d back to the
 *     recorded size so the next append continues from a known point.
 *   - `{ kind: "corrupt" }` — sidecar parsed but structural state doesn't
 *     match disk: missing intermediate file, under-sized file, etc.
 *     Callers wipe staging and start fresh.
 *
 * Logs generously: every decision branch prints a phase marker so resume
 * regressions are diagnosable from runtime.log alone.
 */
type HydrateResult =
  | { kind: "fresh" }
  | { kind: "resume"; completedByOutput: Map<string, Set<number>>; sidecar: ResumeSidecar }
  | { kind: "corrupt"; reason: string };

const hydrateResumeState = async (
  stagingDir: string,
  jobId: string
): Promise<HydrateResult> => {
  let stagingExists = false;
  try {
    const stat = await fs.stat(stagingDir);
    stagingExists = stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[offline_download] stat(${stagingDir}) failed during resume probe:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  if (!stagingExists) {
    console.info(`[offline_download] resume probe: no staging dir at ${stagingDir} — fresh run`);
    return { kind: "fresh" };
  }
  const sidecar = await readResumeSidecar(stagingDir);
  if (!sidecar) {
    console.info(
      `[offline_download] resume probe: staging dir exists at ${stagingDir} but sidecar missing/invalid — treating as corrupt`
    );
    return { kind: "corrupt", reason: "sidecar_missing_or_invalid" };
  }
  if (sidecar.jobId !== jobId) {
    console.info(
      `[offline_download] resume probe: sidecar jobId=${sidecar.jobId} does not match step jobId=${jobId} — treating as corrupt`
    );
    return { kind: "corrupt", reason: "jobid_mismatch" };
  }
  // Verify on-disk sizes for every recorded intermediate.
  const completedByOutput = new Map<string, Set<number>>();
  for (const [filename, info] of Object.entries(sidecar.outputs)) {
    const filePath = joinPath(stagingDir, filename);
    let stat: { size: number } | null = null;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(
          `[offline_download] resume sidecar references missing intermediate ${filePath} — corrupt`
        );
        return { kind: "corrupt", reason: `missing_intermediate:${filename}` };
      }
      console.warn(
        `[offline_download] stat(${filePath}) failed during resume verify:`,
        err instanceof Error ? err.message : err
      );
      return { kind: "corrupt", reason: `stat_failed:${filename}` };
    }
    if (stat.size < info.onDiskBytes) {
      console.warn(
        `[offline_download] intermediate ${filename} undersized (disk=${stat.size}, sidecar=${info.onDiskBytes}) — corrupt`
      );
      return { kind: "corrupt", reason: `undersized:${filename}` };
    }
    if (stat.size > info.onDiskBytes) {
      // Mid-flight crash mitigation: a chunk write resolved before the
      // sidecar rewrite could complete (or a partial write happened mid
      // process exit). Truncate back to the last known-good size.
      console.warn(
        `[offline_download] intermediate ${filename} oversize (disk=${stat.size}, sidecar=${info.onDiskBytes}) — truncating to recorded size`
      );
      try {
        await fs.truncate(filePath, info.onDiskBytes);
      } catch (err) {
        console.warn(
          `[offline_download] truncate(${filePath}, ${info.onDiskBytes}) failed:`,
          err instanceof Error ? err.message : err
        );
        return { kind: "corrupt", reason: `truncate_failed:${filename}` };
      }
    }
    completedByOutput.set(filename, new Set(info.completedOrderIndices));
  }
  console.info(
    `[offline_download] resume probe: hydrated jobId=${jobId} outputs=${completedByOutput.size}`
  );
  return { kind: "resume", completedByOutput, sidecar };
};

/**
 * Record a completed chunk in the sidecar and persist it. Updates the in-
 * memory `completedByOutput` map in lockstep so callers can re-check
 * "already done?" cheaply on the next iteration. The recorded `onDiskBytes`
 * is the cumulative size after this chunk; the sidecar rewrites atomically.
 */
const recordChunkCompleted = async (args: {
  stagingDir: string;
  sidecar: ResumeSidecar;
  completedByOutput: Map<string, Set<number>>;
  intermediateFilename: string;
  orderIndex: number;
  onDiskBytes: number;
}): Promise<void> => {
  const { stagingDir, sidecar, completedByOutput, intermediateFilename, orderIndex, onDiskBytes } = args;
  let entry = sidecar.outputs[intermediateFilename];
  if (!entry) {
    entry = { completedOrderIndices: [], onDiskBytes: 0 };
    sidecar.outputs[intermediateFilename] = entry;
  }
  if (!entry.completedOrderIndices.includes(orderIndex)) {
    entry.completedOrderIndices.push(orderIndex);
    entry.completedOrderIndices.sort((a, b) => a - b);
  }
  entry.onDiskBytes = onDiskBytes;
  let memoSet = completedByOutput.get(intermediateFilename);
  if (!memoSet) {
    memoSet = new Set();
    completedByOutput.set(intermediateFilename, memoSet);
  }
  memoSet.add(orderIndex);
  await writeResumeSidecar(stagingDir, sidecar);
};

/**
 * Stream-download a single object, decrypt it, write the plaintext bytes
 * (header-stripped) to the open file handle. Returns the total bytes written
 * (post-decryption, before any container framing).
 */
const downloadDecryptAndAppend = async (args: {
  signal: AbortSignal;
  token: string;
  libraryKeyBase64: string;
  objectKey: string;
  appendTo: fs.FileHandle;
  deps: ReturnType<typeof getBadgerOfflineDeps>;
}): Promise<number> => {
  ensureNotAborted(args.signal);
  const encrypted = await args.deps.downloadObject(args.token, args.objectKey);
  ensureNotAborted(args.signal);
  const plain = args.deps.decrypt(encrypted, args.libraryKeyBase64);
  ensureNotAborted(args.signal);
  await args.appendTo.write(plain);
  return plain.byteLength;
};

export const offlineDownloadStepHandler: StepHandler = async (stepCtx) => {
  ensureNotAborted(stepCtx.signal);
  let lastProgress: Parameters<StepHandlerCtx["reportProgress"]> | null = null;
  let held = false;
  let slowed = false;
  // A saturation hold (STOR-BW-09) takes precedence over a high-traffic slowdown (STOR-BW-01) as the shown stage; the
  // slowdown only paces fetches, so it replaces the downloading stage and not the local muxing / finalizing ones.
  const overrideStage = (code: string | undefined) =>
    held
      ? { label: HELD_SATURATED_STAGE_LABEL, code: HELD_SATURATED_STAGE_CODE }
      : slowed && (code === undefined || code === "downloading")
        ? { label: SLOWED_HIGH_TRAFFIC_STAGE_LABEL, code: SLOWED_HIGH_TRAFFIC_STAGE_CODE }
        : null;
  // Remember the last stage reported so it is shown again once the hold or the slowdown ends, and keep the
  // hold / slowdown stage shown while the download's own progress reports keep coming.
  const ctx: StepHandlerCtx = {
    ...stepCtx,
    reportProgress: (...args) => {
      lastProgress = args;
      const override = overrideStage(args[2]);
      if (override) stepCtx.reportProgress(args[0], override.label, override.code);
      else stepCtx.reportProgress(...args);
    },
  };
  const showStage = () => {
    const override = overrideStage(lastProgress?.[2]);
    if (override) stepCtx.reportProgress(lastProgress?.[0] ?? 1, override.label, override.code);
    else if (lastProgress) stepCtx.reportProgress(...lastProgress);
  };
  const baseDeps = getBadgerOfflineDeps();
  const payload = ctx.job.payload as Record<string, unknown>;
  const fileId = requireString(payload, "fileId", "STEP_OFFLINE_DOWNLOAD_MISSING_FILE_ID");
  const mediaId = requireString(payload, "mediaId", "STEP_OFFLINE_DOWNLOAD_MISSING_MEDIA_ID");
  const quality = requireString(payload, "quality", "STEP_OFFLINE_DOWNLOAD_MISSING_QUALITY");
  const formatId = requireString(payload, "formatId", "STEP_OFFLINE_DOWNLOAD_MISSING_FORMAT_ID");
  const container = requireString(payload, "container", "STEP_OFFLINE_DOWNLOAD_MISSING_CONTAINER");
  if (container !== "mkv" && container !== "mp4") {
    throw new Error(`STEP_OFFLINE_DOWNLOAD_INVALID_CONTAINER:${container}`);
  }
  // RT-SEC-05: the token and the library key are never in the job payload (that is persisted to runtime_jobs.db);
  // they come from the runtime's memory, waiting for the desktop's push when the job was resumed at boot.
  const credentials = await baseDeps.awaitCredentials({ jobId: ctx.job.jobId, signal: ctx.signal });
  if (!credentials?.token) throw new Error("STEP_OFFLINE_DOWNLOAD_MISSING_TOKEN");
  if (!credentials.libraryKeyBase64) throw new Error("STEP_OFFLINE_DOWNLOAD_MISSING_LIBRARY_KEY");
  const { token, libraryKeyBase64 } = credentials;
  const expectedBytes = requireNumber(payload, "expectedBytes", "STEP_OFFLINE_DOWNLOAD_MISSING_EXPECTED_BYTES");
  const libraryId = (payload.libraryId as string | undefined) || "default";
  const manifest = requireManifest(payload);

  // STOR-BW-09: while the object's silo is saturated the gateway gives this export no bytes; the job is shown as
  // held and carries on by itself when the silo lifts. Nothing is started or prefetched on the side.
  const saturationGate = createSaturationGate({
    traffic: baseDeps.traffic,
    token,
    signal: ctx.signal,
    onHold: () => {
      console.info(`[offline_download] HELD job=${ctx.job.jobId}: the silo is saturated`);
      held = true;
      showStage();
    },
    onRelease: () => {
      console.info(`[offline_download] RELEASED job=${ctx.job.jobId}: the silo is no longer saturated`);
      held = false;
      showStage();
    },
  });
  // STOR-BW-01: while the merged state is high the download is slowed, never stopped or failed.
  const slowdownGate = createSlowdownGate({
    traffic: baseDeps.traffic,
    signal: ctx.signal,
    onSlow: () => {
      console.info(`[offline_download] SLOWED job=${ctx.job.jobId}: high traffic`);
      slowed = true;
      showStage();
    },
    onNormal: () => {
      console.info(`[offline_download] NORMAL SPEED job=${ctx.job.jobId}: traffic is back to normal`);
      slowed = false;
      showStage();
    },
  });
  const deps: typeof baseDeps = {
    ...baseDeps,
    downloadObject: async (downloadToken, objectKey) => {
      await saturationGate.before(objectKey);
      ensureNotAborted(ctx.signal);
      slowdownGate.before();
      // A throw while the silo is saturated is the hold showing through (the gateway gives zero bytes, the tunnel
      // read times out): the job is held, never failed, and the same object is retried once the silo lifts. Any
      // other throw surfaces as is, and an abort stops at once.
      let encrypted: Uint8Array;
      for (;;) {
        try {
          encrypted = await baseDeps.downloadObject(downloadToken, objectKey, { onTraffic: saturationGate.observe });
          break;
        } catch (err) {
          ensureNotAborted(ctx.signal);
          const siloReport = await baseDeps.traffic?.refresh(downloadToken, objectKey).catch(() => null);
          if (siloReport?.saturated !== true) throw err;
          saturationGate.observe(siloReport);
          await saturationGate.before(objectKey);
          ensureNotAborted(ctx.signal);
          slowdownGate.before();
        }
      }
      await slowdownGate.after(encrypted.byteLength);
      return encrypted;
    },
  };
  const offlineRoot = deps.resolveOfflineDir(libraryId);
  const stagingDir = joinPath(offlineRoot, `.tmp-${ctx.job.jobId}`);

  console.info(
    `[offline_download] start job=${ctx.job.jobId} mediaId=${mediaId} fileId=${fileId} quality=${quality} container=${container} videoChunks=${manifest.videoChunks.length} audioTracks=${manifest.audioTracks.length} subs=${manifest.subtitles.length} expectedBytes=${expectedBytes} stagingDir=${stagingDir}`
  );

  // Skipped-subs accounting (MP4 only): ASS / PGS get reported back on the
  // step outputs; the renderer surfaces them in the confirm modal but the
  // job still succeeds with the remaining tracks.
  const skippedSubsForContainer: string[] = [];

  // --- Resume probe ---
  // If a staging dir exists from a prior attempt AND `.resume.json` is intact
  // AND intermediate sizes match the recorded onDiskBytes, we hydrate the
  // completedByOutput map and skip already-downloaded chunks. Anything else
  // (no staging, sidecar missing, schema mismatch, size mismatch, missing
  // intermediate) falls back to a fresh run by wiping the staging dir.
  const hydrate = await hydrateResumeState(stagingDir, ctx.job.jobId);
  let completedByOutput: Map<string, Set<number>>;
  let sidecar: ResumeSidecar;
  let resuming = false;
  if (hydrate.kind === "resume") {
    completedByOutput = hydrate.completedByOutput;
    sidecar = hydrate.sidecar;
    resuming = true;
    console.info(
      `[offline_download] RESUMING job=${ctx.job.jobId} stagingDir=${stagingDir} priorOutputs=${completedByOutput.size}`
    );
  } else {
    if (hydrate.kind === "corrupt") {
      console.warn(
        `[offline_download] corrupt resume state at ${stagingDir} (reason=${hydrate.reason}) — wiping and starting fresh`
      );
      await rmSilent(stagingDir);
    }
    completedByOutput = new Map();
    sidecar = emptySidecar(ctx.job.jobId);
  }

  await fs.mkdir(stagingDir, { recursive: true });
  if (!resuming) {
    // Persist an initial empty sidecar so a crash before the first chunk
    // write still leaves a parseable resume state (with no completed
    // chunks) for the next attempt's hydrate probe.
    await writeResumeSidecar(stagingDir, sidecar);
  }

  // ---------------- Phase 1 — fetch + decrypt + concat ----------------
  let totalDownloadedBytes = 0;
  let videoIntermediatePath: string | null = null;
  const audioIntermediates: Array<{ track: ManifestAudioTrack; path: string }> = [];
  const subtitleIntermediates: Array<{ track: ManifestSubtitleTrack; path: string }> = [];

  // For sidecar bookkeeping we track the per-output bytes-written counter
  // ourselves so the recorded `onDiskBytes` does not drift from disk truth.
  // It starts at whatever was already on disk for resumed outputs.
  const onDiskBytesByOutput = new Map<string, number>();
  for (const [name, entry] of Object.entries(sidecar.outputs)) {
    onDiskBytesByOutput.set(name, entry.onDiskBytes);
  }
  // Re-seed totalDownloadedBytes from resumed sizes so progress percent
  // continues from roughly where the prior attempt left off rather than
  // dropping back to 0%.
  if (resuming) {
    for (const bytes of onDiskBytesByOutput.values()) {
      totalDownloadedBytes += bytes;
    }
  }

  /**
   * Open a per-output intermediate file handle for append. When resuming
   * (handler hydrated state for this filename) we open with "a" so existing
   * bytes survive; otherwise we open with "w" (truncate) for a clean start.
   */
  const openIntermediate = async (filename: string): Promise<fs.FileHandle> => {
    const filePath = joinPath(stagingDir, filename);
    const wasResumed = completedByOutput.has(filename);
    const mode = wasResumed ? "a" : "w";
    if (!wasResumed) onDiskBytesByOutput.set(filename, 0);
    return fs.open(filePath, mode);
  };

  try {
    // ----- Video -----
    if (manifest.videoChunks.length === 0) {
      throw new Error("STEP_OFFLINE_DOWNLOAD_NO_VIDEO_CHUNKS");
    }
    const videoFilename = "video.mp4";
    videoIntermediatePath = joinPath(stagingDir, videoFilename);
    const videoHandle = await openIntermediate(videoFilename);
    try {
      ctx.reportProgress(1, "Downloading video", "downloading");

      // Init key (init.mp4) first if present — DASH-style ingest produces a
      // separate init segment. Tracked under sentinel orderIndex=-1.
      if (manifest.videoInitKey) {
        const videoCompleted = completedByOutput.get(videoFilename);
        if (videoCompleted?.has(INIT_ORDER_INDEX)) {
          console.info(
            `[offline_download] RESUME: skipping video init (already on disk)`
          );
        } else {
          const wrote = await downloadDecryptAndAppend({
            signal: ctx.signal,
            token,
            libraryKeyBase64,
            objectKey: manifest.videoInitKey,
            appendTo: videoHandle,
            deps,
          });
          totalDownloadedBytes += wrote;
          const newBytes = (onDiskBytesByOutput.get(videoFilename) ?? 0) + wrote;
          onDiskBytesByOutput.set(videoFilename, newBytes);
          await recordChunkCompleted({
            stagingDir,
            sidecar,
            completedByOutput,
            intermediateFilename: videoFilename,
            orderIndex: INIT_ORDER_INDEX,
            onDiskBytes: newBytes,
          });
          console.info(`[offline_download] init video chunk wrote=${wrote} bytes (onDisk=${newBytes})`);
        }
      }

      // Order chunks deterministically (manifest carries them already in
      // order, but defend against an out-of-order producer).
      const orderedVideoChunks = [...manifest.videoChunks].sort(
        (a, b) => Number(a.orderIndex) - Number(b.orderIndex)
      );
      for (let i = 0; i < orderedVideoChunks.length; i += 1) {
        ensureNotAborted(ctx.signal);
        const chunk = orderedVideoChunks[i];
        const videoCompleted = completedByOutput.get(videoFilename);
        if (videoCompleted?.has(chunk.orderIndex)) {
          console.info(
            `[offline_download] RESUME: skipping video chunk orderIndex=${chunk.orderIndex} (already on disk)`
          );
          continue;
        }
        const wrote = await downloadDecryptAndAppend({
          signal: ctx.signal,
          token,
          libraryKeyBase64,
          objectKey: chunk.key,
          appendTo: videoHandle,
          deps,
        });
        totalDownloadedBytes += wrote;
        const newBytes = (onDiskBytesByOutput.get(videoFilename) ?? 0) + wrote;
        onDiskBytesByOutput.set(videoFilename, newBytes);
        await recordChunkCompleted({
          stagingDir,
          sidecar,
          completedByOutput,
          intermediateFilename: videoFilename,
          orderIndex: chunk.orderIndex,
          onDiskBytes: newBytes,
        });
        const phase1Progress =
          expectedBytes > 0
            ? Math.min(60, Math.floor((totalDownloadedBytes / expectedBytes) * 60))
            : Math.min(60, Math.floor(((i + 1) / orderedVideoChunks.length) * 60));
        ctx.reportProgress(Math.max(1, phase1Progress), "Downloading video", "downloading");
      }
    } finally {
      await videoHandle.close();
    }

    // ----- Audio (per-track) -----
    for (const track of manifest.audioTracks) {
      ensureNotAborted(ctx.signal);
      const audioFilename = `audio-${track.trackId}.m4a`;
      const trackPath = joinPath(stagingDir, audioFilename);
      const trackHandle = await openIntermediate(audioFilename);
      try {
        const stageLabel = `Downloading audio (${track.language || "und"})`;
        ctx.reportProgress(
          Math.min(70, Math.max(60, Math.floor((totalDownloadedBytes / Math.max(1, expectedBytes)) * 60))),
          stageLabel,
          "downloading"
        );
        if (track.initKey) {
          const audioCompleted = completedByOutput.get(audioFilename);
          if (audioCompleted?.has(INIT_ORDER_INDEX)) {
            console.info(
              `[offline_download] RESUME: skipping audio init track=${track.trackId} (already on disk)`
            );
          } else {
            const wrote = await downloadDecryptAndAppend({
              signal: ctx.signal,
              token,
              libraryKeyBase64,
              objectKey: track.initKey,
              appendTo: trackHandle,
              deps,
            });
            totalDownloadedBytes += wrote;
            const newBytes = (onDiskBytesByOutput.get(audioFilename) ?? 0) + wrote;
            onDiskBytesByOutput.set(audioFilename, newBytes);
            await recordChunkCompleted({
              stagingDir,
              sidecar,
              completedByOutput,
              intermediateFilename: audioFilename,
              orderIndex: INIT_ORDER_INDEX,
              onDiskBytes: newBytes,
            });
          }
        }
        const orderedAudioChunks = [...track.chunks].sort(
          (a, b) => Number(a.orderIndex) - Number(b.orderIndex)
        );
        for (const chunk of orderedAudioChunks) {
          ensureNotAborted(ctx.signal);
          const audioCompleted = completedByOutput.get(audioFilename);
          if (audioCompleted?.has(chunk.orderIndex)) {
            console.info(
              `[offline_download] RESUME: skipping audio chunk track=${track.trackId} orderIndex=${chunk.orderIndex} (already on disk)`
            );
            continue;
          }
          const wrote = await downloadDecryptAndAppend({
            signal: ctx.signal,
            token,
            libraryKeyBase64,
            objectKey: chunk.key,
            appendTo: trackHandle,
            deps,
          });
          totalDownloadedBytes += wrote;
          const newBytes = (onDiskBytesByOutput.get(audioFilename) ?? 0) + wrote;
          onDiskBytesByOutput.set(audioFilename, newBytes);
          await recordChunkCompleted({
            stagingDir,
            sidecar,
            completedByOutput,
            intermediateFilename: audioFilename,
            orderIndex: chunk.orderIndex,
            onDiskBytes: newBytes,
          });
        }
      } finally {
        await trackHandle.close();
      }
      audioIntermediates.push({ track, path: trackPath });
      console.info(`[offline_download] audio track done track=${track.trackId} lang=${track.language}`);
    }

    // ----- Subtitles (per-track, single object each) -----
    for (const sub of manifest.subtitles) {
      ensureNotAborted(ctx.signal);
      if (container === "mp4" && !isMp4CompatibleSub(sub.format)) {
        // ASS / PGS / SUP cannot embed cleanly in MP4 without lossy
        // conversion — skip them and record on outputs so the renderer can
        // surface "X subtitle tracks dropped" if needed.
        const label = sub.language || sub.label || sub.subtitleId;
        skippedSubsForContainer.push(label);
        console.info(`[offline_download] MP4: skipping incompatible sub ${label} format=${sub.format ?? "unknown"}`);
        continue;
      }
      if (!isPassthroughSubFormat(sub.format)) {
        // Unknown sub format — treat as skippable rather than break the mux.
        const label = sub.language || sub.label || sub.subtitleId;
        skippedSubsForContainer.push(label);
        console.warn(
          `[offline_download] unknown sub format=${sub.format ?? "unknown"} — skipping ${label}`
        );
        continue;
      }
      const ext = subtitleExtensionFor(sub.format);
      const subFilename = `sub-${sub.subtitleId}.${ext}`;
      const subPath = joinPath(stagingDir, subFilename);
      const subCompleted = completedByOutput.get(subFilename);
      if (subCompleted?.has(SUBTITLE_ORDER_INDEX)) {
        console.info(
          `[offline_download] RESUME: skipping sub ${sub.subtitleId} (already on disk)`
        );
        subtitleIntermediates.push({ track: sub, path: subPath });
        continue;
      }
      const subHandle = await openIntermediate(subFilename);
      try {
        ctx.reportProgress(
          Math.max(60, Math.min(80, Math.floor((totalDownloadedBytes / Math.max(1, expectedBytes)) * 80))),
          "Downloading subtitles",
          "downloading"
        );
        const wrote = await downloadDecryptAndAppend({
          signal: ctx.signal,
          token,
          libraryKeyBase64,
          objectKey: sub.objectKey,
          appendTo: subHandle,
          deps,
        });
        totalDownloadedBytes += wrote;
        const newBytes = (onDiskBytesByOutput.get(subFilename) ?? 0) + wrote;
        onDiskBytesByOutput.set(subFilename, newBytes);
        await recordChunkCompleted({
          stagingDir,
          sidecar,
          completedByOutput,
          intermediateFilename: subFilename,
          orderIndex: SUBTITLE_ORDER_INDEX,
          onDiskBytes: newBytes,
        });
      } finally {
        await subHandle.close();
      }
      subtitleIntermediates.push({ track: sub, path: subPath });
    }

    ensureNotAborted(ctx.signal);

    // ---------------- Phase 2 — mux -----------------
    ctx.reportProgress(85, "Muxing tracks", "muxing");
    const muxedPath = joinPath(stagingDir, `output.${container}`);
    const ffmpegArgs: string[] = ["-y"];
    // Inputs (always present): video first, then each audio, then each sub.
    ffmpegArgs.push("-i", videoIntermediatePath);
    for (const ai of audioIntermediates) ffmpegArgs.push("-i", ai.path);
    for (const si of subtitleIntermediates) ffmpegArgs.push("-i", si.path);
    // Maps: 0:v (video), 1..N:a (audio), N+1..M:s (subs).
    ffmpegArgs.push("-map", "0:v:0");
    audioIntermediates.forEach((_, i) => {
      // input index for the i-th audio is 1 + i (video occupies input 0).
      ffmpegArgs.push("-map", `${1 + i}:a:0`);
    });
    const audioInputBase = 1 + audioIntermediates.length;
    subtitleIntermediates.forEach((_, i) => {
      ffmpegArgs.push("-map", `${audioInputBase + i}:s:0?`);
    });
    // Codec passthrough for video + audio.
    ffmpegArgs.push("-c:v", "copy");
    ffmpegArgs.push("-c:a", "copy");
    // Subtitle codec: copy for MKV, mov_text for MP4.
    if (subtitleIntermediates.length > 0) {
      if (container === "mp4") {
        ffmpegArgs.push("-c:s", "mov_text");
      } else {
        ffmpegArgs.push("-c:s", "copy");
      }
    }
    // Per-track language tags. ffmpeg numbering is per-output-stream within
    // each type ("-metadata:s:a:0 language=eng" addresses the first audio
    // stream of the OUTPUT).
    audioIntermediates.forEach((ai, i) => {
      const lang = (ai.track.language || "und").trim().toLowerCase();
      ffmpegArgs.push(`-metadata:s:a:${i}`, `language=${lang}`);
      if (ai.track.label && ai.track.label !== lang) {
        ffmpegArgs.push(`-metadata:s:a:${i}`, `title=${ai.track.label}`);
      }
      if (ai.track.isDefault) {
        ffmpegArgs.push(`-disposition:a:${i}`, "default");
      }
    });
    subtitleIntermediates.forEach((si, i) => {
      const lang = (si.track.language || "und").trim().toLowerCase();
      ffmpegArgs.push(`-metadata:s:s:${i}`, `language=${lang}`);
      if (si.track.label && si.track.label !== lang) {
        ffmpegArgs.push(`-metadata:s:s:${i}`, `title=${si.track.label}`);
      }
      if (si.track.isDefault) {
        ffmpegArgs.push(`-disposition:s:${i}`, "default");
      }
    });
    ffmpegArgs.push(muxedPath);

    console.info(
      `[offline_download] ffmpeg mux args=${JSON.stringify(ffmpegArgs)}`
    );
    const muxStarted = Date.now();
    await runFfmpeg(ffmpegArgs, {
      ffmpegPath: deps.resolveFfmpegPath?.() ?? undefined,
      progress: { enabled: false },
    });
    console.info(`[offline_download] mux done in ${Date.now() - muxStarted}ms`);
    ensureNotAborted(ctx.signal);

    // ---------------- Phase 3 — finalize ----------------
    ctx.reportProgress(95, "Finalizing", "finalizing");
    const desired = sanitizeOfflineFilename(
      buildOfflineFilename({
        ...manifest.filenameInputs,
        container,
      })
    );
    await fs.mkdir(offlineRoot, { recursive: true });
    let existing: string[] = [];
    try {
      existing = await fs.readdir(offlineRoot);
    } catch {
      existing = [];
    }
    const finalName = resolveOfflineFilenameCollision(desired, new Set(existing));
    const finalPath = joinPath(offlineRoot, finalName);

    await fs.rename(muxedPath, finalPath);

    // Stat the final file so the DB row reflects on-disk truth (post-mux
    // size, not the sum of decrypted chunk bytes — those differ because the
    // mux adds container framing).
    const stat = await fs.stat(finalPath);

    const downloadedAt = new Date().toISOString();
    const localDownloadId =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : crypto.randomUUID();
    await deps.registerLocalDownload({
      id: localDownloadId,
      fileId,
      mediaId,
      quality,
      formatId,
      container,
      localPath: finalPath,
      totalBytes: stat.size,
      downloadedAt,
      runtimeJobId: ctx.job.jobId,
    });

    // Best-effort cleanup of any leftover intermediates (they should already
    // be inside the staging dir; the final muxed file has been moved out).
    await rmSilent(stagingDir);

    ctx.emitOutputs({
      downloadResult: {
        localPath: finalPath,
        totalBytes: stat.size,
        container,
        skippedSubsForContainer,
      },
    });
    ctx.reportProgress(100, "Saved offline", "finalizing");
    console.info(
      `[offline_download] success job=${ctx.job.jobId} localPath=${finalPath} totalBytes=${stat.size} skipped=${skippedSubsForContainer.length}`
    );
  } catch (err) {
    // RESUME-AWARE FAILURE HANDLING: on cancellation OR a thrown error we
    // intentionally LEAVE the staging dir + sidecar intact so a retry can
    // pick up from the last persisted chunk. Phase 2 mux & finalize failures
    // also fall through here because the muxed output and DB row haven't
    // been written yet — the next attempt re-muxes from the same
    // intermediates and re-writes the row.
    //
    // The explicit `badger.offline.delete_local` command (different handler
    // in offlineDownload.ts) is the path that actively wipes staging dirs.
    // Orphaned staging dirs from crashed processes are swept on runtime
    // startup (see `sweepOrphanedStagingDirs` in modules/index.ts).
    console.warn(
      `[offline_download] failure job=${ctx.job.jobId} error=${err instanceof Error ? err.message : String(err)} — preserving staging dir ${stagingDir} for resume`
    );
    throw err;
  }
};

// Re-export the manifest shape so the offline-handler module (which builds
// the manifest from library DB) and the test fixtures share one type.
export type {
  OfflineDownloadManifest,
  ManifestVideoChunk,
  ManifestAudioTrack,
  ManifestSubtitleTrack,
};

// Side-effect import: `dirname` was needed earlier when we considered writing
// the final file outside `offlineRoot`; kept the import so the resolver stays
// stable if v2 adds per-media subdirectories. Suppress the unused-import
// warning by referencing it.
void dirname;
