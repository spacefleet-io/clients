/**
 * @bugfix #9 — V2 HTTP route ↔ desktop IPC contract drift
 * @regression-proof
 *
 * The desktop main process (`apps/badger/desktop/src/main/runtimeJobsIpc.ts`)
 * speaks to the runtime over plain HTTP for the v2 jobs surface. This test
 * locks down the (method, path) pairs the desktop emits so a route rename or
 * method change on the runtime side cannot regress to the silent 404 the
 * verifier observed.
 *
 * Coverage rule: each entry below MUST resolve to something other than 404
 * even when engineV2 is disabled (the unavailability envelope is also
 * non-404 — it is 503 with a typed `error` discriminator).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerRuntimeJobsV2Routes } from "../src/routes/runtimeJobsV2";
import { runtimeState } from "../src/runtime";
import {
  __resetEngineV2BootStatusForTests,
  setEngineV2BootStatus,
} from "../src/core/jobs/engineV2BootStatus";

// RT-SEC-02: the token check precedes the engine envelope, so the audit probes
// as a logged-in desktop.
let authorization = "";
beforeEach(() => {
  __resetEngineV2BootStatusForTests();
  runtimeState.resetForTests();
  authorization = `Bearer ${runtimeState.login("audit-backend-token", ["badger"], "audit-user").token}`;
});
afterEach(() => {
  __resetEngineV2BootStatusForTests();
});

// (method, path, body?) — keep in sync with apps/badger/desktop/src/main/runtimeJobsIpc.ts
const desktopIpcCallTable = [
  { method: "POST", path: "/runtime/jobs/v2/list", body: { filter: {} } },
  { method: "POST", path: "/runtime/jobs/v2/cancel", body: { jobId: "j1" } },
  { method: "POST", path: "/runtime/jobs/v2/dismiss", body: { jobId: "j1" } },
  { method: "POST", path: "/runtime/jobs/v2/retry", body: { jobId: "j1" } },
  {
    method: "POST",
    path: "/runtime/jobs/v2/cancel-by-group",
    body: { groupId: "g1" },
  },
] as const;

describe("V2 routes audit [v2-ipc-route-audit] — every desktop IPC (method, path) is registered", () => {
  console.info(
    `[v2-ipc-route-audit:suite-init] auditing ${desktopIpcCallTable.length} (method,path) tuples against registerRuntimeJobsV2Routes`,
  );

  for (const call of desktopIpcCallTable) {
    it(`${call.method} ${call.path} is mounted (no 404 even when engine is disabled)`, async () => {
      console.info(`[v2-ipc-route-audit:probe] ${call.method} ${call.path} body=${JSON.stringify(call.body)}`);
      setEngineV2BootStatus({ state: "disabled" });
      const app = new Hono();
      registerRuntimeJobsV2Routes(app, () => null);
      const res = await app.request(call.path, {
        method: call.method,
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(call.body),
      });
      const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
      console.info(`[v2-ipc-route-audit:result] ${call.method} ${call.path} → status=${res.status} error=${body?.error ?? "<none>"}`);
      try {
        expect(res.status).not.toBe(404);
        // Engine disabled ⇒ 503 with a typed error envelope, not silent 404.
        expect(res.status).toBe(503);
        expect(body.error).toBe("engine_v2_disabled");
      } catch (err) {
        console.error(`=== [v2-ipc-route-audit:failure] ${call.method} ${call.path} ===`);
        console.error(`status=${res.status} body=${JSON.stringify(body)}`);
        throw err;
      }
    });
  }

  it("legacy GET /runtime/jobs/v2/list is no longer the canonical method (returns engine-aware envelope, not Hono's default 404)", async () => {
    console.info(`[v2-ipc-route-audit:legacy-get-list] GET /runtime/jobs/v2/list while engine disabled`);
    setEngineV2BootStatus({ state: "disabled" });
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    const res = await app.request("/runtime/jobs/v2/list", { method: "GET", headers: { authorization } });
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
    console.info(`[v2-ipc-route-audit:legacy-get-list:result] status=${res.status} error=${body?.error ?? "<none>"}`);
    // The catch-all converts wrong-method to a 503 envelope when engine is
    // disabled. This locks down the loud-fail behavior task #7 introduced
    // and ensures task #9's POST switch did not reintroduce a 404.
    expect(res.status).toBe(503);
    expect(body.error).toBe("engine_v2_disabled");
  });
});
