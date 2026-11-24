// Badger's language on phone and TV (UX-I18N-01): the start language, and Badger's instance of the shared
// account-language chain (UX-I18N-07, `@space/mobile-shell/account-language-sync`), wired to the session by
// `useAccountLanguageSync`.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { changeLanguage, getCurrentLanguage, initI18n } from "@space/mobile-shell/i18n";
import { pickStartLanguage, readDeviceLocale } from "@space/mobile-shell/i18n/deviceLanguage";
import { createAccountLanguageSync } from "@space/mobile-shell/account-language-sync";
import { scopeLogger } from "@space/mobile-shell/logger";

const log = scopeLogger("i18n");

/** AsyncStorage key of the language the user picked (or the account's language once applied after sign-in). */
export const UI_LANGUAGE_KEY = "sf_ui_language";
/** AsyncStorage key of the push marker: a pick made on this signed-in phone that has not reached the account yet. */
export const UI_LANGUAGE_UNSYNCED_KEY = "sf_ui_language_unsynced";

/** Makes sure i18next runs in the start language (idempotent): every screen that may mount first calls it. */
export const ensureI18n = async (): Promise<void> => {
  const saved = await AsyncStorage.getItem(UI_LANGUAGE_KEY).catch(() => null);
  const deviceLocale = readDeviceLocale();
  const language = pickStartLanguage(saved, deviceLocale);
  log.info("start_language", { saved, deviceLocale, language });
  await initI18n(language);
};

/**
 * - `chooseUiLanguage`: switches the app to a language and remembers it; `pushToAccount` (picked while signed in)
 *   marks it for the account, and the pick re-runs `useAccountLanguageSync`, whose sync pushes it until it lands.
 * - `syncAccountLanguage`: brings the phone's language and the account's together.
 * - `reconcileSignedInLanguage`: right after a sign-in or a pairing, the language chosen before meets the account's.
 * - `forgetAccountLanguage`: signed out, the pending push belonged to the account that just left.
 */
export const {
  choose: chooseUiLanguage,
  sync: syncAccountLanguage,
  reconcileAfterSignIn: reconcileSignedInLanguage,
  forget: forgetAccountLanguage,
} = createAccountLanguageSync({
  asyncStorage: AsyncStorage,
  languageKey: UI_LANGUAGE_KEY,
  unsyncedKey: UI_LANGUAGE_UNSYNCED_KEY,
  currentLanguage: getCurrentLanguage,
  showLanguage: changeLanguage,
});
