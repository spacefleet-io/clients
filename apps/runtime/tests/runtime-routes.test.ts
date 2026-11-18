import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { ownerLoginGate, runtimeState } from "../src/runtime";
import { resetModulesForTests, setBadgerModuleForTests } from "../src/modules";
import { BadgerModule } from "../src/modules/badger";
import { runtimeJobsStore } from "../src/core/jobs/store";
import type { RuntimeJobRecord } from "@space/runtime-jobs";
import { uploadPlaybackGate } from "@space/content-core/storageTransport";

const SUITE = "runtime-routes";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpRuntimeRoutesSnapshot = (
  label: string,
  ctx: {
    dataDir?: string;
    appsScope?: readonly string[];
    backendToken?: string | null;
    token?: string;
    requestId?: string;
    command?: string;
    module?: string;
    payload?: unknown;
    request?: Record<string, unknown>;
    httpStatus?: number;
    httpUrl?: string;
    response?: unknown;
    responseBody?: unknown;
    expected?: unknown;
    actual?: unknown;
    uploadId?: string;
    versionId?: string;
    shareId?: string;
    sessionId?: string;
    jobId?: string;
    runtimeJobs?: unknown;
    queue?: unknown;
    syncState?: unknown;
    modules?: unknown;
    summary?: unknown;
    badgerJobs?: unknown;
    envSnapshot?: Record<string, string | undefined>;
    uploadAttempts?: number;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] runtime-routes snapshot ===`);
    if (ctx.dataDir !== undefined) console.error(`dataDir: ${ctx.dataDir}`);
    if (ctx.appsScope !== undefined) console.error(`appsScope: [${ctx.appsScope.join(", ")}]`);
    if (ctx.backendToken !== undefined) console.error(`backendToken: ${ctx.backendToken ?? "(none)"}`);
    if (ctx.token !== undefined) {
      console.error(`token: ${ctx.token.slice(0, 8)}…(len=${ctx.token.length})`);
    }
    if (ctx.requestId !== undefined) console.error(`requestId: ${ctx.requestId}`);
    if (ctx.command !== undefined) console.error(`command: ${ctx.command}`);
    if (ctx.module !== undefined) console.error(`module: ${ctx.module}`);
    if (ctx.payload !== undefined) {
      console.error(`payload:\n${JSON.stringify(ctx.payload, jsonReplacer, 2)}`);
    }
    if (ctx.request !== undefined) {
      console.error(`request:\n${JSON.stringify(ctx.request, jsonReplacer, 2)}`);
    }
    if (ctx.httpStatus !== undefined) console.error(`httpStatus: ${ctx.httpStatus}`);
    if (ctx.httpUrl !== undefined) console.error(`httpUrl: ${ctx.httpUrl}`);
    if (ctx.response !== undefined) {
      console.error(`response:\n${JSON.stringify(ctx.response, jsonReplacer, 2)}`);
    }
    if (ctx.responseBody !== undefined) {
      console.error(`responseBody:\n${JSON.stringify(ctx.responseBody, jsonReplacer, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.uploadId !== undefined) console.error(`uploadId: ${ctx.uploadId}`);
    if (ctx.versionId !== undefined) console.error(`versionId: ${ctx.versionId}`);
    if (ctx.shareId !== undefined) console.error(`shareId: ${ctx.shareId}`);
    if (ctx.sessionId !== undefined) console.error(`sessionId: ${ctx.sessionId}`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.runtimeJobs !== undefined) {
      console.error(`runtimeJobs:\n${JSON.stringify(ctx.runtimeJobs, jsonReplacer, 2)}`);
    }
    if (ctx.queue !== undefined) {
      console.error(`queue:\n${JSON.stringify(ctx.queue, jsonReplacer, 2)}`);
    }
    if (ctx.syncState !== undefined) {
      console.error(`syncState:\n${JSON.stringify(ctx.syncState, jsonReplacer, 2)}`);
    }
    if (ctx.modules !== undefined) {
      console.error(`modules:\n${JSON.stringify(ctx.modules, jsonReplacer, 2)}`);
    }
    if (ctx.summary !== undefined) {
      console.error(`summary:\n${JSON.stringify(ctx.summary, jsonReplacer, 2)}`);
    }
    if (ctx.badgerJobs !== undefined) {
      console.error(`badgerJobs:\n${JSON.stringify(ctx.badgerJobs, jsonReplacer, 2)}`);
    }
    if (ctx.envSnapshot !== undefined) {
      console.error(`env:\n${JSON.stringify(ctx.envSnapshot, null, 2)}`);
    }
    if (ctx.uploadAttempts !== undefined) console.error(`uploadAttempts: ${ctx.uploadAttempts}`);
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    try {
      console.error(
        `runtimeJobsStore: badger-jobs=${runtimeJobsStore.list({ includeCompleted: true, app: "badger" }).length}`
      );
    } catch {
      console.error(`runtimeJobsStore: (list failed)`);
    }
  } catch (err) {
    console.error(
      `=== [${SUITE}:${label}] (snapshot failed: ${err instanceof Error ? err.message : String(err)}) ===`
    );
  }
};

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

