export type UiLanguage = "en" | "fr";

export type UiLanguageOption = {
  code: UiLanguage;
  englishName: string;
  nativeName: string;
  flag: string;
};

export const UI_LANGUAGE_CODES: UiLanguage[] = ["en", "fr"];

export const UI_LANGUAGES: UiLanguageOption[] = [
  { code: "en", englishName: "English", nativeName: "English", flag: "🇬🇧" },
  { code: "fr", englishName: "French", nativeName: "Français", flag: "🇫🇷" },
];

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

/**
 * The five languages of the Badger desktop, phone, TV and web apps and the Parrot apps (UX-I18N-01): English, French,
 * Dutch, German and Spanish, the same five the account holds (`AccountLanguage`). One list for every client that has them, so a
 * language added here reaches every one of those apps. `UiLanguage` (en/fr) stays only for the website.
 * Every language picker shows these in this order, each as its flag (the Noto emoji artwork of `./languageFlags` as an
 * image: `Flag` of @space/ui, `MobileFlag` of @space/mobile-shell; emoji characters show as letters on Windows, Linux
 * and Android TV) and its own name (UX-I18N-10).
 */
export type ClientUiLanguage = AccountLanguage;

export type ClientUiLanguageOption = { code: ClientUiLanguage; nativeName: string };

export const CLIENT_UI_LANGUAGES: readonly ClientUiLanguageOption[] = [
  { code: "en", nativeName: "English" },
  { code: "fr", nativeName: "Français" },
  { code: "nl", nativeName: "Nederlands" },
  { code: "de", nativeName: "Deutsch" },
  { code: "es", nativeName: "Español" },
];

export const isClientUiLanguage = (value?: string | null): value is ClientUiLanguage =>
  CLIENT_UI_LANGUAGES.some((language) => language.code === value);

export const isUiLanguage = (value?: string | null): value is UiLanguage =>
  UI_LANGUAGE_CODES.includes((value ?? "") as UiLanguage);

/**
 * Languages the account can hold (ACCT-EMAIL-01): the language of account emails, one of every app language
 * (UX-I18N-01). Wider than `UiLanguage` while the website ships English and French only.
 */
export type AccountLanguage = "en" | "fr" | "nl" | "de" | "es";

export const ACCOUNT_LANGUAGE_CODES: readonly AccountLanguage[] = ["en", "fr", "nl", "de", "es"];

export const DEFAULT_ACCOUNT_LANGUAGE: AccountLanguage = "en";

export const isAccountLanguage = (value?: string | null): value is AccountLanguage =>
  ACCOUNT_LANGUAGE_CODES.includes((value ?? "") as AccountLanguage);

/** A stored account language, or English for a value the account cannot hold (an old or empty row). */
export const toAccountLanguage = (value: unknown): AccountLanguage =>
  typeof value === "string" && isAccountLanguage(value) ? value : DEFAULT_ACCOUNT_LANGUAGE;

/**
 * Start language of an app (UX-I18N-01): the remembered choice when the app has it, else the first of the device's
 * or browser's locale tags whose language the app has, else `fallback`. Region and script are ignored ("fr-CA",
 * "nl_BE", "de-AT" and "es-MX" pick French, Dutch, German and Spanish). Each app passes its own language guard: the phone has more
 * languages than this shared list.
 */
export const pickStartLanguage = <L extends string>(
  saved: string | null,
  locales: readonly (string | null | undefined)[],
  isLanguage: (value?: string | null) => value is L,
  fallback: L,
): L => {
  if (isLanguage(saved)) return saved;
  const fromLocale = locales.map((tag) => tag?.split(/[-_]/)[0]?.toLowerCase()).find(isLanguage);
  return fromLocale ?? fallback;
};
