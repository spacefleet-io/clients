import { advertisedHardwareEncoders, getDesktopPlatform, pickHardwareEncoder } from "@space/desktop-platform";
import { promises as fs } from "node:fs";
import { dirname, join as joinPath, sep } from "node:path";
import {
  createFfmpegTask,
  runFfmpeg,
  runFfprobe,
  type FfprobeStream,
  type FfprobeData,
  type FfprobeResult,
} from "@space/ffmpeg";
// Subpath import (not the barrel) so test suites that `vi.mock("@space/ffmpeg")`
// with a hand-rolled factory keep running the REAL thread/priority policy.
import {
  buildFfmpegThreadArgs,
  resolveFfmpegNiceness,
  resolveFfmpegThreads,
} from "@space/ffmpeg/resourcePolicy";

import { estimateBitrateKbps, guessQualityLabel } from "./labQueueShared";
import { ResumableJobStateStore, type JobState, type OutputState, type SegmentEntry, type SubtitleState } from "@space/content-core";
import { finalizeMediaJob, type ProducedMedia, type ProducedAudioTrack, type ProducedSubtitle, type ProducedVideoFormat } from "./mediaFinalize";
import { defaultCodecForQuality, normalizeSourceCodec, QUALITY_ORDER, type CodecPreset, type QualityPreset, type SourceCodec } from "./quality";
import { UploadSessionManager, uploadEncryptedObjectFile } from "@space/content-core/storageTransport";
import { reclaimOrphanEncoder, releaseEncoderLease, writeEncoderLease } from "./encoderLease";
import { generatePreviewSheets } from "./previewSheets";
import { PREVIEW_SHEETS_VERSION, type MediaPreviewSheets } from "@space/shared/previewSheets";
import type { StorageObjectCounting } from "@space/shared/storageCounting";
import { readAacChannelConfiguration, readAacPceLayout, standardAacLayoutFor } from "./aacChannelLayout";

type MediaIngestRuntime = {
  resolveJobDir?: (userId: string, jobId: string) => string;
  resolveFfmpegPath?: () => string | undefined;
  resolveFfprobePath?: () => string | undefined;
  encryptMediaObject?: (bytes: Buffer) => Buffer;
  uploadStorageObject?: (
    token: string,
    objectKey: string,
    payload: Uint8Array,
    options?: {
      objectNamespace?: string;
      logicalRef?: string;
      contentType?: string;
      chunkSize?: number;
      clientType?: string;
      clientVersion?: string;
      uploadId?: string;
      checksumFn?: (chunk: Uint8Array, seq: number) => string | Promise<string>;
      placementId?: string;
      /** How the object counts toward the allowance (STOR-USE-02). */
      counting?: StorageObjectCounting;
    }
  ) => Promise<string>;
  /** Batched existence check (absent from the result = unknown). */
  headStorageObjects?: (
    token: string,
    objectKeys: string[],
    options?: { signal?: AbortSignal }
  ) => Promise<Record<string, boolean>>;
  getGpuVendor?: () => Promise<string>;
};

let runtime: MediaIngestRuntime = {};

export const configureMediaIngestRuntime = (next: MediaIngestRuntime) => {
  runtime = { ...runtime, ...next };
};

export type { ProducedAudioTrack, ProducedMedia, ProducedSubtitle, ProducedVideoFormat };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SEGMENT_SECONDS_SOURCE = 12;
// Round-12 #6: align fallback (360p) segment duration to the source path. The
// 4s value caused 3× over-chunking — a 622 MB 360p had 3,422 chunks at 180 KB
// each vs the source's 879 chunks at 4 MB. Hurts seek perf + HTTP overhead.
// 12s remains a clean multiple of the 4s GOP cadence in the fallback transcode.
const SEGMENT_SECONDS_FALLBACK = SEGMENT_SECONDS_SOURCE;

const ensureDir = async (path: string) => {
  await fs.mkdir(path, { recursive: true });
};

const exists = async (path: string) => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

const resolveJobDir = (userId: string, jobId: string) =>
  runtime.resolveJobDir?.(userId, jobId) ?? joinPath(process.env.SF_TRANSCODE_DIR ?? "", userId, jobId);

const resolveFfmpegPath = () => {
  const injected = runtime.resolveFfmpegPath?.();
  if (injected) return injected;
  const raw = process.env.SF_FFMPEG_PATH?.trim();
  if (!raw || raw === "undefined" || raw === "null") return undefined;
  return raw;
};
const resolveFfprobePath = () => {
  const injected = runtime.resolveFfprobePath?.();
  if (injected) return injected;
  const raw = process.env.SF_FFPROBE_PATH?.trim();
  if (!raw || raw === "undefined" || raw === "null") return undefined;
  return raw;
};

const parseSegmentTimeline = (mpd: string) => {
  const timescaleMatch = mpd.match(/timescale="(\d+)"/i);
  const timescale = timescaleMatch ? Number(timescaleMatch[1]) : 1;
  const timelineMatch = mpd.match(/<SegmentTimeline[^>]*>([\s\S]*?)<\/SegmentTimeline>/i);
  if (!timelineMatch) return null;
  const timeline = timelineMatch[1];
  const sRegex = /<S\b([^>]*)\/>/gi;
  const segments: Array<{ startUnits: number; durationUnits: number }> = [];
  let current = 0;
  let match = sRegex.exec(timeline);
  while (match) {
    const attrs = match[1];
    const dMatch = attrs.match(/\bd="(\d+)"/i);
    if (!dMatch) {
      match = sRegex.exec(timeline);
      continue;
    }
    const rMatch = attrs.match(/\br="(-?\d+)"/i);
    const tMatch = attrs.match(/\bt="(\d+)"/i);
    const duration = Number(dMatch[1]);
    const repeat = rMatch ? Math.max(0, Number(rMatch[1])) : 0;
    if (tMatch) current = Number(tMatch[1]);
    for (let i = 0; i <= repeat; i += 1) {
      segments.push({ startUnits: current, durationUnits: duration });
      current += duration;
    }
    match = sRegex.exec(timeline);
  }
  if (!segments.length || !Number.isFinite(timescale) || timescale <= 0) return null;
  return segments.map((segment) => ({
    startSeconds: segment.startUnits / timescale,
    durationSeconds: segment.durationUnits / timescale,
  }));
};

const extractCodecStringFromMpd = (mpd: string, kind: "video" | "audio") => {
  const target = kind === "video" ? "video" : "audio";
  const adaptationRegex = new RegExp(
    `<AdaptationSet[^>]*?(?:contentType|mimeType)=[\"']${target}[^>]*>([\\s\\S]*?)<\\/AdaptationSet>`,
    "i"
  );
  const adaptationMatch = mpd.match(adaptationRegex);
  const section = adaptationMatch?.[1] ?? mpd;
  const codecMatch =
    section.match(/codecs="([^"]+)"/i) ??
    section.match(/codecs='([^']+)'/i);
  return codecMatch?.[1] ?? null;
};

const listDashSegments = async (dir: string) => {
  const entries = await fs.readdir(dir);
  const init = entries.find((name) => name.startsWith("init"));
  const segments = entries
    .filter((name) => name.startsWith("seg-") && name.endsWith(".m4s"))
    .sort();
  return { init, segments };
};

const ensureDashOutput = async (output: OutputState) => {
  if (!output.encodingComplete) return false;
  const initPath = output.init?.path;
  if (!initPath || !(await exists(initPath))) return true;
  if (!output.segments.length) return true;
  for (const segment of output.segments) {
    if (!(await exists(segment.path))) return true;
  }
  return false;
};

export const uploadEncryptedFile = async (
  token: string,
  filePath: string,
  options: {
    outputId?: string;
    sessionManager?: UploadSessionManager;
    signal?: AbortSignal;
    /** Per-media silo (#145); every object of one media carries the same id. */
    placementId?: string;
    /** How the object counts toward the allowance (STOR-USE-02). */
    counting?: StorageObjectCounting;
  } = {}
): Promise<{ key: string; sizeBytes: number; checksum: string }> => {
  const encryptBuffer = runtime.encryptMediaObject;
  const uploadStorageObject = runtime.uploadStorageObject;
  if (!encryptBuffer || !uploadStorageObject) {
    throw new Error("INGEST_RUNTIME_NOT_CONFIGURED");
  }
  return uploadEncryptedObjectFile(
    {
      encryptObject: encryptBuffer,
      uploadObject: uploadStorageObject,
    },
    token,
    filePath,
    options
  );
};

/**
 * Seek-bar preview sheets (MPV-PREV-01) of a committed source: made from the local file, then each sheet is
 * encrypted and uploaded on the media's placement (same uploader, pool and retries as the video chunks). Runs after
 * the source commit, so the video is playable before the decode starts. The ffmpeg runs at the encoders' background
 * priority under the playback policy (INGS-LANE-01/02). `onSheetUploaded` reports every stored key as it lands so
 * the caller can release them when this throws (any failure, cancel included); `workDir` is removed either way.
 */
export const producePreviewSheets = async (args: {
  token: string;
  inputPath: string;
  durationSeconds: number | null;
  workDir: string;
  placementId?: string;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  onSheetUploaded?: (key: string) => void;
}): Promise<MediaPreviewSheets> => {
  try {
    const generated = await generatePreviewSheets({
      inputPath: args.inputPath,
      workDir: args.workDir,
      durationSeconds: args.durationSeconds,
      threads: buildFfmpegThreadArgs({ softwareEncoder: true }),
      onLog: args.onLog,
      run: (ffmpegArgs) =>
        runFfmpegWithSignal(
          ffmpegArgs,
          {
            ffmpegPath: resolveFfmpegPath(),
            playbackGated: true,
            progress: { enabled: false },
            log: { onLine: (line) => args.onLog?.(`[preview-sheets] ffmpeg: ${line}`) },
          },
          args.signal
        ),
    });
    const sheets: MediaPreviewSheets["sheets"] = [];
    for (const sheet of generated.sheets) {
      throwIfAborted(args.signal);
      const uploaded = await uploadEncryptedFile(args.token, sheet.path, {
        signal: args.signal,
        placementId: args.placementId,
        counting: { role: "preview" },
      });
      args.onSheetUploaded?.(uploaded.key);
      sheets.push({
        objectKey: uploaded.key,
        sizeBytes: uploaded.sizeBytes,
        firstPicture: sheet.firstPicture,
        pictureCount: sheet.pictureCount,
      });
    }
    args.onLog?.(`[preview-sheets] uploaded sheets=${sheets.length} pictures=${generated.pictureCount}`);
    return {
      version: PREVIEW_SHEETS_VERSION,
      intervalSeconds: generated.intervalSeconds,
      pictureWidth: generated.pictureWidth,
      pictureHeight: generated.pictureHeight,
      columns: generated.columns,
      rows: generated.rows,
      pictureCount: generated.pictureCount,
      sheets,
    };
  } finally {
    await fs.rm(args.workDir, { recursive: true, force: true });
  }
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new Error("CANCELLED");
  }
};

