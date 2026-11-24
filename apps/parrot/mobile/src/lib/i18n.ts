// Parrot's language (UX-I18N-01): the shared phone texts (`@space/mobile-shell/i18n`: sign-in, setup, error reports,
// feedback) plus Parrot's own (`src/i18n/*.json`, the `parrot.*` keys), in English, French, Dutch, German and Spanish.
// App.tsx starts it before the first render: a screen that mounts first without it (Settings, after a restart with a
// saved session) showed the raw keys while only LoginScreen started it.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { addAppTranslations, changeLanguage, initI18n, isMobileUiLanguage, setKeyStepWords } from "@space/mobile-shell/i18n";
import { pickStartLanguage, readDeviceLocale } from "@space/mobile-shell/i18n/deviceLanguage";
import { SHELL_DE, SHELL_EN, SHELL_ES, SHELL_FR, SHELL_NL } from "@space/parrot-core/shell-strings";
import de from "../i18n/de.json";
import en from "../i18n/en.json";
import es from "../i18n/es.json";
import fr from "../i18n/fr.json";
import nl from "../i18n/nl.json";

/**
 * The language this phone shows, remembered for the next starts: the one picked before sign-in, then the account's one
 * language while signed in (UX-I18N-07, `./accountLanguage`).
 */
export const PARROT_LANGUAGE_KEY = "parrot.uiLanguage";

type Tree = { [key: string]: string | Tree };

/**
 * The shared Parrot shell texts (`home.*`, `player.*`, `account.*`, `settings.*`, `nav.*`: the desktop's and the web
 * player's, REL-FAM-02) as i18next reads them: nested under `shell.`, so they never collide with the phone shell's own
 * keys, and with i18next's `{{name}}` placeholders for the desktop's `{name}`.
 */
export const shellTree = (flat: Record<string, string>): Tree => {
  const root: Tree = {};
  for (const [key, text] of Object.entries(flat)) {
    const path = key.split(".");
    let node = root;
    for (const part of path.slice(0, -1)) node = (node[part] ??= {}) as Tree;
    node[path[path.length - 1]!] = text.replace(/\{(\w+)\}/g, "{{$1}}");
  }
  return root;
};

export const PARROT_TRANSLATIONS = {
  en: { ...en, shell: shellTree(SHELL_EN) },
  fr: { ...fr, shell: shellTree(SHELL_FR) },
  nl: { ...nl, shell: shellTree(SHELL_NL) },
  de: { ...de, shell: shellTree(SHELL_DE) },
  es: { ...es, shell: shellTree(SHELL_ES) },
};

const readSavedLanguage = async (): Promise<string | null> => {
  const saved = await AsyncStorage.getItem(PARROT_LANGUAGE_KEY).catch(() => null);
  return isMobileUiLanguage(saved) ? saved : null;
};

/** Starts i18next in the remembered language, else the phone's when Parrot has it, else English. */
export const startI18n = async (): Promise<void> => {
  await initI18n(pickStartLanguage(await readSavedLanguage(), readDeviceLocale()));
  addAppTranslations(PARROT_TRANSLATIONS);
  setKeyStepWords({ en: en.keyStepWords, fr: fr.keyStepWords, nl: nl.keyStepWords, de: de.keyStepWords, es: es.keyStepWords });
};

/** Switches the language on this phone now and remembers it for the next starts (the account is `./accountLanguage`'s). */
export const setParrotLanguage = async (code: string): Promise<void> => {
  if (!isMobileUiLanguage(code)) return;
  await changeLanguage(code);
  await AsyncStorage.setItem(PARROT_LANGUAGE_KEY, code);
};
