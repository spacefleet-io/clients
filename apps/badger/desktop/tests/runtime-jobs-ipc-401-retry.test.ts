/**
 * @bugfix the-app-restart-fixed-soft-pixel — desktop main process holds a
 *         stateful runtime session token (created in `runtimeJobsIpc.ts`
 *         via `createRuntimeSession`) for the lifetime of the desktop
 *         process. After the runtime's 60-minute TTL (default
 *         `RUNTIME_TOKEN_TTL_MS`), the cached token is stale; the only path
 *         that surfaced it was the SSE EventSource (which 401s), producing
 *         the user-visible "Ingest unavailable — runtime engine v2 not
 *         ready" banner. The HTTP `/runtime/jobs/v2/*` snapshots returned
 *         200 (no auth check pre-fix) so the renderer never realised the
 *         token had expired.
 *
 *         Server side: commit 754993df gates the v2 HTTP routes with
 *         `requireToken`. This commit's client-side half adds an
 *         invalidate-and-retry-once on 401 in the IPC `httpFetch`, mirroring
 *         the proven pattern in `packages/runtime-client/src/command.ts`
 *         line ~65. A spurious 401 on a stale token now produces ONE
 *         transparent re-login and ONE successful retry; the renderer never
 *         observes the failure.
 *
 * @regression-proof — three guarantees:
 *   1. A `sf-runtime-jobs-list` IPC call that hits a 401 on its first fetch
 *      MUST silently re-login and re-fetch; the renderer-visible result is
 *      the 200 body, not a runtime_jobs_unreachable envelope.
 *   2. Exactly ONE retry. A second consecutive 401 propagates as a
 *      `runtime_jobs_http_401` error envelope — no infinite-retry loops.
 *   3. The session client's `invalidate()` is called exactly once before
 *      the retry — without this, the second login would be deduped via
 *      `loginInFlight` and return the same stale token forever.
 *
 *      Together they catch the original bug AND the two most plausible
 *      regressions a future refactor might introduce.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede the import of the module under test.
// `registerRuntimeJobsIpc` imports `ipcMain` directly from `electron`, so the
// harness is the mock's call log itself (no DI hook to pass in).
// ---------------------------------------------------------------------------

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;

const ipcHandleMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcHandleMock,
  },
}));

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const harvestHandlers = (): Map<string, IpcHandler> => {
  const handlers = new Map<string, IpcHandler>();
  for (const call of ipcHandleMock.mock.calls) {
    const [channel, handler] = call as [string, IpcHandler];
    handlers.set(channel, handler);
  }
  return handlers;
};

// ---------------------------------------------------------------------------
// Fetch mock — controls login + list responses; counts each call.
// ---------------------------------------------------------------------------

type RecordedCall = {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
};

type ResponseDirective =
  | { kind: "200_list"; jobs?: unknown[] }
  | { kind: "401_list" }
  | { kind: "200_login"; token: string; expiresInMs?: number }
  | { kind: "500_list" };

const createFetchMock = () => {
  const calls: RecordedCall[] = [];
  const listResponses: ResponseDirective[] = [];
  let loginToken = "rt-fresh-token";

  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    const authorization = headers.authorization ?? null;
    calls.push({ url: urlStr, method, authorization, body });

    if (urlStr.includes("/runtime/session/login")) {
      return new Response(
        JSON.stringify({
          ok: true,
          token: loginToken,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          capabilities: { apps: ["badger"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (urlStr.includes("/runtime/jobs/v2/list")) {
      const directive = listResponses.shift();
      if (!directive) {
        return new Response(
          JSON.stringify({ jobs: [], maxEventId: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (directive.kind === "200_list") {
        return new Response(
          JSON.stringify({ jobs: directive.jobs ?? [], maxEventId: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (directive.kind === "401_list") {
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      if (directive.kind === "500_list") {
        return new Response(
          JSON.stringify({ error: "internal", message: "boom" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    }

    return new Response(JSON.stringify({ error: "not_mocked", url: urlStr }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });

  return {
    mockFetch,
    calls,
    setLoginToken: (token: string) => {
      loginToken = token;
    },
    queueListResponse: (directive: ResponseDirective) => listResponses.push(directive),
    getLoginCalls: () => calls.filter((c) => c.url.includes("/runtime/session/login")),
    getListCalls: () => calls.filter((c) => c.url.includes("/runtime/jobs/v2/list")),
  };
};

// ---------------------------------------------------------------------------
// Diagnostic dump — emitted on test failure (per "tests log generously").
// ---------------------------------------------------------------------------

const dumpRetrySnapshot = (
  label: string,
  ctx: {
    fetchCtrl?: ReturnType<typeof createFetchMock> | null;
    handlers?: Map<string, IpcHandler>;
    handlerResult?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-jobs-ipc-401-retry:${label}] snapshot ===`);
    if (ctx.fetchCtrl) {
      console.error(
        `fetch calls (${ctx.fetchCtrl.calls.length}):\n${JSON.stringify(
          ctx.fetchCtrl.calls.map((c) => ({
            url: c.url,
            method: c.method,
            authorizationPresent: !!c.authorization,
            authorizationPrefix: c.authorization?.slice(0, 12) ?? null,
          })),
          null,
          2,
        )}`,
      );
      console.error(
        `loginCalls=${ctx.fetchCtrl.getLoginCalls().length} listCalls=${ctx.fetchCtrl.getListCalls().length}`,
      );
    }
    if (ctx.handlers) {
      console.error(`registered handlers: ${Array.from(ctx.handlers.keys()).join(", ")}`);
    }
    if (ctx.handlerResult !== undefined) {
      console.error(`handler result:\n${JSON.stringify(ctx.handlerResult, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Module under test — imported AFTER vi.mock so the electron stub is in place.
// ---------------------------------------------------------------------------

import { registerRuntimeJobsIpc, setRuntimeJobsBackendToken } from "../src/main/runtimeJobsIpc";

describe("[@bugfix][@regression-proof] runtime-jobs IPC httpFetch invalidate-and-retry-on-401", () => {
  let handlers: Map<string, IpcHandler>;
  let fetchCtrl: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    console.info(`[runtime-jobs-ipc-401-retry:beforeEach] resetting handler-mock + fetch + backend token`);
    ipcHandleMock.mockReset();
    fetchCtrl = createFetchMock();
    vi.stubGlobal("fetch", fetchCtrl.mockFetch);
    setRuntimeJobsBackendToken(null);
    registerRuntimeJobsIpc({ runtimeBaseUrl: "http://mock-runtime:3020", getFallbackCopy: async () => false });
    handlers = harvestHandlers();
    // Seed a backend token so ensureClient() doesn't throw before the test
    // path reaches httpFetch.
    setRuntimeJobsBackendToken("backend-test-token");
    console.info(
      `[runtime-jobs-ipc-401-retry:beforeEach:done] handlers=${handlers.size} registered=${Array.from(handlers.keys()).join(",")}`,
    );
  });

  afterEach(() => {
    console.info(`[runtime-jobs-ipc-401-retry:afterEach] clearing stubs + backend token`);
    vi.unstubAllGlobals();
    setRuntimeJobsBackendToken(null);
  });

  const callList = async (filter?: { mediaId?: string }) => {
    const handler = handlers.get("sf-runtime-jobs-list");
    if (!handler) throw new Error("sf-runtime-jobs-list handler not registered");
    return handler({}, { filter: filter ?? {} });
  };

  it("first 401 → invalidate + retry once → returns the 200 list body", async () => {
    console.info(
      `[runtime-jobs-ipc-401-retry:retry-recovers] queueing 401-then-200; expecting a 200 list to renderer + 2 logins`,
    );
    fetchCtrl.setLoginToken("rt-stale");
    fetchCtrl.queueListResponse({ kind: "401_list" });
    // After invalidate, the second login should mint a different token so
    // the retried fetch goes out with FRESH credentials.
    fetchCtrl.queueListResponse({ kind: "200_list", jobs: [{ jobId: "j1" }] });

    let result: unknown;
    try {
      result = await callList();
      console.info(
        `[runtime-jobs-ipc-401-retry:retry-recovers:after-call] result=${JSON.stringify(result)}`,
      );
      // Renderer sees a clean 200 payload — not an error envelope.
      expect(result).toEqual({ jobs: [{ jobId: "j1" }], maxEventId: 0 });
      // One login attempt for the initial getToken(), a second triggered by
      // the 401 path via session.invalidate() — total 2.
      expect(fetchCtrl.getLoginCalls()).toHaveLength(2);
      expect(fetchCtrl.getListCalls()).toHaveLength(2);
    } catch (err) {
      dumpRetrySnapshot("retry-recovers-failure", { fetchCtrl, handlers, handlerResult: result });
      throw err;
    }
  });

  it("two consecutive 401s → no infinite loop; renderer sees the runtime_jobs_http_401 envelope", async () => {
    console.info(
      `[runtime-jobs-ipc-401-retry:double-401] queueing 401-then-401; expecting envelope { __runtimeJobsError, status: 401 }`,
    );
    fetchCtrl.queueListResponse({ kind: "401_list" });
    fetchCtrl.queueListResponse({ kind: "401_list" });

    let result: { __runtimeJobsError?: true; status?: number; errorCode?: string } | undefined;
    try {
      result = (await callList()) as typeof result;
      console.info(
        `[runtime-jobs-ipc-401-retry:double-401:after-call] result=${JSON.stringify(result)}`,
      );
      expect(result?.__runtimeJobsError).toBe(true);
      expect(result?.status).toBe(401);
      // Exactly TWO list calls — the retry budget is single-shot. No infinite loop.
      expect(fetchCtrl.getListCalls()).toHaveLength(2);
    } catch (err) {
      dumpRetrySnapshot("double-401-failure", { fetchCtrl, handlers, handlerResult: result });
      throw err;
    }
  });

  it("non-401 errors are NOT retried (500 propagates directly)", async () => {
    console.info(
      `[runtime-jobs-ipc-401-retry:no-retry-on-500] queueing one 500; expecting a single fetch and envelope { status:500 }`,
    );
    fetchCtrl.queueListResponse({ kind: "500_list" });

    let result: { __runtimeJobsError?: true; status?: number } | undefined;
    try {
      result = (await callList()) as typeof result;
      console.info(
        `[runtime-jobs-ipc-401-retry:no-retry-on-500:after-call] result=${JSON.stringify(result)}`,
      );
      expect(result?.__runtimeJobsError).toBe(true);
      expect(result?.status).toBe(500);
      // Only ONE list attempt for a non-401 — retry budget is narrowly scoped.
      expect(fetchCtrl.getListCalls()).toHaveLength(1);
    } catch (err) {
      dumpRetrySnapshot("no-retry-on-500-failure", { fetchCtrl, handlers, handlerResult: result });
      throw err;
    }
  });

  it("200 on the first try → no retry, exactly one fetch (no perf regression)", async () => {
    console.info(
      `[runtime-jobs-ipc-401-retry:happy-path] queueing 200; expecting one login + one list and no retry`,
    );
    fetchCtrl.queueListResponse({ kind: "200_list", jobs: [] });

    let result: unknown;
    try {
      result = await callList();
      console.info(
        `[runtime-jobs-ipc-401-retry:happy-path:after-call] result=${JSON.stringify(result)}`,
      );
      expect(result).toEqual({ jobs: [], maxEventId: 0 });
      expect(fetchCtrl.getLoginCalls()).toHaveLength(1);
      expect(fetchCtrl.getListCalls()).toHaveLength(1);
    } catch (err) {
      dumpRetrySnapshot("happy-path-failure", { fetchCtrl, handlers, handlerResult: result });
      throw err;
    }
  });
});
