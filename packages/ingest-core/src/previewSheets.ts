/**
 * Seek-bar preview sheets (MPV-PREV-01), made at import from the local file.
 *
 * One ffmpeg pass decodes the video and writes one small PNG every 5 s (`-r 1/5`; the bundled ffmpeg has no
 * `fps` filter, the output frame rate does the sampling), 160 px wide, height following the display shape. The
 * runtime then packs them 10 x 10 into raw RGB sheets and has ffmpeg's `mjpeg` encoder write each sheet as one
 * JPEG at `-q:v 10`.
 *
 * The output rate drops frames only after the filter graph, so every frame of the film is decoded and scaled:
 * that is the whole cost of the pass. On a computer whose hardware encoder works (NVENC, VA-API, VideoToolbox) the
 * decode and, for CUDA and VA-API, the scale to 160 px run on the graphics card, and only the small picture comes
 * back to the CPU. Any failure of that pass reruns it on the CPU, so a card that cannot decode a file never
 * costs its previews (`generatePreviewSheets`).
 *
 * Sheets are put together here and not with ffmpeg's `tile` filter, which the bundled build lacks
 * (`packages/media-deps/src/features.ts`): adding it means rebuilding and re-shipping ffmpeg for every OS for a
 * filter the runtime replaces with a few lines of pixel copying (about 15 KB per picture, 1,440 pictures for a
 * 2-hour film), on parts the build already has (`png` encoder/decoder, `rawvideo` demuxer + decoder, `mjpeg`).
 * The bundled build also has no `rawvideo` encoder, hence PNG for the intermediate pictures (pngjs reads them).
 *
 * Every ffmpeg run goes through the caller's runner, which spawns at the encoders' background priority and under
 * the per-computer playback policy (INGS-LANE-01/02).
 */
/// <reference path="./pngjs.d.ts" />
import { promises as fs } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { PNG } from "pngjs";
import {
  PREVIEW_INTERVAL_SECONDS,
  PREVIEW_PICTURE_WIDTH,
  PREVIEW_SHEET_COLUMNS,
  PREVIEW_SHEET_ROWS,
} from "@space/shared/previewSheets";
import {
  SKIP_PICTURE_FPS,
  SKIP_PICTURE_HEIGHT,
  SKIP_PICTURE_WIDTH,
  skipPictureFrame,
  skipPictureHeadSeconds,
  skipPictureTailOffset,
  skipPictureWindowToPayload,
  type SkipPicturePayload,
  type SkipPictureWindow,
} from "./skipDetect/picture";

/** JPEG quantiser of a sheet (`mjpeg -q:v`), agent reading approved by Main (2026-10-30, MPV-PREV-01 notes). */
export const PREVIEW_JPEG_QSCALE = 10;

export type GeneratedPreviewSheet = {
  path: string;
  firstPicture: number;
  pictureCount: number;
  /** Sheet pixel size (columns x pictureWidth by usedRows x pictureHeight). */
  width: number;
  height: number;
};

export type GeneratedPreviewSheets = {
  intervalSeconds: number;
  pictureWidth: number;
  pictureHeight: number;
  columns: number;
  rows: number;
  pictureCount: number;
  /** Pictures ffmpeg actually wrote (the plan pads or trims to `pictureCount`). */
  decodedPictures: number;
  sheets: GeneratedPreviewSheet[];
  /** The skip-detection picture windows written by the same decode; null when not asked or not readable. */
  skipPicture: SkipPicturePayload | null;
};

export type PreviewFfmpegRunner = (args: string[]) => Promise<unknown>;

/** Pictures for a duration: one per started 5 s. Null when the duration is unknown. */
export const previewPictureCountFor = (durationSeconds: number | null | undefined): number | null => {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.max(1, Math.ceil(durationSeconds / PREVIEW_INTERVAL_SECONDS));
};