const runFfmpegWithSignal = async (
  args: string[],
  options:
    | {
        ffmpegPath?: string;
        progress?: {
          enabled?: boolean;
          output?: "stdout" | "stderr";
          durationMs?: number | null;
          onUpdate?: (stats: { percent?: number }) => void;
        };
        log?: { onLine?: (line: string, stream: "stdout" | "stderr") => void };
        /** Pipe bytes into ffmpeg's stdin — caller must use pipe:0 in args. */
        stdin?: AsyncIterable<Uint8Array> | null;
        onSpawn?: (child: { pid: number | undefined }) => void;
        /** Obey the playback policy (one core / frozen while a video plays). */
        playbackGated?: boolean;
      }
    | undefined,
  signal?: AbortSignal
) => {
  const task = createFfmpegTask(args, options);
  const abortHandler = () => {
    task.cancel();
  };

  if (signal) {
    if (signal.aborted) {
      task.cancel();
      throw new Error("CANCELLED");
    }
    signal.addEventListener("abort", abortHandler);
  }

  try {
    const result = await task.promise;
    if (signal?.aborted) {
      throw new Error("CANCELLED");
    }
    return result;
  } catch (err) {
    if (signal?.aborted) {
      throw new Error("CANCELLED");
    }
    throw err;
  } finally {
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
};

/**
 * ffmpeg's DASH muxer derives the segment directory from the output URL by
 * splitting on "/" only, so a Windows `C:\\...\\manifest.mpd` made it drop
 * `init-*.mp4` / `seg-*.m4s` into the process cwd. ffmpeg accepts "/" on every
 * OS, so the output URL it gets always uses "/" (still absolute, so the encoder
 * lease can identify the process by its command line). A no-op where the native
 * separator already is "/".
 */
export const toFfmpegOutputUrl = (path: string, separator: string = sep): string =>
  separator === "/" ? path : path.split(separator).join("/");

/**
 * Run a DASH muxer that writes `outputDir`: first reclaim the dir from an
 * orphaned encoder left by a killed runtime (P26, see `encoderLease.ts`),
 * then hold a lease on it for the lifetime of this ffmpeg.
 */
const runDashEncoder = async (
  args: string[],
  outputDir: string,
  mpdPath: string,
  options: NonNullable<Parameters<typeof runFfmpegWithSignal>[1]>,
  signal?: AbortSignal
) => {
  await reclaimOrphanEncoder(outputDir);
  let leasedPid: number | null = null;
  try {
    return await runFfmpegWithSignal(
      args,
      {
        ...options,
        // Every DASH encode (CPU and hardware) is a transcode that competes
        // with video playback: see `encodePlaybackGate` in @space/ffmpeg.
        playbackGated: true,
        onSpawn: ({ pid }) => {
          if (typeof pid !== "number") return;
          leasedPid = pid;
          writeEncoderLease(outputDir, pid, mpdPath);
        },
      },
      signal
    );
  } finally {
    if (leasedPid !== null) releaseEncoderLease(outputDir, leasedPid);
  }
};

/** Hardware encoders — a failure of any of these is recoverable by retrying on CPU. */
export type HardwareVideoEncoder = "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox";
export type VideoEncoder = "copy" | HardwareVideoEncoder | "cpu";

const HARDWARE_ENCODERS = new Set<VideoEncoder>([
  "nvenc",
  "qsv",
  "vaapi",
  "amf",
  "videotoolbox",
]);
const isHardwareEncoder = (encoder: VideoEncoder): encoder is HardwareVideoEncoder =>
  HARDWARE_ENCODERS.has(encoder);

/**
 * Map a quality preset to its target scale height in pixels.
 */
const qualityHeight = (quality: QualityPreset): number => {
  switch (quality) {
    case "2160p": return 2160;
    case "1080p": return 1080;
    case "720p": return 720;
    case "480p": return 480;
    case "360p": return 360;
    case "240p": return 240;
    case "144p": return 144;
  }
};

/**
 * Map a (codec, hardware encoder) pair to its ffmpeg codec library identifier.
 * Falls back to libx264 / libx265 for the universal CPU path.
 */
const codecLibForEncoder = (codec: CodecPreset, encoder: VideoEncoder): string => {
  if (encoder === "copy") return "copy";
  if (codec === "hevc") {
    switch (encoder) {
      case "nvenc": return "hevc_nvenc";
      case "qsv": return "hevc_qsv";
      case "vaapi": return "hevc_vaapi";
      case "amf": return "hevc_amf";
      case "videotoolbox": return "hevc_videotoolbox";
      default: return "libx265";
    }
  }
  switch (encoder) {
    case "nvenc": return "h264_nvenc";
    case "qsv": return "h264_qsv";
    case "vaapi": return "h264_vaapi";
    case "amf": return "h264_amf";
    case "videotoolbox": return "h264_videotoolbox";
    default: return "libx264";
  }
};

/**
 * Named CUDA device shared by the decoder (`-hwaccel_device`) and the filter
 * graph (`-filter_hw_device`), so NVDEC frames and `hwupload`ed frames live on
 * the same GPU/context and `hwupload` can pass NVDEC surfaces through
 * zero-copy. Used by the real NVENC encode AND the encoder probe.
 */
const NVENC_DEVICE_NAME = "sf_cuda";
const NVENC_DEVICE_ARGS = ["-init_hw_device", `cuda=${NVENC_DEVICE_NAME}`, "-filter_hw_device", NVENC_DEVICE_NAME];

/**
 * Build the per-encoder ffmpeg argument list for a video re-encode.
 *
 * `quality` drives the scale height, target bitrate (`estimateBitrateKbps`),
 * and the codec selection (`defaultCodecForQuality`: h264 for ≤1080p, hevc for
 * 2160p). The 360p path is the speed-tuned variant that the original encoder
 * recipe was tuned for; higher resolutions reuse the same hardware-specific
 * rate-control flags but bump the bitrate ceiling. The CPU recipe uses
 * `libx264 -preset veryfast` for ≤1080p and `libx265 -preset veryfast` for
 * 2160p (the only quality that selects HEVC by default).
 *
 * Extracted as an exported pure function so the per-encoder recipes (especially
 * the fragile VAAPI one) can be unit-tested without invoking ffmpeg.
 *
 * Returns `{ preArgs, encoderArgs }`:
 * - `preArgs`  — flags that must precede `-i` (decode/device setup).
 * - `encoderArgs` — the `-vf` filter chain plus the codec + rate-control flags.
 *
 * VAAPI note: the command is intentionally NOT an all-GPU pipeline. ffmpeg
 * silently falls back to a software decoder for many inputs (e.g. 10-bit HEVC),
 * and an all-GPU `-hwaccel_output_format vaapi` chain then receives frames its
 * GPU filters can't consume ("Function not implemented"). Instead we always
 * decode on the CPU and convert to 8-bit NV12 (`format=nv12`) before
 * `hwupload`; the GPU still does the scale + H.264 encode. `format=nv12` also
 * down-converts 10-bit `yuv420p10le` to the 8-bit NV12 `h264_vaapi` requires,
 * which the previous GPU-decode path skipped → "No usable encoding profile
 * found" → "Conversion failed!".
 *
 * NVENC note: decode is attempted on NVDEC (`-hwaccel cuda
 * -hwaccel_output_format cuda`) but the filter chain is source-agnostic:
 * `hwupload,scale_cuda=-2:H:format=nv12`. `hwupload` is a no-op for NVDEC's
 * CUDA frames and uploads the software frames ffmpeg falls back to when NVDEC
 * cannot decode the stream (10-bit/4:2:2/4:4:4 H.264, unsupported profiles …), so the
 * scale + NV12 8-bit conversion + encode always run on the GPU. Do NOT add an
 * output `-pix_fmt` for NVENC — it inserts a CPU `format=` after scale_cuda's
 * CUDA frames, which ffmpeg cannot negotiate ("Impossible to convert between
 * the formats supported by the filter 'scale_cuda' and the filter
 * 'auto_scale'", ultimate-stress #25). The probe (`buildEncoderProbeArgs`)
 * reuses these `encoderArgs` verbatim.
 *
 * Backwards-compat: the third arg defaults to "360p" so existing callers /
 * tests that pass only `(encoder, vaapiDevice)` keep producing byte-identical
 * args to the pre-Phase-3 360p recipe.
 */
export const buildVideoEncoderArgs = (
  encoder: VideoEncoder,
  vaapiDevice: string | null,
  quality: QualityPreset = "360p"
): { preArgs: string[]; encoderArgs: string[] } => {
  const height = qualityHeight(quality);
  const codec = defaultCodecForQuality(quality);
  const codecLib = codecLibForEncoder(codec, encoder);
  // The 360p fallback recipe predates this generalisation; its hand-tuned
  // bitrate ladder (400k average / 800k peak / 1600k buffer) is preserved
  // byte-identically so the existing ingest path keeps producing the exact
  // same ffmpeg args. Other variants derive their ladder from
  // `estimateBitrateKbps` with a 2x maxrate / 4x bufsize ratio, which matches
  // the 360p ratio (400 → 800 → 1600) and keeps the speed-tuned shape.
  const bitrateKbps =
    quality === "360p" ? 400 : estimateBitrateKbps(quality, codec);
  const maxrateKbps = bitrateKbps * 2;
  const bufsizeKbps = bitrateKbps * 4;
  const bitrate = `${bitrateKbps}k`;
  const maxrate = `${maxrateKbps}k`;
  const bufsize = `${bufsizeKbps}k`;
  const preArgs =
    encoder === "nvenc"
      ? [...NVENC_DEVICE_ARGS, "-hwaccel", "cuda", "-hwaccel_device", NVENC_DEVICE_NAME, "-hwaccel_output_format", "cuda"]
      : encoder === "vaapi"
      ? vaapiDevice
        ? ["-vaapi_device", vaapiDevice]
        : []
      : [];
  const encoderArgs =
    encoder === "copy"
      ? ["-c:v", "copy"]
      : encoder === "nvenc"
      ? [
          "-c:v",
          codecLib,
          "-vf",
          // `hwupload` passes NVDEC's CUDA frames straight through and uploads
          // software-decoded frames (10-bit/4:4:4/4:2:2 H.264, unsupported profiles …);
          // `scale_cuda …:format=nv12` resizes AND converts to 8-bit 4:2:0 on
          // the GPU. Never add an output `-pix_fmt`: it appends a CPU
          // `format=` filter after scale_cuda's CUDA frames and ffmpeg dies
          // with "Impossible to convert between the formats supported by the
          // filter 'scale_cuda' and the filter 'auto_scale'" (#25, NVIDIA test machine).
          `hwupload,scale_cuda=-2:${height}:format=nv12`,
          // 360p fallback is the speed-tuned lowest-quality variant:
          // p1 is NVENC's fastest preset (the scale runs p1 fast … p7
          // slow), matching the max-speed intent of the VAAPI
          // (-quality 7), AMF (-quality speed) and VideoToolbox
          // (-realtime 1) paths. Higher variants keep the same preset:
          // we still want fast encodes (this is a re-transcode, not a
          // mastering pipeline) and the per-variant bitrate ladder
          // controls quality.
          "-preset",
          "p1",
          "-rc",
          "vbr",
          "-cq",
          "32",
          "-b:v",
          bitrate,
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-g",
          "96",
          "-keyint_min",
          "96",
          "-sc_threshold",
          "0",
          "-profile:v",
          "main",
        ]
      : encoder === "qsv"
      ? [
          "-c:v",
          codecLib,
          "-vf",
          `scale=-2:${height}`,
          // QSV falls back to its `medium` preset when unset; the 360p
          // fallback is the speed-tuned variant, so pin the fastest.
          "-preset",
          "veryfast",
          "-global_quality",
          "32",
          "-look_ahead",
          "0",
          "-async_depth",
          "2",
          "-b:v",
          bitrate,
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-g",
          "96",
          "-keyint_min",
          "96",
          "-sc_threshold",
          "0",
          "-profile:v",
          "main",
        ]
      : encoder === "vaapi"
      ? [
          // CPU decode → CPU 8-bit NV12 conversion → GPU upload → GPU scale +
          // H.264 encode. `format=nv12` is unconditional: it makes the chain
          // work for ANY input pixel format, including 10-bit HEVC
          // (`yuv420p10le`), which `h264_vaapi` cannot otherwise consume.
          "-vf",
          `format=nv12,hwupload,scale_vaapi=w=-2:h=${height}`,
          "-c:v",
          codecLib,
          // 360p fallback is the lowest-quality variant — tuned for
          // raw speed, not compression efficiency. CQP @ qp30 avoids
          // VBR's rate-distortion search; -bf 0 + -refs 1 collapse
          // frame dependencies so the GPU pipeline stays full;
          // -quality 7 selects the driver's max-speed preset
          // (typically clamped on AMD/Intel VAAPI). -maxrate caps the
          // worst-case burst so adaptive-streaming clients still see a
          // bounded ceiling.
          "-rc_mode",
          "CQP",
          "-qp",
          "30",
          "-quality",
          "7",
          "-bf",
          "0",
          "-refs",
          "1",
          "-async_depth",
          "4",
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-g",
          "96",
          "-keyint_min",
          "96",
          "-sc_threshold",
          "0",
          "-profile:v",
          "main",
        ]
      : encoder === "amf"
      ? [
          "-c:v",
          codecLib,
          "-vf",
          `scale=-2:${height}`,
          "-rc",
          "vbr_peak",
          "-qp_i",
          "28",
          "-qp_p",
          "28",
          "-qp_b",
          "28",
          "-b:v",
          bitrate,
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-quality",
          "speed",
          "-g",
          "96",
          "-keyint_min",
          "96",
          "-sc_threshold",
          "0",
          "-profile:v",
          "main",
          "-pix_fmt",
          "yuv420p",
        ]
      : encoder === "videotoolbox"
      ? [
          "-c:v",
          codecLib,
          "-vf",
          `scale=-2:${height}`,
          "-realtime",
          "1",
          "-b:v",
          bitrate,
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-allow_sw",
          "0",
          "-g",
          "96",
          "-keyint_min",
          "96",
          "-sc_threshold",
          "0",
          "-profile:v",
          "main",
          "-pix_fmt",
          "yuv420p",
        ]
      // CPU path. The 360p recipe predates the generalisation and used a
      // hand-tuned `-maxrate 700k -bufsize 1400k` pair (slightly tighter than
      // the 800k/1600k ceiling the hardware encoders use). We preserve those
      // exact values for 360p so the legacy CPU recipe stays byte-identical,
      // and use the standard 2x/4x ladder for every other variant.
      : quality === "360p"
      ? [
          "-c:v",
          codecLib,
          "-preset",
          "veryfast",
          "-crf",
          "28",
          "-maxrate",
          "700k",
          "-bufsize",
          "1400k",
          "-vf",
          `scale=-2:${height}`,
          "-g",
          "96",
          "-keyint_min",
          "96",
          "-sc_threshold",
          "0",
          "-profile:v",
          "main",
          "-pix_fmt",
          "yuv420p",
        ]
      : [
          "-c:v",
          codecLib,
          "-preset",
          "veryfast",
          "-crf",
          "28",
          "-b:v",
          bitrate,
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-vf",
          `scale=-2:${height}`,
          "-g",
          "96",
          "-keyint_min",
          "96",
          "-sc_threshold",
          "0",
          "-profile:v",
          "main",
          "-pix_fmt",
          "yuv420p",
        ];
  return { preArgs, encoderArgs };
};

/**
 * Full ffmpeg argv for a DASH video encode:
 * `-y <preArgs> <decoder threads> -i <input> <mapping> <encoder recipe>
 * <encoder + filter threads> <dash muxer>`.
 *
 * Thread caps are applied here, NOT inside `buildVideoEncoderArgs`: that
 * function's output is the per-encoder recipe the encoder probe reuses
 * verbatim (and several tests pin it byte-for-byte). Caps go where ffmpeg
 * needs them: decoder threads before `-i`, encoder + filter-graph threads
 * after it. `copy` (stream-copy remux) gets none. `threads` defaults to the
 * host policy (`cores - 2`, see `@space/ffmpeg` resourcePolicy).
 */
export const buildDashVideoArgs = (options: {
  inputPath: string;
  mpdPath: string;
  segmentSeconds: number;
  encoder: VideoEncoder;
  quality?: QualityPreset;
  vaapiDevice?: string | null;
  /** Read the source from stdin (`-i pipe:0`); `inputPath` is then ignored. */
  fromStdin?: boolean;
  /** Explicit worker-thread cap (`0` = no cap). Defaults to `resolveFfmpegThreads()`. */
  threads?: number;
}): string[] => {
  const { encoder, quality = "360p" } = options;
  const { preArgs, encoderArgs } = buildVideoEncoderArgs(encoder, options.vaapiDevice ?? null, quality);
  const threadArgs =
    encoder === "copy"
      ? { input: [], output: [] }
      : buildFfmpegThreadArgs({
          threads: options.threads,
          softwareEncoder: encoder === "cpu",
          x265: encoder === "cpu" && defaultCodecForQuality(quality) === "hevc",
        });
  return [
    "-y",
    ...preArgs,
    ...threadArgs.input,
    "-i",
    options.fromStdin ? "pipe:0" : options.inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-map_chapters",
    "-1",
    ...encoderArgs,
    ...threadArgs.output,
    "-f",
    "dash",
    "-seg_duration",
    String(options.segmentSeconds),
    "-use_timeline",
    "1",
    "-use_template",
    "1",
    "-init_seg_name",
    "init-$RepresentationID$.mp4",
    "-media_seg_name",
    "seg-$Number%05d$.m4s",
    options.mpdPath,
  ];
};

const encodeDashVideo = async (
  inputPath: string,
  outputDir: string,
  segmentSeconds: number,
  encoder: VideoEncoder,
  signal?: AbortSignal,
  onLog?: (line: string) => void,
  progress?: { durationMs?: number | null; onUpdate?: (percent: number) => void },
  quality: QualityPreset = "360p",
  /**
   * Optional source-bytes stream. When set, ffmpeg reads from stdin
   * (`-i pipe:0`) and `inputPath` is unused — pass any non-empty string
   * placeholder. Used by the post-ingest retranscode pipeline to feed
   * concatenated DASH init+segments without staging them to disk first.
   */
  inputStream?: AsyncIterable<Uint8Array> | null
) => {
  await ensureDir(outputDir);
  const mpdPath = joinPath(outputDir, "manifest.mpd");
  const mpdUrl = toFfmpegOutputUrl(mpdPath);
  const vaapiDevice = encoder === "vaapi" ? getDesktopPlatform().hardware.deviceFor("vaapi") : null;
  const ffmpegArgs = buildDashVideoArgs({
    inputPath,
    mpdPath: mpdUrl,
    segmentSeconds,
    encoder,
    quality,
    vaapiDevice,
    fromStdin: Boolean(inputStream),
  });
  console.info("[mediaProcessor] video encode resource policy", {
    encoder,
    quality,
    niceness: resolveFfmpegNiceness(),
    // 0 = no cap (SF_FFMPEG_THREADS=0): ffmpeg picks its own pool size.
    threads: encoder === "copy" ? "n/a" : resolveFfmpegThreads(),
  });
  await runDashEncoder(
    ffmpegArgs,
    outputDir,
    mpdUrl,
    {
      ffmpegPath: resolveFfmpegPath(),
      stdin: inputStream ?? null,
      progress: progress
        ? {
            enabled: true,
            output: "stdout",
            durationMs: progress.durationMs ?? null,
            onUpdate: (stats) => {
              if (typeof stats.percent === "number") {
                progress.onUpdate?.(Math.max(0, Math.min(100, stats.percent)));
              }
            },
          }
        : { enabled: false },
      log: onLog
        ? {
            onLine: (line, stream) => {
              if (stream !== "stderr") return;
              onLog(line);
            },
          }
        : undefined,
    },
    signal
  );
  return mpdPath;
};

/**
 * ffmpeg failures carry the whole stderr (banner + stream mapping + the
 * actual error). Keep the tail, where the cause lives, so a one-line
 * diagnostic stays readable.
 */
const summarizeFfmpegError = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-6).join(" | ").slice(-700);
};

