import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { withSignInErrorTexts } from "@space/shared/signInError";
import { withProviderSignInTexts } from "@space/shared/providerSignIn";
import { withSubtitleLanguageTexts } from "@space/shared/profileSettings";
import { withTitleLanguageTexts } from "@space/shared/titleLanguage";
import { withProfilesTexts } from "@space/shared/profileTexts";
import { withAccountDeletionLabels } from "@space/shared/accountDeletionLabels";
import { CLIENT_UI_LANGUAGES, isClientUiLanguage, type ClientUiLanguage, type ClientUiLanguageOption } from "@space/shared/i18n";
import { installClientPluralRules } from "@space/shared/pluralRules";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import nl from "./nl.json";

// i18next 27 made `strictInterpolationChecks` the default; this keeps the v26 typing of `t()` (options may be left
// out or undefined), which the string helpers built on `t()` rely on.
declare module "i18next" {
  interface CustomTypeOptions {
    strictInterpolationChecks: false;
  }
}

/**
 * The phone (and TV) app languages (UX-I18N-01): the shared client list `CLIENT_UI_LANGUAGES`, the same five the
 * account holds (`ACCOUNT_LANGUAGE_CODES` in `@space/shared/i18n`). Wider than `UI_LANGUAGES` there (`en`, `fr`).
 */
export type MobileUiLanguage = ClientUiLanguage;

export type MobileUiLanguageOption = ClientUiLanguageOption;

export const MOBILE_UI_LANGUAGES = CLIENT_UI_LANGUAGES;

export const DEFAULT_MOBILE_UI_LANGUAGE: MobileUiLanguage = "en";

export const isMobileUiLanguage = isClientUiLanguage;

/**
 * The sign-in error sentences (`login.errors`) come from `@space/shared/signInError`, the Google, Apple and Microsoft
 * sign-in words (`login.provider`, ACCT-SIGNIN-05) from `@space/shared/providerSignIn`, the title-language choice
 * (`titleLanguage`, ACCT-PROF-03) from `@space/shared/titleLanguage`, the Subtitle language setting (`subtitleLanguage`) from `@space/shared/profileSettings`, the profile texts from `@space/shared/profileTexts`, and the labels on the way to account deletion from
 * `@space/shared/accountDeletionLabels` (the legal page prints them too, WEB-LEGAL-04), shared by every app.
 */
export const withSharedTexts = <T extends Record<string, unknown>>(translation: T, language: MobileUiLanguage): T =>
  withAccountDeletionLabels(
    withProfilesTexts(
      withSubtitleLanguageTexts(
        withTitleLanguageTexts(withProviderSignInTexts(withSignInErrorTexts(translation, language), language), language),
        language,
      ),
      language,
    ),
    "mobile",
    language,
  );

const resources = {
  en: { translation: withSharedTexts(en, "en") },
  fr: { translation: withSharedTexts(fr, "fr") },
  nl: { translation: withSharedTexts(nl, "nl") },
  de: { translation: withSharedTexts(de, "de") },
  es: { translation: withSharedTexts(es, "es") },
};

let initialized = false;

export const initI18n = async (savedLanguage?: string | null) => {
  if (initialized) {
    if (savedLanguage && savedLanguage !== i18n.language) {
      await i18n.changeLanguage(savedLanguage);
    }
    return;
  }
  // Hermes has no Intl.PluralRules: without one i18next says "0 titres" in French and never picks a `_many` text.
  installClientPluralRules();
  await i18n.use(initReactI18next).init({
    resources,
    lng: savedLanguage ?? DEFAULT_MOBILE_UI_LANGUAGE,
    fallbackLng: DEFAULT_MOBILE_UI_LANGUAGE,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  initialized = true;
};

/** An app's own texts in its five languages, next to the shared ones (Parrot phone: its `parrot.*` keys). */
export type AppTranslations = Record<MobileUiLanguage, Record<string, unknown>>;

/** Adds an app's own texts once i18next has started; a key already in the shared files is never overwritten. */
export const addAppTranslations = (bundles: AppTranslations): void => {
  for (const [language, bundle] of Object.entries(bundles)) {
    i18n.addResourceBundle(language, "translation", bundle, true, false);
  }
};

/**
 * The app's word for the collection in the shared key step and erase dialog (UX-NAME-03, as `keySavedWarningText`):
 * the shared files carry Badger's ("media library", "médiathèque"); Parrot replaces them with its own ("library",
 * "bibliothèque"). The sentences read it through `$t(keyStepWords.collection)` / `$t(keyStepWords.collectionKey)`.
 */
export type KeyStepWords = { collection: string; collectionKey: string };
export const setKeyStepWords = (words: Record<MobileUiLanguage, KeyStepWords>): void => {
  for (const [language, keyStepWords] of Object.entries(words)) {
    i18n.addResourceBundle(language, "translation", { keyStepWords }, true, true);
  }
};

export const changeLanguage = (code: string) => i18n.changeLanguage(code);
export const getCurrentLanguage = () => i18n.language ?? DEFAULT_MOBILE_UI_LANGUAGE;

/** For text built outside React (alerts, store errors, option labels): resolves in the current language at call time. */
export const translate = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options);

export { useTranslation };
