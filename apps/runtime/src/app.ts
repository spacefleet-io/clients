import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { guardRequest, resolveCorsAcaoOrigin } from "./requestGuard";
import { RUNTIME_OWNER_HEADER } from "@space/runtime-contracts/lifecycle";
import { registerRuntimeRoutes } from "./routes/runtime";
import { registerModuleRoutes } from "./routes/modules";
import { denyToolSessionsOutsideToolRoutes, registerToolAccessRoutes } from "./routes/toolAccess";
import {
  registerRuntimeJobsV2Routes,
  type RuntimeJobsV2Handler,
} from "./routes/runtimeJobsV2";

export const createApp = () => {
  const app = new Hono();

  // The desktop polls /runtime/health every 5 s; its access line was most of an
  // idle runtime.log (issue #671 R8). Packaged builds run with NODE_ENV=production
  // and skip it; dev keeps every access line.
  const accessLog = logger();
  app.use("*", (c, next) =>
    c.req.path === "/runtime/health" && process.env.NODE_ENV === "production" ? next() : accessLog(c, next)
  );
  // Host / Origin lockdown first: a refused request must not reach cors() (no
  // Access-Control headers on the 403) or any route.
  app.use("*", async (c, next) => guardRequest(c.req.raw) ?? (await next()));
  app.use(
    "*",
    cors({
      origin: (origin) => resolveCorsAcaoOrigin(origin || null),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "Last-Event-ID", RUNTIME_OWNER_HEADER],
    })
  );
  // DEV-LIB-01: tool sessions reach `/runtime/tool/*` and nothing else.
  app.use("*", denyToolSessionsOutsideToolRoutes);

  registerToolAccessRoutes(app);
  // V2 routes register FIRST, before the legacy parameterized routes in
  // `registerRuntimeRoutes`. Hono matches routes in registration order, and
  // `app.post("/runtime/jobs/:jobId/cancel")` / `:jobId/retry` will capture
  // `/runtime/jobs/v2/cancel` and `/runtime/jobs/v2/retry` (with jobId="v2")
  // unless our concrete v2 paths register first. The legacy routes do their
  // own auth-check, so a captured request returns 401 instead of reaching
  // the v2 handler — this was the cause of the verifier's 401-on-/cancel
  // and 401-on-/retry observation. Keep this ordering.
  registerRuntimeJobsV2Routes(app, () => runtimeJobsV2Handler);
  registerRuntimeRoutes(app);
  registerModuleRoutes(app);
  return app;
};

// Singleton hook for Phase D to inject the handler. Kept as a module-level
// mutable so the route registration above can lazily resolve it via the
// closure passed to `registerRuntimeJobsV2Routes`.
let runtimeJobsV2Handler: RuntimeJobsV2Handler | null = null;
export const setRuntimeJobsV2Handler = (handler: RuntimeJobsV2Handler | null) => {
  runtimeJobsV2Handler = handler;
};
export const getRuntimeJobsV2Handler = (): RuntimeJobsV2Handler | null =>
  runtimeJobsV2Handler;
