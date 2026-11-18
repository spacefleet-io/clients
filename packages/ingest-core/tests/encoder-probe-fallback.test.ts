/**
 * @bugfix @regression-proof
 *
 * Ultimate-stress finding F2 (issue #25): on a Linux test machine the bundled ffmpeg
 * lists `h264_vaapi` and `/dev/dri/renderD128` exists, but libva cannot load
 * its driver (`radeonsi_drv_video.so` dlopen failed → "Failed to initialise
 * VAAPI connection" → "Device creation failed: -5"). `detectEncoder()` only
 * checked `ffmpeg -encoders` + GPU vendor, so it returned "vaapi", and every
 * post-ingest add-quality (retranscode) job died with handler-error because
 * the streaming path had no CPU fallback.
 *
 * These tests drive the two layers of the fix with a SIMULATED broken device
 * (ffmpeg mock fails any h264_vaapi encode with the exact stderr seen there):
 *   A. `detectEncoder()` probes the hardware encoder with a real (tiny) test
 *      encode, caches the verdict, and returns "cpu" when the probe fails.
 *   B. the streaming (retranscode) encode retries on libx264 with a freshly
 *      re-opened source stream when the hardware encode fails mid-job.
 *
 * Both fail on the pre-fix code: A returns "vaapi"; B rejects after one
 * attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pinLinuxHardware } from "./helpers/pin-linux-hardware";

const SUITE = "encoder-probe-fallback";

const BROKEN_VAAPI_STDERR = [
  "[AVHWDeviceContext @ 0x5da548cce600] libva: dlopen of /usr/lib/x86_64-linux-gnu/dri/radeonsi_drv_video.so failed",
  "[AVHWDeviceContext @ 0x5da548cce600] Failed to initialise VAAPI connection: -1 (unknown libva error).",
  "Device creation failed: -5.",
  "Failed to set value '/dev/dri/renderD128' for option 'vaapi_device': Input/output error",
  "Error parsing global options: Input/output error",
].join("\n");

const runFfmpegMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>>();
const runFfprobeMock = vi.fn();
const createFfmpegTaskMock = vi.fn();

vi.mock("@space/ffmpeg", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: createFfmpegTaskMock,
}));

const originalVaapiDevice = process.env.SF_VAAPI_DEVICE;

const argValueAfter = (args: string[], flag: string) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

describe("@bugfix @regression-proof detectEncoder probes the hardware encoder (F2)", () => {
  let root = "";
  let fakeRenderNode = "";

  beforeEach(async () => {
    await pinLinuxHardware();
    root = mkdtempSync(join(tmpdir(), "sf-encoder-probe-"));
    // A bogus "render node": exists() passes, so hardware.deviceFor("vaapi")
    // hands it to ffmpeg exactly as it would /dev/dri/renderD128.
    fakeRenderNode = join(root, "renderD128");
    writeFileSync(fakeRenderNode, "");
    process.env.SF_VAAPI_DEVICE = fakeRenderNode;
    runFfmpegMock.mockReset();
    console.info(`[${SUITE}:setup] fake render node=${fakeRenderNode}`);
    const { configureMediaIngestRuntime } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({ getGpuVendor: async () => "amd" });
  });

  afterEach(() => {
    if (originalVaapiDevice === undefined) delete process.env.SF_VAAPI_DEVICE;
    else process.env.SF_VAAPI_DEVICE = originalVaapiDevice;
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("falls back to cpu when the VAAPI device is advertised but the probe encode fails", async () => {
    const probeCalls: string[][] = [];
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "-encoders") {
        return { stdout: " V....D h264_vaapi H.264/AVC (VAAPI)", stderr: "", code: 0 };
      }
      probeCalls.push(args);
      if (args.includes("h264_vaapi")) throw new Error(BROKEN_VAAPI_STDERR);
      return { stdout: "", stderr: "", code: 0 };
    });

    const { detectEncoder } = await import("../src/mediaProcessor");
    const selected = await detectEncoder();
    console.info(`[${SUITE}:broken-device] selected=${selected} probeCalls=${probeCalls.length}`);

    expect(selected).toBe("cpu");
    expect(probeCalls).toHaveLength(1);
    // The probe must exercise the same device the real encode would use.
    expect(argValueAfter(probeCalls[0], "-vaapi_device")).toBe(fakeRenderNode);
  });

  it("probes only once per process — the verdict (even a failing one) is cached", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "-encoders") return { stdout: "h264_vaapi", stderr: "", code: 0 };
      if (args.includes("h264_vaapi")) throw new Error(BROKEN_VAAPI_STDERR);
      return { stdout: "", stderr: "", code: 0 };
    });

    const { detectEncoder } = await import("../src/mediaProcessor");
    expect(await detectEncoder()).toBe("cpu");
    expect(await detectEncoder()).toBe("cpu");
    expect(await detectEncoder()).toBe("cpu");

    const probeInvocations = runFfmpegMock.mock.calls.filter(
      ([args]) => args.includes("h264_vaapi")
    );
    console.info(`[${SUITE}:cache] probe invocations=${probeInvocations.length}`);
    expect(probeInvocations).toHaveLength(1);
  });

  it("keeps the working-hardware path: a passing probe still selects vaapi", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "-encoders") return { stdout: "h264_vaapi", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });

    const { detectEncoder } = await import("../src/mediaProcessor");
    const selected = await detectEncoder();
    console.info(`[${SUITE}:working-device] selected=${selected}`);
    expect(selected).toBe("vaapi");
  });

  it("does not probe (and returns cpu) when no hardware encoder is advertised", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "-encoders") return { stdout: "libx264", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });

    const { detectEncoder } = await import("../src/mediaProcessor");
    expect(await detectEncoder()).toBe("cpu");
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
  });
});

describe("@bugfix @regression-proof streaming (retranscode) encode retries on CPU when hardware fails (F2)", () => {
  let root = "";

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

  async function* sourceBytes(label: string): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(label);
  }
  const streamLabels = new WeakMap<object, string>();
  const labelled = (label: string) => {
    const stream = sourceBytes(label);
    streamLabels.set(stream, label);
    return stream;
  };

  beforeEach(async () => {
    await pinLinuxHardware();
    root = mkdtempSync(join(tmpdir(), "sf-stream-fallback-"));
    // Probe passes (device looks fine at selection time) but the real
    // encode fails — e.g. an input the VAAPI chain cannot consume.
    runFfmpegMock.mockReset();
    runFfmpegMock.mockImplementation(async (args: string[]) =>
      args[0] === "-encoders"
        ? { stdout: "h264_vaapi", stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 0 }
    );
    createFfmpegTaskMock.mockReset();
    const { configureMediaIngestRuntime } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: vi.fn(async (_t: string, key: string) => `persisted-${key}`),
      getGpuVendor: async () => "amd",
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("re-opens the source stream and re-encodes with libx264 after a hardware failure", async () => {
    const attempts: Array<{ codec: string; stdinLabel: string | null }> = [];
    createFfmpegTaskMock.mockImplementation(
      (args: string[], options?: { stdin?: AsyncIterable<Uint8Array> | null }) => {
        const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? args[args.length - 1];
        const codec = argValueAfter(args, "-c:v") ?? "?";
        attempts.push({
          codec,
          stdinLabel: options?.stdin ? (streamLabels.get(options.stdin) ?? "?") : null,
        });
        console.info(`[${SUITE}:stream] attempt #${attempts.length} codec=${codec}`);
        if (codec === "h264_vaapi") {
          return { promise: Promise.reject(new Error(BROKEN_VAAPI_STDERR)), cancel: vi.fn() };
        }
        return {
          promise: writeDashOutput(mpdPath).then(() => ({ stdout: "", stderr: "", code: 0 })),
          cancel: vi.fn(),
        };
      }
    );

    const { produceMediaOutputs } = await import("../src/mediaProcessor");
    const logs: string[] = [];
    const out = await produceMediaOutputs({
      userId: "user-1",
      jobId: "job-stream-fallback",
      inputPath: "retranscode-stream:fmt-1",
      inputStream: labelled("first"),
      reopenInputStream: () => labelled("second"),
      sourceQualityOverride: "1080p",
      includeSource: false,
      includeFallback: false,
      targetVariants: ["720p"],
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
      onLog: (line) => logs.push(line),
    });

    console.info(`[${SUITE}:stream] attempts=${JSON.stringify(attempts)} outputs=${out.produced.videoFormats.length}`);
    expect(attempts).toEqual([
      { codec: "h264_vaapi", stdinLabel: "first" },
      { codec: "libx264", stdinLabel: "second" },
    ]);
    expect(logs.some((line) => line.includes("[fallback]") && line.includes("CPU"))).toBe(true);
    expect(out.produced.videoFormats).toHaveLength(1);
  });

  it("does not retry a streaming encode that fails on the CPU encoder", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) =>
      args[0] === "-encoders"
        ? { stdout: "libx264", stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 0 }
    );
    let attempts = 0;
    createFfmpegTaskMock.mockImplementation(() => {
      attempts += 1;
      return { promise: Promise.reject(new Error("boom")), cancel: vi.fn() };
    });
    const { produceMediaOutputs } = await import("../src/mediaProcessor");
    await expect(
      produceMediaOutputs({
        userId: "user-1",
        jobId: "job-stream-cpu-fail",
        inputPath: "retranscode-stream:fmt-1",
        inputStream: sourceBytes("only"),
        reopenInputStream: () => sourceBytes("again"),
        sourceQualityOverride: "1080p",
        includeSource: false,
        includeFallback: false,
        targetVariants: ["720p"],
        includeAudio: false,
        includeSubtitles: false,
        includeChapters: false,
      })
    ).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });
});
