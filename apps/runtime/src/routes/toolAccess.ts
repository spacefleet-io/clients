/**
 * DEV-LIB-01 routes: how a third-party tool asks for, receives and uses
 * library access, and how a first-party app decides and revokes it.
 *
 *  - Tool side (`/runtime/access/request`, `/runtime/access/requests/:id/token`,
 *    `/runtime/tool/:op`): a tool outside any browser, or a web page served from
 *    an allowed web origin (loopback or `RUNTIME_ALLOWED_ORIGINS`, PLAT-WEB-05);
 *    `null`, `file://` and any other origin are refused. A grant made from an
 *    origin works from that origin only. Tiny bounded bodies, no owner secret.
 *  - App side (`decide`, `snapshot`, `grants`): first-party app session only.
 *  - Desktop hand-off (PLAT-WEB-04): `GET /runtime/web/status` (no auth) tells
 *    the web player whether a desktop player listens; the desktop app reports
 *    its playback on `POST /runtime/handoff/:id/state` (app session).
 *  - Everything else is closed to tool sessions by `denyToolSessionsOutsideToolRoutes`.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TOOL_ACCESS_ERRORS,
  desktopHandoffReportSchema,
  isToolOperation,
  toolAccessDecisionSchema,
  toolAccessPollRequestSchema,
  toolAccessRequestSchema,
  type RuntimeWebStatus,
  type ToolAccessError,
} from "@space/tool-access/contracts";
import { readBearerToken, requireAppScope, requireToken } from "../auth";
import { desktopHandoff, runtimeState, toolAccess } from "../runtime";
import { getBadgerLibraryDbService } from "../modules";
import { runToolOperation } from "../core/toolOperations";
import type { ToolAccessFailure } from "../core/toolAccess";
import { isAllowedWebOrigin } from "../requestGuard";

/** Request and poll bodies are a few short strings. */
const ACCESS_BODY_LIMIT_BYTES = 2 * 1024;
/** A tool operation can carry a metadata edit, never a file. */
const TOOL_BODY_LIMIT_BYTES = 256 * 1024;

const TOOL_ROUTE_PREFIX = "/runtime/tool/";

const errorBody = (error: ToolAccessError, message: string) => ({ error, message });

const tooLarge = bodyLimit({
  maxSize: ACCESS_BODY_LIMIT_BYTES,
  onError: (c) => c.json(errorBody(TOOL_ACCESS_ERRORS.payloadTooLarge, "Request body too large."), 413),
});
const toolBodyTooLarge = bodyLimit({
  maxSize: TOOL_BODY_LIMIT_BYTES,
  onError: (c) => c.json(errorBody(TOOL_ACCESS_ERRORS.payloadTooLarge, "Request body too large."), 413),
});

/**
 * A browser attaches `Origin` to cross-origin requests and to every POST. A
 * tool route answers a web page only from an allowed web origin (PLAT-WEB-05:
 * the Badger web player); the opaque `null` (sandboxed frames, desktop
 * renderers), `file://` and every other origin are refused. No `Origin`: a
 * tool outside any browser, unchanged.
 */
const allowWebOriginOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && !isAllowedWebOrigin(origin)) {
    console.info("[handoff] tool route refused for origin", { path: c.req.path, origin });
    return c.json(errorBody(TOOL_ACCESS_ERRORS.forbiddenOrigin, "Tool access is not available from this origin."), 403);
  }
  await next();
};

/** The caller's browser origin, already checked by {@link allowWebOriginOnly}; null outside a browser. */
const callerOrigin = (c: Context): string | null => c.req.header("origin") ?? null;

/**
 * Default deny, in one place: a tool session may reach `/runtime/tool/*` and
 * nothing else, whatever route exists now or is added later.
 */
export const denyToolSessionsOutsideToolRoutes: MiddlewareHandler = async (c, next) => {
  const token = readBearerToken(c.req.header("authorization") ?? null);
  if (token && !c.req.path.startsWith(TOOL_ROUTE_PREFIX) && runtimeState.requireSession(token)?.kind === "tool") {
    return c.json(errorBody(TOOL_ACCESS_ERRORS.toolNotAllowed, "This route is not available to tools."), 403);
  }
  await next();
};

