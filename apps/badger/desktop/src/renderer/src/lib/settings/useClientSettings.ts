import { useState } from "react";
import { ClientConfig, loadClientConfig, saveClientConfig } from "@/lib/config";
import { setUiLanguage } from "@/i18n";
import { announceUiLanguagePick } from "@/lib/accountUiLanguage";

/**
 * Owns the locally-persisted ClientConfig for a settings section and exposes
 * the two writers the old God component carried inline. Side effects that must
 * fire on specific field writes (i18n language switch, arming the main-process
 * auto-updater) live here, so individual sections stay declarative.
 */
export function useClientSettings() {
  const [config, setConfig] = useState<ClientConfig>(() => loadClientConfig());

  const updateSetting = <K extends keyof ClientConfig>(key: K, value: ClientConfig[K]) => {
    const next = { ...config, [key]: value, configured: true, ...(key === "autoUpdate" ? { autoUpdateChosen: true } : {}) };
    setConfig(next);
    saveClientConfig(next);

    if (key === "uiLanguage") {
      void setUiLanguage(next.uiLanguage);
      // While signed in the pick becomes the account's language (AuthProvider PATCHes it).
      announceUiLanguagePick(next.uiLanguage);
    }
    if (key === "autoUpdate") {
      // Mirror the setting down so the main process arms/disarms its 6h background update check.
      void window.spaceBadger?.updater?.setAutoUpdate?.(Boolean(value));
    }
  };

  const updateNestedSetting = (patch: Partial<ClientConfig>) => {
    const next = { ...config, ...patch, configured: true };
    setConfig(next);
    saveClientConfig(next);
  };

  return { config, setConfig, updateSetting, updateNestedSetting };
}
