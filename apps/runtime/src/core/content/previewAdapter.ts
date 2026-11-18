import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { PNG } from "pngjs";
import { encryptContentObject, type ContentPreviewRef, uploadEncryptedContentBytes } from "@space/content-core";
import { runFfmpeg, runFfprobe } from "@space/ffmpeg";
import { resolveRuntimeFfmpegPath, resolveRuntimeFfprobePath } from "./ffmpegRuntime";
import { guessContentMimeType, isAudioMimeType, isImageMimeType, isVideoMimeType } from "./mime";
import type { StorageObjectCounting } from "@space/shared/storageCounting";

type PreviewSizeSpec = {
  size: "small" | "large";
  dimension: number;
};

type PreviewUploadResult = {
  objectKey: string;
  sizeBytes: number;
};

type DeriveRuntimeContentPreviewsArgs = {
  source: {
    localPath: string;
    mimeType: string | null;
  };
  contentKeyBase64: string;
  objectNamespace: string;
  uploadObject: (args: {
    objectKey: string;
    payload: Uint8Array;
    objectNamespace: string;
    logicalRef: string;
    contentType: string;
    /** How the object counts toward the allowance (STOR-USE-02). */
    counting?: StorageObjectCounting;
  }) => Promise<PreviewUploadResult>;
  ffmpegPath?: string;
  ffprobePath?: string;
};

const PREVIEW_SPECS: PreviewSizeSpec[] = [
  { size: "small", dimension: 256 },
  { size: "large", dimension: 768 },
];

const clampPosterSeekSeconds = (durationSeconds: number | null) => {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return "1";
  const seek = Math.min(120, Math.max(1, durationSeconds * 0.1));
  return seek.toFixed(3);
};

const squarePreviewFilter = (dimension: number) =>
  `scale=${dimension}:${dimension}:force_original_aspect_ratio=increase,crop=${dimension}:${dimension}`;

const compositeChannel = (channel: number | undefined, alpha: number | undefined) => {
  const value = channel ?? 0;
  const normalizedAlpha = (alpha ?? 255) / 255;
  return Math.round(value * normalizedAlpha + 255 * (1 - normalizedAlpha));
};

const deriveSquareRgbPreviewFromPng = (bytes: Uint8Array, dimension: number) => {
  const png = PNG.sync.read(Buffer.from(bytes));
  const cropSize = Math.min(png.width, png.height);
  if (cropSize <= 0) {
    throw new Error("invalid_png_dimensions");
  }
  const cropX = Math.floor((png.width - cropSize) / 2);
  const cropY = Math.floor((png.height - cropSize) / 2);
  const rgb = Buffer.alloc(dimension * dimension * 3);

  for (let y = 0; y < dimension; y += 1) {
    for (let x = 0; x < dimension; x += 1) {
      const sourceX = cropX + Math.min(cropSize - 1, Math.floor((x * cropSize) / dimension));
      const sourceY = cropY + Math.min(cropSize - 1, Math.floor((y * cropSize) / dimension));
      const sourceOffset = (sourceY * png.width + sourceX) * 4;
      const targetOffset = (y * dimension + x) * 3;
      rgb[targetOffset] = compositeChannel(png.data[sourceOffset], png.data[sourceOffset + 3]);
      rgb[targetOffset + 1] = compositeChannel(png.data[sourceOffset + 1], png.data[sourceOffset + 3]);
      rgb[targetOffset + 2] = compositeChannel(png.data[sourceOffset + 2], png.data[sourceOffset + 3]);
    }
  }

  return rgb;
};

const deriveVideoDurationSeconds = async (inputPath: string, ffprobePath: string) => {
  try {
    const probe = await runFfprobe(
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        inputPath,
      ],
      { ffprobePath }
    );
    const raw = probe.data?.format?.duration;
    const duration = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
};

const uploadDerivedPreview = async (args: {
  previewPath: string;
  kind: ContentPreviewRef["kind"];
  size: ContentPreviewRef["size"];
  sourcePath: string;
  contentKeyBase64: string;
  objectNamespace: string;
  uploadObject: DeriveRuntimeContentPreviewsArgs["uploadObject"];
}) => {
  const previewBytes = await readFile(args.previewPath);
  const uploaded = await uploadEncryptedContentBytes(
    {
      encryptObject: (bytes) => encryptContentObject(bytes, args.contentKeyBase64),
      uploadObject: async (_token, objectKey, payload, options) => {
        const uploaded = await args.uploadObject({
          objectKey,
          payload,
          objectNamespace: options?.objectNamespace ?? args.objectNamespace,
          logicalRef: options?.logicalRef ?? `${args.sourcePath}#preview:${args.kind}:${args.size}`,
          contentType: options?.contentType ?? "image/jpeg",
          counting: options?.counting,
        });
        return uploaded.objectKey;
      },
    },
    "runtime-preview",
    {
      plaintext: previewBytes,
      logicalRef: `${args.sourcePath}#preview:${args.kind}:${args.size}`,
      objectNamespace: args.objectNamespace,
      contentType: "image/jpeg",
      counting: { role: "preview" },
    }
  );
  return {
    kind: args.kind,
    size: args.size,
    objectKey: uploaded.key,
    mimeType: "image/jpeg",
    sizeBytes: uploaded.sizeBytes,
  } satisfies ContentPreviewRef;
};

