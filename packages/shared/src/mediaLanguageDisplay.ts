/**
 * How a media language and a media track (audio, subtitle) read in a client's UI: the language name in the UI
 * language (`Intl.DisplayNames`), and a track as "English" or "English - SDH". Shared by the Badger desktop app and the
 * web player, so a track reads the same in both.
 */
import { MEDIA_LANGUAGE_OPTIONS, findMediaLanguage, getMediaLanguageFlag } from "./media-languages";

const isMediaLanguage = (value: string) => Boolean(findMediaLanguage(value));

const DISPLAY_NAMES_CACHE = new Map<string, Intl.DisplayNames>();

/** A stored language tag (ISO 639-1 or 639-2) as a known two-letter code, else "und". */
export const normalizeMediaLanguageCode = (raw?: string | null) => {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "und";
  if (value === "eng") return "en";
  if (value === "fre" || value === "fra") return "fr";
  if (value === "spa") return "es";
  if (value === "por") return "pt";
  if (value === "ger" || value === "deu") return "de";
  if (value === "ita") return "it";
  if (value === "jpn") return "ja";
  if (value === "kor") return "ko";
  if (value === "chi" || value === "zho") return "zh";
  if (value.length === 2 && isMediaLanguage(value)) return value;
  return "und";
};

/**
 * Without `Intl.DisplayNames` (Hermes, the phone's engine, has none): the language's own name when it is the UI
 * language ("Nederlands"), else its English name, as the phone's other language lists show it; a region rides along
 * as its code ("Portuguese (BR)"). `null` for a language outside the list.
 */
export const mediaLanguageNameWithoutIntl = (base: string, region: string | undefined, uiLanguage: string) => {
  const match = findMediaLanguage(base.toLowerCase());
  if (!match) return null;
  const sameAsUi = (uiLanguage.trim().split(/[-_]/)[0] ?? "").toLowerCase() === match.code;
  const name = (sameAsUi && match.nativeName) || match.englishName;
  return region ? `${name} (${region.toUpperCase()})` : name;
};

/** The UI language's `Intl.DisplayNames`, or null where the engine has none (Hermes). */
const resolveDisplayNames = (uiLanguage: string) => {
  if (typeof Intl.DisplayNames !== "function") return null;
  const locale = (uiLanguage || "en").trim() || "en";
  const existing = DISPLAY_NAMES_CACHE.get(locale);
  if (existing) return existing;
  const created = new Intl.DisplayNames([locale], { type: "language" });
  DISPLAY_NAMES_CACHE.set(locale, created);
  return created;
};

const fallbackLanguageLabel = (code: string) => {
  const match = MEDIA_LANGUAGE_OPTIONS.find((lang) => lang.code === code);
  return match?.englishName || match?.nativeName || code.toUpperCase();
};

/** "No language" (code `xx`, a silent film or music video) in each app language; Intl has no name for it. */
const NO_LANGUAGE_LABELS: Record<string, string> = {
  en: "No language",
  fr: "Aucune langue",
  nl: "Geen taal",
  de: "Keine Sprache",
  es: "Sin idioma",
};

export const formatMediaLanguageLabelForUi = (
  code: string | null | undefined,
  uiLanguage: string,
  undefinedLabel = "Undefined"
) => {
  const raw = (code ?? "").trim().toLowerCase();
  const normalized = normalizeMediaLanguageCode(code);
  if (normalized === "und") {
    if (raw && raw !== "und" && raw !== "undefined") {
      return raw.toUpperCase();
    }
    return undefinedLabel;
  }
  if (!isMediaLanguage(normalized)) {
    return normalized.toUpperCase();
  }
  const uiBase = ((uiLanguage || "en").trim().split(/[-_]/)[0] ?? "").toLowerCase();
  if (normalized === "xx") return NO_LANGUAGE_LABELS[uiBase] ?? NO_LANGUAGE_LABELS.en!;
  const names = resolveDisplayNames(uiLanguage);
  if (!names) return mediaLanguageNameWithoutIntl(normalized, undefined, uiLanguage || "en") ?? fallbackLanguageLabel(normalized);
  const localized = names.of(normalized)?.trim();
  if (localized && localized.toLowerCase() !== normalized) {
    // French, Spanish… name languages in lower case ("français"); a menu row starts with a capital, as in English.
    return localized.charAt(0).toLocaleUpperCase(uiLanguage || "en") + localized.slice(1);
  }
  return fallbackLanguageLabel(normalized);
};

export type MediaLanguageOptionForUi = { code: string; label: string };

const SORTED_OPTIONS_CACHE = new Map<string, readonly MediaLanguageOptionForUi[]>();

/**
 * Every media language as `{ code, label }` ("Français 🇫🇷": the name in the UI language, then the flag when a country
 * stands for the language), sorted by label for `uiLanguage`. Two codes that name the same language get one row each
 * with a name that tells them apart: Intl names `mo` (Moldavian, a retired code) "Romanian" like `ro`, and Electron's
 * trimmed ICU names `tw` (Twi) "Akan"; the code Intl names in English by its own English name keeps the shared name,
 * the other shows its English name ("Moldavian", "Twi"). Built once per (UI language, undefined label) and shared:
 * the pickers used to sort ~190 options with a
 * comparator that rebuilt both labels and a collator on each of ~1,500 comparisons and then recomputed every label per
 * rendered select, a ~0.4 s main-thread stall per dialog render on a low-end CPU (#928).
 */
