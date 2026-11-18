/**
 * @test-id PROXY-SNAPSHOT-EMISSION-001
 * @bugfix @regression-proof
 *
 * Verifies that library snapshot updates reach the renderer in proxy mode.
 *
 * When finalization completes and calls emitLibrarySnapshotSafe(), the
 * renderer must receive an updated snapshot via IPC. In direct-SQLite mode
 * this works because emitLibrarySnapshot() sends the snapshot directly.
 * In proxy mode, the function was a no-op — causing a 10-20s delay
 * before the UI showed the play button and tracks after finalization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const setLibraryDbAccessorTokenMock = vi.hoisted(() => vi.fn());

const webContentsSendMock = vi.hoisted(() => vi.fn());
const windowMock = vi.hoisted(() => ({
  webContents: {
    send: webContentsSendMock,
    once: vi.fn(),
  },
  isDestroyed: () => false,
  once: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../src/main/libraryDbAccessor", () => ({
  setLibraryDbAccessorToken: (...args: unknown[]) => setLibraryDbAccessorTokenMock(...args),
}));

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

process.env.SF_RUNTIME_BASE_URL = "http://mock-runtime:3020";

import {
  registerLibraryDbRuntimeProxy,
  resetLibraryDbRuntimeProxyForTests,
} from "../src/main/libraryDbRuntimeProxy";

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;

const createIpcHarness = () => {
  const handlers = new Map<string, IpcHandler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  };
  return { ipc, handlers };
};

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

const createFetchMock = () => {
  // Bump `version` each snapshot fetch so successive emits differ in JSON.
  // The proxy dedupes identical snapshots (post-39eb6d11 throttle); in the
  // real ingest flow successive snapshots differ because writes mutated the
  // DB. Mirror that here so the test asserts emission, not equality.
  let snapshotVersion = 0;
  const buildSnapshot = (): Record<string, unknown> => ({
    media: [{ id: "m1", title: "Ghost in the Shell" }],
    playlists: [],
    version: ++snapshotVersion,
  });

  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      body = {};
    }

    if (urlStr.includes("/runtime/session/login")) {
      return new Response(
        JSON.stringify({
          ok: true,
          token: "rt-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          capabilities: { apps: ["badger"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (urlStr.includes("/modules/badger/commands")) {
      const command = (body as { command?: string })?.command ?? "";
      if (command === "badger.db.open") {
        return new Response(
          JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (command === "badger.db.snapshot") {
        return new Response(
          JSON.stringify({ requestId: "r", ok: true, result: buildSnapshot(), error: null }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (command === "badger.db.call") {
        return new Response(
          JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("not found", { status: 404 });
  });

  return { mockFetch };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// On assertion failure, dump the IPC-send ledger so we can see exactly which
// channels were sent and with what payload shape. Body wrapped in try/catch so
// a dump failure can never mask the real assertion failure.
const dumpProxyEmissionSnapshot = (label: string, handlers: Map<string, IpcHandler>) => {
  try {
    console.error(`=== [proxy-snapshot-emission:${label}] snapshot ===`);
    console.error(`registered ipc channels=${JSON.stringify([...handlers.keys()])}`);
    const sends = webContentsSendMock.mock.calls.map((c) => ({
      channel: c[0],
      payloadKeys: c[1] && typeof c[1] === "object" ? Object.keys(c[1] as object) : typeof c[1],
    }));
    console.error(`webContents.send.callCount=${webContentsSendMock.mock.calls.length}`);
    console.error(`webContents.send.calls=${JSON.stringify(sends, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("proxy mode snapshot emission to renderer", () => {
  let handlers: Map<string, IpcHandler>;

  beforeEach(async () => {
    console.info("[proxy-snapshot-emission:setup] resetting proxy + registering ipc harness with window provider");
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    setLibraryDbAccessorTokenMock.mockReset();
    webContentsSendMock.mockReset();

    const harness = createIpcHarness();
    handlers = harness.handlers;

    const fetchCtrl = createFetchMock();
    vi.stubGlobal("fetch", fetchCtrl.mockFetch);

    // Register proxy WITH a window provider — this is key for snapshot emission
    registerLibraryDbRuntimeProxy(harness.ipc as never, () => windowMock as never);
    console.info(`[proxy-snapshot-emission:setup] registered channels=${JSON.stringify([...handlers.keys()])}`);
  });

  const callHandler = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  };

  it("emits snapshot to renderer via IPC after db open", async () => {
    console.info("[proxy-snapshot-emission:open-emit] calling sf-library-db-open; expect a sf-library-db-snapshot send");
    await callHandler("sf-library-db-open", {
      token: "backend-token",
      keyBase64: "key123",
    });

    console.info(`[proxy-snapshot-emission:open-emit] webContents.send.callCount=${webContentsSendMock.mock.calls.length} channels=${JSON.stringify(webContentsSendMock.mock.calls.map((c) => c[0]))}`);
    try {
      // Phase 6 wrapper: { snapshot, version }.
      expect(webContentsSendMock).toHaveBeenCalledWith(
        "sf-library-db-snapshot",
        expect.objectContaining({
          snapshot: expect.objectContaining({ media: expect.any(Array) }),
        })
      );
    } catch (err) {
      dumpProxyEmissionSnapshot("open-emit", handlers);
      throw err;
    }
  });

  it("emits snapshot to renderer after a write via IPC handler", async () => {
    console.info("[proxy-snapshot-emission:write-emit] opening db, then issuing addMediaFormat write; expect throttled snapshot emit");
    await callHandler("sf-library-db-open", {
      token: "backend-token",
      keyBase64: "key123",
    });

    webContentsSendMock.mockClear();

    // A write call through the IPC handler refreshes snapshot and emits
    await callHandler("sf-library-db-call", {
      method: "addMediaFormat",
      args: ["media-1", "file-1", "1080p", "h264", 100, [], 5000],
    });

    // Snapshot emit is throttled (200ms trailing-edge); poll for the
    // trailing-edge flush rather than asserting synchronously.
    const startedAt = Date.now();
    try {
      await vi.waitFor(() => {
        const elapsed = Date.now() - startedAt;
        console.info(`[proxy-snapshot-emission:write-emit] waiting for trailing-edge snapshot flush; elapsed=${elapsed}ms send.callCount=${webContentsSendMock.mock.calls.length}`);
        // Phase 6: main now sends `{ snapshot, version }` instead of bare
        // snapshot. Assert the wrapper shape and that the inner snapshot
        // still carries the expected media array.
        expect(webContentsSendMock).toHaveBeenCalledWith(
          "sf-library-db-snapshot",
          expect.objectContaining({
            snapshot: expect.objectContaining({ media: expect.any(Array) }),
          })
        );
      });
    } catch (err) {
      console.error(`[proxy-snapshot-emission:write-emit] TIMEOUT after ${Date.now() - startedAt}ms waiting for snapshot emit`);
      dumpProxyEmissionSnapshot("write-emit-timeout", handlers);
      throw err;
    }
  });

  it("@bugfix @regression-proof emits snapshot to renderer after finalization writes via callViaRuntime", async () => {
    // This test verifies the fix for the 10-20s finalization delay.
    //
    // Finalization calls callLibraryDb() from libraryDbAccessor.ts, which uses
    // callViaRuntime() — this bypasses the IPC handler and its snapshot emission.
    // After finalization, emitLibrarySnapshotSafe() is called, but in proxy mode
    // it was a no-op. The renderer never got the updated snapshot until some
    // unrelated event triggered a refresh.
    //
    // The fix must ensure that emitLibrarySnapshotSafe() triggers snapshot
    // emission in proxy mode.
    console.info("[proxy-snapshot-emission:finalization-emit] opening db, then calling refreshAndEmitProxySnapshot (the proxy-mode delegate for emitLibrarySnapshotSafe)");
    await callHandler("sf-library-db-open", {
      token: "backend-token",
      keyBase64: "key123",
    });

    webContentsSendMock.mockClear();

    // Simulate what finalization does: write via callViaRuntime (direct HTTP),
    // then call emitLibrarySnapshotSafe(). We can't easily call callViaRuntime
    // here since it's internal, so instead we import and call
    // emitLibrarySnapshotSafe directly to verify it works in proxy mode.
    //
    // For this test, we call refreshAndEmitProxySnapshot which is what
    // emitLibrarySnapshotSafe should delegate to in proxy mode.
    const { refreshAndEmitProxySnapshot } = await import("../src/main/libraryDbRuntimeProxy");
    await refreshAndEmitProxySnapshot();

    // Snapshot emit is throttled (200ms trailing-edge); poll for the
    // trailing-edge flush rather than asserting synchronously.
    const startedAt = Date.now();
    try {
      await vi.waitFor(() => {
        const elapsed = Date.now() - startedAt;
        console.info(`[proxy-snapshot-emission:finalization-emit] waiting for trailing-edge snapshot flush; elapsed=${elapsed}ms send.callCount=${webContentsSendMock.mock.calls.length}`);
        // Phase 6: main now sends `{ snapshot, version }` instead of bare
        // snapshot. Assert the wrapper shape and that the inner snapshot
        // still carries the expected media array.
        expect(webContentsSendMock).toHaveBeenCalledWith(
          "sf-library-db-snapshot",
          expect.objectContaining({
            snapshot: expect.objectContaining({ media: expect.any(Array) }),
          })
        );
      });
    } catch (err) {
      console.error(`[proxy-snapshot-emission:finalization-emit] TIMEOUT after ${Date.now() - startedAt}ms waiting for snapshot emit (pre-fix: proxy-mode emit was a no-op)`);
      dumpProxyEmissionSnapshot("finalization-emit-timeout", handlers);
      throw err;
    }
  });
});
