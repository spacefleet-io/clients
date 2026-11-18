/**
 * REL-LOG-06: this window's instance of the shared renderer error reports
 * (@space/error-report/desktop-renderer). Main owns the answer and the network
 * call; this window only starts its own error catcher while the answer is "on".
 */
import { createRendererErrorReports } from "@space/error-report/desktop-renderer";
import { rendererLogger } from "@/logger";

export const errorReportsLog = rendererLogger.child({ scope: "error-report" });

export const errorReports = createRendererErrorReports({
  bridge: () => window.sf?.errorReports,
  // Dynamic on purpose: the adapter stays out of the entry chunk and is fetched only after opt-in (renderer chunk budget).
  createReporting: async (release) =>
    (await import("@space/error-report/electron-renderer")).createElectronRendererReporting({ release, app: "badger" }),
  log: errorReportsLog,
});

/** Called once from the window entry. Never throws. */
export const bootErrorReports = (): Promise<void> =>
  errorReports.boot().then(
    () => undefined,
    (err: unknown) => errorReportsLog.error({ err: String(err) }, "[error-report] could not read the answer; reporting stays off"),
  );
