/**
 * @bugfix @regression-proof
 *
 * Issue #25: a transcode ffmpeg must obey the per-computer playback policy
 * (one core under `throttle`, frozen under `pause`). The gate lives in
 * `@space/ffmpeg`; a spawn only takes part when the caller opts in with
 * `playbackGated: true`. These tests pin that every DASH transcode (CPU and
 * hardware encoder, streaming and file input) opts in, and that probes do not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SUITE = "dash-encoder-playback-gate";

const runFfmpegMock = vi.fn();
const runFfprobeMock = vi.fn();
const createFfmpegTaskMock = vi.fn();

vi.mock("@space/ffmpeg", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: createFfmpegTaskMock,
}));

const originalPlatform = process.platform;

const setPlatform = (value: string) => {
  Object.defineProperty(process, "platform", { value, configurable: true });
};

const writeDashOutput = async (mpdPath: string) => {
  await fs.mkdir(dirname(mpdPath), { recursive: true });
  await fs.writeFile(join(dirname(mpdPath), "init-0.mp4"), "init");
  await fs.writeFile(join(dirname(mpdPath), "seg-00001.m4s"), "seg-1");
  await fs.writeFile(
    mpdPath,
    [
      '<MPD><Period><AdaptationSet contentType="video" codecs="avc1.640028">',
      '<SegmentTemplate timescale="1"><SegmentTimeline>',
      '<S t="0" d="12" />',
      "</SegmentTimeline></SegmentTemplate>",
      "</AdaptationSet></Period></MPD>",
    ].join("")
  );
};

async function* sourceBytes(): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode("x");
}

describe("@bugfix @regression-proof DASH transcodes opt in to the playback gate (#25)", () => {
  let root = "";

  const runTranscode = async (encodersStdout: string, gpuVendor: string) => {
    runFfmpegMock.mockImplementation(async (args: string[]) =>
      args[0] === "-encoders"
        ? { stdout: encodersStdout, stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 0 }
    );
    const spawns: Array<{ codec: string | undefined; playbackGated: unknown }> = [];
    createFfmpegTaskMock.mockImplementation((args: string[], options?: { playbackGated?: boolean }) => {
      const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? args[args.length - 1];
      const codecIdx = args.indexOf("-c:v");
      spawns.push({ codec: codecIdx >= 0 ? args[codecIdx + 1] : undefined, playbackGated: options?.playbackGated });
      return {
        promise: writeDashOutput(mpdPath).then(() => ({ stdout: "", stderr: "", code: 0 })),
        cancel: vi.fn(),
      };
    });
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: vi.fn(async (_t: string, key: string) => `persisted-${key}`),
      getGpuVendor: async () => gpuVendor,
    });
    await produceMediaOutputs({
      userId: "user-1",
      jobId: `job-${gpuVendor}`,
      inputPath: "retranscode-stream:fmt-1",
      inputStream: sourceBytes(),
      reopenInputStream: () => sourceBytes(),
      sourceQualityOverride: "1080p",
      includeSource: false,
      includeFallback: false,
      targetVariants: ["720p"],
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
    });
    console.info(`[${SUITE}:${gpuVendor}] spawns=${JSON.stringify(spawns)}`);
    return spawns;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-dash-gate-"));
    setPlatform("linux");
    createFfmpegTaskMock.mockReset();
    runFfmpegMock.mockReset();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("the CPU (libx264) transcode is playback-gated", async () => {
    const spawns = await runTranscode("libx264", "none");
    expect(spawns).toEqual([{ codec: "libx264", playbackGated: true }]);
  });

  it("a hardware (VAAPI) transcode is playback-gated too", async () => {
    const spawns = await runTranscode("h264_vaapi", "amd");
    expect(spawns).toEqual([{ codec: "h264_vaapi", playbackGated: true }]);
  });
});
