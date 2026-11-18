import type { EncoderPolicy } from "@space/desktop-platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "detect-encoder";

const runFfmpegMock = vi.fn();

vi.mock("@space/ffmpeg", () => ({
  runFfprobe: vi.fn(),
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: vi.fn(),
}));

const dumpEncoderSnapshot = (
  label: string,
  ctx: {
    platform?: string;
    vendor?: string;
    candidateEncoders?: ReadonlyArray<string>;
    ffmpegStdout?: string;
    ffmpegStderr?: string;
    selected?: unknown;
    expected?: string;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.platform !== undefined) {
      console.error(`encoder policy: ${JSON.stringify(ctx.platform)}`);
    }
    if (ctx.vendor !== undefined) {
      console.error(`gpu vendor: ${JSON.stringify(ctx.vendor)}`);
    }
    if (ctx.candidateEncoders !== undefined) {
      console.error(`candidate encoders advertised by ffmpeg: ${JSON.stringify(ctx.candidateEncoders)}`);
    }
    if (ctx.ffmpegStdout !== undefined) {
      console.error(`ffmpeg -encoders stdout:\n${ctx.ffmpegStdout}`);
    }
    if (ctx.ffmpegStderr !== undefined && ctx.ffmpegStderr.length > 0) {
      console.error(`ffmpeg -encoders stderr:\n${ctx.ffmpegStderr}`);
    }
    if (ctx.selected !== undefined) {
      console.error(`selected encoder: ${JSON.stringify(ctx.selected)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected encoder: ${JSON.stringify(ctx.expected)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const makeEncoderStdout = (encoders: string[]) =>
  ["Encoders:", ...encoders.map((e) => ` V..... ${e}`)].join("\n");

// The selection ALGORITHM is shared (`pickHardwareEncoder`); the OS contributes
// only DATA (`hardware.encoderPolicy`). Each case injects the policy shape its
// platform implementation hands in (never the dev host's own), so the caller's
// wiring is covered for every OS shape on any host without a process.platform
// override.
const encoderPolicies: Record<string, EncoderPolicy> = {
  linux: { order: ["vaapi", "qsv", "nvenc"], vendors: { vaapi: ["amd", "intel"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] } },
  windows: { order: ["amf", "qsv", "nvenc"], vendors: { amf: ["amd", "radeon"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] } },
  macos: { order: ["videotoolbox"], vendors: { videotoolbox: ["apple"] } },
};

describe("detectEncoder selection logic", () => {
  beforeEach(async () => {
    console.info(`[${SUITE}:setup] resetting media-ingest runtime with empty GPU vendor`);
    const { configureMediaIngestRuntime } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({ getGpuVendor: async () => "" });
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] unpinning the desktop platform + vi.resetModules()`);
    vi.resetModules();
  });

  // Dynamic import: resolves the SAME @space/desktop-platform instance that the
  // (re-imported after vi.resetModules) mediaProcessor under test uses.
  const setPlatform = async (name: string) => {
    console.info(`[${SUITE}:setup] encoder policy ${JSON.stringify(name)}`);
    const { getDesktopPlatform, setDesktopPlatformForTests } = await import("@space/desktop-platform");
    const base = getDesktopPlatform();
    const encoderPolicy = encoderPolicies[name];
    if (!encoderPolicy) throw new Error(`no encoder policy fixture for ${name}`);
    setDesktopPlatformForTests({ ...base, hardware: { ...base.hardware, encoderPolicy } });
  };

  const setGpuVendor = async (vendor: string) => {
    console.info(`[${SUITE}:setup] setGpuVendor(${JSON.stringify(vendor)})`);
    const { configureMediaIngestRuntime } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({ getGpuVendor: async () => vendor });
  };

  const callDetectEncoder = async () => {
    console.info(`[${SUITE}:exec] calling detectEncoder()`);
    const { detectEncoder } = await import("../src/mediaProcessor");
    const result = await detectEncoder();
    console.info(`[${SUITE}:exec] detectEncoder() => ${JSON.stringify(result)}`);
    return result;
  };

  const runCase = async (params: {
    label: string;
    platform: string;
    vendor: string;
    candidates: string[];
    expected: string;
  }) => {
    console.info(`[${SUITE}:case] ${params.label}: platform=${params.platform} vendor=${params.vendor} candidates=${JSON.stringify(params.candidates)} expected=${params.expected}`);
    await setPlatform(params.platform);
    await setGpuVendor(params.vendor);
    const stdout = makeEncoderStdout(params.candidates);
    runFfmpegMock.mockResolvedValue({ stdout, stderr: "", code: 0 });
    const selected = await callDetectEncoder();
    try {
      expect(selected).toBe(params.expected);
    } catch (err) {
      dumpEncoderSnapshot(params.label, {
        platform: params.platform,
        vendor: params.vendor,
        candidateEncoders: params.candidates,
        ffmpegStdout: stdout,
        ffmpegStderr: "",
        selected,
        expected: params.expected,
      });
      throw err;
    }
  };

  it("linux + amd + [h264_vaapi] → vaapi", async () => {
    await runCase({
      label: "linux-amd-vaapi-only",
      platform: "linux",
      vendor: "amd",
      candidates: ["h264_vaapi"],
      expected: "vaapi",
    });
  });

  it("linux + intel + [h264_vaapi, h264_qsv] → vaapi (VAAPI preferred for Intel iGPU)", async () => {
    await runCase({
      label: "linux-intel-vaapi-preferred-over-qsv",
      platform: "linux",
      vendor: "intel",
      candidates: ["h264_vaapi", "h264_qsv"],
      expected: "vaapi",
    });
  });

  it("linux + nvidia + [h264_nvenc] → nvenc", async () => {
    await runCase({
      label: "linux-nvidia-nvenc",
      platform: "linux",
      vendor: "nvidia",
      candidates: ["h264_nvenc"],
      expected: "nvenc",
    });
  });

  it("linux + (no vendor) + [h264_vaapi] → vaapi (fallback path)", async () => {
    await runCase({
      label: "linux-no-vendor-vaapi-fallback",
      platform: "linux",
      vendor: "",
      candidates: ["h264_vaapi"],
      expected: "vaapi",
    });
  });

  it("macos + apple + [h264_videotoolbox] → videotoolbox", async () => {
    await runCase({
      label: "macos-apple-videotoolbox",
      platform: "macos",
      vendor: "apple",
      candidates: ["h264_videotoolbox"],
      expected: "videotoolbox",
    });
  });

  it("macos + apple + [h264_videotoolbox, h264_nvenc] → videotoolbox (platform-first)", async () => {
    await runCase({
      label: "macos-apple-platform-first-over-nvenc",
      platform: "macos",
      vendor: "apple",
      candidates: ["h264_videotoolbox", "h264_nvenc"],
      expected: "videotoolbox",
    });
  });

  it("windows + amd + [h264_amf] → amf", async () => {
    await runCase({
      label: "windows-amd-amf",
      platform: "windows",
      vendor: "amd",
      candidates: ["h264_amf"],
      expected: "amf",
    });
  });

  it("windows + amd + [h264_amf, h264_vaapi] → amf (platform-vendor first)", async () => {
    await runCase({
      label: "windows-amd-amf-over-vaapi",
      platform: "windows",
      vendor: "amd",
      candidates: ["h264_amf", "h264_vaapi"],
      expected: "amf",
    });
  });

  it("windows + nvidia + [h264_nvenc] → nvenc", async () => {
    await runCase({
      label: "windows-nvidia-nvenc",
      platform: "windows",
      vendor: "nvidia",
      candidates: ["h264_nvenc"],
      expected: "nvenc",
    });
  });

  it("linux + amd + [] (no hwaccel) → cpu", async () => {
    await runCase({
      label: "linux-amd-no-hwaccel-cpu-fallback",
      platform: "linux",
      vendor: "amd",
      candidates: [],
      expected: "cpu",
    });
  });
});
