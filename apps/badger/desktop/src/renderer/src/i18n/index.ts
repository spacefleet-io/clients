import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { CLIENT_UI_LANGUAGES, isClientUiLanguage, type ClientUiLanguage } from "@space/shared";
import { withSignInErrorTexts } from "@space/shared/signInError";
import { withSubtitleLanguageTexts } from "@space/shared/profileSettings";
import { withTitleLanguageTexts } from "@space/shared/titleLanguage";
import { withProfilesTexts } from "@space/shared/profileTexts";
import { withAccountDeletionLabels } from "@space/shared/accountDeletionLabels";
import { withProviderSignInTexts } from "@space/shared/providerSignIn";
import { withNotifyTexts } from "@space/notify-core/texts";
import { rendererLogger } from "../logger";

// i18next 27 made `strictInterpolationChecks` the default; this keeps the v26 typing of `t()` (options may be left
// out or undefined), which the components' translate props rely on.
declare module "i18next" {
  interface CustomTypeOptions {
    strictInterpolationChecks: false;
  }
}

// Each locale is its own lazy chunk (issue #25): the JSON files were ~145 KiB
// of the startup entry. Startup awaits only the active locale before the first
// render (see initI18n in main.tsx), so the first paint is already translated;
// another locale is fetched only when the user switches to it. The five app
// languages are English, French, Dutch, German and Spanish (UX-I18N-01). The sign-in error
// sentences (`login.errors`) come from `@space/shared/signInError`, the title language question and setting
// (`titleLanguage`, ACCT-PROF-03) from `@space/shared/titleLanguage`, the Subtitle language setting (`subtitleLanguage`) from `@space/shared/profileSettings`, the profile texts from `@space/shared/profileTexts`, the Google, Apple and Microsoft sign-in words (`login.provider`, ACCT-SIGNIN-05) from `@space/shared/providerSignIn`, the labels on the way to account deletion from
// `@space/shared/accountDeletionLabels` (the legal page prints them too, WEB-LEGAL-04), and the notices' bell and default
// titles (`notify`, UX-NOTICE-13) from `@space/notify-core/texts`, all shared by every app.
type Translation = Record<string, unknown>;

const withSharedTexts = (translation: Translation, language: ClientUiLanguage): Translation =>
  withNotifyTexts(
    withAccountDeletionLabels(
      withProfilesTexts(
        withSubtitleLanguageTexts(
          withTitleLanguageTexts(withProviderSignInTexts(withSignInErrorTexts(translation, language), language), language),
          language,
        ),
        language,
      ),
      "desktop",
      language,
    ),
    language,
  );

const localeLoaders: Record<ClientUiLanguage, () => Promise<Translation>> = {
  en: () => import("./en.json").then((mod) => withSharedTexts(mod.default, "en")),
  fr: () => import("./fr.json").then((mod) => withSharedTexts(mod.default, "fr")),
  nl: () => import("./nl.json").then((mod) => withSharedTexts(mod.default, "nl")),
  de: () => import("./de.json").then((mod) => withSharedTexts(mod.default, "de")),
  es: () => import("./es.json").then((mod) => withSharedTexts(mod.default, "es")),
};

const log = rendererLogger.child({ scope: "i18n" });
const pendingLoads = new Map<ClientUiLanguage, Promise<void>>();
let requestedLanguage: ClientUiLanguage | null = null;

const toUiLanguage = (value: string | null | undefined): ClientUiLanguage => (isClientUiLanguage(value) ? value : "en");

/** Tells the main process (tray, app menu, native dialogs) and the document which language is shown. */
const announceLanguage = (language: ClientUiLanguage) => {
  if (typeof document !== "undefined") document.documentElement.lang = language;
  if (typeof window !== "undefined") window.sf?.reportUiLanguage?.(language);
};

/** Fetches a locale bundle once and registers it; concurrent callers share the load. */
export const loadLocale = (language: ClientUiLanguage): Promise<void> => {
  if (i18n.hasResourceBundle(language, "translation")) return Promise.resolve();
  const pending = pendingLoads.get(language);
  if (pending) return pending;
  const startedAt = performance.now();
  log.info({ language }, "[i18n] loading locale bundle");
  const load = localeLoaders[language]()
    .then((translation) => {
      i18n.addResourceBundle(language, "translation", translation, true, true);
      log.info({ language, ms: Math.round(performance.now() - startedAt) }, "[i18n] locale bundle loaded");
    })
    .finally(() => {
      // A failed chunk fetch must not stick: the next switch retries it.
      pendingLoads.delete(language);
    });
  pendingLoads.set(language, load);
  return load;
};

/** Initialises i18next with only the active locale loaded. Await before the first render. */
export const initI18n = async (language: string | null | undefined): Promise<void> => {
  const active = toUiLanguage(language);
  requestedLanguage = active;
  const translation = await localeLoaders[active]();
  await i18n.use(initReactI18next).init({
    resources: { [active]: { translation } },
    partialBundledLanguages: true,
    lng: active,
    // The bundle is already in hand: init synchronously instead of on a
    // setTimeout tick, so the first render is not pushed back another task.
    initAsync: false,
    fallbackLng: "en",
    supportedLngs: CLIENT_UI_LANGUAGES.map((language) => language.code),
    interpolation: {
      escapeValue: false,
    },
    react: { useSuspense: false },
  });
  announceLanguage(active);
  log.info({ language: active }, "[i18n] initialised with active locale only");
};

/**
 * Switches the UI language, loading its bundle first so no untranslated keys flash.
 * When switches overlap, the last requested language wins even if an earlier load
 * resolves later.
 */
export const setUiLanguage = async (language: string | null | undefined): Promise<void> => {
  const next = toUiLanguage(language);
  requestedLanguage = next;
  if (i18n.resolvedLanguage === next) return;
  try {
    await loadLocale(next);
  } catch (err) {
    log.error({ language: next, err: String(err) }, "[i18n] failed to load locale bundle; keeping current language");
    return;
  }
  if (requestedLanguage !== next) {
    log.info({ language: next, requestedLanguage }, "[i18n] superseded language switch dropped");
    return;
  }
  await i18n.changeLanguage(next);
  announceLanguage(next);
};

export default i18n;