/**
 * Encode a video variant with the selected encoder, and if a hardware encoder
 * genuinely fails (not a user cancel), retry once on the universal CPU encoder
 * (`libx264 -preset veryfast`, `libx265` for HEVC variants).
 *
 * Why: hardware encoders are fragile against the long tail of source files
 * and host driver setups. A confirmed example — 10-bit HEVC (`yuv420p10le`)
 * sources — could break the VAAPI pipeline; another — ultimate-stress F2 —
 * is a libva driver that fails to initialise mid-session. CPU encode works
 * for any input ffmpeg can decode, so it is the safe last resort.
 *
 * Streaming sources (`inputStream`, used by the post-ingest retranscode
 * pipeline) are consumable once. They retry only when the caller supplies
 * `reopenInputStream`, which MUST return a fresh iterable of the same bytes
 * (the retranscode adapter re-downloads + re-decrypts the source chunks).
 * Without it a failed hardware streaming encode surfaces directly.
 *
 * The retry is skipped when `signal` is aborted: an aborted encode is a user
 * cancel, not an encoder failure, and must not be silently restarted.
 *
 * Before retrying, the output dir is wiped and recreated so stale partial DASH
 * segments from the failed hardware attempt don't pollute `listDashSegments`.
 */
const encodeDashVideoWithFallback = async (
  inputPath: string,
  outputDir: string,
  segmentSeconds: number,
  encoder: VideoEncoder,
  signal?: AbortSignal,
  onLog?: (line: string) => void,
  progress?: { durationMs?: number | null; onUpdate?: (percent: number) => void },
  quality: QualityPreset = "360p",
  inputStream?: AsyncIterable<Uint8Array> | null,
  reopenInputStream?: (() => AsyncIterable<Uint8Array>) | null
) => {
  try {
    return await encodeDashVideo(
      inputPath,
      outputDir,
      segmentSeconds,
      encoder,
      signal,
      onLog,
      progress,
      quality,
      inputStream ?? null
    );
  } catch (err) {
    // A user cancel is not an encoder failure — never silently restart it.
    if (signal?.aborted || !isHardwareEncoder(encoder)) {
      throw err;
    }
    // A one-shot stream is spent; only a caller-provided re-opener can replay it.
    const retryStream = inputStream ? (reopenInputStream?.() ?? null) : null;
    if (inputStream && !retryStream) {
      throw err;
    }
    const reason = summarizeFfmpegError(err);
    const cpuLib = defaultCodecForQuality(quality) === "hevc" ? "libx265" : "libx264";
    const message = `[fallback] ${encoder} encode failed (${reason}) — retrying ${quality} on CPU (${cpuLib})`;
    console.warn(message);
    onLog?.(message);
    // Discard partial DASH segments from the failed hardware attempt so
    // listDashSegments() doesn't pick up half-written init/seg files.
    console.warn("[mediaProcessor] removing outputs dir", { reason: "hw-encoder-fallback", outputDir, encoder, quality });
    await fs.rm(outputDir, { recursive: true, force: true });
    await ensureDir(outputDir);
    return await encodeDashVideo(
      inputPath,
      outputDir,
      segmentSeconds,
      "cpu",
      signal,
      onLog,
      progress,
      quality,
      retryStream
    );
  }
};

