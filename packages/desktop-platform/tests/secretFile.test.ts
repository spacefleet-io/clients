import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { open as openHandle, type FileHandle } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextLoopTurn } from "node:timers/promises";
import {
  createSecretFile,
  envelopeSecretFormat,
  secretSafeStorage,
  taggedSecretFormat,
  type SecretFileFormat,
  type SecretSafeStorage,
} from "../src/secretFile";

const SECRET = "lk_9f2c1d7a+/=";

/** Stand-in for the OS key store: a reversible cipher whose output never contains the plaintext. */
const encrypt = (plain: string): Buffer => Buffer.from(plain, "utf8").reverse();
const decrypt = (buf: Buffer): string => Buffer.from(buf).reverse().toString("utf8");

/** Linux KDE: what the sync `encryptString` wrote, the async API cannot open (a second key, modelled by a tag). */
const SYNC_ONLY = Buffer.from("sync-only:");
const isSyncOnly = (buf: Buffer) => buf.subarray(0, SYNC_ONLY.length).equals(SYNC_ONLY);

const fakeSafeStorage = (available = true, legacySync = false): SecretSafeStorage => ({
  isAsyncEncryptionAvailable: async () => available,
  encryptStringAsync: async (plain) => encrypt(plain),
  decryptStringAsync: async (buf) => {
    if (isSyncOnly(buf)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.");
    return { result: decrypt(buf), shouldReEncrypt: false };
  },
  legacyDecryptString: legacySync ? (buf) => decrypt(isSyncOnly(buf) ? buf.subarray(SYNC_ONLY.length) : buf) : undefined,
});

/**
 * A stalled disk: every fsync/fdatasync entry point of `node:fs` (sync, callback, FileHandle) waits before the real
 * call. The async ones wait for `release()`, so the test decides when the flush ends. A sync one cannot wait on the
 * test (it holds the only JS thread), so it blocks the calling thread for `syncStallMs` of real time, exactly what a
 * stalled flush does to Electron main: that real wait is the bug being modelled, fake timers cannot stand in for it.
 */
const stalledDisk = async (scratch: string, syncStallMs: number) => {
  const fs = createRequire(import.meta.url)("node:fs") as typeof NodeFs;
  const handle = await openHandle(scratch, "w");
  const handleProto = Object.getPrototypeOf(handle) as Pick<FileHandle, "sync" | "datasync">;
  await handle.close();
  const stats = { started: 0, finished: 0, onCallingThread: 0, inFlight: 0 };
  const gate = Promise.withResolvers<void>();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const restore: Array<() => void> = [];
  const patch = <T extends object, K extends keyof T>(target: T, key: K, make: (orig: T[K]) => T[K]) => {
    const orig = target[key];
    target[key] = make(orig);
    restore.push(() => {
      target[key] = orig;
    });
  };
  const flushing = async <R>(flush: () => Promise<R>): Promise<R> => {
    stats.started++;
    stats.inFlight++;
    await gate.promise;
    try {
      return await flush();
    } finally {
      stats.inFlight--;
      stats.finished++;
    }
  };
  for (const name of ["fsyncSync", "fdatasyncSync"] as const) {
    patch(fs, name, (orig) => ((fd: number) => {
      stats.started++;
      stats.onCallingThread++;
      stats.inFlight++;
      Atomics.wait(sleeper, 0, 0, syncStallMs);
      try {
        orig(fd);
      } finally {
        stats.inFlight--;
        stats.finished++;
      }
    }) as never);
  }
  for (const name of ["fsync", "fdatasync"] as const) {
    patch(fs, name, (orig) => ((fd: number, cb: (err: NodeJS.ErrnoException | null) => void) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      orig(fd, (err) => (err ? reject(err) : resolve()));
      flushing(() => promise).then(() => cb(null), (err: NodeJS.ErrnoException) => cb(err));
    }) as never);
  }
  for (const name of ["sync", "datasync"] as const) {
    patch(handleProto, name, (orig) =>
      function (this: FileHandle) {
        return flushing(() => orig.call(this));
      });
  }
  syncBuiltinESMExports();
  return {
    stats,
    release: () => gate.resolve(),
    restore: () => {
      gate.resolve();
      for (const undo of restore.reverse()) undo();
      syncBuiltinESMExports();
    },
  };
};

