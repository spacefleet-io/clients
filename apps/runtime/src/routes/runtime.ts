import type { Hono } from "hono";
import { APP_IDS, type AppId } from "../types";
import { runtimeState, lifecycleManager, ownerLoginGate, toolAccess } from "../runtime";
import { runtimeKeyStore } from "../core/keys/store";
import { onKeySet } from "../modules";
import { requireToken } from "../auth";
import { cancelRuntimeJob, getRuntimeJob, listRuntimeJobs, retryRuntimeJob } from "../modules";
import type { RuntimeJobFilter, RuntimeJobStatus } from "@space/runtime-jobs";
import { publishAndDriveRuntimeJobsUpdate, publishRuntimeJobsUpdate } from "../core/jobs/events";
import { runtimeJobWorker } from "../core/jobs/worker";
import { runtimeEventLoopMonitor } from "../core/eventLoopMonitor";
import {
  runtimeLoginRequestSchema,
  runtimeConnectRequestSchema,
  runtimeDisconnectRequestSchema,
} from "@space/runtime-contracts";

const toAppScopes = (value: unknown): AppId[] | null => {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const scopes: AppId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !APP_IDS.includes(entry as AppId)) return null;
    scopes.push(entry as AppId);
  }
  return scopes;
};

export const registerRuntimeRoutes = (app: Hono) => {
  const parseJobFilter = (query: Record<string, string | undefined>): RuntimeJobFilter => {
    const parseCsv = (value: string | undefined) =>
      value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    const appId = query.app;
    const app = appId && APP_IDS.includes(appId as AppId) ? (appId as AppId) : undefined;
    const statuses = parseCsv(query.status) as RuntimeJobStatus[];
    const limitRaw = query.limit ? Number(query.limit) : NaN;
    return {
      ...(app ? { app } : {}),
      ...(statuses.length > 0 ? { status: statuses } : {}),
      ...(parseCsv(query.kind).length > 0 ? { kind: parseCsv(query.kind) } : {}),
      includeCompleted: query.includeCompleted === "true",
      ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
    };
  };

  app.post("/runtime/session/login", async (c) => {
    // RT-SEC-05: before anything else, so an unauthorised caller learns nothing, not even whether its payload parses.
    const refusal = ownerLoginGate.authorize(c.req.raw.headers);
    if (refusal) {
      if (refusal.retryAfterSeconds) c.header("Retry-After", String(refusal.retryAfterSeconds));
      return c.json({ error: refusal.error }, refusal.status);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeLoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const scopes = toAppScopes(parsed.data.apps);
    if (scopes === null) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const session = runtimeState.login(parsed.data.backendToken.trim(), scopes, parsed.data.userId);
    return c.json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      capabilities: {
        apps: session.scopes,
      },
    });
  });

  app.post("/runtime/session/refresh", (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.refresh(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    return c.json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      capabilities: {
        apps: session.scopes,
      },
    });
  });

  app.post("/runtime/session/logout", (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    runtimeState.logout(token);
    return c.json({ ok: true });
  });

  app.get("/runtime/health", (c) => {
    return c.json({
      ok: true,
      service: "spacefleet-runtime",
      modules: runtimeState.getModules(),
      ts: new Date().toISOString(),
      pid: process.pid,
      // #25 P1: lets the guardian log how late this runtime's loop runs.
      eventLoop: runtimeEventLoopMonitor.snapshot(),
    });
  });

  app.post("/runtime/connect", async (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeConnectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    // RT-SEC-03: a session registers connections only for the apps it is scoped to.
    if (!session.scopes.has(parsed.data.appName as AppId)) return c.json({ error: "forbidden_scope" }, 403);
    const result = lifecycleManager.onAppConnected(runtimeState, token, parsed.data.appName, parsed.data.pid);
    return c.json({
      ...result,
      connectedApps: result.connectedApps.filter((entry) => session.scopes.has(entry.appName as AppId)),
    });
  });

  app.post("/runtime/disconnect", async (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeDisconnectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const owner = runtimeState.getConnectionApp(parsed.data.connectionId);
    if (owner !== null && !session.scopes.has(owner as AppId)) return c.json({ error: "forbidden_scope" }, 403);
    const result = lifecycleManager.onAppDisconnected(runtimeState, parsed.data.connectionId);
    if (!result.found) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true, remaining: result.remaining });
  });

  app.get("/runtime/connections", (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    return c.json({ connections: runtimeState.getConnections(session.scopes) });
  });

  app.get("/runtime/modules", (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    return c.json({ modules: runtimeState.getModules().filter((entry) => session.scopes.has(entry.app)) });
  });

  app.get("/runtime/jobs", async (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const items = await listRuntimeJobs(parseJobFilter(c.req.query()), [...session.scopes]);
    return c.json({ items });
  });

  app.get("/runtime/jobs/:jobId", async (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const job = await getRuntimeJob(c.req.param("jobId"), [...session.scopes]);
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json({ job });
  });

  app.post("/runtime/jobs/:jobId/cancel", async (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const result = await cancelRuntimeJob(c.req.param("jobId"), [...session.scopes]);
    if (!result.job || !result.app) return c.json({ error: "not_found" }, 404);
    publishRuntimeJobsUpdate(({ app, channel, event, payload }) => runtimeState.publish(app, channel, event, payload), {
      app: result.app,
      sourceChannel: "runtime.jobs",
      sourceEvent: "runtime.jobs.cancel",
      jobs: [result.job],
    });
    return c.json({ job: result.job });
  });

  app.post("/runtime/jobs/:jobId/retry", async (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const result = await retryRuntimeJob(c.req.param("jobId"), [...session.scopes]);
    if (!result.job || !result.app) return c.json({ error: "not_found" }, 404);
    publishAndDriveRuntimeJobsUpdate(
      ({ app, channel, event, payload }) => runtimeState.publish(app, channel, event, payload),
      () => runtimeJobWorker.kick(),
      {
        app: result.app,
        sourceChannel: "runtime.jobs",
        sourceEvent: "runtime.jobs.retry",
        jobs: [result.job],
      }
    );
    return c.json({ job: result.job });
  });

  app.post("/runtime/keys/set", async (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const userId = session.userId;
    if (!userId) return c.json({ error: "missing_user_id", message: "Session has no userId. Pass userId during login." }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.masterKeyBase64 !== "string" || !body.masterKeyBase64.trim()) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const keyBase64 = body.masterKeyBase64.trim();
    const raw = Buffer.from(keyBase64, "base64");
    if (raw.byteLength !== 32) {
      return c.json({ error: "invalid_key_length", message: "Key must be exactly 32 bytes when base64-decoded" }, 400);
    }
    runtimeKeyStore.set(userId, keyBase64);
    onKeySet(userId, keyBase64, session.backendToken, "live");
    // Another account's key means a grant approved for the previous one must not follow it.
    toolAccess.revokeForOtherUsers(userId);
    return c.json({ ok: true });
  });

  app.get("/runtime/keys/status", (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const session = runtimeState.requireSession(token);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const userId = session.userId;
    return c.json({ ok: true, ...runtimeKeyStore.status(userId ?? null) });
  });
};
