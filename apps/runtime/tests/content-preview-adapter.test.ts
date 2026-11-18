import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveRuntimeContentPreviews } from "../src/core/content/previewAdapter";

const { runFfmpegMock, runFfprobeMock } = vi.hoisted(() => ({
  runFfmpegMock: vi.fn(),
  runFfprobeMock: vi.fn(),
}));

vi.mock("@space/ffmpeg", () => ({
  runFfmpeg: runFfmpegMock,
  runFfprobe: runFfprobeMock,
}));

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps ffmpeg/ffprobe call args + refs on assertion
// failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpPreviewSnapshot = (
  label: string,
  ctx: {
    refs?: unknown;
    ffmpegCalls?: unknown[][];
    ffprobeCalls?: unknown[][];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [preview-adapter:${label}] snapshot ===`);
    if (ctx.refs !== undefined) {
      console.error(`refs=\n${JSON.stringify(ctx.refs, null, 2)}`);
    }
    if (ctx.ffmpegCalls) {
      console.error(`ffmpegCalls(${ctx.ffmpegCalls.length})=\n${JSON.stringify(ctx.ffmpegCalls, null, 2)}`);
    }
    if (ctx.ffprobeCalls) {
      console.error(`ffprobeCalls(${ctx.ffprobeCalls.length})=\n${JSON.stringify(ctx.ffprobeCalls, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime content preview adapter", () => {
  afterEach(() => {
    runFfmpegMock.mockReset();
    runFfprobeMock.mockReset();
  });

  it("@bugfix @regression-proof derives encrypted image thumbnails through the shared ffmpeg preview adapter", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "spacefleet-preview-image-"));
    console.info(`[preview-adapter:image-thumb-encrypt] tmp=${root}`);
    try {
      const sourcePath = joinPath(root, "photo.jpg");
      writeFileSync(sourcePath, Buffer.from("image-source-bytes"));
      const derivedOutputs = new Map<string, Buffer>();
      runFfmpegMock.mockImplementation(async (args: string[]) => {
        const outputPath = args[args.length - 1];
        const bytes = Buffer.from(`thumb:${outputPath}`);
        derivedOutputs.set(outputPath, bytes);
        writeFileSync(outputPath, bytes);
        return { stdout: "", stderr: "", code: 0 };
      });
      const uploadObject = vi.fn(async ({ objectKey, payload }: { objectKey: string; payload: Uint8Array }) => ({
        objectKey: `shards/dev/${objectKey}`,
        sizeBytes: payload.byteLength,
      }));

      const refs = await deriveRuntimeContentPreviews({
        source: {
          localPath: sourcePath,
          mimeType: "image/jpeg",
        },
        contentKeyBase64: Buffer.alloc(32, 8).toString("base64"),
        objectNamespace: "parrot",
        uploadObject,
        ffmpegPath: "/tmp/mock-ffmpeg",
      });
      console.info(`[preview-adapter:image-thumb-encrypt] refs.length=${refs.length} ffmpegCalls=${runFfmpegMock.mock.calls.length} uploadCalls=${uploadObject.mock.calls.length}`);

      try {
        expect(runFfmpegMock).toHaveBeenCalledTimes(2);
        expect(runFfprobeMock).not.toHaveBeenCalled();
        expect(refs).toEqual([
          expect.objectContaining({ kind: "image_thumb", size: "small", mimeType: "image/jpeg" }),
          expect.objectContaining({ kind: "image_thumb", size: "large", mimeType: "image/jpeg" }),
        ]);
        const uploaded = uploadObject.mock.calls[0]?.[0]?.payload as Uint8Array;
        const firstOutputPath = runFfmpegMock.mock.calls[0]?.[0]?.at(-1) as string;
        expect(Buffer.from(uploaded)).not.toEqual(derivedOutputs.get(firstOutputPath));
      } catch (err) {
        dumpPreviewSnapshot("image-thumb-encrypt-failure", {
          refs,
          ffmpegCalls: runFfmpegMock.mock.calls.map((c) => c as unknown[]),
          ffprobeCalls: runFfprobeMock.mock.calls.map((c) => c as unknown[]),
        });
        throw err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("@bugfix @regression-proof routes png thumbnails through a raw rgb input so preview generation does not depend on ffmpeg image decoding", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "spacefleet-preview-png-"));
    console.info(`[preview-adapter:png-raw-rgb] tmp=${root}`);
    try {
      const sourcePath = joinPath(root, "photo.png");
      const png = new PNG({ width: 4, height: 2 });
      for (let y = 0; y < png.height; y += 1) {
        for (let x = 0; x < png.width; x += 1) {
          const offset = (y * png.width + x) * 4;
          png.data[offset] = x < 2 ? 255 : 0;
          png.data[offset + 1] = y === 0 ? 128 : 255;
          png.data[offset + 2] = 32;
          png.data[offset + 3] = 255;
        }
      }
      writeFileSync(sourcePath, PNG.sync.write(png));
      runFfmpegMock.mockImplementation(async (args: string[]) => {
        const inputPath = args[args.indexOf("-i") + 1];
        if (inputPath.endsWith(".png")) {
          throw new Error("png decoder unavailable");
        }
        const outputPath = args[args.length - 1];
        writeFileSync(outputPath, Buffer.from(`thumb:${outputPath}`));
        return { stdout: "", stderr: "", code: 0 };
      });
      const uploadObject = vi.fn(async ({ objectKey, payload }: { objectKey: string; payload: Uint8Array }) => ({
        objectKey: `shards/dev/${objectKey}`,
        sizeBytes: payload.byteLength,
      }));

      const refs = await deriveRuntimeContentPreviews({
        source: {
          localPath: sourcePath,
          mimeType: "image/png",
        },
        contentKeyBase64: Buffer.alloc(32, 9).toString("base64"),
        objectNamespace: "parrot",
        uploadObject,
        ffmpegPath: "/tmp/mock-ffmpeg",
      });
      console.info(`[preview-adapter:png-raw-rgb] ffmpegCalls=${runFfmpegMock.mock.calls.length} refs.length=${refs.length}`);

      try {
        expect(runFfmpegMock).toHaveBeenCalledTimes(2);
        const firstArgs = runFfmpegMock.mock.calls[0]?.[0] as string[];
        expect(firstArgs).toContain("-f");
        expect(firstArgs).toContain("rawvideo");
        expect(firstArgs).toContain("-pix_fmt");
        expect(firstArgs).toContain("rgb24");
        expect(firstArgs[firstArgs.indexOf("-i") + 1]).toMatch(/\.rgb$/);
        expect(refs).toEqual([
          expect.objectContaining({ kind: "image_thumb", size: "small", mimeType: "image/jpeg" }),
          expect.objectContaining({ kind: "image_thumb", size: "large", mimeType: "image/jpeg" }),
        ]);
      } catch (err) {
        dumpPreviewSnapshot("png-raw-rgb-failure", {
          refs,
          ffmpegCalls: runFfmpegMock.mock.calls.map((c) => c as unknown[]),
        });
        throw err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives video poster previews using ffprobe duration to choose a representative seek point", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "spacefleet-preview-video-"));
    console.info(`[preview-adapter:video-poster] tmp=${root}`);
    try {
      const sourcePath = joinPath(root, "clip.mp4");
      writeFileSync(sourcePath, Buffer.from("video-source-bytes"));
      runFfprobeMock.mockResolvedValue({
        data: {
          format: {
            duration: "100",
          },
        },
        streams: [],
      });
      runFfmpegMock.mockImplementation(async (args: string[]) => {
        const outputPath = args[args.length - 1];
        writeFileSync(outputPath, Buffer.from(`poster:${outputPath}`));
        return { stdout: "", stderr: "", code: 0 };
      });
      const uploadObject = vi.fn(async ({ objectKey, payload }: { objectKey: string; payload: Uint8Array }) => ({
        objectKey: `shards/dev/${objectKey}`,
        sizeBytes: payload.byteLength,
      }));

      const refs = await deriveRuntimeContentPreviews({
        source: {
          localPath: sourcePath,
          mimeType: "video/mp4",
        },
        contentKeyBase64: Buffer.alloc(32, 5).toString("base64"),
        objectNamespace: "parrot",
        uploadObject,
        ffmpegPath: "/tmp/mock-ffmpeg",
        ffprobePath: "/tmp/mock-ffprobe",
      });
      console.info(`[preview-adapter:video-poster] ffprobeCalls=${runFfprobeMock.mock.calls.length} ffmpegCalls=${runFfmpegMock.mock.calls.length} refs.length=${refs.length}`);

      try {
        expect(runFfprobeMock).toHaveBeenCalledTimes(1);
        expect(runFfmpegMock).toHaveBeenCalledTimes(2);
        const firstArgs = runFfmpegMock.mock.calls[0]?.[0] as string[];
        expect(firstArgs).toContain("-ss");
        expect(firstArgs).toContain("10.000");
        expect(refs).toEqual([
          expect.objectContaining({ kind: "video_poster", size: "small", mimeType: "image/jpeg" }),
          expect.objectContaining({ kind: "video_poster", size: "large", mimeType: "image/jpeg" }),
        ]);
      } catch (err) {
        dumpPreviewSnapshot("video-poster-failure", {
          refs,
          ffmpegCalls: runFfmpegMock.mock.calls.map((c) => c as unknown[]),
          ffprobeCalls: runFfprobeMock.mock.calls.map((c) => c as unknown[]),
        });
        throw err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