describe("secret file", () => {
  let dir: string;
  let path: string;
  const logs: string[] = [];
  const open = (format: SecretFileFormat, safeStorage: SecretSafeStorage | null = fakeSafeStorage()) =>
    createSecretFile({ path, format, safeStorage, log: (line) => logs.push(line), label: "secret.test" });
  const dump = (label: string) => {
    console.error(`=== [secret.test:${label}] logs=${JSON.stringify(logs)}`);
    if (existsSync(path)) console.error(`[secret.test:${label}] file=${JSON.stringify(readFileSync(path, "latin1"))}`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-secret-file-"));
    path = join(dir, "x.secret");
    logs.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  for (const [name, format] of [
    ["tagged", taggedSecretFormat],
    ["envelope", envelopeSecretFormat],
  ] as const) {
    it(`${name}: round trip, sealed at rest, owner-only`, async () => {
      await open(format).write(SECRET);
      console.info(`[secret.test:${name}] wrote ${JSON.stringify(readFileSync(path, "latin1"))}`);
      expect(readFileSync(path, "latin1")).not.toContain(SECRET);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await open(format).read()).toBe(SECRET);
    });

    it(`${name}: without protected storage the secret is stored as is and a warning is logged`, async () => {
      await open(format, fakeSafeStorage(false)).write(SECRET);
      dump(`${name}-plain`);
      expect(logs.join("\n")).toMatch(/OS encryption unavailable/);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await open(format, fakeSafeStorage(false)).read()).toBe(SECRET);
    });
  }

  it("tagged: a file Parrot wrote with the sync encryptString opens via the legacy call and is re-sealed async", async () => {
    writeFileSync(path, Buffer.concat([Buffer.from("enc:"), SYNC_ONLY, encrypt(SECRET)]));
    const value = await open(taggedSecretFormat, fakeSafeStorage(true, true)).read();
    dump("tagged-legacy");
    expect(value).toBe(SECRET);
    expect(logs.join("\n")).toMatch(/legacy sync decryptString: migrating/);
    expect(readFileSync(path)).toEqual(Buffer.concat([Buffer.from("enc:"), encrypt(SECRET)]));
  });

  it("tagged: a `raw:` file opens as is", async () => {
    writeFileSync(path, `raw:${SECRET}`);
    expect(await open(taggedSecretFormat).read()).toBe(SECRET);
  });

  it("re-sealing never downgrades to plain text: without the async encryptor the old ciphertext stays", async () => {
    const seeded = Buffer.concat([Buffer.from("enc:"), SYNC_ONLY, encrypt(SECRET)]);
    writeFileSync(path, seeded);
    expect(await open(taggedSecretFormat, fakeSafeStorage(false, true)).read()).toBe(SECRET);
    dump("no-downgrade");
    expect(readFileSync(path)).toEqual(seeded);
    expect(logs.join("\n")).toMatch(/keeping the old ciphertext/);
  });

  it("an unknown, corrupt or empty file reads as no secret (logged), never throws", async () => {
    expect(await open(taggedSecretFormat).read()).toBeNull();
    writeFileSync(path, "garbage");
    expect(await open(taggedSecretFormat).read()).toBeNull();
    expect(logs.join("\n")).toMatch(/unreadable/);
    writeFileSync(path, "");
    expect(await open(taggedSecretFormat).read()).toBeNull();
  });

  it("an encrypted file with no safeStorage at all reads as no secret", async () => {
    await open(envelopeSecretFormat).write(SECRET);
    expect(await open(envelopeSecretFormat, null).read()).toBeNull();
    expect(logs.join("\n")).toMatch(/safeStorage is unavailable/);
  });

  it("remove() deletes the file; a missing file is fine", async () => {
    const file = open(taggedSecretFormat);
    await file.write(SECRET);
    expect(file.exists()).toBe(true);
    file.remove();
    file.remove();
    expect(file.exists()).toBe(false);
    expect(await file.read()).toBeNull();
  });

  it("secretSafeStorage passes the sync decryptString only while Electron has it", async () => {
    const asyncOnly = { ...fakeSafeStorage() };
    delete asyncOnly.legacyDecryptString;
    expect(secretSafeStorage(asyncOnly).legacyDecryptString).toBeUndefined();
    const withSync = { ...asyncOnly, decryptString: (buf: Buffer) => decrypt(buf) };
    expect(secretSafeStorage(withSync).legacyDecryptString?.(encrypt(SECRET))).toBe(SECRET);
  });

  // @bugfix @regression-proof (PERF-TIME-02, ACCT-AUTH-08): writes fsynced on the calling thread. Badger rewrites its
  // session file on every route change (the last route is part of the session), so while an upload's copy filled the
  // page cache the fsync stalled and Electron main froze 15 s with 0% CPU (e2e-ultimate c050, 2026-11-13): the media
  // page opened only after the flush.
  it("@bugfix @regression-proof a write keeps the event loop turning while the disk flushes, and resolves only once flushed", async () => {
    const disk = await stalledDisk(join(dir, "scratch"), 300);
    try {
      const file = open(envelopeSecretFormat);
      let settled = false;
      const writing = file.write(SECRET).finally(() => {
        settled = true;
      });
      let loopTurnsDuringFlush = 0;
      for (let turn = 0; turn < 10_000 && !settled; turn++) {
        await nextLoopTurn();
        if (disk.stats.inFlight > 0) {
          loopTurnsDuringFlush++;
          if (loopTurnsDuringFlush >= 3) break;
        }
      }
      console.info(`[secret.test:stalled-disk] after waiting: ${JSON.stringify({ ...disk.stats, settled, loopTurnsDuringFlush })}`);
      expect(disk.stats.onCallingThread, "fsync ran on the calling (main) thread").toBe(0);
      expect(loopTurnsDuringFlush, "the event loop turned while a flush was in flight").toBeGreaterThanOrEqual(3);
      expect(settled, "write resolved before its flush finished").toBe(false);
      disk.release();
      await writing;
      console.info(`[secret.test:stalled-disk] after release: ${JSON.stringify(disk.stats)}`);
      dump("stalled-disk");
      expect(disk.stats.inFlight).toBe(0);
      expect(disk.stats.finished).toBeGreaterThanOrEqual(1);
      expect(disk.stats.finished).toBe(disk.stats.started);
      expect(await open(envelopeSecretFormat).read()).toBe(SECRET);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      disk.restore();
    }
  });
});
