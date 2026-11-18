/**
 * #25 product bug: after the desktop app is SIGKILLed / crashes, ~30% of
 * relaunches came back signed out because the session lived ONLY in the
 * renderer's Chromium `localStorage` (committed to LevelDB lazily, ~5 s after a
 * write, and not recoverable by us when the renderer storage comes back
 * empty). The main process now keeps a durable, fsynced, encrypted copy.
 *
 * ACCT-AUTH-08: the copy is encrypted with Electron's ASYNC safeStorage API (the
 * sync one is removed in Electron 46), and a file written by the old sync
 * `encryptString` must still open: no forced sign-in after the update.
 *
 * "Kill" here = drop the store instance with no shutdown hook and open a new one
 * on the same file, which is exactly what a SIGKILL + relaunch does to the file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretSafeStorage } from "@space/desktop-platform/secret-file";
import { createSessionStore } from "../src/main/sessionStore";

const TOKEN = "tok_live_9f2c1d7a";
const USER = JSON.stringify({ id: "u1", email: "a@b.c" });

/**
 * Stand-in for the OS key store: one reversible cipher (output never contains the
 * plaintext). Electron documents that the sync `encryptString` (Electron <= 45)
 * and async `decryptStringAsync` share the per-platform key, which is modelled by
 * sharing this cipher between `legacySyncEncryptedFile` and the async fake.
 */
const osKeyStoreEncrypt = (plain: string): Buffer => Buffer.from(plain, "utf8").reverse();
const osKeyStoreDecrypt = (buf: Buffer): string => Buffer.from(buf).reverse().toString("utf8");

/** Byte-for-byte what the pre-ACCT-AUTH-08 store wrote with `safeStorage.encryptString(json)`. */
const legacySyncEncryptedFile = (entries: Record<string, string>): string =>
  JSON.stringify({ v: 1, enc: "safeStorage", data: osKeyStoreEncrypt(JSON.stringify(entries)).toString("base64") });

/**
 * Linux KDE (kwallet6), seen in a 2026-10-31 probe on Electron 45.2.1: the sync
 * API's key is NOT the one the async provider uses, so `decryptStringAsync` fails
 * on what `encryptString` wrote. Modelled as a second key (a tagged cipher).
 */
const SYNC_ONLY_KEY_TAG = Buffer.from("sync-only-key:");
const syncOnlyKeyFile = (entries: Record<string, string>): string =>
  JSON.stringify({
    v: 1,
    enc: "safeStorage",
    data: Buffer.concat([SYNC_ONLY_KEY_TAG, osKeyStoreEncrypt(JSON.stringify(entries))]).toString("base64"),
  });
const isSyncOnlyKey = (buf: Buffer): boolean => buf.subarray(0, SYNC_ONLY_KEY_TAG.length).equals(SYNC_ONLY_KEY_TAG);