const encodeDashAudio = async (
  inputPath: string,
  outputDir: string,
  segmentSeconds: number,
  streamIndex: number,
  codec: string,
  channelLayout: string | null,
  signal?: AbortSignal,
  onLog?: (line: string) => void,
  progress?: { durationMs?: number | null; onUpdate?: (percent: number) => void }
) => {
  await ensureDir(outputDir);
  const mpdPath = joinPath(outputDir, "manifest.mpd");
  const mpdUrl = toFfmpegOutputUrl(mpdPath);
  // Browsers only decode AAC with a standard channel configuration (#1176): a
  // re-encode of a layout that relabels losslessly (5.1(side) → 5.1) is forced
  // to that standard layout; any other layout is left as it is.
  const standardLayout = standardAacLayoutFor(channelLayout);
  const encodeArgs = [
    "-c:a",
    "aac",
    ...(standardLayout ? ["-af", `aformat=channel_layouts=${standardLayout}`] : []),
  ];
  const runAudio = (audioCodecArgs: string[]) =>
    runDashEncoder(
      [
        "-y",
        "-i",
        inputPath,
        "-map",
        `0:a:${streamIndex}`,
        ...audioCodecArgs,
        "-vn",
        "-sn",
        "-dn",
        "-map_chapters",
        "-1",
        "-f",
        "dash",
        "-seg_duration",
        String(segmentSeconds),
        "-use_timeline",
        "1",
        "-use_template",
        "1",
        "-init_seg_name",
        "init-$RepresentationID$.mp4",
        "-media_seg_name",
        "seg-$Number%05d$.m4s",
        mpdUrl,
      ],
      outputDir,
      mpdUrl,
      {
        ffmpegPath: resolveFfmpegPath(),
        progress: progress
          ? {
              enabled: true,
              output: "stdout",
              durationMs: progress.durationMs ?? null,
              onUpdate: (stats) => {
                if (typeof stats.percent === "number") {
                  progress.onUpdate?.(Math.max(0, Math.min(100, stats.percent)));
                }
              },
            }
          : { enabled: false },
        log: onLog
          ? {
              onLine: (line, stream) => {
                if (stream !== "stderr") return;
                onLog(line);
              },
            }
          : undefined,
      },
      signal
    );
  if (codec.toLowerCase() !== "aac") {
    await runAudio(encodeArgs);
    return mpdPath;
  }
  await runAudio(["-c:a", "copy"]);
  // A copied AAC keeps the source's channel configuration; configuration 0
  // (program config element, no browser decodes it) of a layout that relabels
  // losslessly is re-encoded instead. ffprobe (FFmpeg 8) names no layout for
  // such a track, so the layout is read from the program config element.
  const { init } = await listDashSegments(outputDir);
  const initBytes = init ? await fs.readFile(joinPath(outputDir, init)) : null;
  const config = initBytes ? readAacChannelConfiguration(initBytes) : null;
  const pceLayout = config === 0 && initBytes ? readAacPceLayout(initBytes) : null;
  const reencodeLayout = standardLayout ?? standardAacLayoutFor(pceLayout);
  if (reencodeLayout && config === 0) {
    onLog?.(
      `[ingest] audio ${streamIndex}: copied AAC has channel configuration ${config} (probed layout ${channelLayout ?? "none"}, program config element ${pceLayout ?? "none"}); re-encoding as ${reencodeLayout}`
    );
    console.warn("[mediaProcessor] removing outputs dir", { reason: "aac-channel-configuration", outputDir, config, channelLayout, pceLayout });
    await fs.rm(outputDir, { recursive: true, force: true });
    await ensureDir(outputDir);
    await runAudio(["-c:a", "aac", "-af", `aformat=channel_layouts=${reencodeLayout}`]);
  }
  return mpdPath;
};

const extractSubtitle = async (
  inputPath: string,
  outputDir: string,
  streamIndex: number,
  format: string,
  codecArgs: string[],
  signal?: AbortSignal,
  onLog?: (line: string) => void,
  progress?: { durationMs?: number | null; onUpdate?: (percent: number) => void }
) => {
  await ensureDir(outputDir);
  const outputPath = joinPath(outputDir, `subtitle-${streamIndex}.${format}`);
  const args = ["-y", "-i", inputPath, "-map", `0:s:${streamIndex}`, ...codecArgs, outputPath];
  await runFfmpegWithSignal(
    args,
    {
      ffmpegPath: resolveFfmpegPath(),
      progress: progress
        ? {
            enabled: true,
            output: "stdout",
            durationMs: progress.durationMs ?? null,
            onUpdate: (stats) => {
              if (typeof stats.percent === "number") {
                progress.onUpdate?.(Math.max(0, Math.min(100, stats.percent)));
              }
            },
          }
        : { enabled: false },
      log: onLog
        ? {
            onLine: (line, stream) => {
              if (stream !== "stderr") return;
              onLog(line);
            },
          }
        : undefined,
    },
    signal
  );
  return outputPath;
};

export const resolveSubtitleOutput = (codecName: string) => {
  const codec = codecName.toLowerCase();
  const bitmapCodecs = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "vobsub", "dvb_subtitle"]);
  const textCodecs = new Set(["subrip", "ass", "ssa", "mov_text", "webvtt"]);
  if (bitmapCodecs.has(codec)) {
    if (codec === "dvd_subtitle" || codec === "vobsub" || codec === "dvb_subtitle") {
      return { format: "mkv", codecArgs: ["-c:s", "copy", "-f", "matroska"] };
    }
    return { format: "sup", codecArgs: ["-c:s", "copy"] };
  }
  if (textCodecs.has(codec)) {
    return { format: "srt", codecArgs: ["-c:s", "srt"] };
  }
  return { format: "srt", codecArgs: ["-c:s", "srt"] };
};

/**
 * Build a tiny, self-contained test encode for one hardware encoder. It uses
 * the same device wiring AND filter chain as the real encode so a broken
 * driver / unreadable render node / missing profile / unnegotiable filter
 * graph fails here instead of in the middle of a user's job:
 *  - VAAPI: `-vaapi_device` + `format=nv12,hwupload,scale_vaapi`.
 *  - NVENC: the real recipe's `-init_hw_device`/`-filter_hw_device` wiring and
 *    its complete `encoderArgs` (`hwupload,scale_cuda=…:format=nv12` + codec +
 *    rate-control flags), verbatim. A bare `-c:v h264_nvenc` probe passed on
 *    an NVIDIA test machine while every real encode died in scale_cuda negotiation (#25).
 *    The decode-side `-hwaccel` flags are omitted because the lavfi source has
 *    nothing to hardware-decode; the software-frame → hwupload path it takes
 *    is the same one used for sources NVDEC cannot decode.
 */
const buildEncoderProbeArgs = (encoder: HardwareVideoEncoder, vaapiDevice: string | null): string[] => {
  const source = ["-f", "lavfi", "-i", "color=c=black:s=320x240:r=10:d=1"];
  const sink = ["-frames:v", "3", "-an", "-f", "null", "-"];
  switch (encoder) {
    case "vaapi":
      return [
        ...(vaapiDevice ? ["-vaapi_device", vaapiDevice] : []),
        ...source,
        "-vf",
        "format=nv12,hwupload,scale_vaapi=w=-2:h=240",
        "-c:v",
        "h264_vaapi",
        ...sink,
      ];
    case "nvenc":
      return [...NVENC_DEVICE_ARGS, ...source, ...buildVideoEncoderArgs("nvenc", null, "360p").encoderArgs, ...sink];
    default:
      return [...source, "-c:v", `h264_${encoder}`, ...sink];
  }
};

const ENCODER_PROBE_TIMEOUT_MS = 20_000;

type EncoderProbeResult = { ok: true } | { ok: false; reason: string };

// One probe per (encoder, device) per process. The promise is cached so
// concurrent callers share a single test encode, and a failing verdict sticks
// (a hardware stack that is broken now will not heal mid-session; restart the
// runtime to re-probe).
const encoderProbeCache = new Map<string, Promise<EncoderProbeResult>>();

const probeHardwareEncoder = (encoder: HardwareVideoEncoder): Promise<EncoderProbeResult> => {
  const vaapiDevice = encoder === "vaapi" ? getDesktopPlatform().hardware.deviceFor("vaapi") : null;
  const cacheKey = `${encoder}|${vaapiDevice ?? ""}`;
  const cached = encoderProbeCache.get(cacheKey);
  if (cached) return cached;
  const probe = (async (): Promise<EncoderProbeResult> => {
    console.info(`[encoder-probe] probing ${encoder}${vaapiDevice ? ` device=${vaapiDevice}` : ""}`);
    try {
      await runFfmpeg(buildEncoderProbeArgs(encoder, vaapiDevice), {
        ffmpegPath: resolveFfmpegPath(),
        progress: { enabled: false },
        timeoutMs: ENCODER_PROBE_TIMEOUT_MS,
      });
      console.info(`[encoder-probe] ${encoder} probe ok`);
      return { ok: true };
    } catch (err) {
      const reason = summarizeFfmpegError(err);
      return { ok: false, reason };
    }
  })();
  encoderProbeCache.set(cacheKey, probe);
  return probe;
};

