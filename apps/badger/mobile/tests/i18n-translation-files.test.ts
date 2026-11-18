/**
 * @test-id MOBILE-I18N-FILES-001
 * @level unit
 *
 * The phone app's words all come from the translation files of its five languages (UX-I18N-01, UX-I18N-02), its
 * French is accented (UX-I18N-03), and its German and Dutch speak informally and are spelled correctly (UX-I18N-09):
 *  - en.json, fr.json, nl.json, de.json and es.json define the same keys (plural forms compared by base key) with the same
 *    `{{placeholders}}`, and no French, Dutch, German or Spanish value is empty or mostly left in English,
 *  - every key the code asks for (`t("a.b")`, `translate("a.b")`) exists in en.json, so in all five,
 *  - every language file names the five languages (`languageNames.*`, looked up with a template key),
 *  - no screen or shell component writes user-facing text directly in the code (JSX text, text props, Alert),
 *  - no French value uses a plain-letter spelling from a known list,
 *  - German says "du" (never "Sie"/"Ihr" addressing the user) and never writes umlauts or ß as stand-ins,
 *  - Dutch says "je" (never "u"/"uw"), Spanish says "tú" (never "usted"),
 *  - no message says a bare "library" / "bibliothèque": it is the "media library" / "médiathèque" (UX-NAME-03),
 *  - the native texts (Android resources, iOS .strings files, Info.plist prompts) exist in all five languages, with
 *    the same placeholders, and the Xcode project ships them (UX-I18N-02).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MOBILE_UI_LANGUAGES } from "@space/mobile-shell/i18n";
import { withSubtitleLanguageTexts } from "@space/shared/profileSettings";
import { withTitleLanguageTexts } from "@space/shared/titleLanguage";
import { withProfilesTexts } from "@space/shared/profileTexts";
import { withAccountDeletionLabels } from "@space/shared/accountDeletionLabels";
import { BARE_LIBRARY as SHARED_BARE_LIBRARY, bareLibraryOutside } from "@space/shared/libraryName";
import { keySavedWarningText } from "@space/shared/keySavedWarning";
import de from "../../../../packages/mobile-shell/src/i18n/de.json";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";
import es from "../../../../packages/mobile-shell/src/i18n/es.json";
import fr from "../../../../packages/mobile-shell/src/i18n/fr.json";
import nl from "../../../../packages/mobile-shell/src/i18n/nl.json";

type Tree = { [key: string]: string | Tree };

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const REPO = resolve(__dirname, "../../../..");

const flatten = (tree: Tree, prefix = ""): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") out[`${prefix}${key}`] = value;
    else Object.assign(out, flatten(value, `${prefix}${key}.`));
  }
  return out;
};

const enFlat = flatten(en);
const frFlat = flatten(fr);
const nlFlat = flatten(nl);
const deFlat = flatten(de);
const esFlat = flatten(es);
/** The translations of en.json, by language code. */
const TRANSLATIONS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["fr", frFlat],
  ["nl", nlFlat],
  ["de", deFlat],
  ["es", esFlat],
];
const baseKeys = (flat: Record<string, string>) => new Set(Object.keys(flat).map((k) => k.replace(PLURAL_SUFFIX, "")));
const placeholders = (value: string) => [...value.matchAll(/\{\{\s*(\w+)[^}]*\}\}/g)].map((m) => m[1]!).sort();
const withoutPlaceholders = (value: string) => value.replace(/\{\{[^}]*\}\}/g, "");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

