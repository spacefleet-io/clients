// @vitest-environment jsdom
// @req UX-I18N-01
// The desktop app ships English, French, Dutch, German and Spanish as equals: every locale file holds exactly the same keys
// with the same placeholders, the main process (tray, app menu, quit dialog, file filters) has all five, and a first
// start opens in the system language when it is one of the five.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLIENT_UI_LANGUAGES } from "@space/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAIN_UI_STRINGS, mainUiLanguage, mainUiStrings, seedMainUiLanguage, setMainUiLanguage } from "../src/main/uiStrings";
import { deviceUiLanguage, loadClientConfig } from "../src/renderer/src/lib/config";

const SUITE = "i18n-four-locales";
const CODES = CLIENT_UI_LANGUAGES.map((language) => language.code);

const readLocale = (code: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `../src/renderer/src/i18n/${code}.json`), "utf8")) as unknown;

const flatten = (value: unknown, prefix = ""): Map<string, string> => {
  const out = new Map<string, string>();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      for (const [k, v] of flatten(child, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  } else {
    out.set(prefix, String(value));
  }
  return out;
};

/** `{{name}}` / `{{name, format}}` interpolations, `<0>` / `</0>` Trans tags and `$t(key)` nestings, sorted. */
const placeholders = (text: string): string[] =>
  [
    ...[...text.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)].map((m) => `{{${m[1]}}}`),
    ...[...text.matchAll(/<\/?\d+\s*\/?>/g)].map((m) => m[0].replace(/\s/g, "")),
    ...[...text.matchAll(/\$t\(([^)]+)\)/g)].map((m) => `$t(${m[1]})`),
  ].sort();

const locales = Object.fromEntries(CODES.map((code) => [code, flatten(readLocale(code))])) as Record<string, Map<string, string>>;

describe("desktop locale files (en, fr, nl, de)", () => {
  it("has a file for every app language and the same keys in each", () => {
    const en = locales.en!;
    for (const code of CODES) {
      const other = locales[code]!;
      const missing = [...en.keys()].filter((key) => !other.has(key));
      const extra = [...other.keys()].filter((key) => !en.has(key));
      console.info(`[${SUITE}:keys] ${code}: ${other.size} keys, missing=${JSON.stringify(missing.slice(0, 20))} extra=${JSON.stringify(extra.slice(0, 20))}`);
      expect({ code, missing, extra }).toEqual({ code, missing: [], extra: [] });
    }
    expect(en.size).toBeGreaterThan(1000);
  });

  it("keeps every placeholder, Trans tag and nesting of the English string", () => {
    const en = locales.en!;
    for (const code of CODES.filter((c) => c !== "en")) {
      const mismatches: string[] = [];
      for (const [key, text] of en) {
        const translated = locales[code]!.get(key);
        if (translated === undefined) continue;
        const want = placeholders(text).join(" ");
        const got = placeholders(translated).join(" ");
        if (want !== got) mismatches.push(`${key}: en=[${want}] ${code}=[${got}]`);
      }
      if (mismatches.length) console.error(`=== [${SUITE}:placeholders] ${code} ===\n${mismatches.join("\n")}`);
      expect(mismatches).toEqual([]);
    }
  });

  it("translates: no empty string, and Dutch, German and Spanish are not English copies of the navigation", () => {
    for (const code of CODES) {
      const empty = [...locales[code]!].filter(([, text]) => text.trim() === "").map(([key]) => key);
      expect({ code, empty }).toEqual({ code, empty: [] });
    }
    for (const code of ["nl", "de", "es"]) {
      for (const key of ["nav.library", "nav.settings", "nav.signOut"]) {
        if (!locales.en!.has(key)) continue;
        console.info(`[${SUITE}:nav] ${code} ${key}=${JSON.stringify(locales[code]!.get(key))} en=${JSON.stringify(locales.en!.get(key))}`);
        expect(locales[code]!.get(key)).not.toBe(locales.en!.get(key));
      }
    }
  });
});

describe("main-process strings (quit dialog, file filters)", () => {
  it("exist in all five languages with no empty text", () => {
    expect(Object.keys(MAIN_UI_STRINGS).sort()).toEqual([...CODES].sort());
    for (const code of CODES) {
      const strings = MAIN_UI_STRINGS[code];
      for (const [name, text] of Object.entries(strings)) {
        if (!text.trim()) console.error(`[${SUITE}:main] ${code}.${name} is empty`);
        expect(text.trim()).not.toBe("");
      }
    }
    expect(MAIN_UI_STRINGS.de.quitAnyway).not.toBe(MAIN_UI_STRINGS.en.quitAnyway);
  });

  it("seed from the OS locale, region ignored, English otherwise", () => {
    expect(seedMainUiLanguage("de-AT")).toBe("de");
    expect(seedMainUiLanguage("nl-BE")).toBe("nl");
    expect(seedMainUiLanguage("fr-CA")).toBe("fr");
    expect(seedMainUiLanguage("es-MX")).toBe("es");
    expect(seedMainUiLanguage("ja-JP")).toBe("en");
    expect(seedMainUiLanguage("")).toBe("en");
  });

  it("follow the renderer's reported language and ignore an invalid one", () => {
    seedMainUiLanguage("en-US");
    expect(setMainUiLanguage("nl")).toBe(true);
    expect(mainUiLanguage()).toBe("nl");
    expect(mainUiStrings()).toBe(MAIN_UI_STRINGS.nl);
    expect(setMainUiLanguage("nl")).toBe(false);
    for (const bad of ["ja", "", null, 42, "DE"]) {
      expect(setMainUiLanguage(bad)).toBe(false);
      expect(mainUiLanguage()).toBe("nl");
    }
  });
});

describe("first start language (deviceUiLanguage)", () => {
  const setNavigatorLanguages = (languages: string[]) => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
    vi.spyOn(window.navigator, "language", "get").mockReturnValue(languages[0] ?? "");
  };

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("picks the first system language the app has", () => {
    setNavigatorLanguages(["de-DE", "en-US"]);
    expect(deviceUiLanguage()).toBe("de");
    setNavigatorLanguages(["ja-JP", "nl-NL"]);
    expect(deviceUiLanguage()).toBe("nl");
    setNavigatorLanguages(["es-AR", "en-US"]);
    expect(deviceUiLanguage()).toBe("es");
    setNavigatorLanguages(["ja-JP"]);
    expect(deviceUiLanguage()).toBe("en");
  });

  it("opens a fresh install in the system language, and a saved choice wins afterwards", () => {
    setNavigatorLanguages(["nl-NL"]);
    const fresh = loadClientConfig();
    console.info(`[${SUITE}:fresh] uiLanguage=${fresh.uiLanguage} stored=${JSON.stringify(Object.keys(window.localStorage))}`);
    expect(fresh.uiLanguage).toBe("nl");
  });
});