/** Split `pictureCount` pictures into sheets of `columns * rows`. */
export const planPreviewSheets = (pictureCount: number, perSheet = PREVIEW_SHEET_COLUMNS * PREVIEW_SHEET_ROWS) => {
  const plan: Array<{ firstPicture: number; pictureCount: number }> = [];
  for (let first = 0; first < pictureCount; first += perSheet) {
    plan.push({ firstPicture: first, pictureCount: Math.min(perSheet, pictureCount - first) });
  }
  return plan;
};

/**
 * Graphics-card decode of the sampling pass, from the computer's working hardware encoder: `cuda` (NVDEC + the
 * `scale_cuda` filter), `vaapi` (VA-API decode + `scale_vaapi` on that render node), `videotoolbox` (decode only:
 * the bundled macOS build has no hardware scale filter, so the CPU scales the decoded frames).
 */
export type PreviewHardwareDecode =
  | { kind: "cuda" }
  | { kind: "vaapi"; device: string }
  | { kind: "videotoolbox" };

/** Named CUDA device shared by NVDEC and the filter graph, so decoded frames stay on the card. */
const PREVIEW_CUDA_DEVICE = "sf_preview_cuda";

/** Width 160, height from the display aspect ratio (anamorphic DVD sources included), kept even. */
const PREVIEW_HEIGHT_EXPR = `'max(2,trunc(${PREVIEW_PICTURE_WIDTH}/dar/2)*2)'`;

/** Decode flags (before `-i`) and the scale chain of the sampling pass, per decode path. */
const previewDecodeArgs = (hardware: PreviewHardwareDecode | null): { input: string[]; filter: string } => {
  const cpuScale = `scale=${PREVIEW_PICTURE_WIDTH}:${PREVIEW_HEIGHT_EXPR}:flags=bilinear`;
  switch (hardware?.kind) {
    case "cuda":
      return {
        input: [
          "-init_hw_device",
          `cuda=${PREVIEW_CUDA_DEVICE}`,
          "-filter_hw_device",
          PREVIEW_CUDA_DEVICE,
          "-hwaccel",
          "cuda",
          "-hwaccel_device",
          PREVIEW_CUDA_DEVICE,
          "-hwaccel_output_format",
          "cuda",
        ],
        // `hwupload` passes NVDEC's frames through and uploads the frames ffmpeg decodes in software when NVDEC
        // cannot (4:4:4, some profiles), so the scale always runs on the card; only the 160 px picture comes back.
        filter: `hwupload,scale_cuda=${PREVIEW_PICTURE_WIDTH}:${PREVIEW_HEIGHT_EXPR}:interp_algo=bilinear:format=nv12,hwdownload,format=nv12`,
      };
    case "vaapi":
      return {
        input: ["-vaapi_device", hardware.device, "-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"],
        // `format=nv12|vaapi` + `hwupload`: VA-API frames pass through, software-decoded ones (10-bit or 4:4:4 the
        // card cannot decode) are converted and uploaded, so `scale_vaapi` never gets a frame it cannot take.
        filter: `format=nv12|vaapi,hwupload,scale_vaapi=w=${PREVIEW_PICTURE_WIDTH}:h=${PREVIEW_HEIGHT_EXPR}:mode=fast:format=nv12,hwdownload,format=nv12`,
      };
    case "videotoolbox":
      return { input: ["-hwaccel", "videotoolbox"], filter: cpuScale };
    default:
      return { input: [], filter: cpuScale };
  }
};

/**
 * The skip-detection picture windows (META-SKIP-04) the same decode writes as extra outputs: 160x90 grey PNGs, 4 per
 * second, of the head window (`-t headSeconds`) and the tail window (`-ss tailOffsetSeconds`).
 * Frame k of a window shows the video at `offset + k / 4`.
 */
export type SkipPictureOutputs = {
  headPattern: string;
  headSeconds: number;
  tailPattern: string;
  tailOffsetSeconds: number;
};

