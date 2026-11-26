/**
 * Step: offline_download — "Save offline" on the Badger computer (OFFL-FILE-03). Copies the title's storage objects
 * exactly as stored (SFV1, still sealed with the library key) into the app's offline piece store
 * (`@space/library-db-runtime/offlinePieceStore`): the chosen format's video init + chunks, every audio track's init +
 * chunks and every subtitle object, each kept apart. Nothing is decrypted or rebuilt. The desktop playback server plays
 * the copy through the same HLS path as a stream, reading the pieces from disk.
 *
 * One step per file. Order of writes (OFFL-SAFE-01):
 *   1. free-space check (OFFL-SAFE-02) on the pieces not here yet;
 *   2. every missing piece: `.part` then rename (a piece already here is reused, which is the resume after a cancel,
 *      a failure or a restart, and the sharing between items);
 *   3. the item manifest (tmp + rename): from here on the title is saved;
 *   4. the `media_local_downloads` row (schema_version 2, container "pieces", local_path = manifest), replacing any row
 *      of the same file (the re-save of an old plain file, OFFL-MIGR-01);
 *   5. the old plain file named by `legacyLocalPath`, when this is that re-save, only inside the offline dir.
 *
 * Abort: `ctx.signal.aborted` throws `CANCELLED`; finished pieces stay for a retry, the start-up sweep drops pieces no
 * item lists once no download is in flight.
 *
 * Output (`step.outputs.downloadResult`): { localPath (manifest), totalBytes, container: "pieces", skippedSubsForContainer: [] }.
 */

import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import {
  OFFLINE_PIECES_MANIFEST_VERSION,
  isPathUnderDir,
  offlinePieceSize,
  writeOfflinePiece,
  writeOfflinePieceManifest,
  type OfflinePieceManifest,
  type OfflinePieceTrack,
} from "@space/library-db-runtime/offlinePieceStore";
import { offlineDiskSpaceErrorMessage } from "@space/shared/offlineDiskSpace";
import type { StepHandler, StepHandlerCtx } from "@space/runtime-jobs-engine/engineV2";
import { FREE_DISK_SAFETY_MARGIN_BYTES, freeDiskBytesAt, getBadgerOfflineDeps } from "../offlineDownloadDeps";
import { HELD_SATURATED_STAGE_CODE, SLOWED_HIGH_TRAFFIC_STAGE_CODE } from "@space/shared/storageTrafficStage";
import {
  HELD_SATURATED_STAGE_LABEL,
  SLOWED_HIGH_TRAFFIC_STAGE_LABEL,
  createSaturationGate,
  createSlowdownGate,
} from "../offlineTrafficGate";

interface ManifestVideoChunk {
  key: string;
  sizeBytes: number;
  orderIndex: number;
  /** Start of the chunk in the title, seconds; absent on jobs queued by older builds. */
  startSeconds?: number | null;
}

interface ManifestAudioTrack {
  trackId: string;
  language: string;
  label: string;
  isDefault: boolean;
  initKey: string | null;
  initSize: number | null;
  chunks: ManifestVideoChunk[];
  codecString?: string | null;
  durationSeconds?: number | null;
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
  /** What the HLS playlist needs for the video (OFFL-PLAY-01); absent on jobs queued by older builds. */
  video?: { codecString: string | null; bitrateKbps: number | null; durationSeconds: number | null };
  audioTracks: ManifestAudioTrack[];
  subtitles: ManifestSubtitleTrack[];
  /** Source filename hint (jobs sidebar label fallback). */
  filenameHint?: string | null;
  /** Movie/episode metadata the jobs sidebar labels the job with. */
  filenameInputs:
    | { kind: "movie"; title: string; year?: number | null }
    | { kind: "episode"; showTitle: string; seasonNumber: number; episodeNumber: number; episodeTitle?: string | null };
}

const requireString = (payload: Record<string, unknown>, key: string, errorCode: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(errorCode);
  return value;
};

const requireManifest = (payload: Record<string, unknown>): OfflineDownloadManifest => {
  const manifest = payload.manifest as OfflineDownloadManifest | undefined;
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.videoChunks)) {
    throw new Error("STEP_OFFLINE_DOWNLOAD_MISSING_MANIFEST");
  }
  return manifest;
};

const ensureNotAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error("CANCELLED");
};

type PieceTask = { key: string; expectedBytes: number; stage: string };

const toPieceTrack = (
  initKey: string,
  chunks: ManifestVideoChunk[],
  codecString: string | null | undefined,
  durationSeconds: number | null | undefined
): OfflinePieceTrack => ({
  initKey,
  codecString: codecString ?? null,
  durationSeconds: durationSeconds ?? null,
  chunks: [...chunks]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((c) => ({ key: c.key, sizeBytes: c.sizeBytes, startSeconds: c.startSeconds ?? null })),
});

