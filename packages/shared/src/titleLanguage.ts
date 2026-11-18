/**
 * ACCT-PROF-03: each profile picks "App language everywhere" (`"app"`, the default) or "Original version"
 * (`"original"`) for the title, poster and backdrop of every movie and show. Everything else (synopsis, genres,
 * episode names, the app) stays in the account's language (UX-I18N-07). An original written in a non-Latin script
 * keeps the account-language set with either option.
 *
 * The library keeps at most two sets per media:
 *   - the media row (`title`, `poster_path`, `backdrop_path`) holds the account-language set, so every reader that
 *     knows nothing of this rule still shows a legible title;
 *   - one synced `setting.set` row per media holds the rest:
 *       key   `title_variants_v1:<media id>`
 *       value JSON `{v: 1, rowLanguage, rowTitle, original: {language, title, posterPath, backdropPath} | null,
 *                    fetchedAt}`
 *     `rowLanguage` / `rowTitle` are the language the media row was last fetched in and the title it was given, so a
 *     later pass sees a user's title edit (row title ≠ `rowTitle`) and keeps it. `original` is present only while a
 *     profile uses "Original version" and the original set differs from the account's.
 * Same transport as `localized_text_v1:` (LIB-LANG-02): no op-shape change, older apps store the key and ignore it.
 * Portable: no DOM, no node:*.
 */
import { normalizeMediaLanguageCode } from "./mediaLanguageDisplay";

export type TitleLanguage = "app" | "original";

export const TITLE_LANGUAGES = ["app", "original"] as const satisfies readonly TitleLanguage[];

export const DEFAULT_TITLE_LANGUAGE: TitleLanguage = "app";

export const isTitleLanguage = (value: unknown): value is TitleLanguage => value === "app" || value === "original";

/**
 * Profiles created before this moment never get the question: an unset choice reads as "App language everywhere"
 * (Main 2026-11-16: no forced question for existing users). A profile created from then on is asked once, on the
 * first app that opens with it.
 */
export const TITLE_LANGUAGE_ASKED_SINCE = "2026-11-17T00:00:00.000Z";

/** The profile's option; unset reads as the default. */
export const profileTitleLanguage = (settings: { titleLanguage?: unknown } | null | undefined): TitleLanguage =>
  isTitleLanguage(settings?.titleLanguage) ? settings.titleLanguage : DEFAULT_TITLE_LANGUAGE;

/** True when this profile must be asked "How should titles appear?": created after the rule and never answered. */
export const needsTitleLanguageQuestion = (
  profile: { createdAt: string },
  settings: { titleLanguage?: unknown } | null | undefined
): boolean => !isTitleLanguage(settings?.titleLanguage) && profile.createdAt >= TITLE_LANGUAGE_ASKED_SINCE;

/**
 * Language codes written in a non-Latin script, for an original with no title stored to read the letters of.
 */
export const NON_LATIN_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set([
  "ja", "ko", "zh", "ar", "he", "fa", "ur", "ru", "uk", "be", "bg", "mk", "el", "hy", "ka", "hi", "bn", "ta", "te",
  "kn", "ml", "mr", "gu", "pa", "or", "si", "th", "lo", "km", "my", "am", "ti", "dv", "ne", "yi", "mn", "kk", "ky",
  "tg", "ps", "sd", "ug", "bo",
]);

const LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/** True when every letter of `text` is a Latin letter (digits, spaces and punctuation are ignored). */
export const isLatinScriptText = (text: string): boolean => {
  for (const char of text) {
    if (LETTER.test(char) && !LATIN_LETTER.test(char)) return false;
  }
  return true;
};

export type OriginalWork = { originalTitle?: string | null; originalLanguage?: string | null };

/**
 * True when the original is written in Latin letters: the original title's own letters decide (a Serbian title in
 * Latin letters counts as Latin); the language code only when no original title is stored.
 */
export const isLatinOriginal = (work: OriginalWork): boolean => {
  const title = work.originalTitle?.trim();
  if (title && LETTER.test(title)) return isLatinScriptText(title);
  const code = normalizeMediaLanguageCode(work.originalLanguage);
  return code !== "und" && !NON_LATIN_SCRIPT_LANGUAGES.has(code);
};

/**
 * The language the original set is fetched in, or null when "Original version" shows the account-language set for
 * this work: an unknown original language, the account's own language, or a non-Latin original.
 */
export const originalSetLanguage = (work: OriginalWork, accountLanguage: string): string | null => {
  const code = normalizeMediaLanguageCode(work.originalLanguage);
  if (code === "und" || code === normalizeMediaLanguageCode(accountLanguage)) return null;
  return isLatinOriginal(work) ? code : null;
};