export const deriveRuntimeContentPreviews = async (
  args: DeriveRuntimeContentPreviewsArgs
): Promise<ContentPreviewRef[]> => {
  const mimeType = args.source.mimeType ?? guessContentMimeType(args.source.localPath);
  const kind = isImageMimeType(mimeType)
    ? "image_thumb"
    : isVideoMimeType(mimeType)
      ? "video_poster"
      : isAudioMimeType(mimeType)
        ? "audio_cover"
        : null;
  if (!kind) return [];

  const ffmpegPath = args.ffmpegPath ?? resolveRuntimeFfmpegPath();
  const ffprobePath = args.ffprobePath ?? resolveRuntimeFfprobePath();
  if (!ffmpegPath) return [];
  if (kind === "video_poster" && !ffprobePath) return [];

  const tempDir = await mkdtemp(joinPath(tmpdir(), "spacefleet-content-preview-"));
  try {
    // For audio files, first try to extract embedded album art
    if (kind === "audio_cover") {
      const rawCoverPath = joinPath(tempDir, "cover-raw.jpg");
      try {
        await runFfmpeg(
          ["-y", "-i", args.source.localPath, "-an", "-vcodec", "copy", rawCoverPath],
          { ffmpegPath, progress: { enabled: false } }
        );
      } catch {
        // No embedded album art — nothing to generate
        return [];
      }
      // Resize extracted cover into preview specs
      const refs: ContentPreviewRef[] = [];
      for (const spec of PREVIEW_SPECS) {
        const outputPath = joinPath(tempDir, `${kind}-${spec.size}.jpg`);
        await runFfmpeg(
          ["-y", "-i", rawCoverPath, "-vf", squarePreviewFilter(spec.dimension), "-frames:v", "1", "-q:v", "4", outputPath],
          { ffmpegPath, progress: { enabled: false } }
        );
        refs.push(
          await uploadDerivedPreview({
            previewPath: outputPath,
            kind,
            size: spec.size,
            sourcePath: args.source.localPath,
            contentKeyBase64: args.contentKeyBase64,
            objectNamespace: args.objectNamespace,
            uploadObject: args.uploadObject,
          })
        );
      }
      return refs;
    }

    const durationSeconds =
      kind === "video_poster" && ffprobePath
        ? await deriveVideoDurationSeconds(args.source.localPath, ffprobePath)
        : null;

    const refs: ContentPreviewRef[] = [];
    for (const spec of PREVIEW_SPECS) {
      const outputPath = joinPath(tempDir, `${kind}-${spec.size}.jpg`);
      let ffmpegArgs: string[];
      if (kind === "image_thumb" && mimeType === "image/png") {
        const rgbPath = joinPath(tempDir, `${kind}-${spec.size}.rgb`);
        const sourceBytes = await readFile(args.source.localPath);
        const rgb = deriveSquareRgbPreviewFromPng(sourceBytes, spec.dimension);
        await writeFile(rgbPath, Buffer.from(rgb));
        ffmpegArgs = [
          "-y",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-s:v",
          `${spec.dimension}x${spec.dimension}`,
          "-i",
          rgbPath,
          "-frames:v",
          "1",
          "-q:v",
          "4",
          outputPath,
        ];
      } else {
        ffmpegArgs =
          kind === "image_thumb"
            ? [
                "-y",
                "-i",
                args.source.localPath,
                "-vf",
                squarePreviewFilter(spec.dimension),
                "-frames:v",
                "1",
                "-q:v",
                "4",
                outputPath,
              ]
            : [
                "-y",
                "-ss",
                clampPosterSeekSeconds(durationSeconds),
                "-i",
                args.source.localPath,
                "-vf",
                squarePreviewFilter(spec.dimension),
                "-frames:v",
                "1",
                "-q:v",
                "4",
                outputPath,
              ];
      }
      await runFfmpeg(ffmpegArgs, { ffmpegPath, progress: { enabled: false } });
      refs.push(
        await uploadDerivedPreview({
          previewPath: outputPath,
          kind,
          size: spec.size,
          sourcePath: args.source.localPath,
          contentKeyBase64: args.contentKeyBase64,
          objectNamespace: args.objectNamespace,
          uploadObject: args.uploadObject,
        })
      );
    }
    return refs;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};
