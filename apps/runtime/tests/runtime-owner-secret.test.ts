/**
 * RT-SEC-05 (runtime part): nothing on the machine can log in to the runtime
 * without the owner secret held by our own apps.
 *
 * @covers POST /runtime/session/login, apps/runtime/src/core/ownerSecret.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDesktopPlatform } from "@space/desktop-platform";
import { RUNTIME_OWNER_ERRORS, RUNTIME_OWNER_HEADER, RUNTIME_OWNER_SECRET_FILE } from "@space/runtime-contracts/lifecycle";
import { createApp } from "../src/app";
import { ownerLoginGate, runtimeState } from "../src/runtime";
import {
  OwnerLoginGate,
  OwnerSecretWriteError,
  createOwnerSecret,
  ownerSecretMatches,
  publishOwnerSecret,
} from "../src/core/ownerSecret";

const SUITE = "runtime-owner-secret";
// POSIX mode bits only exist where the process has a uid (not on Windows, which uses ACLs).
const POSIX = typeof process.getuid === "function";

const loginRequest = (headers: Record<string, string>, body: unknown = { backendToken: "tok", apps: ["badger"] }) =>
  createApp().request("/runtime/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

let dir: string;

beforeEach(() => {
  runtimeState.resetForTests();
  dir = mkdtempSync(join(tmpdir(), "sf-owner-secret-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("login gate over HTTP", () => {
  it("refuses a login without the owner secret, and says nothing about sessions @req RT-SEC-05[runtime]", async () => {
    console.info(`[${SUITE}:missing] POST login without the header`);
    const res = await loginRequest({});
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: RUNTIME_OWNER_ERRORS.required });
    expect(text).not.toMatch(/token|expiresAt|capabilities/);
  });

  it("refuses a login with a wrong secret @req RT-SEC-05[runtime]", async () => {
    console.info(`[${SUITE}:wrong] POST login with a wrong secret`);
    const res = await loginRequest({ [RUNTIME_OWNER_HEADER]: createOwnerSecret() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: RUNTIME_OWNER_ERRORS.invalid });
  });

  it("refuses before it parses the body, so a bad payload learns nothing either @req RT-SEC-05[runtime]", async () => {
    const res = await createApp().request("/runtime/session/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: RUNTIME_OWNER_ERRORS.required });
  });

  it("refuses an Origin: null page that has no secret @req RT-SEC-05[runtime]", async () => {
    // The request guard lets Origin: null through (desktop renderers send it); only the secret keeps a sandboxed web page out.
    const res = await loginRequest({ origin: "null" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: RUNTIME_OWNER_ERRORS.required });
  });

  it("accepts the right secret and still honours the requested apps @req RT-SEC-05[runtime]", async () => {
    const res = await loginRequest({ [RUNTIME_OWNER_HEADER]: ownerLoginGate.secret });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string; capabilities: { apps: string[] } };
    expect(body.ok).toBe(true);
    expect(body.token.length).toBeGreaterThan(10);
    expect(body.capabilities.apps).toEqual(["badger"]);
  });

  it("accepts the secret from an Origin: null renderer (desktop apps) @req RT-SEC-05[runtime]", async () => {
    const res = await loginRequest({ origin: "null", [RUNTIME_OWNER_HEADER]: ownerLoginGate.secret });
    expect(res.status).toBe(200);
  });

  it("keeps health public @req RT-SEC-05[runtime]", async () => {
    const res = await createApp().request("/runtime/health");
    expect(res.status).toBe(200);
  });

  it("never echoes the secret in a response @req RT-SEC-05[runtime]", async () => {
    const wrong = await loginRequest({ [RUNTIME_OWNER_HEADER]: ownerLoginGate.secret.slice(0, -1) + "0" });
    const ok = await loginRequest({ [RUNTIME_OWNER_HEADER]: ownerLoginGate.secret });
    for (const res of [wrong, ok]) {
      expect(await res.text()).not.toContain(ownerLoginGate.secret);
      expect([...res.headers.values()].join("\n")).not.toContain(ownerLoginGate.secret);
    }
  });

  it("lets a browser preflight ask for the owner header on an allowed origin only @req RT-SEC-05[runtime]", async () => {
    const res = await createApp().request("/runtime/session/login", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": RUNTIME_OWNER_HEADER,
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(RUNTIME_OWNER_HEADER);
    const foreign = await createApp().request("/runtime/session/login", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": RUNTIME_OWNER_HEADER,
      },
    });
    expect(foreign.status).toBe(403);
  });
});

describe("OwnerLoginGate", () => {
  it("is 64 hex characters of fresh randomness @req RT-SEC-05[runtime]", () => {
    const a = createOwnerSecret();
    const b = createOwnerSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(new OwnerLoginGate().secret).not.toBe(new OwnerLoginGate().secret);
  });

  it("compares in constant time through timingSafeEqual, whatever the length @req RT-SEC-05[runtime]", () => {
    const secret = createOwnerSecret();
    expect(ownerSecretMatches(secret, secret)).toBe(true);
    expect(ownerSecretMatches(secret.slice(0, -1), secret)).toBe(false);
    expect(ownerSecretMatches(`${secret}0`, secret)).toBe(false);
    expect(ownerSecretMatches("", secret)).toBe(false);
  });

  it("rate limits failures with 429 + Retry-After, never the right secret, and recovers with the window @req RT-SEC-05[runtime]", () => {
    let now = 1_000_000;
    const gate = new OwnerLoginGate({ secret: "s".repeat(64), maxFailures: 3, windowMs: 10_000, clock: () => now });
    const wrong = new Headers({ [RUNTIME_OWNER_HEADER]: "nope" });
    for (let i = 0; i < 3; i += 1) expect(gate.authorize(wrong)?.status).toBe(401);
    const limited = gate.authorize(wrong);
    expect(limited).toMatchObject({ status: 429, error: RUNTIME_OWNER_ERRORS.rateLimited });
    expect(limited?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // Our own apps are never locked out by a hammering program.
    expect(gate.authorize(new Headers({ [RUNTIME_OWNER_HEADER]: "s".repeat(64) }))).toBeNull();
    now += 10_001;
    expect(gate.authorize(wrong)?.status).toBe(401);
  });

  it("answers 429 over HTTP once a guesser exhausted its tries @req RT-SEC-05[runtime]", async () => {
    // Share the singleton's failure window deliberately: this is the real route.
    let last = 0;
    for (let i = 0; i < 30 && last !== 429; i += 1) last = (await loginRequest({ [RUNTIME_OWNER_HEADER]: "guess" })).status;
    expect(last).toBe(429);
    const res = await loginRequest({ [RUNTIME_OWNER_HEADER]: "guess" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await loginRequest({ [RUNTIME_OWNER_HEADER]: ownerLoginGate.secret })).status).toBe(200);
  });
});

describe("publishOwnerSecret", () => {
  const paths = () => getDesktopPlatform().paths;

  it("writes the secret to owner.secret, owner-only (0600 file in a 0700 dir on POSIX) @req RT-SEC-05[runtime]", () => {
    const target = join(dir, "runtime");
    const secret = createOwnerSecret();
    const file = publishOwnerSecret({ dir: target, secret, paths: paths() });
    expect(file.path).toBe(join(target, RUNTIME_OWNER_SECRET_FILE));
    expect(readFileSync(file.path, "utf8")).toBe(secret);
    if (POSIX) {
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      expect(statSync(target).mode & 0o777).toBe(0o700);
    }
  });

  it("tightens a pre-existing group/world-readable data dir @req RT-SEC-05[runtime]", () => {
    if (!POSIX) return;
    const target = join(dir, "loose");
    publishOwnerSecret({ dir: target, secret: "a", paths: paths() });
    const file = publishOwnerSecret({ dir: target, secret: "b", paths: paths() });
    expect(statSync(target).mode & 0o077).toBe(0);
    expect(readFileSync(file.path, "utf8")).toBe("b");
  });

  it("replaces the previous run's secret atomically and leaves no temp file @req RT-SEC-05[runtime]", () => {
    publishOwnerSecret({ dir, secret: "old", paths: paths() });
    const file = publishOwnerSecret({ dir, secret: "new", paths: paths() });
    expect(readFileSync(file.path, "utf8")).toBe("new");
    expect(existsSync(`${file.path}.${process.pid}.tmp`)).toBe(false);
  });

  it("refuses to publish when the file cannot be made owner-only, and leaves no secret behind @req RT-SEC-05[runtime]", () => {
    const failing = {
      restrictDirToOwner: () => undefined,
      restrictFileToOwner: () => {
        throw new Error("icacls failed");
      },
    };
    expect(() => publishOwnerSecret({ dir, secret: "s3cret", paths: failing })).toThrow(OwnerSecretWriteError);
    expect(existsSync(join(dir, RUNTIME_OWNER_SECRET_FILE))).toBe(false);
    expect(existsSync(`${join(dir, RUNTIME_OWNER_SECRET_FILE)}.${process.pid}.tmp`)).toBe(false);
  });

  it("restricts the file before the secret is written into it @req RT-SEC-05[runtime]", () => {
    let contentAtRestriction: string | null = null;
    publishOwnerSecret({
      dir,
      secret: "s3cret",
      paths: {
        restrictDirToOwner: () => undefined,
        restrictFileToOwner: (p) => {
          contentAtRestriction = readFileSync(p, "utf8");
        },
      },
    });
    expect(contentAtRestriction).toBe("");
  });

  it("removes its own file on shutdown, but not a successor's @req RT-SEC-05[runtime]", () => {
    const first = publishOwnerSecret({ dir, secret: "one", paths: paths() });
    first.remove();
    expect(existsSync(first.path)).toBe(false);

    const second = publishOwnerSecret({ dir, secret: "two", paths: paths() });
    writeFileSync(second.path, "three"); // a relaunched runtime took over
    second.remove();
    expect(readFileSync(second.path, "utf8")).toBe("three");
  });

  it("is never logged by the route, the gate or the publisher @req RT-SEC-05[runtime]", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const secret = ownerLoginGate.secret;
    await loginRequest({ [RUNTIME_OWNER_HEADER]: secret });
    await loginRequest({ [RUNTIME_OWNER_HEADER]: "wrong" });
    publishOwnerSecret({ dir, secret, paths: paths() });
    const logged = spies.flatMap((s) => s.mock.calls).flat().map(String).join("\n");
    expect(logged).not.toContain(secret);
  });
});
