/**
 * RT-SEC-01: the runtime serves only this machine. A web page cannot reach it
 * (foreign Origin refused, CORS is an allowlist and never `*`), and a DNS
 * rebinding page cannot reach it either (foreign Host refused) — on the Hono
 * routes, the v2 SSE stream and the WebSocket upgrade alike.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRuntimeServerDefinition } from "../src/index";
import { getRuntimeConfig } from "../src/config";
import { guardRequest, isAllowedHost, isAllowedOrigin } from "../src/requestGuard";
import { ownerLoginGate, runtimeState } from "../src/runtime";

const ENV_KEYS = ["HOST", "RUNTIME_ALLOWED_ORIGINS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  runtimeState.resetForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const login = (headers: Record<string, string> = {}) =>
  createApp().request("/runtime/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-runtime-owner": ownerLoginGate.secret, ...headers },
    body: JSON.stringify({ backendToken: "tok", apps: ["badger"] }),
  });

describe("CORS configuration", () => {
  it("defaults to no extra origin and ignores a wildcard @req RT-SEC-01[runtime]", () => {
    expect(getRuntimeConfig().corsOrigins).toEqual([]);
    process.env.RUNTIME_ALLOWED_ORIGINS = "*, https://app.example.test/ ,";
    expect(getRuntimeConfig().corsOrigins).toEqual(["https://app.example.test"]);
  });
});

describe("Origin policy", () => {
  it("accepts the desktop origins and requests without an Origin @req RT-SEC-01[runtime]", () => {
    for (const origin of [
      null,
      "http://localhost:3007",
      "http://127.0.0.1:3007",
      "http://[::1]:3007",
      "https://localhost",
      "null",
      "file://",
    ]) {
      expect(isAllowedOrigin(origin), String(origin)).toBe(true);
    }
  });

  it("refuses a foreign or malformed origin @req RT-SEC-01[runtime]", () => {
    for (const origin of [
      "https://evil.example",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example:3007",
      "ftp://localhost",
      "not a url",
      "*",
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });

  it("honours RUNTIME_ALLOWED_ORIGINS exactly (no wildcard, no prefix match) @req RT-SEC-01[runtime]", () => {
    process.env.RUNTIME_ALLOWED_ORIGINS = "https://api.spacebadger.io";
    expect(isAllowedOrigin("https://api.spacebadger.io")).toBe(true);
    expect(isAllowedOrigin("https://api.spacebadger.io/")).toBe(true);
    expect(isAllowedOrigin("https://api.spacebadger.io.evil.example")).toBe(false);
    expect(isAllowedOrigin("http://api.spacebadger.io")).toBe(false);
  });
});

describe("Host policy", () => {
  it("accepts loopback names with any port @req RT-SEC-01[runtime]", () => {
    for (const host of ["127.0.0.1:3020", "localhost:3020", "LOCALHOST", "[::1]:3020", "127.0.0.1"]) {
      expect(isAllowedHost(host, "127.0.0.1"), host).toBe(true);
    }
  });

  it("refuses a foreign hostname and an empty or unparsable Host (DNS rebinding) @req RT-SEC-01[runtime]", () => {
    for (const host of ["evil.example", "evil.example:3020", "localhost.evil.example:3020", "127.0.0.1.evil.example", "", "a b"]) {
      expect(isAllowedHost(host, "127.0.0.1"), host).toBe(false);
    }
    expect(isAllowedHost(null, "127.0.0.1")).toBe(false);
  });

  it("judges a request without a Host header by the host of its URL @req RT-SEC-01[runtime]", () => {
    // `guardRequest` falls back to the URL host (in-process requests carry no
    // header), so a missing header never lets a foreign URL host through.
    expect(guardRequest(new Request("http://rebind.evil.example:3020/runtime/health"))?.status).toBe(403);
    expect(guardRequest(new Request("http://127.0.0.1:3020/runtime/health"))).toBeNull();
  });

  it("allows a configured non-loopback HOST, and IP literals only on a wildcard bind @req RT-SEC-01[runtime]", () => {
    expect(isAllowedHost("192.168.0.20:3020", "192.168.0.20")).toBe(true);
    expect(isAllowedHost("192.168.0.21:3020", "192.168.0.20")).toBe(false);
    expect(isAllowedHost("192.168.0.21:3020", "0.0.0.0")).toBe(true);
    expect(isAllowedHost("[fe80::1]:3020", "::")).toBe(true);
    expect(isAllowedHost("evil.example:3020", "0.0.0.0")).toBe(false);
  });
});

describe("Hono routes", () => {
  it("refuses a foreign Origin outright, with no CORS headers, even on a simple POST @req RT-SEC-01[runtime]", async () => {
    const res = await login({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_origin" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(runtimeState.getMemoryStats().sessions).toBe(0);
  });

  it("refuses a foreign Origin preflight @req RT-SEC-01[runtime]", async () => {
    const res = await createApp().request("/runtime/session/login", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a foreign Host @req RT-SEC-01[runtime]", async () => {
    const res = await login({ host: "rebind.evil.example:3020" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_host" });
  });

  it("serves the desktop renderers (loopback, null and file origins, or none) and echoes the origin @req RT-SEC-01[runtime]", async () => {
    for (const origin of ["http://localhost:3007", "http://127.0.0.1:3007", "null", "file://", undefined]) {
      const res = await login({ host: "127.0.0.1:3020", ...(origin ? { origin } : {}) });
      expect(res.status, String(origin)).toBe(200);
      if (origin) expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("serves a configured origin and never answers `*` @req RT-SEC-01[runtime]", async () => {
    process.env.RUNTIME_ALLOWED_ORIGINS = "https://api.spacebadger.io";
    const allowed = await login({ origin: "https://api.spacebadger.io" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://api.spacebadger.io");
    const health = await createApp().request("/runtime/health", { headers: { origin: "http://localhost:3007" } });
    expect(health.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});

describe("Bun server entry points", () => {
  const fakeServer = () => {
    let upgrades = 0;
    const server = {
      upgrade: () => {
        upgrades += 1;
        return true;
      },
      timeout: () => undefined,
    };
    return { server: server as unknown as Bun.Server<never>, upgrades: () => upgrades };
  };

  it("refuses a WebSocket upgrade from a foreign Origin even with a valid token @req RT-SEC-01[runtime]", async () => {
    const { fetch } = createRuntimeServerDefinition();
    const { server, upgrades } = fakeServer();
    const session = runtimeState.login("tok", ["badger"], "u");
    const res = await fetch(
      new Request(`http://127.0.0.1:3020/runtime/events?token=${session.token}`, {
        headers: { origin: "https://evil.example" },
      }),
      server
    );
    expect(res?.status).toBe(403);
    expect(upgrades()).toBe(0);
  });

  it("refuses a WebSocket upgrade and an SSE stream addressed to a foreign Host @req RT-SEC-01[runtime]", async () => {
    const { fetch } = createRuntimeServerDefinition();
    const { server, upgrades } = fakeServer();
    const session = runtimeState.login("tok", ["badger"], "u");
    for (const path of ["/runtime/events", "/runtime/events/jobs/v2/stream"]) {
      const res = await fetch(
        new Request(`http://rebind.evil.example:3020${path}?token=${session.token}`, {
          headers: { host: "rebind.evil.example:3020" },
        }),
        server
      );
      expect(res?.status, path).toBe(403);
    }
    expect(upgrades()).toBe(0);
  });

  it("refuses an SSE stream from a foreign Origin @req RT-SEC-01[runtime]", async () => {
    const { fetch } = createRuntimeServerDefinition();
    const { server } = fakeServer();
    const session = runtimeState.login("tok", ["badger"], "u");
    const res = await fetch(
      new Request(`http://127.0.0.1:3020/runtime/events/jobs/v2/stream?token=${session.token}`, {
        headers: { origin: "https://evil.example" },
      }),
      server
    );
    expect(res?.status).toBe(403);
  });

  it("accepts a WebSocket upgrade from a desktop renderer origin @req RT-SEC-01[runtime]", async () => {
    const { fetch } = createRuntimeServerDefinition();
    const { server, upgrades } = fakeServer();
    const session = runtimeState.login("tok", ["badger"], "u");
    for (const origin of ["http://localhost:3007", "null", "file://"]) {
      const res = await fetch(
        new Request(`http://127.0.0.1:3020/runtime/events?token=${session.token}`, { headers: { origin } }),
        server
      );
      expect(res, origin).toBeUndefined();
    }
    expect(upgrades()).toBe(3);
  });
});
