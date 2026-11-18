import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { defaultObjectCacheBytes, loadIntegrationConfig } from "../src/config";
import {
  decryptLibraryEnvelope,
  decryptMediaObject,
  deriveMediaMasterKey,
  encryptLibraryEnvelope,
  encryptMediaObject,
} from "../src/mediaCrypto";
import { IntegrationRuntime } from "../src/runtime";
import { handleIntegrationRequest } from "../src/server";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const BASE = "http://127.0.0.1:8790";

describe("sidecar answers while the runtime is still starting (#934)", () => {
  const dirs: string[] = [];
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("@req INTG-JF-04[badger-jellyfin] /status says starting and session/library routes answer 503 until the first login settles", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-intg-start-"));
    dirs.push(dir);
    // The env login hangs on the network until the test lets it fail, like a slow API on a low-end box.
    const { promise: loginRequest, reject: failLogin } = Promise.withResolvers<Response>();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return loginRequest;
    }) as unknown as typeof fetch;
    const config = loadIntegrationConfig({
      HEADLESS_STATE_DIR: path.join(dir, "state"),
      HEADLESS_LIBRARY_KEY_FILE: path.join(dir, "library.key"),
      HEADLESS_API_URL: "http://api.test",
      HEADLESS_EMAIL: "a@b.c",
      HEADLESS_PASSWORD: "pw",
    });
    const runtime = new IntegrationRuntime(config, () => undefined);
    const deps = runtime.buildDeps();
    const get = (route: string, init?: RequestInit) => handleIntegrationRequest(new Request(`${BASE}${route}`, init), deps);

    const started = runtime.start();
    try {
      await expect.poll(() => calls, { timeout: 5_000 }).toBeGreaterThan(0);

      expect((await get("/health")).status).toBe(200);
      const status = await get("/integration/v1/status");
      expect(status.status).toBe(200);
      expect(((await status.json()) as { state: string }).state).toBe("starting");
      expect((await get("/integration/v1/pairing/status")).status).toBe(200);
      for (const [route, init] of [
        ["/integration/v1/library", undefined],
        ["/integration/v1/profiles", undefined],
        ["/integration/v1/login", { method: "POST", body: JSON.stringify({ email: "x@y.z", password: "p" }) }],
        ["/integration/v1/signout", { method: "POST" }],
      ] as const) {
        const res = await get(route, init);
        expect(res.status, route).toBe(503);
        expect(((await res.json()) as { error: string }).error, route).toBe("starting");
      }

      failLogin(new Error("network down"));
      await started;

      const after = (await (await get("/integration/v1/status")).json()) as { state: string; lastError: string | null };
      expect(after.state).toBe("needs_login");
      expect(after.lastError).toMatch(/^login_failed/);
      const library = await get("/integration/v1/library");
      expect(library.status).toBe(503);
      expect(((await library.json()) as { error: string }).error).toBe("library_not_ready");
    } finally {
      failLogin(new Error("test over"));
      await started.catch(() => undefined);
      await runtime.stop();
    }
  });
});

describe("GCM decrypt without the concat copy still checks the tag (#934)", () => {
  const libraryKey = randomBytes(32);
  const master = deriveMediaMasterKey(libraryKey);
  const flip = (buf: Buffer, at: number) => {
    const copy = Buffer.from(buf);
    copy[at] ^= 0x01;
    return copy;
  };

  it("@req PRIV-ENC-01[badger-jellyfin] round-trips a segment-sized media object and throws on a tampered body, tag or key", () => {
    const plain = randomBytes(4 * MIB + 123);
    const encrypted = encryptMediaObject(master, plain, 77);
    expect(decryptMediaObject(master, encrypted).equals(plain)).toBe(true);
    expect(() => decryptMediaObject(master, flip(encrypted, 4 + 16 + 12 + 1000))).toThrow();
    expect(() => decryptMediaObject(master, flip(encrypted, encrypted.length - 1))).toThrow();
    expect(() => decryptMediaObject(deriveMediaMasterKey(randomBytes(32)), encrypted)).toThrow();
  });

  it("@req PRIV-ENC-01[badger-jellyfin] round-trips a library envelope and throws on a tampered body, tag or key", () => {
    const plain = randomBytes(300_000);
    const envelope = encryptLibraryEnvelope(libraryKey, plain);
    expect(decryptLibraryEnvelope(libraryKey, envelope).equals(plain)).toBe(true);
    expect(() => decryptLibraryEnvelope(libraryKey, flip(envelope, 12 + 5))).toThrow();
    expect(() => decryptLibraryEnvelope(libraryKey, flip(envelope, envelope.length - 1))).toThrow();
    expect(() => decryptLibraryEnvelope(randomBytes(32), envelope)).toThrow();
  });
});

describe("decrypted-object cache sized by RAM (#934)", () => {
  it("@req INTG-JF-04[badger-jellyfin] defaults to a sixteenth of RAM within 64..256 MiB", () => {
    expect(defaultObjectCacheBytes(512 * MIB)).toBe(64 * MIB);
    expect(defaultObjectCacheBytes(1 * GIB)).toBe(64 * MIB);
    expect(defaultObjectCacheBytes(1.5 * GIB)).toBe(96 * MIB);
    expect(defaultObjectCacheBytes(2 * GIB)).toBe(128 * MIB);
    expect(defaultObjectCacheBytes(4 * GIB)).toBe(256 * MIB);
    expect(defaultObjectCacheBytes(64 * GIB)).toBe(256 * MIB);
    expect(defaultObjectCacheBytes(3 * GIB + 12345)).toBe(192 * MIB);
  });

  it("@req INTG-JF-04[badger-jellyfin] uses the RAM default only when HEADLESS_OBJECT_CACHE_MB is unset or invalid; an explicit value always wins", () => {
    const cwd = os.tmpdir();
    expect(loadIntegrationConfig({}, cwd, 2 * GIB).objectCacheBytes).toBe(128 * MIB);
    expect(loadIntegrationConfig({ HEADLESS_OBJECT_CACHE_MB: "nope" }, cwd, 2 * GIB).objectCacheBytes).toBe(128 * MIB);
    expect(loadIntegrationConfig({ HEADLESS_OBJECT_CACHE_MB: "0" }, cwd, 2 * GIB).objectCacheBytes).toBe(128 * MIB);
    expect(loadIntegrationConfig({ HEADLESS_OBJECT_CACHE_MB: "512" }, cwd, 2 * GIB).objectCacheBytes).toBe(512 * MIB);
    expect(loadIntegrationConfig({ HEADLESS_OBJECT_CACHE_MB: "32" }, cwd, 64 * GIB).objectCacheBytes).toBe(32 * MIB);
    expect(loadIntegrationConfig({}, cwd).objectCacheBytes).toBe(defaultObjectCacheBytes(os.totalmem()));
  });
});
