import { beforeEach, describe, expect, it, vi } from "vitest";

const getFfmpegCapabilitiesMock = vi.hoisted(() => vi.fn());
const runFfmpegCapabilityTestMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/ffmpegCapabilities", () => ({
  getFfmpegCapabilities: getFfmpegCapabilitiesMock,
  runFfmpegCapabilityTest: runFfmpegCapabilityTestMock,
}));

import { registerFfmpegIpc } from "../src/main/ffmpegIpc";

type Handler = (_event: unknown, payload?: any) => unknown | Promise<unknown>;

const createIpcHarness = () => {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  };
  return { ipc, handlers };
};

// Dump-on-failure: surface the registered IPC channels, the runtime-bridge
// call counts/args, and the local-fallback mock state so a failing
// expectation is diagnosable offline (per "tests log generously").
const dumpFfmpegIpcSnapshot = (
  label: string,
  ctx: {
    handlers?: Map<string, Handler>;
    runtimeBridge?: { getCapabilities?: any; runCapabilityTest?: any };
    caps?: unknown;
    testResult?: unknown;
  },
) => {
  try {
    console.error(`=== [ffmpeg-runtime-ipc:${label}] snapshot ===`);
    console.error(
      `registered handlers=${JSON.stringify(ctx.handlers ? Array.from(ctx.handlers.keys()) : null)}`,
    );
    console.error(
      `runtimeBridge.getCapabilities calls=${JSON.stringify(ctx.runtimeBridge?.getCapabilities?.mock?.calls ?? null)}`,
    );
    console.error(
      `runtimeBridge.runCapabilityTest calls=${JSON.stringify(ctx.runtimeBridge?.runCapabilityTest?.mock?.calls ?? null)}`,
    );
    console.error(
      `local getFfmpegCapabilitiesMock calls=${JSON.stringify(getFfmpegCapabilitiesMock.mock.calls)}`,
    );
    console.error(
      `local runFfmpegCapabilityTestMock calls=${JSON.stringify(runFfmpegCapabilityTestMock.mock.calls)}`,
    );
    console.error(`observed caps=${JSON.stringify(ctx.caps)}`);
    console.error(`observed testResult=${JSON.stringify(ctx.testResult)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("ffmpeg runtime ipc integration", () => {
  beforeEach(() => {
    console.info(`[ffmpeg-runtime-ipc:setup] resetting ffmpeg capability mocks`);
    getFfmpegCapabilitiesMock.mockReset();
    runFfmpegCapabilityTestMock.mockReset();
  });

  it("prefers runtime ffmpeg capabilities and test result when available", async () => {
    console.info(`[ffmpeg-runtime-ipc:runtime-preferred] registering ipc with available runtime bridge`);
    const { ipc, handlers } = createIpcHarness();
    const runtimeBridge = {
      getCapabilities: vi.fn(async () => ({ preferredEncoder: "qsv", encoders: ["h264_qsv"] })),
      runCapabilityTest: vi.fn(async () => ({ encoder: "qsv", ok: true, testedAt: "2026-01-01T00:00:00.000Z" })),
    };

    registerFfmpegIpc(ipc as any, {
      runtimeBridge: runtimeBridge as any,
    });
    console.info(
      `[ffmpeg-runtime-ipc:runtime-preferred] registered handlers=${JSON.stringify(Array.from(handlers.keys()))}`,
    );

    const caps = await handlers.get("sf-ffmpeg-capabilities")?.(null);
    console.info(`[ffmpeg-runtime-ipc:runtime-preferred] capabilities result=${JSON.stringify(caps)}`);
    try {
      expect(caps).toEqual({ preferredEncoder: "qsv", encoders: ["h264_qsv"] });
      expect(runtimeBridge.getCapabilities).toHaveBeenCalledTimes(1);
      expect(getFfmpegCapabilitiesMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpFfmpegIpcSnapshot("runtime-preferred-caps", { handlers, runtimeBridge, caps });
      throw err;
    }

    const testResult = await handlers.get("sf-ffmpeg-capabilities-test")?.(null, "qsv");
    console.info(`[ffmpeg-runtime-ipc:runtime-preferred] capability-test result=${JSON.stringify(testResult)}`);
    try {
      expect(testResult).toEqual({ encoder: "qsv", ok: true, testedAt: "2026-01-01T00:00:00.000Z" });
      expect(runtimeBridge.runCapabilityTest).toHaveBeenCalledWith("qsv");
      expect(runFfmpegCapabilityTestMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpFfmpegIpcSnapshot("runtime-preferred-test", { handlers, runtimeBridge, caps, testResult });
      throw err;
    }
  });

  it("falls back to local ffmpeg capability functions when runtime is unavailable", async () => {
    console.info(`[ffmpeg-runtime-ipc:local-fallback] registering ipc with runtime bridge returning null`);
    const { ipc, handlers } = createIpcHarness();
    const runtimeBridge = {
      getCapabilities: vi.fn(async () => null),
      runCapabilityTest: vi.fn(async () => null),
    };
    getFfmpegCapabilitiesMock.mockReturnValue({ preferredEncoder: "cpu", encoders: ["libx264"] });
    runFfmpegCapabilityTestMock.mockReturnValue({ encoder: "cpu", ok: false, testedAt: "2026-01-01T00:00:00.000Z" });

    registerFfmpegIpc(ipc as any, {
      runtimeBridge: runtimeBridge as any,
    });
    console.info(
      `[ffmpeg-runtime-ipc:local-fallback] registered handlers=${JSON.stringify(Array.from(handlers.keys()))}`,
    );

    const caps = await handlers.get("sf-ffmpeg-capabilities")?.(null);
    console.info(`[ffmpeg-runtime-ipc:local-fallback] capabilities result=${JSON.stringify(caps)}`);
    try {
      expect(caps).toEqual({ preferredEncoder: "cpu", encoders: ["libx264"] });
      expect(getFfmpegCapabilitiesMock).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpFfmpegIpcSnapshot("local-fallback-caps", { handlers, runtimeBridge, caps });
      throw err;
    }

    const testResult = await handlers.get("sf-ffmpeg-capabilities-test")?.(null, "cpu");
    console.info(`[ffmpeg-runtime-ipc:local-fallback] capability-test result=${JSON.stringify(testResult)}`);
    try {
      expect(testResult).toEqual({ encoder: "cpu", ok: false, testedAt: "2026-01-01T00:00:00.000Z" });
      expect(runFfmpegCapabilityTestMock).toHaveBeenCalledWith("cpu");
    } catch (err) {
      dumpFfmpegIpcSnapshot("local-fallback-test", { handlers, runtimeBridge, caps, testResult });
      throw err;
    }
  });
});