const SOURCE_ROOTS = [join(REPO, "apps/badger/mobile/src"), join(REPO, "packages/mobile-shell/src"), join(REPO, "packages/mobile-mpv-playback/src")];
const SOURCES = SOURCE_ROOTS.flatMap(walk).filter((f) => !/[\\/]i18n[\\/]/.test(f));
// Test files render fixtures, not user-facing text.
const UI_SOURCES = SOURCES.filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** French spellings that lost their accents; each must never appear as a word in a French value. */
const UNACCENTED = [
  "hote",
  "hotes",
  "definissez",
  "definir",
  "verifiez",
  "verification",
  "verifier",
  "reessayez",
  "reessayer",
  "deja",
  "echoue",
  "echouee",
  "echec",
  "creer",
  "cree",
  "cinema",
  "envoye",
  "envoyee",
  "reinitialiser",
  "reinitialisation",
  "parametres",
  "reglages",
  "bibliotheque",
  "telecharger",
  "telechargement",
  "telechargements",
  "telecharge",
  "personnalise",
  "personnalisee",
  "defaut",
  "stocke",
  "stockees",
  "deconnexion",
  "deconnecter",
  "elements",
  "recents",
  "recent",
  "supprime",
  "supprimee",
  "qualite",
  "annule",
  "termine",
  "episode",
  "episodes",
  "resolution",
  "memoire",
  "reseau",
  "numero",
  "controle",
  "synchronise",
  "synchronisee",
  "genere",
  "selectionner",
  "selectionnez",
  "selectionne",
  "precedent",
  "equipement",
  "applique",
  "meme",
  "tres",
  "etre",
  "ete",
  "a jour",
  "mise a jour",
];
const UNACCENTED_RE = new RegExp(`(?<![\\p{L}])(${UNACCENTED.join("|")})(?![\\p{L}])`, "iu");

/** German words written with a stand-in for ä, ö, ü or ß; each must never appear as a word in a German value. */
const GERMAN_STAND_INS = [
  "groesse",
  "groesser",
  "gross",
  "grosse",
  "loeschen",
  "geloescht",
  "loesche",
  "schliessen",
  "schliesse",
  "abschliessen",
  "oeffnen",
  "oeffne",
  "fuer",
  "ueber",
  "zurueck",
  "koennen",
  "moechtest",
  "waehle",
  "waehlen",
  "hinzufuegen",
  "fuege",
  "naechste",
  "naechsten",
  "verfuegbar",
  "laeuft",
  "geraet",
  "geraete",
  "schluessel",
  "passwoerter",
  "muessen",
  "spaeter",
  "ausserdem",
  "heisst",
  "weiss",
  "pruefen",
  "pruefe",
  "aendern",
  "aenderung",
  "aenderungen",
  "frueher",
  "haeufig",
  "bestaetigen",
  "bestaetigung",
  "hoerbuch",
  "standardmaessig",
];
const GERMAN_STAND_IN_RE = new RegExp(`(?<![\\p{L}])(${GERMAN_STAND_INS.join("|")})(?![\\p{L}])`, "iu");
/** "Sie"/"Ihnen"/"Ihr…" addressing the user, i.e. not opening a sentence (where "Sie" can mean "they"). */
const GERMAN_FORMAL_RE = /(?<![.!?:]\s|^)(?<![\p{L}])(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?![\p{L}])/u;
/** "u"/"uw" addressing the user; "{{hours}} u" (the hour abbreviation) is not one. */
const DUTCH_FORMAL_RE = /(?<![\p{L}])(?<!\}\}\s)(u|uw|U|Uw)(?![\p{L}])/u;
const ANDROID_RES = join(REPO, "packages/mobile-media-proxy/android/src/main/res");
const ANDROID_APP_RES = join(REPO, "apps/badger/mobile/android/app/src/main/res");
const IOS = join(REPO, "apps/badger/mobile/ios");
const IOS_APP = join(IOS, "SpaceBadgerMobile");
/** The download notification texts ship in the MediaProxy pod (resource bundle `MediaProxyDownloads`), next to `DownloadEngine.swift`. */
const IOS_DOWNLOAD_STRINGS = join(REPO, "packages/mobile-media-proxy/ios/Downloads/Resources");

/** `<string name="a">text</string>` entries of an Android resource file, as name -> text. */
const androidStrings = (file: string): Record<string, string> =>
  Object.fromEntries([...readFileSync(file, "utf8").matchAll(/<string name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)].map((m) => [m[1]!, m[2]!]));

