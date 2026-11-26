import { CLIENT_UI_LANGUAGES } from "@space/shared";
import { describe, expect, it } from "vitest";

import { createBuilderConfig } from "../electron-builder.config.mjs";
import { SIGNED_WINDOWS_ENV } from "@space/desktop-platform-windows/packaging/signedWindowsEnv";
import { ELECTRON_LANGUAGES, LPROJ_EXTENSION, MAC_ELECTRON_LANGUAGES, checkPackagedLocales } from "@space/desktop-platform/packaging/packaged-locales-lib";

// Electron's full locale set on Linux and Windows (55 .pak files, 8.5 MiB packed / 48 MiB installed on Windows).
const ELECTRON_LOCALE_PAKS = [
  "af", "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en-GB", "en-US", "es-419", "es", "et", "fa", "fi",
  "fil", "fr", "gu", "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt", "lv", "ml", "mr", "ms", "nb",
  "nl", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk", "ur",
  "vi", "zh-CN", "zh-TW",
].map((name) => `${name}.pak`);

// Electron 44's macOS locale folders (Contents/Resources/*.lproj).
const ELECTRON_LPROJS = [
  "af", "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "en_GB", "es", "es_419", "et", "fa", "fi",
  "fil", "fr", "gu", "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt", "lv", "ml", "mr", "ms", "nb",
  "nl", "pl", "pt_BR", "pt_PT", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk", "ur",
  "vi", "zh_CN", "zh_TW",
].map((name) => `${name}.lproj`);

const UI_CODES = CLIENT_UI_LANGUAGES.map((language) => language.code);

const primarySubtag = (language: string) => language.split(/[-_]/)[0]!.toLowerCase();

describe("packaged Electron locales", () => {
  it("ships exactly the languages the app UI supports, no more and no fewer", () => {
    expect(new Set(ELECTRON_LANGUAGES.map(primarySubtag))).toEqual(new Set(UI_CODES));
  });

  it("asks electron-builder to prune every other locale on every target", () => {
    for (const targetId of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
      const cfg = createBuilderConfig({ targetId, env: SIGNED_WINDOWS_ENV }) as unknown as { electronLanguages?: string[] };
      expect(cfg.electronLanguages).toEqual(ELECTRON_LANGUAGES);
    }
  });

  it("macOS: the same UI languages, under Electron's .lproj names", () => {
    expect(new Set(MAC_ELECTRON_LANGUAGES.map(primarySubtag))).toEqual(new Set(UI_CODES));
    expect(MAC_ELECTRON_LANGUAGES.every((language) => ELECTRON_LPROJS.includes(`${language}${LPROJ_EXTENSION}`))).toBe(true);
  });

  it("macOS: flags every other Electron .lproj and accepts en, fr, nl, de, es and es_419", () => {
    const result = checkPackagedLocales(ELECTRON_LPROJS, MAC_ELECTRON_LANGUAGES, LPROJ_EXTENSION);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toHaveLength(ELECTRON_LPROJS.length - 6);
    expect(result.unexpected).toContain("en_GB.lproj");
    for (const kept of ["es.lproj", "es_419.lproj"]) expect(result.unexpected).not.toContain(kept);
    expect(checkPackagedLocales(["fr.lproj", "nl.lproj", "de.lproj", "es.lproj", "es_419.lproj"], MAC_ELECTRON_LANGUAGES, LPROJ_EXTENSION).missing).toEqual(["en.lproj"]);
  });

  it("accepts a locales dir holding only the supported paks", () => {
    expect(checkPackagedLocales(["en-US.pak", "fr.pak", "nl.pak", "de.pak", "es.pak", "es-419.pak"])).toEqual({ unexpected: [], missing: [] });
  });

  it("flags an unused locale that slipped back into the package", () => {
    const result = checkPackagedLocales(ELECTRON_LOCALE_PAKS);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toHaveLength(ELECTRON_LOCALE_PAKS.length - 6);
    expect(result.unexpected).toContain("it.pak");
    expect(result.unexpected).toContain("en-GB.pak");
    for (const kept of ["fr.pak", "nl.pak", "de.pak", "es.pak", "es-419.pak"]) expect(result.unexpected).not.toContain(kept);
    expect(result.unexpected).not.toContain("en-US.pak");
  });

  it("flags a supported locale that was pruned by mistake, and a pruning that matched nothing", () => {
    expect(checkPackagedLocales(["en-US.pak", "fr.pak", "nl.pak", "es.pak", "es-419.pak"]).missing).toEqual(["de.pak"]);
    expect(checkPackagedLocales([]).missing).toEqual(["en-US.pak", "fr.pak", "nl.pak", "de.pak", "es.pak", "es-419.pak"]);
  });

  it("ignores files that are not locale paks", () => {
    expect(checkPackagedLocales(["en-US.pak", "fr.pak", "nl.pak", "de.pak", "es.pak", "es-419.pak", "README"])).toEqual({ unexpected: [], missing: [] });
  });
});
