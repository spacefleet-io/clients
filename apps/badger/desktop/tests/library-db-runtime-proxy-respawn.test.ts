/**
 * @test-id PROXY-RESPAWN-REOPEN-001
 * @bugfix
 * @regression-proof
 * @level unit
 * @why When the RuntimeGuardian respawned the runtime mid-session (manual
 *      restart from Settings, crash recovery, or wedged-process kill), the new
 *      runtime booted with `BadgerLibraryDb` at null. The desktop only fires
 *      `sf-library-db-open` during user-driven login, so subsequent
 *      `badger.db.call` commands hit `LIBRARY_DB_NOT_OPEN`.
 *      Round-10 evidence: source job
 *      `8ea5a59b-d561-4de1-8ff1-4c2f44789125` failed with
 *      `error_message=LIBRARY_DB_NOT_OPEN`.
 * @covers apps/badger/desktop/src/main/libraryDbRuntimeProxy.ts
 *         (`reopenAfterRuntimeRespawn`, cached open payload lifecycle)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks (must come before imports)
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock("../src/main/libraryDbAccessor", () => ({
  setLibraryDbAccessorToken: vi.fn(),
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
  REOPEN_RETRY_DELAYS_MS,
  reopenAfterRuntimeReady,
  reopenAfterRuntimeRespawn,
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

type FetchCall = { url: string; method: string; body?: unknown };

const createFetchMock = () => {
  const calls: FetchCall[] = [];
  let loginToken = "rt-default";
  let runtimeDown = false;
  let openFailuresLeft = 0;
  let openFailureCode: "internal_error" | "module_not_ready" = "module_not_ready";

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
    if (runtimeDown) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3020"), { code: "ECONNREFUSED" }),
      });
    }

    if (urlStr.includes("/runtime/session/login")) {
      return new Response(
        JSON.stringify({
          ok: true,
          token: loginToken,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          capabilities: { apps: ["badger"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (urlStr.includes("/modules/badger/commands")) {
      const command = (body as { command?: string })?.command ?? "";
      if (
        openFailuresLeft > 0 &&
        (command === "badger.db.open" || command === "badger.db.open_local")
      ) {
        openFailuresLeft -= 1;
        return new Response(
          JSON.stringify({
            requestId: "r",
            ok: false,
            result: null,
            error: { code: openFailureCode, message: `injected ${openFailureCode}`, retryable: true, details: {} },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (command === "badger.db.snapshot") {
        return new Response(
          JSON.stringify({
            requestId: "r",
            ok: true,
            result: { media: [], mediaDetails: [], playlists: [], version: 1 },
            error: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // badger.db.open / badger.db.close / badger.db.call etc.
      return new Response(
        JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("not found", { status: 404 });
  });

  return {
    mockFetch,
    calls,
    setLoginToken: (token: string) => {
      loginToken = token;
    },
    /** Simulate the runtime being down: every request rejects like undici does. */
    setRuntimeDown: (down: boolean) => {
      runtimeDown = down;
    },
    /** The next `n` open / open_local commands answer with an error envelope. */
    failNextOpens: (n: number, code: "internal_error" | "module_not_ready" = "module_not_ready") => {
      openFailuresLeft = n;
      openFailureCode = code;
    },
    getOpenLocalCommandCalls: () =>
      calls
        .filter((c) => c.url.includes("/modules/badger/commands"))
        .filter((c) => (c.body as { command?: string })?.command === "badger.db.open_local"),
    getCommandCalls: () => calls.filter((c) => c.url.includes("/modules/badger/commands")),
    getOpenCommandCalls: () =>
      calls
        .filter((c) => c.url.includes("/modules/badger/commands"))
        .filter((c) => (c.body as { command?: string })?.command === "badger.db.open"),
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// On assertion failure, dump the fetch-call ledger (esp. badger.db.open
// commands + their cached login payload) so a respawn-reopen failure is
// diagnosable offline. Body wrapped in try/catch so a dump failure can never
// mask the real assertion failure.
const dumpRespawnSnapshot = (label: string, fetchCtrl: ReturnType<typeof createFetchMock>) => {
  try {
    console.error(`=== [library-db-runtime-proxy-respawn:${label}] snapshot ===`);
    const openCalls = fetchCtrl.getOpenCommandCalls();
    console.error(`badger.db.open call count=${openCalls.length}`);
    console.error(`badger.db.open payloads=${JSON.stringify(openCalls.map((c) => (c.body as { payload?: unknown })?.payload), null, 2)}`);
    console.error(`all command calls=${JSON.stringify(fetchCtrl.getCommandCalls().map((c) => (c.body as { command?: string })?.command))}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("[@bugfix][@regression-proof] library DB runtime proxy: reopen after runtime respawn", () => {
  let handlers: Map<string, IpcHandler>;
  let fetchCtrl: ReturnType<typeof createFetchMock>;

  beforeEach(async () => {
    console.info("[library-db-runtime-proxy-respawn:setup] resetting proxy + registering ipc harness (no window provider)");
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    const harness = createIpcHarness();
    handlers = harness.handlers;
    fetchCtrl = createFetchMock();
    vi.stubGlobal("fetch", fetchCtrl.mockFetch);
    registerLibraryDbRuntimeProxy(harness.ipc as unknown as Parameters<typeof registerLibraryDbRuntimeProxy>[0]);
    console.info(`[library-db-runtime-proxy-respawn:setup] registered channels=${JSON.stringify([...handlers.keys()])}`);
  });

  const callHandler = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  };

  // Pre-fix repro: after `runtimeGuardian.emit("ready")` while the user is
  // logged in, calling `reopenAfterRuntimeRespawn()` re-fires `badger.db.open`
  // against the (newly respawned) runtime. Without the cached payload + this
  // helper, the runtime's `BadgerLibraryDbService.db` stays null and every
  // subsequent `badger.db.call` throws `LIBRARY_DB_NOT_OPEN`.
  it("reopen after runtime ready re-fires badger.db.open with cached login payload", async () => {
    fetchCtrl.setLoginToken("rt-1");
    console.info("[library-db-runtime-proxy-respawn:reopen-refires] step 1: user login via sf-library-db-open (backend-A)");
    // 1. User logs in — desktop fires `sf-library-db-open` once.
    await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key-AAAA" });

    const openCallsBeforeRespawn = fetchCtrl.getOpenCommandCalls();
    console.info(`[library-db-runtime-proxy-respawn:reopen-refires] after login open-count=${openCallsBeforeRespawn.length} (expected 1)`);
    try {
      expect(openCallsBeforeRespawn).toHaveLength(1);
      expect((openCallsBeforeRespawn[0].body as { payload?: { token?: string } })?.payload?.token).toBe(
        "backend-A"
      );
    } catch (err) {
      dumpRespawnSnapshot("reopen-refires-after-login", fetchCtrl);
      throw err;
    }

    // 2. Simulate runtime respawn → guardian emits `ready` → main wires this
    //    listener to `reopenAfterRuntimeRespawn`.
    console.info("[library-db-runtime-proxy-respawn:reopen-refires] step 2: simulate guardian ready -> reopenAfterRuntimeRespawn");
    const result = await reopenAfterRuntimeRespawn();
    console.info(`[library-db-runtime-proxy-respawn:reopen-refires] reopen result=${JSON.stringify(result)}`);
    if (!result.reopened) dumpRespawnSnapshot("reopen-refires-not-reopened", fetchCtrl);
    expect(result.reopened).toBe(true);

    // 3. A second `badger.db.open` must have been sent — same credentials.
    const openCallsAfterRespawn = fetchCtrl.getOpenCommandCalls();
    console.info(`[library-db-runtime-proxy-respawn:reopen-refires] after respawn open-count=${openCallsAfterRespawn.length} (expected 2)`);
    try {
      expect(openCallsAfterRespawn).toHaveLength(2);
      expect((openCallsAfterRespawn[1].body as { payload?: { token?: string; keyBase64?: string } })?.payload).toEqual({
        token: "backend-A",
        keyBase64: "key-AAAA",
      });
    } catch (err) {
      dumpRespawnSnapshot("reopen-refires-after-respawn", fetchCtrl);
      throw err;
    }
  });

  it("reopen is a no-op when no user has logged in yet (fresh app start, first guardian ready)", async () => {
    console.info("[library-db-runtime-proxy-respawn:noop-fresh-start] no login; calling reopenAfterRuntimeRespawn (expect no-op, no_cached_payload)");
    // Don't call sf-library-db-open — simulate the very first guardian
    // `ready` event firing before the renderer has driven login.
    const result = await reopenAfterRuntimeRespawn();
    const openCalls = fetchCtrl.getOpenCommandCalls();
    console.info(`[library-db-runtime-proxy-respawn:noop-fresh-start] result=${JSON.stringify(result)} open-count=${openCalls.length} (expected reopened=false, count=0)`);
    try {
      expect(result.reopened).toBe(false);
      expect(result.reason).toBe("no_cached_payload");
      expect(openCalls).toHaveLength(0);
    } catch (err) {
      dumpRespawnSnapshot("noop-fresh-start", fetchCtrl);
      throw err;
    }
  });

  it("reopen is a no-op after logout (clear-local-cache drops the cached payload)", async () => {
    fetchCtrl.setLoginToken("rt-1");
    console.info("[library-db-runtime-proxy-respawn:noop-after-logout] login backend-A, then clear-local-cache, then reopen (expect no-op)");
    await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key-AAAA" });

    // Logout flow clears the cache.
    await callHandler("sf-library-db-clear-local-cache");

    // A subsequent guardian `ready` must NOT attempt to re-open with the
    // stale, just-cleared credentials — that would resurrect a logged-out
    // session inside the runtime.
    const result = await reopenAfterRuntimeRespawn();
    const openCalls = fetchCtrl.getOpenCommandCalls();
    console.info(`[library-db-runtime-proxy-respawn:noop-after-logout] result=${JSON.stringify(result)} open-count=${openCalls.length} (expected reopened=false, count=1 — only the original login)`);
    try {
      expect(result.reopened).toBe(false);
      expect(result.reason).toBe("no_cached_payload");
      // Only the original login open should have been sent — no second call.
      expect(openCalls).toHaveLength(1);
    } catch (err) {
      dumpRespawnSnapshot("noop-after-logout", fetchCtrl);
      throw err;
    }
  });

  it("reopen survives multiple back-to-back guardian ready emissions", async () => {
    // The guardian can emit `ready` repeatedly (initial start, after a manual
    // restart, after a health-recovery transition). Each must re-fire
    // `badger.db.open` and stay consistent — no errors propagated out, no
    // duplicate state corruption.
    fetchCtrl.setLoginToken("rt-1");
    console.info("[library-db-runtime-proxy-respawn:back-to-back] login backend-A, then 3 back-to-back reopen calls (expect 1 login + 3 reopen = 4 opens)");
    await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key-AAAA" });

    const r1 = await reopenAfterRuntimeRespawn();
    const r2 = await reopenAfterRuntimeRespawn();
    const r3 = await reopenAfterRuntimeRespawn();

    const openCount = fetchCtrl.getOpenCommandCalls().length;
    console.info(`[library-db-runtime-proxy-respawn:back-to-back] r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} r3=${JSON.stringify(r3)} open-count=${openCount} (expected 4)`);
    try {
      expect(r1.reopened).toBe(true);
      expect(r2.reopened).toBe(true);
      expect(r3.reopened).toBe(true);
      // 1 (login) + 3 (respawns) = 4 total badger.db.open calls.
      expect(fetchCtrl.getOpenCommandCalls()).toHaveLength(4);
    } catch (err) {
      dumpRespawnSnapshot("back-to-back", fetchCtrl);
      throw err;
    }
  });

  // F5 (ultimate stress, issue #25, runs 2026-10-05T00-45-33 / 01-29-49): the app
  // was relaunched while the previous runtime was still dying; the renderer's
  // `sf-library-db-open-local` hit ECONNREFUSED at session login. The payload
  // was cached only AFTER a successful open, so when the guardian later brought
  // the runtime back, `reopenAfterRuntimeRespawn` answered `no_cached_payload`
  // and every `sf-library-db-call` stayed `LIBRARY_DB_NOT_READY` all session.
  describe("F5: library open that failed because the runtime was down", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a runtime-unreachable open-local is re-fired (as open_local) once the runtime is ready", async () => {
      fetchCtrl.setLoginToken("rt-1");
      fetchCtrl.setRuntimeDown(true);
      console.info("[library-db-runtime-proxy-respawn:f5-unreachable-open] step 1: open-local while runtime down (expect ECONNREFUSED)");
      await expect(
        callHandler("sf-library-db-open-local", { token: "backend-A", keyBase64: "key-AAAA" })
      ).rejects.toThrow();
      const notReady = await callHandler("sf-library-db-call", { method: "listMedia" });
      console.info(`[library-db-runtime-proxy-respawn:f5-unreachable-open] call while down -> ${JSON.stringify(notReady)}`);
      expect(notReady).toEqual({ __sfIpcError: "LIBRARY_DB_NOT_READY" });

      console.info("[library-db-runtime-proxy-respawn:f5-unreachable-open] step 2: runtime back, guardian ready -> reopenAfterRuntimeRespawn");
      fetchCtrl.setRuntimeDown(false);
      const result = await reopenAfterRuntimeRespawn();
      console.info(`[library-db-runtime-proxy-respawn:f5-unreachable-open] reopen result=${JSON.stringify(result)}`);
      try {
        expect(result).toEqual({ reopened: true });
        expect(fetchCtrl.getOpenLocalCommandCalls()).toHaveLength(1);
        expect(fetchCtrl.getOpenCommandCalls()).toHaveLength(0);
        const ready = await callHandler("sf-library-db-call", { method: "listMedia" });
        expect(ready).not.toEqual({ __sfIpcError: "LIBRARY_DB_NOT_READY" });
      } catch (err) {
        dumpRespawnSnapshot("f5-unreachable-open", fetchCtrl);
        throw err;
      }
    });

    it("remote open failed and its open-local fallback failed too: the re-open stays a remote open", async () => {
      fetchCtrl.setLoginToken("rt-1");
      fetchCtrl.setRuntimeDown(true);
      await expect(callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key-AAAA" })).rejects.toThrow();
      await expect(callHandler("sf-library-db-open-local", { token: "backend-A", keyBase64: "key-AAAA" })).rejects.toThrow();
      fetchCtrl.setRuntimeDown(false);
      const result = await reopenAfterRuntimeRespawn();
      console.info(`[library-db-runtime-proxy-respawn:f5-remote-intent] result=${JSON.stringify(result)} open=${fetchCtrl.getOpenCommandCalls().length} open_local=${fetchCtrl.getOpenLocalCommandCalls().length}`);
      expect(result).toEqual({ reopened: true });
      // Calls made while the runtime was down never reach the mock's command ledger
      // as commands (login fails first); only the re-open does.
      expect(fetchCtrl.getOpenCommandCalls()).toHaveLength(1);
      expect(fetchCtrl.getOpenLocalCommandCalls()).toHaveLength(0);
    });

    it("a library error that is not a connectivity failure is NOT retained for re-open", async () => {
      fetchCtrl.setLoginToken("rt-1");
      fetchCtrl.failNextOpens(1, "internal_error");
      await expect(
        callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "wrong-key" })
      ).rejects.toThrow("injected internal_error");
      const result = await reopenAfterRuntimeRespawn();
      console.info(`[library-db-runtime-proxy-respawn:f5-non-connectivity] result=${JSON.stringify(result)}`);
      expect(result).toEqual({ reopened: false, reason: "no_cached_payload" });
      expect(fetchCtrl.getOpenCommandCalls()).toHaveLength(1);
    });

    it("reopenAfterRuntimeReady retries with backoff when the first re-open fails", async () => {
      vi.useFakeTimers();
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key-AAAA" });
      // /runtime/health answered but the module is not accepting opens yet.
      fetchCtrl.failNextOpens(2, "module_not_ready");
      const pending = reopenAfterRuntimeReady();
      await vi.advanceTimersByTimeAsync(REOPEN_RETRY_DELAYS_MS[0]! + REOPEN_RETRY_DELAYS_MS[1]!);
      const result = await pending;
      console.info(`[library-db-runtime-proxy-respawn:f5-retry] result=${JSON.stringify(result)} opens=${fetchCtrl.getOpenCommandCalls().length}`);
      try {
        expect(result).toEqual({ reopened: true });
        // 1 login + 2 failed re-opens + 1 successful re-open.
        expect(fetchCtrl.getOpenCommandCalls()).toHaveLength(4);
      } catch (err) {
        dumpRespawnSnapshot("f5-retry", fetchCtrl);
        throw err;
      }
    });

    it("logout while a re-open is backing off supersedes it (no resurrected session)", async () => {
      vi.useFakeTimers();
      fetchCtrl.setLoginToken("rt-1");
      await callHandler("sf-library-db-open", { token: "backend-A", keyBase64: "key-AAAA" });
      fetchCtrl.failNextOpens(1, "module_not_ready");
      const pending = reopenAfterRuntimeReady();
      await vi.advanceTimersByTimeAsync(10);
      await callHandler("sf-library-db-clear-local-cache");
      await vi.advanceTimersByTimeAsync(REOPEN_RETRY_DELAYS_MS[0]!);
      const result = await pending;
      console.info(`[library-db-runtime-proxy-respawn:f5-logout-supersedes] result=${JSON.stringify(result)}`);
      expect(result.reopened).toBe(false);
      // login open + the one failed re-open; nothing after logout.
      expect(fetchCtrl.getOpenCommandCalls()).toHaveLength(2);
    });
  });
});
