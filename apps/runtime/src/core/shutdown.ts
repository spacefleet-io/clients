/**
 * Graceful-shutdown drain with a hard deadline (#25, ultimate stress P1).
 *
 * The runtime's SIGTERM handler said "exit on a timer if either hangs", but no
 * timer existed: `engineV2.stop()` awaits in-flight steps, and under a loaded
 * disk a sync SQLite commit can sit in fsync for seconds. The guardian waits
 * `childKillGraceMs` (5 s) after SIGTERM and then SIGKILLs, so a slow drain
 * looked like "the runtime ignores SIGTERM" and every in-flight write was cut
 * at a random point. This drains best-effort and always exits by the deadline,
 * inside the guardian's grace.
 */

export type ShutdownStep = {
  name: string;
  run: () => unknown;
  /**
   * Own time limit for a step that can wait on something unbounded (a queue
   * behind in-flight work). Given the drain time still left, returns how long
   * this step may run; past it the drain moves on and the step is left to
   * finish (or fail, which is logged) on its own. Without it a step may use
   * the whole remaining drain.
   */
  limitMs?: (remainingMs: number) => number;
};

export type ShutdownDrainOptions = {
  signal: string;
  deadlineMs: number;
  exit: (code: number) => void;
  log?: (message: string, data: Record<string, unknown>) => void;
  now?: () => number;
};

const defaultLog = (message: string, data: Record<string, unknown>) => {
  console.warn(`[runtime] ${message} ${JSON.stringify(data)}`);
};

export const runShutdownDrain = async (steps: ShutdownStep[], options: ShutdownDrainOptions): Promise<void> => {
  const log = options.log ?? defaultLog;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let exited = false;
  let current = "(none)";
  const exitOnce = (code: number, reason: string) => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    log("shutdown exit", { signal: options.signal, reason, code, elapsedMs: now() - startedAt, step: current });
    options.exit(code);
  };
  const forceExit = () => {
    log("shutdown drain exceeded deadline — forcing exit", {
      signal: options.signal,
      deadlineMs: options.deadlineMs,
      stuckStep: current,
    });
    exitOnce(1, "deadline");
  };
  const deadline = setTimeout(forceExit, options.deadlineMs);
  for (const step of steps) {
    if (exited) return;
    current = step.name;
    const stepStartedAt = now();
    let timedOut = false;
    try {
      if (step.limitMs) {
        const limitMs = Math.max(0, step.limitMs(options.deadlineMs - (stepStartedAt - startedAt)));
        const pending = (async () => step.run())();
        const limit = Promise.withResolvers<"timeout">();
        const timer = setTimeout(() => limit.resolve("timeout"), limitMs);
        try {
          const outcome = await Promise.race([pending.then(() => "done" as const), limit.promise]);
          if (outcome === "timeout") {
            timedOut = true;
            log("shutdown step exceeded its limit; continuing the drain", { step: step.name, limitMs });
            // The step keeps running; a late failure must not vanish.
            pending.catch((err) =>
              log("shutdown step failed after its limit", { step: step.name, error: err instanceof Error ? err.message : String(err) })
            );
          }
        } finally {
          clearTimeout(timer);
        }
      } else {
        await step.run();
      }
    } catch (err) {
      log("shutdown step failed", { step: step.name, error: err instanceof Error ? err.message : String(err) });
    }
    if (exited) return;
    log("shutdown step done", { step: step.name, ms: now() - stepStartedAt, ...(timedOut ? { timedOut: true } : {}) });
    // #25 P4: a synchronous step (a SQLite close fsyncing the WAL) blocks the
    // main thread, so the timer above could not fire during it. Report the
    // overrun as the deadline exit it is, never as a clean drain.
    if (now() - startedAt >= options.deadlineMs) {
      forceExit();
      return;
    }
  }
  current = "(done)";
  exitOnce(0, "drained");
};
