/**
 * @test-id PARROT-DESKTOP-FR-TYPO-001
 * @level unit
 * @req UX-I18N-15[parrot]
 * @why Main 2026-11-24 (chat): Parrot desktop follows UX-I18N-15 as Badger desktop does: a narrow no-break space
 *   (U+202F) before `: ; ? ! %` and inside `« »`, so a line never breaks before the sign. This covers Parrot's own
 *   strings and the shared Parrot shell strings (`@space/parrot-core/shell-strings`) it spreads into them.
 */
import { frenchTypographyProblems } from "@space/shared/frenchTypography";
import { describe, expect, it } from "vitest";
import { PARROT_STRINGS } from "../src/renderer/src/i18n";

const SUITE = "parrot-french-typography";

describe("French typography @req UX-I18N-15[parrot]", () => {
  it("every French Parrot desktop text uses U+202F before : ; ? ! % and inside « »", () => {
    const problems = frenchTypographyProblems(PARROT_STRINGS.fr);
    console.info(`[${SUITE}:fr] problems=${problems.length}`);
    expect(problems).toEqual([]);
  });
});