/** Test seam: forget cached hardware-encoder probe verdicts. */
export const resetEncoderProbeCache = () => {
  encoderProbeCache.clear();
};

/** Hardware H.264 encoders this ffmpeg build advertises (`-encoders`), in the OS's fallback order. */
const listAdvertisedHardwareEncoders = async (): Promise<HardwareVideoEncoder[]> => {
  const res = await runFfmpeg(["-encoders"], {
    ffmpegPath: resolveFfmpegPath(),
    progress: { enabled: false },
  }).catch(() => null);
  const encoders = [res?.stdout, res?.stderr].filter(Boolean).join("\n");
  return advertisedHardwareEncoders(getDesktopPlatform().hardware.encoderPolicy, encoders.split(/\s+/));
};

/**
 * Pick the encoder a platform/GPU *should* use, based only on what ffmpeg
 * advertises (`-encoders`) and the GPU vendor. Advertised ≠ usable: the
 * caller must verify a hardware pick with `probeHardwareEncoder`. Which
 * encoders exist and which GPU vendor each suits is the desktop platform's
 * `hardware.encoderPolicy`.
 */
const selectEncoderCandidate = async (
  advertised: readonly HardwareVideoEncoder[]
): Promise<Exclude<VideoEncoder, "copy">> => {
  const gpuVendor = (await runtime.getGpuVendor?.().catch(() => "") ?? "").toLowerCase();
  return pickHardwareEncoder(getDesktopPlatform().hardware.encoderPolicy, advertised, gpuVendor) ?? "cpu";
};

/**
 * Choose the video encoder for this machine. A hardware candidate is only
 * returned if a cheap test encode on it actually succeeds (probed once per
 * process, cached); otherwise we log the reason and select software
 * (libx264/libx265). This is what stops a host whose ffmpeg lists
 * `h264_vaapi` but whose libva driver can't initialise (ultimate-stress F2,
 * on a Linux test machine) from failing every transcode.
 */
export const detectEncoder = async (): Promise<Exclude<VideoEncoder, "copy">> => {
  const candidate = await selectEncoderCandidate(await listAdvertisedHardwareEncoders());
  if (!isHardwareEncoder(candidate)) {
    console.info(`[encoder-probe] no hardware encoder advertised → ${candidate}`);
    return candidate;
  }
  const probe = await probeHardwareEncoder(candidate);
  if (probe.ok) return candidate;
  console.warn(
    `[encoder-probe] ${candidate} advertised but unusable → falling back to cpu. reason: ${probe.reason}`
  );
  return "cpu";
};

/**
 * First-start hardware detection (#25): like `detectEncoder`, but when the
 * vendor-preferred encoder fails its test encode, every other advertised
 * hardware H.264 encoder is test-encoded in turn, so a wrong/unknown GPU
 * vendor can't make the machine look GPU-less. Returns the first encoder that
 * works, else "cpu". Probes are cached per encoder (see probeHardwareEncoder).
 */
export const detectWorkingHardwareEncoder = async (): Promise<HardwareVideoEncoder | "cpu"> => {
  const advertised = await listAdvertisedHardwareEncoders();
  const preferred = await selectEncoderCandidate(advertised);
  const order = isHardwareEncoder(preferred)
    ? [preferred, ...advertised.filter((encoder) => encoder !== preferred)]
    : [...advertised];
  console.info(`[encoder-probe] hardware detection: advertised=[${advertised.join(",")}] order=[${order.join(",")}]`);
  for (const encoder of order) {
    const probe = await probeHardwareEncoder(encoder);
    if (probe.ok) {
      console.info(`[encoder-probe] hardware detection → ${encoder}`);
      return encoder;
    }
    console.warn(`[encoder-probe] hardware detection: ${encoder} advertised but unusable. reason: ${probe.reason}`);
  }
  console.info("[encoder-probe] hardware detection → cpu (no usable hardware encoder)");
  return "cpu";
};

const parseLanguage = (stream: FfprobeStream, fallback: string) => {
  const tags = (stream.tags ?? {}) as Record<string, unknown>;
  const raw = (tags.language as string | undefined) ?? (tags.LANGUAGE as string | undefined);
  return raw?.trim() || fallback;
};

const parseLabel = (stream: FfprobeStream, fallback: string) => {
  const tags = (stream.tags ?? {}) as Record<string, unknown>;
  const raw = (tags.title as string | undefined) ?? (tags.TITLE as string | undefined);
  return raw?.trim() || fallback;
};

/**
 * Run ffprobe over a media file and return the parsed result. Pure helper
 * extracted for reuse by the Phase D step handlers; `processMediaJob` keeps
 * calling this internally so the legacy ingestion path is unchanged.
 */
export const probeMediaFile = async (inputPath: string) => {
  const result = await runFfprobe(
    ["-v", "error", "-show_streams", "-show_chapters", "-show_format", "-print_format", "json", inputPath],
    { ffprobePath: resolveFfprobePath() }
  );
  return result;
};

const loadProbe = probeMediaFile;

// ---------------------------------------------------------------------------
// Phase F split: probe + encode (`produceMediaOutputs`) and encrypted upload
// (`uploadProducedMedia`) are now independent entrypoints. `processMediaJob`
// is a thin composition that preserves the legacy single-call signature for
// callers still depending on it (apps/badger/desktop/src/main/mediaIngest.ts,
// apps/runtime/src/modules/badgerIngest.ts, etc.).
//
// Carve line: `produceMediaOutputs` writes unencrypted DASH segments to disk
// and persists `job_state.json` with `segments[].uploaded === false` for every
// chunk. `uploadProducedMedia` reads that state, encrypts each pending chunk
// via the runtime's `encryptMediaObject`, pushes it through
// `UploadSessionManager`, and flips `uploaded: true` + persists the key.
//
// This matches how `ResumableJobStateStore` was always meant to be used:
// `segments[].uploaded` is the per-chunk idempotency key, so resume-after-
// crash is identical pre/post split — `uploadProducedMedia` skips any segment
// already flagged uploaded and only encrypts + pushes the rest.
// ---------------------------------------------------------------------------

/**
 * Common payload fields shared by `processMediaJob`, `produceMediaOutputs`
 * and `uploadProducedMedia`. Pulled out so all three entrypoints stay in sync
 * if a future field is added.
 */
type ProcessMediaJobPayload = {
  token: string;
  userId: string;
  jobId: string;
  inputPath: string;
  /** Per-media silo placement (#145) for every uploaded object of this job. */
  placementId: string;
  /**
   * Optional source-bytes stream. When set, probe is skipped (the caller
   * MUST set `sourceQualityOverride`), the variant encode loop pipes the
   * iterable to ffmpeg via stdin instead of reading `inputPath` from
   * disk. The CPU-retry fallback needs `reopenInputStream` (a stream is
   * consumable once). Used by the post-ingest retranscode pipeline.
   */
  inputStream?: AsyncIterable<Uint8Array> | null;
  /**
   * Factory returning a FRESH iterable of the same bytes as `inputStream`.
   * Used only to replay the source when a hardware encode fails and the
   * encode is retried on CPU; without it a failed hardware streaming encode
   * is terminal (the original stream is spent).
   */
  reopenInputStream?: (() => AsyncIterable<Uint8Array>) | null;
  /**
   * Optional duration hint in seconds. When `inputStream` is provided,
   * probe is skipped so progress ETA can't derive from
   * probe.format.duration; the caller threads it through here if known.
   */
  inputDurationSeconds?: number | null;
  sourceQualityOverride?: string;
  includeSource?: boolean;
  includeFallback: boolean;
  /**
   * Explicit list of transcode variants to produce. When provided and
   * non-empty, replaces the `includeFallback` toggle (which is equivalent to
   * `["360p"]`). Each variant produces a separate DASH output with id
   * `video-<quality>-<codec>` (e.g. `video-720p-h264`, `video-2160p-hevc`).
   *
   * Backward compat: `includeFallback: true` without `targetVariants` is
   * still honoured and produces the legacy `video-360p-h264` output with
   * byte-identical ffmpeg args.
   */
  targetVariants?: QualityPreset[];
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
  audioTrackIndexes?: number[];
  subtitleTrackIndexes?: number[];
  audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  signal?: AbortSignal;
  onProgress?: (stage: "transcoding" | "uploading", progress: number) => void;
  onEncoder?: (encoder: Exclude<VideoEncoder, "copy">) => void;
  onLog?: (line: string) => void;
};

/**
 * Output of `produceMediaOutputs` — the encode-only entrypoint.
 *
 * `stateStore` carries the live `ResumableJobStateStore<unknown>`
 * with every planned chunk's path written but `uploaded === false`. The caller
 * passes this object straight into `uploadProducedMedia` to do the actual
 * upload (or omits it on restart, in which case `uploadProducedMedia` opens
 * a fresh store from `job_state.json` on disk).
 *
 * `produced` is the metadata structure with empty `chunks[]` arrays —
 * pre-upload, none of the segments carry object keys yet. The shape matches
 * `ProducedMedia` so callers that cache it between extract and commit have
 * a uniform type to thread through (commit reads the post-upload
 * `ProducedMedia` from the upload step's output, not from this cache).
 */
export interface ProducedMediaOutputs {
  jobDir: string;
  stateStore: ResumableJobStateStore<unknown>;
  encoder: Exclude<VideoEncoder, "copy">;
  /**
   * Pre-upload metadata view — chunks empty until uploadProducedMedia runs.
   * Useful for callers that want to cache the encode-side shape (quality,
   * codec, language, etc.) between steps without re-reading job_state.json.
   */
  produced: ProducedMedia;
}

const ENCODE_TERMINAL_PROGRESS_PCT = 99;

/**
 * Encode-only entrypoint. Probes the input, runs every requested ffmpeg
 * invocation, and writes unencrypted DASH segments to disk via
 * `ResumableJobStateStore`. Does NOT upload or encrypt — those are the
 * upload-step's responsibilities.
 *
 * Progress fires only the `"transcoding"` stage. `"uploading"` is the
 * `uploadProducedMedia` entrypoint's concern.
 *
 * Idempotent: if a prior call already wrote outputs whose `encodingComplete`
 * is true and whose DASH files exist on disk, that output is skipped. This
 * is the same short-circuit the legacy monolith used; the underlying
 * `ResumableJobStateStore` semantics are unchanged.
 */
