// Electron ships 55 Chromium locale paks (8.5 MiB packed, 48 MiB installed on
// Windows). The app's own UI is en, fr, nl, de and es (CLIENT_UI_LANGUAGES in @space/shared)
// and never reads Chromium's locale strings for anything else, so only those five
// ship. They must ship: Chromium derives `app.getLocale()` and `navigator.languages`
// from the paks it has, so a pruned de.pak makes a German system report en-US and the
// first start picks English. Spanish ships twice: Chromium resolves every Spanish system
// outside Spain to es-419 and, without its pak, to en-US. Chromium falls back to en-US for
// any other OS language.
//
// electron-builder's `electronLanguages` (ELECTRON_LANGUAGES on every target) deletes every
// locale file that no listed language matches: the exact name, a region of a bare listed
// language ("en" keeps "en-US" and "en-GB"), or the bare form of a listed region ("en-US" keeps
// macOS's `en.lproj`). When nothing matches at all it only logs a warning and ships all 55, so
// `package.mjs` re-checks the unpacked output with `checkPackagedLocales`.
export const ELECTRON_LANGUAGES = ["en-US", "fr", "nl", "de", "es", "es-419"];

// macOS keeps Chromium's locales as `Contents/Resources/<lang>.lproj` (`en.lproj`, `en_GB.lproj`),
// so "en-US" leaves `en.lproj` and drops `en_GB.lproj` ("en" would keep both). These are the
// folders a macOS package must hold: they are also what macOS and Electron read as the app's
// localizations, so with only `fr.lproj` left an English user could get a French app menu and `app.getLocale()`.
export const MAC_ELECTRON_LANGUAGES = ["en", "fr", "nl", "de", "es", "es_419"];

/** Per-OS locale files: `.pak` files under `locales/` (Linux, Windows), `.lproj` folders (macOS). */
export const PAK_EXTENSION = ".pak";
export const LPROJ_EXTENSION = ".lproj";

/**
 * Locale paks that should not be in a packaged build, and wanted ones that are absent.
 * Mirrors electron-builder's match rule so the check agrees with what it keeps.
 * @param {string[]} fileNames entries of the unpacked build's locale directory
 * @param {string[]} [languages]
 * @param {string} [extension] `.pak` (Linux, Windows) or `.lproj` (macOS)
 * @returns {{ unexpected: string[]; missing: string[] }}
 */
export const checkPackagedLocales = (fileNames, languages = ELECTRON_LANGUAGES, extension = PAK_EXTENSION) => {
  const wanted = languages.map((language) => language.toLowerCase());
  const present = fileNames
    .filter((name) => name.endsWith(extension))
    .map((name) => ({ name, language: name.slice(0, -extension.length).toLowerCase() }));
  const unexpected = present
    .filter(({ language }) => !wanted.some((want) => want === language || want.startsWith(`${language}-`)))
    .map(({ name }) => name);
  const presentLanguages = new Set(present.map(({ language }) => language));
  const missing = languages
    .filter((language) => !presentLanguages.has(language.toLowerCase()))
    .map((language) => `${language}${extension}`);
  return { unexpected, missing };
};
