/**
 * Badger's opt-in error reports (REL-LOG-06), on the phone app basis shared with Parrot (REL-FAM-03,
 * `@space/mobile-shell/errorReporting`): Badger only supplies its DSN, its version and where its answer is stored.
 */
import { startErrorReporting as startShared } from "@space/mobile-shell/errorReporting";
import packageJson from "../../package.json";
import { getBuildDsn } from "./errorReportConfig";
import { getAppSettings, loadAppSettings, subscribeAppSettings } from "./appSettings";

/** Called from `index.js` before React mounts. */
export const startErrorReporting = (): void =>
  startShared({
    app: "badger",
    dsn: getBuildDsn(),
    release: packageJson.version,
    setting: { load: loadAppSettings, get: getAppSettings, subscribe: subscribeAppSettings },
  });