export const offlineDownloadStepHandler: StepHandler = async (stepCtx) => {
  ensureNotAborted(stepCtx.signal);
  let lastProgress: Parameters<StepHandlerCtx["reportProgress"]> | null = null;
  let held = false;
  let slowed = false;
  // A saturation hold (STOR-BW-09) takes precedence over a high-traffic slowdown (STOR-BW-01) as the shown stage; the
  // slowdown only paces fetches, so it replaces the downloading stage and not the finalizing one.
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
  const libraryId = (payload.libraryId as string | undefined) || "default";
  const legacyLocalPath = typeof payload.legacyLocalPath === "string" ? payload.legacyLocalPath : null;
  const manifest = requireManifest(payload);
  if (!manifest.videoInitKey || manifest.videoChunks.length === 0) {
    throw new Error("STEP_OFFLINE_DOWNLOAD_NO_VIDEO_CHUNKS");
  }
  const offlineRoot = baseDeps.resolveOfflineDir(libraryId);

  // Every piece once (a key listed twice is fetched once), video first so a cancel keeps the biggest part.
  const tasks: PieceTask[] = [];
  const seen = new Set<string>();
  const addTask = (key: string | null, expectedBytes: number | null, stage: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    tasks.push({ key, expectedBytes: Math.max(0, Number(expectedBytes ?? 0)), stage });
  };
  addTask(manifest.videoInitKey, manifest.videoInitSize, "Downloading video");
  for (const chunk of manifest.videoChunks) addTask(chunk.key, chunk.sizeBytes, "Downloading video");
  for (const track of manifest.audioTracks) {
    const stage = `Downloading audio (${track.language || track.label || "und"})`;
    addTask(track.initKey, track.initSize, stage);
    for (const chunk of track.chunks) addTask(chunk.key, chunk.sizeBytes, stage);
  }
  for (const sub of manifest.subtitles) addTask(sub.objectKey, sub.sizeBytes, "Downloading subtitles");

  // Pieces already here (an earlier attempt, or another title sharing them) are kept and not fetched again.
  const sizes = new Map<string, number>();
  for (const task of tasks) {
    const size = await offlinePieceSize(offlineRoot, task.key);
    if (size !== null) sizes.set(task.key, size);
  }
  const totalExpected = tasks.reduce((sum, t) => sum + t.expectedBytes, 0);
  const missingBytes = tasks.filter((t) => !sizes.has(t.key)).reduce((sum, t) => sum + t.expectedBytes, 0);
  console.info(
    `[offline_download] start job=${ctx.job.jobId} mediaId=${mediaId} fileId=${fileId} quality=${quality} pieces=${tasks.length} present=${sizes.size} expectedBytes=${totalExpected} missingBytes=${missingBytes} root=${offlineRoot} legacy=${legacyLocalPath ?? "none"}`
  );

  // OFFL-SAFE-02: refused before anything is fetched when the pieces still to fetch do not fit.
  if (missingBytes > 0) {
    const freeBytes = await (baseDeps.freeDiskBytes ?? freeDiskBytesAt)(offlineRoot);
    if (freeBytes < missingBytes + FREE_DISK_SAFETY_MARGIN_BYTES) {
      console.warn(
        `[offline_download] insufficient disk space job=${ctx.job.jobId} required=${missingBytes} free=${freeBytes} margin=${FREE_DISK_SAFETY_MARGIN_BYTES}`
      );
      throw new Error(offlineDiskSpaceErrorMessage(missingBytes, freeBytes));
    }
  }

  // RT-SEC-05: the token and the library key are never in the job payload (that is persisted to runtime_jobs.db);
  // they come from the runtime's memory, waiting for the desktop's push when the job was resumed at boot. The key is
  // not used here (pieces stay sealed) but its absence means no session is open.
  const credentials = await baseDeps.awaitCredentials({ jobId: ctx.job.jobId, signal: ctx.signal });
  if (!credentials?.token) throw new Error("STEP_OFFLINE_DOWNLOAD_MISSING_TOKEN");
  if (!credentials.libraryKeyBase64) throw new Error("STEP_OFFLINE_DOWNLOAD_MISSING_LIBRARY_KEY");
  const { token } = credentials;

  // STOR-BW-09: while the object's silo is saturated the gateway gives this download no bytes; the job is shown as
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
  const downloadObject = async (objectKey: string): Promise<Uint8Array> => {
    await saturationGate.before(objectKey);
    ensureNotAborted(ctx.signal);
    slowdownGate.before();
    // A throw while the silo is saturated is the hold showing through (the gateway gives zero bytes, the tunnel
    // read times out): the job is held, never failed, and the same object is retried once the silo lifts. Any
    // other throw surfaces as is, and an abort stops at once.
    let sealed: Uint8Array;
    for (;;) {
      try {
        sealed = await baseDeps.downloadObject(token, objectKey, { onTraffic: saturationGate.observe });
        break;
      } catch (err) {
        ensureNotAborted(ctx.signal);
        const siloReport = await baseDeps.traffic?.refresh(token, objectKey).catch(() => null);
        if (siloReport?.saturated !== true) throw err;
        saturationGate.observe(siloReport);
        await saturationGate.before(objectKey);
        ensureNotAborted(ctx.signal);
        slowdownGate.before();
      }
    }
    await slowdownGate.after(sealed.byteLength);
    return sealed;
  };

  try {
    let doneBytes = tasks.filter((t) => sizes.has(t.key)).reduce((sum, t) => sum + t.expectedBytes, 0);
    const percent = () => (totalExpected > 0 ? Math.min(94, Math.floor((doneBytes / totalExpected) * 94)) : 0);
    for (const task of tasks) {
      ensureNotAborted(ctx.signal);
      if (sizes.has(task.key)) continue;
      ctx.reportProgress(percent(), task.stage, "downloading");
      const sealed = await downloadObject(task.key);
      ensureNotAborted(ctx.signal);
      const written = await writeOfflinePiece(offlineRoot, task.key, sealed, { tag: ctx.job.jobId });
      sizes.set(task.key, written);
      doneBytes += task.expectedBytes;
      ctx.reportProgress(percent(), task.stage, "downloading");
    }

    ctx.reportProgress(95, "Finalizing", "finalizing");
    const objects = tasks.map((t) => ({ key: t.key, sizeBytes: sizes.get(t.key)! }));
    const totalBytes = objects.reduce((sum, o) => sum + o.sizeBytes, 0);
    const pieceManifest: OfflinePieceManifest = {
      version: OFFLINE_PIECES_MANIFEST_VERSION,
      fileId,
      mediaId,
      formatId,
      quality,
      savedAt: new Date().toISOString(),
      video: {
        id: formatId,
        quality,
        bitrateKbps: manifest.video?.bitrateKbps ?? null,
        track: toPieceTrack(
          manifest.videoInitKey,
          manifest.videoChunks,
          manifest.video?.codecString,
          manifest.video?.durationSeconds
        ),
      },
      audio: manifest.audioTracks
        .filter((t): t is ManifestAudioTrack & { initKey: string } => Boolean(t.initKey) && t.chunks.length > 0)
        .map((t) => ({
          id: t.trackId,
          language: t.language,
          label: t.label,
          isDefault: t.isDefault,
          track: toPieceTrack(t.initKey, t.chunks, t.codecString, t.durationSeconds),
        })),
      subtitles: manifest.subtitles.map((s) => ({
        id: s.subtitleId,
        language: s.language,
        label: s.label,
        format: s.format,
        objectKey: s.objectKey,
        isDefault: s.isDefault,
      })),
      objects,
      totalBytes,
    };
    const manifestPath = await writeOfflinePieceManifest(offlineRoot, pieceManifest);
    ensureNotAborted(ctx.signal);
    await baseDeps.registerLocalDownload({
      id: typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : crypto.randomUUID(),
      fileId,
      mediaId,
      quality,
      formatId,
      container: "pieces",
      localPath: manifestPath,
      totalBytes,
      downloadedAt: pieceManifest.savedAt,
      runtimeJobId: ctx.job.jobId,
      schemaVersion: OFFLINE_PIECES_MANIFEST_VERSION,
    });

    // OFFL-MIGR-01: the old plain file this save replaces goes once the pieces are recorded, and only from inside the
    // app's offline dir: a path elsewhere is never touched.
    if (legacyLocalPath) {
      if (isPathUnderDir(offlineRoot, legacyLocalPath)) {
        await fs.rm(legacyLocalPath, { force: true });
        console.info(`[offline_download] removed legacy plain file job=${ctx.job.jobId} path=${legacyLocalPath}`);
      } else {
        console.warn(
          `[offline_download] legacy path outside the offline dir left alone job=${ctx.job.jobId} path=${legacyLocalPath} root=${offlineRoot}`
        );
      }
    }

    ctx.emitOutputs({
      downloadResult: { localPath: manifestPath, totalBytes, container: "pieces", skippedSubsForContainer: [] },
    });
    ctx.reportProgress(100, "Saved offline", "finalizing");
    console.info(
      `[offline_download] success job=${ctx.job.jobId} manifest=${manifestPath} pieces=${objects.length} totalBytes=${totalBytes}`
    );
  } catch (err) {
    // Finished pieces stay for a retry (they are reused); `.part` leftovers and pieces no item lists are swept at
    // start-up once no download is in flight (sweepOfflinePieceStore, modules/index.ts).
    console.warn(
      `[offline_download] failure job=${ctx.job.jobId} error=${err instanceof Error ? err.message : String(err)} — pieces kept for a retry`
    );
    throw err;
  }
};

// The offline-handler module builds this manifest from the library DB; the tests share the type.
export type { OfflineDownloadManifest, ManifestVideoChunk, ManifestAudioTrack, ManifestSubtitleTrack };
