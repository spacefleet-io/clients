import { getDesktopPlatform, setDesktopPlatformForTests, type EncoderPolicy } from "@space/desktop-platform";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  getGPUInfo: vi.fn(async (..._args: unknown[]) => ({
    gpuDevice: [{ vendor: "NVIDIA", device: "RTX", driverVersion: "1.0" }],
    auxAttributes: { glRenderer: "MockRenderer" },
  })),
}));

vi.mock("electron", () => ({
  app: {
    getGPUInfo: (...args: unknown[]) => state.getGPUInfo(...args),
  },
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => state.spawnSync(...args),
}));

import { getFfmpegCapabilities, runFfmpegCapabilityTest } from "../src/main/ffmpegCapabilities";

const makeResult = (stdout: string, stderr = "", status = 0) => ({ stdout, stderr, status });

// The Linux platform's policy shape, injected so the NVIDIA → nvenc pick is pinned
// independently of the dev host's own policy (macOS: videotoolbox only).
const linuxPolicy: EncoderPolicy = { order: ["vaapi", "qsv", "nvenc"], vendors: { vaapi: ["amd", "intel"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] } };

// Dump the computed ffmpeg capability/test state + spawn call shape on
// assertion failure. try/catch so a dump failure can't mask the real expect().
const dumpFfmpegCapabilitiesSnapshot = (label: string, payload: Record<string, unknown>) => {
  try {
    console.error(`=== [ffmpeg-capabilities:${label}] snapshot ===`);
    console.error(`spawnSync.calls=${state.spawnSync.mock.calls.length}`);
    console.error(`spawnSync.callArgs:\n${JSON.stringify(state.spawnSync.mock.calls, null, 2)}`);
    for (const [k, v] of Object.entries(payload)) {
      console.error(`${k}:\n${JSON.stringify(v, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("ffmpeg capability detection", () => {
  afterEach(() => setDesktopPlatformForTests(null));

  it("detects encoders/hwaccels and picks preferred encoder from GPU vendor", async () => {
    const base = getDesktopPlatform();
    setDesktopPlatformForTests({ ...base, hardware: { ...base.hardware, encoderPolicy: linuxPolicy } });
    console.info("[ffmpeg-capabilities:detect] mocking spawnSync for encoders/hwaccels (NVIDIA GPU)");
    state.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("-encoders")) {
        return makeResult(" V..... h264_nvenc NVIDIA encoder\n V..... h264_qsv Intel encoder\n");
      }
      if (args.includes("-hwaccels")) {
        return makeResult("Hardware acceleration methods:\nvaapi\nqsv\n");
      }
      return makeResult("");
    });

    const caps = await getFfmpegCapabilities();
    console.info(
      `[ffmpeg-capabilities:detect] encoders=${JSON.stringify(caps.encoders)} hwaccels=${JSON.stringify(caps.hwaccels)} preferredEncoder=${caps.preferredEncoder} gpu.vendor=${caps.gpu?.vendor}`,
    );
    if (
      !caps.encoders.includes("h264_nvenc") ||
      !caps.hwaccels.includes("vaapi") ||
      caps.preferredEncoder !== "nvenc" ||
      caps.gpu?.vendor !== "NVIDIA"
    ) {
      dumpFfmpegCapabilitiesSnapshot("detect", { caps });
    }
    expect(caps.encoders).toContain("h264_nvenc");
    expect(caps.hwaccels).toContain("vaapi");
    expect(caps.preferredEncoder).toBe("nvenc");
    expect(caps.gpu?.vendor).toBe("NVIDIA");
  });

  it("surfaces test failure diagnostics with exit code", async () => {
    console.info("[ffmpeg-capabilities:test-failure] mocking spawnSync to fail encoder test with status=1");
    state.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("-encoders")) return makeResult(" V..... h264_nvenc NVIDIA encoder\n");
      if (args.includes("-hwaccels")) return makeResult("Hardware acceleration methods:\nvaapi\n");
      return makeResult("", "Error while opening encoder", 1);
    });

    const result = await runFfmpegCapabilityTest("nvenc");
    console.info(
      `[ffmpeg-capabilities:test-failure] result.ok=${result?.ok} result.encoder=${result?.encoder} result.message=${JSON.stringify(result?.message)}`,
    );
    if (result?.ok !== false || !result?.message?.includes("exit 1") || result?.encoder !== "nvenc") {
      dumpFfmpegCapabilitiesSnapshot("test-failure", { result });
    }
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("exit 1");
    expect(result?.encoder).toBe("nvenc");
  });
});