const fakeSafeStorage = (
  available = true,
  opts: { shouldReEncrypt?: boolean; legacySync?: boolean } = {},
): SecretSafeStorage => ({
  isAsyncEncryptionAvailable: async () => available,
  encryptStringAsync: async (plain) => osKeyStoreEncrypt(plain),
  decryptStringAsync: async (buf) => {
    if (isSyncOnlyKey(buf)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.");
    return { result: osKeyStoreDecrypt(buf), shouldReEncrypt: opts.shouldReEncrypt ?? false };
  },
  // Electron 45's sync decryptString reads both: its own key and the shared one.
  legacyDecryptString: opts.legacySync
    ? (buf) => osKeyStoreDecrypt(isSyncOnlyKey(buf) ? buf.subarray(SYNC_ONLY_KEY_TAG.length) : buf)
    : undefined,
});

describe("session store (main process)", () => {
  let dir: string;
  let filePath: string;
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  /** Open the store the way main does at startup: create, then await load() before any read(). */
  const open = async (safeStorage: SecretSafeStorage | null = fakeSafeStorage()) => {
    const store = createSessionStore({ filePath, safeStorage, log });
    await store.load();
    return store;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-session-store-"));
    filePath = join(dir, "session.json");
    logs.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const dump = (label: string) => {
    console.error(`=== [session-store:${label}] dir=${JSON.stringify(readdirSync(dir))} logs=${JSON.stringify(logs)}`);
    if (existsSync(filePath)) console.error(`file=${readFileSync(filePath, "utf8").slice(0, 400)}`);
  };

  // @req ACCT-AUTH-08
  it("@bugfix @regression-proof a login saved by the old sync safeStorage.encryptString opens with the async API (no forced sign-in)", async () => {
    writeFileSync(filePath, legacySyncEncryptedFile({ sf_client_token: TOKEN, sf_client_user: USER }), { mode: 0o600 });
    console.info(`[session-store:legacy] seeded ${readFileSync(filePath, "utf8").slice(0, 120)}`);
    const store = await open();
    try {
      expect(store.read()).toEqual({ sf_client_token: TOKEN, sf_client_user: USER });
      expect(logs.join("\n")).toMatch(/loaded 2 entries/);
    } catch (err) {
      dump("legacy-sync");
      throw err;
    }
    // The next write uses the async encryptor and stays readable by the next launch.
    await store.replace({ sf_client_token: TOKEN, sf_client_user: USER, sf_client_library_key: "k" });
    expect((await open()).read()).toEqual({ sf_client_token: TOKEN, sf_client_user: USER, sf_client_library_key: "k" });
  });

  // @req ACCT-AUTH-08
  it("@bugfix @regression-proof migration: a login the async API cannot open (KDE key mismatch) opens with the legacy sync decryptString and is rewritten with encryptStringAsync", async () => {
    writeFileSync(filePath, syncOnlyKeyFile({ sf_client_token: TOKEN, sf_client_user: USER }), { mode: 0o600 });
    const store = await open(fakeSafeStorage(true, { legacySync: true }));
    const raw = readFileSync(filePath, "utf8");
    console.info(`[session-store:migrate] after load file=${raw.slice(0, 120)} logs=${JSON.stringify(logs)}`);
    try {
      expect(store.read()).toEqual({ sf_client_token: TOKEN, sf_client_user: USER });
      expect(logs.join("\n")).toMatch(/legacy sync decryptString: migrating/);
      // Rewritten with the async key: Electron 46 (no sync API at all) still opens it.
      expect(raw).toBe(legacySyncEncryptedFile({ sf_client_token: TOKEN, sf_client_user: USER }));
      if (process.platform !== "win32") expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect((await open(fakeSafeStorage(true))).read()).toEqual({ sf_client_token: TOKEN, sf_client_user: USER });
    } catch (err) {
      dump("migrate");
      throw err;
    }
  });

  it("without the legacy sync API (Electron 46) an unmigrated KDE login reads as 'no session': why the migration ships on 45 first", async () => {
    writeFileSync(filePath, syncOnlyKeyFile({ sf_client_token: TOKEN }));
    const store = await open(fakeSafeStorage(true));
    expect(store.read()).toEqual({});
    expect(logs.join("\n")).toMatch(/unreadable/);
  });

  it("migration never downgrades to plain text: with no async encryptor the old ciphertext is kept", async () => {
    const seeded = syncOnlyKeyFile({ sf_client_token: TOKEN });
    writeFileSync(filePath, seeded);
    const store = await open(fakeSafeStorage(false, { legacySync: true }));
    expect(store.read()).toEqual({ sf_client_token: TOKEN });
    expect(readFileSync(filePath, "utf8")).toBe(seeded);
    expect(logs.join("\n")).toMatch(/keeping the old ciphertext/);
  });

  // @req ACCT-AUTH-08
  it("round trip: replace() then a fresh load() returns exactly the saved entries, encrypted at rest", async () => {
    const store = await open();
    await store.replace({ sf_client_token: TOKEN, sf_client_user: USER });
    const raw = readFileSync(filePath, "utf8");
    try {
      expect(raw).not.toContain(TOKEN);
      expect(raw).not.toContain("a@b.c");
      expect(JSON.parse(raw)).toMatchObject({ v: 1, enc: "safeStorage" });
      // Same envelope the sync API wrote: an older build can still read what this one writes.
      expect(raw).toBe(legacySyncEncryptedFile({ sf_client_token: TOKEN, sf_client_user: USER }));
      expect((await open()).read()).toEqual({ sf_client_token: TOKEN, sf_client_user: USER });
    } catch (err) {
      dump("round-trip");
      throw err;
    }
  });

  it("read() before load() resolved throws instead of serving an empty session", () => {
    const store = createSessionStore({ filePath, safeStorage: fakeSafeStorage(), log });
    expect(() => store.read()).toThrow(/before load/);
  });

  it("a key rotation (shouldReEncrypt) rewrites the file with the current key and keeps the session", async () => {
    writeFileSync(filePath, legacySyncEncryptedFile({ sf_client_token: TOKEN }));
    const before = statSync(filePath).ino;
    const store = await open(fakeSafeStorage(true, { shouldReEncrypt: true }));
    try {
      expect(store.read()).toEqual({ sf_client_token: TOKEN });
      expect(logs.join("\n")).toMatch(/re-encrypted with encryptStringAsync/);
      expect(statSync(filePath).ino).not.toBe(before); // tmp → rename
      expect((await open()).read()).toEqual({ sf_client_token: TOKEN });
    } catch (err) {
      dump("re-encrypt");
      throw err;
    }
  });

  it("concurrent replace() calls land in call order (a slow encryption never lets an older session win)", async () => {
    const firstEncryption = Promise.withResolvers<void>();
    let calls = 0;
    const slowFirst: SecretSafeStorage = {
      ...fakeSafeStorage(),
      encryptStringAsync: async (plain) => {
        calls += 1;
        if (calls === 1) await firstEncryption.promise;
        return osKeyStoreEncrypt(plain);
      },
    };
    const store = await open(slowFirst);
    const writes = Promise.all([store.replace({ sf_client_token: "old" }), store.replace({ sf_client_token: "new" })]);
    firstEncryption.resolve();
    await writes;
    try {
      expect(store.read()).toEqual({ sf_client_token: "new" });
      expect((await open()).read()).toEqual({ sf_client_token: "new" });
    } catch (err) {
      dump("order");
      throw err;
    }
  });

  it("@bugfix @regression-proof the session survives an abrupt kill (new instance, same file)", async () => {
    const first = await open();
    await first.replace({ sf_client_token: TOKEN, sf_client_user: USER });
    // SIGKILL: no close()/flush hook ever runs; the next launch only has the file.
    const relaunched = await open();
    try {
      expect(relaunched.read()).toEqual({ sf_client_token: TOKEN, sf_client_user: USER });
    } catch (err) {
      dump("survives-kill");
      throw err;
    }
  });

  it("@bugfix @regression-proof is durable on return: fsynced file is complete before replace() resolves", async () => {
    const store = await open();
    await store.replace({ sf_client_token: TOKEN });
    expect(existsSync(filePath)).toBe(true);
    // No half-written temp files are left behind (write tmp → fsync → rename).
    expect(readdirSync(dir).filter((name) => name !== "session.json")).toEqual([]);
    expect(() => JSON.parse(readFileSync(filePath, "utf8"))).not.toThrow();
  });

  it("falls back to an owner-only (0600) file when no keyring is available, and says so", async () => {
    const store = await open(fakeSafeStorage(false));
    await store.replace({ sf_client_token: TOKEN });
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ v: 1, enc: "plain" });
    if (process.platform !== "win32") expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toMatch(/encryption unavailable/i);
    expect((await open(fakeSafeStorage(false))).read()).toEqual({ sf_client_token: TOKEN });
  });

  it("works with no safeStorage object at all", async () => {
    const store = await open(null);
    await store.replace({ sf_client_token: TOKEN });
    expect((await open(null)).read()).toEqual({ sf_client_token: TOKEN });
  });

  it("replace() is a full replacement: clearing the session (logout / 401) is durable too", async () => {
    const store = await open();
    await store.replace({ sf_client_token: TOKEN, sf_client_user: USER, sf_client_library_key: "k" });
    await store.replace({ sf_client_library_key: "k" });
    try {
      expect((await open()).read()).toEqual({ sf_client_library_key: "k" });
    } catch (err) {
      dump("replace");
      throw err;
    }
    await store.replace({});
    expect((await open()).read()).toEqual({});
  });

  it("only persists session keys with string values; everything else is dropped", async () => {
    const store = await open();
    await store.replace({
      sf_client_token: TOKEN,
      "sf_client_library_key:u1": "lk",
      "sf_client_library_key_ack:u1": "true",
      theme: "dark",
      sf_client_user: 42,
    } as unknown as Record<string, string>);
    expect(store.read()).toEqual({
      sf_client_token: TOKEN,
      "sf_client_library_key:u1": "lk",
      "sf_client_library_key_ack:u1": "true",
    });
  });

  it("@bugfix @regression-proof fails closed: a clear that cannot be written never leaves the old token to resurrect after a relaunch", async () => {
    const store = await open();
    await store.replace({ sf_client_token: TOKEN, sf_client_user: USER });
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    chmodSync(dir, 0o500); // tmp file cannot be created and the file cannot be unlinked
    try {
      await expect(store.replace({ sf_client_user: USER })).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    try {
      expect((await open()).read().sf_client_token).toBeUndefined();
      expect(store.read().sf_client_token).toBeUndefined();
    } catch (err) {
      dump("fail-closed");
      throw err;
    }
  });

  it("fails closed when the keyring cannot encrypt a sign-out either", async () => {
    const store = await open();
    await store.replace({ sf_client_token: TOKEN, sf_client_user: USER });
    const failing: SecretSafeStorage = {
      ...fakeSafeStorage(),
      encryptStringAsync: async () => {
        throw new Error("keyring temporarily unavailable");
      },
    };
    const broken = await open(failing);
    await expect(broken.replace({ sf_client_user: USER })).rejects.toThrow(/temporarily unavailable/);
    expect((await open()).read().sf_client_token).toBeUndefined();
  });

  it("a corrupt or truncated file reads as 'no session' (logged), never throws, and is overwritten by the next replace()", async () => {
    writeFileSync(filePath, '{"v":1,"enc":"plain","data":"{\\"sf_client_tok');
    const store = await open();
    expect(store.read()).toEqual({});
    expect(logs.join("\n")).toMatch(/unreadable/i);
    await store.replace({ sf_client_token: TOKEN });
    expect((await open()).read()).toEqual({ sf_client_token: TOKEN });
  });

  it("a keyring that can no longer decrypt (profile moved) reads as 'no session' instead of rejecting", async () => {
    await (await open()).replace({ sf_client_token: TOKEN });
    const broken: SecretSafeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plain) => Buffer.from(plain),
      decryptStringAsync: async () => {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync");
      },
    };
    const store = await open(broken);
    expect(store.read()).toEqual({});
    expect(logs.join("\n")).toMatch(/unreadable/i);
  });

  it("an encrypted file with no safeStorage at all reads as 'no session'", async () => {
    writeFileSync(filePath, legacySyncEncryptedFile({ sf_client_token: TOKEN }));
    const store = await open(null);
    expect(store.read()).toEqual({});
    expect(logs.join("\n")).toMatch(/safeStorage is unavailable/);
  });

  it("an unwritable location surfaces the error (the renderer logs it) without corrupting the old file", async () => {
    const store = await open();
    await store.replace({ sf_client_token: TOKEN });
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    chmodSync(dir, 0o500);
    try {
      await expect(store.replace({ sf_client_token: "other" })).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect((await open()).read()).toEqual({ sf_client_token: TOKEN });
  });

  it("skips the disk write when nothing changed (no fsync storm from repeated mirrors)", async () => {
    const store = await open();
    await store.replace({ sf_client_token: TOKEN });
    const before = statSync(filePath).mtimeMs;
    const inode = statSync(filePath).ino;
    await store.replace({ sf_client_token: TOKEN });
    expect(statSync(filePath).ino).toBe(inode);
    expect(statSync(filePath).mtimeMs).toBe(before);
  });
});
