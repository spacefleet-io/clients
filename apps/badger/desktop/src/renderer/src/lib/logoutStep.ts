import { rendererLogger } from "@/logger";

const logoutLog = rendererLogger.child({ scope: "logout" });

/**
 * The longest one local cleanup step of sign-out may hold it (ACCT-DEV-01): past this the step is logged and sign-out
 * goes on without it, so the app always reaches the sign-in screen and the steps after it (forgetting the library key,
 * dropping the stored session) still run. Run 38822 waited 59 s on the metadata tickets step, then forever on the
 * library cache clear.
 */
export const LOGOUT_STEP_TIMEOUT_MS = 15_000;

/**
 * Runs one sign-out step and logs how long it took. A step that fails, or is still running after
 * `LOGOUT_STEP_TIMEOUT_MS`, is logged and left behind; this never throws.
 */
export const logoutStep = async (step: string, run: () => Promise<unknown>): Promise<void> => {
  const startedAt = Date.now();
  const bound = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => bound.resolve("timeout"), LOGOUT_STEP_TIMEOUT_MS);
  // A step that throws before returning its promise is a failed step, like one that rejects.
  const work = Promise.resolve().then(run);
  const outcome = await Promise.race([
    work.then(
      () => "done" as const,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    bound.promise,
  ]);
  clearTimeout(timer);
  const elapsedMs = Date.now() - startedAt;
  if (outcome === "timeout") {
    logoutLog.warn({ step, elapsedMs }, "logout step did not finish in time; signing out without it");
  } else if (outcome === "done") {
    logoutLog.info({ step, elapsedMs }, "logout step done");
  } else {
    logoutLog.warn({ step, elapsedMs, err: outcome }, "logout step failed; signing out without it");
  }
};
