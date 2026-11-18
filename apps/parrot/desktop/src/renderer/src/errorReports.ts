/**
 * REL-LOG-06: this window's instance of the shared renderer error reports (@space/error-report/desktop-renderer).
 * Main keeps the answer and makes the network call; this window starts its own error catcher only while the answer
 * is "on". Settings and the setup flow change the answer through this instance, so it applies without a restart.
 */
import { createRendererErrorReports } from "@space/error-report/desktop-renderer";

export const errorReportsLog = {
  info: (fields: Record<string, unknown>, message: string) => console.info(message, fields),
  error: (fields: Record<string, unknown>, message: string) => console.error(message, fields),
};

export const errorReports = createRendererErrorReports({
  bridge: () => window.parrot?.errorReports,
  // Dynamic on purpose: nothing is fetched for a user who said no.
  createReporting: async (release) =>
    (await import("@space/error-report/electron-renderer")).createElectronRendererReporting({ release, app: "parrot" }),
  log: errorReportsLog,
});

/** Reads main's answer and applies it in this window. Never throws; the boot never holds up a render. */
export const applyErrorReports = (): Promise<void> =>
  errorReports.boot().then(
    () => undefined,
    (err: unknown) => errorReportsLog.error({ err: String(err) }, "[error-report] could not read the answer; reporting stays off"),
  );
