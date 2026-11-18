/**
 * @bugfix #9 — V2 `/cancel` and `/retry` routes shadowed by legacy
 *            `/runtime/jobs/:jobId/cancel` / `:jobId/retry` parameterized
 *            routes when both were registered, with the legacy ones first.
 * @regression-proof
 *
 * Live evidence (verifier, runtime PID 1173102):
 *   POST /runtime/jobs/v2/cancel → 401 unauthorized
 *   POST /runtime/jobs/v2/retry  → 401 unauthorized
 *   POST /runtime/jobs/v2/list   → 200
 *   POST /runtime/jobs/v2/dismiss → 200
 *   POST /runtime/jobs/v2/cancel-by-group → 200
 *
 * Asymmetry root cause: Hono's path matcher treats
 * `/runtime/jobs/:jobId/cancel` as a match for `/runtime/jobs/v2/cancel`
 * with `jobId = "v2"`. The legacy route has its own `requireToken` auth
 * gate which returns 401 before the v2 handler ever runs. /list and
 * /dismiss were unaffected because there's no `:jobId/list` or
 * `:jobId/dismiss` legacy route.
 *
 * Fix: register the v2 routes BEFORE the legacy parameterized routes so the
 * concrete v2 paths win the match. This test mounts both in the buggy
 * order (legacy first) AND then in the fixed order (v2 first) and asserts
 * the symptom only happens with the buggy order.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerRuntimeJobsV2Routes } from "../src/routes/runtimeJobsV2";
import { runtimeState } from "../src/runtime";

// RT-SEC-02: the v2 routes check the token before the engine-unavailable 503,
// so the "reached the v2 handler" probes carry a real session.
const v2Authorization = () =>
  `Bearer ${runtimeState.login("shadow-backend-token", ["badger"], "shadow-user").token}`;

const installLegacyShadowRoute = (app: Hono) => {
  // Minimal stand-in for the legacy `:jobId/cancel` route in routes/runtime.ts.
  // It does an auth check and returns 401 if absent — same shape that caused
  // the verifier's 401 observation.
  app.post("/runtime/jobs/:jobId/cancel", (c) => {
    const auth = c.req.header("authorization");
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    return c.json({ legacy: true, jobId: c.req.param("jobId") });
  });
  app.post("/runtime/jobs/:jobId/retry", (c) => {
    const auth = c.req.header("authorization");
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    return c.json({ legacy: true, jobId: c.req.param("jobId") });
  });
};

const dumpShadowSnapshot = async (label: string, res: Response | null) => {
  try {
    if (!res) {
      console.error(`=== [v2-route-shadow-regression:${label}] no response ===`);
      return;
    }
    const cloned = res.clone();
    const text = await cloned.text().catch(() => "<no body>");
    console.error(`=== [v2-route-shadow-regression:${label}] snapshot ===`);
    console.error(`status=${res.status} body=${text.slice(0, 500)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("V2 routes are not shadowed by legacy `/runtime/jobs/:jobId/*` routes [v2-route-shadow-regression]", () => {
  it("BUGGY ORDER reproduces the 401: legacy registered first, v2 /cancel returns 401", async () => {
    console.info(`[v2-route-shadow-regression:buggy-order] installing legacy FIRST, then v2 — expecting 401 from /v2/cancel`);
    const app = new Hono();
    installLegacyShadowRoute(app);
    registerRuntimeJobsV2Routes(app, () => null);
    const res = await app.request("/runtime/jobs/v2/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "j1" }),
    });
    console.info(`[v2-route-shadow-regression:buggy-order:result] status=${res.status}`);
    try {
      // Demonstrates the live symptom: 401 because the legacy `:jobId/cancel`
      // route captured the path with jobId="v2" and rejected the missing
      // bearer.
      expect(res.status).toBe(401);
    } catch (err) {
      await dumpShadowSnapshot("buggy-order-failure", res);
      throw err;
    }
  });

  it("FIXED ORDER: v2 routes registered first — /cancel reaches v2 handler (503 because no engine wired here)", async () => {
    console.info(`[v2-route-shadow-regression:fixed-order-cancel] v2 FIRST, then legacy — expecting NOT 401, expecting 503`);
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    installLegacyShadowRoute(app);
    const res = await app.request("/runtime/jobs/v2/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: v2Authorization() },
      body: JSON.stringify({ jobId: "j1" }),
    });
    console.info(`[v2-route-shadow-regression:fixed-order-cancel:result] status=${res.status}`);
    try {
      // 503 (engine not ready) is the V2 handler's response — proves we
      // reached it instead of being shadow-captured. Critically NOT 401.
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(503);
    } catch (err) {
      await dumpShadowSnapshot("fixed-order-cancel-failure", res);
      throw err;
    }
  });

  it("FIXED ORDER: /retry also reaches v2 handler instead of being captured by `:jobId/retry`", async () => {
    console.info(`[v2-route-shadow-regression:fixed-order-retry] v2 FIRST — expecting NOT 401, expecting 503`);
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    installLegacyShadowRoute(app);
    const res = await app.request("/runtime/jobs/v2/retry", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: v2Authorization() },
      body: JSON.stringify({ jobId: "j1" }),
    });
    console.info(`[v2-route-shadow-regression:fixed-order-retry:result] status=${res.status}`);
    try {
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(503);
    } catch (err) {
      await dumpShadowSnapshot("fixed-order-retry-failure", res);
      throw err;
    }
  });

  it("FIXED ORDER: a real legacy jobId still reaches the legacy handler", async () => {
    console.info(`[v2-route-shadow-regression:legacy-still-works] real jobId=legit-job-uuid with Bearer should still reach legacy`);
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    installLegacyShadowRoute(app);
    const res = await app.request("/runtime/jobs/legit-job-uuid/cancel", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer t",
      },
      body: JSON.stringify({}),
    });
    console.info(`[v2-route-shadow-regression:legacy-still-works:result] status=${res.status}`);
    let body: { legacy: boolean; jobId: string } | null = null;
    try {
      // Concrete v2 paths must NOT capture non-v2 jobIds — the legacy route
      // still owns the parameterized space.
      expect(res.status).toBe(200);
      body = (await res.json()) as { legacy: boolean; jobId: string };
      console.info(`[v2-route-shadow-regression:legacy-still-works:body] ${JSON.stringify(body)}`);
      expect(body.legacy).toBe(true);
      expect(body.jobId).toBe("legit-job-uuid");
    } catch (err) {
      await dumpShadowSnapshot("legacy-still-works-failure", res);
      console.error(`parsed body=${JSON.stringify(body)}`);
      throw err;
    }
  });
});
