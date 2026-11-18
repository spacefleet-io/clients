/**
 * Errors the crash guards catch (UX-CRASH-01) never reach the SDKs' global handlers: React keeps them inside the
 * boundary. Each guard hands them here; the reporting adapter that is running (phone, TV, desktop window, browser)
 * plugs its `captureException` in while reporting is on and unplugs it when it stops, so with reporting off a caught
 * error goes nowhere (REL-LOG-06). No imports on purpose: the UI packages load this without any SDK code.
 */

/** Which kind of guard caught the error: a fixed word, never the guarded element's name (it can hold a route or an id). */
export type CaughtErrorGuard = "window" | "screen" | "section" | "overlay" | "item" | "popup";

export type CaughtErrorSink = (error: unknown, guard: CaughtErrorGuard) => void;

let sink: CaughtErrorSink | undefined;

/** Plugs in (or, with `undefined`, unplugs) the running adapter. */
export const setCaughtErrorSink = (next: CaughtErrorSink | undefined): void => {
  sink = next;
};

/** Called by every crash guard; does nothing while reporting is off. Never throws into the guard. */
export const reportCaughtError = (error: unknown, guard: CaughtErrorGuard): void => {
  try {
    sink?.(error, guard);
  } catch (err) {
    console.warn("[error-report] could not report a caught error", err);
  }
};
