/**
 * RT-SEC-02 sweep: every route the runtime serves needs a live session token,
 * except `POST /runtime/session/login` and `GET /runtime/health`.
 *
 * The route table comes from the Hono app itself, so a route added later is
 * covered automatically and fails here until it checks the token (or is
 * deliberately added to the public allowlist below).
 */

import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createRuntimeServerDefinition } from "../src/index";
import { ownerLoginGate, runtimeState } from "../src/runtime";
import { __resetEngineV2BootStatusForTests, setEngineV2BootStatus } from "../src/core/jobs/engineV2BootStatus";

/**
 * The only routes reachable without a session. The two tool-access routes
 * are how a tool that has no session yet gets one (DEV-LIB-01): the first
 * answers only while an app is listening and never hands out anything but a
 * poll secret, the second needs that secret; neither accepts a browser
 * `Origin` other than an allowed web origin (`runtime-tool-access.test.ts`).
 * `GET /runtime/web/status` tells the web player, before it holds a grant,
 * whether a desktop player listens: one boolean (PLAT-WEB-05,
 * `runtime-desktop-handoff.test.ts`).
 */
const PUBLIC_ROUTES: Record<string, true> = {
  "POST /runtime/session/login": true,
  "GET /runtime/health": true,
  "POST /runtime/access/request": true,
  "POST /runtime/access/requests/probe/token": true,
  "GET /runtime/web/status": true,
};

type Probe = { method: string; path: string; key: string };

/** One concrete (method, path) per registered route; `ALL` routes get GET and POST. */
const collectProbes = (): Probe[] => {
  const seen: Record<string, Probe> = {};
  for (const route of createApp().routes) {
    // `app.use("*", …)` middleware entries are not endpoints.
    if (route.path === "*" || route.path === "/*") continue;
    const path = route.path.replace(/:[A-Za-z0-9_]+/g, "probe").replace(/\*/g, "probe");
    const methods = route.method === "ALL" ? ["GET", "POST"] : [route.method];
    for (const method of methods) {
      const key = `${method} ${route.path}`;
      seen[`${method} ${path}`] = { method, path, key };
    }
  }
  return Object.values(seen);
};

const request = (app: Hono, probe: Probe, authorization?: string) =>
  app.request(probe.path, {
    method: probe.method,
    headers: {
      ...(probe.method === "POST" ? { "content-type": "application/json" } : {}),
      ...(authorization ? { authorization } : {}),
    },
    ...(probe.method === "POST" ? { body: "{}" } : {}),
  });

const isPublic = (probe: Probe) => Object.hasOwn(PUBLIC_ROUTES, `${probe.method} ${probe.path}`);

beforeEach(() => {
  runtimeState.resetForTests();
  __resetEngineV2BootStatusForTests();
});

