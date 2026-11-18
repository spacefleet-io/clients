/**
 * Track language → tesseract traineddata code (the `@tesseract.js-data`
 * package names). Accepts ISO 639-1, ISO 639-2/B and /T, BCP-47-ish tags
 * (`pt-BR`, `zh-Hans`, `sr-Latn`) and English language names.
 */

/** [tesseract code, aliases (639-1, 639-2/B, 639-2/T, other tags, English names)] */
const TESSERACT_LANGUAGES: Array<[string, string[]]> = [
  ["afr", ["af", "afrikaans"]],
  ["amh", ["am", "amharic"]],
  ["ara", ["ar", "arabic"]],
  ["asm", ["as", "assamese"]],
  ["aze", ["az", "azerbaijani"]],
  ["bel", ["be", "belarusian"]],
  ["ben", ["bn", "bengali", "bangla"]],
  ["bod", ["bo", "tib", "tibetan"]],
  ["bos", ["bs", "bosnian"]],
  ["bre", ["br", "breton"]],
  ["bul", ["bg", "bulgarian"]],
  ["cat", ["ca", "catalan", "valencian"]],
  ["ceb", ["cebuano"]],
  ["ces", ["cs", "cze", "czech"]],
  ["chr", ["cherokee"]],
  ["cos", ["co", "corsican"]],
  ["cym", ["cy", "wel", "welsh"]],
  ["dan", ["da", "danish"]],
  ["deu", ["de", "ger", "german", "deutsch"]],
  ["div", ["dv", "dhivehi", "divehi"]],
  ["dzo", ["dz", "dzongkha"]],
  ["ell", ["el", "gre", "greek"]],
  ["eng", ["en", "english"]],
  ["epo", ["eo", "esperanto"]],
  ["est", ["et", "estonian"]],
  ["eus", ["eu", "baq", "basque"]],
  ["fao", ["fo", "faroese"]],
  ["fas", ["fa", "per", "persian", "farsi"]],
  ["fil", ["tl", "tgl", "filipino", "tagalog"]],
  ["fin", ["fi", "finnish"]],
  ["fra", ["fr", "fre", "french", "français", "francais"]],
  ["fry", ["fy", "frisian", "western frisian"]],
  ["gla", ["gd", "gaelic", "scottish gaelic"]],
  ["gle", ["ga", "irish"]],
  ["glg", ["gl", "galician"]],
  ["guj", ["gu", "gujarati"]],
  ["hat", ["ht", "haitian", "haitian creole"]],
  ["heb", ["he", "iw", "hebrew"]],
  ["hin", ["hi", "hindi"]],
  ["hrv", ["hr", "croatian"]],
  ["hun", ["hu", "hungarian"]],
  ["hye", ["hy", "arm", "armenian"]],
  ["iku", ["iu", "inuktitut"]],
  ["ind", ["id", "in", "indonesian"]],
  ["isl", ["is", "ice", "icelandic"]],
  ["ita", ["it", "italian"]],
  ["jav", ["jv", "javanese"]],
  ["kan", ["kn", "kannada"]],
  ["kat", ["ka", "geo", "georgian"]],
  ["kaz", ["kk", "kazakh"]],
  ["khm", ["km", "khmer", "cambodian"]],
  ["kir", ["ky", "kyrgyz", "kirghiz"]],
  ["kmr", ["ku", "kur", "kurdish", "kurmanji"]],
  ["lao", ["lo", "lao"]],
  ["lat", ["la", "latin"]],
  ["lav", ["lv", "latvian"]],
  ["lit", ["lt", "lithuanian"]],
  ["ltz", ["lb", "luxembourgish"]],
  ["mal", ["ml", "malayalam"]],
  ["mar", ["mr", "marathi"]],
  ["mkd", ["mk", "mac", "macedonian"]],
  ["mlt", ["mt", "maltese"]],
  ["mon", ["mn", "mongolian"]],
  ["mri", ["mi", "mao", "maori"]],
  ["msa", ["ms", "may", "malay", "zsm"]],
  ["mya", ["my", "bur", "burmese", "myanmar"]],
  ["nep", ["ne", "nepali"]],
  ["nld", ["nl", "dut", "dutch", "flemish"]],
  ["nor", ["no", "nb", "nn", "nob", "nno", "norwegian", "norwegian bokmål", "norwegian bokmal", "norwegian nynorsk", "bokmål", "bokmal", "nynorsk"]],
  ["oci", ["oc", "occitan"]],
  ["ori", ["or", "oriya", "odia"]],
  ["pan", ["pa", "punjabi", "panjabi"]],
  ["pol", ["pl", "polish"]],
  ["por", ["pt", "portuguese", "brazilian portuguese"]],
  ["pus", ["ps", "pashto", "pushto"]],
  ["que", ["qu", "quechua"]],
  ["ron", ["ro", "rum", "mo", "mol", "romanian", "moldavian", "moldovan"]],
  ["rus", ["ru", "russian"]],
  ["san", ["sa", "sanskrit"]],
  ["sin", ["si", "sinhala", "sinhalese"]],
  ["slk", ["sk", "slo", "slovak"]],
  ["slv", ["sl", "slovenian", "slovene"]],
  ["snd", ["sd", "sindhi"]],
  ["spa", ["es", "spanish", "castilian", "español", "espanol", "latin american spanish"]],
  ["sqi", ["sq", "alb", "albanian"]],
  ["srp", ["sr", "scc", "serbian"]],
  ["sun", ["su", "sundanese"]],
  ["swa", ["sw", "swahili"]],
  ["swe", ["sv", "swedish"]],
  ["syr", ["syriac"]],
  ["tam", ["ta", "tamil"]],
  ["tat", ["tt", "tatar"]],
  ["tel", ["te", "telugu"]],
  ["tgk", ["tg", "tajik"]],
  ["tha", ["th", "thai"]],
  ["tir", ["ti", "tigrinya"]],
  ["ton", ["to", "tonga", "tongan"]],
  ["tur", ["tr", "turkish"]],
  ["uig", ["ug", "uyghur", "uighur"]],
  ["ukr", ["uk", "ukrainian"]],
  ["urd", ["ur", "urdu"]],
  ["uzb", ["uz", "uzbek"]],
  ["vie", ["vi", "vietnamese"]],
  ["yid", ["yi", "yiddish"]],
  ["yor", ["yo", "yoruba"]],
];

