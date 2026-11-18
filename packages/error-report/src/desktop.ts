/**
 * REL-LOG-06: the user's choice about sending error reports to SpaceFleet, for every desktop app (Badger, Parrot).
 * Shared by the main process (`./desktop-main`), the preload bridge and the renderer (`./desktop-renderer`). The
 * choice lives in `<userData>/error-reports.json` on this computer only; it is never part of anything the account
 * syncs.
 */
export type ErrorReportsDecision = "on" | "off" | "undecided";

export type ErrorReportsState = {
  /** `undecided` until the user answers the setup step or flips the Settings switch. */
  decision: ErrorReportsDecision;
  /** False when this build carries no reporting address: the choice can be stored but nothing is ever sent. */
  available: boolean;
  /** The app version a report is filed under. */
  release: string;
};

/** What the preload exposes to the renderer (`window.sf.errorReports` in Badger, `window.parrot.errorReports` in Parrot). */
export type ErrorReportsBridge = {
  get(): Promise<ErrorReportsState>;
  set(decision: "on" | "off"): Promise<ErrorReportsState>;
};

export const ERROR_REPORTS_GET_CHANNEL = "sf-error-reports-get";
export const ERROR_REPORTS_SET_CHANNEL = "sf-error-reports-set";

/**
 * `SF_ERROR_REPORTS=off`: test harnesses with a fresh userData answer the
 * question for the run (the way SF_TRANSCODE_FALLBACK_COPY does), so no setup
 * step waits for a click. Only "off" exists: a harness never turns reporting on.
 */
export const parseForcedErrorReports = (raw: string | undefined): "off" | null => (raw?.trim().toLowerCase() === "off" ? "off" : null);

export const isErrorReportsAnswer = (value: unknown): value is "on" | "off" => value === "on" || value === "off";

/** The preload half of the bridge, built from the renderer's `ipcRenderer`. */
export const createErrorReportsBridge = (ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }): ErrorReportsBridge => ({
  get: () => ipc.invoke(ERROR_REPORTS_GET_CHANNEL) as Promise<ErrorReportsState>,
  set: (decision) => ipc.invoke(ERROR_REPORTS_SET_CHANNEL, decision) as Promise<ErrorReportsState>,
});
