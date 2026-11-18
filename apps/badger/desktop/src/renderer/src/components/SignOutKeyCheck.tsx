import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSignOutWithKeyCheck as useSharedSignOutWithKeyCheck, type SignOutWithKeyCheck } from "@space/ui";
import { asksKeySavedBeforeSignOut } from "@space/shared/keptLibraryKey";
import { useAuth } from "@/auth";
import { getStoredLibraryKey } from "@/lib/onboarding";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "sign-out-key-check" });

/** Settings › Security with its "Show key" dialog already open (SecuritySection reads `showKey=1` once, then drops it). */
export const SHOW_KEY_SETTINGS_PATH = "/settings?section=security&showKey=1";

/**
 * Badger desktop's Sign out of this computer (ACCT-DEV-03, shared `useSignOutWithKeyCheck` in @space/ui): asks
 * whether the library key was saved when this computer holds it, and offers "Show my key", which opens Settings ›
 * Security's show-key dialog. A key store that cannot be read counts as holding a key.
 */
export function useSignOutWithKeyCheck(): SignOutWithKeyCheck {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const navigate = useNavigate();

  const holdsKey = useCallback(async () => {
    const storedKey = await getStoredLibraryKey().catch((error: unknown) => {
      log.warn({ err: error }, "could not read the stored library key; treating this computer as a holder");
      return "unknown";
    });
    const holds = asksKeySavedBeforeSignOut(storedKey);
    log.info({ holdsKey: holds }, "sign out requested");
    return holds;
  }, []);

  const signOut = useCallback(async () => {
    log.info({}, "signing out (user's own Sign out)");
    await logout("signOut");
    navigate("/login");
  }, [logout, navigate]);

  const text = useMemo(
    () => ({
      title: t("nav.signOutKeyCheck.title"),
      body: t("nav.signOutKeyCheck.body"),
      cancel: t("nav.signOutKeyCheck.cancel"),
      confirm: t("nav.signOutKeyCheck.confirm"),
      showKey: t("nav.signOutKeyCheck.showKey"),
    }),
    [t],
  );

  return useSharedSignOutWithKeyCheck({
    holdsKey,
    signOut,
    text,
    onShowKey: () => navigate(SHOW_KEY_SETTINGS_PATH),
    log: (event) => log.info({ event }, "saved-key question"),
  });
}