/** The language an answer is fetched in when the account-language answer's title is not in Latin letters. */
export const TITLE_FALLBACK_LANGUAGE = "en";

/** True when a fetched account-language title must be replaced by the English one (not in Latin letters). */
export const needsTitleFallback = (title: string | null | undefined): boolean =>
  typeof title === "string" && !isLatinScriptText(title);

export const TITLE_VARIANTS_KEY_PREFIX = "title_variants_v1:";

export const titleVariantsKey = (mediaId: string) => `${TITLE_VARIANTS_KEY_PREFIX}${mediaId}`;

export const isTitleVariantsKey = (key: string) => key.startsWith(TITLE_VARIANTS_KEY_PREFIX);

export type TitleArt = { title: string; posterPath: string | null; backdropPath: string | null };

export type TitleVariantSet = TitleArt & { language: string };

export type TitleVariants = {
  /** The language the media row's title, poster and backdrop were last fetched in. */
  rowLanguage: string;
  /** The title the media row was given then; a different row title is the user's edit. */
  rowTitle: string;
  original: TitleVariantSet | null;
  fetchedAt: string;
};

const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

export const serializeTitleVariants = (record: TitleVariants): string =>
  JSON.stringify({
    v: 1,
    rowLanguage: record.rowLanguage,
    rowTitle: record.rowTitle,
    original: record.original
      ? {
          language: record.original.language,
          title: record.original.title,
          posterPath: record.original.posterPath,
          backdropPath: record.original.backdropPath,
        }
      : null,
    fetchedAt: record.fetchedAt,
  });

/** The stored record, or null for a missing, deleted (`""`), unreadable or newer-version value. */
export const parseTitleVariants = (value: string | null | undefined): TitleVariants | null => {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const rowLanguage = textOrNull(row.rowLanguage);
  if (row.v !== 1 || !rowLanguage || typeof row.rowTitle !== "string") return null;
  const original = row.original && typeof row.original === "object" ? (row.original as Record<string, unknown>) : null;
  const originalLanguage = textOrNull(original?.language);
  const originalTitle = textOrNull(original?.title);
  return {
    rowLanguage,
    rowTitle: row.rowTitle,
    original:
      original && originalLanguage && originalTitle
        ? {
            language: originalLanguage,
            title: originalTitle,
            posterPath: textOrNull(original.posterPath),
            backdropPath: textOrNull(original.backdropPath),
          }
        : null,
    fetchedAt: typeof row.fetchedAt === "string" ? row.fetchedAt : "",
  };
};

/** A picture copied into the user's storage (not a catalog path still waiting for its copy, META-ART-01). */
const copiedPicture = (path: string | null): path is string => !!path && !/^\/[^/]/.test(path);

/**
 * The title, poster and backdrop a profile is shown: the original set with "Original version" when the library holds
 * it, else the media row's own (the account-language set, or the user's edit). An original set whose title is not in
 * Latin letters is never shown, whichever app wrote it. An original picture missing or not copied yet keeps the row's
 * one, so the old picture stays until the new one is ready.
 */
export const shownTitleArt = <T extends TitleArt>(item: T, variants: TitleVariants | null, titleLanguage: TitleLanguage): T => {
  const original = titleLanguage === "original" ? variants?.original : null;
  if (!original || needsTitleFallback(original.title)) return item;
  return {
    ...item,
    title: original.title,
    posterPath: copiedPicture(original.posterPath) ? original.posterPath : item.posterPath,
    backdropPath: copiedPicture(original.backdropPath) ? original.backdropPath : item.backdropPath,
  };
};

export type TitleLanguageTextLanguage = "en" | "fr" | "nl" | "de" | "es";

export type TitleLanguageOptionTexts = {
  label: string;
  description: string;
  /**
   * Two example titles, the same two films for both options: translated into the app's language under "App language
   * everywhere", their original under "Original version". Originals that read as obviously original (English films for
   * the other languages, European films for English), and always in Latin letters: a non-Latin original is replaced.
   */
  examples: readonly [string, string];
};

export type TitleLanguageTexts = {
  /** The setup question and the setting's window title. */
  question: string;
  /** Under the question. */
  intro: string;
  /** The Settings row. */
  settingTitle: string;
  settingDescription: string;
  app: TitleLanguageOptionTexts;
  original: TitleLanguageOptionTexts;
};

