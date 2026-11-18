/**
 * Opt-in error reports (REL-LOG-06) for the phone apps (Badger, Parrot: REL-FAM-03, one app basis). Off until the user
 * says yes (setup step or Settings): while the answer is off, or unknown because storage could not be read, the
 * reporting SDK is never initialised and nothing is sent. Turning it on starts reporting at once, turning it off stops
 * it, both without a restart. Each app keeps the answer in its own local settings (AsyncStorage); it is never part of
 * anything the account syncs.
 */
import { Platform } from "react-native";
import { createReactNativeReporting } from "@space/error-report/react-native";
import type { ErrorReporting, ReportApp } from "@space/error-report";
import { scopeLogger } from "./logger";
import { errorReportsOffered, setErrorReportsOffered } from "./errorReportsOffered";

const log = scopeLogger("error-reports");

/** The stored answer. `errorReportsDecided` is false until the user was asked. */
export type ErrorReportsSetting = { errorReports: boolean; errorReportsDecided: boolean };

/** Whether the user's stored choice means "send". An unanswered question is "no". */
export const wantsErrorReports = (settings: ErrorReportsSetting): boolean => settings.errorReportsDecided && settings.errorReports;

export type ErrorReportsSettingSource = {
  load: () => Promise<unknown>;
  get: () => ErrorReportsSetting;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Keeps `reporting` in step with the saved choice: applies it once the settings are read, then on every change.
 * A settings read that fails leaves the defaults (off). Returns a function that stops following the settings.
 */
export const followErrorReportSetting = (reporting: ErrorReporting, source: ErrorReportsSettingSource): (() => void) => {
  const apply = () => {
    const want = wantsErrorReports(source.get());
    reporting.setEnabled(want).catch((error: unknown) => {
      log.warn("apply.failed", { want, message: error instanceof Error ? error.message : String(error) });
    });
  };
  const unsubscribe = source.subscribe(apply);
  source
    .load()
    .catch((error: unknown) => {
      log.warn("load.failed", { message: error instanceof Error ? error.message : String(error) });
    })
    .then(apply);
  return unsubscribe;
};

let started = false;

/**
 * Called from the app's `index.js` before React mounts. The first apply is the user's saved answer; the SDK is only
 * touched when that answer is "send" and this build has a DSN (`dsn` comes from the app's generated build config,
 * empty string when the build has none, as `ReporterConfig` expects). A build with no DSN neither asks the question nor
 * shows the switch (`errorReportsOffered`, issue #2570). Every report names the app and whether it ran on a phone or a TV.
 */
export const startErrorReporting = (options: {
  app: ReportApp;
  dsn: string;
  release: string;
  setting: ErrorReportsSettingSource;
}): void => {
  if (started) return;
  started = true;
  setErrorReportsOffered(options.dsn);
  log.info("start", { offered: errorReportsOffered() });
  const platform = Platform.isTV === true ? "tv" : "phone";
  followErrorReportSetting(
    createReactNativeReporting({ dsn: options.dsn, release: options.release, app: options.app, platform }),
    options.setting,
  );
};
