/**
 * Auth gate regression for the v2 jobs HTTP routes.
 *
 * @bugfix the-app-restart-fixed-soft-pixel — `/runtime/jobs/v2/list`,
 *         `/cancel`, `/dismiss`, `/retry`, and `/cancel-by-group` were
 *         registered without calling `requireToken`. A renderer with a
 *         long-expired runtime session would see those endpoints respond 200
 *         (silently accepting any Bearer, even `Bearer JUNK` or none) while
 *         the SSE sibling `/runtime/events/jobs/v2/stream` correctly 401'd —
 *         producing the user-visible "Ingest unavailable — runtime engine v2
 *         not ready" banner without any client-readable signal that the real
 *         problem was the stale token. The auth gap also let any local
 *         process reach those mutation endpoints (cancel/dismiss/retry) with
 *         no credential.
 * @regression-proof — each route is exercised with three credential shapes
 *         (no Bearer, junk Bearer, valid login token) and the auth/engine
 *         ordering is locked down: the token check runs BEFORE the
 *         engine-unavailable 503 envelope (RT-SEC-02), so an unauthenticated
 *         caller learns nothing about the engine; an authenticated caller
 *         still gets the typed 503.
 *
 * Live evidence (before fix), runtime PID 13415 with a 6h47m-old session:
 *   POST /runtime/jobs/v2/list (any Bearer)           → 200 OK
 *   GET  /runtime/events/jobs/v2/stream (same token)  → 401 unauthorized
 * The asymmetry is exactly what this test prevents from coming back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  __resetEngineV2BootStatusForTests,
  setEngineV2BootStatus,
} from "../src/core/jobs/engineV2BootStatus";
import {
  registerRuntimeJobsV2Routes,
  type RuntimeJobsV2Handler,
} from "../src/routes/runtimeJobsV2";
import { runtimeState } from "../src/runtime";

const SUITE = "runtime-jobs-v2-http-auth";

// Minimal fake handler — every method records its call and returns a benign
// shape. The route layer only inspects shape, not contents, so this is
// enough to assert "we reached the handler" via 200.
type Call = { method: string; payload: unknown };
const createFakeHandler = (calls: Call[]): RuntimeJobsV2Handler => ({
  handleSseSubscribe: () => ({ unsubscribe: () => {} }),
  getJobApp: async () => null,
  getGroupApps: async () => [],
  handleSnapshot: async (filter) => {
    calls.push({ method: "handleSnapshot", payload: filter ?? null });
    return { jobs: [], maxEventId: 0 };
  },
  handleCancelByGroup: async (input) => {
    calls.push({ method: "handleCancelByGroup", payload: input });
    return { cancelled: 0, dismissed: 0 };
  },
  handleCancel: async (input) => {
    calls.push({ method: "handleCancel", payload: input });
    return { cancelled: false };
  },
  handleDismiss: async (input) => {
    calls.push({ method: "handleDismiss", payload: input });
    return { dismissed: false, errorCode: "not-found" as const };
  },
  handleRetry: async (input) => {
    calls.push({ method: "handleRetry", payload: input });
    return { retried: false };
  },
});

const dumpAuthSnapshot = async (
  label: string,
  ctx: { res?: Response | null; expectedStatus?: number; sentToken?: string | null; calls?: Call[] },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.res) {
      const text = await ctx.res.clone().text().catch(() => "<no-body>");
      console.error(`http status=${ctx.res.status} expected=${ctx.expectedStatus ?? "?"} body=${text.slice(0, 500)}`);
    }
    if (ctx.sentToken !== undefined) {
      console.error(
        `sentToken=${ctx.sentToken === null ? "<none>" : `${ctx.sentToken.slice(0, 8)}…(len=${ctx.sentToken.length})`}`,
      );
    }
    if (ctx.calls) console.error(`handlerCalls=${JSON.stringify(ctx.calls)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// (method, path, body) — one tuple per route the auth gate protects. Keep in
// sync with the routes in apps/runtime/src/routes/runtimeJobsV2.ts AND with
// apps/runtime/tests/v2-ipc-route-audit.test.ts (which locks down their
// registration vs 404s).
const protectedRoutes = [
  { path: "/runtime/jobs/v2/list", body: { filter: {} }, handlerMethod: "handleSnapshot" },
  { path: "/runtime/jobs/v2/cancel-by-group", body: { groupId: "g1" }, handlerMethod: "handleCancelByGroup" },
  { path: "/runtime/jobs/v2/cancel", body: { jobId: "j1" }, handlerMethod: "handleCancel" },
  { path: "/runtime/jobs/v2/dismiss", body: { jobId: "j1" }, handlerMethod: "handleDismiss" },
  { path: "/runtime/jobs/v2/retry", body: { jobId: "j1" }, handlerMethod: "handleRetry" },
] as const;

beforeEach(() => {
  console.info(`[${SUITE}:before-each] resetting boot status + sessions`);
  __resetEngineV2BootStatusForTests();
  runtimeState.resetForTests();
});

afterEach(() => {
  console.info(`[${SUITE}:after-each] resetting boot status + sessions`);
  __resetEngineV2BootStatusForTests();
  runtimeState.resetForTests();
});

describe(`Auth gate on /runtime/jobs/v2/* [${SUITE}] — engine ready, auth required @bugfix @regression-proof`, () => {
  for (const route of protectedRoutes) {
    describe(`POST ${route.path}`, () => {
      it("401 when no Authorization header is sent", async () => {
        console.info(`[${SUITE}:no-bearer] POST ${route.path} — expecting 401 (engine ready, no auth)`);
        setEngineV2BootStatus({ state: "ready" });
        const app = new Hono();
        const calls: Call[] = [];
        registerRuntimeJobsV2Routes(app, () => createFakeHandler(calls));
        const res = await app.request(route.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(route.body),
        });
        const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
        console.info(`[${SUITE}:no-bearer:result] ${route.path} status=${res.status} error=${body?.error ?? "<none>"} handlerCalls=${calls.length}`);
        try {
          expect(res.status).toBe(401);
          expect(body.error).toBe("unauthorized");
          // Handler must NOT be invoked when auth fails.
          expect(calls.length).toBe(0);
        } catch (err) {
          await dumpAuthSnapshot(`no-bearer-${route.path}`, { res, expectedStatus: 401, sentToken: null, calls });
          throw err;
        }
      });

      it("401 when a junk Bearer token is sent (no session in the runtime map)", async () => {
        console.info(`[${SUITE}:junk-bearer] POST ${route.path} — expecting 401 (engine ready, junk token)`);
        setEngineV2BootStatus({ state: "ready" });
        const app = new Hono();
        const calls: Call[] = [];
        registerRuntimeJobsV2Routes(app, () => createFakeHandler(calls));
        const junkToken = "rt_JUNK_NOT_A_REAL_SESSION";
        const res = await app.request(route.path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${junkToken}`,
          },
          body: JSON.stringify(route.body),
        });
        const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
        console.info(`[${SUITE}:junk-bearer:result] ${route.path} status=${res.status} error=${body?.error ?? "<none>"} handlerCalls=${calls.length}`);
        try {
          expect(res.status).toBe(401);
          expect(body.error).toBe("unauthorized");
          expect(calls.length).toBe(0);
        } catch (err) {
          await dumpAuthSnapshot(`junk-bearer-${route.path}`, { res, expectedStatus: 401, sentToken: junkToken, calls });
          throw err;
        }
      });

      it("200 when a freshly-logged-in token is sent (auth passes, handler is reached)", async () => {
        console.info(`[${SUITE}:valid-bearer] POST ${route.path} — expecting 200 (engine ready, valid token)`);
        setEngineV2BootStatus({ state: "ready" });
        // Mint a real runtime session via the same path the desktop uses —
        // runtimeState.login is what /runtime/session/login wraps.
        const session = runtimeState.login("test-backend-token", ["badger"], "test-user-id");
        const app = new Hono();
        const calls: Call[] = [];
        registerRuntimeJobsV2Routes(app, () => createFakeHandler(calls));
        const res = await app.request(route.path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${session.token}`,
          },
          body: JSON.stringify(route.body),
        });
        console.info(`[${SUITE}:valid-bearer:result] ${route.path} status=${res.status} handlerCalls=${calls.length}`);
        try {
          expect(res.status).toBe(200);
          // Crucially the handler MUST have been reached — auth check did not
          // short-circuit a legit caller.
          expect(calls.length).toBe(1);
          expect(calls[0]!.method).toBe(route.handlerMethod);
        } catch (err) {
          await dumpAuthSnapshot(`valid-bearer-${route.path}`, { res, expectedStatus: 200, sentToken: session.token, calls });
          throw err;
        }
      });
    });
  }

  // @req RT-SEC-02[runtime]
  it("ordering invariant: the token check wins over the engine-down envelope — an unauthenticated caller gets 401, not 503 @req RT-SEC-02[runtime]", async () => {
    // RT-SEC-02: an unauthenticated caller must not learn whether EngineV2
    // booted. Authenticated callers still get the typed 503 envelope so the
    // renderer can tell "engine broken" from "session expired".
    setEngineV2BootStatus({ state: "disabled" });
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    for (const route of protectedRoutes) {
      const res = await app.request(route.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(route.body),
      });
      const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
      try {
        expect(res.status).toBe(401);
        expect(body.error).toBe("unauthorized");
      } catch (err) {
        await dumpAuthSnapshot(`token-wins-${route.path}`, { res, expectedStatus: 401, sentToken: null });
        throw err;
      }
    }
  });

  it("engine-down envelope is still served to an authenticated caller (503, not 401) @req RT-SEC-02[runtime]", async () => {
    setEngineV2BootStatus({ state: "disabled" });
    const session = runtimeState.login("test-backend-token", ["badger"], "test-user-id");
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    const res = await app.request("/runtime/jobs/v2/list", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ filter: {} }),
    });
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
    try {
      expect(res.status).toBe(503);
      expect(body.error).toBe("engine_v2_disabled");
    } catch (err) {
      await dumpAuthSnapshot("envelope-authed", { res, expectedStatus: 503, sentToken: session.token });
      throw err;
    }
  });
});