const skipPictureFilter = (hardware: PreviewHardwareDecode | null, decodeFilter: string) => {
  const grey = `scale=${SKIP_PICTURE_WIDTH}:${SKIP_PICTURE_HEIGHT}:flags=fast_bilinear,format=gray`;
  // CUDA scales straight to the skip size with nearest sampling, which keeps credits text as sharp as the CPU path's
  // `fast_bilinear`: the card's bilinear averages the thin white letters away, and the credits test then sees no text
  // on the dark frames (Parks and Recreation S2E01–E04 lost every credits start that way).
  if (hardware?.kind === "cuda") {
    return `hwupload,scale_cuda=${SKIP_PICTURE_WIDTH}:${SKIP_PICTURE_HEIGHT}:interp_algo=nearest:format=nv12,hwdownload,format=nv12,format=gray`;
  }
  // VA-API frames stay on the card until the decode chain's `hwdownload`; the CPU path scales once.
  return hardware?.kind === "vaapi" ? `${decodeFilter},${grey}` : grey;
};

const skipPictureOutputArgs = (filter: string, threadsOutput: string[], window: string[], pattern: string) => [
  "-map",
  "0:V:0",
  "-an",
  "-sn",
  "-dn",
  "-vf",
  filter,
  ...threadsOutput,
  ...window,
  "-r",
  String(SKIP_PICTURE_FPS),
  "-c:v",
  "png",
  "-f",
  "image2",
  pattern,
];

/**
 * ffmpeg arguments of the sampling pass (exported for the arg-shape tests). `hardware` null decodes on the CPU.
 * `framePattern` null writes only the skip-detection windows (a signatures-only run); every output shares one decode.
 */
export const buildPreviewSampleArgs = (args: {
  inputPath: string;
  framePattern: string | null;
  threads: { input: string[]; output: string[] };
  hardware?: PreviewHardwareDecode | null;
  skipPicture?: SkipPictureOutputs | null;
}) => {
  const hardware = args.hardware ?? null;
  const decode = previewDecodeArgs(hardware);
  const outputs: string[] = [];
  if (args.framePattern) {
    outputs.push(
      // `V` (capital) skips attached cover pictures, which Matroska / MP4 list as video streams.
      "-map",
      "0:V:0",
      "-an",
      "-sn",
      "-dn",
      "-vf",
      decode.filter,
      ...args.threads.output,
      "-r",
      `1/${PREVIEW_INTERVAL_SECONDS}`,
      "-c:v",
      "png",
      "-f",
      "image2",
      args.framePattern
    );
  }
  const skip = args.skipPicture;
  if (skip) {
    const filter = skipPictureFilter(hardware, decode.filter);
    outputs.push(...skipPictureOutputArgs(filter, args.threads.output, ["-t", skip.headSeconds.toFixed(3)], skip.headPattern));
    outputs.push(...skipPictureOutputArgs(filter, args.threads.output, ["-ss", skip.tailOffsetSeconds.toFixed(3)], skip.tailPattern));
  }
  if (outputs.length === 0) throw new Error("PREVIEW_NO_OUTPUT");
  return [
    "-nostdin",
    "-y",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "warning",
    ...args.threads.input,
    ...decode.input,
    // Skips the deblocking pass: invisible at 160 px, and the decode is the whole cost of this pass.
    "-skip_loop_filter",
    "all",
    "-i",
    args.inputPath,
    ...outputs,
  ];
};

/** The windows of a video of `durationSeconds`, under `dir`. */
export const planSkipPictureOutputs = (dir: string, durationSeconds: number): SkipPictureOutputs => ({
  headPattern: joinPath(dir, "head", "%06d.png"),
  headSeconds: skipPictureHeadSeconds(durationSeconds),
  tailPattern: joinPath(dir, "tail", "%06d.png"),
  tailOffsetSeconds: skipPictureTailOffset(durationSeconds),
});

