// REL-LOG-06: exposes the error-report bridge only; it sends nothing until the user opts in.
import "@space/error-report/electron-preload";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import fs from "fs";
import path from "path";
import os from "os";
import { runFfmpeg, runFfprobe } from "@space/ffmpeg";
import type { MpvCommand, MpvExternalMessage, MpvResponse, OscActionFile, SubtitleEntry } from "@space/mpv-protocol";
import type { PairingStartOptions } from "@space/desktop-shell/pairing";
import type { BadgerExportEstimatePayload, BadgerExportSubmitPayload } from "@space/runtime-contracts/badger/export";
import { SIBLING_IPC } from "@space/desktop-shell/sibling";
import { scopeLogger } from "../main/logger";
import type { AppWindowVisibility as AppWindowVisibilityState } from "../main/appWindowVisibility";
import { initTestIpcRecorder } from "./testIpcRecorder";
import type { UploadsDuringPlayback, UploadsFirstRunAnswer } from "../shared/uploadPlaybackDefault";
import type { DeviceCapacityValues } from "../shared/deviceCapacity";
import type { PlaybackSaturationState } from "../shared/playbackSaturation";
import { SESSION_REPLACE_CHANNEL, SESSION_SNAPSHOT_CHANNEL, sanitizeSessionEntries } from "../shared/sessionKeys";
import { CLIENT_IDENTITY_CHANNEL } from "@space/desktop-shell/client-identity";
import { PROVIDER_RETURN_IPC } from "../shared/providerReturn";
import type { ProviderReturn } from "@space/shared/providerSignIn";
import { createErrorReportsBridge } from "@space/error-report/desktop";
import { createIpcFanout } from "./ipcFanout";
import { createUpdaterBridge } from "@space/desktop-shell/updater-preload";
import { readStorageUnitBase } from "@space/desktop-shell/storage-units";

const subscribeMpvExternalMessage = createIpcFanout<MpvExternalMessage>(ipcRenderer, "sf-mpv-external-message");

// Install the IPC chatter recorder before any `sf` API is captured. When
// SF_E2E !== "1" this is a no-op and ipcRenderer is untouched.
initTestIpcRecorder();

