/**
 * @req UX-I18N-15[badger-desktop]
 *
 * App French copy puts a narrow no-break space (U+202F) before `: ; ? ! %` and inside `« »` (Main 2026-11-19, PR #2988
 * review). The shared pattern every app test uses, run on the shared subtitle copy and on Badger desktop's strings.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FRENCH_SPACING, frenchTypographyProblems } from "../src/frenchTypography";
import subtitleFetchCopyFr from "../src/subtitleFetchCopy/fr.json";
import { profilesTexts } from "../src/profileTexts";
import { titleLanguageTexts } from "../src/titleLanguage";

const desktopFr: unknown = JSON.parse(
  readFileSync(new URL("../../../apps/badger/desktop/src/renderer/src/i18n/fr.json", import.meta.url), "utf8"),
);

describe("French typography (UX-I18N-15)", () => {
  it("flags a plain or U+00A0 space, a glued sign and a doubled U+202F", () => {
    for (const bad of ["Mettre à jour ?", "ici : la", "ici\u00a0: la", "« source »", "{percent} %", "{percent}%", "ici: la", "ici\u202f\u202f: la"]) {
      expect(FRENCH_SPACING.test(bad), bad).toBe(true);
    }
    for (const good of ["Mettre à jour\u202f?", "ici\u202f: la", "«\u202fsource\u202f»", "{percent}\u202f%", "https://spacefleet.io"]) {
      expect(FRENCH_SPACING.test(good), good).toBe(false);
    }
  });

  it("skips URLs and names the key path of each problem", () => {
    expect(frenchTypographyProblems({ link: "Voir https://spacefleet.io/aide?x=1" })).toEqual([]);
    expect(frenchTypographyProblems({ menu: { title: "Sous-titres :" } })).toEqual(["menu.title: Sous-titres :"]);
  });

  it("the shared subtitle copy follows it", () => {
    expect(frenchTypographyProblems(subtitleFetchCopyFr)).toEqual([]);
  });

  it("the shared profile screens and the title question follow it", () => {
    expect(frenchTypographyProblems(profilesTexts.fr)).toEqual([]);
    expect(frenchTypographyProblems(titleLanguageTexts.fr)).toEqual([]);
  });

  it("Badger desktop's French strings follow it", () => {
    expect(frenchTypographyProblems(desktopFr)).toEqual([]);
  });
});
