/**
 * @bugfix vaapi-10bit-hevc-360p-transcode-fails
 * @regression-proof
 *
 * Pre-fix: 360p transcoding failed outright on 10-bit HEVC source files
 * (HEVC Main 10, `yuv420p10le`). Two faults in the VAAPI 360p recipe:
 *
 *   1. It built an all-GPU pipeline (`-hwaccel vaapi
 *      -hwaccel_output_format vaapi` + `scale_vaapi`) for codecs assumed
 *      hardware-decodable. ffmpeg silently fell back to a SOFTWARE HEVC
 *      decoder, leaving the GPU filter/encoder chain with frames it could
 *      not consume → `Function not implemented`.
 *   2. It never converted the 10-bit source to the 8-bit NV12 that
 *      `h264_vaapi` requires → `No usable encoding profile found` →
 *      `Conversion failed!`.
 *
 *   Because the 360p fallback calls the encoder exactly once, that failure
 *   was terminal for the whole ingest.
 *
 * Post-fix, two independent guards:
 *
 *   A. `buildVideoEncoderArgs("vaapi", …)` always emits
 *      `format=nv12,hwupload,scale_vaapi=…` and NO `-hwaccel_output_format
 *      vaapi`. CPU decode + CPU 8-bit NV12 conversion feed a GPU that only
 *      scales + H.264-encodes — works for any input pixel format including
 *      10-bit `yuv420p10le`.
 *   B. The 360p fallback is wrapped so that if the hardware encoder still
 *      throws (and the abort signal is NOT set) it retries once on the
 *      universal CPU encoder (`libx264`). A user cancel is never retried.
 *
 * These tests pin both guards so the fix cannot silently regress.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildVideoEncoderArgs } from "../src/mediaProcessor";
import { pinLinuxHardware } from "./helpers/pin-linux-hardware";

const SUITE = "vaapi-10bit-hevc-fallback";

const dumpVaapiSnapshot = (
  label: string,
  ctx: {
    capability?: string;
    decision?: string;
    encoderPicked?: string;
    preArgs?: ReadonlyArray<string>;
    encoderArgs?: ReadonlyArray<string>;
    fallbackTree?: ReadonlyArray<string>;
    reencodeCodecs?: ReadonlyArray<string>;
    reencodeAttempts?: number;
    logs?: ReadonlyArray<string>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.capability) console.error(`vaapi capability probe result: ${ctx.capability}`);
    if (ctx.decision) console.error(`fallback decision: ${ctx.decision}`);
    if (ctx.encoderPicked) console.error(`encoder picked: ${ctx.encoderPicked}`);
    if (ctx.preArgs) console.error(`preArgs: ${JSON.stringify(ctx.preArgs)}`);
    if (ctx.encoderArgs) console.error(`encoderArgs: ${JSON.stringify(ctx.encoderArgs)}`);
    if (ctx.fallbackTree) {
      console.error(`fallback decision tree:\n${JSON.stringify(ctx.fallbackTree, null, 2)}`);
    }
    if (ctx.reencodeCodecs) {
      console.error(`reencode codecs (in order): ${JSON.stringify(ctx.reencodeCodecs)}`);
    }
    if (typeof ctx.reencodeAttempts === "number") {
      console.error(`reencode attempts: ${ctx.reencodeAttempts}`);
    }
    if (ctx.logs) {
      console.error(`onLog lines (${ctx.logs.length}):\n${JSON.stringify(ctx.logs, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// vi.mock is hoisted above the static import of mediaProcessor (which pulls in
// @space/ffmpeg). vi.hoisted lifts the mock fns alongside it so the factory can
// see them — a plain `const` would not yet be initialized when the factory runs.
const { runFfprobeMock, runFfmpegMock, createFfmpegTaskMock } = vi.hoisted(() => ({
  runFfprobeMock: vi.fn(),
  runFfmpegMock: vi.fn(),
  createFfmpegTaskMock: vi.fn(),
}));

vi.mock("@space/ffmpeg", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: createFfmpegTaskMock,
}));

// ---------------------------------------------------------------------------
// Guard A — the VAAPI argument recipe (pure-function unit test).
// ---------------------------------------------------------------------------
describe("@bugfix @regression-proof buildVideoEncoderArgs — VAAPI 10-bit HEVC recipe", () => {
  it("always converts to 8-bit NV12 before hwupload", () => {
    console.info(`[${SUITE}:guard-A:nv12] probing vaapi recipe for nv12+hwupload`);
    const { encoderArgs } = buildVideoEncoderArgs("vaapi", "/dev/dri/renderD128");
    const vfIndex = encoderArgs.indexOf("-vf");
    if (vfIndex < 0) {
      dumpVaapiSnapshot("guard-A-nv12-no-vf", { encoderArgs });
    }
    expect(vfIndex).toBeGreaterThanOrEqual(0);
    const vf = encoderArgs[vfIndex + 1];
    console.info(`[${SUITE}:guard-A:nv12] -vf value=${JSON.stringify(vf)}`);
    if (!vf.includes("format=nv12,hwupload") || !vf.includes("scale_vaapi=w=-2:h=360")) {
      dumpVaapiSnapshot("guard-A-nv12-mismatch", {
        capability: "vaapi available + 360p default",
        encoderArgs,
        decision: `-vf=${vf}`,
      });
    }
    // `format=nv12` down-converts 10-bit yuv420p10le → 8-bit NV12, which
    // h264_vaapi requires; `hwupload` then moves NV12 frames to the GPU.
    expect(vf).toContain("format=nv12,hwupload");
    expect(vf).toContain("scale_vaapi=w=-2:h=360");
  });

  it("does NOT build an all-GPU decode pipeline (-hwaccel_output_format vaapi)", () => {
    console.info(`[${SUITE}:guard-A:no-all-gpu] verifying no -hwaccel_output_format`);
    const { preArgs, encoderArgs } = buildVideoEncoderArgs("vaapi", "/dev/dri/renderD128");
    const all = [...preArgs, ...encoderArgs];
    if (all.includes("-hwaccel_output_format") || all.join(" ").includes("-hwaccel vaapi") || !encoderArgs.includes("h264_vaapi")) {
      dumpVaapiSnapshot("guard-A-all-gpu-resurrected", {
        capability: "vaapi available + 360p default",
        preArgs,
        encoderArgs,
        decision: "encoderArgs should contain h264_vaapi WITHOUT -hwaccel*",
      });
    }
    // The fragile GPU-decode path is the regression — it must be gone.
    expect(all).not.toContain("-hwaccel_output_format");
    expect(all.join(" ")).not.toContain("-hwaccel vaapi");
    // The H.264 VAAPI encoder is still selected.
    expect(encoderArgs).toContain("h264_vaapi");
  });

  it("preArgs only set the VAAPI device (CPU decode, no -hwaccel)", () => {
    console.info(`[${SUITE}:guard-A:preargs-vaapi-device] verifying device-only preArgs`);
    const { preArgs } = buildVideoEncoderArgs("vaapi", "/dev/dri/renderD128");
    if (JSON.stringify(preArgs) !== JSON.stringify(["-vaapi_device", "/dev/dri/renderD128"])) {
      dumpVaapiSnapshot("guard-A-preargs-mismatch", { preArgs });
    }
    expect(preArgs).toEqual(["-vaapi_device", "/dev/dri/renderD128"]);
  });

  it("preArgs are empty when no VAAPI device is available", () => {
    console.info(`[${SUITE}:guard-A:preargs-empty] verifying empty preArgs when no device`);
    const { preArgs } = buildVideoEncoderArgs("vaapi", null);
    if (preArgs.length !== 0) {
      dumpVaapiSnapshot("guard-A-preargs-not-empty", { preArgs });
    }
    expect(preArgs).toEqual([]);
  });

  it("keeps the speed-tuned VAAPI rate-control flags unchanged", () => {
    console.info(`[${SUITE}:guard-A:rate-control] verifying CQP/-qp/-quality tuning`);
    const { encoderArgs } = buildVideoEncoderArgs("vaapi", "/dev/dri/renderD128");
    // Spot-check the CQP recipe so the hardening edit didn't drop tuning.
    expect(encoderArgs).toEqual(
      expect.arrayContaining(["-rc_mode", "CQP", "-qp", "30", "-quality", "7"])
    );
  });

  it("cpu encoder uses libx264 -preset veryfast (the universal fallback)", () => {
    console.info(`[${SUITE}:guard-A:cpu-fallback] verifying universal CPU recipe`);
    const { preArgs, encoderArgs } = buildVideoEncoderArgs("cpu", null);
    expect(preArgs).toEqual([]);
    expect(encoderArgs).toEqual(
      expect.arrayContaining(["-c:v", "libx264", "-preset", "veryfast"])
    );
  });
});

// ---------------------------------------------------------------------------
// Guard B — the 360p hardware→CPU fallback, exercised through processMediaJob.
//
// processMediaJob runs the 360p fallback via the with-fallback wrapper. We
// make the FIRST hardware-encoder (h264_vaapi) ffmpeg invocation fail and
// assert a second ffmpeg invocation runs with libx264 (the CPU retry), unless
// the job was cancelled.
// ---------------------------------------------------------------------------
describe("@bugfix @regression-proof 360p fallback retries on CPU when the hardware encoder fails", () => {
  let root = "";

  // Produce a valid DASH manifest + segments so the post-encode parsing in
  // processMediaJob succeeds for any "successful" ffmpeg task.
  const writeDashOutput = async (mpdPath: string) => {
    await fs.mkdir(dirname(mpdPath), { recursive: true });
    await fs.writeFile(join(dirname(mpdPath), "init-0.mp4"), "init");
    await fs.writeFile(join(dirname(mpdPath), "seg-00001.m4s"), "seg-1");
    await fs.writeFile(join(dirname(mpdPath), "seg-00002.m4s"), "seg-2");
    await fs.writeFile(
      mpdPath,
      [
        '<MPD><Period><AdaptationSet contentType="video" codecs="avc1.640028">',
        '<SegmentTemplate timescale="1"><SegmentTimeline>',
        '<S t="0" d="12" /><S d="12" />',
        "</SegmentTimeline></SegmentTemplate>",
        "</AdaptationSet></Period></MPD>",
      ].join("")
    );
  };

  // Distinguish the 360p re-encode task: it maps the video stream AND is a
  // real re-encode (NOT `-c:v copy`, which is the source-copy task).
  const isReencodeTask = (args: string[]) =>
    args.includes("0:v:0") && !(args.includes("-c:v") && args[args.indexOf("-c:v") + 1] === "copy");

  beforeEach(async () => {
    await pinLinuxHardware();
    root = mkdtempSync(join(tmpdir(), "sf-vaapi-fallback-"));
    console.info(`[${SUITE}:guard-B:setup] temp root=${root} — advertising VAAPI capability via ffmpeg -encoders mock`);
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
    createFfmpegTaskMock.mockReset();

    // detectEncoder() probes `ffmpeg -encoders`; advertise VAAPI so an AMD
    // box selects the `vaapi` encoder for the 360p fallback.
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "-encoders") {
        return { stdout: "V..... h264_vaapi", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "" };
    });

    runFfprobeMock.mockResolvedValue({
      // HEVC Main 10 — the 10-bit source class that triggered the bug.
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          profile: "Main 10",
          pix_fmt: "yuv420p10le",
          width: 1920,
          height: 1080,
        },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng", title: "Main" } },
      ],
      data: { format: { duration: "60" }, chapters: [] },
    });
  });

  afterEach(() => {
    console.info(`[${SUITE}:guard-B:teardown] removing temp root=${root}`);
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  const configure = async () => {
    const { configureMediaIngestRuntime } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, objectKey: string) => `persisted-${objectKey}`),
      // AMD vendor → detectEncoder() picks `vaapi`.
      getGpuVendor: async () => "amd",
    });
  };

  it("retries the 360p encode on CPU (libx264) when the VAAPI encode throws", async () => {
    console.info(`[${SUITE}:guard-B:retry-on-cpu] expecting VAAPI fail → libx264 retry`);
    await configure();
    const { processMediaJob } = await import("../src/mediaProcessor");

    const reencodeCodecs: string[] = [];
    let reencodeAttempts = 0;
    createFfmpegTaskMock.mockImplementation((args: string[]) => {
      const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? args[args.length - 1];
      if (isReencodeTask(args)) {
        reencodeAttempts += 1;
        const codec = args[args.indexOf("-c:v") + 1];
        reencodeCodecs.push(codec);
        console.info(`[${SUITE}:guard-B:retry-on-cpu] reencode #${reencodeAttempts} codec=${codec}`);
        // Fail the first (hardware/VAAPI) attempt the way the broken
        // pipeline did; let the CPU retry succeed.
        if (reencodeAttempts === 1) {
          return {
            promise: Promise.reject(new Error("Conversion failed! (h264_vaapi)")),
            cancel: vi.fn(),
          };
        }
      }
      return {
        promise: writeDashOutput(mpdPath).then(() => ({ stdout: "", stderr: "" })),
        cancel: vi.fn(),
      };
    });

    const logs: string[] = [];
    const result = await processMediaJob({
      token: "token",
      userId: "user-1",
      jobId: "job-vaapi-fallback",
      placementId: "placement-vaapi-fallback",
      inputPath: "/tmp/input-10bit-hevc.mkv",
      includeSource: false,
      includeFallback: true,
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
      onLog: (line) => logs.push(line),
    });
    console.info(
      `[${SUITE}:guard-B:retry-on-cpu] reencode_attempts=${reencodeAttempts} codecs=${JSON.stringify(reencodeCodecs)} videoFormats=${result.produced.videoFormats.length}`,
    );

    // Two re-encode attempts: VAAPI (failed) then CPU (succeeded).
    if (reencodeAttempts !== 2 || reencodeCodecs[0] !== "h264_vaapi" || reencodeCodecs[1] !== "libx264") {
      dumpVaapiSnapshot("retry-on-cpu-unexpected-attempts", {
        capability: "VAAPI advertised, HEVC Main 10 source",
        decision: "should retry on libx264 after h264_vaapi fails",
        encoderPicked: reencodeCodecs[1] ?? "(none)",
        reencodeCodecs,
        reencodeAttempts,
        logs,
      });
    }
    expect(reencodeAttempts).toBe(2);
    expect(reencodeCodecs[0]).toBe("h264_vaapi");
    expect(reencodeCodecs[1]).toBe("libx264");
    // The downgrade is surfaced through the onLog callback.
    if (!logs.some((line) => line.includes("retrying 360p on CPU"))) {
      dumpVaapiSnapshot("retry-on-cpu-no-log-line", { logs, reencodeCodecs, reencodeAttempts });
    }
    expect(logs.some((line) => line.includes("retrying 360p on CPU"))).toBe(true);
    // The 360p fallback output is produced despite the hardware failure.
    expect(result.produced.videoFormats).toHaveLength(1);
  });

  it("does NOT retry when the abort signal is set (user cancel, not an encoder failure)", async () => {
    console.info(`[${SUITE}:guard-B:cancel-no-retry] expecting NO retry on abort`);
    await configure();
    const { processMediaJob } = await import("../src/mediaProcessor");

    const controller = new AbortController();
    let reencodeAttempts = 0;
    createFfmpegTaskMock.mockImplementation((args: string[]) => {
      const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? args[args.length - 1];
      if (isReencodeTask(args)) {
        reencodeAttempts += 1;
        console.info(`[${SUITE}:guard-B:cancel-no-retry] reencode #${reencodeAttempts} — scheduling abort`);
        // Simulate ffmpeg being cancelled mid-encode: the task promise stays
        // pending until cancel() rejects it, exactly like the real ffmpeg
        // task. We abort the controller on a microtask so runFfmpegWithSignal
        // has already registered its abort listener — the abort then drives
        // cancel(). The wrapper sees signal.aborted and must NOT retry.
        const deferred = Promise.withResolvers<{ stdout: string; stderr: string }>();
        const cancel = vi.fn(() => deferred.reject(new Error("CANCELLED")));
        queueMicrotask(() => controller.abort());
        return { promise: deferred.promise, cancel };
      }
      return {
        promise: writeDashOutput(mpdPath).then(() => ({ stdout: "", stderr: "" })),
        cancel: vi.fn(),
      };
    });

    const logs: string[] = [];
    await expect(
      processMediaJob({
        token: "token",
        userId: "user-1",
        jobId: "job-vaapi-cancelled",
        placementId: "placement-vaapi-cancelled",
        inputPath: "/tmp/input-10bit-hevc.mkv",
        includeSource: false,
        includeFallback: true,
        includeAudio: false,
        includeSubtitles: false,
        includeChapters: false,
        signal: controller.signal,
        onLog: (line) => logs.push(line),
      })
    ).rejects.toThrow();
    console.info(`[${SUITE}:guard-B:cancel-no-retry] reencode_attempts=${reencodeAttempts}`);

    // Exactly one re-encode attempt — the cancel was respected, no CPU retry.
    if (reencodeAttempts !== 1 || logs.some((line) => line.includes("retrying 360p on CPU"))) {
      dumpVaapiSnapshot("cancel-no-retry-unexpected", {
        capability: "VAAPI advertised, HEVC Main 10 source, signal aborted mid-encode",
        decision: "should NOT retry after abort",
        reencodeAttempts,
        logs,
      });
    }
    expect(reencodeAttempts).toBe(1);
    expect(logs.some((line) => line.includes("retrying 360p on CPU"))).toBe(false);
  });
});
