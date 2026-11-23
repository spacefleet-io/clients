import type { Hono } from "hono";
import { APP_IDS, type AppId, type RuntimeCommandResponse } from "../types";
import { requireAppScope, requireToken } from "../auth";
import { isValidCommandResponse, parseCommandRequest } from "../validation";
import { runtimeState } from "../runtime";
import { executeModuleCommand, getModuleStateSummary, setModuleEventPublisher } from "../modules";
import { decodeWireBytes, encodeWireBytes } from "@space/runtime-contracts/wireBytes";
import { syncRuntimeJobsFromModuleCommand, syncRuntimeJobsFromModuleEvent } from "../core/jobs/adapters";
import { publishAndDriveRuntimeJobsUpdate } from "../core/jobs/events";
import { runtimeJobWorker } from "../core/jobs/worker";
import { runtimeEventLoopMonitor } from "../core/eventLoopMonitor";

/** A command slower than this is logged with its name and duration (#25 P1):
 *  the HTTP access log only says `POST /modules/badger/commands 200 47s`. */
const SLOW_COMMAND_LOG_MS = 1_000;

const isApp = (value: string): value is AppId => APP_IDS.includes(value as AppId);

setModuleEventPublisher((module, channel, event, payload) => {
  const syncedJobs = syncRuntimeJobsFromModuleEvent(module, channel, event, payload);
  runtimeState.publish(module, channel, event, payload);
  const isBadgerJobsEvent = module === "badger" && channel === "ingest" && event.startsWith("ingest.jobs");
  if (isBadgerJobsEvent && syncedJobs.length > 0) {
    publishAndDriveRuntimeJobsUpdate(
      ({ app, channel, event, payload }) => runtimeState.publish(app, channel, event, payload),
      () => runtimeJobWorker.drainNow(),
      {
        app: module,
        sourceChannel: `${module}.${channel}`,
        sourceEvent: `${module}.${event}`,
        jobs: syncedJobs,
      }
    );
  }
});

