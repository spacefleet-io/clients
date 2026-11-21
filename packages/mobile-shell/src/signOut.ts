/**
 * The phone apps' Sign out hook (ACCT-DEV-03, `signOutAskingForSavedKey`): a phone that holds the library key first
 * asks whether it was saved, a phone without one signs out at once. Badger and Parrot pass their key store, their
 * session's sign-out and the i18n prefix of their `title`/`body`/`cancel`/`confirm` texts.
 */
import { useCallback } from "react";
import { Alert } from "react-native";
import { useTranslation } from "./i18n";
import { signOutAskingForSavedKey } from "./libraryKey";
import { scopeLogger } from "./logger";

const log = scopeLogger("signOut");

export const useMobileSignOut = ({
  readStoredKey,
  signOut,
  keyPrefix,
}: {
  readStoredKey: () => Promise<string | null>;
  signOut: () => Promise<void>;
  /** The i18n key holding the question's texts, e.g. `account.signOutKey`. */
  keyPrefix: string;
}): (() => Promise<void>) => {
  const { t } = useTranslation();
  return useCallback(async () => {
    await signOutAskingForSavedKey({
      readStoredKey,
      text: {
        title: t(`${keyPrefix}.title`),
        body: t(`${keyPrefix}.body`),
        cancel: t(`${keyPrefix}.cancel`),
        confirm: t(`${keyPrefix}.confirm`),
      },
      alert: Alert.alert,
      signOut,
      log: (event) => log.info(event, {}),
    });
  }, [readStoredKey, signOut, keyPrefix, t]);
};
