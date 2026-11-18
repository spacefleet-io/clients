/**
 * @test-id MOBILE-ACTION-LABEL-TEXT-001
 * @level unit
 * @why Pixel 8 hand try 2026-11-12: in the film page's 5-action row, Android cut "Bande-annonce" mid-word
 *   ("Bande-anno" / "nce"), because it never breaks a hyphenated word at its hyphen while hyphenation is off.
 */
// @req UX-PHONE-04[badger-mobile]
import { describe, expect, it } from "vitest";
import { actionLabelText } from "../src/lib/phoneDetails";

describe("phone action label text", () => {
  it("@req UX-PHONE-04 lets a label break after each hyphen inside a word, and leaves other labels alone", () => {
    expect(actionLabelText("Bande-annonce")).toBe("Bande-\u200Bannonce");
    expect(actionLabelText("Chercher des sous-titres")).toBe("Chercher des sous-\u200Btitres");
    expect(actionLabelText("Lire sur la TV")).toBe("Lire sur la TV");
    expect(actionLabelText("Get subtitles · offline -")).toBe("Get subtitles · offline -");
  });
});
