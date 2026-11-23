/**
 * @test-id MOBILE-SELF-UPDATE-FR-TYPO-001
 * @level unit
 * @req REL-UPD-06
 * @why Main 2026-11-18 (gallery review): the self-update's French texts follow the site's rule (WEB-LANG-04), a narrow
 *   no-break space (U+202F) before `: ; ? ! %` and inside `« »`, so Android never breaks the line before the sign.
 */
import { describe, expect, it } from "vitest";
import { selfUpdateStrings } from "../src/strings";

/**
 * The website's pattern for WEB-LANG-04, plus `%`: an ASCII or U+00A0 space before the sign or inside « », or the
 * sign glued to the word, number or placeholder before it.
 */
const FR_SPACING = /[ \u00a0][:;?!%]|«[ \u00a0]|[ \u00a0]»|[^\W\d_][:;?!](?= )|[\d}]%/u;

describe("French typography @req REL-UPD-06", () => {
  it("every French self-update text uses U+202F before : ; ? ! % and inside « »", () => {
    const problems = Object.entries(selfUpdateStrings.fr)
      .filter(([, text]) => FR_SPACING.test(text.replace(/\w+:\/\/\S+/g, "")))
      .map(([key, text]) => `${key}: ${text}`);
    expect(problems).toEqual([]);
  });

  it("flags a plain space and a glued sign", () => {
    for (const bad of ["Mettre à jour ?", "ici : la", "« source »", "{percent} %", "{percent}%", "ici: la"]) expect(FR_SPACING.test(bad), bad).toBe(true);
    for (const good of ["Mettre à jour\u202f?", "ici\u202f: la", "«\u202fsource\u202f»", "{percent}\u202f%"]) expect(FR_SPACING.test(good), good).toBe(false);
  });
});
