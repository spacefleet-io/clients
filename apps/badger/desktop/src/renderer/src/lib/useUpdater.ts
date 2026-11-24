/**
 * Badger's renderer wrapper over the shared desktop updater hook (`@space/desktop-shell/updater-react`), bound to
 * `window.spaceBadger.updater`. The Settings "Check for updates" button, the update button in the header and the
 * mandatory "Update now" prompts all drive this one pipeline.
 */
import { useDesktopUpdater, type DesktopUpdaterControls } from "@space/desktop-shell/updater-react";
import { rendererLogger } from "@/logger";

export type { UpdaterPhase, UpdaterState } from "@space/desktop-shell/updater";

const updaterLog = rendererLogger.child({ scope: "updater" });
const logUpdaterError = (message: string, context: string) => updaterLog.error({ message }, context);

export const useUpdater = (): DesktopUpdaterControls =>
  useDesktopUpdater(typeof window !== "undefined" ? window.spaceBadger?.updater : undefined, logUpdaterError);