/** ACCT-PROF-03: the question's and the setting's texts, the same in every app (REL-FAM-02). */
export const titleLanguageTexts: Record<TitleLanguageTextLanguage, TitleLanguageTexts> = {
  en: {
    question: "How should titles appear?",
    intro: "Only for this profile. You can change it later in Settings.",
    settingTitle: "Titles and posters",
    settingDescription: "The language of titles, posters and backdrops for this profile.",
    app: {
      label: "App language everywhere",
      description: "Titles, posters and backdrops in the app's language, like everything else.",
      examples: ["Amélie", "Life Is Beautiful"],
    },
    original: {
      label: "Original version",
      description:
        "Titles, posters and backdrops in the movie's or show's original language; synopses stay in the app's language. Originals in another alphabet, such as Japanese, stay in the app's language.",
      examples: ["Le Fabuleux Destin d'Amélie Poulain", "La vita è bella"],
    },
  },
  fr: {
    question: "Comment afficher les titres ?",
    intro: "Pour ce profil uniquement. Vous pourrez le changer plus tard dans les Réglages.",
    settingTitle: "Titres et affiches",
    settingDescription: "La langue des titres, affiches et images de fond pour ce profil.",
    app: {
      label: "Langue de l'app partout",
      description: "Titres, affiches et images de fond dans la langue de l'app, comme tout le reste.",
      examples: ["Les Dents de la mer", "La Ligne verte"],
    },
    original: {
      label: "Version originale",
      description:
        "Titres, affiches et images de fond dans la langue d'origine du film ou de la série ; les résumés restent dans la langue de l'app. Les originaux dans un autre alphabet, comme le japonais, restent dans la langue de l'app.",
      examples: ["Jaws", "The Green Mile"],
    },
  },
  nl: {
    question: "Hoe moeten titels worden getoond?",
    intro: "Alleen voor dit profiel. Je kunt het later wijzigen in Instellingen.",
    settingTitle: "Titels en posters",
    settingDescription: "De taal van titels, posters en achtergronden voor dit profiel.",
    app: {
      label: "Overal de taal van de app",
      description: "Titels, posters en achtergronden in de taal van de app, net als de rest.",
      examples: ["De Leeuwenkoning", "In de ban van de ring"],
    },
    original: {
      label: "Originele versie",
      description:
        "Titels, posters en achtergronden in de oorspronkelijke taal van de film of serie; samenvattingen blijven in de taal van de app. Originelen in een ander schrift, zoals Japans, blijven in de taal van de app.",
      examples: ["The Lion King", "The Lord of the Rings"],
    },
  },
  de: {
    question: "Wie sollen Titel angezeigt werden?",
    intro: "Nur für dieses Profil. Du kannst es später in den Einstellungen ändern.",
    settingTitle: "Titel und Poster",
    settingDescription: "Die Sprache von Titeln, Postern und Hintergründen für dieses Profil.",
    app: {
      label: "Überall die App-Sprache",
      description: "Titel, Poster und Hintergründe in der Sprache der App, wie alles andere.",
      examples: ["Der weiße Hai", "Kevin – Allein zu Haus"],
    },
    original: {
      label: "Originalfassung",
      description:
        "Titel, Poster und Hintergründe in der Originalsprache des Films oder der Serie; Inhaltsangaben bleiben in der Sprache der App. Originale in einer anderen Schrift, etwa Japanisch, bleiben in der Sprache der App.",
      examples: ["Jaws", "Home Alone"],
    },
  },
  es: {
    question: "¿Cómo se muestran los títulos?",
    intro: "Solo para este perfil. Puedes cambiarlo más tarde en Ajustes.",
    settingTitle: "Títulos y pósteres",
    settingDescription: "El idioma de los títulos, pósteres y fondos para este perfil.",
    app: {
      label: "Idioma de la app en todo",
      description: "Títulos, pósteres y fondos en el idioma de la app, como todo lo demás.",
      examples: ["Tiburón", "Solo en casa"],
    },
    original: {
      label: "Versión original",
      description:
        "Títulos, pósteres y fondos en el idioma original de la película o la serie; las sinopsis siguen en el idioma de la app. Los originales en otro alfabeto, como el japonés, siguen en el idioma de la app.",
      examples: ["Jaws", "Home Alone"],
    },
  },
};

/** Puts {@link titleLanguageTexts} into an i18next translation tree as `titleLanguage`, keeping its other keys. */
export const withTitleLanguageTexts = <T extends Record<string, unknown>>(translation: T, language: TitleLanguageTextLanguage): T => ({
  ...translation,
  titleLanguage: titleLanguageTexts[language],
});
