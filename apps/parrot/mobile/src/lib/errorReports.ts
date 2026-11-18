/**
 * Parrot's opt-in error reports (REL-LOG-06), on the phone app basis shared with Badger (REL-FAM-03,
 * `@space/mobile-shell/errorReporting`). Parrot supplies its DSN, its version and where the answer is stored: this
 * phone only (AsyncStorage `parrot.errorReports`), never synced. Off until the user turns the Settings switch on.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { startErrorReporting, type ErrorReportsSetting } from "@space/mobile-shell/errorReporting";
import { scopeLogger } from "@space/mobile-shell/logger";
import packageJson from "../../package.json";

const KEY = "parrot.errorReports";
const log = scopeLogger("error-reports");

let setting: ErrorReportsSetting = { errorReports: false, errorReportsDecided: false };
const listeners = new Set<() => void>();

/** The answer as last read or set; the default (never asked) means off. */
export const getErrorReportsSetting = (): ErrorReportsSetting => setting;

export const subscribeErrorReportsSetting = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Reads the stored answer; anything unreadable or unrecognised stays "never asked" (off). */
export const loadErrorReportsSetting = async (): Promise<ErrorReportsSetting> => {
  const raw = await AsyncStorage.getItem(KEY);
  const stored: unknown = raw ? JSON.parse(raw) : null;
  if (stored && typeof stored === "object" && "errorReports" in stored && typeof stored.errorReports === "boolean") {
    setting = { errorReports: stored.errorReports, errorReportsDecided: true };
    for (const listener of listeners) listener();
  }
  return setting;
};

/** Stores the user's answer; reporting follows at once, without a restart. */
export const setErrorReports = async (on: boolean): Promise<void> => {
  await AsyncStorage.setItem(KEY, JSON.stringify({ errorReports: on }));
  setting = { errorReports: on, errorReportsDecided: true };
  log.info("answer.stored", { on });
  for (const listener of listeners) listener();
};

/** Metro treats a `require` inside `try` as an optional dependency, so a build without the generated file still bundles. */
const readBuildDsn = (): string => {
  try {
    const generated: { PARROT_MOBILE_DSN?: string } = require("../generated/errorReportConfig");
    return generated.PARROT_MOBILE_DSN ?? "";
  } catch {
    return "";
  }
};

/** Called from `index.js` before React mounts. */
export const startParrotErrorReporting = (dsn: string = readBuildDsn()): void =>
  startErrorReporting({
    app: "parrot",
    dsn,
    release: packageJson.version,
    setting: { load: loadErrorReportsSetting, get: getErrorReportsSetting, subscribe: subscribeErrorReportsSetting },
  });
