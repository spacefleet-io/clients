/**
 * Bounded, abortable, logged wait for a resume-after-restart prerequisite.
 *
 * Jobs persisted across a runtime SIGKILL are re-queued at boot, i.e. BEFORE
 * the desktop re-attaches the user session (backend token via badger.db.open /
 * keys/set, library DB re-open). The runtime keeps the token and the library
 * key in memory only (RT-SEC-05: never in a job payload, never on disk), so a
 * step that needs them waits here for the push instead of failing terminally;
 * only a wait that expires surfaces the step's own error code.
 */

import type { LibraryReadyWait } from "./deps";

/**
 * Default bound for the resume-after-restart auth/library readiness wait.
 * Generous vs. the guardian respawn + desktop re-attach path (respawn ≈ a few
 * seconds, desktop `reopenAfterRuntimeReady` backoff totals 30 s) but finite so
 * a logged-out user's resumed job still fails with a clear error.
 */
const DEFAULT_AUTH_WAIT_MS = 120_000;
const DEFAULT_AUTH_POLL_MS = 250;
const AUTH_WAIT_PROGRESS_LOG_MS = 5_000;

/** Step identity for the readiness waits; same shape as the deps contract's. */
export type AuthWaitContext = LibraryReadyWait;

export const resolveAuthWaitMs = (configured: number | undefined): number => {
  if (configured !== undefined) return Math.max(0, Math.trunc(configured));
  const raw = process.env.SF_BADGER_AUTH_WAIT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return DEFAULT_AUTH_WAIT_MS;
};

/** Resolves after `ms`, or as soon as `signal` aborts (caller re-checks the signal). */
export const sleepOrAbort = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export type AuthWaiter = {
  authWaitMs: number;
  waitForReady: <T>(
    what: string,
    probe: () => T | null | undefined | false | "",
    ctx: AuthWaitContext
  ) => Promise<T | null>;
};

export const createAuthWaiter = (
  opts: { authWaitMs?: number; authPollMs?: number } = {}
): AuthWaiter => {
  const authWaitMs = resolveAuthWaitMs(opts.authWaitMs);
  const authPollMs = Math.max(1, opts.authPollMs ?? DEFAULT_AUTH_POLL_MS);
  const waitForReady = async <T>(
    what: string,
    probe: () => T | null | undefined | false | "",
    ctx: AuthWaitContext
  ): Promise<T | null> => {
    const immediate = probe();
    if (immediate) return immediate;
    const startedAt = Date.now();
    const deadline = startedAt + authWaitMs;
    const logBase = { what, stage: ctx.stage, jobId: ctx.jobId, userId: ctx.userId, authWaitMs };
    console.info(JSON.stringify({ event: "badger.deps.auth_wait.start", ...logBase }));
    let lastProgressLogAt = startedAt;
    for (;;) {
      if (ctx.signal.aborted) throw new Error("CANCELLED");
      const now = Date.now();
      if (now >= deadline) {
        console.warn(
          JSON.stringify({ event: "badger.deps.auth_wait.timeout", ...logBase, waitedMs: now - startedAt })
        );
        return null;
      }
      await sleepOrAbort(Math.min(authPollMs, deadline - now), ctx.signal);
      if (ctx.signal.aborted) throw new Error("CANCELLED");
      const value = probe();
      if (value) {
        console.info(
          JSON.stringify({ event: "badger.deps.auth_wait.ready", ...logBase, waitedMs: Date.now() - startedAt })
        );
        return value;
      }
      if (Date.now() - lastProgressLogAt >= AUTH_WAIT_PROGRESS_LOG_MS) {
        lastProgressLogAt = Date.now();
        console.info(
          JSON.stringify({ event: "badger.deps.auth_wait.waiting", ...logBase, waitedMs: lastProgressLogAt - startedAt })
        );
      }
    }
  };
  return { authWaitMs, waitForReady };
};
