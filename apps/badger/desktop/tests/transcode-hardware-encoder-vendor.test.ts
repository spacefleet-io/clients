/**
 * @bugfix @regression-proof
 *
 * #25 review (ReviewHwDefault finding 0): main's GPU vendor hook read
 * `app.getGPUInfo("complete").gpuDevice[0].vendor`, which Chromium never
 * sets (it reports `vendorId` / `vendorString`), so the vendor was always "".
 * On a Windows machine whose ffmpeg advertises both h264_amf and h264_qsv,
 * the vendor-less pick fell through to AMF, the AMF test encode failed, and
 * the first-start probe stored `hwEncoder=none` for good — an Intel-QSV (or
 * NVIDIA-NVENC) computer was told it has no encoder and could be recommended
 * OFF.
 *
 * Simulated machine: Windows, Intel GPU (vendorId 0x8086), ffmpeg lists
 * h264_amf and h264_qsv, only a QSV test encode succeeds.
 *   1. with the real vendor id → the probe reports qsv (vendor mapping);
 *   2. with no usable vendor at all → still qsv (the first-start probe tries
 *      every advertised hardware encoder until one works).
 * Pre-fix, both report "none".
 */
import type { EncoderPolicy } from "@space/desktop-platform";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "transcode-hardware-encoder-vendor";

const getGPUInfo = vi.fn();
vi.mock("electron", () => ({
  app: { getGPUInfo: (kind: string) => getGPUInfo(kind), getPath: () => "/tmp" },
}));

const runFfmpegMock = vi.fn();
// ingest-core resolves @space/ffmpeg to the workspace package source (not the
// desktop's installed copy), so mock that file: no real ffmpeg runs here.
vi.mock("@space/ffmpeg", () => ({
  runFfmpeg: runFfmpegMock,
  runFfprobe: vi.fn(),
  createFfmpegTask: vi.fn(),
}));

const ENCODERS_STDOUT = [
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " V....D h264_amf             AMD AMF H.264 Encoder (codec h264)",
  " V....D h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)",
].join("\n");

// The machine is Windows-shaped through the platform seam: the encoder policy
// (amf, qsv, nvenc) is the data a Windows platform implementation hands the
// shared selection algorithm. No process.platform override.
const windowsEncoderPolicy: EncoderPolicy = {
  order: ["amf", "qsv", "nvenc"],
  vendors: { amf: ["amd", "radeon"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] },
};

const probedEncoders: string[] = [];

beforeEach(() => {
  vi.resetModules();
  probedEncoders.length = 0;
  getGPUInfo.mockReset();
  runFfmpegMock.mockReset();
  runFfmpegMock.mockImplementation(async (args: string[]) => {
    if (args.includes("-encoders")) return { stdout: ENCODERS_STDOUT, stderr: "" };
    const cv = args[args.indexOf("-c:v") + 1] ?? "";
    probedEncoders.push(cv);
    console.info(`[${SUITE}:ffmpeg] test encode ${cv}`);
    if (cv === "h264_qsv") return { stdout: "", stderr: "" };
    throw new Error(`[enc:${cv}] Could not open encoder before EOF`);
  });
});

const probe = async () => {
  // Same module registry as the transcodeHardware / ingest-core imports below (vi.resetModules above).
  const { getDesktopPlatform, setDesktopPlatformForTests } = await import("@space/desktop-platform");
  const base = getDesktopPlatform();
  setDesktopPlatformForTests({ ...base, hardware: { ...base.hardware, encoderPolicy: windowsEncoderPolicy } });
  const { probeTranscodeHardware } = await import("../src/main/transcodeHardware");
  const hardware = await probeTranscodeHardware();
  console.info(`[${SUITE}:result] hwEncoder=${hardware.hwEncoder} probed=${JSON.stringify(probedEncoders)}`);
  return hardware;
};

describe("@bugfix @regression-proof first-start hardware encoder detection", () => {
  it("maps Chromium's vendorId: an Intel GPU with amf+qsv advertised gets qsv", async () => {
    getGPUInfo.mockResolvedValue({
      gpuDevice: [{ vendorId: 0x8086, deviceId: 0x5912, active: true, vendorString: "", deviceString: "" }],
    });
    const hardware = await probe();
    expect(hardware.hwEncoder).toBe("qsv");
    // The vendor picks QSV first: no wasted AMF test encode.
    expect(probedEncoders).toEqual(["h264_qsv"]);
  });

  it("tries every advertised hardware encoder when the GPU vendor is unknown", async () => {
    getGPUInfo.mockRejectedValue(new Error("GPU process unavailable"));
    const hardware = await probe();
    expect(hardware.hwEncoder).toBe("qsv");
    expect(probedEncoders).toContain("h264_qsv");
  });

  it("reads the vendor from vendorId, else vendorString, preferring the active device", async () => {
    const { gpuVendorFromInfo } = await import("../src/main/mediaIngest");
    expect(gpuVendorFromInfo({ gpuDevice: [{ vendorId: 0x10de }] })).toBe("nvidia");
    expect(gpuVendorFromInfo({ gpuDevice: [{ vendorId: 0x1002 }] })).toBe("amd");
    expect(
      gpuVendorFromInfo({ gpuDevice: [{ vendorId: 0x8086, active: false }, { vendorId: 0x10de, active: true }] }),
    ).toBe("nvidia");
    expect(gpuVendorFromInfo({ gpuDevice: [{ vendorId: 0x1234, vendorString: "Intel Inc." }] })).toBe("intel inc.");
    expect(gpuVendorFromInfo({ gpuDevice: [] })).toBe("");
    expect(gpuVendorFromInfo({})).toBe("");
    expect(gpuVendorFromInfo(null)).toBe("");
  });
});