const prepareSkipPictureDirs = async (outputs: SkipPictureOutputs) => {
  for (const pattern of [outputs.headPattern, outputs.tailPattern]) {
    await fs.rm(dirname(pattern), { recursive: true, force: true });
    await fs.mkdir(dirname(pattern), { recursive: true });
  }
};

/** Hash every grey picture of one window directory, in order (one picture in memory at a time). */
const readSkipPictureWindow = async (dir: string, offsetSeconds: number): Promise<SkipPictureWindow> => {
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".png")).sort();
  const hashes = new Uint32Array(names.length * 2);
  const flags = new Uint8Array(names.length);
  const gray = new Uint8Array(SKIP_PICTURE_WIDTH * SKIP_PICTURE_HEIGHT);
  for (const [index, name] of names.entries()) {
    const picture = PNG.sync.read(await fs.readFile(joinPath(dir, name)));
    if (picture.width !== SKIP_PICTURE_WIDTH || picture.height !== SKIP_PICTURE_HEIGHT) {
      throw new Error(`SKIP_PICTURE_SIZE:${name}:${picture.width}x${picture.height}`);
    }
    for (let i = 0; i < gray.length; i++) gray[i] = picture.data[i * 4]!;
    const frame = skipPictureFrame(gray);
    hashes[index * 2] = frame.lo;
    hashes[index * 2 + 1] = frame.hi;
    flags[index] = frame.flags;
  }
  return { offsetSeconds, hashes, flags };
};

/** The picture half of a skip signature from the windows a sampling pass wrote. Throws when a window is empty. */
const readSkipPicture = async (outputs: SkipPictureOutputs): Promise<SkipPicturePayload> => {
  const head = await readSkipPictureWindow(dirname(outputs.headPattern), 0);
  const tail = await readSkipPictureWindow(dirname(outputs.tailPattern), outputs.tailOffsetSeconds);
  if (head.flags.length === 0 || tail.flags.length === 0) throw new Error("SKIP_PICTURE_EMPTY");
  return { fps: SKIP_PICTURE_FPS, head: skipPictureWindowToPayload(head), tail: skipPictureWindowToPayload(tail) };
};

const removeSkipPictureDirs = async (outputs: SkipPictureOutputs | null) => {
  if (!outputs) return;
  for (const pattern of [outputs.headPattern, outputs.tailPattern]) await fs.rm(dirname(pattern), { recursive: true, force: true });
};

/**
 * Signatures-only run (a video that already has its preview sheets): one decode writes only the two windows.
 * Falls back to the CPU like `generatePreviewSheets`.
 */
export const generateSkipPicture = async (args: {
  inputPath: string;
  workDir: string;
  durationSeconds: number;
  run: PreviewFfmpegRunner;
  threads: { input: string[]; output: string[] };
  hardware?: PreviewHardwareDecode | null;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}): Promise<SkipPicturePayload> => {
  const outputs = planSkipPictureOutputs(args.workDir, args.durationSeconds);
  const sample = async (hardware: PreviewHardwareDecode | null) => {
    await prepareSkipPictureDirs(outputs);
    const startedAt = Date.now();
    await args.run(buildPreviewSampleArgs({ inputPath: args.inputPath, framePattern: null, threads: args.threads, hardware, skipPicture: outputs }));
    // A pass told to give way (MPV-PREV-07) does not hash the pictures of a decode that ended as it was told.
    if (args.signal?.aborted) throw new Error("CANCELLED");
    return readSkipPicture(outputs).then((picture) => ({ picture, ms: Date.now() - startedAt }));
  };
  try {
    const hardware = args.hardware ?? null;
    try {
      const { picture, ms } = await sample(hardware);
      args.onLog?.(`[skip-detect] picture.sampled decode=${hardware?.kind ?? "cpu"} ms=${ms}`);
      return picture;
    } catch (error) {
      if (!hardware || args.signal?.aborted) throw error;
      args.onLog?.(`[skip-detect] ${hardware.kind} decode failed, sampling again on the CPU: ${error instanceof Error ? error.message : String(error)}`);
      const { picture, ms } = await sample(null);
      args.onLog?.(`[skip-detect] picture.sampled decode=cpu ms=${ms}`);
      return picture;
    }
  } finally {
    await removeSkipPictureDirs(outputs);
  }
};

