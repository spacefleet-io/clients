import {
  closeSync,
  cpSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { PathLog } from "@space/desktop-platform-contract";

/**
 * The machinery for a "carry a legacy `/tmp` dir over to its persistent
 * XDG location" migration (the runtime data dir in `paths.ts`): validate the
 * legacy dir, hold a crash-safe cross-process lock while copying, copy without
 * following symlinks. What counts as "data", "still in use" and how the copy is
 * swapped in stays with each migration.
 */

export const OWNER_ONLY = 0o700;

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const readPid = (file: string): number | null => {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export type MigrationLockSeams = {
  isAlive?: (pid: number) => boolean;
  /** How long to wait for another process's migration before starting without it (default 120 s). */
  waitMs?: number;
  /** Poll interval while waiting (default 100 ms). */
  pollMs?: number;
  /** Age after which a lock without a readable owner pid counts as abandoned (default 30 s). */
  ownerlessStaleMs?: number;
};

export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * Take `lock` with our pid already in it: the pid goes to a private file first
 * and is hard-linked onto `lock` (link fails when `lock` exists), so no other
 * process ever sees the lock without its owner.
 */
const tryLock = (lock: string): boolean => {
  const mine = `${lock}.${process.pid}`;
  writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    linkSync(mine, lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(mine, { force: true });
  }
};

/** Remove our lock, unless it is no longer ours (broken as stale and re-taken). */
const unlock = (lock: string) => {
  if (readText(lock) === String(process.pid)) rmSync(lock, { force: true });
};

/**
 * Remove a lock whose owner is gone. The lock is renamed aside first and its
 * content compared with what we judged stale: if another process broke and
 * re-took it in between, theirs goes back.
 */
const breakStaleLock = (lock: string, staleContent: string | null) => {
  const aside = `${lock}.stale.${process.pid}`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  if (readText(aside) !== staleContent) {
    try {
      linkSync(aside, lock);
    } catch {
      // Re-taken again meanwhile: its owner holds it now.
    }
  }
  rmSync(aside, { force: true });
};

/**
 * Whether `legacyDir` may be migrated from: a real directory (not a symlink)
 * owned by `uid`. `/tmp` is shared, so another user's dir at a well-known
 * name must never be trusted. Logs why when it is refused; a missing dir is
 * silently "nothing to do".
 */
export const inspectLegacyDir = (legacyDir: string, uid: number, what: string, log: PathLog, meta: Record<string, unknown>): boolean => {
  let stat;
  try {
    stat = lstatSync(legacyDir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) {
    log("warn", `legacy ${what} is not a real directory (symlink or file); not migrating it`, meta);
    return false;
  }
  if (stat.uid !== uid) {
    log("warn", `legacy ${what} belongs to another user; not migrating it`, { ...meta, ownerUid: stat.uid, uid });
    return false;
  }
  return true;
};

/**
 * Overwrite a file with zeros, flush, and unlink it (used for key material the
 * legacy `/tmp` dir must not keep in plain text). Best effort: SSD wear
 * levelling, copy-on-write or journaling filesystems and snapshots can keep old
 * copies of the bytes. A symlink is only unlinked, never written through.
 */
export const shredFileSync = (file: string): void => {
  try {
    const stats = lstatSync(file);
    if (stats.isFile()) {
      const fd = openSync(file, "r+");
      try {
        const zeros = Buffer.alloc(Math.min(stats.size, 1 << 20));
        for (let at = 0; at < stats.size; ) at += writeSync(fd, zeros, 0, Math.min(zeros.length, stats.size - at), at);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    // Unlink regardless: a file we cannot overwrite must still go.
  }
  rmSync(file, { force: true });
};

/** Copy `from` to `to` (which must not exist) without following symlinks or clobbering anything. */
export const copyTree = (from: string, to: string): void =>
  cpSync(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });

/**
 * Run `work` while holding `lock`, one process at a time (two desktop apps may
 * start together). `shouldRun` is the migration's own "is there still anything
 * to do" check; it is re-evaluated after every wait, so a process that waited
 * finds the other's result in place and does nothing. The lock stays held
 * from before the copy until after the rename; others wait for it (bounded by
 * `waitMs`, then they carry on without migrating). A lock whose owner died is
 * broken.
 */
export const runUnderMigrationLock = (
  { lock, what, log, meta, seams }: { lock: string; what: string; log: PathLog; meta: Record<string, unknown>; seams: MigrationLockSeams },
  shouldRun: () => boolean,
  work: () => void,
): void => {
  const isAlive = seams.isAlive ?? processAlive;
  const deadline = Date.now() + (seams.waitMs ?? 120_000);
  let waitLogged = false;
  for (;;) {
    if (!shouldRun()) return;
    mkdirSync(dirname(lock), { recursive: true, mode: OWNER_ONLY });
    if (tryLock(lock)) {
      try {
        work();
      } finally {
        unlock(lock);
      }
      return;
    }
    const content = readText(lock);
    const owner = content === null ? null : Number.parseInt(content, 10);
    const ownerless = owner === null || !Number.isInteger(owner) || owner <= 0;
    let lockAgeMs = 0;
    try {
      lockAgeMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    const abandoned = ownerless ? lockAgeMs > (seams.ownerlessStaleMs ?? 30_000) : owner === process.pid || !isAlive(owner);
    if (abandoned) {
      log("warn", "breaking the lock of an interrupted migration", { ...meta, lock, pid: owner });
      breakStaleLock(lock, content);
      continue;
    }
    if (Date.now() >= deadline) {
      log("warn", `another process is still migrating the legacy ${what}; starting without waiting further`, { ...meta, pid: owner });
      return;
    }
    if (!waitLogged) {
      log("info", `another process is migrating the legacy ${what}; waiting for it`, { ...meta, pid: owner });
      waitLogged = true;
    }
    sleepSync(seams.pollMs ?? 100);
  }
};
