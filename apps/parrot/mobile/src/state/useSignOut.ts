import { useCallback } from "react";
import { Alert } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { signOutAskingForSavedKey } from "@space/mobile-shell/libraryKey";
import { scopeLogger } from "@space/mobile-shell/logger";
import { libraryKeyStore } from "../lib/stores";
import { useSession } from "./session";

const log = scopeLogger("signOut");

/**
 * Parrot's Sign out (ACCT-DEV-03, `signOutAskingForSavedKey`): a phone that holds the library key first asks whether
 * it was saved, a phone without one (the key-entry screen before a key is saved) signs out at once.
 */
export const useSignOut = (): (() => Promise<void>) => {
  const { signOut } = useSession();
  const { t } = useTranslation();
  return useCallback(async () => {
    await signOutAskingForSavedKey({
      readStoredKey: libraryKeyStore.get,
      text: {
        title: t("parrot.settings.signOutKey.title"),
        body: t("parrot.settings.signOutKey.body"),
        cancel: t("parrot.settings.signOutKey.cancel"),
        confirm: t("parrot.settings.signOutKey.confirm"),
      },
      alert: Alert.alert,
      signOut,
      log: (event) => log.info(event, {}),
    });
  }, [signOut, t]);
};