/** ffmpeg arguments that turn one raw RGB sheet into the stored JPEG. */
export const buildPreviewSheetEncodeArgs = (args: { rawPath: string; width: number; height: number; outputPath: string }) => [
  "-nostdin",
  "-y",
  "-hide_banner",
  "-nostats",
  "-loglevel",
  "warning",
  "-f",
  "rawvideo",
  "-pix_fmt",
  "rgb24",
  "-s:v",
  `${args.width}x${args.height}`,
  "-i",
  args.rawPath,
  "-frames:v",
  "1",
  "-c:v",
  "mjpeg",
  "-pix_fmt",
  "yuvj420p",
  "-q:v",
  String(PREVIEW_JPEG_QSCALE),
  "-f",
  "image2",
  "-update",
  "1",
  args.outputPath,
];

/**
 * Make the sheets of `inputPath` under `workDir` (`sheet-000.jpg`, ...). Throws on any failure; the caller decides
 * that previews are optional. Intermediate pictures are removed before returning, the sheets stay for upload.
 */
export const generatePreviewSheets = async (args: {
  inputPath: string;
  workDir: string;
  durationSeconds: number | null;
  run: PreviewFfmpegRunner;
  threads: { input: string[]; output: string[] };
  /** Decode on the graphics card first; null decodes on the CPU. */
  hardware?: PreviewHardwareDecode | null;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  /** Also write the skip-detection picture windows (META-SKIP-04): an episode's run. */
  skipPicture?: boolean;
}): Promise<GeneratedPreviewSheets> => {
  const log = (line: string) => args.onLog?.(`[preview-sheets] ${line}`);
  const framesDir = joinPath(args.workDir, "frames");
  await fs.rm(args.workDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });
  const skipOutputs =
    args.skipPicture && args.durationSeconds && args.durationSeconds >= 60
      ? planSkipPictureOutputs(joinPath(args.workDir, "skip"), args.durationSeconds)
      : null;
  try {
    const framePattern = joinPath(framesDir, "%06d.png");
    const sample = async (hardware: PreviewHardwareDecode | null) => {
      if (skipOutputs) await prepareSkipPictureDirs(skipOutputs);
      const startedAt = Date.now();
      await args.run(
        buildPreviewSampleArgs({ inputPath: args.inputPath, framePattern, threads: args.threads, hardware, skipPicture: skipOutputs })
      );
      return Date.now() - startedAt;
    };
    const hardware = args.hardware ?? null;
    let decodedOn = hardware?.kind ?? "cpu";
    let sampleMs: number;
    try {
      sampleMs = await sample(hardware);
      // A hardware pass that exits cleanly with no pictures counts as failed too.
      if (hardware && !(await fs.readdir(framesDir)).some((name) => name.endsWith(".png"))) throw new Error("no pictures");
    } catch (error) {
      if (!hardware || args.signal?.aborted) throw error;
      // The card could not decode or scale this file: the pass runs again on the CPU, from no pictures.
      log(`${hardware.kind} decode failed, sampling again on the CPU: ${error instanceof Error ? error.message : String(error)}`);
      await fs.rm(framesDir, { recursive: true, force: true });
      await fs.mkdir(framesDir, { recursive: true });
      decodedOn = "cpu";
      sampleMs = await sample(null);
    }
    const frames = (await fs.readdir(framesDir)).filter((name) => name.endsWith(".png")).sort();
    log(`sampled pictures=${frames.length} decode=${decodedOn} ms=${sampleMs} durationSeconds=${args.durationSeconds ?? "unknown"}`);
    if (frames.length === 0) throw new Error("PREVIEW_NO_PICTURES");

    // The skip windows are optional on top of the sheets: one that cannot be read leaves the sheets as they are.
    let skipPicture: SkipPicturePayload | null = null;
    if (skipOutputs) {
      try {
        skipPicture = await readSkipPicture(skipOutputs);
        log(`skip pictures head=${skipPicture.head.flags.length ? Buffer.from(skipPicture.head.flags, "base64").byteLength : 0} tail=${Buffer.from(skipPicture.tail.flags, "base64").byteLength}`);
      } catch (error) {
        log(`skip pictures unreadable: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await removeSkipPictureDirs(skipOutputs);
      }
    }

    // The duration decides the count (one per started 5 s); ffmpeg's output-rate sampling can land one picture
    // over or under it at the end, which is trimmed or padded with the last picture.
    const pictureCount = previewPictureCountFor(args.durationSeconds) ?? frames.length;
    const first = PNG.sync.read(await fs.readFile(joinPath(framesDir, frames[0]!)));
    const pictureWidth = first.width;
    const pictureHeight = first.height;
    const columns = PREVIEW_SHEET_COLUMNS;
    const rows = PREVIEW_SHEET_ROWS;
    const plan = planPreviewSheets(pictureCount, columns * rows);
    const sheets: GeneratedPreviewSheet[] = [];

    for (const [sheetIndex, entry] of plan.entries()) {
      const usedRows = Math.ceil(entry.pictureCount / columns);
      const width = columns * pictureWidth;
      const height = usedRows * pictureHeight;
      const canvas = Buffer.alloc(width * height * 3);
      for (let i = 0; i < entry.pictureCount; i += 1) {
        const frameName = frames[Math.min(entry.firstPicture + i, frames.length - 1)]!;
        const picture = PNG.sync.read(await fs.readFile(joinPath(framesDir, frameName)));
        if (picture.width !== pictureWidth || picture.height !== pictureHeight) {
          throw new Error(`PREVIEW_PICTURE_SIZE_CHANGED:${frameName}:${picture.width}x${picture.height}`);
        }
        const originX = (i % columns) * pictureWidth;
        const originY = Math.floor(i / columns) * pictureHeight;
        for (let y = 0; y < pictureHeight; y += 1) {
          let source = y * pictureWidth * 4;
          let target = ((originY + y) * width + originX) * 3;
          for (let x = 0; x < pictureWidth; x += 1) {
            canvas[target] = picture.data[source]!;
            canvas[target + 1] = picture.data[source + 1]!;
            canvas[target + 2] = picture.data[source + 2]!;
            source += 4;
            target += 3;
          }
        }
      }
      const name = `sheet-${String(sheetIndex).padStart(3, "0")}`;
      const rawPath = joinPath(args.workDir, `${name}.rgb`);
      const outputPath = joinPath(args.workDir, `${name}.jpg`);
      await fs.writeFile(rawPath, canvas);
      await args.run(buildPreviewSheetEncodeArgs({ rawPath, width, height, outputPath }));
      await fs.rm(rawPath, { force: true });
      const { size } = await fs.stat(outputPath);
      log(`sheet=${sheetIndex} pictures=${entry.pictureCount} first=${entry.firstPicture} size=${width}x${height} bytes=${size}`);
      sheets.push({ path: outputPath, firstPicture: entry.firstPicture, pictureCount: entry.pictureCount, width, height });
    }

    return {
      intervalSeconds: PREVIEW_INTERVAL_SECONDS,
      pictureWidth,
      pictureHeight,
      columns,
      rows,
      pictureCount,
      decodedPictures: frames.length,
      sheets,
      skipPicture,
    };
  } finally {
    await fs.rm(framesDir, { recursive: true, force: true });
    await removeSkipPictureDirs(skipOutputs);
  }
};