const ALIASES: ReadonlyMap<string, string> = new Map(
  TESSERACT_LANGUAGES.flatMap(([code, aliases]) => [[code, code] as const, ...aliases.map((a) => [a, code] as const)])
);

/** Every traineddata code `resolveTesseractLanguage` can return (each needs a pinned sha256). */
export const TESSERACT_LANGUAGE_CODES: readonly string[] = [
  ...TESSERACT_LANGUAGES.map(([code]) => code),
  "srp_latn",
  "uzb_cyrl",
  "aze_cyrl",
];

/**
 * Chinese, Japanese and Korean are never OCR'd (decision 2026-10-29): tags,
 * ISO codes, tesseract codes (`chi_sim`, `jpn_vert`…) and names, in English
 * and in their own scripts.
 */
const CJK_NAMES = new Set([
  "zh",
  "chi",
  "zho",
  "cmn",
  "yue",
  "ja",
  "jpn",
  "ko",
  "kor",
  "chinese",
  "mandarin",
  "cantonese",
  "japanese",
  "korean",
]);
const CJK_NATIVE_NAME = /中文|汉语|漢語|普通话|國語|国语|粵語|粤语|日本語|한국어/;

export type TesseractLanguage =
  | { status: "ocr"; code: string; known: boolean }
  | { status: "excluded"; reason: "cjk" };

/**
 * Picks the traineddata for a track. CJK tracks come back `excluded` and
 * must not be OCR'd. Unknown / undetermined languages fall back to `eng`
 * with `known: false` so the caller logs the guess.
 */
export const resolveTesseractLanguage = (language: string | null | undefined, label?: string | null): TesseractLanguage => {
  const tag = (language ?? "").trim().toLowerCase();
  const hint = `${language ?? ""} ${label ?? ""}`;
  const primary = tag.split(/[-_]/)[0] ?? "";
  const labelWords = (label ?? "").toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const code = ALIASES.get(tag) ?? ALIASES.get(primary);
  if (CJK_NAMES.has(tag) || CJK_NAMES.has(primary)) return { status: "excluded", reason: "cjk" };
  // An undetermined tag defers to the label ("Chinese (Traditional)", "日本語").
  if (!code && (labelWords.some((w) => w.length > 3 && CJK_NAMES.has(w)) || CJK_NATIVE_NAME.test(label ?? ""))) {
    return { status: "excluded", reason: "cjk" };
  }
  if ((primary === "sr" || primary === "srp") && /latn|latin/i.test(hint)) return { status: "ocr", code: "srp_latn", known: true };
  if ((primary === "uz" || primary === "uzb") && /cyrl|cyrillic/i.test(hint)) return { status: "ocr", code: "uzb_cyrl", known: true };
  if ((primary === "az" || primary === "aze") && /cyrl|cyrillic/i.test(hint)) return { status: "ocr", code: "aze_cyrl", known: true };
  if (code) return { status: "ocr", code, known: true };
  // Undetermined tag: the label may still name the language ("French", "Español (Latinoamérica)").
  for (const word of labelWords) {
    const fromLabel = word.length > 3 ? ALIASES.get(word) : undefined;
    if (fromLabel) return { status: "ocr", code: fromLabel, known: true };
  }
  return { status: "ocr", code: "eng", known: false };
};
