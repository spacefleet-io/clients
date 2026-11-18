/**
 * @test-id PROXY-TOKEN-LIFECYCLE-001
 * @level unit
 * @why Runtime proxy cached stale tokens across login cycles (2026-03-29 cascade bug #4).
 *      No test verified the proxy's token caching, invalidation on backend token change,
 *      401 retry behavior, or snapshot cache lifecycle.
 * @covers apps/badger/desktop/src/main/libraryDbRuntimeProxy.ts: token exchange, cache invalidation,
 *         snapshot caching, clear-local-cache cleanup
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks (must come before imports)
// ---------------------------------------------------------------------------

const setLibraryDbAccessorTokenMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
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
// Test setup
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
// Fetch mock infrastructure
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string; body?: unknown; headers?: Record<string, string> };

const createFetchMock = () => {
  const calls: FetchCall[] = [];
  let loginResponseToken = "rt-default";
  const commandResponses: Array<{ ok: boolean; status?: number; result?: unknown; error?: unknown }> = [];
  let snapshotResponse: Record<string, unknown> = {
    media: [{ id: "m1", title: "Test Media" }],
    mediaDetails: [{ id: "m1", title: "Test Media", type: "movie" }],
    playlists: [],
    version: 1,
  };

  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url: urlStr, method, body });

    // Login endpoint
    if (urlStr.includes("/runtime/session/login")) {
      return new Response(JSON.stringify({
        ok: true,
        token: loginResponseToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        capabilities: { apps: ["badger"] },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Command endpoint
    if (urlStr.includes("/modules/badger/commands")) {
      // Check for queued custom responses
      if (commandResponses.length > 0) {
        const custom = commandResponses.shift()!;
        const status = custom.status ?? (custom.ok ? 200 : 500);
        return new Response(
          JSON.stringify({ requestId: "r", ok: custom.ok, result: custom.result, error: custom.ok ? null : custom.error }),
          { status, headers: { "content-type": "application/json" } }
        );
      }

      // Default: check command type
      const command = (body as { command?: string })?.command ?? "";
      if (command === "badger.db.open") {
        return new Response(JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (command === "badger.db.open_local") {
        // Offline open: the runtime opens the on-disk DB with no remote pull and
        // never reaches the backend, so this succeeds even when the backend is
        // unreachable. Mock returns ok like the runtime would.
        return new Response(JSON.stringify({ requestId: "r", ok: true, result: { version: 0, mediaCount: 0 }, error: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (command === "badger.db.snapshot") {
        return new Response(JSON.stringify({ requestId: "r", ok: true, result: snapshotResponse, error: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (command === "badger.db.status") {
        return new Response(
          JSON.stringify({ requestId: "r", ok: true, result: { open: true, version: snapshotResponse.version ?? 1, datasetStatus: { core: true, metadata: false, playback: false } }, error: null }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (command === "badger.db.close") {
        return new Response(JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (command === "badger.db.call") {
        // Like the runtime, a write bumps the library version (#25: the proxy
        // only refreshes its cache when the version moved).
        snapshotResponse = { ...snapshotResponse, version: Number(snapshotResponse.version ?? 1) + 1 };
        return new Response(JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Unknown command — still ok
      return new Response(JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  });

  return {
    mockFetch,
    calls,
    setLoginToken: (token: string) => { loginResponseToken = token; },
    setSnapshot: (snapshot: Record<string, unknown>) => { snapshotResponse = snapshot; },
    queueCommandResponse: (resp: { ok: boolean; status?: number; result?: unknown; error?: unknown }) => {
      commandResponses.push(resp);
    },
    getLoginCalls: () => calls.filter((c) => c.url.includes("/runtime/session/login")),
    getCommandCalls: () => calls.filter((c) => c.url.includes("/modules/badger/commands")),
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Diagnostic-logging helpers (per the tests-log-generously convention).
// Suite id: proxy-token. Phase markers: `[proxy-token:<phase>]`.
// dumpProxyTokenSnapshot prints fetch traffic + the IPC handler map so a
// failed assertion is debuggable without a re-run.
// ---------------------------------------------------------------------------

const dumpProxyTokenSnapshot = (
  label: string,
  ctx: {
    fetchCtrl?: ReturnType<typeof createFetchMock> | null;
    handlers?: Map<string, IpcHandler>;
    extra?: Record<string, unknown>;
  } = {},
) => {
  try {
     
    console.log(
      `[proxy-token:dump] ${label}`,
      JSON.stringify(
        {
          loginCalls: ctx.fetchCtrl?.getLoginCalls().length,
          commandCalls: ctx.fetchCtrl?.getCommandCalls().length,
          commandCallCommands: ctx.fetchCtrl
            ?.getCommandCalls()
            .map((c) => (c.body as { command?: string })?.command),
          allCallUrls: ctx.fetchCtrl?.calls.map((c) => c.url),
          handlersRegistered: ctx.handlers ? Array.from(ctx.handlers.keys()) : null,
          setLibraryDbAccessorTokenCalls:
            setLibraryDbAccessorTokenMock.mock.calls.length,
          ...(ctx.extra ?? {}),
        },
        null,
        2,
      ),
    );
  } catch (dumpError) {
     
    console.log(`[proxy-token:dump-error] ${label}`, dumpError);
  }
};

describe("library DB runtime proxy token lifecycle", () => {
  let handlers: Map<string, IpcHandler>;
  let fetchCtrl: ReturnType<typeof createFetchMock>;

  beforeEach(async () => {
     
    console.log("[proxy-token:beforeEach] resetting proxy + mocks");
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    setLibraryDbAccessorTokenMock.mockReset();
    const harness = createIpcHarness();
    handlers = harness.handlers;
    fetchCtrl = createFetchMock();
    vi.stubGlobal("fetch", fetchCtrl.mockFetch);
    registerLibraryDbRuntimeProxy(harness.ipc as any);
     
    console.log(
      `[proxy-token:beforeEach:registered] handlers=${handlers.size}`,
    );
  });

  const callHandler = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  };

  // -------------------------------------------------------------------------
  // Suite D: Proxy token lifecycle
  // -------------------------------------------------------------------------

  it("login with token-A caches runtime token, reuses on subsequent calls", async () => {
    try {
       
      console.log("[proxy-token:login-cache] opening DB with backend-A, then getDatasetStatus");
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key123" });

      // Call getDatasetStatus which goes to runtime (not cached)
      await callHandler("sf-library-db-call", { method: "getDatasetStatus" });

      // Should have exactly 1 login call (not 2)
      const loginCalls = fetchCtrl.getLoginCalls();
       
      console.log(
        `[proxy-token:login-cache:asserting] loginCalls=${loginCalls.length}`,
      );
      expect(loginCalls).toHaveLength(1);
      expect((loginCalls[0].body as { backendToken?: string })?.backendToken).toBe("backend-A");
    } catch (assertionError) {
      dumpProxyTokenSnapshot("login-cache:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });

  it("token-A → clear cache → token-B exchanges for new runtime token", async () => {
    try {
       
      console.log("[proxy-token:cache-cycle] backend-A → clear → backend-B");
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key123" });

      // Clear cache (simulates logout)
      await callHandler("sf-library-db-clear-local-cache");

      // Login with token-B
      fetchCtrl.setLoginToken("rt-2");
      await callHandler("sf-library-db-open", { token: "backend-B", keyBase64: "key456" });

      // Should have 2 login calls with different backend tokens
      const loginCalls = fetchCtrl.getLoginCalls();
       
      console.log(
        `[proxy-token:cache-cycle:asserting] loginCalls=${loginCalls.length}`,
      );
      expect(loginCalls).toHaveLength(2);
      expect((loginCalls[0].body as { backendToken?: string })?.backendToken).toBe("backend-A");
      expect((loginCalls[1].body as { backendToken?: string })?.backendToken).toBe("backend-B");
    } catch (assertionError) {
      dumpProxyTokenSnapshot("cache-cycle:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });

  it("401 from runtime triggers automatic re-login and retry", async () => {
    try {
       
      console.log("[proxy-token:401-retry] queuing 401 then expecting auto-retry");
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key123" });

      // Queue a 401 response for the next command — the retry should re-login
      // and succeed with the default response
      fetchCtrl.queueCommandResponse({ ok: false, status: 401, error: { code: "unauthorized", message: "unauthorized", retryable: false, details: {} } });
      fetchCtrl.setLoginToken("rt-fresh");

      // The call should NOT throw — the 401 triggers automatic re-login + retry
      const result = await callHandler("sf-library-db-call", { method: "getDatasetStatus" });
      expect(result).toBeDefined();

      // Should have 2 login calls: initial open + automatic re-login after 401
      const loginCalls = fetchCtrl.getLoginCalls();
       
      console.log(
        `[proxy-token:401-retry:asserting] loginCalls=${loginCalls.length}`,
      );
      expect(loginCalls).toHaveLength(2);
      expect((loginCalls[1].body as { backendToken?: string })?.backendToken).toBe("backend-A");
    } catch (assertionError) {
      dumpProxyTokenSnapshot("401-retry:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });

  // -------------------------------------------------------------------------
  // Suite E-pre: close-via-call regression
  // -------------------------------------------------------------------------

  it("[@bugfix][@regression-proof] close via db.call is ignored — proxy stays open", async () => {
    try {
      // OnboardingKey.tsx opens a temporary DB instance to test the key, then
      // calls testDb.close(). The proxy must ignore this close because it manages
      // a single global DB lifecycle — propagating close would leave dbOpen=false
      // while the library context expects the DB to be open.
       
      console.log("[proxy-token:close-via-call-ignored] opening then issuing call:close");
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key123" });

      // Verify cache exists after open
      const hasCacheBefore = await callHandler("sf-library-db-has-local-cache");
      expect(hasCacheBefore).toBe(true);

      // Close via call path (what testDb.close() does) — should be ignored
       
      console.log("[proxy-token:close-via-call-ignored] firing the would-be close");
      await callHandler("sf-library-db-call", { method: "close" });

      // Cache should still exist (close was ignored)
      const hasCacheAfter = await callHandler("sf-library-db-has-local-cache");
      expect(hasCacheAfter).toBe(true);

      // Subsequent calls should still work (DB is still open)
      const media = await callHandler("sf-library-db-call", { method: "listMedia" });
      expect(Array.isArray(media)).toBe(true);

      // No badger.db.close should have been sent to runtime
      const closeCalls = fetchCtrl.getCommandCalls().filter(
        (c) => (c.body as { command?: string })?.command === "badger.db.close"
      );
       
      console.log(
        `[proxy-token:close-via-call-ignored:asserting] closeCalls=${closeCalls.length}`,
      );
      expect(closeCalls).toHaveLength(0);
    } catch (assertionError) {
      dumpProxyTokenSnapshot("close-via-call-ignored:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });

  // -------------------------------------------------------------------------
  // Suite E: Snapshot caching
  // -------------------------------------------------------------------------

  it("read methods served from snapshot cache without runtime call", async () => {
    try {
       
      console.log("[proxy-token:read-from-cache] priming snapshot then issuing reads");
      fetchCtrl.setLoginToken("rt-1");
      fetchCtrl.setSnapshot({
        media: [{ id: "m1", title: "Cached Movie" }],
        mediaDetails: [{ id: "m1", title: "Cached Movie", type: "movie" }],
        playlists: [{ id: "p1", name: "My List" }],
        version: 5,
      });

      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key123" });

      const commandCallsBefore = fetchCtrl.getCommandCalls().length;
       
      console.log(
        `[proxy-token:read-from-cache] commandCallsBefore=${commandCallsBefore}`,
      );

      // These reads should all be served from cache
      const media = await callHandler("sf-library-db-call", { method: "listMedia" });
      const playlists = await callHandler("sf-library-db-call", { method: "listPlaylists" });
      const hasMedia = await callHandler("sf-library-db-call", { method: "hasAnyMedia" });
      const version = await callHandler("sf-library-db-call", { method: "getVersion" });

      expect(media).toEqual([{ id: "m1", title: "Cached Movie" }]);
      expect(playlists).toEqual([{ id: "p1", name: "My List" }]);
      expect(hasMedia).toBe(true);
      expect(version).toBe(5);

      // No additional command calls should have been made (all served from cache)
      const commandCallsAfter = fetchCtrl.getCommandCalls().length;
       
      console.log(
        `[proxy-token:read-from-cache:asserting] commandCallsAfter=${commandCallsAfter}`,
      );
      expect(commandCallsAfter).toBe(commandCallsBefore);
    } catch (assertionError) {
      dumpProxyTokenSnapshot("read-from-cache:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });

  it("write invalidates cache and fetches fresh snapshot", async () => {
    try {
       
      console.log("[proxy-token:write-invalidates] opening then issuing deleteMedia write");
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key123" });

      const commandCallsBefore = fetchCtrl.getCommandCalls().length;

      // Write call goes through runtime
      await callHandler("sf-library-db-call", { method: "deleteMedia", args: ["m1"] });

      // badger.db.call (the write), badger.db.status (version moved) and —
      // with no library frame delivering it — one badger.db.snapshot refresh.
      const newCalls = fetchCtrl.getCommandCalls().slice(commandCallsBefore);
      const commands = newCalls.map((c) => (c.body as { command?: string })?.command);
       
      console.log(
        `[proxy-token:write-invalidates:asserting] newCommands=${JSON.stringify(commands)}`,
      );
      expect(commands).toContain("badger.db.call");
      expect(commands).toContain("badger.db.snapshot");
    } catch (assertionError) {
      dumpProxyTokenSnapshot("write-invalidates:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });

  it("clear-local-cache clears snapshot and closes DB", async () => {
    try {
       
      console.log("[proxy-token:clear-cache] opening then clearing");
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key123" });

      // Verify cache exists
      const hasCacheBefore = await callHandler("sf-library-db-has-local-cache");
      expect(hasCacheBefore).toBe(true);

      // Clear
      await callHandler("sf-library-db-clear-local-cache");

      // Cache should be gone
      const hasCacheAfter = await callHandler("sf-library-db-has-local-cache");
       
      console.log(
        `[proxy-token:clear-cache:asserting] hasCacheAfter=${hasCacheAfter}`,
      );
      expect(hasCacheAfter).toBe(false);

      // DB calls should fail with not-ready
      const result = await callHandler("sf-library-db-call", { method: "listMedia" });
      expect(result).toEqual({ __sfIpcError: "LIBRARY_DB_NOT_READY" });
    } catch (assertionError) {
      dumpProxyTokenSnapshot("clear-cache:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });

  // -------------------------------------------------------------------------
  // Suite F: Offline local open (backend-unreachable mode)
  //
  // Reported 2026-06-04: "I just started the app without the dev stack running
  // and just have a 'library unavailable', not my offline one." Root cause —
  // in runtime-proxy mode `sf-library-db-open-local` delegated to the REMOTE
  // `badger.db.open`, which needs the backend, so the offline fallback 400'd
  // and the renderer showed "Library unavailable" instead of offline mode.
  // Fix routes open-local to the dedicated local-only `badger.db.open_local`
  // command (no remote pull) and hydrates the renderer snapshot from it.
  // -------------------------------------------------------------------------

  it("[@bugfix][@regression-proof] open-local sends badger.db.open_local, never the remote badger.db.open", async () => {
    try {

      console.log("[proxy-token:offline-open] firing sf-library-db-open-local");
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open-local", { token: "backend-A", keyBase64: "key123" });

      const commands = fetchCtrl
        .getCommandCalls()
        .map((c) => (c.body as { command?: string })?.command);

      console.log(
        `[proxy-token:offline-open:asserting] commands=${JSON.stringify(commands)}`,
      );
      // The dedicated local-only command MUST be used...
      expect(commands).toContain("badger.db.open_local");
      // ...and the remote open (which needs the backend) MUST NOT. Pre-fix this
      // was `badger.db.open`, which 400'd offline → "Library unavailable".
      expect(commands).not.toContain("badger.db.open");
    } catch (assertionError) {
      dumpProxyTokenSnapshot("offline-open:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });

  it("[@bugfix][@regression-proof] open-local hydrates the snapshot cache so the offline library populates", async () => {
    try {

      console.log("[proxy-token:offline-open-hydrate] priming snapshot then open-local");
      fetchCtrl.setLoginToken("rt-1");
      fetchCtrl.setSnapshot({
        media: [{ id: "m1", title: "Offline Movie" }],
        mediaDetails: [{ id: "m1", title: "Offline Movie", type: "movie" }],
        playlists: [],
        version: 3,
      });

      await callHandler("sf-library-db-open-local", { token: "backend-A", keyBase64: "key123" });

      // Pre-fix open-local returned immediately after the (remote) open without
      // fetching a snapshot → cache stayed empty. The fix hydrates it.
      const hasCache = await callHandler("sf-library-db-has-local-cache");

      console.log(`[proxy-token:offline-open-hydrate:asserting] hasCache=${hasCache}`);
      expect(hasCache).toBe(true);

      // Reads are served from the hydrated snapshot — the offline library shows
      // the downloaded title without any further runtime/backend round trip.
      const media = await callHandler("sf-library-db-call", { method: "listMedia" });
      expect(media).toEqual([{ id: "m1", title: "Offline Movie" }]);
    } catch (assertionError) {
      dumpProxyTokenSnapshot("offline-open-hydrate:fail", { fetchCtrl, handlers });
      throw assertionError;
    }
  });
});