describe("runtime route auth sweep", () => {
  const probes = collectProbes();

  it("enumerates the real route table and the public allowlist is not stale @req RT-SEC-02[runtime]", () => {
    expect(probes.length).toBeGreaterThan(15);
    for (const publicKey of Object.keys(PUBLIC_ROUTES)) {
      expect(probes.map((p) => `${p.method} ${p.path}`)).toContain(publicKey);
    }
    // The v2 job routes and the module routes are part of the sweep.
    expect(probes.some((p) => p.path === "/runtime/jobs/v2/list")).toBe(true);
    expect(probes.some((p) => p.path === "/modules/probe/commands")).toBe(true);
  });

  it("answers 401 to every non-public route without a token @req RT-SEC-02[runtime]", async () => {
    const app = createApp();
    const offenders: string[] = [];
    for (const probe of probes) {
      if (isPublic(probe)) continue;
      const res = await request(app, probe);
      if (res.status !== 401) offenders.push(`${probe.method} ${probe.path} -> ${res.status}`);
    }
    expect(offenders).toEqual([]);
  });

  it("answers 401 to every non-public route with a junk or malformed token @req RT-SEC-02[runtime]", async () => {
    const app = createApp();
    const offenders: string[] = [];
    for (const authorization of ["Bearer rt_not_a_session", "Bearer ", "Basic abc", "rt_bare_token"]) {
      for (const probe of probes) {
        if (isPublic(probe)) continue;
        const res = await request(app, probe, authorization);
        if (res.status !== 401) offenders.push(`${probe.method} ${probe.path} [${authorization}] -> ${res.status}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("answers 401 to every non-public route once the session was logged out or expired @req RT-SEC-02[runtime]", async () => {
    const app = createApp();
    const offenders: string[] = [];
    for (const probe of probes) {
      if (isPublic(probe)) continue;
      const session = runtimeState.login("sweep-backend-token", ["badger", "parrot"], "sweep-user");
      runtimeState.logout(session.token);
      const res = await request(app, probe, `Bearer ${session.token}`);
      if (res.status !== 401) offenders.push(`${probe.method} ${probe.path} -> ${res.status}`);
    }
    expect(offenders).toEqual([]);
  });

  it("does not let a live session be rejected as unauthorized on any route (the 401 comes from the token check only) @req RT-SEC-02[runtime]", async () => {
    const app = createApp();
    const offenders: string[] = [];
    for (const probe of probes) {
      if (isPublic(probe)) continue;
      const session = runtimeState.login("sweep-backend-token", ["badger", "parrot"], "sweep-user");
      const res = await request(app, probe, `Bearer ${session.token}`);
      if (res.status === 401) offenders.push(`${probe.method} ${probe.path}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the two public routes reachable without a token @req RT-SEC-02[runtime]", async () => {
    const app = createApp();
    const health = await app.request("/runtime/health");
    expect(health.status).toBe(200);
    const login = await app.request("/runtime/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-runtime-owner": ownerLoginGate.secret },
      body: JSON.stringify({ backendToken: "tok", apps: ["badger"] }),
    });
    expect(login.status).toBe(200);
  });

  it("serves no unauthenticated root page and no unknown route leaks anything @req RT-SEC-02[runtime]", async () => {
    const app = createApp();
    const root = await app.request("/");
    expect(root.status).toBe(404);
    const unknown = await app.request("/runtime/definitely-not-a-route");
    expect(unknown.status).toBe(404);
  });

  it("answers 401 on the v2 routes in every engine state, never the engine envelope @req RT-SEC-02[runtime]", async () => {
    const app = createApp();
    const v2 = probes.filter((p) => p.path.startsWith("/runtime/jobs/v2/"));
    expect(v2.length).toBeGreaterThanOrEqual(5);
    for (const state of [
      { state: "disabled" },
      { state: "not_booted" },
      { state: "boot_failed", message: "boom" },
      { state: "ready" },
    ] as const) {
      setEngineV2BootStatus(state);
      for (const probe of v2) {
        const res = await request(app, probe);
        expect(res.status, `${probe.method} ${probe.path} in ${state.state}`).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    }
  });
});

describe("Bun server entry points (SSE stream and WebSocket upgrade) auth", () => {
  const SSE = "http://127.0.0.1:3020/runtime/events/jobs/v2/stream";
  const WS = "http://127.0.0.1:3020/runtime/events";
  const fakeServer = () => {
    const upgrades: Array<{ data?: unknown }> = [];
    const server = {
      upgrade: (_request: Request, options?: { data?: unknown }) => {
        upgrades.push(options ?? {});
        return true;
      },
      timeout: () => undefined,
    };
    return { server: server as unknown as Bun.Server<never>, upgrades };
  };

  for (const [name, url] of [
    ["SSE stream", SSE],
    ["WebSocket upgrade", WS],
  ] as const) {
    it(`${name}: 401 with no token, a junk header token, a junk query token and a logged-out token @req RT-SEC-02[runtime]`, async () => {
      const { fetch } = createRuntimeServerDefinition();
      const { server, upgrades } = fakeServer();
      const session = runtimeState.login("ws-backend-token", ["badger"], "ws-user");
      runtimeState.logout(session.token);
      for (const request of [
        new Request(url),
        new Request(url, { headers: { authorization: "Bearer rt_junk" } }),
        new Request(`${url}?token=rt_junk`),
        new Request(`${url}?token=${session.token}`),
        new Request(url, { headers: { authorization: `Bearer ${session.token}` } }),
      ]) {
        const res = await fetch(request, server);
        expect(res?.status).toBe(401);
      }
      expect(upgrades).toHaveLength(0);
    });
  }

  it("WebSocket upgrade proceeds for a live session token (query and header) @req RT-SEC-02[runtime]", async () => {
    const { fetch } = createRuntimeServerDefinition();
    const { server, upgrades } = fakeServer();
    const session = runtimeState.login("ws-backend-token", ["badger"], "ws-user");
    expect(await fetch(new Request(`${WS}?token=${session.token}`), server)).toBeUndefined();
    expect(
      await fetch(new Request(WS, { headers: { authorization: `Bearer ${session.token}` } }), server)
    ).toBeUndefined();
    expect(upgrades).toHaveLength(2);
  });

  it("SSE stream is served to a live session (not 401) @req RT-SEC-02[runtime]", async () => {
    const { fetch } = createRuntimeServerDefinition();
    const { server } = fakeServer();
    const session = runtimeState.login("ws-backend-token", ["badger"], "ws-user");
    const res = await fetch(new Request(`${SSE}?token=${session.token}`), server);
    expect(res?.status).not.toBe(401);
    await res?.body?.cancel();
  });

  it("SSE stream ends once its session is logged out: no more frames, not even heartbeats @req RT-SEC-02[runtime]", async () => {
    vi.useFakeTimers();
    const savedHeartbeat = process.env.RUNTIME_JOBS_V2_SSE_HEARTBEAT_MS;
    process.env.RUNTIME_JOBS_V2_SSE_HEARTBEAT_MS = "1000";
    try {
      const { fetch } = createRuntimeServerDefinition();
      const { server } = fakeServer();
      const session = runtimeState.login("sse-backend-token", ["badger"], "sse-user");
      const res = await fetch(new Request(`${SSE}?token=${session.token}`), server);
      expect(res?.status).toBe(200);
      const reader = res!.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const readSome = async () => {
        const chunk = await reader.read();
        if (!chunk.done) text += decoder.decode(chunk.value);
        return chunk.done;
      };
      // Handshake and priming comment arrive first; then a heartbeat.
      await vi.advanceTimersByTimeAsync(1000);
      for (let i = 0; i < 5 && !text.includes(":heartbeat"); i += 1) expect(await readSome()).toBe(false);
      expect(text).toContain("event: handshake");
      expect(text).toContain(":heartbeat");

      runtimeState.logout(session.token);
      const framesBefore = text;
      await vi.advanceTimersByTimeAsync(1000);
      // The next heartbeat finds the session gone and closes the stream.
      let done = false;
      for (let i = 0; i < 5 && !done; i += 1) done = await readSome();
      expect(done).toBe(true);
      expect(text.slice(framesBefore.length)).not.toContain(":heartbeat");
    } finally {
      if (savedHeartbeat === undefined) delete process.env.RUNTIME_JOBS_V2_SSE_HEARTBEAT_MS;
      else process.env.RUNTIME_JOBS_V2_SSE_HEARTBEAT_MS = savedHeartbeat;
      vi.useRealTimers();
    }
  });
});