const login = async (
  app: ReturnType<typeof createApp>,
  apps = ["badger"],
  backendToken = "api_token"
) => {
  const res = await app.request("/runtime/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-runtime-owner": ownerLoginGate.secret },
    body: JSON.stringify({
      backendToken,
      apps,
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  return body.token as string;
};

describe("runtime routes", () => {
  console.info(`[${SUITE}:describe] entering "runtime routes"`);
  beforeEach(() => {
    console.info(`[${SUITE}:beforeEach] resetting runtimeState + modules`);
    const resetStartedAt = performance.now();
    runtimeState.resetForTests();
    const stateResetMs = performance.now() - resetStartedAt;
    resetModulesForTests();
    console.info(
      `[${SUITE}:beforeEach] reset done runtimeState=${stateResetMs.toFixed(1)}ms modules=${(performance.now() - resetStartedAt - stateResetMs).toFixed(1)}ms`
    );
  });

  it("requires auth for runtime module listing @req RT-SEC-02", async () => {
    const label = "no-auth-modules";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const res = await app.request("/runtime/modules");
    try {
      expect(res.status).toBe(401);
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        httpUrl: "/runtime/modules",
        httpStatus: res.status,
        expected: 401,
        actual: res.status,
        error: err,
      });
      throw err;
    }
  });

  it("allows trusted local desktop origins for runtime session preflight", async () => {
    const label = "preflight-trusted-origins";
    console.info(`[${SUITE}:${label}] start`);
    process.env.RUNTIME_ALLOWED_ORIGINS = "https://api.spacebadger.io";
    const app = createApp();

    console.info(`[${SUITE}:${label}] preflight localhost:3007`);
    const localhostRes = await app.request("/runtime/session/login", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3007",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    try {
      expect(localhostRes.status).toBe(204);
      expect(localhostRes.headers.get("access-control-allow-origin")).toBe("http://localhost:3007");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        httpUrl: "/runtime/session/login OPTIONS",
        httpStatus: localhostRes.status,
        expected: { status: 204, allowOrigin: "http://localhost:3007" },
        actual: {
          status: localhostRes.status,
          allowOrigin: localhostRes.headers.get("access-control-allow-origin"),
        },
        envSnapshot: { RUNTIME_ALLOWED_ORIGINS: process.env.RUNTIME_ALLOWED_ORIGINS },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] preflight 127.0.0.1:3007`);
    const localIpRes = await app.request("/runtime/session/login", {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:3007",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    try {
      expect(localIpRes.status).toBe(204);
      expect(localIpRes.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3007");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        httpUrl: "/runtime/session/login OPTIONS",
        httpStatus: localIpRes.status,
        expected: { status: 204, allowOrigin: "http://127.0.0.1:3007" },
        actual: {
          status: localIpRes.status,
          allowOrigin: localIpRes.headers.get("access-control-allow-origin"),
        },
        envSnapshot: { RUNTIME_ALLOWED_ORIGINS: process.env.RUNTIME_ALLOWED_ORIGINS },
        error: err,
      });
      throw err;
    }
  });

  it("logs in and returns scoped capabilities", async () => {
    const label = "login-scoped-capabilities";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["parrot"]);
    console.info(`[${SUITE}:${label}] logged in token=${token.slice(0, 8)}…`);
    const modulesRes = await app.request("/runtime/modules", { headers: authHeader(token) });
    const body = (await modulesRes.json()) as { modules?: unknown[] };
    try {
      expect(modulesRes.status).toBe(200);
      expect(Array.isArray(body.modules)).toBe(true);
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        token,
        appsScope: ["parrot"],
        httpUrl: "/runtime/modules",
        httpStatus: modulesRes.status,
        responseBody: body,
        error: err,
      });
      throw err;
    }
  });

  it("lists shared runtime jobs from the canonical runtime store without app-private list commands @bugfix @regression-proof", async () => {
    const label = "list-shared-jobs-canonical";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["parrot", "badger"]);

    const seed = (jobId: string, appId: "parrot" | "badger", kind: string): RuntimeJobRecord => ({
      jobId,
      app: appId,
      kind,
      lane: appId === "parrot" ? "io" : "cpu",
      status: "running",
      stageCode: "uploading",
      stageLabel: "Uploading",
      progress: { mode: "indeterminate", completed: null, total: null, unit: null },
      payload: {},
      outputs: {},
      errorCode: null,
      errorMessage: null,
      retryable: true,
      cancelRequested: false,
      priority: 0,
      dedupeKey: null,
      createdAt: "2026-03-23T10:00:00.000Z",
      updatedAt: "2026-03-23T10:00:00.000Z",
      startedAt: "2026-03-23T10:00:00.000Z",
      finishedAt: null,
    });

    runtimeJobsStore.upsertMany([
      seed("parrot:task:seed-1", "parrot", "parrot.ingest.local_file"),
      seed("badger:ingest:user-seed:seed-2", "badger", "badger.ingest.media_file"),
    ]);
    console.info(`[${SUITE}:list-shared-jobs-canonical] seeded 2 jobs into runtimeJobsStore`);

    const res = await app.request("/runtime/jobs?includeCompleted=true", { headers: authHeader(token) });
    const body = (await res.json()) as { items?: Array<{ jobId?: string }> };
    try {
      expect(res.status).toBe(200);
      expect(body.items?.map((item) => item.jobId)).toEqual(["parrot:task:seed-1", "badger:ingest:user-seed:seed-2"]);
    } catch (err) {
      dumpRuntimeRoutesSnapshot("list-shared-jobs-canonical", {
        token,
        appsScope: ["parrot", "badger"],
        httpUrl: "/runtime/jobs?includeCompleted=true",
        httpStatus: res.status,
        responseBody: body,
        expected: ["parrot:task:seed-1", "badger:ingest:user-seed:seed-2"],
        actual: body.items?.map((item) => item.jobId),
        error: err,
      });
      throw err;
    }
  });

  it("lists, gets, cancels, and retries Badger shared runtime jobs", async () => {
    const label = "shared-jobs-badger-only";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };
    const send = (requestId: string, command: string, payload: Record<string, unknown>) =>
      app.request("/modules/badger/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({ requestId, module: "badger", command, payload }),
      });

    await send("req-badger-only-open", "badger.ingest.open", { userId: "user-a", config: {} });
    await send("req-badger-only-apply", "badger.ingest.apply", {
      actions: [{ type: "queue_files", files: [{ id: "job-3", filename: "/tmp/movie-3.mkv", sizeMb: 100 }] }],
    });

    console.info(`[${SUITE}:${label}] listing /runtime/jobs`);
    const listed = await app.request("/runtime/jobs?includeCompleted=true", { headers: authHeader(token) });
    const listedBody = (await listed.json()) as { items?: Array<{ jobId: string; app: string; status: string }> };
    const badgerJob = listedBody.items?.find((item) => item.app === "badger");
    try {
      expect(listed.status).toBe(200);
      expect(badgerJob).toBeTruthy();
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        token,
        httpUrl: "/runtime/jobs?includeCompleted=true",
        responseBody: listedBody,
        runtimeJobs: listedBody.items,
        error: err,
      });
      throw err;
    }
    if (!badgerJob) return;

    const got = await app.request(`/runtime/jobs/${encodeURIComponent(badgerJob.jobId)}`, { headers: authHeader(token) });
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as { job?: { jobId?: string } };
    expect(gotBody.job?.jobId).toBe(badgerJob.jobId);

    console.info(`[${SUITE}:${label}] cancelling badger job ${badgerJob.jobId}`);
    const cancelled = await app.request(`/runtime/jobs/${encodeURIComponent(badgerJob.jobId)}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancelled.status).toBe(200);
    const cancelledBody = (await cancelled.json()) as { job?: { status?: string } };
    expect(cancelledBody.job?.status).toBe("cancelled");

    runtimeJobsStore.upsert({
      ...(runtimeJobsStore.get(badgerJob.jobId) as RuntimeJobRecord),
      status: "failed",
      stageCode: "failed",
      stageLabel: "Failed",
      cancelRequested: false,
      retryable: true,
      errorCode: "test_failure",
      errorMessage: "test_failure",
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    console.info(`[${SUITE}:${label}] retrying badger job`);
    const retried = await app.request(`/runtime/jobs/${encodeURIComponent(badgerJob.jobId)}/retry`, {
      method: "POST",
      headers,
    });
    const retriedBody = (await retried.json()) as { job?: { status?: string; stageCode?: string } };
    try {
      expect(retried.status).toBe(200);
      expect(retriedBody.job?.status).toBe("queued");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        jobId: badgerJob.jobId,
        httpUrl: `/runtime/jobs/${badgerJob.jobId}/retry`,
        httpStatus: retried.status,
        responseBody: retriedBody,
        error: err,
      });
      throw err;
    }
  });

  it("enforces app scope on module state endpoint @req RT-SEC-03", async () => {
    const label = "scope-enforce-module-state";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["parrot"]);
    const badgerState = await app.request("/modules/badger/state", { headers: authHeader(token) });
    const body = (await badgerState.json()) as { error?: string };
    try {
      expect(badgerState.status).toBe(403);
      expect(body.error).toBe("forbidden_scope");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        token,
        appsScope: ["parrot"],
        httpUrl: "/modules/badger/state",
        httpStatus: badgerState.status,
        responseBody: body,
        error: err,
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof cancels queued Badger runtime jobs through the shared route without requiring a module cancel command", async () => {
    const label = "badger-cancel-queued-no-module";
    console.info(`[${SUITE}:${label}] start`);
    const badgerModule = {
      execute: vi.fn(async () => ({
        response: {
          requestId: "unexpected",
          ok: false,
          result: null,
          error: {
            code: "invalid_command",
            message: "badger_execute_should_not_run",
            retryable: false,
            details: {},
          },
        },
      })),
      shutdown: vi.fn(),
      setEventPublisher: vi.fn(),
      getStateSummary: vi.fn(() => null),
    } as unknown as BadgerModule;
    setBadgerModuleForTests(badgerModule);

    runtimeJobsStore.upsert({
      jobId: "badger:ingest:user-route:job-queued-1",
      app: "badger",
      kind: "badger.ingest.media_file",
      lane: "background",
      status: "queued",
      stageCode: "ready",
      stageLabel: "Ready to start",
      progress: { mode: "none", completed: null, total: null, unit: null },
      payload: {
        userId: "user-route",
        matchedMediaId: "media-1",
        filename: "/tmp/queued.mkv",
      },
      outputs: {},
      errorCode: null,
      errorMessage: null,
      retryable: false,
      cancelRequested: false,
      priority: 0,
      dedupeKey: null,
      createdAt: "2026-03-23T10:00:00.000Z",
      updatedAt: "2026-03-23T10:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });

    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const cancelled = await app.request("/runtime/jobs/badger%3Aingest%3Auser-route%3Ajob-queued-1/cancel", {
      method: "POST",
      headers,
    });

    const body = (await cancelled.json()) as { job?: { status?: string; stageCode?: string } };
    try {
      expect(cancelled.status).toBe(200);
      expect(body.job?.status).toBe("cancelled");
      expect(body.job?.stageCode).toBe("cancelled");
      expect(badgerModule.execute).not.toHaveBeenCalled();
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-cancel-queued-no-module", {
        jobId: "badger:ingest:user-route:job-queued-1",
        httpUrl: "/runtime/jobs/badger:ingest:user-route:job-queued-1/cancel",
        httpStatus: cancelled.status,
        responseBody: body,
        extra: { badgerExecuteCalls: (badgerModule.execute as ReturnType<typeof vi.fn>).mock.calls.length },
        error: err,
      });
      throw err;
    }
  });

  it("rejects route/module mismatch command payloads", async () => {
    const label = "reject-route-module-mismatch";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["parrot", "badger"]);
    const res = await app.request("/modules/parrot/commands", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-1",
        module: "badger",
        command: "badger.sync.get_state",
        payload: {},
      }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    try {
      expect(res.status).toBe(403);
      expect(body.error?.code).toBe("forbidden_scope");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        httpUrl: "/modules/parrot/commands",
        httpStatus: res.status,
        responseBody: body,
        extra: { sentRouteModule: "parrot", sentBodyModule: "badger" },
        error: err,
      });
      throw err;
    }
  });

  it("returns module_not_installed for unavailable modules", async () => {
    const label = "module-not-installed";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["parrot"]);
    const res = await app.request("/modules/parrot/commands", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-2",
        module: "parrot",
        command: "parrot.sync.get_state",
        payload: {},
      }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    try {
      expect(res.status).toBe(404);
      expect(body.error?.code).toBe("module_not_installed");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        appsScope: ["parrot"],
        httpUrl: "/modules/parrot/commands",
        httpStatus: res.status,
        responseBody: body,
        error: err,
      });
      throw err;
    }
  });

  it("deduplicates commands by requestId per token @req RT-CMD-04", async () => {
    const label = "dedupe-by-request-id";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const requestBody = JSON.stringify({
      requestId: "req-dedupe",
      module: "badger",
      command: "badger.playback.list_active_sessions",
      payload: {},
    });
    const first = await app.request("/modules/badger/commands", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: requestBody,
    });
    const second = await app.request("/modules/badger/commands", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: requestBody,
    });
    const body1 = await first.json();
    const body2 = await second.json();
    try {
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(body1).toEqual(body2);
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        requestId: "req-dedupe",
        httpUrl: "/modules/badger/commands",
        extra: {
          firstStatus: first.status,
          secondStatus: second.status,
          firstBody: body1,
          secondBody: body2,
        },
        error: err,
      });
      throw err;
    }
  });

  it("supports badger ingest open/apply/list/get_state/close flow", async () => {
    const label = "badger-ingest-flow";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const open = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-ingest-open",
        module: "badger",
        command: "badger.ingest.open",
        payload: { userId: "user-a", config: {} },
      }),
    });
    const openBody = (await open.json()) as { ok: boolean; result?: { userId?: string; totalJobs?: number } };
    try {
      expect(open.status).toBe(200);
      expect(openBody.ok).toBe(true);
      expect(openBody.result?.userId).toBe("user-a");
      expect(openBody.result?.totalJobs).toBe(0);
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-ingest-flow", {
        command: "badger.ingest.open",
        httpStatus: open.status,
        responseBody: openBody,
        error: err,
      });
      throw err;
    }

    const apply = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-ingest-apply",
        module: "badger",
        command: "badger.ingest.apply",
        payload: {
          actions: [
            {
              type: "queue_files",
              files: [
                {
                  id: "job-1",
                  filename: "/tmp/movie.mkv",
                  sizeMb: 100,
                },
              ],
            },
            {
              type: "start_job",
              jobId: "job-1",
            },
          ],
        },
      }),
    });
    const applyBody = (await apply.json()) as {
      ok: boolean;
      result?: { changed?: boolean; totalJobs?: number };
    };
    try {
      expect(apply.status).toBe(200);
      expect(applyBody.ok).toBe(true);
      expect(applyBody.result?.changed).toBe(true);
      expect(applyBody.result?.totalJobs).toBe(1);
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-ingest-flow", {
        command: "badger.ingest.apply",
        httpStatus: apply.status,
        responseBody: applyBody,
        error: err,
      });
      throw err;
    }

    const listJobs = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-list-jobs",
        module: "badger",
        command: "badger.ingest.list_jobs",
        payload: {},
      }),
    });
    const body = (await listJobs.json()) as {
      ok: boolean;
      result?: {
        userId?: string | null;
        opened?: boolean;
        jobs?: Array<{ id?: string; status?: string }>;
        total?: number;
        listedAt?: string;
      };
    };
    try {
      expect(listJobs.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result?.userId).toBe("user-a");
      expect(body.result?.opened).toBe(true);
      expect(Array.isArray(body.result?.jobs)).toBe(true);
      expect(body.result?.jobs?.[0]?.id).toBe("job-1");
      expect(body.result?.jobs?.[0]?.status).toBe("transcoding");
      expect(typeof body.result?.total).toBe("number");
      expect(typeof body.result?.listedAt).toBe("string");
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-ingest-flow", {
        command: "badger.ingest.list_jobs",
        httpStatus: listJobs.status,
        responseBody: body,
        badgerJobs: body.result?.jobs,
        error: err,
      });
      throw err;
    }

    const state = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-ingest-state",
        module: "badger",
        command: "badger.ingest.get_state",
        payload: {},
      }),
    });
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as {
      ok: boolean;
      result?: { activeUserId?: string | null; opened?: boolean; totalJobs?: number };
    };
    expect(stateBody.ok).toBe(true);
    expect(stateBody.result?.activeUserId).toBe("user-a");
    expect(stateBody.result?.opened).toBe(true);
    expect(stateBody.result?.totalJobs).toBe(1);

    const close = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-ingest-close",
        module: "badger",
        command: "badger.ingest.close",
        payload: {},
      }),
    });
    expect(close.status).toBe(200);
    const closeBody = (await close.json()) as { ok: boolean; result?: { closed?: boolean } };
    expect(closeBody.ok).toBe(true);
    expect(closeBody.result?.closed).toBe(true);
  });

  it("rejects badger ingest apply when queue is not open", async () => {
    const label = "badger-ingest-apply-not-open";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const apply = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-ingest-apply-not-open",
        module: "badger",
        command: "badger.ingest.apply",
        payload: {
          actions: [],
        },
      }),
    });
    const body = (await apply.json()) as { ok: boolean; error?: { code?: string; message?: string } };
    try {
      expect(apply.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("invalid_payload");
      expect(String(body.error?.message ?? "")).toContain("not open");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        command: "badger.ingest.apply",
        httpStatus: apply.status,
        responseBody: body,
        error: err,
      });
      throw err;
    }
  });

  it("supports badger dummy_ingest start/upsert/get/list flow", async () => {
    const label = "badger-dummy-ingest-flow";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const start = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-dummy-start",
        module: "badger",
        command: "badger.dummy_ingest.start",
        payload: {
          userId: "user-dummy",
          jobId: "dummy-job-1",
          catalogId: 603,
          mediaType: "movie",
        },
      }),
    });
    const startBody = (await start.json()) as { ok: boolean; result?: { jobId?: string; status?: string } };
    try {
      expect(start.status).toBe(200);
      expect(startBody.ok).toBe(true);
      expect(startBody.result?.jobId).toBe("dummy-job-1");
      expect(startBody.result?.status).toBe("queued");
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-dummy-ingest-flow", {
        command: "badger.dummy_ingest.start",
        httpStatus: start.status,
        responseBody: startBody,
        error: err,
      });
      throw err;
    }

    const upsert = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-dummy-upsert",
        module: "badger",
        command: "badger.dummy_ingest.upsert_job",
        payload: {
          jobId: "dummy-job-1",
          userId: "user-dummy",
          catalogId: 603,
          mediaType: "movie",
          status: "running",
          progress: 45,
          stage: "uploading_assets",
          error: null,
        },
      }),
    });
    expect(upsert.status).toBe(200);
    const upsertBody = (await upsert.json()) as { ok: boolean; result?: { status?: string; progress?: number } };
    expect(upsertBody.ok).toBe(true);
    expect(upsertBody.result?.status).toBe("running");
    expect(upsertBody.result?.progress).toBe(45);

    const getJob = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-dummy-get",
        module: "badger",
        command: "badger.dummy_ingest.get_job",
        payload: { jobId: "dummy-job-1" },
      }),
    });
    expect(getJob.status).toBe(200);
    const getBody = (await getJob.json()) as { ok: boolean; result?: { id?: string; status?: string } };
    expect(getBody.ok).toBe(true);
    expect(getBody.result?.id).toBe("dummy-job-1");
    expect(getBody.result?.status).toBe("running");

    const list = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-dummy-list",
        module: "badger",
        command: "badger.dummy_ingest.list_jobs",
        payload: { userId: "user-dummy" },
      }),
    });
    const listBody = (await list.json()) as {
      ok: boolean;
      result?: { total?: number; jobs?: Array<{ id?: string; status?: string }> };
    };
    try {
      expect(list.status).toBe(200);
      expect(listBody.ok).toBe(true);
      expect(listBody.result?.total).toBe(1);
      expect(listBody.result?.jobs?.[0]?.id).toBe("dummy-job-1");
      expect(listBody.result?.jobs?.[0]?.status).toBe("running");
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-dummy-ingest-flow", {
        command: "badger.dummy_ingest.list_jobs",
        httpStatus: list.status,
        responseBody: listBody,
        badgerJobs: listBody.result?.jobs,
        error: err,
      });
      throw err;
    }
  });

  it("badger.playback.set_upload_policy drives the ingest upload gate (lease-based) and rejects bad payloads", async () => {
    const label = "badger-upload-policy";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };
    const send = async (requestId: string, payload: unknown) => {
      const res = await app.request("/modules/badger/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({ requestId, module: "badger", command: "badger.playback.set_upload_policy", payload }),
      });
      return { status: res.status, body: (await res.json()) as { ok: boolean; result?: Record<string, unknown>; error?: unknown } };
    };
    try {
      const active = await send("req-up-1", { mode: "pause", playbackActive: true });
      console.info(`[${SUITE}:${label}] active -> ${JSON.stringify(active.body)} gate=${JSON.stringify(uploadPlaybackGate.getState())}`);
      expect(active.body.ok).toBe(true);
      expect(active.body.result).toEqual({ mode: "pause", playbackActive: true, effective: "pause" });
      expect(uploadPlaybackGate.maxConcurrency()).toBe(0);

      const stopped = await send("req-up-2", { mode: "pause", playbackActive: false });
      expect(stopped.body.result).toEqual({ mode: "pause", playbackActive: false, effective: "full" });
      expect(uploadPlaybackGate.maxConcurrency()).toBe(Number.POSITIVE_INFINITY);

      const throttled = await send("req-up-3", { mode: "throttle", playbackActive: true, leaseMs: 5_000 });
      expect(throttled.body.result).toMatchObject({ effective: "throttle" });
      expect(uploadPlaybackGate.maxConcurrency()).toBe(2);

      const bad = await send("req-up-4", { mode: "turbo", playbackActive: true });
      expect(bad.body.ok).toBe(false);
      // A rejected payload leaves the gate as it was.
      expect(uploadPlaybackGate.getState().effective).toBe("throttle");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, { command: "badger.playback.set_upload_policy", summary: uploadPlaybackGate.getState(), error: err });
      throw err;
    } finally {
      uploadPlaybackGate.update({ mode: "full", playbackActive: false });
    }
  });

  it("@req MPV-PREV-06 badger.previews.get_status answers whether a video's previews are still to come, and rejects bad payloads", async () => {
    const label = "badger-previews-status";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };
    const send = async (requestId: string, payload: unknown) => {
      const res = await app.request("/modules/badger/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({ requestId, module: "badger", command: "badger.previews.get_status", payload }),
      });
      return { status: res.status, body: (await res.json()) as { ok: boolean; result?: Record<string, unknown>; error?: unknown } };
    };
    try {
      // No engine wired in this suite, so no catch-up pass: nothing has given up on the video, it is still to come.
      const pending = await send("req-prev-1", { formatId: "fmt-1" });
      console.info(`[${SUITE}:${label}] pending -> ${JSON.stringify(pending.body)}`);
      expect(pending.body.ok).toBe(true);
      expect(pending.body.result).toEqual({ formatId: "fmt-1", state: "pending", failures: 0, maxAttempts: 0 });
      const bad = await send("req-prev-2", {});
      console.info(`[${SUITE}:${label}] bad -> ${JSON.stringify(bad.body)}`);
      expect(bad.body.ok).toBe(false);
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, { command: "badger.previews.get_status", error: err });
      throw err;
    }
  });

  it("supports badger playback prepare/release/list command flow", async () => {
    const label = "badger-playback-flow";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const prepareStream = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-prepare-stream",
        module: "badger",
        command: "badger.playback.prepare_stream",
        payload: {
          sessionId: "stream-1",
          kind: "stream",
          url: "http://127.0.0.1:4444/playback/stream/stream-1",
          totalSize: 1_000_000,
          contentType: "video/mp4",
        },
      }),
    });
    const prepareStreamBody = (await prepareStream.json()) as {
      ok: boolean;
      result?: { sessionId?: string; kind?: string; releasedAt?: string | null };
    };
    try {
      expect(prepareStream.status).toBe(200);
      expect(prepareStreamBody.ok).toBe(true);
      expect(prepareStreamBody.result?.sessionId).toBe("stream-1");
      expect(prepareStreamBody.result?.kind).toBe("stream");
      expect(prepareStreamBody.result?.releasedAt).toBeNull();
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-playback-flow", {
        command: "badger.playback.prepare_stream",
        sessionId: "stream-1",
        httpStatus: prepareStream.status,
        responseBody: prepareStreamBody,
        error: err,
      });
      throw err;
    }

    const prepareHls = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-prepare-hls",
        module: "badger",
        command: "badger.playback.prepare_stream",
        payload: {
          sessionId: "hls-1",
          kind: "hls",
          url: "http://127.0.0.1:4444/playback/hls/hls-1/master.m3u8",
          mode: "vod",
          videoTrackCount: 3,
          audioTrackCount: 2,
        },
      }),
    });
    expect(prepareHls.status).toBe(200);

    const listActive = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-list-active",
        module: "badger",
        command: "badger.playback.list_active_sessions",
        payload: {},
      }),
    });
    const listActiveBody = (await listActive.json()) as {
      ok: boolean;
      result?: { total?: number; sessions?: Array<{ sessionId?: string; kind?: string; releasedAt?: string | null }> };
    };
    try {
      expect(listActive.status).toBe(200);
      expect(listActiveBody.ok).toBe(true);
      expect(listActiveBody.result?.total).toBe(2);
      expect(listActiveBody.result?.sessions?.some((session) => session.sessionId === "stream-1")).toBe(true);
      expect(listActiveBody.result?.sessions?.every((session) => session.releasedAt === null)).toBe(true);
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-playback-flow", {
        command: "badger.playback.list_active_sessions",
        httpStatus: listActive.status,
        responseBody: listActiveBody,
        extra: { sessions: listActiveBody.result?.sessions },
        error: err,
      });
      throw err;
    }

    const release = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-release",
        module: "badger",
        command: "badger.playback.release_stream",
        payload: {
          sessionId: "stream-1",
          kind: "stream",
        },
      }),
    });
    const releaseBody = (await release.json()) as {
      ok: boolean;
      result?: { released?: boolean; sessionId?: string };
    };
    try {
      expect(release.status).toBe(200);
      expect(releaseBody.ok).toBe(true);
      expect(releaseBody.result?.released).toBe(true);
      expect(releaseBody.result?.sessionId).toBe("stream-1");
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-playback-flow", {
        command: "badger.playback.release_stream",
        sessionId: "stream-1",
        httpStatus: release.status,
        responseBody: releaseBody,
        error: err,
      });
      throw err;
    }

    const listAll = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-list-all",
        module: "badger",
        command: "badger.playback.list_active_sessions",
        payload: { includeReleased: true },
      }),
    });
    expect(listAll.status).toBe(200);
    const listAllBody = (await listAll.json()) as {
      ok: boolean;
      result?: { total?: number; sessions?: Array<{ sessionId?: string; releasedAt?: string | null }> };
    };
    expect(listAllBody.ok).toBe(true);
    expect(listAllBody.result?.total).toBe(2);
    const released = listAllBody.result?.sessions?.find((session) => session.sessionId === "stream-1");
    expect(typeof released?.releasedAt).toBe("string");

    const metricsInitial = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-metrics-get-initial",
        module: "badger",
        command: "badger.playback.get_signed_url_metrics",
        payload: {},
      }),
    });
    expect(metricsInitial.status).toBe(200);
    const metricsInitialBody = (await metricsInitial.json()) as {
      ok: boolean;
      result?: { requests?: number; resetAt?: string };
    };
    expect(metricsInitialBody.ok).toBe(true);
    expect(metricsInitialBody.result?.requests).toBe(0);
    expect(typeof metricsInitialBody.result?.resetAt).toBe("string");

    const metricsRecord = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-metrics-record",
        module: "badger",
        command: "badger.playback.record_signed_url_request",
        payload: { increment: 3 },
      }),
    });
    expect(metricsRecord.status).toBe(200);
    const metricsRecordBody = (await metricsRecord.json()) as {
      ok: boolean;
      result?: { requests?: number };
    };
    expect(metricsRecordBody.ok).toBe(true);
    expect(metricsRecordBody.result?.requests).toBe(3);

    const metricsReset = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-metrics-reset",
        module: "badger",
        command: "badger.playback.reset_signed_url_metrics",
        payload: {},
      }),
    });
    expect(metricsReset.status).toBe(200);
    const metricsResetBody = (await metricsReset.json()) as {
      ok: boolean;
      result?: { requests?: number; resetAt?: string };
    };
    expect(metricsResetBody.ok).toBe(true);
    expect(metricsResetBody.result?.requests).toBe(0);
    expect(typeof metricsResetBody.result?.resetAt).toBe("string");
  });

  it("supports badger ffmpeg capability command flow", async () => {
    const label = "badger-ffmpeg-caps";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const ffmpegCaps = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-ffmpeg-caps",
        module: "badger",
        command: "badger.capabilities.get_ffmpeg",
        payload: {},
      }),
    });
    expect(ffmpegCaps.status).toBe(200);
    const ffmpegCapsBody = (await ffmpegCaps.json()) as { ok: boolean; result?: { preferredEncoder?: string } };
    expect(ffmpegCapsBody.ok).toBe(true);
    expect(typeof ffmpegCapsBody.result?.preferredEncoder).toBe("string");

    const ffmpegTest = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-ffmpeg-test",
        module: "badger",
        command: "badger.capabilities.test_ffmpeg",
        payload: {},
      }),
    });
    const ffmpegTestBody = (await ffmpegTest.json()) as { ok: boolean; result?: { ok?: boolean; encoder?: string } };
    try {
      expect(ffmpegTest.status).toBe(200);
      expect(ffmpegTestBody.ok).toBe(true);
      expect(typeof ffmpegTestBody.result?.ok).toBe("boolean");
      expect(typeof ffmpegTestBody.result?.encoder).toBe("string");
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-ffmpeg-caps", {
        command: "badger.capabilities.test_ffmpeg",
        httpStatus: ffmpegTest.status,
        responseBody: ffmpegTestBody,
        error: err,
      });
      throw err;
    }
  });

  it("generates playback session id when prepare_stream omits sessionId", async () => {
    const label = "playback-prepare-auto-session-id";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const prepare = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-playback-prepare-auto-id",
        module: "badger",
        command: "badger.playback.prepare_stream",
        payload: {
          kind: "stream",
        },
      }),
    });
    const body = (await prepare.json()) as {
      ok: boolean;
      result?: { sessionId?: string; kind?: string };
    };
    try {
      expect(prepare.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(typeof body.result?.sessionId).toBe("string");
      expect((body.result?.sessionId ?? "").length).toBeGreaterThan(8);
      expect(body.result?.kind).toBe("stream");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        command: "badger.playback.prepare_stream",
        sessionId: body.result?.sessionId,
        httpStatus: prepare.status,
        responseBody: body,
        error: err,
      });
      throw err;
    }
  });

  it("supports badger library state/snapshot command flow", async () => {
    const label = "badger-library-state-snapshot";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const stateBefore = await app.request("/modules/badger/state", { headers: authHeader(token) });
    const stateBeforeBody = (await stateBefore.json()) as {
      summary?: { library?: { totalSnapshots?: number; headSnapshotId?: string | null } };
    };
    try {
      expect(stateBefore.status).toBe(200);
      expect(stateBeforeBody.summary?.library?.totalSnapshots).toBe(0);
      expect(stateBeforeBody.summary?.library?.headSnapshotId ?? null).toBeNull();
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-library-state-snapshot", {
        httpUrl: "/modules/badger/state (before)",
        httpStatus: stateBefore.status,
        responseBody: stateBeforeBody,
        summary: stateBeforeBody.summary,
        error: err,
      });
      throw err;
    }

    const upsert = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-library-upsert",
        module: "badger",
        command: "badger.library.upsert_snapshot",
        payload: {
          snapshotId: "snap-1",
          version: 1,
          stateHash: "hash-1",
          mediaCount: 12,
          playlistCount: 3,
        },
      }),
    });
    expect(upsert.status).toBe(200);
    const upsertBody = (await upsert.json()) as { ok: boolean; result?: { isHead?: boolean } };
    expect(upsertBody.ok).toBe(true);
    expect(upsertBody.result?.isHead).toBe(true);

    const list = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-library-list",
        module: "badger",
        command: "badger.library.list_snapshots",
        payload: {},
      }),
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { ok: boolean; result?: { snapshots?: Array<{ snapshotId?: string }> } };
    expect(listBody.ok).toBe(true);
    expect(listBody.result?.snapshots?.[0]?.snapshotId).toBe("snap-1");

    const getHead = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-library-get-head",
        module: "badger",
        command: "badger.library.get_snapshot",
        payload: {},
      }),
    });
    expect(getHead.status).toBe(200);
    const getHeadBody = (await getHead.json()) as { ok: boolean; result?: { snapshotId?: string; version?: number } };
    expect(getHeadBody.ok).toBe(true);
    expect(getHeadBody.result?.snapshotId).toBe("snap-1");
    expect(getHeadBody.result?.version).toBe(1);

    const clear = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-library-clear",
        module: "badger",
        command: "badger.library.clear",
        payload: {},
      }),
    });
    expect(clear.status).toBe(200);
    const clearBody = (await clear.json()) as { ok: boolean; result?: { cleared?: number } };
    expect(clearBody.ok).toBe(true);
    expect(clearBody.result?.cleared).toBe(1);

    const stateAfter = await app.request("/modules/badger/state", { headers: authHeader(token) });
    const stateAfterBody = (await stateAfter.json()) as {
      summary?: { library?: { totalSnapshots?: number; headSnapshotId?: string | null } };
    };
    try {
      expect(stateAfter.status).toBe(200);
      expect(stateAfterBody.summary?.library?.totalSnapshots).toBe(0);
      expect(stateAfterBody.summary?.library?.headSnapshotId ?? null).toBeNull();
    } catch (err) {
      dumpRuntimeRoutesSnapshot("badger-library-state-snapshot", {
        httpUrl: "/modules/badger/state (after clear)",
        httpStatus: stateAfter.status,
        responseBody: stateAfterBody,
        summary: stateAfterBody.summary,
        error: err,
      });
      throw err;
    }
  });

  it("rejects badger library upsert when payload is invalid", async () => {
    const label = "badger-library-upsert-invalid";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const headers = { ...authHeader(token), "content-type": "application/json" };
    const invalid = await app.request("/modules/badger/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-badger-library-invalid",
        module: "badger",
        command: "badger.library.upsert_snapshot",
        payload: { version: -1 },
      }),
    });
    const body = (await invalid.json()) as { ok: boolean; error?: { code?: string } };
    try {
      expect(invalid.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("invalid_payload");
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        command: "badger.library.upsert_snapshot",
        httpStatus: invalid.status,
        responseBody: body,
        payload: { version: -1 },
        error: err,
      });
      throw err;
    }
  });

  it("invalidates token on logout", async () => {
    const label = "logout-invalidates-token";
    console.info(`[${SUITE}:${label}] start`);
    const app = createApp();
    const token = await login(app, ["badger"]);
    const logout = await app.request("/runtime/session/logout", {
      method: "POST",
      headers: authHeader(token),
    });
    try {
      expect(logout.status).toBe(200);
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        token,
        httpUrl: "/runtime/session/logout",
        httpStatus: logout.status,
        error: err,
      });
      throw err;
    }
    const modulesAfter = await app.request("/runtime/modules", { headers: authHeader(token) });
    try {
      expect(modulesAfter.status).toBe(401);
    } catch (err) {
      dumpRuntimeRoutesSnapshot(label, {
        token,
        httpUrl: "/runtime/modules (after logout)",
        httpStatus: modulesAfter.status,
        expected: 401,
        actual: modulesAfter.status,
        error: err,
      });
      throw err;
    }
  });
});
