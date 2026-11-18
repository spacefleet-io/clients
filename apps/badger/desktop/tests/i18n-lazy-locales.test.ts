import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as I18nModuleNs from "../src/renderer/src/i18n";

// Issue #25: each locale is a lazy chunk. Startup loads only the active locale,
// a language switch loads the other one (en, fr, nl, de; key parity is in
// i18n-four-locales.test.ts), and an FR user gets FR strings the
// moment initI18n resolves (main.tsx renders only after that).

const localeLoads = vi.hoisted(() => [] as string[]);

type I18nModule = typeof I18nModuleNs;

const loadI18nModule = async (): Promise<I18nModule> => {
  vi.resetModules();
  // doMock (not hoisted vi.mock) so each fresh module graph re-runs the factory
  // and a locale import is counted every time it really happens.
  for (const locale of ["en", "fr", "nl", "de", "es"] as const) {
    vi.doMock(`../src/renderer/src/i18n/${locale}.json`, async (importOriginal) => {
      localeLoads.push(locale);
      console.info(`[i18n-lazy-locales:loader] ${locale}.json loaded (loads=${JSON.stringify(localeLoads)})`);
      return importOriginal();
    });
  }
  return import("../src/renderer/src/i18n");
};

const dumpI18nState = (label: string, mod: I18nModule) => {
  const i18n = mod.default;
  console.error(`=== [i18n-lazy-locales:${label}] snapshot ===`);
  console.error(`language=${i18n.language} resolvedLanguage=${i18n.resolvedLanguage}`);
  console.error(
    `bundles en=${i18n.hasResourceBundle("en", "translation")} fr=${i18n.hasResourceBundle("fr", "translation")}`,
  );
  console.error(`loads=${JSON.stringify(localeLoads)}`);
  console.error(`t(nav.dashboard)=${JSON.stringify(i18n.t("nav.dashboard"))}`);
};

describe("renderer i18n lazy locales", () => {
  beforeEach(() => {
    localeLoads.length = 0;
    console.info("[i18n-lazy-locales:setup] reset locale load log");
  });

  it("loads only the active locale at startup", async () => {
    const mod = await loadI18nModule();
    console.info("[i18n-lazy-locales:startup-en] initI18n(en)");
    await mod.initI18n("en");
    const ok = localeLoads.join(",") === "en" && !mod.default.hasResourceBundle("fr", "translation");
    if (!ok) dumpI18nState("startup-en", mod);
    expect(localeLoads).toEqual(["en"]);
    expect(mod.default.hasResourceBundle("fr", "translation")).toBe(false);
    expect(mod.default.t("nav.dashboard")).toBe("Home");
  });

  it("loads the other locale only when the user switches to it", async () => {
    const mod = await loadI18nModule();
    await mod.initI18n("en");
    console.info(`[i18n-lazy-locales:switch] after init loads=${JSON.stringify(localeLoads)}; switching to fr`);
    await mod.setUiLanguage("fr");
    if (mod.default.resolvedLanguage !== "fr") dumpI18nState("switch-fr", mod);
    expect(localeLoads).toEqual(["en", "fr"]);
    expect(mod.default.resolvedLanguage).toBe("fr");
    expect(mod.default.t("nav.dashboard")).toBe("Accueil");

    console.info("[i18n-lazy-locales:switch] switching back to en; no new load expected");
    await mod.setUiLanguage("en");
    if (localeLoads.length !== 2) dumpI18nState("switch-back-en", mod);
    expect(localeLoads).toEqual(["en", "fr"]);
    expect(mod.default.t("nav.dashboard")).toBe("Home");
  });

  it("gives an FR user FR strings on first paint without loading EN", async () => {
    const mod = await loadI18nModule();
    console.info("[i18n-lazy-locales:startup-fr] initI18n(fr)");
    await mod.initI18n("fr");
    // main.tsx renders right after initI18n resolves: these are first-paint strings.
    const firstPaint = mod.default.t("nav.dashboard");
    if (firstPaint !== "Accueil" || localeLoads.join(",") !== "fr") dumpI18nState("startup-fr", mod);
    expect(mod.default.resolvedLanguage).toBe("fr");
    expect(firstPaint).toBe("Accueil");
    expect(localeLoads).toEqual(["fr"]);
    expect(mod.default.hasResourceBundle("en", "translation")).toBe(false);
  });

  it("gives a German user German strings on first paint, loading only de", async () => {
    const mod = await loadI18nModule();
    console.info("[i18n-lazy-locales:startup-de] initI18n(de)");
    await mod.initI18n("de");
    const firstPaint = mod.default.t("nav.dashboard");
    if (mod.default.resolvedLanguage !== "de" || localeLoads.join(",") !== "de") dumpI18nState("startup-de", mod);
    expect(mod.default.resolvedLanguage).toBe("de");
    expect(firstPaint).not.toBe("Home");
    expect(localeLoads).toEqual(["de"]);
  });

  it("falls back to EN for an unknown stored language", async () => {
    const mod = await loadI18nModule();
    await mod.initI18n("ja");
    if (mod.default.resolvedLanguage !== "en") dumpI18nState("unknown-language", mod);
    expect(localeLoads).toEqual(["en"]);
    expect(mod.default.resolvedLanguage).toBe("en");
  });

  it("lets the last requested language win when switches overlap", async () => {
    const mod = await loadI18nModule();
    await mod.initI18n("en");
    console.info("[i18n-lazy-locales:overlap] fr switch then immediate en switch");
    const toFr = mod.setUiLanguage("fr");
    const toEn = mod.setUiLanguage("en");
    await Promise.all([toFr, toEn]);
    if (mod.default.resolvedLanguage !== "en") dumpI18nState("overlap", mod);
    expect(mod.default.resolvedLanguage).toBe("en");
  });
});
