/**
 * Step: export_file — the only step of a `kind: "export"` job (OFFL-FILE-01 "Download file", ACCT-EXPORT-01
 * "Download everything"). Fetches the stored pieces of one file at the quality the submit picked (the highest),
 * decrypts them, muxes one plain MKV/MP4 with every audio and subtitle track, and moves it into the folder the user
 * picked under a name nobody holds (OFFL-FILE-02, #618: compared without letter case, never overwrites).
 *
 * Not offline content: no `media_local_downloads` row, nothing under the app's offline dir.
 *
 * The file is built in `<final folder>/.sf-export-<jobId>/` so the last move stays on one disk (a link or rename,
 * never a copy) and the final name only ever holds a complete file (OFFL-SAFE-01). An export does not resume: on
 * failure or cancel the staging folder is removed and a retry starts over.
 *
 * Lane `upload` (network-heavy, like offline saves). Same storage traffic rules as offline saves: held while the
 * silo is saturated (STOR-BW-09), slowed while traffic is high (STOR-BW-01).
 */

import { promises as fs } from "node:fs";
import { join as joinPath } from "node:path";
import { runFfmpeg } from "@space/ffmpeg";
import { buildExportPath } from "@space/shared/exportLayout";
import { placeExportFile } from "@space/shared/exportPlacement";
import { HELD_SATURATED_STAGE_CODE, SLOWED_HIGH_TRAFFIC_STAGE_CODE } from "@space/shared/storageTrafficStage";
import type { StepHandler, StepHandlerCtx } from "../../../core/jobs/engineV2";
import { getBadgerOfflineDeps, type BadgerOfflineDeps } from "../offlineDownloadDeps";
import {
  HELD_SATURATED_STAGE_LABEL,
  SLOWED_HIGH_TRAFFIC_STAGE_LABEL,
  createSaturationGate,
  createSlowdownGate,
} from "../offlineTrafficGate";
import type { ExportJobPayload, ExportPiece } from "../export";

const ensureNotAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error("CANCELLED");
};

const subtitleExtensionFor = (raw: string | null): string | null => {
  const fmt = (raw ?? "").toLowerCase();
  if (fmt === "srt") return "srt";
  if (fmt === "vtt" || fmt === "webvtt") return "vtt";
  if (fmt === "ass" || fmt === "ssa") return "ass";
  if (fmt === "pgs" || fmt === "sup") return "sup";
  return null;
};

const readPayload = (raw: unknown): ExportJobPayload => {
  const p = (raw ?? {}) as Partial<ExportJobPayload>;
  if (!p.fileId || !p.mediaId) throw new Error("STEP_EXPORT_MISSING_FILE");
  if (p.container !== "mkv" && p.container !== "mp4") throw new Error(`STEP_EXPORT_INVALID_CONTAINER:${String(p.container)}`);
  if (p.layout !== "flat" && p.layout !== "library") throw new Error(`STEP_EXPORT_INVALID_LAYOUT:${String(p.layout)}`);
  if (!p.destDir) throw new Error("STEP_EXPORT_MISSING_DEST_DIR");
  if (!p.manifest || p.manifest.videoChunks.length === 0) throw new Error("STEP_EXPORT_NO_VIDEO_CHUNKS");
  return p as ExportJobPayload;
};

