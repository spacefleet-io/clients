/** Website pages the Badger apps link to (phone, TV, web player), in the app's language (the website serves `/:lang/...` for en, fr, de, nl, es). */
const WEBSITE = "https://spacebadger.io";
const WEBSITE_LANGUAGES = ["en", "fr", "de", "nl", "es"] as const;

export type WebsitePage = "downloads";

/** `https://spacebadger.io/<lang>/<page>`; a language the website lacks falls back to English. */
export const websiteUrl = (page: WebsitePage, language: string): string => {
  const lang = (WEBSITE_LANGUAGES as readonly string[]).includes(language) ? language : "en";
  return `${WEBSITE}/${lang}/${page}`;
};

/** The legal pages (privacy policy, terms) live on spacefleet.io, in the same four languages (WEB-LEGAL-13). */
const LEGAL_WEBSITE = "https://spacefleet.io";

/**
 * REL-LOG-06: the "What's in a report?" link next to the error-reports line in every app's settings and first-launch
 * question: the error-reports part of the privacy policy (`id="error-reports"` in `@space/legal`), in the app's language.
 */
export const errorReportsPrivacyUrl = (language: string): string => {
  const base = language.split("-")[0] ?? "";
  const lang = (WEBSITE_LANGUAGES as readonly string[]).includes(base) ? base : "en";
  return `${LEGAL_WEBSITE}/${lang}/privacy#error-reports`;
};
