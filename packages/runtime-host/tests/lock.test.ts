import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSpawnLock, forceReleaseSpawnLock, isSpawnLockStale, readLockHolderPid } from "../src/lock";

const SUITE = "runtime-host-lock";

const dumpLockSnapshot = (
  label: string,
  ctx: {
    root?: string;
    lockDir?: string;
    expectedHolderPid?: number | null;
    acquireAttempts?: Array<{ pid?: number; result: "lock" | "null"; observedHolder: number | null }>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`root: ${ctx.root ?? "(none)"}`);
    console.error(`lockDir: ${ctx.lockDir ?? "(none)"}`);
    if (ctx.lockDir) {
      const lockExists = existsSync(ctx.lockDir);
      console.error(`lockDir exists: ${lockExists}`);
      if (lockExists) {
        let dirContents: string[] = [];
        try {
          dirContents = readdirSync(ctx.lockDir);
        } catch (e) {
          dirContents = [`(readdir failed: ${e instanceof Error ? e.message : String(e)})`];
        }
        console.error(`lockDir contents: ${JSON.stringify(dirContents)}`);
        const pidFile = joinPath(ctx.lockDir, "pid");
        if (existsSync(pidFile)) {
          try {
            console.error(`pid file body: ${JSON.stringify(readFileSync(pidFile, "utf8"))}`);
          } catch (e) {
            console.error(`(pid-file read failed: ${e instanceof Error ? e.message : String(e)})`);
          }
        }
      }
      console.error(`readLockHolderPid: ${JSON.stringify(readLockHolderPid(ctx.lockDir))}`);
      console.error(`isSpawnLockStale: ${JSON.stringify(isSpawnLockStale(ctx.lockDir))}`);
    }
    if (ctx.expectedHolderPid !== undefined) {
      console.error(`expected holder pid: ${ctx.expectedHolderPid}`);
    }
    if (ctx.acquireAttempts) {
      console.error(`acquire attempts:\n${JSON.stringify(ctx.acquireAttempts, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("spawn lock", () => {
  let root: string;
  let lockDir: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const setup = () => {
    root = mkdtempSync(joinPath(tmpdir(), "rt-lock-"));
    lockDir = joinPath(root, "runtime.spawn.lock");
    console.info(`[${SUITE}:setup] root=${root} lockDir=${lockDir}`);
  };

  it("acquires a lock on a fresh directory", () => {
    setup();
    console.info(`[${SUITE}:acquire-fresh] attempting acquire on fresh dir`);
    const attempts: Array<{ pid?: number; result: "lock" | "null"; observedHolder: number | null }> = [];
    const lock = acquireSpawnLock(lockDir);
    attempts.push({ result: lock ? "lock" : "null", observedHolder: readLockHolderPid(lockDir) });
    try {
      expect(lock).not.toBeNull();
      expect(existsSync(lockDir)).toBe(true);
      console.info(`[${SUITE}:acquire-fresh] acquired, releasing`);
      lock!.release();
      expect(existsSync(lockDir)).toBe(false);
      console.info(`[${SUITE}:acquire-fresh] OK released, dir gone`);
    } catch (err) {
      dumpLockSnapshot("acquire-fresh-failure", { root, lockDir, acquireAttempts: attempts });
      throw err;
    }
  });

  it("returns null when the lock is already held", () => {
    setup();
    const attempts: Array<{ pid?: number; result: "lock" | "null"; observedHolder: number | null }> = [];
    console.info(`[${SUITE}:double-acquire] first acquire`);
    const first = acquireSpawnLock(lockDir);
    attempts.push({ result: first ? "lock" : "null", observedHolder: readLockHolderPid(lockDir) });
    try {
      expect(first).not.toBeNull();
      console.info(`[${SUITE}:double-acquire] second acquire (expect null)`);
      const second = acquireSpawnLock(lockDir);
      attempts.push({ result: second ? "lock" : "null", observedHolder: readLockHolderPid(lockDir) });
      expect(second).toBeNull();
      first!.release();
      console.info(`[${SUITE}:double-acquire] OK second was null, first released`);
    } catch (err) {
      dumpLockSnapshot("double-acquire-failure", { root, lockDir, acquireAttempts: attempts });
      throw err;
    }
  });

  it("writes the holder PID into the lock directory", () => {
    setup();
    const expectedHolder = 12345;
    console.info(`[${SUITE}:holder-pid] acquiring with pid=${expectedHolder}`);
    const lock = acquireSpawnLock(lockDir, expectedHolder);
    try {
      expect(readLockHolderPid(lockDir)).toBe(expectedHolder);
      console.info(`[${SUITE}:holder-pid] OK observed=${readLockHolderPid(lockDir)}`);
      lock!.release();
    } catch (err) {
      dumpLockSnapshot("holder-pid-failure", { root, lockDir, expectedHolderPid: expectedHolder });
      throw err;
    }
  });

  it("detects a stale lock held by a dead PID", () => {
    setup();
    const deadPid = 2_000_000_000;
    console.info(`[${SUITE}:stale-lock] acquiring with dead pid=${deadPid} (no release — simulating crash)`);
    const lock = acquireSpawnLock(lockDir, deadPid);
    try {
      expect(lock).not.toBeNull();
      // Don't release — simulate a crash
      console.info(`[${SUITE}:stale-lock] checking isSpawnLockStale`);
      expect(isSpawnLockStale(lockDir)).toBe(true);
      console.info(`[${SUITE}:stale-lock] forceReleaseSpawnLock`);
      forceReleaseSpawnLock(lockDir);
      expect(existsSync(lockDir)).toBe(false);
      console.info(`[${SUITE}:stale-lock] OK lock force-released, dir gone`);
    } catch (err) {
      dumpLockSnapshot("stale-lock-failure", { root, lockDir, expectedHolderPid: deadPid });
      throw err;
    }
  });

  it("detects a live lock as non-stale", () => {
    setup();
    console.info(`[${SUITE}:live-lock] acquiring with self pid=${process.pid}`);
    const lock = acquireSpawnLock(lockDir, process.pid);
    try {
      expect(isSpawnLockStale(lockDir)).toBe(false);
      console.info(`[${SUITE}:live-lock] OK non-stale, releasing`);
      lock!.release();
    } catch (err) {
      dumpLockSnapshot("live-lock-failure", { root, lockDir, expectedHolderPid: process.pid });
      throw err;
    }
  });

  it("allows re-acquisition after force release of a stale lock", () => {
    setup();
    const deadPid = 2_000_000_000;
    const attempts: Array<{ pid?: number; result: "lock" | "null"; observedHolder: number | null }> = [];
    console.info(`[${SUITE}:reacquire-after-stale] acquire dead pid=${deadPid}`);
    acquireSpawnLock(lockDir, deadPid);
    attempts.push({ pid: deadPid, result: "lock", observedHolder: readLockHolderPid(lockDir) });
    console.info(`[${SUITE}:reacquire-after-stale] force-releasing stale lock`);
    forceReleaseSpawnLock(lockDir);
    console.info(`[${SUITE}:reacquire-after-stale] re-acquiring`);
    const second = acquireSpawnLock(lockDir);
    attempts.push({ result: second ? "lock" : "null", observedHolder: readLockHolderPid(lockDir) });
    try {
      expect(second).not.toBeNull();
      second!.release();
      console.info(`[${SUITE}:reacquire-after-stale] OK re-acquired and released`);
    } catch (err) {
      dumpLockSnapshot("reacquire-after-stale-failure", { root, lockDir, acquireAttempts: attempts });
      throw err;
    }
  });
});