export const registerModuleRoutes = (app: Hono) => {
  app.get("/modules/:app/state", (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const appId = c.req.param("app");
    if (!isApp(appId)) return c.json({ error: "invalid_payload" }, 400);
    if (!requireAppScope(token, appId)) return c.json({ error: "forbidden_scope" }, 403);
    const module = runtimeState.getModule(appId);
    if (!module?.installed) return c.json({ error: "module_not_installed" }, 404);
    if (!module.ready) return c.json({ error: "module_not_ready" }, 503);
    const moduleSummary = getModuleStateSummary(appId);
    return c.json({
      app: module.app,
      status: module.status,
      lastUpdatedAt: new Date().toISOString(),
      summary: {
        installed: module.installed,
        ready: module.ready,
        ...(moduleSummary ?? {}),
      },
    });
  });

  app.post("/modules/:app/commands", async (c) => {
    const token = requireToken(c.req.header("authorization") ?? null);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const appId = c.req.param("app");
    if (!isApp(appId)) return c.json({ error: "invalid_payload" }, 400);
    if (!requireAppScope(token, appId)) return c.json({ error: "forbidden_scope" }, 403);

    const body = await c.req.json().catch(() => null);
    const req = parseCommandRequest(body);
    if (!req) {
      return c.json(
        {
          requestId: "unknown",
          ok: false,
          result: null,
          error: {
            code: "invalid_payload",
            message: "Invalid command envelope",
            retryable: false,
            details: {},
          },
        },
        400
      );
    }
    if (req.module !== appId) {
      return c.json(
        {
          requestId: req.requestId,
          ok: false,
          result: null,
          error: {
            code: "forbidden_scope",
            message: "Route/module scope mismatch",
            retryable: false,
            details: {},
          },
        },
        403
      );
    }

    const module = runtimeState.getModule(appId);
    if (!module?.installed) {
      return c.json(
        {
          requestId: req.requestId,
          ok: false,
          result: null,
          error: {
            code: "module_not_installed",
            message: `Module ${appId} is not installed`,
            retryable: false,
            details: {},
          },
        },
        404
      );
    }
    if (!module.ready) {
      return c.json(
        {
          requestId: req.requestId,
          ok: false,
          result: null,
          error: {
            code: "module_not_ready",
            message: `Module ${appId} is not ready`,
            retryable: true,
            details: {},
          },
        },
        503
      );
    }

    const cached = runtimeState.getCachedResult(token, req.requestId);
    if (cached) return c.json(cached);

    const session = runtimeState.requireSession(token);
    let response: RuntimeCommandResponse;
    let event: { channel: string; event: string; payload: Record<string, unknown> } | undefined;
    const label = `${req.module}:${req.command}`;
    const commandStartedAt = Date.now();
    const settle = runtimeEventLoopMonitor.track(label);
    try {
      // RT-CMD-05: tagged bytes in the payload become Uint8Arrays again before the module sees them.
      const executed = await executeModuleCommand({ ...req, payload: decodeWireBytes(req.payload) }, {
        backendToken: session?.backendToken ?? null,
        userId: session?.userId ?? null,
      });
      response = executed.response;
      event = executed.event;
    } catch (cause) {
      settle();
      const message = cause instanceof Error ? cause.message : "Internal server error";
      console.error(
        `[runtime] command failed ${JSON.stringify({ command: label, ms: Date.now() - commandStartedAt, requestId: req.requestId, message })}`,
        cause instanceof Error ? cause.stack : undefined
      );
      return c.json(
        {
          requestId: req.requestId,
          ok: false,
          result: null,
          error: {
            code: "internal_error",
            message,
            retryable: false,
            details: {},
          },
        },
        500
      );
    }
    settle();
    const commandMs = Date.now() - commandStartedAt;
    if (commandMs >= SLOW_COMMAND_LOG_MS) {
      console.warn(
        `[runtime] slow command ${JSON.stringify({ command: label, ms: commandMs, requestId: req.requestId, ok: response.ok, eventLoop: runtimeEventLoopMonitor.snapshot() })}`,
      );
    }
    if (!isValidCommandResponse(response)) {
      return c.json(
        {
          requestId: req.requestId,
          ok: false,
          result: null,
          error: {
            code: "internal_error",
            message: "Invalid response envelope",
            retryable: false,
            details: {},
          },
        },
        500
      );
    }
    // RT-CMD-05: bytes in the result travel tagged (plain JSON would send an index-keyed object); the remembered
    // answer is the wire form, so a resend gets the same bytes.
    const wire = encodeWireBytes(response);
    runtimeState.setCachedResult(token, req.requestId, wire);
    const syncedJobs = syncRuntimeJobsFromModuleCommand(req, response);
    let syncedEventJobs: ReturnType<typeof syncRuntimeJobsFromModuleEvent> = [];
    if (response.ok && event) {
      syncedEventJobs = syncRuntimeJobsFromModuleEvent(req.module, event.channel, event.event, event.payload);
      runtimeState.publish(req.module, event.channel, event.event, {
        requestId: req.requestId,
        ...event.payload,
      });
    } else if (response.ok) {
      runtimeState.publish(req.module, "sync", "sync.command_accepted", {
        requestId: req.requestId,
        command: req.command,
      });
    }
    const combinedSyncedJobs =
      response.ok && (syncedJobs.length > 0 || syncedEventJobs.length > 0)
        ? [...syncedJobs, ...syncedEventJobs].reduce<typeof syncedJobs>((acc, job) => {
            if (acc.some((existing) => existing.jobId === job.jobId)) return acc;
            acc.push(job);
            return acc;
          }, [])
        : [];
    if (response.ok && combinedSyncedJobs.length > 0) {
      publishAndDriveRuntimeJobsUpdate(
        ({ app, channel, event, payload }) => runtimeState.publish(app, channel, event, payload),
        () => runtimeJobWorker.drainNow(),
        {
          app: req.module,
          requestId: req.requestId,
          sourceChannel: `${req.module}.command`,
          sourceEvent: req.command,
          jobs: combinedSyncedJobs,
        }
      );
    }
    const status = response.ok
      ? 200
      : response.error.code === "invalid_payload"
        ? 400
        : response.error.code === "invalid_command"
          ? 400
          : response.error.code === "forbidden_scope"
            ? 403
            : response.error.code === "module_not_installed"
              ? 404
        : response.error.code === "module_not_ready"
          ? 503
          : response.error.code === "quota_exceeded"
            ? 409
          : 400;
    return c.json(wire, status);
  });
};
