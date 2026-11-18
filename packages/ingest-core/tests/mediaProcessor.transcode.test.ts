/**
 * @bugfix @regression-proof
 *
 * Phase 3 — encoder extension beyond 360p.
 *
 * Two safety nets:
 *
 *   A. Byte-equivalence pin for the legacy 360p recipe. Every encoder
 *      family (cpu/nvenc/qsv/vaapi/amf/videotoolbox) must produce the
 *      exact same `{ preArgs, encoderArgs }` shape when called with no
 *      quality arg (default "360p") as it did pre-Phase-3. If any future
 *      edit drifts those args, the existing 360p ingest e2e produces
 *      different DASH segments and breaks playback compat.
 *
 *   B. Per-variant ffmpeg recipe — 240p / 480p / 720p / 1080p / 2160p
 *      must wire the right height + bitrate ladder + codec lib. 2160p
 *      selects HEVC (`libx265` on CPU); the lower variants stay on h264.
 *
 * Plus an integration-style check through `produceMediaOutputs` that
 * `targetVariants: [variant]` produces a per-variant DASH output with
 * the canonical id `video-<quality>-<codec>` and the right metadata.
 */

import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "mediaProcessor-transcode";

const dumpTranscodeSnapshot = (
  label: string,
  ctx: {
    transcodePlan?: unknown;
    ffmpegArgs?: ReadonlyArray<ReadonlyArray<string>>;
    progressEvents?: ReadonlyArray<unknown>;
    stateOutputs?: ReadonlyArray<unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.transcodePlan !== undefined) {
      console.error(`transcode plan:\n${JSON.stringify(ctx.transcodePlan, null, 2)}`);
    }
    if (ctx.ffmpegArgs) {
      console.error(`ffmpeg args (${ctx.ffmpegArgs.length} invocations):`);
      ctx.ffmpegArgs.forEach((args, idx) => {
        console.error(`  #${idx}: ${JSON.stringify(args)}`);
      });
    }
    if (ctx.progressEvents) {
      console.error(
        `mock progress events (${ctx.progressEvents.length}):\n${JSON.stringify(ctx.progressEvents, null, 2)}`,
      );
    }
    if (ctx.stateOutputs) {
      console.error(
        `state.outputs (${ctx.stateOutputs.length}):\n${JSON.stringify(ctx.stateOutputs, null, 2)}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

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

import { buildVideoEncoderArgs } from "../src/mediaProcessor";

// ---------------------------------------------------------------------------
// Guard A — byte-equivalence pin for the legacy 360p recipe. Defaults MUST
// stay byte-identical so the existing ingest pipeline keeps producing the
// same ffmpeg invocations.
// ---------------------------------------------------------------------------
describe("@bugfix @regression-proof buildVideoEncoderArgs — 360p byte-equivalence (Phase 3 non-regression)", () => {
  it("default (no quality arg) yields the legacy CPU 360p recipe", () => {
    console.info(`[${SUITE}:byte-equiv:cpu-360p] probing default CPU recipe`);
    const { preArgs, encoderArgs } = buildVideoEncoderArgs("cpu", null);
    if (preArgs.length !== 0 || encoderArgs[0] !== "-c:v" || encoderArgs[1] !== "libx264") {
      dumpTranscodeSnapshot("byte-equiv-cpu-360p-mismatch", {
        transcodePlan: { family: "cpu", quality: "default(360p)", preArgs, encoderArgs },
      });
    }
    expect(preArgs).toEqual([]);
    expect(encoderArgs).toEqual([
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "28",
      "-maxrate", "700k",
      "-bufsize", "1400k",
      "-vf", "scale=-2:360",
      "-g", "96",
      "-keyint_min", "96",
      "-sc_threshold", "0",
      "-profile:v", "main",
      "-pix_fmt", "yuv420p",
    ]);
  });

  it("default nvenc recipe pins the legacy 360p h264_nvenc args", () => {
    console.info(`[${SUITE}:byte-equiv:nvenc-360p] probing default NVENC recipe`);
    const { encoderArgs } = buildVideoEncoderArgs("nvenc", null);
    expect(encoderArgs).toEqual([
      "-c:v", "h264_nvenc",
      "-vf", "hwupload,scale_cuda=-2:360:format=nv12",
      "-preset", "p1",
      "-rc", "vbr",
      "-cq", "32",
      "-b:v", "400k",
      "-maxrate", "800k",
      "-bufsize", "1600k",
      "-g", "96",
      "-keyint_min", "96",
      "-sc_threshold", "0",
      "-profile:v", "main",
    ]);
  });

  it("default qsv recipe pins the legacy 360p h264_qsv args", () => {
    console.info(`[${SUITE}:byte-equiv:qsv-360p] probing default QSV recipe`);
    const { encoderArgs } = buildVideoEncoderArgs("qsv", null);
    expect(encoderArgs).toEqual([
      "-c:v", "h264_qsv",
      "-vf", "scale=-2:360",
      "-preset", "veryfast",
      "-global_quality", "32",
      "-look_ahead", "0",
      "-async_depth", "2",
      "-b:v", "400k",
      "-maxrate", "800k",
      "-bufsize", "1600k",
      "-g", "96",
      "-keyint_min", "96",
      "-sc_threshold", "0",
      "-profile:v", "main",
    ]);
  });

  it("default vaapi recipe pins the legacy 360p h264_vaapi args", () => {
    console.info(`[${SUITE}:byte-equiv:vaapi-360p] probing default VAAPI recipe`);
    const { encoderArgs } = buildVideoEncoderArgs("vaapi", "/dev/dri/renderD128");
    expect(encoderArgs).toEqual([
      "-vf", "format=nv12,hwupload,scale_vaapi=w=-2:h=360",
      "-c:v", "h264_vaapi",
      "-rc_mode", "CQP",
      "-qp", "30",
      "-quality", "7",
      "-bf", "0",
      "-refs", "1",
      "-async_depth", "4",
      "-maxrate", "800k",
      "-bufsize", "1600k",
      "-g", "96",
      "-keyint_min", "96",
      "-sc_threshold", "0",
      "-profile:v", "main",
    ]);
  });

  it("default amf recipe pins the legacy 360p h264_amf args", () => {
    console.info(`[${SUITE}:byte-equiv:amf-360p] probing default AMF recipe`);
    const { encoderArgs } = buildVideoEncoderArgs("amf", null);
    expect(encoderArgs).toEqual([
      "-c:v", "h264_amf",
      "-vf", "scale=-2:360",
      "-rc", "vbr_peak",
      "-qp_i", "28",
      "-qp_p", "28",
      "-qp_b", "28",
      "-b:v", "400k",
      "-maxrate", "800k",
      "-bufsize", "1600k",
      "-quality", "speed",
      "-g", "96",
      "-keyint_min", "96",
      "-sc_threshold", "0",
      "-profile:v", "main",
      "-pix_fmt", "yuv420p",
    ]);
  });

  it("default videotoolbox recipe pins the legacy 360p h264_videotoolbox args", () => {
    console.info(`[${SUITE}:byte-equiv:videotoolbox-360p] probing default videotoolbox recipe`);
    const { encoderArgs } = buildVideoEncoderArgs("videotoolbox", null);
    expect(encoderArgs).toEqual([
      "-c:v", "h264_videotoolbox",
      "-vf", "scale=-2:360",
      "-realtime", "1",
      "-b:v", "400k",
      "-maxrate", "800k",
      "-bufsize", "1600k",
      "-allow_sw", "0",
      "-g", "96",
      "-keyint_min", "96",
      "-sc_threshold", "0",
      "-profile:v", "main",
      "-pix_fmt", "yuv420p",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Guard B — per-variant recipes (240/480/720/1080/2160). For each variant we
// check the scale height, codec lib, and that the bitrate ladder follows the
// 2x maxrate / 4x bufsize convention starting from estimateBitrateKbps.
// ---------------------------------------------------------------------------
describe("buildVideoEncoderArgs — per-variant scale + bitrate ladder", () => {
  // helper: pull the value following a flag in the args list
  const after = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  it("CPU 240p uses scale=-2:240 + libx264 with the 500k ladder", () => {
    console.info(`[${SUITE}:per-variant:cpu-240p] probing 240p CPU ladder`);
    const { encoderArgs } = buildVideoEncoderArgs("cpu", null, "240p");
    const vf = after(encoderArgs, "-vf");
    const codec = after(encoderArgs, "-c:v");
    if (vf !== "scale=-2:240" || codec !== "libx264") {
      dumpTranscodeSnapshot("per-variant-cpu-240p-mismatch", {
        transcodePlan: { family: "cpu", quality: "240p", encoderArgs },
      });
    }
    expect(vf).toBe("scale=-2:240");
    expect(codec).toBe("libx264");
    expect(after(encoderArgs, "-b:v")).toBe("500k");
    expect(after(encoderArgs, "-maxrate")).toBe("1000k");
    expect(after(encoderArgs, "-bufsize")).toBe("2000k");
  });

  it("CPU 480p uses scale=-2:480 + libx264 with the 1200k ladder", () => {
    console.info(`[${SUITE}:per-variant:cpu-480p] probing 480p CPU ladder`);
    const { encoderArgs } = buildVideoEncoderArgs("cpu", null, "480p");
    expect(after(encoderArgs, "-vf")).toBe("scale=-2:480");
    expect(after(encoderArgs, "-c:v")).toBe("libx264");
    expect(after(encoderArgs, "-b:v")).toBe("1200k");
    expect(after(encoderArgs, "-maxrate")).toBe("2400k");
    expect(after(encoderArgs, "-bufsize")).toBe("4800k");
  });

  it("CPU 720p uses scale=-2:720 + libx264 with the 2500k ladder", () => {
    console.info(`[${SUITE}:per-variant:cpu-720p] probing 720p CPU ladder`);
    const { encoderArgs } = buildVideoEncoderArgs("cpu", null, "720p");
    expect(after(encoderArgs, "-vf")).toBe("scale=-2:720");
    expect(after(encoderArgs, "-c:v")).toBe("libx264");
    expect(after(encoderArgs, "-b:v")).toBe("2500k");
    expect(after(encoderArgs, "-maxrate")).toBe("5000k");
    expect(after(encoderArgs, "-bufsize")).toBe("10000k");
  });

  it("CPU 1080p uses scale=-2:1080 + libx264 with the 5000k ladder", () => {
    console.info(`[${SUITE}:per-variant:cpu-1080p] probing 1080p CPU ladder`);
    const { encoderArgs } = buildVideoEncoderArgs("cpu", null, "1080p");
    expect(after(encoderArgs, "-vf")).toBe("scale=-2:1080");
    expect(after(encoderArgs, "-c:v")).toBe("libx264");
    expect(after(encoderArgs, "-b:v")).toBe("5000k");
    expect(after(encoderArgs, "-maxrate")).toBe("10000k");
    expect(after(encoderArgs, "-bufsize")).toBe("20000k");
  });

  it("CPU 2160p selects HEVC (libx265) with the 8400k ladder (estimateBitrateKbps × 0.7)", () => {
    console.info(`[${SUITE}:per-variant:cpu-2160p] probing 2160p HEVC CPU ladder`);
    // estimateBitrateKbps("2160p", "hevc") = round(12000 × 0.7) = 8400
    const { encoderArgs } = buildVideoEncoderArgs("cpu", null, "2160p");
    expect(after(encoderArgs, "-vf")).toBe("scale=-2:2160");
    expect(after(encoderArgs, "-c:v")).toBe("libx265");
    expect(after(encoderArgs, "-b:v")).toBe("8400k");
    expect(after(encoderArgs, "-maxrate")).toBe("16800k");
    expect(after(encoderArgs, "-bufsize")).toBe("33600k");
  });

  it("nvenc 720p uses h264_nvenc + hwupload,scale_cuda=-2:720:format=nv12 with the 2500k ladder", () => {
    console.info(`[${SUITE}:per-variant:nvenc-720p] probing 720p NVENC ladder`);
    const { encoderArgs } = buildVideoEncoderArgs("nvenc", null, "720p");
    expect(after(encoderArgs, "-c:v")).toBe("h264_nvenc");
    expect(after(encoderArgs, "-vf")).toBe("hwupload,scale_cuda=-2:720:format=nv12");
    expect(after(encoderArgs, "-b:v")).toBe("2500k");
    expect(after(encoderArgs, "-maxrate")).toBe("5000k");
    expect(after(encoderArgs, "-bufsize")).toBe("10000k");
  });

  it("nvenc 2160p switches to hevc_nvenc (HEVC for 4K)", () => {
    console.info(`[${SUITE}:per-variant:nvenc-2160p] probing 2160p NVENC HEVC switch`);
    const { encoderArgs } = buildVideoEncoderArgs("nvenc", null, "2160p");
    expect(after(encoderArgs, "-c:v")).toBe("hevc_nvenc");
    expect(after(encoderArgs, "-vf")).toBe("hwupload,scale_cuda=-2:2160:format=nv12");
  });

  it("vaapi 1080p uses h264_vaapi + format=nv12,hwupload,scale_vaapi=w=-2:h=1080", () => {
    console.info(`[${SUITE}:per-variant:vaapi-1080p] probing 1080p VAAPI ladder`);
    const { encoderArgs } = buildVideoEncoderArgs("vaapi", "/dev/dri/renderD128", "1080p");
    expect(after(encoderArgs, "-vf")).toBe("format=nv12,hwupload,scale_vaapi=w=-2:h=1080");
    expect(after(encoderArgs, "-c:v")).toBe("h264_vaapi");
    // VAAPI uses CQP (no -b:v); maxrate/bufsize must reflect the 5000k ladder.
    expect(after(encoderArgs, "-maxrate")).toBe("10000k");
    expect(after(encoderArgs, "-bufsize")).toBe("20000k");
  });

  it("vaapi 2160p switches to hevc_vaapi", () => {
    console.info(`[${SUITE}:per-variant:vaapi-2160p] probing 2160p VAAPI HEVC switch`);
    const { encoderArgs } = buildVideoEncoderArgs("vaapi", "/dev/dri/renderD128", "2160p");
    expect(after(encoderArgs, "-c:v")).toBe("hevc_vaapi");
    expect(after(encoderArgs, "-vf")).toBe("format=nv12,hwupload,scale_vaapi=w=-2:h=2160");
  });
});

// ---------------------------------------------------------------------------
// Guard C — produceMediaOutputs end-to-end. `targetVariants: ["720p"]`
// produces a `video-720p-h264` output with quality + codec set on the row;
// `targetVariants: ["1080p", "240p"]` produces both. `includeFallback: true`
// without targetVariants still produces the legacy `video-360p-h264` output.
// ---------------------------------------------------------------------------
describe("produceMediaOutputs — targetVariants drives per-variant DASH outputs", () => {
  let root = "";

  const setupDashOutput = async (mpdPath: string) => {
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-transcode-variants-"));
    console.info(`[${SUITE}:guard-C:setup] temp root=${root}`);
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
    createFfmpegTaskMock.mockReset();
    runFfmpegMock.mockResolvedValue({ stdout: "", stderr: "" });
    createFfmpegTaskMock.mockImplementation((args: string[]) => {
      const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? args[args.length - 1];
      return {
        promise: setupDashOutput(mpdPath).then(() => ({ stdout: "", stderr: "" })),
        cancel: vi.fn(),
      };
    });
    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng" } },
      ],
      data: { format: { duration: "120" }, chapters: [] },
    });
  });

  afterEach(() => {
    console.info(`[${SUITE}:guard-C:teardown] removing temp root=${root}`);
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("targetVariants: ['720p'] produces a video-720p-h264 output", async () => {
    console.info(`[${SUITE}:guard-C:targetVariants-720p] expecting single video-720p-h264 output`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });

    const result = await produceMediaOutputs({
      userId: "u1",
      jobId: "j-720p",
      inputPath: "/tmp/movie.mkv",
      includeSource: false,
      includeFallback: false,
      targetVariants: ["720p"],
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
    });

    const state = result.stateStore.getState();
    console.info(`[${SUITE}:guard-C:targetVariants-720p:assert] state.outputs=${state.outputs.length}`);
    const variantOutput = state.outputs.find((o) => o.id === "video-720p-h264");
    if (!variantOutput) {
      dumpTranscodeSnapshot("targetVariants-720p-missing", {
        transcodePlan: { targetVariants: ["720p"] },
        stateOutputs: state.outputs,
      });
    }
    expect(variantOutput).toBeDefined();
    expect(variantOutput?.quality).toBe("720p");
    expect(variantOutput?.codec).toBe("h264");
    expect(state.outputs.find((o) => o.id === "video-source")).toBeUndefined();
    expect(state.outputs.find((o) => o.id === "video-360p-h264")).toBeUndefined();
  });

  it("targetVariants with two variants produces a DASH output per variant", async () => {
    console.info(`[${SUITE}:guard-C:targetVariants-multi] expecting 1080p + 240p outputs`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });

    const result = await produceMediaOutputs({
      userId: "u1",
      jobId: "j-multi-variant",
      inputPath: "/tmp/movie.mkv",
      includeSource: false,
      includeFallback: false,
      targetVariants: ["1080p", "240p"],
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
    });

    const state = result.stateStore.getState();
    console.info(`[${SUITE}:guard-C:targetVariants-multi:assert] state.outputs=${state.outputs.length}`);
    const v1080 = state.outputs.find((o) => o.id === "video-1080p-h264");
    const v240 = state.outputs.find((o) => o.id === "video-240p-h264");
    if (!v1080 || !v240) {
      dumpTranscodeSnapshot("targetVariants-multi-missing", {
        transcodePlan: { targetVariants: ["1080p", "240p"] },
        stateOutputs: state.outputs,
      });
    }
    expect(v1080).toBeDefined();
    expect(v240).toBeDefined();
    expect(v1080?.quality).toBe("1080p");
    expect(v240?.quality).toBe("240p");
  });

  it("includeFallback: true without targetVariants still produces the legacy video-360p-h264 (backward compat)", async () => {
    console.info(`[${SUITE}:guard-C:legacy-fallback] expecting video-360p-h264 with no targetVariants`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });

    const result = await produceMediaOutputs({
      userId: "u1",
      jobId: "j-legacy-fallback",
      inputPath: "/tmp/movie.mkv",
      includeSource: false,
      includeFallback: true,
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
    });

    const state = result.stateStore.getState();
    if (!state.outputs.find((o) => o.id === "video-360p-h264")) {
      dumpTranscodeSnapshot("legacy-fallback-missing", {
        transcodePlan: { includeFallback: true, targetVariants: undefined },
        stateOutputs: state.outputs,
      });
    }
    expect(state.outputs.find((o) => o.id === "video-360p-h264")).toBeDefined();
  });

  it("ffmpeg is invoked with the per-variant scale + bitrate for 1080p", async () => {
    console.info(`[${SUITE}:guard-C:ffmpeg-args-1080p] capturing ffmpeg invocation args`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });

    const recordedArgs: string[][] = [];
    createFfmpegTaskMock.mockImplementation((args: string[]) => {
      recordedArgs.push(args);
      const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? args[args.length - 1];
      return {
        promise: setupDashOutput(mpdPath).then(() => ({ stdout: "", stderr: "" })),
        cancel: vi.fn(),
      };
    });

    await produceMediaOutputs({
      userId: "u1",
      jobId: "j-1080p-args",
      inputPath: "/tmp/movie.mkv",
      includeSource: false,
      includeFallback: false,
      targetVariants: ["1080p"],
      includeAudio: false,
      includeSubtitles: false,
      includeChapters: false,
    });

    console.info(`[${SUITE}:guard-C:ffmpeg-args-1080p:assert] captured ${recordedArgs.length} ffmpeg invocations`);
    if (recordedArgs.length !== 1) {
      dumpTranscodeSnapshot("ffmpeg-args-1080p-wrong-count", {
        transcodePlan: { targetVariants: ["1080p"] },
        ffmpegArgs: recordedArgs,
      });
    }
    // Exactly one ffmpeg invocation — the 1080p re-encode (no source copy,
    // no audio/subs requested).
    expect(recordedArgs.length).toBe(1);
    const args = recordedArgs[0];
    const hasScale1080 = args.some((a) => /scale[_a-z]*=.*1080/.test(a));
    const codecIdx = args.indexOf("-c:v");
    if (!hasScale1080 || codecIdx < 0) {
      dumpTranscodeSnapshot("ffmpeg-args-1080p-shape", {
        transcodePlan: { targetVariants: ["1080p"] },
        ffmpegArgs: recordedArgs,
      });
    }
    // Must include a scale filter targeting height 1080.
    expect(hasScale1080).toBe(true);
    // h264 codec lib (CPU detect on a non-GPU test box). Be permissive
    // about the exact encoder family — the detect-encoder path can pick
    // any of cpu/nvenc/qsv/vaapi/amf/videotoolbox depending on the test
    // host. We just need one of the h264_* selections.
    expect(codecIdx).toBeGreaterThanOrEqual(0);
    expect(args[codecIdx + 1]).toMatch(/^(libx264|h264_(nvenc|qsv|vaapi|amf|videotoolbox))$/);
  });
});
