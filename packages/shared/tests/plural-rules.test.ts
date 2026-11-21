/**
 * @req UX-I18N-01[badger-mobile,badger-tv]
 * @req PAR-LIB-03[parrot]
 * @bugfix Hermes (phones, TVs) has no `Intl.PluralRules`: a Parrot phone's album/artist Delete threw while wording its
 * question, and i18next fell back to "1 is one, the rest other" (French "0 titres"). The client rules stand in.
 * @covers packages/shared/src/pluralRules.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { installClientPluralRules, pluralCategory } from "../src/pluralRules";

const T = "[SHARED-PLURAL-RULES]";
const real = Intl.PluralRules;
const LANGUAGES = ["en", "fr", "nl", "de", "es", "fr-FR", "en-GB"];
const COUNTS = [0, 1, 1.5, 2, 13, 1_000_000, 2_000_000];
const setPluralRules = (value: unknown) => Object.defineProperty(Intl, "PluralRules", { value, configurable: true, writable: true });

afterEach(() => setPluralRules(real));

describe("client plural rules where the engine has no Intl.PluralRules (Hermes)", () => {
  it("UX-I18N-01: pluralCategory picks the engine's category for every client language", () => {
    const engine = LANGUAGES.map((language) => COUNTS.map((n) => new real(language).select(n)));
    setPluralRules(undefined);
    const fallback = LANGUAGES.map((language) => COUNTS.map((n) => pluralCategory(language, n)));
    console.info(T, "categories", JSON.stringify({ LANGUAGES, COUNTS, engine, fallback }));
    expect(fallback).toEqual(engine);
  });

  it("UX-I18N-01: installed, Intl.PluralRules answers like the engine's, categories included; a no-op where one exists", () => {
    expect(installClientPluralRules()).toBe(false);
    expect(Intl.PluralRules).toBe(real);
    setPluralRules(undefined);
    expect(installClientPluralRules()).toBe(true);
    for (const language of LANGUAGES) {
      const shim = new Intl.PluralRules(language);
      const engine = new real(language);
      console.info(T, "installed", language, JSON.stringify(shim.resolvedOptions().pluralCategories));
      expect(COUNTS.map((n) => shim.select(n))).toEqual(COUNTS.map((n) => engine.select(n)));
      expect([...shim.resolvedOptions().pluralCategories].sort()).toEqual([...engine.resolvedOptions().pluralCategories].sort());
    }
    expect(new Intl.PluralRules("en", { type: "ordinal" }).select(2)).toBe("other");
  });
});
