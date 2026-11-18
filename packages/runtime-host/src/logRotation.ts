import { closeSync, copyFileSync, existsSync, openSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";

/** `runtime.log` is rotated once it reaches this size (issue #671, R8). */
export const RUNTIME_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Files kept: `runtime.log` plus `runtime.log.1` .. `runtime.log.<KEEP-1>`, so at most 5 x 10 MB. */
export const RUNTIME_LOG_KEEP_FILES = 5;

/** A rotation takes milliseconds; a lock older than this belongs to a guardian that died mid-rotation. */
const LOCK_STALE_MS = 30_000;

export type LogRotationOptions = {
  maxBytes?: number;
  keepFiles?: number;
};

/**
 * Rotate `logPath` when it is at least `maxBytes`: `.1` becomes `.2`, and so
 * on, the oldest beyond `keepFiles` is deleted, and the log moves to `.1`.
 * The log is copied to `.1` and truncated in place, never renamed: the runtime
 * (or an older one the guardian adopted) holds it open and keeps appending, and
 * its fd is in append mode, so its next write lands at the new end. A few lines
 * written between the copy and the truncate can be lost. Rotation, never
 * removal of content the user may be asked to send us (RT-LOG-01). Returns true when it rotated. Never throws: a log that cannot
 * rotate must not stop the runtime from starting or the health monitor.
 */
export const rotateLogIfLarge = (logPath: string, options: LogRotationOptions = {}): boolean => {
  const maxBytes = options.maxBytes ?? RUNTIME_LOG_MAX_BYTES;
  const keepFiles = Math.max(2, options.keepFiles ?? RUNTIME_LOG_KEEP_FILES);
  try {
    if (!existsSync(logPath) || statSync(logPath).size < maxBytes) return false;
  } catch {
    return false;
  }
  // Every app's guardian shares one data dir; only one may rotate at a time.
  const lockPath = `${logPath}.rotate.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
    } catch {
      // lock vanished or unreadable: the next health tick retries
    }
    return false;
  }
  try {
    // Re-check under the lock: the other guardian may have rotated already.
    if (statSync(logPath).size < maxBytes) return false;
    rmSync(`${logPath}.${keepFiles - 1}`, { force: true });
    for (let i = keepFiles - 2; i >= 1; i--) {
      if (existsSync(`${logPath}.${i}`)) renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
    }
    copyFileSync(logPath, `${logPath}.1`);
    truncateSync(logPath, 0);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
};
