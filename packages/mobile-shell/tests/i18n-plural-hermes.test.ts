/**
 * @req UX-I18N-01[mobile]
 * @bugfix Hermes (phones, TVs) has no `Intl.PluralRules`, so i18next fell back to "1 is one, the rest other": French
 * said « 0 saisons ». `initI18n` now gives the engine the client languages' rules first.
 * @covers packages/mobile-shell/src/i18n/index.ts
 */
import { afterAll, describe, expect, it } from "vitest";
import i18n from "i18next";
import { initI18n } from "../src/i18n";

const T = "[MOBILE-I18N-PLURAL-HERMES]";
const real = Intl.PluralRules;

afterAll(() => Object.defineProperty(Intl, "PluralRules", { value: real, configurable: true, writable: true }));

describe("phone texts on an engine without Intl.PluralRules (Hermes)", () => {
  it("UX-I18N-01: French counts read « 0 saison », « 1 saison », « 2 saisons »; English « 0 seasons »", async () => {
    Object.defineProperty(Intl, "PluralRules", { value: undefined, configurable: true, writable: true });
    await initI18n("fr");
    const fr = [0, 1, 2].map((count) => i18n.t("details.runtime.seasons", { count }));
    console.info(T, "fr", JSON.stringify(fr), "PluralRules installed:", typeof Intl.PluralRules);
    expect(fr).toEqual(["0 saison", "1 saison", "2 saisons"]);
    await i18n.changeLanguage("en");
    const en = [0, 1, 2].map((count) => i18n.t("details.runtime.seasons", { count }));
    console.info(T, "en", JSON.stringify(en));
    expect(en).toEqual(["0 seasons", "1 season", "2 seasons"]);
  });
});
