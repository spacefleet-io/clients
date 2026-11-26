/**
 * Bun preload for runtime-relaunch-drain.integration.test.ts (#25 P4).
 *
 * Reproduces the slow SIGTERM drain seen in the ultimate stress baseline: the
 * LAST connection to a WAL database checkpoints and fsyncs on close, and on a
 * stalled disk that synchronous `close()` blocked the runtime's main thread
 * for 4.7–14.2 s while its listening socket stayed open.
 *
 * Patches both SQLite drivers the runtime may resolve (`node:sqlite` first,
 * then `bun:sqlite` — see packages/runtime-jobs-engine/src/sqliteStore.ts) so closing the last live
 * handle on a file whose path ends with SF_TEST_SLOW_CLOSE_SUFFIX busy-waits
 * SF_TEST_SLOW_CLOSE_MS first. A handle counts as live from its first
 * exec/query/prepare (every store runs a PRAGMA right after opening) until
 * its close.
 */
import { createRequire } from "node:module";
import { writeSync } from "node:fs";

const require = createRequire(import.meta.url);
const slowMs = Number(process.env.SF_TEST_SLOW_CLOSE_MS ?? 0);
const suffix = process.env.SF_TEST_SLOW_CLOSE_SUFFIX ?? "runtime_jobs.db";
const live = new Map<string, Set<object>>();

type Handle = { filename?: string; location?: () => string | null };
type Proto = Record<string, (...args: unknown[]) => unknown>;

const fileOf = (db: Handle): string => {
  if (typeof db.filename === "string") return db.filename;
  try {
    return db.location?.() ?? "";
  } catch {
    return "";
  }
};

const patch = (driver: string, proto: Proto | undefined) => {
  if (!proto || typeof proto.close !== "function") return;
  for (const method of ["exec", "run", "query", "prepare"]) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function (this: Handle, ...args: unknown[]) {
      const file = fileOf(this);
      let handles = live.get(file);
      if (!handles) {
        handles = new Set();
        live.set(file, handles);
      }
      handles.add(this);
      return original.apply(this, args);
    };
  }
  const originalClose = proto.close;
  proto.close = function (this: Handle, ...args: unknown[]) {
    const file = fileOf(this);
    const handles = live.get(file);
    handles?.delete(this);
    if (slowMs > 0 && file.endsWith(suffix) && (handles?.size ?? 0) === 0) {
      writeSync(2, `[slow-last-close] ${driver}: blocking ${slowMs} ms in close(${file})\n`);
      const until = Date.now() + slowMs;
      while (Date.now() < until) {
        // Synchronous on purpose: a WAL checkpoint+fsync blocks the event loop.
      }
      writeSync(2, `[slow-last-close] ${driver}: close(${file}) unblocked\n`);
    }
    return originalClose.apply(this, args);
  };
  writeSync(2, `[slow-last-close] ${driver} patched slowMs=${slowMs} suffix=${suffix}\n`);
};

for (const [driver, exportName] of [
  ["node:sqlite", "DatabaseSync"],
  ["bun:sqlite", "Database"],
] as const) {
  try {
    const ctor = (require(driver) as Record<string, { prototype: Proto } | undefined>)[exportName];
    patch(driver, ctor?.prototype);
  } catch {
    // Driver not available in this Bun build.
  }
}