const resolveDummyStorageDir = () => {
  const fromEnv = process.env.SF_DUMMY_STORAGE_DIR?.trim();
  const appRoot = process.env.SF_APP_ROOT?.trim();
  const cwd = process.cwd();
  const candidates = [
    fromEnv ? path.resolve(cwd, fromEnv) : null,
    appRoot ? path.resolve(appRoot, ".storage") : null,
    appRoot ? path.resolve(appRoot, "..", ".storage") : null,
    appRoot ? path.resolve(appRoot, "..", "..", ".storage") : null,
    path.resolve(cwd, ".storage"),
    path.resolve(cwd, "..", ".storage"),
    path.resolve(cwd, "..", "..", ".storage"),
    path.resolve(cwd, "..", "..", "..", ".storage"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const manifestPath = path.join(candidate, "manifest.json");
    const legacyPath = path.join(candidate, "dummy_manifest.json");
    if (fs.existsSync(manifestPath) || fs.existsSync(legacyPath)) {
      return candidate;
    }
  }

  return candidates[0] ?? path.resolve(cwd, ".storage");
};

const resolveBundledBinary = (envKey: string, filename: string) => {
  const rawEnv = process.env[envKey]?.trim();
  const fromEnv = rawEnv && rawEnv !== "undefined" && rawEnv !== "null" ? rawEnv : undefined;
  const appRoot = process.env.SF_APP_ROOT?.trim() ?? process.cwd();
  const cwd = process.cwd();
  const upRoots = [appRoot, path.join(appRoot, ".."), path.join(appRoot, "..", ".."), path.join(appRoot, "..", "..", "..")];
  const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? process.env.SF_DEV_SERVER_URL;
  const preferVendor = Boolean(devServerUrl);
  const vendorCandidates = [
    path.join(cwd, "packages", "ffmpeg", "vendor", "ffmpeg", filename),
    ...upRoots.map((root) => path.join(root, "packages", "ffmpeg", "vendor", "ffmpeg", filename)),
  ];
  const resourceCandidates = [
    path.join(appRoot, "resources", "ffmpeg", filename),
    path.join(appRoot, "..", "resources", "ffmpeg", filename),
    path.join(cwd, "packages", "ffmpeg", "resources", "ffmpeg", filename),
    path.join(cwd, "apps", "clients", "desktop", "resources", "ffmpeg", filename),
    ...upRoots.map((root) => path.join(root, "packages", "ffmpeg", "resources", "ffmpeg", filename)),
  ];
  const candidates = [
    fromEnv,
    ...(preferVendor ? vendorCandidates : resourceCandidates),
    ...(preferVendor ? resourceCandidates : vendorCandidates),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
};

const ffmpegPath = resolveBundledBinary("SF_FFMPEG_PATH", "ffmpeg");
const ffprobePath = resolveBundledBinary("SF_FFPROBE_PATH", "ffprobe");
const logger = scopeLogger("desktop-preload");
const subtitleSampleLog = (event: string, payload: Record<string, unknown>) => {
  logger.warn({ event, ...payload }, "subtitle-sample");
};
const tail = (value: string, max = 280) => (value.length > max ? value.slice(value.length - max) : value);

const readFileUtf8 = (filePath: string) =>
  new Promise<string>((resolve, reject) => {
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

const readFileBuffer = (filePath: string) =>
  new Promise<Buffer>((resolve, reject) => {
    fs.readFile(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

const readDummyManifest = async () => {
  const baseDir = resolveDummyStorageDir();
  const manifestPath = path.join(baseDir, "manifest.json");
  const legacyPath = path.join(baseDir, "dummy_manifest.json");
  const raw = await readFileUtf8(manifestPath).catch(async () => {
    return readFileUtf8(legacyPath);
  });
  return JSON.parse(raw);
};

const readDummyObject = async (key: string) => {
  const baseDir = resolveDummyStorageDir();
  const objectPath = path.join(baseDir, "objects", key);
  return readFileBuffer(objectPath);
};

type SubtitleImageCue = {
  startMs: number;
  endMs: number;
  imageBase64: string;
};

type MediaProbeSummary = {
  video: { codec: string | null; width: number | null; height: number | null } | null;
  audio: { count: number; languages: string[] };
  subtitles: { count: number; languages: string[] };
  chapters: { count: number };
  durationSeconds: number | null;
  audioTracks: Array<{ index: number; language: string; label: string; codec: string | null; channels: number | null }>;
  subtitleTracks: Array<{ index: number; language: string; label: string; codec: string | null }>;
};

const passthroughLanguageCode = (raw?: string | null) => {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "und";
  return value;
};

const probeMedia = async (filePath: string): Promise<MediaProbeSummary> => {
  if (!ffprobePath) {
    throw new Error("ffprobe_not_found");
  }
  const result = await runFfprobe(
    ["-v", "error", "-show_streams", "-show_format", "-show_chapters", "-print_format", "json", filePath],
    ffprobePath ? { ffprobePath } : undefined
  );
  const streams = result.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
  const chapters = (result.data as { chapters?: unknown[] }).chapters;
  const toLanguages = (items: Array<{ language?: string | null }>) =>
    Array.from(new Set(items.map((item) => passthroughLanguageCode(item.language))));
  const toLabel = (stream: { title?: string | null }, fallback: string) =>
    (stream.title ?? fallback).trim();

  return {
    video: videoStream
      ? {
          codec: (videoStream.codec_name as string | undefined) ?? null,
          width: typeof videoStream.width === "number" ? videoStream.width : Number(videoStream.width) || null,
          height: typeof videoStream.height === "number" ? videoStream.height : Number(videoStream.height) || null,
        }
      : null,
    audio: { count: audioStreams.length, languages: toLanguages(audioStreams) },
    subtitles: { count: subtitleStreams.length, languages: toLanguages(subtitleStreams) },
    chapters: { count: Array.isArray(chapters) ? chapters.length : 0 },
    durationSeconds: Number((result.data as { format?: { duration?: string } }).format?.duration ?? 0) || null,
    audioTracks: audioStreams.map((stream, index) => ({
      index,
      language: passthroughLanguageCode(stream.language),
      label: toLabel(stream, passthroughLanguageCode(stream.language) === "und" ? "Undefined" : passthroughLanguageCode(stream.language).toUpperCase()),
      codec: (stream.codec_name as string | undefined) ?? null,
      channels: typeof stream.channels === "number" ? stream.channels : Number(stream.channels) || null,
    })),
    subtitleTracks: subtitleStreams.map((stream, index) => ({
      index,
      language: passthroughLanguageCode(stream.language),
      label: toLabel(stream, passthroughLanguageCode(stream.language) === "und" ? "Undefined" : passthroughLanguageCode(stream.language).toUpperCase()),
      codec: (stream.codec_name as string | undefined) ?? null,
    })),
  };
};

const sampleAudioTrack = async (payload: { path: string; index: number; startSeconds?: number; durationSeconds?: number }) => {
  if (!ffmpegPath) {
    throw new Error("ffmpeg_not_found");
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sf-audio-sample-"));
  const outputPath = path.join(tempDir, "sample.mp3");
  const randomStart = Math.floor(Math.random() * 240);
  const start = Math.max(0, Math.floor(payload.startSeconds ?? randomStart));
  const duration = Math.max(60, Math.floor(payload.durationSeconds ?? 60));
  const result = await runFfmpeg(
    [
      "-y",
      "-ss",
      String(start),
      "-i",
      payload.path,
      "-map",
      `0:a:${Math.max(0, payload.index)}`,
      "-t",
      String(duration),
      "-vn",
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      outputPath,
    ],
    ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
  );
  if (result.code !== 0) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("audio_sample_failed");
  }
  const buffer = await fs.promises.readFile(outputPath);
  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  return `data:audio/mpeg;base64,${buffer.toString("base64")}`;
};

const extractSubtitleImageSample = async (payload: { path: string; index: number; external?: boolean }) => {
  if (!ffmpegPath) {
    throw new Error("ffmpeg_not_found");
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sf-sub-image-"));
  const outPath = path.join(tempDir, "sample.jpg");
  const listFrameFiles = async () => {
    const entries = await fs.promises.readdir(tempDir).catch(() => []);
    return entries
      .filter((entry) => /^frame-\d+\.jpg$/i.test(entry))
      .map((entry) => path.join(tempDir, entry))
      .sort();
  };
  const mapCandidates = payload.external
    ? [`0:s:${Math.max(0, payload.index)}`, `0:${Math.max(0, payload.index)}`]
    : [];
  let succeeded = false;
  for (const map of mapCandidates) {
    const seekAttempts = [0, Math.floor(Math.random() * 240)];
    for (const seekSeconds of seekAttempts) {
      const args = [
        "-y",
        ...(seekSeconds > 0 ? ["-ss", String(seekSeconds)] : []),
        "-i",
        payload.path,
        "-map",
        map,
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-f",
        "image2",
        outPath,
      ];
      const result = await runFfmpeg(
        args,
        ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
      ).catch(() => ({ code: 1, stderr: "ffmpeg_failed" }));
      if (result.code !== 0) {
        subtitleSampleLog("map_extract_failed", {
          path: payload.path,
          index: payload.index,
          map,
          seekSeconds,
          code: result.code,
          stderr: tail(result.stderr ?? ""),
        });
        continue;
      }
      const fileSize = (await fs.promises.stat(outPath).catch(() => null))?.size ?? 0;
      if (fileSize < 7000) {
        subtitleSampleLog("map_extract_too_small", {
          path: payload.path,
          index: payload.index,
          map,
          seekSeconds,
          fileSize,
        });
        continue;
      }
      succeeded = true;
      break;
    }
    if (succeeded) break;
  }
  if (!succeeded && !payload.external) {
    const probe = await runFfprobe(
      ["-v", "error", "-show_streams", "-show_format", "-print_format", "json", payload.path],
      ffprobePath ? { ffprobePath } : undefined
    ).catch(() => null);
    const probeData = probe?.data as
      | {
          format?: { duration?: number | string | null };
          streams?: Array<{ duration?: number | string | null }>;
        }
      | undefined;
    const duration = Number(probeData?.format?.duration ?? probeData?.streams?.[0]?.duration ?? 0);
    const attempts =
      Number.isFinite(duration) && duration > 30
        ? [
            Math.max(0, Math.min(duration - 8, duration * 0.08)),
            Math.max(0, Math.min(duration - 8, duration * 0.22)),
            Math.max(0, Math.min(duration - 8, duration * 0.38)),
            Math.max(0, Math.min(duration - 8, duration * 0.52)),
            Math.max(0, Math.min(duration - 8, duration * 0.68)),
            Math.max(0, Math.min(duration - 8, duration * 0.82)),
            Math.max(0, Math.min(duration - 8, duration * (0.1 + Math.random() * 0.75))),
            Math.max(0, Math.min(duration - 8, duration * (0.1 + Math.random() * 0.75))),
            Math.max(0, Math.min(duration - 8, duration * (0.1 + Math.random() * 0.75))),
            Math.max(0, Math.min(duration - 8, duration * (0.1 + Math.random() * 0.75))),
            0,
          ]
        : [0, 20, 60, 120, 180, 240, Math.random() * 240, Math.random() * 240];
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const seekTime = attempts[attemptIndex] ?? 0;
      const overlayPattern = path.join(tempDir, `embed-${attemptIndex}-%05d.png`);
      const result = await runFfmpeg(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=size=1920x1080:rate=8:color=black",
          ...(seekTime > 0 ? ["-ss", String(seekTime)] : []),
          "-i",
          payload.path,
          "-filter_complex",
          `[0:v][1:s:${Math.max(0, payload.index)}]overlay`,
          "-frames:v",
          "480",
          "-f",
          "image2",
          overlayPattern,
        ],
        ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
      );
      if (result.code !== 0) continue;
      const entries = await fs.promises.readdir(tempDir).catch(() => []);
      const frames = entries
        .filter((entry) => entry.startsWith(`embed-${attemptIndex}-`) && entry.endsWith(".png"))
        .map((entry) => path.join(tempDir, entry));
      if (!frames.length) continue;
      const scored = await Promise.all(
        frames.map(async (frame) => ({
          frame,
          size: (await fs.promises.stat(frame).catch(() => null))?.size ?? 0,
        }))
      );
      const chosen = pickLikelySubtitleFrame(scored);
      if (!chosen) {
        subtitleSampleLog("embedded_overlay_no_usable_frame", {
          path: payload.path,
          index: payload.index,
          seekTime,
          frameCount: frames.length,
          maxSize: scored.sort((a, b) => b.size - a.size)[0]?.size ?? 0,
        });
        continue;
      }
      const pickedBuffer = await fs.promises.readFile(chosen).catch(() => null);
      if (pickedBuffer) {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        return `data:image/png;base64,${pickedBuffer.toString("base64")}`;
      }
    }
  }
  if (!succeeded && payload.external) {
    // Try PGS-focused extraction path used by SUP decode.
    const pgsPattern = path.join(tempDir, "frame-%05d.jpg");
    const pgsFallback = await runFfmpeg(
      [
        "-y",
        "-f",
        "sup",
        "-i",
        payload.path,
        "-map",
        "0:s:0",
        "-fps_mode",
        "vfr",
        "-c:v",
        "mjpeg",
        "-frames:v",
        "12",
        "-f",
        "image2",
        pgsPattern,
      ],
      ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
    ).catch(() => ({ code: 1, stderr: "ffmpeg_failed" }));
    if (pgsFallback.code === 0) {
      const frames = await listFrameFiles();
      if (frames.length > 0) {
        const start = Math.min(frames.length - 1, Math.floor(frames.length * 0.15));
        const end = Math.max(start, Math.floor(frames.length * 0.85) - 1);
        const pick = start + Math.floor(Math.random() * (end - start + 1));
        const chosen = frames[pick] ?? frames[Math.floor(frames.length / 2)] ?? frames[0];
        const pickedBuffer = await fs.promises.readFile(chosen).catch(() => null);
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        if (pickedBuffer) {
          return `data:image/jpeg;base64,${pickedBuffer.toString("base64")}`;
        }
      }
    }
  }
  if (!succeeded && payload.external) {
    // Fallback for raw/quirky bitmap subtitle inputs (.sup, vobsub...) where -map can fail:
    // render a short frame sequence and pick a non-edge sample.
    const sequencePattern = path.join(tempDir, "frame-%05d.jpg");
    const fallback = await runFfmpeg(
      [
        "-y",
        "-i",
        payload.path,
        "-frames:v",
        "24",
        "-f",
        "image2",
        sequencePattern,
      ],
      ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
    ).catch(() => ({ code: 1, stderr: "ffmpeg_failed" }));
    if (fallback.code === 0) {
      const frames = await listFrameFiles();
      if (frames.length > 0) {
        const start = Math.min(frames.length - 1, Math.floor(frames.length * 0.15));
        const end = Math.max(start, Math.floor(frames.length * 0.85) - 1);
        const pick = start + Math.floor(Math.random() * (end - start + 1));
        const chosen = frames[pick] ?? frames[Math.floor(frames.length / 2)] ?? frames[0];
        const pickedBuffer = await fs.promises.readFile(chosen).catch(() => null);
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        if (pickedBuffer) {
          return `data:image/jpeg;base64,${pickedBuffer.toString("base64")}`;
        }
      }
    }
  }
  if (!succeeded && payload.external) {
    // Final fallback for raw SUP/PGS: render subtitles over a blank video stream.
    // This works even when subtitle->image mapping cannot pick a video encoder directly.
    const overlayPattern = path.join(tempDir, "frame-%05d.png");
    const probe = await runFfprobe(
      ["-v", "error", "-show_streams", "-print_format", "json", payload.path],
      ffprobePath ? { ffprobePath } : undefined
    ).catch(() => null);
    const startTime = Number(probe?.streams?.[0]?.start_time ?? 0);
    const seekTime = Number.isFinite(startTime) && startTime > 0 ? Math.max(0, startTime + 2) : 0;
    const overlayResult = await runFfmpeg(
      [
        "-y",
        "-ss",
        String(seekTime),
        "-f",
        "lavfi",
        "-i",
        "color=size=1920x1080:rate=1:color=black",
        "-f",
        "sup",
        "-i",
        payload.path,
        "-filter_complex",
        "[0:v][1:s]overlay",
        "-frames:v",
        "20",
        "-f",
        "image2",
        overlayPattern,
      ],
      ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
    ).catch(() => ({ code: 1, stderr: "ffmpeg_failed" }));
    if (overlayResult.code === 0) {
      const entries = await fs.promises.readdir(tempDir).catch(() => []);
      const frames = entries
        .filter((entry) => /^frame-\d+\.png$/i.test(entry))
        .map((entry) => path.join(tempDir, entry));
      if (frames.length > 0) {
        const scored = await Promise.all(
          frames.map(async (frame) => ({
            frame,
            size: (await fs.promises.stat(frame).catch(() => null))?.size ?? 0,
          }))
        );
        const chosen = pickLikelySubtitleFrame(scored) ?? frames[Math.floor(frames.length / 2)];
        const pickedBuffer = await fs.promises.readFile(chosen).catch(() => null);
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        if (pickedBuffer) {
          return `data:image/png;base64,${pickedBuffer.toString("base64")}`;
        }
      }
    }
  }
  if (!succeeded) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    return "";
  }
  const buffer = await fs.promises.readFile(outPath).catch(() => null);
  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  if (!buffer) return "";
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
};

const pickLikelySubtitleFrame = (scores: Array<{ frame: string; size: number }>) => {
  if (!scores.length) return null;
  const ranked = [...scores].sort((a, b) => b.size - a.size);
  const max = ranked[0]?.size ?? 0;
  const min = ranked[ranked.length - 1]?.size ?? 0;
  const median = ranked[Math.floor(ranked.length / 2)]?.size ?? max;
  const dynamicFloor = Math.max(6000, Math.floor(median * 1.15));
  const candidates = ranked.filter((item) => item.size >= dynamicFloor && item.size >= max * 0.6);
  if (!candidates.length) {
    const looksEmpty = max < 7000 || (min > 0 && max / min < 1.08);
    if (looksEmpty) return null;
    return ranked[0]?.frame ?? null;
  }
  const pool = candidates.slice(0, Math.min(4, candidates.length));
  return pool[Math.floor(Math.random() * pool.length)]?.frame ?? ranked[0]?.frame ?? null;
};

const extractSupOverlaySample = async (supPath: string, preferredSeekSeconds?: number) => {
  if (!ffmpegPath) {
    throw new Error("ffmpeg_not_found");
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sf-sup-overlay-"));
  try {
    const outPattern = path.join(tempDir, "frame-%05d.png");
    const probe = await runFfprobe(
      ["-v", "error", "-show_streams", "-print_format", "json", supPath],
      ffprobePath ? { ffprobePath } : undefined
    ).catch(() => null);
    const startTime = Number(probe?.streams?.[0]?.start_time ?? 0);
    const duration = Number(probe?.streams?.[0]?.duration ?? 0);
    const attempts: number[] = [];
    if (Number.isFinite(preferredSeekSeconds ?? NaN)) {
      attempts.push(Math.max(0, Number(preferredSeekSeconds)));
    }
    if (Number.isFinite(duration) && duration > 30) {
      attempts.push(Math.max(0, Math.min(duration - 8, duration * (0.1 + Math.random() * 0.75))));
      attempts.push(Math.max(0, Math.min(duration - 8, duration * (0.1 + Math.random() * 0.75))));
    } else if (Number.isFinite(startTime) && startTime > 0) {
      attempts.push(Math.max(0, startTime + 2 + Math.random() * 90));
    } else {
      attempts.push(Math.random() * 180);
      attempts.push(Math.random() * 180);
    }
    attempts.push(0);

    for (const seekTime of attempts) {
      const result = await runFfmpeg(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=size=1920x1080:rate=1:color=black",
          "-ss",
          String(seekTime),
          "-f",
          "sup",
          "-i",
          supPath,
          "-filter_complex",
          "[0:v][1:s]overlay",
          "-frames:v",
          "20",
          "-f",
          "image2",
          outPattern,
        ],
        ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
      );
      if (result.code !== 0) continue;
      const entries = await fs.promises.readdir(tempDir).catch(() => []);
      const frames = entries
        .filter((entry) => /^frame-\d+\.png$/i.test(entry))
        .map((entry) => path.join(tempDir, entry));
      if (!frames.length) continue;
      const scored = await Promise.all(
        frames.map(async (frame) => ({
          frame,
          size: (await fs.promises.stat(frame).catch(() => null))?.size ?? 0,
        }))
      );
      const chosen = pickLikelySubtitleFrame(scored);
      if (!chosen) continue;
      const pickedBuffer = await fs.promises.readFile(chosen).catch(() => null);
      if (pickedBuffer) {
        return `data:image/png;base64,${pickedBuffer.toString("base64")}`;
      }
    }
    return "";
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const sampleSubtitleText = async (payload: { path: string; index?: number; external?: boolean; sampleIndex?: number }) => {
  if (!ffmpegPath) {
    throw new Error("ffmpeg_not_found");
  }
  const sampleIndex = Math.max(0, payload.sampleIndex ?? 0);
  const fractions = [0.12, 0.28, 0.44, 0.6, 0.76, 0.9];
  const pickFraction = (index: number) => fractions[index % fractions.length] ?? 0.5;
  const toTextLines = (raw: string) =>
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^\d+$/.test(line))
      .filter((line) => !/^\d{2}:\d{2}:\d{2}/.test(line))
      .filter((line) => !/^WEBVTT/i.test(line));
  const pickSnippetByIndex = (lines: string[], index: number) => {
    if (!lines.length) return "";
    const windowSize = 8;
    if (lines.length <= windowSize) return lines.join(" ");
    const minIndex = Math.max(0, Math.floor(lines.length * 0.1));
    const maxIndex = Math.max(minIndex, Math.floor(lines.length * 0.9) - 1);
    const span = Math.max(1, maxIndex - minIndex + 1);
    const anchor = minIndex + Math.floor((span - 1) * pickFraction(index));
    const start = Math.max(0, Math.min(lines.length - windowSize, anchor - Math.floor(windowSize / 2)));
    return lines.slice(start, start + windowSize).join(" ");
  };
  const readSnippet = async (subtitlePath: string, index: number) => {
    const raw = await fs.promises.readFile(subtitlePath, "utf8");
    return pickSnippetByIndex(toTextLines(raw), index);
  };

  const bitmapCodecs = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "vobsub", "dvb_subtitle"]);
  const detectCodec = async () => {
    if (!ffprobePath) return "";
    const argsBase = ["-v", "error", "-show_streams", "-print_format", "json", payload.path];
    const streamInfo = await runFfprobe(
      ["-v", "error", "-select_streams", `s:${Math.max(0, payload.index ?? 0)}`, "-show_streams", "-print_format", "json", payload.path],
      ffprobePath ? { ffprobePath } : undefined
    ).catch(() => null);
    const selected = String(streamInfo?.streams?.[0]?.codec_name ?? "");
    if (selected) return selected;
    const fallback = await runFfprobe(argsBase, ffprobePath ? { ffprobePath } : undefined).catch(() => null);
    return String(fallback?.streams?.[0]?.codec_name ?? "");
  };

  if (payload.external) {
    const ext = path.extname(payload.path).toLowerCase();
    const codecName = await detectCodec();
    if (ext === ".sup" || bitmapCodecs.has(codecName)) {
      const deterministicSeekHint = 240 * pickFraction(sampleIndex);
      const overlayImage = await extractSupOverlaySample(payload.path, deterministicSeekHint).catch(() => "");
      if (overlayImage) return { kind: "image", value: overlayImage } as const;
      const image = await extractSubtitleImageSample({
        path: payload.path,
        index: Math.max(0, payload.index ?? 0),
        external: true,
      });
      if (image) return { kind: "image", value: image } as const;
      subtitleSampleLog("external_bitmap_no_image", {
        path: payload.path,
        index: payload.index ?? 0,
        codecName,
      });
      return { kind: "message", value: "No image sample could be generated for this subtitle." } as const;
    }
    try {
      const text = await readSnippet(payload.path, sampleIndex);
      return text
        ? ({ kind: "text", value: text } as const)
        : ({ kind: "message", value: "No readable subtitle text found." } as const);
    } catch {
      subtitleSampleLog("external_text_read_failed", {
        path: payload.path,
        index: payload.index ?? 0,
      });
      return { kind: "message", value: "Could not read subtitle sample." } as const;
    }
  }

  const streamInfo = await runFfprobe(
    ["-v", "error", "-select_streams", `s:${Math.max(0, payload.index ?? 0)}`, "-show_streams", "-print_format", "json", payload.path],
    ffprobePath ? { ffprobePath } : undefined
  ).catch(() => null);
  const codecName = String(streamInfo?.streams?.[0]?.codec_name ?? "");
  const durationSeconds = Number(streamInfo?.streams?.[0]?.duration ?? 0);
  if (bitmapCodecs.has(codecName)) {
    const image = await extractSubtitleImageSample({ path: payload.path, index: Math.max(0, payload.index ?? 0) });
    if (image) return { kind: "image", value: image } as const;
    subtitleSampleLog("embedded_bitmap_no_image", {
      path: payload.path,
      index: payload.index ?? 0,
      codecName,
    });
    return { kind: "message", value: "No image sample could be generated for this subtitle stream." } as const;
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sf-sub-sample-"));
  const outPath = path.join(tempDir, "sample.srt");
  const sampleStart =
    Number.isFinite(durationSeconds) && durationSeconds > 30
      ? Math.max(0, Math.min(durationSeconds - 20, durationSeconds * pickFraction(sampleIndex)))
      : 0;
  const result = await runFfmpeg(
    [
      "-y",
      "-ss",
      String(sampleStart),
      "-i",
      payload.path,
      "-map",
      `0:s:${Math.max(0, payload.index ?? 0)}`,
      "-t",
      "180",
      "-c:s",
      "srt",
      outPath,
    ],
    ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
  );
  if (result.code !== 0) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    return { kind: "message", value: "No readable subtitle sample could be generated." } as const;
  }
  const snippet = await readSnippet(outPath, sampleIndex).catch(() => "");
  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  return snippet
    ? ({ kind: "text", value: snippet } as const)
    : ({ kind: "message", value: "No readable subtitle text found." } as const);
};

const decodeSupSubtitles = async (url: string, preview = false): Promise<SubtitleImageCue[]> => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sf-sup-"));
  const supPath = path.join(tempDir, "subtitle.sup");
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("sup_download_failed");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(supPath, buffer);

    const packetResult = await runFfprobe(
      [
      "-v",
      "error",
      "-select_streams",
      "s:0",
      "-show_packets",
      "-print_format",
      "json",
      supPath,
      ],
      ffprobePath ? { ffprobePath } : undefined
    );
    const packetData = packetResult.data as { packets?: Array<{ pts_time?: number | string; duration_time?: number | string }> };
    const packets = Array.isArray(packetData.packets) ? packetData.packets : [];
    const packetTimes = packets.map((packet: any) => ({
      startMs: Number(packet.pts_time ?? 0) * 1000,
      durationMs: Number(packet.duration_time ?? 0) * 1000,
    }));

    const outputPattern = path.join(tempDir, "img-%05d.jpg");
    const ffmpegArgs = [
      "-y",
      "-i",
      supPath,
      "-map",
      "0:s:0",
      "-fps_mode",
      "vfr",
      "-c:v",
      "mjpeg",
      ...(preview ? ["-frames:v", "5"] : []),
      "-f",
      "image2",
      outputPattern,
    ];
    const result = await runFfmpeg(
      ffmpegArgs,
      ffmpegPath ? { progress: { enabled: false }, ffmpegPath } : { progress: { enabled: false } }
    );
    if (result.code !== 0) {
      throw new Error("sup_decode_failed");
    }

    const images = (await fs.promises.readdir(tempDir))
      .filter((name) => name.startsWith("img-") && name.endsWith(".jpg"))
      .sort();
    if (images.length === 0) {
      throw new Error("sup_decode_no_frames");
    }
    const cues: SubtitleImageCue[] = [];
    const total = packetTimes.length ? Math.min(images.length, packetTimes.length) : images.length;
    for (let i = 0; i < total; i += 1) {
      const imagePath = path.join(tempDir, images[i]);
      const imageBuffer = await fs.promises.readFile(imagePath);
      const packet = packetTimes[i] ?? { startMs: i * 2000, durationMs: 2000 };
      const next = packetTimes[i + 1]?.startMs;
      const endMs =
        packet.durationMs > 0 ? packet.startMs + packet.durationMs : next ? next : packet.startMs + 2000;
      cues.push({
        startMs: Math.max(0, Math.floor(packet.startMs)),
        endMs: Math.max(0, Math.floor(endMs)),
        imageBase64: imageBuffer.toString("base64"),
      });
    }
    return cues;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

// Close-to-tray flush handshake (issue #25; main side: src/main/rendererFlush.ts).
// win.destroy() skips pagehide, so main sends "sf-window-flush-request" first:
// run every registered callback synchronously, then ack with the request id and
// how many callbacks ran (main records it; the renderer console dies with the window).
const beforeWindowDestroyCallbacks = new Set<() => void>();
ipcRenderer.on("sf-window-flush-request", (_event, requestId: unknown) => {
  const callbacks = beforeWindowDestroyCallbacks.size;
  console.info(`[sf-window-flush] request=${String(requestId)} callbacks=${callbacks}`);
  for (const callback of beforeWindowDestroyCallbacks) {
    try {
      callback();
    } catch (error) {
      console.error("[sf-window-flush] callback failed", error);
    }
  }
  ipcRenderer.send("sf-window-flush-done", requestId, { callbacks });
});

// #25: the main-process copy of the signed-in session, read synchronously once at
// preload time so it exists before any renderer module reads localStorage.
const sessionSnapshot = (() => {
  try {
    return sanitizeSessionEntries(ipcRenderer.sendSync(SESSION_SNAPSHOT_CHANNEL));
  } catch (error) {
    console.error("[session-store] snapshot unavailable", error);
    return {};
  }
})();

// REL-CD-29: the build identity main worked out, read once so the window states the same build on its API calls.
const clientIdentity = (() => {
  try {
    return ipcRenderer.sendSync(CLIENT_IDENTITY_CHANNEL) ?? null;
  } catch (error) {
    console.error("[client-identity] unavailable", error);
    return null;
  }
})();

contextBridge.exposeInMainWorld("sf", {
  version: "0.1.60",
  clientIdentity,
  // REL-CD-29: a "please update" refusal the runtime got on its own API call, forwarded by main.
  onAppUpdateRequired: (callback: (refusal: { status: number; payload: Record<string, unknown> }) => void) => {
    const handler = (_event: unknown, refusal: { status: number; payload: Record<string, unknown> }) => callback(refusal);
    ipcRenderer.on("sf-app-update-required", handler);
    return () => ipcRenderer.removeListener("sf-app-update-required", handler);
  },
  // STOR-UNIT-01: the storage unit base main worked out (1000 or 1024), set by the renderer before its first render.
  storageUnitBase: readStorageUnitBase(ipcRenderer),
  // Test seam: lets the renderer install its perf probe (ultimate stress suite).
  e2ePerfEnabled: process.env.SF_E2E_PERF === "1",
  // Test seam: harnesses export SF_FIRST_TOUR=off so the first-open tour and the player tip (UX-TOUR-01..03) never
  // cover a UI test.
  firstTourOff: process.env.SF_FIRST_TOUR === "off",
  // Test seam: harnesses export SF_PROFILE_SETUP=off so "Your profile" and "New in this update" (UX-SETUP-10,
  // UX-UPDATE-01) never cover a UI test; e2e/profile-setup unsets it.
  profileSetupOff: process.env.SF_PROFILE_SETUP === "off",
  getPlaybackBaseUrl: () => ipcRenderer.invoke("sf-playback-base-url"),
  setPlaybackToken: (token: string | null) => ipcRenderer.invoke("sf-playback-set-token", token),
  setAuthToken: (token: string | null) => ipcRenderer.invoke("sf-auth-set-token", token),
  setMediaKey: (key: string | null) => ipcRenderer.invoke("sf-media-set-key", key),
  forwardKeyToRuntime: (userId: string, keyBase64: string) =>
    ipcRenderer.invoke("sf-media-forward-key-to-runtime", { userId, keyBase64 }),
  resetPlaybackSignedUrlMetrics: () => ipcRenderer.invoke("sf-playback-signed-urls-reset"),
  getPlaybackSignedUrlMetrics: () => ipcRenderer.invoke("sf-playback-signed-urls-stats"),
  createPlaybackStream: (payload: {
    initKey: string;
    initSize: number;
    chunks: Array<{ key: string; sizeBytes: number }>;
    contentType: string;
  }) => ipcRenderer.invoke("sf-playback-stream-create", payload),
  releasePlaybackStream: (streamId: string) => ipcRenderer.invoke("sf-playback-stream-release", streamId),
  createPlaybackHlsSession: (payload: {
    mode?: "vod" | "event";
    videos: Array<{
      id: string;
      quality: string;
      bitrateKbps: number | null;
      width: number | null;
      height: number | null;
      track: { initKey: string; codecString: string | null; segments: Array<{ key: string; durationSeconds: number }> };
    }>;
    audio: Array<{
      id: string;
      language: string;
      label: string;
      isDefault: boolean;
      track: { initKey: string; codecString: string | null; segments: Array<{ key: string; durationSeconds: number }> };
    }>;
  }) => ipcRenderer.invoke("sf-playback-hls-create", payload),
  releasePlaybackHlsSession: (sessionId: string) => ipcRenderer.invoke("sf-playback-hls-release", sessionId),
  // Auto quality (#25): upstream link estimate measured in main.
  getPlaybackLinkEstimate: (): Promise<{
    bps: number;
    sampleCount: number;
    updatedAtMs: number | null;
    throttleKbps: number;
  }> => ipcRenderer.invoke("sf-playback-link-estimate"),
  // STOR-BW-07, STOR-BW-08, PLAY-QUAL-07: saturation state of the silo serving the playback, read and pushed.
  getPlaybackSaturationState: (): Promise<PlaybackSaturationState> => ipcRenderer.invoke("sf-playback-saturation-state"),
  onPlaybackSaturationChange: (callback: (state: PlaybackSaturationState) => void) => {
    const handler = (_event: unknown, state: PlaybackSaturationState) => callback(state);
    ipcRenderer.on("sf-playback-saturation", handler);
    return () => ipcRenderer.removeListener("sf-playback-saturation", handler);
  },
  reportPlaybackStopped: (): Promise<void> => ipcRenderer.invoke("sf-playback-saturation-stop"),
  // Offline playback (OFFL-FILE-03): an HLS session over the pieces saved on this device. `manifestPath` is the
  // localPath of the runtime's list_local entry; main checks it sits in the offline dir. Release with
  // releasePlaybackHlsSession. Works with the backend/runtime unreachable.
  createPlaybackOfflineHlsSession: (payload: {
    fileId: string;
    manifestPath: string;
  }): Promise<{ id: string; url: string; subtitleKeys: string[] }> =>
    ipcRenderer.invoke("sf-playback-offline-hls-create", payload),
  // Pre-warm chunks at the resume offset BEFORE launching mpv. The proxy
  // fetches init segments + the segment at startSeconds via the tunnel and
  // caches them, so mpv's first read latency is microseconds instead of
  // hundreds of ms (which would otherwise trip mpv's HLS-stream-error
  // retry loop and cause the user-observed segment loop on Resume).
  // @bugfix mpv-launch-loop-cold-hls-proxy
  prewarmPlaybackHlsSession: (payload: {
    sessionId: string;
    videoId?: string | null;
    audioId?: string | null;
    startSeconds?: number | null;
  }): Promise<{ warmedKeys: string[]; missedKeys: string[]; elapsedMs: number }> =>
    ipcRenderer.invoke("sf-playback-hls-prewarm", payload),
  getMpvFlags: () => {
    const rawExternal = process.env.SF_MPV_EXTERNAL?.trim();
    const externalPlayer = rawExternal ? rawExternal === "1" : true;
    return {
      smokeTest: process.env.SF_MPV_SMOKE_TEST === "1",
      externalPlayer,
    };
  },
  hideAppWindow: () => ipcRenderer.invoke("sf-app-hide"),
  showAppWindow: () => ipcRenderer.invoke("sf-app-show"),
  /**
   * Main's hidden/visible flag for the app window (issue #25 P19/M7).
   * `backgroundThrottling: false` keeps `document.visibilityState` "visible"
   * after `win.hide()`, so this IPC is the renderer's only hidden signal.
   */
  getAppWindowVisibility: () =>
    ipcRenderer.invoke("sf-app-window-visibility-get") as Promise<AppWindowVisibilityState | null>,
  onAppWindowVisibility: (callback: (state: AppWindowVisibilityState) => void) => {
    const handler = (_event: unknown, state: AppWindowVisibilityState) => callback(state);
    ipcRenderer.on("sf-app-window-visibility", handler);
    return () => ipcRenderer.removeListener("sf-app-window-visibility", handler);
  },
  /** Every Escape key press of the window, whichever frame it went to (LIB-DETAIL-06, main's `escapeKeyForward.ts`). */
  onEscapeKey: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("sf-escape-key", handler);
    return () => ipcRenderer.removeListener("sf-escape-key", handler);
  },
  signalPlaybackReady: () => ipcRenderer.invoke("sf-mpv-playback-ready"),
  launchExternalMpv: (payload: {
    url: string;
    audioUrl?: string | null;
    backdropUrl?: string | null;
    startTime?: number | null;
    paused?: boolean;
    hlsBitrateBps?: number | null;
    /** PLAY-TRACK-04: per-load tracks for a launch on the stream itself (#2762). */
    audioTrack?: number | "no" | null;
    subtitleTrack?: number | "no" | null;
  }) => ipcRenderer.invoke("sf-mpv-external-play", payload),
  cacheExternalMpvSubtitles: (payload: SubtitleEntry[], options?: { cachedOnly?: boolean }) =>
    ipcRenderer.invoke("sf-mpv-cache-subtitles", payload, options),
  clearExternalMpvSubtitleCache: () => ipcRenderer.invoke("sf-mpv-clear-subtitle-cache"),
  // MPV-PREV-01: the playing video's seek-bar preview record (source format `previewSheets`, null = none).
  // MPV-PREV-06: `missing` {formatId, hint} for the "Previews are being prepared" line when there is no record.
  setExternalMpvPreviewSheets: (previewSheets: unknown, missing?: { formatId: string | null; hint: string }) =>
    ipcRenderer.invoke("sf-mpv-preview-sheets", previewSheets, missing),
  getFfmpegCapabilities: () => ipcRenderer.invoke("sf-ffmpeg-capabilities"),
  testFfmpegEncoder: (encoder?: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu") =>
    ipcRenderer.invoke("sf-ffmpeg-capabilities-test", encoder),
  uploadSubtitleFile: (payload: { token: string; path: string; placementId?: string | null }) =>
    ipcRenderer.invoke("sf-upload-subtitle", payload),
  uploadSubtitleContent: (payload: { token: string; content: string; format: string; placementId?: string | null }) =>
    ipcRenderer.invoke("sf-upload-subtitle-content", payload),
  pickSubtitleFile: () => ipcRenderer.invoke("sf-pick-subtitle-file"),
  sendExternalMpvCommand: (command: MpvCommand): Promise<MpvResponse> =>
    ipcRenderer.invoke("sf-mpv-external-command", command),
  sendExternalMpvRequest: (command: MpvCommand): Promise<MpvResponse> =>
    ipcRenderer.invoke("sf-mpv-external-request", command),
  stopExternalMpv: () => {
    return ipcRenderer.invoke("sf-mpv-external-stop");
  },
  isExternalMpvAlive: () => {
    return ipcRenderer.invoke("sf-mpv-external-alive") as Promise<boolean>;
  },
  warmExternalMpv: () => ipcRenderer.invoke("sf-mpv-warm") as Promise<void>,
  /**
   * Multiplexed external-mpv event subscription. Tier-4 retired
   * `onExternalMpvExit` and `onExternalMpvOscAction` in favor of a single
   * channel carrying an `MpvExternalMessage` discriminated union.
   * Renderer consumers switch on `msg.type` and handle exit / osc_action
   * / property_change variants. All subscribers share one ipc listener
   * (`createIpcFanout`), so the player stack never trips MaxListeners.
   */
  onMpvExternalMessage: subscribeMpvExternalMessage,
  /**
   * Pull the last osc_action the main process retained, if any (durable
   * delivery — @bugfix next-episode-osc-action-dropped-on-listener-churn). A
   * renderer calls this right after (re)subscribing so a next_episode action
   * delivered while its listener was detached (a render-churn teardown window),
   * or fired before the listener mounted, is recovered instead of lost.
   * Deduped by `seq`; ack on handle to clear it.
   */
  getPendingOscAction: () =>
    ipcRenderer.invoke("sf-get-pending-osc-action") as Promise<{ action: OscActionFile; seq: number } | null>,
  ackOscAction: (seq: number) => ipcRenderer.send("sf-ack-osc-action", seq),
  /**
   * E2E-only: seed a pending osc_action in main WITHOUT a live emit, simulating
   * one dropped in a teardown window. No-op in production (the main handler is
   * only registered when SF_E2E=1). Returns the assigned monotonic seq.
   */
  __e2eSetPendingOscAction: (action: OscActionFile) =>
    ipcRenderer.invoke("sf-e2e-set-pending-osc-action", action) as Promise<number>,
  libraryDb: {
    open: (payload: { token: string; keyBase64: string; userId: string }) => ipcRenderer.invoke("sf-library-db-open", payload),
    openLocal: (payload: { token: string; keyBase64: string; userId: string }) => ipcRenderer.invoke("sf-library-db-open-local", payload),
    sealLocalCacheForRotation: (payload: { token: string; newKeyBase64: string }) =>
      ipcRenderer.invoke("sf-library-db-seal-local-cache-for-rotation", payload),
    // PRIV-KEY-06: a key rotation re-encrypts every other app's library first (main/libraryRotationIpc.ts);
    // STOR-RESEAL-01: with their media references renamed to the re-sealed copies.
    reencryptForRotation: (payload: { token: string; oldKeyBase64: string; newKeyBase64: string; resealCopies?: Array<[string, string]> }) =>
      ipcRenderer.invoke("sf-library-db-reencrypt-for-rotation", payload),
    hasLocalCache: () => ipcRenderer.invoke("sf-library-db-has-local-cache"),
    clearLocalCache: () => ipcRenderer.invoke("sf-library-db-clear-local-cache"),
    // ACCT-SQUAD-02 / UX-PROF-01: "Who's watching?" may answer before the library opens, when the generic call is
    // still refused; main keeps the choice and applies it to every library it opens until sign-out.
    setActiveProfile: (profile: { id: string; isMain: boolean } | null) => ipcRenderer.invoke("sf-library-db-set-active-profile", profile),
    call: async (payload: { handle?: string; method: string; args?: unknown[] }) => {
      const result = await ipcRenderer.invoke("sf-library-db-call", payload);
      if (result && typeof result === "object" && "__sfIpcError" in result) {
        throw new Error((result as { __sfIpcError: string }).__sfIpcError);
      }
      return result;
    },
    snapshot: async () => {
      const result = await ipcRenderer.invoke("sf-library-db-call", { method: "getSnapshot" });
      if (result && typeof result === "object" && "__sfIpcError" in result) {
        throw new Error((result as { __sfIpcError: string }).__sfIpcError);
      }
      return result;
    },
    onSnapshot: (callback: (payload: unknown) => void) => {
      // Phase 6: main now sends `{ snapshot, version }` instead of bare
      // snapshot. The renderer-side adapter inspects payload shape and
      // accepts both forms for back-compat with older preloads. We
      // forward the IPC arg verbatim — no shape coercion in the preload.
      const handler = (_event: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on("sf-library-db-snapshot", handler);
      return () => ipcRenderer.removeListener("sf-library-db-snapshot", handler);
    },
    onDatasetStatus: (callback: (status: unknown) => void) => {
      const handler = (_event: unknown, status: unknown) => callback(status);
      ipcRenderer.on("sf-library-db-dataset-status", handler);
      return () => ipcRenderer.removeListener("sf-library-db-dataset-status", handler);
    },
  },
  runtime: {
    getStatus: () => ipcRenderer.invoke("sf-runtime-status-get"),
    onStatusChange: (callback: (payload: { status: string }) => void) => {
      const handler = (_event: unknown, payload: { status: string }) => callback(payload);
      ipcRenderer.on("sf-runtime-status", handler);
      return () => ipcRenderer.removeListener("sf-runtime-status", handler);
    },
    restart: () => ipcRenderer.invoke("sf-runtime-restart"),
    getBaseUrl: () => ipcRenderer.invoke("sf-runtime-base-url-get"),
    getOwnerSecret: () => ipcRenderer.invoke("sf-runtime-owner-secret-get"),
  },
  session: {
    snapshot: sessionSnapshot,
    replace: (entries: Record<string, string>) => ipcRenderer.invoke(SESSION_REPLACE_CHANNEL, entries),
  },
  toolAccess: {
    getSnapshot: () => ipcRenderer.invoke("sf-tool-access-snapshot"),
    decide: (payload: { requestId: string; decision: "approve" | "deny"; mode?: "read" | "write" }) =>
      ipcRenderer.invoke("sf-tool-access-decide", payload),
    revoke: (grantId: string) => ipcRenderer.invoke("sf-tool-access-revoke", { grantId }),
    onUpdate: (callback: (snapshot: unknown) => void) => {
      const handler = (_event: unknown, snapshot: unknown) => callback(snapshot);
      ipcRenderer.on("sf-tool-access-update", handler);
      return () => ipcRenderer.removeListener("sf-tool-access-update", handler);
    },
  },
  // PLAT-WEB-05: the web player hand-off (main/handoffIpc.ts). Main asks the renderer to play; the renderer reports a
  // playback it could not start. `takePending` returns a play sent while the page was still loading.
  handoff: {
    onPlay: (callback: (request: { handoffId: string; mediaId: string }) => void) => {
      const handler = (_event: unknown, request: { handoffId: string; mediaId: string }) => callback(request);
      ipcRenderer.on("sf-handoff-play", handler);
      return () => ipcRenderer.removeListener("sf-handoff-play", handler);
    },
    takePending: () => ipcRenderer.invoke("sf-handoff-pending"),
    reportFailed: (payload: { handoffId: string; error: string }) => ipcRenderer.invoke("sf-handoff-failed", payload),
  },
  // ACCT-PAY-05: main hands over `badger://billing/return?payment=<id>`; the plan change checks that payment at once.
  billing: {
    onPaymentReturn: (callback: (paymentId: string) => void) => {
      const handler = (_event: unknown, paymentId: string) => callback(paymentId);
      ipcRenderer.on("sf-billing-payment-return", handler);
      return () => ipcRenderer.removeListener("sf-billing-payment-return", handler);
    },
  },
  // ACCT-SIGNIN-05: a Google, Apple or Microsoft sign-in came back through `badger://auth/provider`. Main nudges on
  // `onReturn`; `takeReturn` hands over the outcome once (also the one that came before this page listened).
  providerSignIn: {
    onReturn: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(PROVIDER_RETURN_IPC.returned, handler);
      return () => ipcRenderer.removeListener(PROVIDER_RETURN_IPC.returned, handler);
    },
    takeReturn: (): Promise<ProviderReturn | null> => ipcRenderer.invoke(PROVIDER_RETURN_IPC.pending),
  },
  deviceSettings: {
    getTranscode: () => ipcRenderer.invoke("sf-device-transcode-get"),
    answerFirstRun: (answer: "accepted" | "overridden") =>
      ipcRenderer.invoke("sf-device-transcode-answer", answer),
    setFallbackCopy: (value: boolean) => ipcRenderer.invoke("sf-device-transcode-set", value),
    getUploadsDuringPlayback: () => ipcRenderer.invoke("sf-device-uploads-playback-get"),
    answerUploadsFirstRun: (answer: UploadsFirstRunAnswer) =>
      ipcRenderer.invoke("sf-device-uploads-playback-answer", answer),
    setUploadsDuringPlayback: (value: UploadsDuringPlayback) =>
      ipcRenderer.invoke("sf-device-uploads-playback-set", value),
    adoptCapacity: (seed: DeviceCapacityValues) => ipcRenderer.invoke("sf-device-capacity-adopt", seed),
    setCapacity: (values: DeviceCapacityValues) => ipcRenderer.invoke("sf-device-capacity-set", values),
  },
  errorReports: createErrorReportsBridge(ipcRenderer),
  runtimeJobs: {
    getStreamUrl: () => ipcRenderer.invoke("sf-runtime-jobs-stream-url"),
    list: (filter?: { mediaId?: string; includeDismissed?: boolean }) =>
      ipcRenderer.invoke("sf-runtime-jobs-list", { filter }),
    cancel: (payload: { jobId: string; reason?: string }) =>
      ipcRenderer.invoke("sf-runtime-jobs-cancel", payload),
    cancelByGroup: (payload: { groupId: string; reason?: string }) =>
      ipcRenderer.invoke("sf-runtime-jobs-cancel-by-group", payload),
    dismiss: (payload: { jobId: string }) =>
      ipcRenderer.invoke("sf-runtime-jobs-dismiss", payload),
    retry: (payload: { jobId: string; mode?: "upload" | "process" }) =>
      ipcRenderer.invoke("sf-runtime-jobs-retry", payload),
    availability: (payload: { jobIds: string[] }) =>
      ipcRenderer.invoke("sf-runtime-jobs-availability", payload),
    findFile: (payload: { jobId: string }) =>
      ipcRenderer.invoke("sf-runtime-jobs-find-file", payload),
    submitSources: (payload: { userId: string; sources: unknown[] }) =>
      ipcRenderer.invoke("sf-runtime-jobs-submit-sources", payload),
    configureScheduling: (payload: {
      maxParallelTranscodes: number;
      maxParallelExtractions: number;
    }) => ipcRenderer.invoke("sf-runtime-jobs-configure-scheduling", payload),
    attachAuth: (payload: { userId: string; token: string }) =>
      ipcRenderer.invoke("sf-badger-runtime-attach-auth", payload),
    replanQualities: (payload: {
      mediaId: string;
      fileId: string;
      addQualities: string[];
      removeFormatIds: string[];
    }) => ipcRenderer.invoke("sf-badger-media-replan-qualities", payload),
  },
  // Offline-mode bridge — typed wrappers for the badger.offline.* runtime
  // commands. The renderer never talks to the runtime directly; main owns
  // the runtime-client session + Zod-validated sendCommand calls. Phase 3
  // of the offline-mode plan (Layer C).
  //
  // v2 additions:
  //   - estimate + downloadSubmit accept an optional `fileIds` narrow-scope
  //     filter (used by episode/season scopes in the renderer).
  //   - deleteLocal accepts a `season` scope variant ({ type:"season",
  //     mediaId, seasonNumber }) for per-season deletion without
  //     over-deleting adjacent seasons.
  offline: {
    estimate: (payload: {
      mediaIds: string[];
      quality?: string;
      container: "mkv" | "mp4";
      fileIds?: string[];
    }) => ipcRenderer.invoke("sf-badger-offline-estimate", payload),
    downloadSubmit: (payload: {
      mediaIds: string[];
      quality?: string;
      container: "mkv" | "mp4";
      skipAlreadyLocal?: boolean;
      fileIds?: string[];
    }) => ipcRenderer.invoke("sf-badger-offline-download-submit", payload),
    deleteLocal: (payload: {
      scope:
        | { type: "media"; mediaId: string }
        | { type: "season"; mediaId: string; seasonNumber: number }
        | { type: "file"; fileId: string };
    }) => ipcRenderer.invoke("sf-badger-offline-delete-local", payload),
    listLocal: (payload: { mediaIds?: string[] } = {}) =>
      ipcRenderer.invoke("sf-badger-offline-list-local", payload),
    reconcile: (payload: { mediaIds?: string[] } = {}) =>
      ipcRenderer.invoke("sf-badger-offline-reconcile", payload),
  },
  exportFiles: {
    pickFolder: () => ipcRenderer.invoke("sf-pick-export-folder"),
    estimate: (payload: BadgerExportEstimatePayload) => ipcRenderer.invoke("sf-badger-export-estimate", payload),
    submit: (payload: BadgerExportSubmitPayload) => ipcRenderer.invoke("sf-badger-export-submit", payload),
  },
  storageGc: {
    run: (payload: { dryRun?: boolean } = {}) =>
      ipcRenderer.invoke("sf-badger-storage-gc", payload),
  },
  pairing: {
    /** `{ mode: "key" }`: the key screen asks another device for the library key only (ACCT-PAIR-01). */
    start: (options?: PairingStartOptions) => ipcRenderer.invoke("sf-pairing-start", options),
    poll: (requestId: string) => ipcRenderer.invoke("sf-pairing-poll", requestId),
    cancel: () => ipcRenderer.invoke("sf-pairing-cancel"),
    /** What this computer calls itself in the account's device list (ACCT-DEV-01). */
    deviceName: () => ipcRenderer.invoke("sf-pairing-device-name"),
  },
  /** ACCT-PAIR-07: "Continue with your Parrot account" when Parrot is signed in on this computer. */
  sibling: {
    offer: () => ipcRenderer.invoke(SIBLING_IPC.offer),
    signIn: () => ipcRenderer.invoke(SIBLING_IPC.signIn),
    cancel: () => ipcRenderer.invoke(SIBLING_IPC.cancel),
  },
  apiHost: {
    get: () => ipcRenderer.invoke("sf-api-base-url-get"),
    set: (payload: { apiBaseUrl?: string | null; baseUrl?: string | null }) =>
      ipcRenderer.invoke("sf-api-base-url-set", payload),
  },
  getDummyManifest: readDummyManifest,
  readDummyObject,
  decodeSupSubtitles,
  probeMedia,
  sampleAudioTrack,
  sampleSubtitleText,
  scanFiles: (paths: string[]) => ipcRenderer.invoke("sf-fs-scan", paths),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openFileDialog: (options: { properties: string[] }) => ipcRenderer.invoke("sf-fs-open-dialog", options),
  setWindowProcessingState: (active: boolean) => ipcRenderer.send("sf-window-processing-state", { active: Boolean(active) }),
  /** The language the window shows (UX-I18N-01); the tray, app menu and native dialogs follow it. */
  reportUiLanguage: (language: string) => ipcRenderer.send("sf-ui-language", language),
  onBeforeWindowDestroy: (callback: () => void) => {
    beforeWindowDestroyCallbacks.add(callback);
    return () => {
      beforeWindowDestroyCallbacks.delete(callback);
    };
  },
  // STOR-BW-11: the server refused the profile named on a playback; the profile store re-reads the list.
  onPlaybackProfileRefused: (callback: (code: string) => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      if (payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string") callback(payload.code);
    };
    ipcRenderer.on("sf-playback-profile-refused", handler);
    return () => ipcRenderer.removeListener("sf-playback-profile-refused", handler);
  },
});

// In-app desktop updater bridge (REL-UPD-01), under its own `spaceBadger` namespace: `window.spaceBadger.updater`.
// The shared bridge from @space/desktop-shell, the same one Parrot exposes.
contextBridge.exposeInMainWorld("spaceBadger", { updater: createUpdaterBridge(ipcRenderer) });
