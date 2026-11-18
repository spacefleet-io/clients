/**
 * How Badger names the library in its translation files (UX-NAME-02, UX-NAME-03; Chris 2026-11-09).
 *
 * The page or tab is called "Library" (Bibliothèque, Bibliotheek, Bibliothek, Biblioteca); every message about the collection says
 * "media library" (médiathèque, mediatheek, Mediathek, mediateca). Each app lists the keys that name the page; only those may use
 * the bare word. Shared by the phone/TV, desktop and web player translation tests.
 */

/** A bare library per language: anything that is not the media library. */
export const BARE_LIBRARY: Record<"en" | "fr" | "nl" | "de" | "es", RegExp> = {
  en: /(?<!media )librar(?:y|ies)/i,
  fr: /biblioth[èe]que(?! multimédia)/i,
  nl: /bibliotheek/i,
  de: /bibliothek/i,
  es: /biblioteca/i,
};

/** The media library per language, as messages must say it. */
export const MEDIA_LIBRARY: Record<"en" | "fr" | "nl" | "de" | "es", RegExp> = {
  en: /media librar(?:y|ies)/i,
  fr: /médiathèque/i,
  nl: /mediatheek/i,
  de: /mediathek/i,
  es: /mediateca/i,
};

/**
 * Filter for `Object.entries(flat)`: true when a message outside `pageNameKeys` says a bare library.
 * `pageNameKeys` are the app's keys that name the page itself (its tab, its title, a "back to Library").
 */
export const bareLibraryOutside =
  (pageNameKeys: ReadonlySet<string>) =>
  (re: RegExp) =>
  ([key, value]: [string, string]): boolean =>
    !pageNameKeys.has(key) && re.test(value);