/** `"key" = "value";` entries of an iOS .strings file, as key -> value. */
const iosStrings = (file: string): Record<string, string> =>
  Object.fromEntries([...readFileSync(file, "utf8").matchAll(/^"([^"]+)"\s*=\s*"((?:[^"\\]|\\.)*)";/gm)].map((m) => [m[1]!, m[2]!]));

const BARE_LIBRARY: Record<string, RegExp> = SHARED_BARE_LIBRARY;
const BARE_LIBRARY_EN = SHARED_BARE_LIBRARY.en;
const BARE_LIBRARY_FR = SHARED_BARE_LIBRARY.fr;
/**
 * The page itself is called "Library" (UX-NAME-02, Chris 2026-11-09): its tab, the empty page's "Your library" and the TV
 * title page's "Back to Library" name the page, not the collection, so they are the only keys allowed the bare word.
 */
const bareLibrary = bareLibraryOutside(new Set(["nav.library", "home.emptyLibrary.eyebrow", "tvShell.empty.eyebrow", "tvShell.details.backToLibrary"]));
/** Android resource folder suffix per language: the default `values` folder is English. */
const ANDROID_SUFFIX: Record<string, string> = { en: "", fr: "-fr", nl: "-nl", de: "-de", es: "-es" };
const NATIVE_LANGUAGES = ["en", "fr", "nl", "de", "es"] as const;
const OTHER_NATIVE_LANGUAGES = ["fr", "nl", "de", "es"] as const;

describe("mobile translation files", () => {
  /** @req UX-I18N-01[badger-mobile,badger-tv] @req UX-I18N-02[badger-mobile,badger-tv] */
  it("English, French, Dutch, German and Spanish define the same keys", () => {
    const enKeys = baseKeys(enFlat);
    for (const [language, flat] of TRANSLATIONS) {
      const keys = baseKeys(flat);
      const missing = [...enKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enKeys.has(k));
      console.info(`[MOBILE-I18N-FILES-001] en keys=${enKeys.size} ${language} keys=${keys.size} missingIn${language}=${JSON.stringify(missing)} extraIn${language}=${JSON.stringify(extra)}`);
      expect({ language, missing, extra }).toEqual({ language, missing: [], extra: [] });
    }
  });

  /** @req UX-I18N-01[badger-mobile,badger-tv] @req UX-I18N-02[badger-mobile,badger-tv] */
  it("no French, Dutch, German or Spanish value is empty or left in English by accident", () => {
    for (const [language, flat] of TRANSLATIONS) {
      const empty = Object.entries(flat).filter(([, v]) => v.trim() === "").map(([k]) => k);
      expect({ language, empty }).toEqual({ language, empty: [] });
      const sameAsEnglish = Object.keys(flat).filter((k) => enFlat[k] !== undefined && enFlat[k] === flat[k] && /[A-Za-z]{4,}/.test(withoutPlaceholders(flat[k]!)));
      console.info(`[MOBILE-I18N-FILES-001] ${language} values identical to en (cognates, brand names, host examples, genres): ${JSON.stringify(sameAsEnglish)}`);
      expect(sameAsEnglish.length).toBeLessThan(Object.keys(flat).length * 0.08);
    }
  });

  /** @req UX-I18N-02[badger-mobile,badger-tv] */
  it("every translation keeps the {{placeholders}} of the English text", () => {
    const mismatches: string[] = [];
    for (const [language, flat] of TRANSLATIONS) {
      for (const [key, value] of Object.entries(flat)) {
        const english = enFlat[key] ?? enFlat[key.replace(PLURAL_SUFFIX, "_other")];
        if (english === undefined) continue;
        const want = placeholders(english);
        const got = placeholders(value);
        if (JSON.stringify(want) !== JSON.stringify(got)) mismatches.push(`${language} ${key}: en ${JSON.stringify(want)} vs ${JSON.stringify(got)}`);
      }
    }
    console.info(`[MOBILE-I18N-FILES-001] placeholder mismatches=${JSON.stringify(mismatches, null, 1)}`);
    expect(mismatches).toEqual([]);
  });

  /** @req UX-I18N-01[badger-mobile,badger-tv] */
  it("every language file names each of the five app languages", () => {
    const codes = MOBILE_UI_LANGUAGES.map((option) => option.code);
    expect(codes).toEqual(["en", "fr", "nl", "de", "es"]);
    for (const [language, flat] of [["en", enFlat] as const, ...TRANSLATIONS]) {
      const names = codes.map((code) => flat[`languageNames.${code}`]);
      console.info(`[MOBILE-I18N-FILES-001] ${language} languageNames=${JSON.stringify(names)}`);
      expect(names.every((name) => typeof name === "string" && name.trim().length > 0)).toBe(true);
      expect(new Set(names).size).toBe(codes.length);
    }
  });

  /** @req UX-I18N-02[badger-mobile,badger-tv] */
  it("every key the code looks up exists in the English file", () => {
    // The texts shared by every app are added at load, as `initI18n` does.
    const known = baseKeys(flatten(withAccountDeletionLabels(withProfilesTexts(withSubtitleLanguageTexts(withTitleLanguageTexts(en, "en"), "en"), "en"), "mobile", "en")));
    const lookups: Array<{ file: string; key: string }> = [];
    for (const file of SOURCES) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const m of text.matchAll(/(?<![\w.])(?:t|translate|i18n\.t)\(\s*["']([A-Za-z][\w.]*)["']/g)) lookups.push({ file: relative(REPO, file), key: m[1]! });
    }
    const missing = lookups.filter(({ key }) => !known.has(key) && !key.includes(" ")).map(({ file, key }) => `${file}: ${key}`);
    console.info(`[i18n] static lookups=${lookups.length} missing=${JSON.stringify(missing)}`);
    expect(lookups.length).toBeGreaterThan(150);
    expect(missing).toEqual([]);
  });

  /** @req UX-I18N-02[badger-mobile,badger-tv] */
  it("no screen or component writes user-facing text directly in the code", () => {
    const TEXT_PROP = "title|label|placeholder|accessibilityLabel|accessibilityHint|message|subtitle|hint|description|headline|body|caption|text";
    const offenders: string[] = [];
    for (const file of UI_SOURCES) {
      const text = stripComments(readFileSync(file, "utf8"));
      const where = (index: number) => `${relative(REPO, file)}:${text.slice(0, index).split("\n").length}`;
      // JSX text between tags: `<Text>Some words</Text>`
      for (const m of text.matchAll(/(?<!=)>\s*([A-Za-zÀ-ÿ][^<>{}=;]*[A-Za-zÀ-ÿ?!.:])\s*</g)) {
        if (/^[A-Z]{1,3}[0-9]?$/.test(m[1]!.trim())) continue; // icon glyph / unit like "CC"
        if (/[a-z]\s+[a-z]|^[A-Z][a-z]{3,}/.test(m[1]!)) offenders.push(`${where(m.index!)} jsx text "${m[1]!.trim()}"`);
      }
      // text props given a string literal: `placeholder="Search"`
      for (const m of text.matchAll(new RegExp(`\\b(?:${TEXT_PROP})=\\"([^\\"]*[a-zà-ÿ]{3}[^\\"]*)\\"`, "g"))) offenders.push(`${where(m.index!)} prop "${m[1]}"`);
      // Alert.alert("Literal", ...)
      for (const m of text.matchAll(/Alert\.alert\(\s*["'`]([^"'`]+)["'`]/g)) offenders.push(`${where(m.index!)} alert "${m[1]}"`);
    }
    console.info(`[i18n] ui files scanned=${UI_SOURCES.length} offenders=${JSON.stringify(offenders, null, 1)}`);
    expect(offenders).toEqual([]);
  });

  /** @req UX-I18N-03[badger-mobile,badger-tv] */
  it("French values never use a plain-letter spelling from the known list", () => {
    const offenders = Object.entries(frFlat)
      .map(([key, value]) => ({ key, value, hit: value.replace(/\{\{[^}]*\}\}/g, "").match(UNACCENTED_RE)?.[0] }))
      .filter((row) => row.hit)
      .map((row) => `${row.key}: "${row.value}" (${row.hit})`);
    console.info(`[i18n] unaccented French offenders=${JSON.stringify(offenders, null, 1)}`);
    expect(offenders).toEqual([]);
  });

  /** @req UX-I18N-03[badger-mobile,badger-tv] */
  it("the French file does use accents where the language needs them", () => {
    const accented = Object.values(frFlat).filter((v) => /[àâçéèêëîïôûùüÿœÀÂÇÉÈÊËÎÏÔÛÙÜŸŒ]/.test(v));
    expect(frFlat["authApiHost.button"]).toBe("Hôte API");
    expect(accented.length).toBeGreaterThan(100);
  });

  /** @req UX-I18N-09[badger-mobile,badger-tv] */
  it("German never writes ä, ö, ü or ß as a stand-in and does use them", () => {
    const offenders = Object.entries(deFlat)
      .map(([key, value]) => ({ key, value, hit: withoutPlaceholders(value).match(GERMAN_STAND_IN_RE)?.[0] }))
      .filter((row) => row.hit)
      .map((row) => `${row.key}: "${row.value}" (${row.hit})`);
    const withUmlaut = Object.values(deFlat).filter((v) => /[äöüÄÖÜ]/.test(v)).length;
    const withEszett = Object.values(deFlat).filter((v) => v.includes("ß")).length;
    console.info(`[MOBILE-I18N-FILES-001] German stand-in offenders=${JSON.stringify(offenders, null, 1)} withUmlaut=${withUmlaut} withEszett=${withEszett}`);
    expect(offenders).toEqual([]);
    expect(withUmlaut).toBeGreaterThan(100);
    expect(withEszett).toBeGreaterThan(0);
  });

  /** @req UX-I18N-09[badger-mobile,badger-tv] */
  it("German, Dutch and Spanish speak to the user informally", () => {
    const germanFormal = Object.entries(deFlat)
      .filter(([, value]) => GERMAN_FORMAL_RE.test(withoutPlaceholders(value)))
      .map(([key, value]) => `${key}: "${value}"`);
    const dutchFormal = Object.entries(nlFlat)
      .filter(([, value]) => DUTCH_FORMAL_RE.test(value))
      .map(([key, value]) => `${key}: "${value}"`);
    const germanDu = Object.values(deFlat).filter((v) => /(?<![\p{L}])(du|dein\p{L}*|dich|dir)(?![\p{L}])/iu.test(v)).length;
    const dutchJe = Object.values(nlFlat).filter((v) => /(?<![\p{L}])(je|jij|jouw)(?![\p{L}])/iu.test(v)).length;
    console.info(`[MOBILE-I18N-FILES-001] germanFormal=${JSON.stringify(germanFormal, null, 1)} dutchFormal=${JSON.stringify(dutchFormal, null, 1)} germanDu=${germanDu} dutchJe=${dutchJe}`);
    expect(germanFormal).toEqual([]);
    expect(dutchFormal).toEqual([]);
    expect(germanDu).toBeGreaterThan(50);
    expect(dutchJe).toBeGreaterThan(50);
    const spanishUsted = Object.entries(esFlat)
      .filter(([, value]) => /(?<![\p{L}])(usted|ustedes)(?![\p{L}])/iu.test(value))
      .map(([key, value]) => `${key}: "${value}"`);
    const spanishTu = Object.values(esFlat).filter((v) => /(?<![\p{L}])(tu|tus|tú|te|ti|contigo)(?![\p{L}])/iu.test(v)).length;
    console.info(`[MOBILE-I18N-FILES-001] spanishUsted=${JSON.stringify(spanishUsted, null, 1)} spanishTu=${spanishTu}`);
    expect(spanishUsted).toEqual([]);
    expect(spanishTu).toBeGreaterThan(50);
  });

  /** @req UX-NAME-03[badger-mobile,badger-tv] */
  it("no English message says a bare \"library\": it is the \"media library\"", () => {
    const offenders = Object.entries(enFlat).filter(bareLibrary(BARE_LIBRARY_EN)).map(([k, v]) => `${k}: "${v}"`);
    const mediaLibrary = Object.entries(enFlat).filter(([, v]) => /media library/i.test(v)).length;
    console.info(`[i18n] en strings saying "media library"=${mediaLibrary} bare "library" offenders=${JSON.stringify(offenders, null, 1)}`);
    expect(mediaLibrary).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });

  /** @req UX-NAME-03[badger-mobile,badger-tv] */
  it("no French message says a bare \"bibliothèque\": it is the \"médiathèque\"", () => {
    const offenders = Object.entries(frFlat).filter(bareLibrary(BARE_LIBRARY_FR)).map(([k, v]) => `${k}: "${v}"`);
    const mediatheque = Object.entries(frFlat).filter(([, v]) => /médiathèque/i.test(v)).length;
    console.info(`[i18n] fr strings saying "médiathèque"=${mediatheque} bare "bibliothèque" offenders=${JSON.stringify(offenders, null, 1)}`);
    expect(mediatheque).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });

  /** @req UX-NAME-03[badger-mobile,badger-tv] */
  it("no Dutch, German or Spanish message says a bare library: it is the \"mediatheek\" / \"Mediathek\" / \"mediateca\"", () => {
    for (const [lang, flat] of [["nl", nlFlat], ["de", deFlat], ["es", esFlat]] as const) {
      const offenders = Object.entries(flat).filter(bareLibrary(BARE_LIBRARY[lang]!)).map(([k, v]) => `${k}: "${v}"`);
      const mediatheek = Object.entries(flat).filter(([, v]) => /mediathe?ek|mediateca/i.test(v)).length;
      console.info(`[i18n] ${lang} strings saying the media library=${mediatheek} bare library offenders=${JSON.stringify(offenders, null, 1)}`);
      expect(mediatheek).toBeGreaterThan(30);
      expect(offenders).toEqual([]);
    }
  });

  /** @req UX-NAME-03[badger-mobile,badger-tv] */
  it("the new-key step's shared sentences (keySavedWarningText) say Badger's media library, never a bare library", () => {
    const offenders = NATIVE_LANGUAGES.flatMap((lang) =>
      Object.entries(keySavedWarningText(lang, "badger"))
        .filter(([, value]) => BARE_LIBRARY[lang]!.test(value))
        .map(([key, value]) => `${lang}.${key}: "${value}"`),
    );
    console.info(`[i18n] keySavedWarningText badger bare library offenders=${JSON.stringify(offenders, null, 1)}`);
    expect(offenders).toEqual([]);
    expect(keySavedWarningText("en", "badger").stepLine).toContain("can get your media library back");
  });

  /** @req UX-NAME-03[badger-mobile] */
  it("the native texts (Android resources, iOS strings and permission prompts) never say a bare library either", () => {
    const native: { lang: string; key: string; value: string }[] = [];
    for (const lang of NATIVE_LANGUAGES) {
      Object.entries(androidStrings(join(ANDROID_RES, `values${ANDROID_SUFFIX[lang]}/strings.xml`))).forEach(([key, value]) => native.push({ lang, key: `android-${lang}:${key}`, value }));
      Object.entries(iosStrings(join(IOS_DOWNLOAD_STRINGS, `${lang}.lproj/Localizable.strings`))).forEach(([key, value]) => native.push({ lang, key: `ios-${lang}:Localizable.strings:${key}`, value }));
      Object.entries(iosStrings(join(IOS_APP, `${lang}.lproj/InfoPlist.strings`))).forEach(([key, value]) => native.push({ lang, key: `ios-${lang}:InfoPlist.strings:${key}`, value }));
    }
    const infoPlist = readFileSync(join(IOS_APP, "Info.plist"), "utf8");
    for (const m of infoPlist.matchAll(/<key>(NS\w+UsageDescription)<\/key>\s*<string>([^<]*)<\/string>/g)) native.push({ lang: "en", key: `Info.plist:${m[1]}`, value: m[2]! });
    const offenders = native.filter(({ lang, value }) => BARE_LIBRARY[lang]!.test(value)).map(({ key, value }) => `${key}: "${value}"`);
    console.info(`[i18n] native strings scanned=${native.length} bare library offenders=${JSON.stringify(offenders, null, 1)}`);
    expect(native.length).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });

  /** @req UX-I18N-02[badger-mobile] */
  it("Android download notification texts exist in English, French, Dutch and German with the same placeholders", () => {
    const en = androidStrings(join(ANDROID_RES, "values/strings.xml"));
    expect(Object.keys(en).length).toBeGreaterThanOrEqual(7);
    for (const lang of OTHER_NATIVE_LANGUAGES) {
      const other = androidStrings(join(ANDROID_RES, `values${ANDROID_SUFFIX[lang]}/strings.xml`));
      console.info(`[i18n] android ${lang}=${JSON.stringify(other)}`);
      expect(Object.keys(other).sort(), `values${ANDROID_SUFFIX[lang]} has the English names`).toEqual(Object.keys(en).sort());
      for (const [name, value] of Object.entries(other)) {
        expect(value.match(/%\d+\$[ds]/g) ?? [], `${lang} ${name} has the English placeholders`).toEqual(en[name]!.match(/%\d+\$[ds]/g) ?? []);
      }
    }
    // French shares no word with English here; Dutch and German keep the loanword "Downloads", so only French is checked for copies.
    const fr = androidStrings(join(ANDROID_RES, "values-fr/strings.xml"));
    for (const [name, value] of Object.entries(fr)) expect(value, `fr ${name} must not be a copy of the English text`).not.toBe(en[name]);
    // The French percentage is written "42 %", as in packages/mobile-shell/src/i18n/fr.json.
    expect(fr["media_proxy_downloads_percent"]).toBe("%1$d %%");
    expect(androidStrings(join(ANDROID_RES, "values-de/strings.xml"))["media_proxy_downloads_waiting_wifi"]).toBe("Warten auf WLAN");
    expect(androidStrings(join(ANDROID_RES, "values-nl/strings.xml"))["media_proxy_downloads_waiting_wifi"]).toBe("Wacht op wifi");
  });

  /** @req UX-I18N-02[badger-mobile] */
  it("iOS download notification texts exist in English, French, Dutch and German in Localizable.strings", () => {
    const en = iosStrings(join(IOS_DOWNLOAD_STRINGS, "en.lproj/Localizable.strings"));
    expect(Object.keys(en).length).toBeGreaterThanOrEqual(5);
    for (const lang of OTHER_NATIVE_LANGUAGES) {
      const other = iosStrings(join(IOS_DOWNLOAD_STRINGS, `${lang}.lproj/Localizable.strings`));
      console.info(`[i18n] ios Localizable ${lang}=${JSON.stringify(other)}`);
      expect(Object.keys(other).sort(), `${lang}.lproj has the English keys`).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(other)) expect(value, `${lang} ${key} must not be a copy of the English text`).not.toBe(en[key]);
    }
  });

  /** @req UX-I18N-02[badger-mobile] */
  it("iOS permission prompts and the app name come from InfoPlist.strings in English, French, Dutch and German", () => {
    const infoPlist = readFileSync(join(IOS_APP, "Info.plist"), "utf8");
    const plistKeys = [...infoPlist.matchAll(/<key>(NS(?:Camera|FaceID|LocalNetwork)UsageDescription)<\/key>/g)].map((m) => m[1]!);
    const en = iosStrings(join(IOS_APP, "en.lproj/InfoPlist.strings"));
    console.info(`[i18n] Info.plist prompts=${JSON.stringify(plistKeys)} en=${JSON.stringify(en)}`);
    expect(plistKeys.sort()).toEqual(["NSCameraUsageDescription", "NSFaceIDUsageDescription", "NSLocalNetworkUsageDescription"]);
    for (const key of [...plistKeys, "CFBundleDisplayName"]) expect(en[key], `en InfoPlist.strings has ${key}`).toBeTruthy();
    for (const lang of OTHER_NATIVE_LANGUAGES) {
      const other = iosStrings(join(IOS_APP, `${lang}.lproj/InfoPlist.strings`));
      console.info(`[i18n] InfoPlist.strings ${lang}=${JSON.stringify(other)}`);
      expect(Object.keys(other).sort(), `${lang} InfoPlist.strings has the English keys`).toEqual(Object.keys(en).sort());
      for (const key of plistKeys) expect(other[key], `${lang} ${key} is translated`).not.toBe(en[key]);
      expect(other["CFBundleDisplayName"]).toBe("Badger");
    }
    // The Info.plist value is the fallback: it must say the same as the English file.
    for (const key of [...plistKeys, "CFBundleDisplayName"]) {
      const base = infoPlist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
      expect(base, `Info.plist ${key} matches en InfoPlist.strings`).toBe(en[key]);
    }
  });

  /** @req UX-I18N-02[badger-mobile] */
  it("the Xcode project ships the French, Dutch and German strings files", () => {
    const pbx = readFileSync(join(IOS, "SpaceBadgerMobile.xcodeproj/project.pbxproj"), "utf8");
    const regions = pbx.match(/knownRegions = \(([\s\S]*?)\);/)?.[1] ?? "";
    console.info(`[i18n] pbxproj knownRegions=${JSON.stringify(regions.replace(/\s+/g, " ").trim())}`);
    for (const lang of OTHER_NATIVE_LANGUAGES) expect(regions, `knownRegions has ${lang}`).toMatch(new RegExp(`\\b${lang},`));
    for (const lang of NATIVE_LANGUAGES) expect(pbx, `${lang}.lproj/InfoPlist.strings is a file of the project`).toContain(`path = SpaceBadgerMobile/${lang}.lproj/InfoPlist.strings;`);
    expect(pbx, "InfoPlist.strings is copied into the app").toContain("InfoPlist.strings in Resources");
    // Localizable.strings (download notifications) ships in the MediaProxy pod's resource bundle instead.
    const podspec = readFileSync(join(REPO, "packages/mobile-media-proxy/MediaProxy.podspec"), "utf8");
    expect(podspec, "MediaProxy.podspec bundles the download notification strings").toContain('"MediaProxyDownloads" => ["ios/Downloads/Resources/*.lproj/*.strings"]');
    for (const lang of NATIVE_LANGUAGES) expect(statSync(join(IOS_DOWNLOAD_STRINGS, `${lang}.lproj/Localizable.strings`)).isFile(), `${lang}.lproj/Localizable.strings is in the pod`).toBe(true);
  });

  /** @req UX-I18N-02[badger-mobile] @req PLAT-SUITE-02[badger-mobile,badger-tv] */
  it("the app is called Badger under its icon on both phones and the TV, not SpaceBadger or SpaceBadgerMobile", () => {
    const androidName = androidStrings(join(ANDROID_APP_RES, "values/strings.xml"))["app_name"];
    const iosName = iosStrings(join(IOS_APP, "en.lproj/InfoPlist.strings"))["CFBundleDisplayName"];
    const tvPlist = readFileSync(join(IOS, "SpaceBadgerTV/Info.plist"), "utf8");
    const tvName = tvPlist.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
    const appJson = JSON.parse(readFileSync(join(REPO, "apps/badger/mobile/app.json"), "utf8")) as { displayName: string };
    const launchLabel = readFileSync(join(IOS_APP, "LaunchScreen.storyboard"), "utf8").match(/<label [^>]*text="([^"]*)"/)?.[1];
    console.info(`[i18n] android app_name=${androidName} ios CFBundleDisplayName=${iosName} tv=${tvName} app.json displayName=${appJson.displayName} launch=${launchLabel}`);
    expect(androidName).toBe("Badger");
    expect(iosName).toBe("Badger");
    expect(tvName).toBe("Badger");
    expect(appJson.displayName).toBe("Badger");
    expect(launchLabel).toBe("Badger");
    // Every text the phone and the TV show reads "Badger"; "SpaceBadger" is only a domain name (PLAT-SUITE-02).
    for (const [lang, flat] of TRANSLATIONS) {
      const spaced = Object.entries(flat).filter(([, value]) => /SpaceBadger/.test(value));
      if (spaced.length) console.info(`[i18n] ${lang} still says SpaceBadger: ${JSON.stringify(spaced)}`);
      expect(spaced, `${lang} texts never say SpaceBadger`).toEqual([]);
    }
    for (const lang of NATIVE_LANGUAGES) {
      const strings = iosStrings(join(IOS_APP, `${lang}.lproj/InfoPlist.strings`));
      expect(Object.values(strings).filter((v) => /SpaceBadger/.test(v)), `${lang} InfoPlist.strings never says SpaceBadger`).toEqual([]);
    }
  });
});
