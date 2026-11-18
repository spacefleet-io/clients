/**
 * REL-LOG-06: opt-in error reports, main-process side, for every desktop app (Badger, Parrot). Owns the user's answer
 * (a small consent file in userData) and the reporting SDK behind it, so an app's main entry only wires it.
 *
 * Reporting is off until the answer is "on": the SDK is not initialised and no network call is made before that.
 * Nothing here reads or logs user data, only the on / off / undecided answer.
 */
import type { ErrorReporting } from "./controller";
import type { ConsentFile } from "./consentFile";
import { ERROR_REPORTS_GET_CHANNEL, ERROR_REPORTS_SET_CHANNEL, isErrorReportsAnswer, type ErrorReportsState } from "./desktop";

export type ErrorReportsDeps = {
  consent: ConsentFile;
  reporting: ErrorReporting;
  /** True when this build carries a valid reporting address. */
  available: boolean;
  /** The app version reports are filed under. */
  release: string;
  /** SF_ERROR_REPORTS=off: answers the question for this run without touching the file. */
  forced?: "off" | null;
  /** The app's log: one line per answer applied. */
  log: (line: string) => void;
  /** The app's log for a failure to apply the answer (reporting then stays off). */
  logError: (line: string) => void;
};

export type ErrorReportsController = {
  getState(): ErrorReportsState;
  /** Applies the stored answer; call once, as early as the app can. Never throws. */
  start(): Promise<void>;
  /** Stores the answer, then starts or stops reporting at once. Rejects on anything but "on" / "off". */
  setDecision(value: unknown): Promise<ErrorReportsState>;
};

export const createErrorReports = (deps: ErrorReportsDeps): ErrorReportsController => {
  const decision = () => deps.forced ?? deps.consent.read();
  const state = (): ErrorReportsState => ({ decision: decision(), available: deps.available, release: deps.release });
  // A build without a reporting address never starts the SDK, whatever the answer.
  const apply = async () => deps.reporting.setEnabled(decision() === "on" && deps.available);

  return {
    getState: state,
    async start() {
      try {
        await apply();
        deps.log(`[error-report] answer=${decision()} available=${deps.available} reporting=${deps.reporting.isEnabled() ? "on" : "off"}`);
      } catch (err) {
        deps.logError(`[error-report] could not apply the stored answer; reporting stays off: ${String(err)}`);
      }
    },
    async setDecision(value) {
      if (!isErrorReportsAnswer(value)) throw new Error(`invalid error-reports answer: ${String(value)}`);
      if (deps.forced) {
        deps.log(`[error-report] answer ignored: forced ${deps.forced} by SF_ERROR_REPORTS`);
        return state();
      }
      deps.consent.write(value);
      await apply();
      deps.log(`[error-report] answer=${value} stored, reporting=${deps.reporting.isEnabled() ? "on" : "off"}`);
      return state();
    },
  };
};

/** Electron's `ipcMain`, structurally, so this package does not depend on electron. */
export type IpcHandle = { handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void };

export const registerErrorReportsIpc = (ipc: IpcHandle, controller: ErrorReportsController): void => {
  ipc.handle(ERROR_REPORTS_GET_CHANNEL, () => controller.getState());
  ipc.handle(ERROR_REPORTS_SET_CHANNEL, (_event, value: unknown) => controller.setDecision(value));
};
