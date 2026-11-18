/**
 * Hard backstop for the shutdown drain (#25, ultimate stress P4).
 *
 * `runShutdownDrain`'s deadline is a main-thread timer: it cannot fire while
 * the main thread is stuck in a synchronous call — a SQLite close that
 * checkpoints and fsyncs the WAL on a stalled disk, or Bun closing the
 * still-open databases inside `process.exit()`. The stress baseline showed a
 * runtime that logged a clean drain and then stayed alive for >10 s, and a
 * reopened app waiting 14–43 s for it.
 *
 * The watchdog runs in a Web Worker, whose own thread and event loop keep
 * running while the main thread is blocked. At `ms` it writes one line to
 * stderr (synchronously, so it lands before the kill) and SIGKILLs the
 * runtime. The kernel then frees the port at once. SQLite in WAL mode is
 * crash-safe, so a kill mid-close loses no committed write; in-flight jobs were
 * already requeued by `engineV2.stop()` earlier in the drain.
 *
 * A Web Worker from a blob URL, not `node:worker_threads` (which rejects blob
 * URLs) and not a separate source file (the runtime is also bundled into a
 * single file for the desktop app).
 */

const WATCHDOG_SOURCE = `
self.onmessage = (event) => {
  const { pid, ms, line } = event.data;
  setTimeout(() => {
    try { require("node:fs").writeSync(2, line); } catch {}
    process.kill(pid, "SIGKILL");
  }, ms);
};
`;

/**
 * Arms the watchdog: SIGKILLs this process `ms` from now unless it has exited
 * by then. Never disarmed — every path out of the drain ends in an exit.
 * Returns false where no Web Worker exists (the `start:node` dev path).
 */
export const armShutdownWatchdog = (ms: number, context: Record<string, unknown>): boolean => {
  if (typeof Worker === "undefined") return false;
  const url = URL.createObjectURL(new Blob([WATCHDOG_SOURCE], { type: "application/javascript" }));
  const worker = new Worker(url, { smol: true });
  const line = `[runtime] shutdown watchdog fired — SIGKILL ${JSON.stringify({ ...context, pid: process.pid, watchdogMs: ms })}\n`;
  worker.postMessage({ pid: process.pid, ms, line });
  // The pending watchdog must not keep a drained runtime alive. `{ ref: false }`
  // does not do it on Bun 1.3.5 (measured); `unref()` does, but bun-types'
  // Worker type omits it.
  (worker as Worker & { unref(): void }).unref();
  return true;
};
