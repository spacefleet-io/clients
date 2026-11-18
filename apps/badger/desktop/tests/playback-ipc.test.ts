import type { IpcMain } from "electron";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { registerPlaybackIpc } from "../src/main/playbackIpc";
import type { PlaybackLinkEstimate } from "../src/main/playbackLinkMeter";
import type { PlaybackRuntimeBridge } from "../src/main/playbackRuntimeBridge";
import type { PlaybackServer } from "../src/main/playbackServer";

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

// On assertion failure, dump the registered IPC channels + the mock call args
// for the playbackServer / runtimeBridge so the diagnose is offline. Wrapped in
// try/catch so a dump failure can't mask the original assertion.
const dumpPlaybackIpcSnapshot = (
  label: string,
  ctx: {
    handlers?: Map<string, Handler>;
    playbackServer?: Record<string, { mock?: { calls: unknown[] } }>;
    runtimeBridge?: Record<string, { mock?: { calls: unknown[] } }>;
    extra?: Record<string, unknown>;
  },
): void => {
  try {
    console.error(`=== [playback-ipc-integration:${label}] snapshot ===`);
    if (ctx.handlers) {
      console.error(
        `registered channels: ${JSON.stringify([...ctx.handlers.keys()])}`,
      );
    }
    const dumpMockCalls = (
      bag: Record<string, { mock?: { calls: unknown[] } }> | undefined,
      name: string,
    ) => {
      if (!bag) return;
      const calls: Record<string, unknown[]> = {};
      for (const [key, fn] of Object.entries(bag)) {
        if (fn && typeof fn === "object" && fn.mock) calls[key] = fn.mock.calls;
      }
      console.error(`${name} mock calls:\n${JSON.stringify(calls, null, 2)}`);
    };
    dumpMockCalls(ctx.playbackServer, "playbackServer");
    dumpMockCalls(ctx.runtimeBridge, "runtimeBridge");
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("playback ipc integration", () => {
  let playbackServer: {
    getBaseUrl: ReturnType<typeof vi.fn>;
    setToken: ReturnType<typeof vi.fn>;
    resetSignedUrlMetrics: ReturnType<typeof vi.fn>;
    getSignedUrlMetrics: ReturnType<typeof vi.fn>;
    createStream: ReturnType<typeof vi.fn>;
    releaseStream: ReturnType<typeof vi.fn>;
    createHlsSession: ReturnType<typeof vi.fn>;
    releaseHlsSession: ReturnType<typeof vi.fn>;
    getLinkEstimate: Mock<() => PlaybackLinkEstimate>;
  };
  let runtimeBridge: {
    setBackendToken: ReturnType<typeof vi.fn>;
    prepareSession: ReturnType<typeof vi.fn>;
    mirrorPrepare: ReturnType<typeof vi.fn>;
    mirrorRelease: ReturnType<typeof vi.fn>;
    getSignedUrlMetrics: ReturnType<typeof vi.fn>;
    resetSignedUrlMetrics: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    playbackServer = {
      getBaseUrl: vi.fn(() => "http://127.0.0.1:41111"),
      setToken: vi.fn(),
      resetSignedUrlMetrics: vi.fn(),
      getSignedUrlMetrics: vi.fn(() => ({ resetAt: 1, requests: 2 })),
      createStream: vi.fn(() => ({
        id: "runtime-stream-1",
        url: "http://127.0.0.1:41111/playback/stream/runtime-stream-1",
        totalSize: 123,
      })),
      releaseStream: vi.fn(),
      createHlsSession: vi.fn(() => ({
        id: "runtime-hls-1",
        url: "http://127.0.0.1:41111/playback/hls/runtime-hls-1/master.m3u8",
      })),
      releaseHlsSession: vi.fn(),
      getLinkEstimate: vi.fn(() => ({ bps: 4_200_000, sampleCount: 5, updatedAtMs: 1_700_000_000_000, throttleKbps: 0 })),
    };
    runtimeBridge = {
      setBackendToken: vi.fn(),
      prepareSession: vi.fn(),
      mirrorPrepare: vi.fn(),
      mirrorRelease: vi.fn(),
      getSignedUrlMetrics: vi.fn(async () => ({ resetAt: "2026-01-01T00:00:00.000Z", requests: 7 })),
      resetSignedUrlMetrics: vi.fn(async () => ({ resetAt: "2026-01-01T00:00:00.000Z", requests: 0 })),
    };
  });

  /**
   * @test-id DESKTOP-IPC-PLAYBACK-001
   * @level integration
   * @bugfix runtime-block-playback-launch
   * @regression-proof Playback launch must NOT await runtimeBridge.prepareSession.
   * The runtime is informed out-of-band via fire-and-forget mirrorPrepare, so a
   * slow or wedged runtime never delays the local HLS/stream session creation.
   * Previously prepareSession was awaited and a hung runtime stalled the "Preparing
   * player" modal for tens of seconds. The local playback server allocates its
   * own session id; the runtime gets that id via mirrorPrepare async.
   */
  it("creates stream locally without awaiting the runtime; mirrors prepare async", async () => {
    const { ipc, handlers } = createIpcHarness();
    const onAuthTokenChanged = vi.fn();
    playbackServer.createStream.mockReturnValue({
      id: "local-stream-1",
      url: "http://127.0.0.1:41111/playback/stream/local-stream-1",
      totalSize: 123,
    });
    // Runtime is wedged — mirrorPrepare never resolves. The IPC handler must
    // still return synchronously with the locally-allocated session.
    runtimeBridge.mirrorPrepare.mockReturnValue(new Promise(() => {}));

    console.info(
      "[playback-ipc-integration:stream-create] registering IPC with wedged runtime (mirrorPrepare never resolves)",
    );
    registerPlaybackIpc(ipc as any, {
      playbackServer: playbackServer as any,
      runtimeBridge: runtimeBridge as any,
      onAuthTokenChanged,
    });
    console.info(
      `[playback-ipc-integration:stream-create] registered channels=${JSON.stringify([...handlers.keys()])}`,
    );

    console.info(
      "[playback-ipc-integration:stream-create] invoking sf-playback-stream-create (must return without awaiting runtime)",
    );
    const created = await handlers.get("sf-playback-stream-create")?.(null, {
      initKey: "init-1",
      initSize: 12,
      chunks: [{ key: "c1", sizeBytes: 40 }],
      contentType: "video/mp4",
    });
    console.info(
      `[playback-ipc-integration:stream-create] returned session=${JSON.stringify(created)} prepareSession.called=${runtimeBridge.prepareSession.mock.calls.length} mirrorPrepare.called=${runtimeBridge.mirrorPrepare.mock.calls.length}`,
    );

    try {
      expect(runtimeBridge.prepareSession).not.toHaveBeenCalled();
      expect(playbackServer.createStream).toHaveBeenCalledTimes(1);
      expect(runtimeBridge.mirrorPrepare).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "local-stream-1",
          kind: "stream",
        })
      );
      expect(created).toEqual(
        expect.objectContaining({
          id: "local-stream-1",
        })
      );

      await handlers.get("sf-playback-set-token")?.(null, "abc");
      expect(playbackServer.setToken).toHaveBeenCalledWith("abc");
      expect(runtimeBridge.setBackendToken).toHaveBeenCalledWith("abc");
      expect(onAuthTokenChanged).toHaveBeenCalledWith("abc");

      const metrics = await handlers.get("sf-playback-signed-urls-stats")?.(null);
      expect(metrics).toEqual({ resetAt: "2026-01-01T00:00:00.000Z", requests: 7 });
      expect(runtimeBridge.getSignedUrlMetrics).toHaveBeenCalledTimes(1);

      await handlers.get("sf-playback-signed-urls-reset")?.(null);
      expect(playbackServer.resetSignedUrlMetrics).toHaveBeenCalledTimes(1);
      expect(runtimeBridge.resetSignedUrlMetrics).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpPlaybackIpcSnapshot("stream-create-fail", {
        handlers,
        playbackServer: playbackServer as any,
        runtimeBridge: runtimeBridge as any,
        extra: { created, onAuthTokenChangedCalls: onAuthTokenChanged.mock.calls },
      });
      throw err;
    }
  });

  it("creates HLS session locally without awaiting the runtime; mirrors prepare async", async () => {
    const { ipc, handlers } = createIpcHarness();
    runtimeBridge.mirrorPrepare.mockReturnValue(new Promise(() => {}));

    console.info(
      "[playback-ipc-integration:hls-create] registering IPC with wedged runtime",
    );
    registerPlaybackIpc(ipc as any, {
      playbackServer: playbackServer as any,
      runtimeBridge: runtimeBridge as any,
    });

    console.info(
      "[playback-ipc-integration:hls-create] invoking sf-playback-hls-create (vod, 1 video + 1 audio)",
    );
    const created = await handlers.get("sf-playback-hls-create")?.(null, {
      mode: "vod",
      videos: [{ id: "v1", quality: "1080p", bitrateKbps: 5000, width: 1920, height: 1080, track: {} }],
      audio: [{ id: "a1", language: "en", label: "English", isDefault: true, track: {} }],
    });
    console.info(
      `[playback-ipc-integration:hls-create] returned session=${JSON.stringify(created)} mirrorPrepare.callArgs=${JSON.stringify(runtimeBridge.mirrorPrepare.mock.calls)}`,
    );

    try {
      expect(runtimeBridge.prepareSession).not.toHaveBeenCalled();
      expect(playbackServer.createHlsSession).toHaveBeenCalledTimes(1);
      expect(runtimeBridge.mirrorPrepare).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "runtime-hls-1",
          kind: "hls",
          mode: "vod",
          videoTrackCount: 1,
          audioTrackCount: 1,
        })
      );
      expect(created).toEqual(expect.objectContaining({ id: "runtime-hls-1" }));
    } catch (err) {
      dumpPlaybackIpcSnapshot("hls-create-fail", {
        handlers,
        playbackServer: playbackServer as any,
        runtimeBridge: runtimeBridge as any,
        extra: { created },
      });
      throw err;
    }
  });

  it("falls back to playback server metrics when runtime metrics are unavailable", async () => {
    const { ipc, handlers } = createIpcHarness();
    runtimeBridge.getSignedUrlMetrics.mockResolvedValue(null);
    playbackServer.getSignedUrlMetrics.mockReturnValue({ resetAt: 111, requests: 3 });

    console.info(
      "[playback-ipc-integration:metrics-fallback] runtime metrics=null, expecting fallback to playbackServer metrics",
    );
    registerPlaybackIpc(ipc as any, {
      playbackServer: playbackServer as any,
      runtimeBridge: runtimeBridge as any,
    });

    const metrics = await handlers.get("sf-playback-signed-urls-stats")?.(null);
    console.info(
      `[playback-ipc-integration:metrics-fallback] returned metrics=${JSON.stringify(metrics)} playbackServer.getSignedUrlMetrics.called=${playbackServer.getSignedUrlMetrics.mock.calls.length}`,
    );
    try {
      expect(metrics).toEqual({ resetAt: 111, requests: 3 });
      expect(playbackServer.getSignedUrlMetrics).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpPlaybackIpcSnapshot("metrics-fallback-fail", {
        handlers,
        playbackServer: playbackServer as any,
        runtimeBridge: runtimeBridge as any,
        extra: { metrics },
      });
      throw err;
    }
  });

  /**
   * @test-id DESKTOP-IPC-PLAYBACK-LINK-001
   * @level integration
   * @why Issue #25: the renderer ABR reads the link estimate measured in main over upstream segment fetches.
   */
  it("sf-playback-link-estimate returns the playback server's effective link estimate", async () => {
    const { ipc, handlers } = createIpcHarness();
    playbackServer.getLinkEstimate.mockReturnValue({
      bps: 1_000_000,
      sampleCount: 3,
      updatedAtMs: 1_700_000_000_123,
      throttleKbps: 1_000,
    });
    // Partial doubles: the harness only implements the IpcMain/PlaybackServer/bridge members this module calls.
    const ipcMain = ipc as unknown as IpcMain;
    const server = playbackServer as unknown as PlaybackServer;
    const bridge = runtimeBridge as unknown as PlaybackRuntimeBridge;
    registerPlaybackIpc(ipcMain, { playbackServer: server, runtimeBridge: bridge });
    const estimate = await handlers.get("sf-playback-link-estimate")?.(null);
    console.info(
      `[playback-ipc-integration:link-estimate] channels=${JSON.stringify([...handlers.keys()])} estimate=${JSON.stringify(estimate)}`,
    );
    try {
      expect(estimate).toEqual({ bps: 1_000_000, sampleCount: 3, updatedAtMs: 1_700_000_000_123, throttleKbps: 1_000 });
      expect(playbackServer.getLinkEstimate).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpPlaybackIpcSnapshot("link-estimate-fail", {
        handlers,
        playbackServer,
        runtimeBridge,
        extra: { estimate },
      });
      throw err;
    }
  });
});
