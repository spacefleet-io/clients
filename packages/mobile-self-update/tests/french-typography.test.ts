/**
 * @test-id MOBILE-SELF-UPDATE-FR-TYPO-001
 * @level unit
 * @req REL-UPD-06
 * @why Main 2026-11-18 (gallery review): the self-update's French texts follow the site's rule (WEB-LANG-04), a narrow
 *   no-break space (U+202F) before `: ; ? ! %` and inside `« »`, so Android never breaks the line before the sign.
 */
import { frenchTypographyProblems } from "@space/shared/frenchTypography";
import { describe, expect, it } from "vitest";
import { selfUpdateStrings } from "../src/strings";

describe("French typography @req REL-UPD-06", () => {
  it("every French self-update text uses U+202F before : ; ? ! % and inside « »", () => {
    const problems = frenchTypographyProblems(selfUpdateStrings.fr);
    expect(problems).toEqual([]);
  });
});
