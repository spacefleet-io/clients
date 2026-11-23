/**
 * @test-id PARROT-MOBILE-I18N-FILES-001
 * @level unit
 * @bugfix @regression-proof
 * @why Found on the emulator (2026-11-08, PixelAndroidQA): about 30 texts of Parrot phone (sign-in, library key,
 *   library, player, Settings and navigation titles) were written in English in the code, so a French phone showed
 *   them in English. Every word now comes from the translation files, and this guard fails on a key the code asks
 *   for that a file lacks, or on text written straight into a screen.
 *
 * Parrot's words are the shared phone texts (packages/mobile-shell/src/i18n) plus its own `parrot.*` texts
 * (src/i18n), in English, French, Dutch, German and Spanish (UX-I18N-01, UX-I18N-02):
 *  - Parrot's five files define the same keys (plural forms compared by base key) with the same `{{placeholders}}`,
 *    and no French, Dutch, German or Spanish value is empty or left in English,
 *  - every key the code asks for (`t("a.b")`, `translate("a.b")`, and the prefix of a `t(\`a.${x}\`)` template) exists
 *    in English, so in all five,
 *  - no screen, setup step or App.tsx writes user-facing text directly in the code (JSX text, text props).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import sharedEn from "../../../../packages/mobile-shell/src/i18n/en.json";
import { SHELL_EN } from "../../../../packages/parrot-core/src/shellStrings";
import { profilesTexts } from "../../../../packages/shared/src/profileTexts";
import de from "../src/i18n/de.json";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import fr from "../src/i18n/fr.json";
import nl from "../src/i18n/nl.json";

type Tree = { [key: string]: string | Tree };

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const APP = resolve(__dirname, "..");
const REPO = resolve(APP, "../../..");

const flatten = (tree: Tree, prefix = ""): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") out[`${prefix}${key}`] = value;
    else Object.assign(out, flatten(value, `${prefix}${key}.`));
  }
  return out;
};

const enFlat = flatten(en);
const TRANSLATIONS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["fr", flatten(fr)],
  ["nl", flatten(nl)],
  ["de", flatten(de)],
  ["es", flatten(es)],
];
const baseKeys = (flat: Record<string, string>) => new Set(Object.keys(flat).map((k) => k.replace(PLURAL_SUFFIX, "")));
const placeholders = (value: string) => [...value.matchAll(/\{\{\s*(\w+)[^}]*\}\}/g)].map((m) => m[1]!).sort();

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

const SOURCES = [join(APP, "App.tsx"), ...walk(join(APP, "src"))];
const UI_SOURCES = SOURCES.filter((f) => f.endsWith(".tsx"));
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("Parrot phone translation files", () => {
  /** @req UX-I18N-01[parrot] */
  it("English, French, Dutch, German and Spanish define the same Parrot keys", () => {
    const enKeys = baseKeys(enFlat);
    for (const [language, flat] of TRANSLATIONS) {
      const keys = baseKeys(flat);
      const missing = [...enKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enKeys.has(k));
      console.info(`[PARROT-I18N] en keys=${enKeys.size} ${language} keys=${keys.size} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
      expect({ language, missing, extra }).toEqual({ language, missing: [], extra: [] });
    }
  });

  /** @req UX-I18N-01[parrot] */
  it("no French, Dutch, German or Spanish value is empty or left in English", () => {
    // Words that are the same in both languages, checked by hand.
    const COGNATES: Record<string, true> = {
      "fr parrot.player.position": true,
      "de parrot.player.position": true,
      ...Object.fromEntries(
        ["fr", "nl"].flatMap((language) =>
          ["parrot.library.view.albums", "parrot.library.albums_one", "parrot.library.albums_other"].map((key) => [`${language} ${key}`, true as const])
        )
      ),
    };
    for (const [language, flat] of TRANSLATIONS) {
      const empty = Object.entries(flat).filter(([, v]) => v.trim() === "").map(([k]) => k);
      const sameAsEnglish = Object.keys(flat).filter(
        (k) => enFlat[k] === flat[k] && /[A-Za-z]{4,}/.test(flat[k]!.replace(/\{\{[^}]*\}\}/g, "")) && !COGNATES[`${language} ${k}`]
      );
      console.info(`[PARROT-I18N] ${language} empty=${JSON.stringify(empty)} sameAsEnglish=${JSON.stringify(sameAsEnglish)}`);
      expect({ language, empty, sameAsEnglish }).toEqual({ language, empty: [], sameAsEnglish: [] });
    }
  });

  /** @req UX-I18N-02[parrot] */
  it("every translation keeps the {{placeholders}} of the English text", () => {
    const mismatches: string[] = [];
    for (const [language, flat] of TRANSLATIONS) {
      for (const [key, value] of Object.entries(flat)) {
        const english = enFlat[key] ?? enFlat[key.replace(PLURAL_SUFFIX, "_other")];
        if (english === undefined) continue;
        if (JSON.stringify(placeholders(english)) !== JSON.stringify(placeholders(value))) mismatches.push(`${language} ${key}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  /** @req UX-I18N-02[parrot] */
  it("every key the code looks up exists in the shared or Parrot English file", () => {
    // `shell.*`: the Parrot texts every surface shares (@space/parrot-core), which `src/lib/i18n.ts` nests under `shell.`.
    const shellKeys = Object.keys(SHELL_EN).map((key) => `shell.${key}`);
    // `profiles.*`: the profile screens' texts every app shares (`withProfilesTexts`, added by the phone shell's i18n).
    const profileKeys = baseKeys(flatten({ profiles: profilesTexts.en } as Tree));
    const known = new Set([...baseKeys(flatten(sharedEn as Tree)), ...baseKeys(enFlat), ...shellKeys, ...profileKeys]);
    const missing: string[] = [];
    let lookups = 0;
    for (const file of SOURCES) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const m of text.matchAll(/(?<![\w.])(?:t|translate)\(\s*["']([A-Za-z][\w.]*)["']/g)) {
        lookups += 1;
        if (!known.has(m[1]!)) missing.push(`${relative(REPO, file)}: ${m[1]}`);
      }
      // `t(\`parrot.key.errors.${result}\`)`: the prefix must hold keys.
      for (const m of text.matchAll(/(?<![\w.])(?:t|translate)\(\s*`([A-Za-z][\w.]*\.)\$\{/g)) {
        lookups += 1;
        if (![...known].some((key) => key.startsWith(m[1]!))) missing.push(`${relative(REPO, file)}: ${m[1]}*`);
      }
    }
    console.info(`[PARROT-I18N] lookups=${lookups} missing=${JSON.stringify(missing)}`);
    expect(lookups).toBeGreaterThan(60);
    expect(missing).toEqual([]);
  });

  /** @req UX-I18N-02[parrot] */
  it("no screen, setup step or App.tsx writes user-facing text directly in the code", () => {
    const TEXT_PROP = "title|label|placeholder|accessibilityLabel|accessibilityHint|message|subtitle|hint|description|body|text";
    const offenders: string[] = [];
    for (const file of UI_SOURCES) {
      const text = stripComments(readFileSync(file, "utf8"));
      const where = (index: number) => `${relative(REPO, file)}:${text.slice(0, index).split("\n").length}`;
      for (const m of text.matchAll(/(?<!=)>\s*([A-Za-zÀ-ÿ][^<>{}=;]*[A-Za-zÀ-ÿ?!.:])\s*</g)) {
        if (/[a-z]\s+[a-z]|^[A-Z][a-z]{3,}/.test(m[1]!)) offenders.push(`${where(m.index!)} jsx text "${m[1]!.trim()}"`);
      }
      for (const m of text.matchAll(new RegExp(`\\b(?:${TEXT_PROP})=\\"([^\\"]*[a-zà-ÿ]{3}[^\\"]*)\\"`, "g"))) offenders.push(`${where(m.index!)} prop "${m[1]}"`);
      for (const m of text.matchAll(/\b(?:title|accessibilityLabel):\s*["']([^"']*[a-z]{3}[^"']*)["']/g)) offenders.push(`${where(m.index!)} option "${m[1]}"`);
    }
    console.info(`[PARROT-I18N] ui files scanned=${UI_SOURCES.length} offenders=${JSON.stringify(offenders, null, 1)}`);
    expect(offenders).toEqual([]);
  });
});
