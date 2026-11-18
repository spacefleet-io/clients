import { describe, expect, it } from "vitest";
import { LEGAL_CONTENT, LEGAL_LANGUAGES, LEGAL_SLUGS, legalItemText, type LegalContent, type LegalSlug } from "../src/index";

const SUITE = "security-policy-web";

const pageText = (content: LegalContent, slug: LegalSlug) => {
  const page = content.pages[slug];
  return [
    page.title,
    page.intro,
    ...page.sections.flatMap((s) => [s.heading, ...s.blocks.map((b) => (typeof b === "string" ? b : b.items.map(legalItemText).join("\n")))]),
  ].join("\n");
};

describe(`[${SUITE}] the security policy pages on spacefleet.io`, () => {
  // @req REL-SEC-01[web]
  it("the policy and acknowledgments pages exist, in English and French", () => {
    expect(LEGAL_SLUGS).toContain("security");
    expect(LEGAL_SLUGS).toContain("security-acknowledgments");
    const en = pageText(LEGAL_CONTENT.en, "security");
    const fr = pageText(LEGAL_CONTENT.fr, "security");
    console.info(`[${SUITE}] policy en:\n${en}`);
    for (const fact of ["security@spacefleet.io", "within 3 working days", "pays no bug bounty", "by name", "without your name, or not at all", "What to report"]) {
      expect(en).toContain(fact);
    }
    for (const fact of ["security@spacefleet.io", "sous 3 jours ouvrés", "ne verse aucune prime aux bogues", "nommément", "sans votre nom, ou pas du tout"]) {
      expect(fr).toContain(fact);
    }
    for (const lang of LEGAL_LANGUAGES) {
      expect(pageText(LEGAL_CONTENT[lang], "security")).toContain("(page:security-acknowledgments)");
      expect(pageText(LEGAL_CONTENT[lang], "security-acknowledgments")).toContain("(page:security)");
    }
  });
});