export const produceMediaOutputs = async (
  // Encode-only: nothing is uploaded here, so no placementId.
  payload: Omit<ProcessMediaJobPayload, "token" | "placementId"> & { token?: string }
): Promise<ProducedMediaOutputs> => {
  throwIfAborted(payload.signal);
  const jobDir = resolveJobDir(payload.userId, payload.jobId);
  const stateStore = await ResumableJobStateStore.open<unknown>({
    jobDir,
    inputPath: payload.inputPath,
    userId: payload.userId,
  });
  const state = stateStore.getState();

  // When `inputStream` is provided we skip probe entirely — caller must
  // supply `sourceQualityOverride`. Downstream branches that rely on
  // probe (source/audio/subtitle/chapter loops) are all gated by the
  // matching include* flags which retranscode sets to false.
  const streamingMode = Boolean(payload.inputStream);
  if (streamingMode && !payload.sourceQualityOverride) {
    throw new Error("PRODUCE_INPUT_STREAM_REQUIRES_SOURCE_QUALITY_OVERRIDE");
  }
  const probe = streamingMode
    ? ({
        data: { streams: [], format: {} } as FfprobeData,
        streams: [] as FfprobeStream[],
      } as FfprobeResult)
    : await loadProbe(payload.inputPath);
  const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
  if (!videoStream && !streamingMode) {
    throw new Error("NO_VIDEO_STREAM");
  }
  const durationSeconds = streamingMode
    ? payload.inputDurationSeconds ?? null
    : Number(probe.data.format?.duration ?? 0) || null;
  const sourceHeight = Number(videoStream?.height ?? 0);
  const sourceWidth = Number(videoStream?.width ?? 0);
  const rawCodec = String(videoStream?.codec_name ?? "unknown");
  const overrideQuality =
    payload.sourceQualityOverride && QUALITY_ORDER.includes(payload.sourceQualityOverride as QualityPreset)
      ? payload.sourceQualityOverride
      : null;
  // Retranscode (streaming) outputs are our own encodes (h264 / hevc by quality); an original is copied untouched, so
  // it keeps its real codec (av1, vp9, mpeg2 ... or the raw ffprobe name): never relabelled as something else (#303).
  const sourceCodec: SourceCodec = streamingMode
    ? defaultCodecForQuality((overrideQuality ?? "1080p") as QualityPreset)
    : normalizeSourceCodec(rawCodec);
  const sourceQuality = overrideQuality ?? guessQualityLabel(sourceHeight, sourceWidth) ?? "1080p";
  if (overrideQuality) {
    payload.onLog?.(`[probe] using UI quality override → ${overrideQuality}`);
  }
  if (!streamingMode) {
    payload.onLog?.(
      `[probe] video ${sourceWidth || "?"}x${sourceHeight || "?"} → ${sourceQuality} (${rawCodec} → source codec ${sourceCodec})`
    );
  }
  const chapters =
    streamingMode || payload.includeChapters === false
      ? []
      : (probe.data as { chapters?: Array<{ start_time?: string; tags?: Record<string, unknown> }> }).chapters?.map(
          (chapter) => ({
            title: String((chapter.tags?.title as string | undefined) ?? "Chapter"),
            startSeconds: Number(chapter.start_time ?? 0),
          })
        ) ?? [];
  const chapterBoundaries = chapters
    .map((chapter) => Number(chapter.startSeconds))
    .filter((value) => Number.isFinite(value));
  const encoder = await detectEncoder();
  payload.onEncoder?.(encoder);
  const logLine = (label: string) => (line: string) => {
    if (!payload.onLog) return;
    payload.onLog(`[${label}] ${line}`);
  };
  const progressState = {
    transcoding: { lastAt: 0, lastPct: -1 },
    lastStage: null as "transcoding" | null,
  };
  const emitProgress = (stage: "transcoding", pct: number) => {
    if (!payload.onProgress) return;
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const now = Date.now();
    const stageState = progressState[stage];
    const stageChanged = progressState.lastStage !== stage;
    const pctChanged = clamped !== stageState.lastPct;
    const enoughTime = now - stageState.lastAt >= 400;
    if (!stageChanged && !pctChanged) return;
    if (!stageChanged && clamped !== 0 && clamped !== 100 && !enoughTime) return;
    progressState.lastStage = stage;
    stageState.lastAt = now;
    stageState.lastPct = clamped;
    payload.onProgress(stage, clamped);
  };

  const outputRoot = joinPath(jobDir, "outputs");
  await ensureDir(outputRoot);

  const subtitleStates: SubtitleState[] = [];
  const audioOverrideMap = new Map(
    (payload.audioTrackOverrides ?? []).map((entry) => [entry.index, entry])
  );
  const subtitleOverrideMap = new Map(
    (payload.subtitleTrackOverrides ?? []).map((entry) => [entry.index, entry])
  );
  // Pre-count planned transcode outputs once so the progress denominator is
  // fixed for the whole extracting stage. Previously `transcodeTotal` was
  // bumped on every `startTranscodeStep()`, which made `(done + active) /
  // total` jump backward as new ffmpeg invocations began (e.g. 100% → 50% →
  // 100% → 66% → 100% across the ~22 outputs of a multi-track ingest). With a
  // fixed denominator the parsed ffmpeg time drives a monotonic 0→100%.
  const audioStreamsForPlanning = probe.streams.filter((stream) => stream.codec_type === "audio");
  const subtitleStreamsForPlanning = probe.streams.filter((stream) => stream.codec_type === "subtitle");
  const allowedAudioIndexesPlan =
    payload.audioTrackIndexes && payload.audioTrackIndexes.length > 0
      ? new Set(payload.audioTrackIndexes)
      : null;
  const allowedSubtitleIndexesPlan =
    payload.subtitleTrackIndexes && payload.subtitleTrackIndexes.length > 0
      ? new Set(payload.subtitleTrackIndexes)
      : null;
  let plannedAudio = 0;
  if (payload.includeAudio !== false) {
    for (let index = 0; index < audioStreamsForPlanning.length; index += 1) {
      if (allowedAudioIndexesPlan && !allowedAudioIndexesPlan.has(index)) continue;
      plannedAudio += 1;
    }
  }
  let plannedSubtitles = 0;
  if (payload.includeSubtitles !== false) {
    for (let index = 0; index < subtitleStreamsForPlanning.length; index += 1) {
      if (allowedSubtitleIndexesPlan && !allowedSubtitleIndexesPlan.has(index)) continue;
      plannedSubtitles += 1;
    }
  }
  // Resolve the effective transcode variants. Backward compat: when callers
  // pass only `includeFallback: true` (no explicit `targetVariants`), the
  // legacy 360p output is produced — byte-identical to the pre-Phase-3
  // pipeline. When `targetVariants` is provided AND non-empty, it wins; the
  // `includeFallback` flag is then ignored. An empty `targetVariants: []`
  // explicitly disables transcoding regardless of `includeFallback`.
  const effectiveVariants: QualityPreset[] =
    payload.targetVariants !== undefined
      ? [...payload.targetVariants]
      : payload.includeFallback
      ? ["360p"]
      : [];
  const transcodeTotal =
    (payload.includeSource !== false ? 1 : 0) +
    effectiveVariants.length +
    plannedAudio +
    plannedSubtitles;
  let transcodeDone = 0;
  let transcodeActive = 0;
  const durationMs = durationSeconds ? Math.round(durationSeconds * 1000) : null;
  const bumpTranscodeProgress = () => {
    if (transcodeTotal <= 0) return;
    const pct = Math.max(
      1,
      Math.min(
        ENCODE_TERMINAL_PROGRESS_PCT,
        Math.round(((transcodeDone + transcodeActive) / transcodeTotal) * 100)
      )
    );
    emitProgress("transcoding", pct);
  };
  const startTranscodeStep = () => {
    transcodeActive = 0;
    bumpTranscodeProgress();
  };
  const finishTranscodeStep = () => {
    transcodeDone += 1;
    transcodeActive = 0;
    bumpTranscodeProgress();
  };
  const makeProgressHandler = () => ({
    durationMs,
    onUpdate: (percent: number) => {
      transcodeActive = Math.max(0, Math.min(1, percent / 100));
      bumpTranscodeProgress();
    },
  });

  if (payload.includeSource !== false) {
    const sourceOutputId = `video-source`;
    const sourceOutput = stateStore.ensureOutput(sourceOutputId, "video", SEGMENT_SECONDS_SOURCE);
    sourceOutput.quality = sourceQuality;
    sourceOutput.codec = sourceCodec;
    sourceOutput.durationSeconds = durationSeconds;

    const needsSourceEncode = !sourceOutput.encodingComplete || (await ensureDashOutput(sourceOutput));
    if (needsSourceEncode) {
      startTranscodeStep();
      sourceOutput.encodingComplete = false;
      throwIfAborted(payload.signal);
      const mpdPath = await encodeDashVideo(
        payload.inputPath,
        sourceOutput.outputDir,
        SEGMENT_SECONDS_SOURCE,
        "copy",
        payload.signal,
        logLine("video-source"),
        makeProgressHandler()
      );
      const mpd = await fs.readFile(mpdPath, "utf8");
      sourceOutput.codecString = extractCodecStringFromMpd(mpd, "video");
      const timeline = parseSegmentTimeline(mpd);
      const { init, segments } = await listDashSegments(sourceOutput.outputDir);
      sourceOutput.init = init
        ? { path: joinPath(sourceOutput.outputDir, init) }
        : null;
      sourceOutput.segments = segments.map((name, index) => {
        const fullPath = joinPath(sourceOutput.outputDir, name);
        const entry = timeline?.[index];
        return {
          path: fullPath,
          startSeconds: entry?.startSeconds ?? null,
          uploaded: false,
          key: undefined,
          sizeBytes: undefined,
          checksum: undefined
        };
      });
      sourceOutput.encodingComplete = true;
      sourceOutput.chapters = chapters;
      finishTranscodeStep();
      await stateStore.save();
    }
  }

  if (streamingMode && effectiveVariants.length !== 1) {
    throw new Error(
      `PRODUCE_INPUT_STREAM_SINGLE_VARIANT_ONLY: received ${effectiveVariants.length} variants — a stream is consumable once and cannot fan out`
    );
  }
  for (const variant of effectiveVariants) {
    const variantCodec = defaultCodecForQuality(variant);
    const variantOutputId = `video-${variant}-${variantCodec}`;
    const variantOutput = stateStore.ensureOutput(variantOutputId, "video", SEGMENT_SECONDS_FALLBACK);
    variantOutput.quality = variant;
    variantOutput.codec = variantCodec;
    variantOutput.durationSeconds = durationSeconds;
    const needsVariantEncode = !variantOutput.encodingComplete || (await ensureDashOutput(variantOutput));
    if (needsVariantEncode) {
      startTranscodeStep();
      variantOutput.encodingComplete = false;
      throwIfAborted(payload.signal);
      // Every path (ingest + streaming retranscode) goes through the
      // with-fallback wrapper: a hardware encode failure retries on CPU. A
      // streaming source can only be replayed via `reopenInputStream`.
      const mpdPath = await encodeDashVideoWithFallback(
        payload.inputPath,
        variantOutput.outputDir,
        SEGMENT_SECONDS_FALLBACK,
        encoder,
        payload.signal,
        logLine(`video-${variant}`),
        makeProgressHandler(),
        variant,
        payload.inputStream ?? null,
        payload.reopenInputStream ?? null
      );
      const mpd = await fs.readFile(mpdPath, "utf8");
      variantOutput.codecString = extractCodecStringFromMpd(mpd, "video");
      const timeline = parseSegmentTimeline(mpd);
      const { init, segments } = await listDashSegments(variantOutput.outputDir);
      variantOutput.init = init
        ? { path: joinPath(variantOutput.outputDir, init) }
        : null;
      variantOutput.segments = segments.map((name, index) => {
        const fullPath = joinPath(variantOutput.outputDir, name);
        const entry = timeline?.[index];
        return {
          path: fullPath,
          startSeconds: entry?.startSeconds ?? null,
          uploaded: false,
          key: undefined,
          sizeBytes: undefined,
          checksum: undefined
        };
      });
      variantOutput.encodingComplete = true;
      finishTranscodeStep();
      await stateStore.save();
    }
  }

  // Silent sources (screen recordings, silent films, test clips) are legitimate
  // media: a source with zero audio streams ingests as video-only. The
  // audio-required guard lives in finalize (`AUDIO_REQUIRED_MISSING`) and only
  // fires when the source HAS audio streams but none could be produced.
  const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio");
  if (payload.includeAudio !== false && audioStreams.length === 0) {
    payload.onLog?.("[ingest] source has no audio streams — ingesting video-only");
  }
  const allowedAudioIndexes =
    payload.audioTrackIndexes && payload.audioTrackIndexes.length > 0
      ? new Set(payload.audioTrackIndexes)
      : null;
  if (payload.includeAudio !== false) {
    for (let index = 0; index < audioStreams.length; index += 1) {
      if (allowedAudioIndexes && !allowedAudioIndexes.has(index)) continue;
      const stream = audioStreams[index];
      const streamCodec = String(stream.codec_name ?? "aac");
      const override = audioOverrideMap.get(index);
      const language =
        override?.language?.trim() ||
        parseLanguage(stream, "und");
      const label =
        override?.label?.trim() ||
        parseLabel(stream, language === "und" ? "Undefined" : language.toUpperCase());
      const outputId = `audio-${index}`;
      const audioOutput = stateStore.ensureOutput(outputId, "audio", SEGMENT_SECONDS_SOURCE);
      audioOutput.codec = "aac";
      audioOutput.quality = "audio";
      audioOutput.language = language;
      audioOutput.label = label;
      audioOutput.durationSeconds = durationSeconds;
      const needsAudioEncode = !audioOutput.encodingComplete || (await ensureDashOutput(audioOutput));
      if (needsAudioEncode) {
        startTranscodeStep();
        audioOutput.encodingComplete = false;
        throwIfAborted(payload.signal);
        const mpdPath = await encodeDashAudio(
          payload.inputPath,
          audioOutput.outputDir,
          SEGMENT_SECONDS_SOURCE,
          index,
          streamCodec,
          typeof stream.channel_layout === "string" ? stream.channel_layout : null,
          payload.signal,
          logLine(`audio-${index}`),
          makeProgressHandler()
        );
        const mpd = await fs.readFile(mpdPath, "utf8");
        audioOutput.codecString = extractCodecStringFromMpd(mpd, "audio");
        const timeline = parseSegmentTimeline(mpd);
        const { init, segments } = await listDashSegments(audioOutput.outputDir);
        audioOutput.init = init
          ? { path: joinPath(audioOutput.outputDir, init) }
          : null;
        audioOutput.segments = segments.map((name, segIndex) => {
          const fullPath = joinPath(audioOutput.outputDir, name);
          const entry = timeline?.[segIndex];
          return {
            path: fullPath,
            startSeconds: entry?.startSeconds ?? null,
            uploaded: false,
            key: undefined,
            sizeBytes: undefined,
            checksum: undefined
          };
        });
        audioOutput.encodingComplete = true;
        finishTranscodeStep();
        await stateStore.save();
      }
      audioOutput.codecString = audioOutput.codecString ?? "mp4a.40.2";
    }
  }

  const subtitleStreams = probe.streams.filter((stream) => stream.codec_type === "subtitle");
  const allowedSubtitleIndexes =
    payload.subtitleTrackIndexes && payload.subtitleTrackIndexes.length > 0
      ? new Set(payload.subtitleTrackIndexes)
      : null;
  const subtitleDir = joinPath(jobDir, "subtitles");
  if (payload.includeSubtitles !== false) {
    for (let index = 0; index < subtitleStreams.length; index += 1) {
      if (allowedSubtitleIndexes && !allowedSubtitleIndexes.has(index)) continue;
      const stream = subtitleStreams[index];
      const override = subtitleOverrideMap.get(index);
      const language =
        override?.language?.trim() ||
        parseLanguage(stream, "und");
      const label =
        override?.label?.trim() ||
        parseLabel(stream, language === "und" ? "Undefined" : language.toUpperCase());
      const codec = String(stream.codec_name ?? "");
      const { format, codecArgs } = resolveSubtitleOutput(codec);
      let entry = state.subtitles.find((item) => item.id === `sub-${index}`);
      if (!entry || !(await exists(entry.path))) {
        startTranscodeStep();
        throwIfAborted(payload.signal);
        const outputPath = await extractSubtitle(
          payload.inputPath,
          subtitleDir,
          index,
          format,
          codecArgs,
          payload.signal,
          logLine(`subtitle-${index}`),
          makeProgressHandler()
        );
        entry = {
          id: `sub-${index}`,
          path: outputPath,
          language,
          label,
          format,
        };
        const existingIndex = state.subtitles.findIndex((item) => item.id === `sub-${index}`);
        if (existingIndex >= 0) {
          state.subtitles[existingIndex] = entry;
        } else {
          state.subtitles.push(entry);
        }
        finishTranscodeStep();
        await stateStore.save();
      }
      subtitleStates.push(entry);
    }
  }

  // Pre-upload `produced` view: metadata-only, chunks empty until
  // uploadProducedMedia runs. Useful as a cache key for callers that need
  // a uniform `ProducedMedia` shape across the extract → upload → commit
  // chain.
  const preUploadProduced = buildEmptyProducedMedia(state, subtitleStates);

  return {
    jobDir,
    stateStore,
    encoder,
    produced: preUploadProduced,
  };
};

