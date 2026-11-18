/**
 * RT-SEC-05 (key part): the runtime never writes a library key to disk. Keys sit
 * in memory, an old plaintext `runtime_keys.json` is read once and shredded, and
 * a restarted runtime reports "locked" until an app pushes the key again.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { getRuntimeConfig } from "../src/config";
import { RuntimeKeyStore, runtimeKeyStore } from "../src/core/keys/store";
import { runtimeState } from "../src/runtime";

const newKey = () => randomBytes(32);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Every file under `dir`, so a scan can look for key bytes in any of them. */
const listFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return entry.isFile() ? [full] : [];
  });

/** Files under `dir` whose bytes contain the key in base64, hex, or raw form. */
const filesHoldingKey = (dir: string, key: Buffer): string[] => {
  const needles = [key, Buffer.from(key.toString("base64")), Buffer.from(key.toString("hex"))];
  return listFiles(dir).filter((file) => {
    const bytes = readFileSync(file);
    return needles.some((needle) => bytes.includes(needle));
  });
};

describe("keys are never written to disk @req RT-SEC-05[runtime] @req RT-SEC-06[runtime]", () => {
  const config = getRuntimeConfig();

  beforeEach(() => runtimeKeyStore.reset());
  afterEach(() => runtimeKeyStore.reset());

  it("POST /runtime/keys/set leaves no key bytes anywhere in the runtime data dir", async () => {
    const app = createApp();
    const userId = `key-at-rest-${randomBytes(4).toString("hex")}`;
    const session = runtimeState.login("backend-token", ["badger", "parrot"], userId);
    const key = newKey();

    const res = await app.request("/runtime/keys/set", {
      method: "POST",
      headers: { ...bearer(session.token), "content-type": "application/json" },
      body: JSON.stringify({ masterKeyBase64: key.toString("base64") }),
    });
    expect(res.status).toBe(200);
    expect(runtimeKeyStore.get(userId)).toBe(key.toString("base64"));

    const holding = filesHoldingKey(config.runtimeDataDir, key);
    console.info("[key-at-rest] scan", { dir: config.runtimeDataDir, files: listFiles(config.runtimeDataDir).length, holding });
    expect(holding).toEqual([]);
    expect(existsSync(config.legacyRuntimeKeysPath)).toBe(false);
  });

  it("clearing a key and resetting the store never touch the disk either", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-key-at-rest-"));
    try {
      const store = new RuntimeKeyStore();
      const key = newKey().toString("base64");
      store.set("u1", key);
      store.clear("u1");
      store.set("u2", key);
      store.reset();
      expect(readdirSync(dir)).toEqual([]);
      expect(store.entries()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a plaintext runtime_keys.json from an older build is migrated once @req RT-SEC-05[runtime]", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-key-migrate-"));
    file = join(dir, "runtime_keys.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const legacyFile = (entries: Array<{ userId: string; key: Buffer }>) =>
    JSON.stringify(
      {
        keys: entries.map(({ userId, key }) => ({
          userId,
          masterKeyBase64: key.toString("base64"),
          updatedAt: "2026-10-01T00:00:00.000Z",
        })),
      },
      null,
      2
    );

  it("keeps the key usable in memory, deletes the file and leaves no key bytes on disk", () => {
    const key = newKey();
    writeFileSync(file, legacyFile([{ userId: "u1", key }]));

    const store = new RuntimeKeyStore();
    const result = store.migrateLegacyPlaintextFile(file);

    expect(result).toEqual({ found: true, loaded: 1, removed: true, overwritten: true });
    expect(store.get("u1")).toBe(key.toString("base64"));
    expect(store.status("u1")).toMatchObject({ keyed: true, locked: false, storage: "memory" });
    expect(existsSync(file)).toBe(false);
    expect(filesHoldingKey(dir, key)).toEqual([]);
  });

  it("overwrites the old bytes before unlinking (a second hard link sees zeros, not the key)", () => {
    const key = newKey();
    writeFileSync(file, legacyFile([{ userId: "u1", key }]));
    const size = statSync(file).size;
    const other = join(dir, "other-name-for-same-inode");
    linkSync(file, other);

    new RuntimeKeyStore().migrateLegacyPlaintextFile(file);

    expect(existsSync(file)).toBe(false);
    const left = readFileSync(other);
    expect(left.byteLength).toBe(size);
    expect(left.every((byte) => byte === 0)).toBe(true);
  });

  it("removes an unreadable file too, and never writes through a symlink", () => {
    writeFileSync(file, "{ not json");
    const unreadable = new RuntimeKeyStore().migrateLegacyPlaintextFile(file);
    expect(unreadable).toMatchObject({ found: true, loaded: 0, removed: true });
    expect(existsSync(file)).toBe(false);

    const target = join(dir, "precious.txt");
    writeFileSync(target, "do not touch");
    symlinkSync(target, file);
    const linked = new RuntimeKeyStore().migrateLegacyPlaintextFile(file);
    expect(linked).toMatchObject({ found: true, removed: true, overwritten: false });
    expect(readFileSync(target, "utf8")).toBe("do not touch");
  });

  it("does nothing when there is no old file, and a key already in memory wins over the file's", () => {
    const store = new RuntimeKeyStore();
    expect(store.migrateLegacyPlaintextFile(file)).toEqual({ found: false, loaded: 0, removed: true, overwritten: false });
    expect(store.migrateLegacyPlaintextFile(null)).toMatchObject({ found: false });

    const live = newKey().toString("base64");
    store.set("u1", live);
    writeFileSync(file, legacyFile([{ userId: "u1", key: newKey() }, { userId: "u2", key: newKey() }]));
    expect(store.migrateLegacyPlaintextFile(file)).toMatchObject({ loaded: 1, removed: true });
    expect(store.get("u1")).toBe(live);
    expect(store.has("u2")).toBe(true);
  });

  it("reports a file it cannot delete instead of pretending the key is safe", () => {
    // A directory where the file should be: readable as nothing, not removable without `recursive`.
    mkdirSync(file);
    writeFileSync(join(file, "inside"), "x");
    const store = new RuntimeKeyStore();
    const result = store.migrateLegacyPlaintextFile(file);
    expect(result).toMatchObject({ found: true, removed: false });
    expect(store.status("u1")).toMatchObject({ legacyPlaintextFileRemains: true });
  });
});

describe("a locked runtime says so, and a restart needs the key pushed again @req RT-SEC-05[runtime] @req RT-SEC-06[runtime]", () => {
  beforeEach(() => runtimeKeyStore.reset());
  afterEach(() => {
    runtimeKeyStore.reset();
    vi.unstubAllEnvs();
  });

  it("GET /runtime/keys/status answers locked, with the reason, until a key is set", async () => {
    const app = createApp();
    const userId = `lock-${randomBytes(4).toString("hex")}`;
    const session = runtimeState.login("backend-token", ["badger"], userId);

    const locked = await app.request("/runtime/keys/status", { headers: bearer(session.token) });
    const lockedBody = (await locked.json()) as Record<string, unknown>;
    expect(lockedBody).toMatchObject({ ok: true, keyed: false, locked: true, storage: "memory" });
    expect(String(lockedBody.message)).toMatch(/sign in on the desktop app/i);

    const key = newKey().toString("base64");
    await app.request("/runtime/keys/set", {
      method: "POST",
      headers: { ...bearer(session.token), "content-type": "application/json" },
      body: JSON.stringify({ masterKeyBase64: key }),
    });
    const unlocked = await app.request("/runtime/keys/status", { headers: bearer(session.token) });
    const unlockedBody = (await unlocked.json()) as Record<string, unknown>;
    expect(unlockedBody).toMatchObject({ ok: true, keyed: true, locked: false });
    expect(unlockedBody.message).toBeUndefined();
  });

  /** One runtime boot: a fresh module graph (runtime.ts opens its stores and migrates keys at import) on `dataDir`. */
  const bootRuntime = async (dataDir: string) => {
    vi.resetModules();
    vi.stubEnv("SPACEFLEET_RUNTIME_DATA_DIR", dataDir);
    const { runtimeState: state } = await import("../src/runtime");
    const { runtimeKeyStore: keys } = await import("../src/core/keys/store");
    const { createApp: createBootedApp } = await import("../src/app");
    return { state, keys, app: createBootedApp() };
  };

  it("a restart boots locked from the real runtime wiring, migrates a legacy file, and keys/set never writes a key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sf-key-restart-"));
    const legacyKey = newKey();
    const pushedKey = newKey();
    const legacyPath = join(dataDir, "runtime_keys.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        keys: [{ userId: "legacy-user", masterKeyBase64: legacyKey.toString("base64"), updatedAt: "2026-10-01T00:00:00.000Z" }],
      })
    );
    try {
      // Boot 1: the old plaintext file is moved into memory and shredded by runtime.ts's own startup code.
      const first = await bootRuntime(dataDir);
      expect(first.keys.get("legacy-user")).toBe(legacyKey.toString("base64"));
      expect(existsSync(legacyPath)).toBe(false);
      expect(filesHoldingKey(dataDir, legacyKey)).toEqual([]);

      // keys/set over HTTP keeps the key in memory only: no runtime_keys.json, no file holding any key bytes.
      const session = first.state.login("backend-token", ["badger"], "pushed-user");
      const res = await first.app.request("/runtime/keys/set", {
        method: "POST",
        headers: { ...bearer(session.token), "content-type": "application/json" },
        body: JSON.stringify({ masterKeyBase64: pushedKey.toString("base64") }),
      });
      expect(res.status).toBe(200);
      expect(first.keys.get("pushed-user")).toBe(pushedKey.toString("base64"));
      expect(existsSync(legacyPath)).toBe(false);
      expect(filesHoldingKey(dataDir, pushedKey)).toEqual([]);
      expect(filesHoldingKey(dataDir, legacyKey)).toEqual([]);

      // Boot 2 on the same data dir: nothing to load from disk, so every user is locked until an app pushes again.
      const second = await bootRuntime(dataDir);
      expect(second.keys).not.toBe(first.keys);
      expect(second.keys.get("legacy-user")).toBeNull();
      expect(second.keys.get("pushed-user")).toBeNull();
      expect(second.keys.status("pushed-user")).toMatchObject({ keyed: false, locked: true, storage: "memory" });

      const secondSession = second.state.login("backend-token", ["badger"], "pushed-user");
      const locked = await second.app.request("/runtime/keys/status", { headers: bearer(secondSession.token) });
      expect(await locked.json()).toMatchObject({ ok: true, keyed: false, locked: true });

      // What the desktop app does when the runtime becomes ready: push again.
      await second.app.request("/runtime/keys/set", {
        method: "POST",
        headers: { ...bearer(secondSession.token), "content-type": "application/json" },
        body: JSON.stringify({ masterKeyBase64: pushedKey.toString("base64") }),
      });
      const unlocked = await second.app.request("/runtime/keys/status", { headers: bearer(secondSession.token) });
      expect(await unlocked.json()).toMatchObject({ ok: true, keyed: true, locked: false });
      expect(filesHoldingKey(dataDir, pushedKey)).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