export const exportFileStepHandler: StepHandler = async (stepCtx) => {
  ensureNotAborted(stepCtx.signal);
  const payload = readPayload(stepCtx.job.payload);
  const { manifest, container } = payload;
  const jobId = stepCtx.job.jobId;
  const baseDeps = getBadgerOfflineDeps();

  // Hold / slowdown stages win over the step's own stage while they last (same rules as offline saves).
  let held = false;
  let slowed = false;
  let lastProgress: Parameters<StepHandlerCtx["reportProgress"]> | null = null;
  const overrideStage = (code: string | undefined) =>
    held
      ? { label: HELD_SATURATED_STAGE_LABEL, code: HELD_SATURATED_STAGE_CODE }
      : slowed && (code === undefined || code === "downloading")
        ? { label: SLOWED_HIGH_TRAFFIC_STAGE_LABEL, code: SLOWED_HIGH_TRAFFIC_STAGE_CODE }
        : null;
  const report: StepHandlerCtx["reportProgress"] = (...args) => {
    lastProgress = args;
    const override = overrideStage(args[2]);
    if (override) stepCtx.reportProgress(args[0], override.label, override.code);
    else stepCtx.reportProgress(...args);
  };
  const showStage = () => {
    if (lastProgress) report(...lastProgress);
  };

  // RT-SEC-05: credentials come from the runtime's memory, never from the persisted payload.
  const credentials = await baseDeps.awaitCredentials({ jobId, signal: stepCtx.signal });
  if (!credentials?.token) throw new Error("STEP_EXPORT_MISSING_TOKEN");
  if (!credentials.libraryKeyBase64) throw new Error("STEP_EXPORT_MISSING_LIBRARY_KEY");
  const { token, libraryKeyBase64 } = credentials;

  const saturationGate = createSaturationGate({
    traffic: baseDeps.traffic,
    token,
    signal: stepCtx.signal,
    onHold: () => {
      console.info(`[export_file] HELD job=${jobId}: the silo is saturated`);
      held = true;
      showStage();
    },
    onRelease: () => {
      console.info(`[export_file] RELEASED job=${jobId}`);
      held = false;
      showStage();
    },
  });
  const slowdownGate = createSlowdownGate({
    traffic: baseDeps.traffic,
    signal: stepCtx.signal,
    onSlow: () => {
      console.info(`[export_file] SLOWED job=${jobId}: high traffic`);
      slowed = true;
      showStage();
    },
    onNormal: () => {
      console.info(`[export_file] NORMAL SPEED job=${jobId}`);
      slowed = false;
      showStage();
    },
  });
  const fetchObject: BadgerOfflineDeps["downloadObject"] = async (downloadToken, objectKey) => {
    await saturationGate.before(objectKey);
    ensureNotAborted(stepCtx.signal);
    slowdownGate.before();
    // A throw while the silo is saturated is the hold showing through: wait for the lift and fetch the same object.
    let encrypted: Uint8Array;
    for (;;) {
      try {
        encrypted = await baseDeps.downloadObject(downloadToken, objectKey, { onTraffic: saturationGate.observe });
        break;
      } catch (err) {
        ensureNotAborted(stepCtx.signal);
        const siloReport = await baseDeps.traffic?.refresh(downloadToken, objectKey).catch(() => null);
        if (siloReport?.saturated !== true) throw err;
        saturationGate.observe(siloReport);
        await saturationGate.before(objectKey);
        ensureNotAborted(stepCtx.signal);
        slowdownGate.before();
      }
    }
    await slowdownGate.after(encrypted.byteLength);
    return encrypted;
  };

  const target = buildExportPath({ ...manifest.filenameInputs, container }, payload.layout);
  const finalDir = joinPath(payload.destDir, ...target.dirs);
  const stagingDir = joinPath(finalDir, `.sf-export-${jobId}`);
  console.info(
    `[export_file] start job=${jobId} mediaId=${payload.mediaId} fileId=${payload.fileId} quality=${payload.quality} container=${container} layout=${payload.layout} finalDir=${finalDir} name=${JSON.stringify(target.filename)} videoChunks=${manifest.videoChunks.length} audioTracks=${manifest.audioTracks.length} subs=${manifest.subtitles.length} expectedBytes=${payload.expectedBytes}`,
  );

  const expected = Math.max(1, payload.expectedBytes);
  let fetchedBytes = 0;
  const fetchInto = async (path: string, keys: string[], label: string) => {
    const handle = await fs.open(path, "w");
    try {
      for (const key of keys) {
        ensureNotAborted(stepCtx.signal);
        const plain = baseDeps.decrypt(await fetchObject(token, key), libraryKeyBase64);
        ensureNotAborted(stepCtx.signal);
        await handle.write(plain);
        fetchedBytes += plain.byteLength;
        report(Math.max(1, Math.min(85, Math.floor((fetchedBytes / expected) * 85))), label, "downloading");
      }
    } finally {
      await handle.close();
    }
  };
  const orderedKeys = (initKey: string | null, chunks: ExportPiece[]) => [
    ...(initKey ? [initKey] : []),
    ...[...chunks].sort((a, b) => a.orderIndex - b.orderIndex).map((c) => c.key),
  ];

  await fs.mkdir(finalDir, { recursive: true });
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir);
  try {
    report(1, "Downloading video", "downloading");
    const videoPath = joinPath(stagingDir, "video.mp4");
    await fetchInto(videoPath, orderedKeys(manifest.videoInitKey, manifest.videoChunks), "Downloading video");

    const audioPaths: string[] = [];
    for (const [i, track] of manifest.audioTracks.entries()) {
      const path = joinPath(stagingDir, `audio-${i}.m4a`);
      await fetchInto(path, orderedKeys(track.initKey, track.chunks), `Downloading audio (${track.language || "und"})`);
      audioPaths.push(path);
    }

    const skippedSubsForContainer = [...payload.skippedSubsForContainer];
    const subs: Array<{ track: ExportJobPayload["manifest"]["subtitles"][number]; path: string }> = [];
    for (const [i, track] of manifest.subtitles.entries()) {
      const ext = subtitleExtensionFor(track.format);
      if (!ext || (container === "mp4" && ext !== "srt" && ext !== "vtt")) {
        skippedSubsForContainer.push(track.language || track.label || track.subtitleId);
        console.warn(`[export_file] skipping sub ${track.subtitleId} format=${track.format ?? "unknown"} container=${container}`);
        continue;
      }
      const path = joinPath(stagingDir, `sub-${i}.${ext}`);
      await fetchInto(path, [track.objectKey], "Downloading subtitles");
      subs.push({ track, path });
    }
    ensureNotAborted(stepCtx.signal);

    report(90, "Muxing tracks", "muxing");
    const muxedPath = joinPath(stagingDir, `output.${container}`);
    const args = ["-y", "-i", videoPath];
    for (const path of audioPaths) args.push("-i", path);
    for (const sub of subs) args.push("-i", sub.path);
    args.push("-map", "0:v:0");
    audioPaths.forEach((_, i) => args.push("-map", `${1 + i}:a:0`));
    subs.forEach((_, i) => args.push("-map", `${1 + audioPaths.length + i}:s:0?`));
    args.push("-c:v", "copy", "-c:a", "copy");
    if (subs.length > 0) args.push("-c:s", container === "mp4" ? "mov_text" : "copy");
    manifest.audioTracks.forEach((track, i) => {
      const lang = (track.language || "und").trim().toLowerCase();
      args.push(`-metadata:s:a:${i}`, `language=${lang}`);
      if (track.label && track.label !== lang) args.push(`-metadata:s:a:${i}`, `title=${track.label}`);
      if (track.isDefault) args.push(`-disposition:a:${i}`, "default");
    });
    subs.forEach(({ track }, i) => {
      const lang = (track.language || "und").trim().toLowerCase();
      args.push(`-metadata:s:s:${i}`, `language=${lang}`);
      if (track.label && track.label !== lang) args.push(`-metadata:s:s:${i}`, `title=${track.label}`);
      if (track.isDefault) args.push(`-disposition:s:${i}`, "default");
    });
    args.push(muxedPath);
    console.info(`[export_file] ffmpeg mux args=${JSON.stringify(args)}`);
    await runFfmpeg(args, { ffmpegPath: baseDeps.resolveFfmpegPath?.() ?? undefined, progress: { enabled: false } });
    ensureNotAborted(stepCtx.signal);

    report(97, "Saving to folder", "finalizing");
    const finalPath = await placeExportFile({
      sourcePath: muxedPath,
      destDir: finalDir,
      desiredName: target.filename,
      log: (line) => console.info(`[export_file] job=${jobId} ${line}`),
    });
    const { size } = await fs.stat(finalPath);
    await fs.rm(stagingDir, { recursive: true, force: true });
    stepCtx.emitOutputs({ exportResult: { path: finalPath, totalBytes: size, container, skippedSubsForContainer } });
    report(100, "Saved to folder", "finalizing");
    console.info(`[export_file] success job=${jobId} path=${finalPath} bytes=${size} skippedSubs=${skippedSubsForContainer.length}`);
  } catch (err) {
    // No resume for exports: drop the partial so nothing half-written stays in the user's folder.
    console.warn(`[export_file] failure job=${jobId} error=${err instanceof Error ? err.message : String(err)}; removing ${stagingDir}`);
    await fs.rm(stagingDir, { recursive: true, force: true }).catch((rmErr: unknown) => {
      console.warn(`[export_file] staging cleanup failed ${stagingDir}:`, rmErr instanceof Error ? rmErr.message : rmErr);
    });
    throw err;
  }
};