/**
 * Build a pre-upload `ProducedMedia` view from a state store. Chunks are
 * empty (not uploaded yet); other metadata (quality, codec, language,
 * label, durationSeconds, chapters) flows through. Mirrors the structure
 * `mediaFinalize.buildProducedMedia` returns post-upload, minus the chunks.
 */
const buildEmptyProducedMedia = (
  state: JobState<unknown>,
  subtitleStates: SubtitleState[]
): ProducedMedia => {
  const videoFormats: ProducedVideoFormat[] = [];
  const audioTracks: ProducedAudioTrack[] = [];
  const subtitleTracks: ProducedSubtitle[] = [];
  for (const output of state.outputs) {
    if (output.kind === "video") {
      videoFormats.push({
        quality: output.quality ?? "unknown",
        codec: output.codec ?? "h264",
        codecString: output.codecString ?? null,
        initKey: output.init?.key ?? "",
        initSize: output.init?.sizeBytes ?? 0,
        durationSeconds: output.durationSeconds ?? null,
        totalSize: 0,
        chunks: [],
        chapters: output.chapters,
      });
      continue;
    }
    audioTracks.push({
      language: output.language ?? "und",
      label: output.label ?? output.language?.toUpperCase() ?? "Audio",
      codec: output.codec ?? "aac",
      codecString: output.codecString ?? null,
      initKey: output.init?.key ?? "",
      initSize: output.init?.sizeBytes ?? 0,
      durationSeconds: output.durationSeconds ?? null,
      totalSize: 0,
      chunks: [],
      isDefault: audioTracks.length === 0,
    });
  }
  for (const subtitle of subtitleStates) {
    subtitleTracks.push({
      language: subtitle.language,
      label: subtitle.label,
      objectKey: subtitle.key ?? "",
      format: subtitle.format,
      isDefault: false,
    });
  }
  return { videoFormats, audioTracks, subtitleTracks };
};

/**
 * Input shape for `uploadProducedMedia` — the upload-only entrypoint.
 *
 * `scope` selects which outputs participate:
 * - `"source"`  → video-source + every audio output + every subtitle output
 * - `"format"`  → exactly one quality variant (e.g. `"360p"`), and nothing
 *                  else. Audio + subtitles already uploaded by the source
 *                  scope.
 * - `"all"`     → every output in the state store (legacy composition;
 *                  preserves the pre-split `processMediaJob` contract).
 *
 * `uploadProducedMedia` opens the `ResumableJobStateStore` from disk by
 * `(userId, jobId)` — same convention as `produceMediaOutputs`. Callers
 * that already have a live store handle can pass it as `stateStore` to
 * avoid re-reading `job_state.json`. Restart-after-crash cases (where the
 * extract step ran in a previous process) MUST omit `stateStore` so we
 * re-load from disk.
 */
export interface UploadProducedMediaArgs {
  token: string;
  userId: string;
  jobId: string;
  scope: "source" | "format" | "all";
  variant?: string;
  /**
   * Per-media silo placement (#145). All objects of one media (source and
   * every format job) share it; see `isValidPlacementId`.
   */
  placementId: string;
  /**
   * Optional live store handle. When provided, this exact store + its
   * in-flight OutputState references are mutated. When omitted, the upload
   * step opens a fresh store from `job_state.json` on disk — the standard
   * cross-process resume path.
   */
  stateStore?: ResumableJobStateStore<unknown>;
  signal?: AbortSignal;
  onProgress?: (stage: "uploading", progress: number) => void;
  onLog?: (line: string) => void;
}

/**
 * Output of `uploadProducedMedia`. The same `ProducedMedia` shape the old
 * `processMediaJob` returned — but produced from the now-uploaded state
 * store directly, so all `chunks[]` carry their real `key`/`sizeBytes`
 * straight from this call. Existing callers that consumed
 * `processMediaJob.produced` keep working unchanged.
 */
export interface UploadProducedMediaResult {
  produced: ProducedMedia;
  uploadedKeys: string[];
}

