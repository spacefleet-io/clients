/**
 * Seek-bar preview sheets (MPV-PREV-01), made at import from the local file.
 *
 * One ffmpeg pass decodes the video and writes one small PNG every 5 s (`-r 1/5`; the bundled ffmpeg has no
 * `fps` filter, the output frame rate does the sampling), 160 px wide, height following the display shape. The
 * runtime then packs them 10 x 10 into raw RGB sheets and has ffmpeg's `mjpeg` encoder write each sheet as one
 * JPEG at `-q:v 10`.
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
import { join as joinPath } from "node:path";
import { PNG } from "pngjs";
import {
  PREVIEW_INTERVAL_SECONDS,
  PREVIEW_PICTURE_WIDTH,
  PREVIEW_SHEET_COLUMNS,
  PREVIEW_SHEET_ROWS,
} from "@space/shared/previewSheets";

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

/** ffmpeg arguments of the sampling pass (exported for the arg-shape tests). */
export const buildPreviewSampleArgs = (args: {
  inputPath: string;
  framePattern: string;
  threads: { input: string[]; output: string[] };
}) => [
  "-nostdin",
  "-y",
  "-hide_banner",
  "-nostats",
  "-loglevel",
  "warning",
  ...args.threads.input,
  // Skips the deblocking pass: invisible at 160 px, and the decode is the whole cost of this pass.
  "-skip_loop_filter",
  "all",
  "-i",
  args.inputPath,
  // `V` (capital) skips attached cover pictures, which Matroska / MP4 list as video streams.
  "-map",
  "0:V:0",
  "-an",
  "-sn",
  "-dn",
  "-vf",
  // Width 160, height from the display aspect ratio (anamorphic DVD sources included), kept even.
  `scale=${PREVIEW_PICTURE_WIDTH}:'max(2,trunc(${PREVIEW_PICTURE_WIDTH}/dar/2)*2)':flags=bilinear`,
  ...args.threads.output,
  "-r",
  `1/${PREVIEW_INTERVAL_SECONDS}`,
  "-c:v",
  "png",
  "-f",
  "image2",
  args.framePattern,
];

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
  onLog?: (line: string) => void;
}): Promise<GeneratedPreviewSheets> => {
  const log = (line: string) => args.onLog?.(`[preview-sheets] ${line}`);
  const framesDir = joinPath(args.workDir, "frames");
  await fs.rm(args.workDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });
  try {
    const sampleStartedAt = Date.now();
    await args.run(
      buildPreviewSampleArgs({ inputPath: args.inputPath, framePattern: joinPath(framesDir, "%06d.png"), threads: args.threads })
    );
    const frames = (await fs.readdir(framesDir)).filter((name) => name.endsWith(".png")).sort();
    log(`sampled pictures=${frames.length} ms=${Date.now() - sampleStartedAt} durationSeconds=${args.durationSeconds ?? "unknown"}`);
    if (frames.length === 0) throw new Error("PREVIEW_NO_PICTURES");

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
    };
  } finally {
    await fs.rm(framesDir, { recursive: true, force: true });
  }
};
