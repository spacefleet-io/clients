import { useEffect } from "react";
import { translate, useTranslation } from "@space/mobile-shell/i18n";
import { useAuth } from "../../store/auth";
import { useAppSettings } from "../appSettings";
import { scopeLogger } from "@space/mobile-shell/logger";
import { startDownloads } from "./downloadsStore";
import { downloadNotificationLabels } from "@space/mobile-media-proxy/downloads";

const log = scopeLogger("downloads");

/**
 * Keeps the native download engine configured with the current auth token,
 * Wi-Fi-only policy and notification text in the app language (UX-I18N-02),
 * loads the persisted queue and resumes unfinished work (app killed
 * mid-download, reboot, expired token). Mount once, signed in.
 */
export const useDownloadsBootstrap = (): void => {
  const { token } = useAuth();
  const [settings] = useAppSettings();
  const { i18n } = useTranslation();
  const wifiOnly = settings.downloadsWifiOnly;
  const language = i18n.language;

  useEffect(() => {
    if (!token) return;
    log.info("bootstrap.configure", { wifiOnly, language });
    startDownloads({ authToken: token, wifiOnly, labels: downloadNotificationLabels(translate) }).catch((err) =>
      log.error("bootstrap.failed", { error: String(err) }),
    );
  }, [token, wifiOnly, language]);
};
