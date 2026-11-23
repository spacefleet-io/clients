import { useCallback } from "react";
import { Alert } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { signOutAskingForSavedKey } from "@space/mobile-shell/libraryKey";
import { scopeLogger } from "@space/mobile-shell/logger";
import { useAuth } from "../store/auth";
import { getStoredLibraryKey } from "./onboarding";

const log = scopeLogger("signOut");

/**
 * The phone's Sign out (ACCT-DEV-03, `signOutAskingForSavedKey`): a phone that holds the library key first asks
 * whether it was saved, a phone without one signs out at once.
 */
export const useSignOut = (): (() => Promise<void>) => {
  const { logout } = useAuth();
  const { t } = useTranslation();
  return useCallback(async () => {
    await signOutAskingForSavedKey({
      readStoredKey: getStoredLibraryKey,
      text: {
        title: t("account.signOutKey.title"),
        body: t("account.signOutKey.body"),
        cancel: t("account.signOutKey.cancel"),
        confirm: t("account.signOutKey.confirm"),
      },
      alert: Alert.alert,
      signOut: () => logout("signOut"),
      log: (event) => log.info(event, {}),
    });
  }, [logout, t]);
};
