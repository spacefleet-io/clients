/**
 * The runtime's ffmpeg capability report picks its preferred encoder from the
 * desktop platform's encoder policy (no GPU vendor is known here, so the OS's
 * own order decides) and finds the VAAPI render node through the platform.
 */
import { getDesktopPlatform, setDesktopPlatformForTests, type EncoderPolicy } from "@space/desktop-platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "badger-ffmpeg-capabilities";

const state = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: (...args: unknown[]) => state.spawnSync(...args) }));

import { getRuntimeFfmpegCapabilities, runRuntimeFfmpegCapabilityTest } from "../src/modules/badgerFfmpeg";

// Policy shapes the Linux / Windows platform implementations hand in, injected so the
// pick algorithm is pinned independently of the dev host's own policy.
const linuxPolicy: EncoderPolicy = { order: ["vaapi", "qsv", "nvenc"], vendors: { vaapi: ["amd", "intel"], qsv: ["intel"], nvenc: ["nvidia"] } };
const windowsPolicy: EncoderPolicy = { order: ["amf", "qsv", "nvenc"], vendors: { amf: ["amd"], qsv: ["intel"], nvenc: ["nvidia"] } };

const advertise = (...names: string[]) => {
  state.spawnSync.mockImplementation((_cmd: string, args: string[] = []) => ({
    stdout: args.includes("-encoders") ? names.map((n) => ` V..... ${n} encoder`).join("\n") : "",
    stderr: "",
    status: 0,
  }));
};

describe("runtime ffmpeg capabilities", () => {
  beforeEach(() => state.spawnSync.mockReset());
  afterEach(() => setDesktopPlatformForTests(null));

  it("prefers the first advertised encoder of the platform's order, else cpu", () => {
    const base = getDesktopPlatform();
    setDesktopPlatformForTests({ ...base, hardware: { ...base.hardware, encoderPolicy: linuxPolicy } });
    const cases: Array<[string[], string]> = [
      [["h264_nvenc", "h264_qsv", "h264_vaapi"], "vaapi"],
      [["h264_nvenc", "h264_qsv"], "qsv"],
      [["h264_nvenc"], "nvenc"],
      [["libx264", "h264_amf"], "cpu"],
      [[], "cpu"],
    ];
    for (const [names, want] of cases) {
      advertise(...names);
      const got = getRuntimeFfmpegCapabilities().preferredEncoder;
      console.info(`[${SUITE}:linux-order] ${JSON.stringify(names)} -> ${got} (want ${want})`);
      expect(got).toBe(want);
    }
  });

  it("follows another platform's policy through the seam", () => {
    const base = getDesktopPlatform();
    setDesktopPlatformForTests({ ...base, hardware: { ...base.hardware, encoderPolicy: windowsPolicy } });
    advertise("h264_nvenc", "h264_amf", "h264_vaapi");
    const got = getRuntimeFfmpegCapabilities().preferredEncoder;
    console.info(`[${SUITE}:windows-order] -> ${got}`);
    expect(got).toBe("amf");
  });

  it("tests VAAPI on the render node the platform reports, and reports a missing node", () => {
    const base = getDesktopPlatform();
    advertise("h264_vaapi");
    setDesktopPlatformForTests({ ...base, hardware: { ...base.hardware, deviceFor: () => "/dev/dri/renderD129" } });
    const ok = runRuntimeFfmpegCapabilityTest("vaapi");
    const call = state.spawnSync.mock.calls.find(([, args]) => ((args as string[] | undefined) ?? []).includes("-vaapi_device"));
    console.info(`[${SUITE}:vaapi-device] result=${JSON.stringify(ok)} args=${JSON.stringify(call?.[1])}`);
    expect((call?.[1] as string[])[(call?.[1] as string[]).indexOf("-vaapi_device") + 1]).toBe("/dev/dri/renderD129");

    state.spawnSync.mockClear();
    setDesktopPlatformForTests({ ...base, hardware: { ...base.hardware, deviceFor: () => null } });
    const missing = runRuntimeFfmpegCapabilityTest("vaapi");
    console.info(`[${SUITE}:vaapi-missing] ${JSON.stringify(missing)}`);
    expect(missing?.ok).toBe(false);
    expect(missing?.message).toContain("VAAPI device not found");
  });

  // The runtime has no console on Windows (spawned detached): an ffmpeg probe without windowsHide opened a
  // visible console window in Badger 0.1.0 to 0.1.2.
  it("@req PLAT-DESK-13 @bugfix @regression-proof probes ffmpeg with the platform's spawn options (windowsHide on Windows)", () => {
    const base = getDesktopPlatform();
    const windowsSpawnOptions = ({ detached }: { detached: boolean }) => ({ detached, windowsHide: true });
    setDesktopPlatformForTests({ ...base, processes: { ...base.processes, spawnOptions: windowsSpawnOptions } });
    advertise("h264_nvenc");
    getRuntimeFfmpegCapabilities();
    runRuntimeFfmpegCapabilityTest("cpu");
    const calls = state.spawnSync.mock.calls.map(([cmd, args, opts]) => ({ cmd, first: (args as string[])[0], opts }));
    console.info(`[${SUITE}:windows-hide] spawnSync calls=${JSON.stringify(calls)}`);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call.opts).toMatchObject({ windowsHide: true, detached: false });
  });
});
