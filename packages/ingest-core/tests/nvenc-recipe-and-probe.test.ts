/**
 * @test-id INGEST-NVENC-RECIPE-PROBE-001
 * @level unit
 * @why Ultimate stress #25 (NVIDIA test machine, RTX 5090): `h264_nvenc` + `scale_cuda`
 *      failed with "Impossible to convert between the formats supported by
 *      scale_cuda". Two contract bugs, both pinned here without needing a GPU
 *      (the real-GPU proof lives in nvenc-scale-cuda.integration.test.ts):
 *        1. The NVENC recipe passed `-pix_fmt yuv420p` on the output, which
 *           appends a CPU `format=yuv420p` after scale_cuda's CUDA frames.
 *           8-bit 4:2:0 must be requested INSIDE the GPU chain
 *           (`scale_cuda=…:format=nv12`) and `hwupload` must precede it so
 *           sources NVDEC cannot decode (10-bit/4:4:4 H.264, VP9, …) still
 *           reach the GPU.
 *        2. `probeHardwareEncoder("nvenc")` ran a bare `-c:v h264_nvenc`, so it
 *           passed on a host whose real chain was broken. The probe must run
 *           the SAME device wiring, filter chain and encoder flags as a real
 *           encode.
 * @covers packages/ingest-core/src/mediaProcessor.ts: buildVideoEncoderArgs,
 *         buildEncoderProbeArgs (via detectEncoder)
 * @bugfix @regression-proof
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUALITY_ORDER } from "../src/quality";
import { pinLinuxHardware } from "./helpers/pin-linux-hardware";

const SUITE = "nvenc-recipe-and-probe";

const runFfmpegMock = vi.fn();
const runFfprobeMock = vi.fn();
const createFfmpegTaskMock = vi.fn();

vi.mock("@space/ffmpeg", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: createFfmpegTaskMock,
}));

const argValueAfter = (args: string[], flag: string) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const qualityHeight = (quality: string) => Number(quality.replace("p", ""));

describe("@bugfix @regression-proof NVENC recipe keeps the whole chain on the GPU (#25)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each(QUALITY_ORDER)("%s: no output -pix_fmt; 8-bit 4:2:0 requested inside the scale_cuda chain", async (quality) => {
    const { buildVideoEncoderArgs } = await import("../src/mediaProcessor");
    const { preArgs, encoderArgs } = buildVideoEncoderArgs("nvenc", null, quality);
    console.info(`[${SUITE}:recipe:${quality}] preArgs=${preArgs.join(" ")} | encoderArgs=${encoderArgs.join(" ")}`);

    // The bug: an output -pix_fmt appends a software format filter after
    // scale_cuda's CUDA surfaces → "Impossible to convert between the formats".
    expect(encoderArgs).not.toContain("-pix_fmt");
    // scale resizes AND converts to 8-bit NV12 on the GPU; hwupload first so
    // software-decoded frames (10-bit H.264, 4:4:4, VP9, …) are uploaded and
    // CUDA frames from NVDEC pass straight through.
    expect(argValueAfter(encoderArgs, "-vf")).toBe(`hwupload,scale_cuda=-2:${qualityHeight(quality)}:format=nv12`);
    // A filter hw device is required for hwupload of software frames.
    expect(argValueAfter(preArgs, "-init_hw_device")).toMatch(/^cuda=/);
    expect(argValueAfter(preArgs, "-filter_hw_device")).toBe(argValueAfter(preArgs, "-init_hw_device")?.replace(/^cuda=/, ""));
    expect(argValueAfter(preArgs, "-hwaccel")).toBe("cuda");
    expect(argValueAfter(preArgs, "-hwaccel_output_format")).toBe("cuda");
  });
});

describe("@bugfix @regression-proof NVENC probe exercises the same chain as a real encode (#25)", () => {
  beforeEach(async () => {
    await pinLinuxHardware();
    runFfmpegMock.mockReset();
    const { configureMediaIngestRuntime, resetEncoderProbeCache } = await import("../src/mediaProcessor");
    resetEncoderProbeCache();
    configureMediaIngestRuntime({ getGpuVendor: async () => "NVIDIA Corporation" });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("probe argv = real recipe's device wiring + filter chain + encoder flags", async () => {
    const probeCalls: string[][] = [];
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "-encoders") return { stdout: " V....D h264_nvenc NVIDIA NVENC", stderr: "", code: 0 };
      probeCalls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    });

    const { detectEncoder, buildVideoEncoderArgs } = await import("../src/mediaProcessor");
    const selected = await detectEncoder();
    expect(selected).toBe("nvenc");
    expect(probeCalls).toHaveLength(1);
    const probe = probeCalls[0]!;
    console.info(`[${SUITE}:probe] argv=${probe.join(" ")}`);

    const real = buildVideoEncoderArgs("nvenc", null, "360p");
    // Same filter chain (this is what the pre-fix probe never ran).
    expect(argValueAfter(probe, "-vf")).toBe(argValueAfter(real.encoderArgs, "-vf"));
    // Same encoder flags, in order, as the real encode — so any flag that
    // breaks negotiation (e.g. the old -pix_fmt) breaks the probe too.
    const joinedProbe = probe.join(" ");
    expect(joinedProbe).toContain(real.encoderArgs.join(" "));
    // Same filter-device wiring.
    expect(argValueAfter(probe, "-init_hw_device")).toBe(argValueAfter(real.preArgs, "-init_hw_device"));
    expect(argValueAfter(probe, "-filter_hw_device")).toBe(argValueAfter(real.preArgs, "-filter_hw_device"));
    // The probe input is a lavfi source: decode-side hwaccel flags must not be
    // applied to it, but it must be a real (software) frame source.
    expect(probe).not.toContain("-hwaccel");
    expect(probe).toContain("lavfi");
    // Pre-fix the probe was just `-c:v h264_nvenc` with no -vf at all.
    expect(probe).toContain("-vf");
  });

  it("a host whose scale_cuda chain is broken is rejected by the probe → cpu (not discovered mid-job)", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "-encoders") return { stdout: " V....D h264_nvenc NVIDIA NVENC", stderr: "", code: 0 };
      // Plain h264_nvenc works on this simulated host; only the scale_cuda
      // chain fails — exactly that test machine. Pre-fix the probe never ran the
      // chain, so it reported "nvenc ok".
      if (args.some((arg) => arg.includes("scale_cuda"))) {
        throw new Error(
          "Impossible to convert between the formats supported by the filter 'Parsed_scale_cuda_0' and the filter 'auto_scale_0'",
        );
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const { detectEncoder } = await import("../src/mediaProcessor");
    expect(await detectEncoder()).toBe("cpu");
  });
});
