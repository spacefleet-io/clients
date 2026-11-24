/**
 * Badger's renderer wrapper over the shared desktop updater hook (`@space/desktop-shell/updater-react`), bound to
 * `window.spaceBadger.updater`. The Settings "Check for updates" button, the update button in the header and the
 * mandatory "Update now" prompts all drive this one pipeline.
 */
import { useEffect } from "react";
import { useDesktopUpdater, type DesktopUpdaterControls } from "@space/desktop-shell/updater-react";
import { loadClientConfig } from "@/lib/config";
import { rendererLogger } from "@/logger";

export type { UpdaterPhase, UpdaterState } from "@space/desktop-shell/updater";

const updaterLog = rendererLogger.child({ scope: "updater" });
const logUpdaterError = (message: string, context: string) => updaterLog.error({ message }, context);

export const useUpdater = (): DesktopUpdaterControls =>
  useDesktopUpdater(typeof window !== "undefined" ? window.spaceBadger?.updater : undefined, logUpdaterError);

/**
 * REL-UPD-01: at start, pushes the stored `autoUpdate` window setting (ON by default) down to the main process, which
 * arms the start-up check and the 6-hour background check; the Settings switch pushes later changes. Mounted once by
 * `App`, on every screen, signed in or out.
 */
export const usePushStoredAutoUpdate = (): void => {
  useEffect(() => {
    void window.spaceBadger?.updater?.setAutoUpdate(loadClientConfig().autoUpdate);
  }, []);
};
