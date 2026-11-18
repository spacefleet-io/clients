// The phone apps' start language (UX-I18N-01), shared by Badger phone/TV and Parrot.
import { I18nManager, Platform, Settings } from "react-native";
import { pickStartLanguage as pickAppStartLanguage } from "@space/shared/i18n";
import { DEFAULT_MOBILE_UI_LANGUAGE, isMobileUiLanguage, type MobileUiLanguage } from "./index";

/**
 * The device's language as a locale tag ("nl-NL", "de_DE"): the first preferred language on iOS (the locale the app
 * gets there is narrowed to the languages the app bundle declares), the app locale on Android, else Intl's default.
 */
export const readDeviceLocale = (): string | null => {
  if (Platform.OS === "ios") {
    const preferred: unknown = Settings.get("AppleLanguages");
    if (Array.isArray(preferred) && typeof preferred[0] === "string") return preferred[0];
  }
  const androidLocale = I18nManager.getConstants().localeIdentifier;
  if (androidLocale) return androidLocale;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return null;
  }
};

/**
 * Start language (UX-I18N-01): the remembered choice, else the device's language when the app has it, else English
 * (the shared rule, `pickStartLanguage` in `@space/shared/i18n`, over the phone's five languages).
 */
export const pickStartLanguage = (saved: string | null, deviceLocale: string | null): MobileUiLanguage =>
  pickAppStartLanguage(saved, [deviceLocale], isMobileUiLanguage, DEFAULT_MOBILE_UI_LANGUAGE);