const scopedOutputIds = (
  state: JobState<unknown>,
  scope: "source" | "format" | "all",
  variant: string | undefined
): Set<string> => {
  if (scope === "all") {
    return new Set(state.outputs.map((output) => output.id));
  }
  if (scope === "source") {
    // Source scope: video-source + every audio output (chapters + subs are
    // also source-owned, handled below). The fallback variant is NOT in the
    // source scope — it ships on its own format job.
    const ids = new Set<string>();
    for (const output of state.outputs) {
      if (output.id === "video-source") ids.add(output.id);
      else if (output.kind === "audio") ids.add(output.id);
    }
    return ids;
  }
  // format scope: select only the matching variant's video output
  if (!variant) {
    return new Set<string>();
  }
  // Match the variant's video output by quality. Output IDs follow
  // `video-<quality>-<codec>` (e.g. `video-360p-h264`, `video-720p-h264`,
  // `video-2160p-hevc`). The pre-Phase-3 360p output id is kept by the
  // encoder for byte-equivalence; the quality match is the canonical filter.
  const targets = new Set<string>();
  for (const output of state.outputs) {
    if (output.kind !== "video") continue;
    if (output.id === "video-source") continue;
    if (output.quality === variant) targets.add(output.id);
  }
  return targets;
};

/**
 * Upload-only entrypoint. Reads the `ResumableJobStateStore` produced by
 * `produceMediaOutputs`, encrypts every pending chunk via the runtime's
 * `encryptMediaObject`, pushes it through the `UploadSessionManager`, and
 * flips `segments[].uploaded = true` + persists state after each chunk.
 *
 * Idempotent at the chunk level: a segment with `uploaded === true` is
 * skipped (the prior key/size/checksum stay intact). This is the same
 * resume-after-crash guarantee `processMediaJob` always had.
 *
 * Progress: emits `"uploading"` ticks via `onProgress`, throttled identically
 * to `processMediaJob`. For deterministic linear progress the caller can
 * also rely on `finalizeMediaJob`'s internal `bumpUploadProgress` (called
 * after each chunk completes, byte-weighted by total upload size).
 *
 * Returns the canonical `ProducedMedia` plus the list of every object key
 * uploaded in this call (excludes already-uploaded segments).
 */
export const uploadProducedMedia = async (
  args: UploadProducedMediaArgs
): Promise<UploadProducedMediaResult> => {
  if (!args.token) {
    throw new Error("AUTH_REQUIRED");
  }
  throwIfAborted(args.signal);

  const jobDir = resolveJobDir(args.userId, args.jobId);
  // Re-load state from disk when the caller didn't pass a live handle.
  // This is the restart-after-crash recovery path — the extract step ran
  // in a previous process and persisted job_state.json; we open it here
  // to get every planned chunk + its `uploaded` flag.
  const stateStore = args.stateStore
    ?? (await ResumableJobStateStore.open<unknown>({
      jobDir,
      // open() reads existing state when present; the inputPath/userId
      // fallbacks are only used when no state exists yet (defensive).
      inputPath: "",
      userId: args.userId,
    }));

  const sessionManager = new UploadSessionManager(stateStore);
  const state = stateStore.getState();
  const inputPath = state.inputPath;
  const scopeIds = scopedOutputIds(state, args.scope, args.variant);
  // Derive these from state.outputs rather than re-probing the source.
  // duration is per-OutputState; chapters live on the source-output's
  // `chapters` array; audio count is the number of audio-kind outputs.
  const durationSeconds =
    state.outputs.find((o) => typeof o.durationSeconds === "number")
      ?.durationSeconds ?? null;
  const sourceOutput = state.outputs.find((o) => o.id === "video-source");
  const chapterBoundaries = (sourceOutput?.chapters ?? [])
    .map((entry) => Number(entry.startSeconds))
    .filter((value) => Number.isFinite(value));
  const audioStreamCount = state.outputs.filter((o) => o.kind === "audio").length;
  // For format scope, audio is already up via the source job — don't
  // require it again. For source/all scopes, audio is included.
  const includeAudio = args.scope === "format" ? false : true;
  const subtitleStates = state.subtitles;
  // Round-12: subtitles are extracted + uploaded as part of the source scope
  // (the source-job's commit reads them too). Format scope skips subtitles
  // entirely because they're already up. "all" scope (legacy composition)
  // includes them.
  const scopedSubtitles =
    args.scope === "format" ? [] : subtitleStates;
  // Same for chapter boundaries — only meaningful when finalizing the
  // source-side outputs. (Format scope already has chapters baked into the
  // source-job's format row.)
  const scopedChapters =
    args.scope === "format" ? [] : chapterBoundaries;
  // Scope the state's outputs view so finalizeMediaJob only touches the
  // selected ones. We do this by building a shallow state view; the
  // underlying store is updated in place because the OutputState objects
  // are shared references.
  const scopedState: JobState<unknown> = {
    ...state,
    outputs: state.outputs.filter((output) => scopeIds.has(output.id)),
    subtitles: scopedSubtitles,
  };
  // Linear progress passthrough — every byte-weighted progress sample from
  // finalizeMediaJob lands here, deduped on integer percent so we don't
  // emit the same value back-to-back. Downstream consumers (engineV2's
  // reportProgress / desktop renderer) do their own throttle; uploads
  // benefit from the tightest possible loop here so a stalled-upload
  // observer can spot regressions early. Pre-Phase-F the legacy
  // processMediaJob throttled at 400ms; the new model lets engineV2
  // batch.
  const lastEmit = { lastPct: -1 };
  const emitUpload = (pct: number) => {
    if (!args.onProgress) return;
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    if (clamped === lastEmit.lastPct) return;
    lastEmit.lastPct = clamped;
    args.onProgress("uploading", clamped);
  };

  // Snapshot which segments were already uploaded BEFORE finalize runs.
  // After finalize, `uploadedKeys` should contain only the chunks this
  // call actually pushed — pre-existing keys (from a prior crash) are
  // excluded so the caller can distinguish "uploaded this round" from
  // "already uploaded by a previous attempt".
  const preUploadedKeys = new Set<string>();
  for (const output of state.outputs) {
    if (!scopeIds.has(output.id)) continue;
    if (output.init?.uploaded && output.init.key) preUploadedKeys.add(output.init.key);
    for (const segment of output.segments) {
      if (segment.uploaded && segment.key) preUploadedKeys.add(segment.key);
    }
  }
  for (const subtitle of scopedSubtitles) {
    if (subtitle.uploaded && subtitle.key) preUploadedKeys.add(subtitle.key);
  }

  // Format scope: the source job has already produced + uploaded audio
  // (and its commit recorded it). Skip the audio-required guard for format
  // jobs — `audioStreamCount: 0` + `includeAudio: false` collapses it.
  const finalizeIncludeAudio =
    args.scope === "format" ? false : includeAudio;
  const finalizeAudioCount =
    args.scope === "format" ? 0 : audioStreamCount;

  const produced = await finalizeMediaJob({
    stateStore,
    state: scopedState,
    sessionManager,
    subtitleStates: scopedSubtitles,
    audioStreamCount: finalizeAudioCount,
    includeAudio: finalizeIncludeAudio,
    inputPath,
    jobDir,
    durationSeconds,
    chapterBoundaries: scopedChapters,
    signal: args.signal,
    onUploadProgress: emitUpload,
    onLog: args.onLog,
    placementId: args.placementId,
    uploadFile: (filePath, options) => uploadEncryptedFile(args.token, filePath, options),
    headObjects: async (keys, options) => {
      // Unconfigured = cannot verify; finalize then re-uploads every resumed
      // object rather than trusting it.
      if (!runtime.headStorageObjects) throw new Error("INGEST_RUNTIME_NOT_CONFIGURED: headStorageObjects");
      return runtime.headStorageObjects(args.token, keys, options);
    },
  });

  // Build the uploadedKeys list AFTER finalize completes — only newly-
  // uploaded chunks (not present in `preUploadedKeys`) count. Pre-uploaded
  // segments from a prior crash-recovery run are reachable via `produced`
  // but excluded here, so a fully-uploaded resume returns
  // `uploadedKeys.length === 0`.
  const uploadedKeys: string[] = [];
  for (const output of state.outputs) {
    if (!scopeIds.has(output.id)) continue;
    if (output.init?.uploaded && output.init.key && !preUploadedKeys.has(output.init.key)) {
      uploadedKeys.push(output.init.key);
    }
    for (const segment of output.segments) {
      if (segment.uploaded && segment.key && !preUploadedKeys.has(segment.key)) {
        uploadedKeys.push(segment.key);
      }
    }
  }
  for (const subtitle of scopedSubtitles) {
    if (subtitle.uploaded && subtitle.key && !preUploadedKeys.has(subtitle.key)) {
      uploadedKeys.push(subtitle.key);
    }
  }

  return { produced, uploadedKeys };
};

/**
 * Legacy single-call entrypoint. Composes `produceMediaOutputs` +
 * `uploadProducedMedia` so existing callers
 * (apps/badger/desktop/src/main/mediaIngest.ts,
 * apps/runtime/src/modules/badgerIngest.ts) keep working unchanged.
 *
 * Externally-observed behavior is identical to the pre-split version:
 * - emits `"transcoding"` then `"uploading"` progress in sequence
 * - returns `{ produced, encoder }` with the same shape
 * - throws the same error codes (`AUTH_REQUIRED`, `NO_VIDEO_STREAM`,
 *   `CANCELLED`)
 *
 * Phase D step handlers (`apps/runtime/src/modules/badger/steps/`) bypass
 * this and call `produceMediaOutputs` / `uploadProducedMedia` directly so
 * the extract step finishes BEFORE the upload step's first network call —
 * the engineV2 lane model is then honest end-to-end.
 */
export const processMediaJob = async (payload: ProcessMediaJobPayload): Promise<{ produced: ProducedMedia; encoder: Exclude<VideoEncoder, "copy"> }> => {
  if (!payload.token) {
    throw new Error("AUTH_REQUIRED");
  }
  // Forward transcoding progress as the encode pass runs, then upload
  // progress as the upload pass runs — same shape the pre-split monolith
  // emitted (transcoding → uploading). The two phases now run serially in
  // composition, but for legacy callers the externally-observed sequence
  // is unchanged.
  const outputs = await produceMediaOutputs(payload);
  const { produced } = await uploadProducedMedia({
    token: payload.token,
    userId: payload.userId,
    jobId: payload.jobId,
    placementId: payload.placementId,
    scope: "all",
    stateStore: outputs.stateStore,
    signal: payload.signal,
    onProgress: payload.onProgress
      ? (_stage, pct) => payload.onProgress!("uploading", pct)
      : undefined,
    onLog: payload.onLog,
  });

  return { encoder: outputs.encoder, produced };
};
