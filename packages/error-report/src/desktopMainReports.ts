/**
 * REL-LOG-06 + REL-FAM-03: a desktop app's (Badger, Parrot) error reports, wired the same way in both main processes:
 * the answer in `<userData>/error-reports.json`, the Electron main SDK behind the opt-in gate, a build without a
 * reporting address never reporting, and `SF_ERROR_REPORTS=off` answering for one run.
 *
 * Its own entry (not `./desktop-main`) because it loads the Electron SDK, which the gate itself never needs.
 */
import { join } from "node:path";
import { createConsentFile } from "./consentFile";
import { parseForcedErrorReports } from "./desktop";
import { createErrorReports, type ErrorReportsController } from "./desktopMain";
import { createElectronMainReporting } from "./electronMain";
import { resolveDsn } from "./options";

export type DesktopErrorReportsDeps = {
  app: "badger" | "parrot";
  /** Electron's userData dir; the answer lives in `error-reports.json` there, the file both apps always used. */
  userDataDir: string;
  /** The build's Bugsink address (`__SF_BUGSINK_DSN__`); "" in a build without one, which never reports. */
  dsn: string;
  /** The app version reports are filed under. */
  release: string;
  /** `process.env.SF_ERROR_REPORTS` */
  forcedRaw: string | undefined;
  log: (line: string) => void;
  logError: (line: string) => void;
};

export const createDesktopErrorReports = (deps: DesktopErrorReportsDeps): ErrorReportsController =>
  createErrorReports({
    consent: createConsentFile(join(deps.userDataDir, "error-reports.json")),
    reporting: createElectronMainReporting({ dsn: deps.dsn, release: deps.release, app: deps.app, platform: "desktop" }),
    available: resolveDsn(deps.dsn) !== null,
    release: deps.release,
    forced: parseForcedErrorReports(deps.forcedRaw),
    log: deps.log,
    logError: deps.logError,
  });
