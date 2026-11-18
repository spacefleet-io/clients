import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AppUpdateRequiredPayload } from "@space/shared/appVersion";
import { DesktopUpdateRequiredScreen } from "@space/desktop-shell/updater-required";
import { rendererLogger } from "@/logger";
import { useUpdater } from "@/lib/useUpdater";
import { useClientSettings } from "@/lib/settings/useClientSettings";

const gateLog = rendererLogger.child({ scope: "app-update-required" });

/**
 * REL-CD-29: this build is too old, so the app shows the shared blocking update screen (`DesktopUpdateRequiredScreen`,
 * the same one Parrot shows) on every screen, sign-in included. Two signals say so, and they read the same minimum on
 * the API side:
 *  - `refusal`: an API call was refused with "please update" (426). The gate then checks once for the update the user
 *    now needs.
 *  - no `refusal`: the desktop `release-status` reported this build below `minClientVersion` (the updater's latched
 *    `state.mandatory`). That answer came from a check the main process already ran, so the gate checks nothing more.
 * `App` mounts it above the routes, so it also covers the signed-out screens; `LibraryUpdateGate` and
 * `UpdateReadyNotice` leave both cases to it.
 */
export default function AppUpdateRequiredGate({ refusal }: { refusal: AppUpdateRequiredPayload | null }) {
  const { i18n } = useTranslation();
  const updater = useUpdater();
  const { check } = updater;
  // The automatic-updates switch on the screen is the same window setting as Settings › About & updates.
  const { config, updateSetting } = useClientSettings();

  // One check per refusal: the refusal never clears, and `check` stays the same for the window's life. The mandatory
  // flag is latched too, so either signal logs once.
  useEffect(() => {
    if (!refusal) {
      gateLog.warn({}, "mandatory update reported by release-status");
      return;
    }
    gateLog.warn({ refusal }, "app update required by the API");
    void check();
  }, [refusal, check]);

  return (
    <DesktopUpdateRequiredScreen
      controls={updater}
      language={i18n.language}
      appName="Badger"
      autoUpdate={{ checked: config.autoUpdate, onCheckedChange: (enabled) => updateSetting("autoUpdate", enabled) }}
    />
  );
}
