/**
 * @bugfix #7 — loud-fail rule for engineV2 boot
 * @regression-proof
 *
 * Locks down that:
 *  1. The boot status helper resolves the right error envelope per state.
 *  2. The /runtime/jobs/v2/list HTTP route returns 503 with the correct
 *     `error` discriminator when no handler is wired AND the boot status
 *     reflects either `disabled` or `boot_failed`.
 *  3. The legacy badger.ingest dispatcher short-circuits with the same
 *     error envelope when V2 is the required mode but engineV2 is null.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  __resetEngineV2BootStatusForTests,
  setEngineV2BootStatus,
  resolveEngineV2UnavailableError,
  ENGINE_V2_DISABLED_ERROR,
} from "../src/core/jobs/engineV2BootStatus";
import { registerRuntimeJobsV2Routes } from "../src/routes/runtimeJobsV2";
import { executeModuleCommand, setEngineV2ForBadgerIngest } from "../src/modules";
import { runtimeState } from "../src/runtime";

// RT-SEC-02: the v2 routes answer 401 before any availability envelope, so the
// envelope assertions below run as a logged-in caller.
const authedHeaders = () => ({
  authorization: `Bearer ${runtimeState.login("boot-status-backend-token", ["badger"], "boot-status-user").token}`,
});

const readJsonRecord = async (res: Response): Promise<Record<string, unknown>> => {
  const parsed: unknown = await res.json();
  if (typeof parsed !== "object" || parsed === null) throw new Error("expected a JSON object response body");
  return Object.fromEntries(Object.entries(parsed));
};

const dumpBootStatusSnapshot = async (label: string, ctx: {
  res?: Response | null;
  body?: unknown;
  resolved?: unknown;
}) => {
  try {
    console.error(`=== [engine-v2-boot-status:${label}] snapshot ===`);
    if (ctx.res) {
      const text = await ctx.res.clone().text().catch(() => "<no-body>");
      console.error(`http status=${ctx.res.status} body=${text.slice(0, 500)}`);
    }
    if (ctx.body !== undefined) console.error(`parsedBody=${JSON.stringify(ctx.body, null, 2)}`);
    if (ctx.resolved !== undefined) console.error(`resolved=${JSON.stringify(ctx.resolved, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  console.info(`[engine-v2-boot-status:before-each] resetting boot status + engine binding`);
  __resetEngineV2BootStatusForTests();
  setEngineV2ForBadgerIngest(null);
  runtimeState.resetForTests();
});
afterEach(() => {
  console.info(`[engine-v2-boot-status:after-each] resetting boot status + engine binding`);
  __resetEngineV2BootStatusForTests();
  setEngineV2ForBadgerIngest(null);
});

describe("engineV2 boot status resolver [engine-v2-boot-status:resolver]", () => {
  it("returns disabled envelope when V2 was opted out", () => {
    console.info(`[engine-v2-boot-status:resolver-disabled] state=disabled → ENGINE_V2_DISABLED_ERROR`);
    setEngineV2BootStatus({ state: "disabled" });
    const resolved = resolveEngineV2UnavailableError();
    try {
      expect(resolved).toEqual(ENGINE_V2_DISABLED_ERROR);
    } catch (err) {
      void dumpBootStatusSnapshot("resolver-disabled-failure", { resolved });
      throw err;
    }
  });

  it("returns boot_failed envelope carrying the original message", () => {
    console.info(`[engine-v2-boot-status:resolver-boot-failed] state=boot_failed message="DB locked"`);
    setEngineV2BootStatus({ state: "boot_failed", message: "DB locked" });
    const body = resolveEngineV2UnavailableError();
    try {
      expect(body?.error).toBe("engine_v2_boot_failed");
      expect(body?.message).toBe("DB locked");
    } catch (err) {
      void dumpBootStatusSnapshot("resolver-boot-failed-failure", { resolved: body });
      throw err;
    }
  });

  it("returns not-ready envelope while still booting", () => {
    console.info(`[engine-v2-boot-status:resolver-not-booted] state=not_booted → engine_v2_not_ready`);
    setEngineV2BootStatus({ state: "not_booted" });
    const resolved = resolveEngineV2UnavailableError();
    try {
      expect(resolved?.error).toBe("engine_v2_not_ready");
    } catch (err) {
      void dumpBootStatusSnapshot("resolver-not-booted-failure", { resolved });
      throw err;
    }
  });

  it("returns null once the engine is ready", () => {
    console.info(`[engine-v2-boot-status:resolver-ready] state=ready → null`);
    setEngineV2BootStatus({ state: "ready" });
    const resolved = resolveEngineV2UnavailableError();
    try {
      expect(resolved).toBeNull();
    } catch (err) {
      void dumpBootStatusSnapshot("resolver-ready-failure", { resolved });
      throw err;
    }
  });
});

describe("/runtime/jobs/v2/list 503 envelope [engine-v2-boot-status:list-503]", () => {
  it("surfaces engine_v2_disabled when V2 is disabled and no handler is wired", async () => {
    console.info(`[engine-v2-boot-status:list-disabled] GET /runtime/jobs/v2/list with state=disabled`);
    setEngineV2BootStatus({ state: "disabled" });
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    const res = await app.request("/runtime/jobs/v2/list", { headers: authedHeaders() });
    const body = await readJsonRecord(res);
    console.info(`[engine-v2-boot-status:list-disabled] status=${res.status} body=${JSON.stringify(body)}`);
    try {
      expect(res.status).toBe(503);
      expect(body.error).toBe("engine_v2_disabled");
      expect(typeof body.message).toBe("string");
    } catch (err) {
      await dumpBootStatusSnapshot("list-disabled-failure", { res, body });
      throw err;
    }
  });

  it("surfaces engine_v2_boot_failed with the original exception message", async () => {
    console.info(`[engine-v2-boot-status:list-boot-failed] state=boot_failed message="boom: sqlite open failed"`);
    setEngineV2BootStatus({
      state: "boot_failed",
      message: "boom: sqlite open failed",
    });
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    const res = await app.request("/runtime/jobs/v2/list", { headers: authedHeaders() });
    const body = await readJsonRecord(res);
    console.info(`[engine-v2-boot-status:list-boot-failed] status=${res.status} body=${JSON.stringify(body)}`);
    try {
      expect(res.status).toBe(503);
      expect(body.error).toBe("engine_v2_boot_failed");
      expect(body.message).toContain("boom");
    } catch (err) {
      await dumpBootStatusSnapshot("list-boot-failed-failure", { res, body });
      throw err;
    }
  });
});

describe("v2 routes are always mounted (no 404 for missing engine) [engine-v2-boot-status:always-mounted]", () => {
  it("returns 503 (not 404) for the snapshot route when no handler is wired", async () => {
    console.info(`[engine-v2-boot-status:snapshot-mounted] expecting 503 with no handler`);
    setEngineV2BootStatus({ state: "disabled" });
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    const res = await app.request("/runtime/jobs/v2/list", { headers: authedHeaders() });
    console.info(`[engine-v2-boot-status:snapshot-mounted] status=${res.status}`);
    try {
      expect(res.status).toBe(503);
    } catch (err) {
      await dumpBootStatusSnapshot("snapshot-mounted-failure", { res });
      throw err;
    }
  });

  it("catch-all returns 503 for unknown /runtime/jobs/v2/* path when V2 is disabled", async () => {
    console.info(`[engine-v2-boot-status:catchall-unknown-path] GET /runtime/jobs/v2/totally-fake-route`);
    setEngineV2BootStatus({ state: "disabled" });
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    const res = await app.request("/runtime/jobs/v2/totally-fake-route", { headers: authedHeaders() });
    const body = await readJsonRecord(res);
    console.info(`[engine-v2-boot-status:catchall-unknown-path] status=${res.status} body=${JSON.stringify(body)}`);
    try {
      expect(res.status).toBe(503);
      expect(body.error).toBe("engine_v2_disabled");
    } catch (err) {
      await dumpBootStatusSnapshot("catchall-unknown-path-failure", { res, body });
      throw err;
    }
  });

  it("catch-all returns 503 (not 404) when wrong method is used while V2 is disabled", async () => {
    console.info(`[engine-v2-boot-status:catchall-wrong-method] POST /runtime/jobs/v2/list while disabled`);
    setEngineV2BootStatus({ state: "disabled" });
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    const res = await app.request("/runtime/jobs/v2/list", { method: "POST", headers: authedHeaders() });
    const body = await readJsonRecord(res);
    console.info(`[engine-v2-boot-status:catchall-wrong-method] status=${res.status} body=${JSON.stringify(body)}`);
    try {
      expect(res.status).toBe(503);
      expect(body.error).toBe("engine_v2_disabled");
    } catch (err) {
      await dumpBootStatusSnapshot("catchall-wrong-method-failure", { res, body });
      throw err;
    }
  });
});

describe("v2 availability envelope needs a session @req RT-SEC-02[runtime] [engine-v2-boot-status:token-first]", () => {
  it("answers 401, not the 503 envelope, to a caller without a token (catch-all and snapshot) @req RT-SEC-02[runtime]", async () => {
    setEngineV2BootStatus({ state: "boot_failed", message: "boom: sqlite open failed" });
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => null);
    for (const [path, method] of [
      ["/runtime/jobs/v2/list", "POST"],
      ["/runtime/jobs/v2/list", "GET"],
      ["/runtime/jobs/v2/totally-fake-route", "GET"],
    ] as const) {
      const res = await app.request(path, { method });
      const body = await readJsonRecord(res);
      try {
        expect(res.status).toBe(401);
        expect(body).toEqual({ error: "unauthorized" });
      } catch (err) {
        await dumpBootStatusSnapshot(`token-first-${method}-${path}`, { res, body });
        throw err;
      }
    }
  });
});

describe("legacy badger.ingest commands short-circuit when V2 not ready [engine-v2-boot-status:legacy-short-circuit]", () => {
  it("returns invalid_command with engine_v2_disabled reason for badger.ingest.apply", async () => {
    console.info(`[engine-v2-boot-status:legacy-apply-disabled] state=disabled, executing badger.ingest.apply`);
    setEngineV2BootStatus({ state: "disabled" });
    const result = await executeModuleCommand({
      requestId: "req-test-1",
      module: "badger",
      command: "badger.ingest.apply",
      payload: { userId: "u1", actions: [] },
    });
    console.info(`[engine-v2-boot-status:legacy-apply-disabled] response.ok=${result.response.ok} message=${result.response.error?.message ?? ""}`);
    try {
      expect(result.response.ok).toBe(false);
      expect(result.response.error?.message).toContain("engine_v2_disabled");
    } catch (err) {
      void dumpBootStatusSnapshot("legacy-apply-disabled-failure", { body: result.response });
      throw err;
    }
  });

  it("returns invalid_command with engine_v2_boot_failed reason for badger.ingest.submit_sources", async () => {
    console.info(`[engine-v2-boot-status:legacy-submit-boot-failed] state=boot_failed, message="schema mismatch"`);
    setEngineV2BootStatus({
      state: "boot_failed",
      message: "schema mismatch",
    });
    const result = await executeModuleCommand({
      requestId: "req-test-2",
      module: "badger",
      command: "badger.ingest.submit_sources",
      payload: { userId: "u1", sources: [] },
    });
    console.info(`[engine-v2-boot-status:legacy-submit-boot-failed] response.ok=${result.response.ok} message=${result.response.error?.message ?? ""}`);
    try {
      expect(result.response.ok).toBe(false);
      expect(result.response.error?.message).toContain("engine_v2_boot_failed");
      expect(result.response.error?.message).toContain("schema mismatch");
    } catch (err) {
      void dumpBootStatusSnapshot("legacy-submit-boot-failed-failure", { body: result.response });
      throw err;
    }
  });
});