export const sortedMediaLanguageOptionsForUi = (
  uiLanguage: string,
  undefinedLabel = "Undefined"
): readonly MediaLanguageOptionForUi[] => {
  const locale = (uiLanguage || "en").trim() || "en";
  const key = `${locale}\u0000${undefinedLabel}`;
  const cached = SORTED_OPTIONS_CACHE.get(key);
  if (cached) return cached;
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  const named = MEDIA_LANGUAGE_OPTIONS.map((option) => ({
    option,
    name: formatMediaLanguageLabelForUi(option.code, locale, undefinedLabel),
  }));
  const codesByName = new Map<string, number>();
  for (const { name } of named) codesByName.set(name.toLowerCase(), (codesByName.get(name.toLowerCase()) ?? 0) + 1);
  const english = resolveDisplayNames("en");
  const sorted = named
    .map(({ option, name }) => {
      const shared = (codesByName.get(name.toLowerCase()) ?? 0) > 1;
      const ownName = (english?.of(option.code) ?? option.englishName).toLowerCase() === option.englishName.toLowerCase();
      const label = shared && !ownName ? option.englishName : name;
      const flag = getMediaLanguageFlag(option.code);
      return { code: option.code, label: flag ? `${label} ${flag}` : label };
    })
    .sort((a, b) => collator.compare(a.label, b.label));
  SORTED_OPTIONS_CACHE.set(key, sorted);
  return sorted;
};

/**
 * The names a track label may give its own language: its English and own names from the list, and Intl's English
 * name and endonym ("French", "Français"), plus `uiName`, the name the player shows. Lower case, longest first.
 */
const namesOfLanguage = (code: string, uiName: string) => {
  const match = findMediaLanguage(code);
  const names = new Set(
    [uiName, match?.englishName, match?.nativeName, resolveDisplayNames("en")?.of(code), resolveDisplayNames(code)?.of(code)]
      .map((name) => (name ?? "").trim().toLowerCase())
      .filter((name) => name.length > 0 && name !== code)
  );
  return [...names].sort((a, b) => b.length - a.length);
};

/**
 * Whether a track label only names the track's own language again: its code ("FRE", "eng", "fr") or a name
 * ({@link namesOfLanguage}). Files and fetched subtitles often carry one as their title, which read "French - FRE"
 * next to an audio "French - Français" in the same player (INGS-NAME-02).
 */
const labelNamesLanguage = (label: string, code: string, names: readonly string[]) => {
  const lower = label.trim().toLowerCase();
  if (normalizeMediaLanguageCode(lower) === code || names.includes(lower)) return true;
  // An ISO 639-2 code the short list in normalizeMediaLanguageCode does not know ("dut", "nld", "swe").
  const english = resolveDisplayNames("en");
  return Boolean(english && /^[a-z]{3}$/.test(lower) && english.of(lower)?.toLowerCase() === english.of(code)?.toLowerCase());
};

// Format a media track (audio/subtitle) for display in the player track menu,
// playback overlay, or modal preview. Implements the either/or display rule:
//   - language === "und" → render the label verbatim (custom-label mode); if
//     no label is set, fall back to undefinedLabel.
//   - language tagged → the language's name in the UI language ("French",
//     "Français") if no descriptor, or a descriptor that only names the
//     language again ("FRE", "English", "Français" on a French track);
//     "English - deaf" if a distinct descriptor is set. If the label starts
//     with a name of its language ("French test", "Français SDH"), that
//     prefix is stripped so the display never reads "French French test".
export const formatTrackDisplayLabel = (
  language: string | null | undefined,
  label: string | null | undefined,
  uiLanguage: string,
  undefinedLabel = "Undefined"
) => {
  const normalized = normalizeMediaLanguageCode(language);
  const trimmed = (label ?? "").trim();
  if (normalized === "und") {
    return trimmed || undefinedLabel;
  }
  const langName = formatMediaLanguageLabelForUi(normalized, uiLanguage, undefinedLabel);
  const names = namesOfLanguage(normalized, langName);
  if (!trimmed || labelNamesLanguage(trimmed, normalized, names)) {
    return langName;
  }
  // Strip a leading name of the language, anchored, case-insensitive, ending at a non-letter, with an optional
  // separator (space, dash, colon) after it: language="fr", label="French test" → "French - test".
  const labelLower = trimmed.toLowerCase();
  const prefix = names.find((name) => labelLower.startsWith(name) && !/^\p{L}/u.test(trimmed.slice(name.length)));
  let descriptor = trimmed;
  if (prefix) {
    const remainder = trimmed.slice(prefix.length).replace(/^[\s\-:]+/, "");
    if (remainder.length === 0) {
      return langName;
    }
    // A fetched subtitle's name (PLAY-SUBGET-17): "Spanish (Hearing impaired)", "Spanish 2",
    // "French — Director's cut" read as named, not "Spanish - 2".
    if (/^(\(|\d+$|—)/.test(remainder)) {
      return `${langName} ${remainder}`;
    }
    if (labelNamesLanguage(remainder, normalized, names)) return langName;
    descriptor = remainder;
  }
  return `${langName} - ${descriptor}`;
};
