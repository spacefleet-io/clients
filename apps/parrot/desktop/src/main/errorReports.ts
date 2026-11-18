/**
 * Error reports (REL-LOG-06) for Parrot's main process, on the shared desktop basis Badger uses
 * (`@space/error-report/desktop-main`). Kept out of `index.ts`, which needs a running Electron, so tests drive it.
 */
import { join } from "node:path";
import { resolveDsn } from "@space/error-report";
import { createConsentFile } from "@space/error-report/consent-file";
import { parseForcedErrorReports } from "@space/error-report/desktop";
import { createErrorReports, type ErrorReportsController } from "@space/error-report/desktop-main";
import { createElectronMainReporting } from "@space/error-report/electron-main";
import type { ParrotSetupState } from "../shared/ipc";
import type { ParrotStore } from "./store";

/** The answer lives in `<userData>/error-reports.json`, the file Parrot always used, so earlier answers survive. */
export const createParrotErrorReports = (deps: {
  userDataDir: string;
  /** The build's Bugsink address (`__SF_BUGSINK_DSN__`); "" in a build without one, which never reports. */
  dsn: string;
  release: string;
  /** `process.env.SF_ERROR_REPORTS` */
  forcedRaw: string | undefined;
  log: (line: string) => void;
  fail: (line: string) => void;
}): ErrorReportsController =>
  createErrorReports({
    consent: createConsentFile(join(deps.userDataDir, "error-reports.json")),
    reporting: createElectronMainReporting({ dsn: deps.dsn, release: deps.release, app: "parrot", platform: "desktop" }),
    available: resolveDsn(deps.dsn) !== null,
    release: deps.release,
    forced: parseForcedErrorReports(deps.forcedRaw),
    log: deps.log,
    logError: deps.fail,
  });

/** Saves setup answers; the error-reports answer is stored and applied through the shared controller. */
export const createSetupSaver = (deps: {
  store: Pick<ParrotStore, "setup" | "updateSetup">;
  errorReports: Pick<ErrorReportsController, "setDecision">;
  applyStartAtLogin: (on: boolean) => void;
  log: (line: string) => void;
  fail: (line: string) => void;
}) => async (patch: Partial<ParrotSetupState>): Promise<void> => {
  const { store } = deps;
  const before = store.setup;
  await store.updateSetup(patch);
  deps.log(`[setup] saved ${Object.keys(patch).join(", ")} (step ${store.setup.step}, done=${store.setup.done})`);
  if (patch.startAtLogin !== undefined && (patch.done || patch.startAtLogin !== before.startAtLogin)) {
    try {
      deps.applyStartAtLogin(patch.startAtLogin);
    } catch (error) {
      deps.fail(`[login-item] could not apply: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (patch.errorReports !== undefined && (patch.done || patch.errorReports !== before.errorReports)) {
    try {
      await deps.errorReports.setDecision(patch.errorReports ? "on" : "off");
    } catch (error) {
      // Setup goes on: reporting stays as it was.
      deps.fail(`[error-report] could not store the setup answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

/**
 * Writes the Linux start-at-login entry again at launch (REL-UPD-04): an AppImage update moves the app to a
 * new file name, so the entry written by an older version would point at a file that no longer exists.
 */
export const reapplyStartAtLoginAtLaunch = (deps: {
  platform: NodeJS.Platform;
  setup: Pick<ParrotSetupState, "done" | "startAtLogin">;
  applyStartAtLogin: (on: boolean) => void;
  fail: (line: string) => void;
}): boolean => {
  if (deps.platform !== "linux" || !deps.setup.done || !deps.setup.startAtLogin) return false;
  try {
    deps.applyStartAtLogin(true);
  } catch (error) {
    deps.fail(`[login-item] could not rewrite at launch: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
};