const failureResponse = (c: Context, failure: ToolAccessFailure) => {
  if (failure.retryAfterSeconds) c.header("Retry-After", String(failure.retryAfterSeconds));
  return c.json(errorBody(failure.error, failure.message), failure.status);
};

/** The body of a tool call: empty means `{}`; anything not JSON is a 400. */
const readJsonBody = async (c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> => {
  const text = await c.req.text();
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

/** First-party app session (kind `app`, badger scope) or a refusal response. */
const requireAppSession = (c: Context): { ok: true } | { ok: false; response: Response } => {
  const token = requireToken(c.req.header("authorization") ?? null);
  if (!token) {
    const bearer = readBearerToken(c.req.header("authorization") ?? null);
    const isTool = bearer ? runtimeState.requireSession(bearer)?.kind === "tool" : false;
    return {
      ok: false,
      response: isTool
        ? c.json(errorBody(TOOL_ACCESS_ERRORS.notAppSession, "Only a SpaceFleet app can do this."), 403)
        : c.json(errorBody(TOOL_ACCESS_ERRORS.unauthorized, "Unauthorized."), 401),
    };
  }
  if (!requireAppScope(token, "badger")) {
    return { ok: false, response: c.json(errorBody(TOOL_ACCESS_ERRORS.notAppSession, "Only a SpaceFleet app can do this."), 403) };
  }
  return { ok: true };
};

export const registerToolAccessRoutes = (app: Hono) => {
  // ---- tool side ----

  app.post("/runtime/access/request", allowWebOriginOnly, tooLarge, async (c) => {
    const body = await readJsonBody(c);
    const parsed = body.ok ? toolAccessRequestSchema.safeParse(body.value) : null;
    if (!parsed?.success) {
      return c.json(errorBody(TOOL_ACCESS_ERRORS.invalidPayload, "Expected { toolName, reason?, mode: 'read' | 'write' }."), 400);
    }
    const result = toolAccess.request(parsed.data, callerOrigin(c));
    if (!result.ok) return failureResponse(c, result);
    c.header("Cache-Control", "no-store");
    return c.json({
      requestId: result.requestId,
      pollSecret: result.pollSecret,
      verificationCode: result.verificationCode,
      expiresAt: result.expiresAt,
    });
  });

  app.post("/runtime/access/requests/:id/token", allowWebOriginOnly, tooLarge, async (c) => {
    const body = await readJsonBody(c);
    const parsed = body.ok ? toolAccessPollRequestSchema.safeParse(body.value) : null;
    if (!parsed?.success) {
      return c.json(errorBody(TOOL_ACCESS_ERRORS.invalidPayload, "Expected { pollSecret }."), 400);
    }
    const result = toolAccess.poll(c.req.param("id"), parsed.data.pollSecret, callerOrigin(c));
    if (!result.ok) return failureResponse(c, result);
    c.header("Cache-Control", "no-store");
    if (result.status === 202) return c.json({ status: "pending" }, 202);
    return c.json(result.body, 200);
  });

  app.post("/runtime/tool/:op", allowWebOriginOnly, toolBodyTooLarge, async (c) => {
    // No live session is still a bearer: after a restart a stored web grant (PLAT-WEB-06) has none until `authorize` restores it by digest.
    const token = readBearerToken(c.req.header("authorization") ?? null);
    if (!token) return c.json(errorBody(TOOL_ACCESS_ERRORS.unauthorized, "Unauthorized."), 401);
    // RT-SEC-02: a token the runtime does not know is a 401, before any 403 about the operation.
    const session = runtimeState.requireSession(token);
    if (!session && !toolAccess.hasStoredGrant(token)) {
      return c.json(errorBody(TOOL_ACCESS_ERRORS.unauthorized, "Unauthorized."), 401);
    }
    const operation = c.req.param("op");
    // Default deny: anything not on the list is refused, whoever asks.
    if (!isToolOperation(operation)) {
      return c.json(errorBody(TOOL_ACCESS_ERRORS.toolNotAllowed, "This operation is not available to tools."), 403);
    }
    // `/runtime/tool/*` is for grants: an app session is refused here too.
    if (session && session.kind !== "tool") {
      return c.json(errorBody(TOOL_ACCESS_ERRORS.toolNotAllowed, "This route is for tool sessions."), 403);
    }
    const authorized = toolAccess.authorize(token, operation, callerOrigin(c));
    if (!authorized.ok) return failureResponse(c, authorized);
    const body = await readJsonBody(c);
    if (!body.ok) return c.json(errorBody(TOOL_ACCESS_ERRORS.invalidPayload, "Body must be JSON."), 400);
    const result = await runToolOperation(getBadgerLibraryDbService(), operation, body.value, {
      grantId: authorized.grantId,
      handoff: desktopHandoff,
    });
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(errorBody(result.error, result.message), result.status);
  });

  // ---- desktop hand-off (PLAT-WEB-04 / PLAT-WEB-05) ----

  // No auth: the web player asks before it holds a grant whether a desktop player is there.
  app.get("/runtime/web/status", (c) => {
    c.header("Cache-Control", "no-store");
    const status: RuntimeWebStatus = { runtime: "spacefleet", desktopPlayer: desktopHandoff.hasDesktopPlayer() };
    return c.json(status);
  });

  // The desktop app reports what its player does with a hand-off.
  app.post("/runtime/handoff/:id/state", tooLarge, async (c) => {
    const gate = requireAppSession(c);
    if (!gate.ok) return gate.response;
    const body = await readJsonBody(c);
    const parsed = body.ok ? desktopHandoffReportSchema.safeParse(body.value) : null;
    if (!parsed?.success) {
      return c.json(
        errorBody(
          TOOL_ACCESS_ERRORS.invalidPayload,
          "Expected { state: 'starting' | 'playing' | 'closed' | 'failed', positionSeconds?, durationSeconds?, error? }."
        ),
        400
      );
    }
    const result = desktopHandoff.report(c.req.param("id"), parsed.data);
    if (!result.ok) return c.json(errorBody(TOOL_ACCESS_ERRORS.notFound, "No such hand-off."), 404);
    return c.json(result.ignored ? { ok: true, ignored: true } : { ok: true });
  });

  // ---- app side ----

  app.get("/runtime/access/snapshot", (c) => {
    const gate = requireAppSession(c);
    if (!gate.ok) return gate.response;
    c.header("Cache-Control", "no-store");
    return c.json(toolAccess.snapshot());
  });

  app.get("/runtime/access/grants", (c) => {
    const gate = requireAppSession(c);
    if (!gate.ok) return gate.response;
    c.header("Cache-Control", "no-store");
    return c.json({ grants: toolAccess.snapshot().grants });
  });

  app.post("/runtime/access/requests/:id/decide", tooLarge, async (c) => {
    const gate = requireAppSession(c);
    if (!gate.ok) return gate.response;
    const body = await readJsonBody(c);
    const parsed = body.ok ? toolAccessDecisionSchema.safeParse(body.value) : null;
    if (!parsed?.success) {
      return c.json(errorBody(TOOL_ACCESS_ERRORS.invalidPayload, "Expected { decision: 'approve' | 'deny', mode? }."), 400);
    }
    const result = toolAccess.decide(c.req.param("id"), parsed.data.decision, parsed.data.mode);
    if (!result.ok) return failureResponse(c, result);
    return c.json({ ok: true });
  });

  app.delete("/runtime/access/grants/:id", (c) => {
    const gate = requireAppSession(c);
    if (!gate.ok) return gate.response;
    if (!toolAccess.revoke(c.req.param("id"))) {
      return c.json(errorBody(TOOL_ACCESS_ERRORS.notFound, "No such grant."), 404);
    }
    return c.json({ ok: true });
  });

  // Sign-out: every grant ends at once.
  app.delete("/runtime/access/grants", (c) => {
    const gate = requireAppSession(c);
    if (!gate.ok) return gate.response;
    return c.json({ ok: true, revoked: toolAccess.revokeAll() });
  });
};
