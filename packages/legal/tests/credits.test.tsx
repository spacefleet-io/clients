import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { LEGAL_CONTENT, LEGAL_LANGUAGES, LEGAL_SLUGS } from "../src/index";
import { creditsFor, fontsCreditFor, openSourceFor } from "../src/credits";
import { LegalCreditsSection, LegalPage } from "../src/components";

const render = (path: string, element: React.ReactElement) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:lang/*" element={element} />
      </Routes>
    </MemoryRouter>,
  );

const credits = (lang: (typeof LEGAL_LANGUAGES)[number]) => (
  <LegalCreditsSection lang={lang}>
    <p data-testid="site-sources">site sources</p>
  </LegalCreditsSection>
);

describe("third-party data credits (WEB-LEGAL-17)", () => {
  // @req WEB-LEGAL-17[web]
  it("holds only the words around the credits, in every language, with the line shown before the app was ever online", () => {
    for (const lang of LEGAL_LANGUAGES) {
      const labels = creditsFor(lang);
      console.info(`[legal:credits] ${lang}: unavailable "${labels.unavailable}"`);
      expect(Object.keys(labels).sort()).toEqual(["about", "heading", "intro", "unavailable"]);
      for (const value of Object.values(labels)) expect(value.trim(), lang).not.toBe("");
      expect(Object.keys(LEGAL_CONTENT[lang].credits).sort(), lang).toEqual(["about", "heading", "intro", "openSource", "unavailable"]);
    }
    expect(creditsFor("en").unavailable).toBe("The data credits show here once the app has been online.");
    expect(creditsFor("en-GB").heading).toBe(LEGAL_CONTENT.en.credits.heading);
    expect(creditsFor("ja").heading).toBe(LEGAL_CONTENT.en.credits.heading);
  });

  // @req WEB-LEGAL-17[web]: legal.web-apps.test.tsx checks that the website passes `credits`.
  it("the legal notice shows the credits the website renders; no other page and not without `credits`", () => {
    for (const lang of LEGAL_LANGUAGES) {
      const html = render(`/${lang}/legal-notice`, <LegalPage slug="legal-notice" credits={credits} />);
      expect(html).toContain('data-testid="legal-credits"');
      expect(html).toContain(LEGAL_CONTENT[lang].credits.heading);
      expect(html).toContain('data-testid="site-sources"');
      expect(html).toContain('data-testid="legal-flags-credit"');
    }
    for (const slug of LEGAL_SLUGS.filter((slug) => slug !== "legal-notice")) {
      expect(render(`/en/${slug}`, <LegalPage slug={slug} credits={credits} />)).not.toContain("legal-credits");
    }
    expect(render("/en/legal-notice", <LegalPage slug="legal-notice" />)).not.toContain("legal-credits");
  });

  // @req UX-SET-03
  it("credits the bundled Inter and Space Grotesk fonts under the OFL, in the apps' notice and the legal notice", () => {
    expect(openSourceFor("en", "badger").fonts).toBe("Fonts: Inter and Space Grotesk, under the SIL Open Font License 1.1.");
    expect(fontsCreditFor("fr")).toBe("Polices : Inter et Space Grotesk, sous licence SIL Open Font License 1.1.");
    for (const lang of LEGAL_LANGUAGES) {
      const fonts = openSourceFor(lang, "parrot").fonts;
      console.info(`[legal:credits] fonts ${lang}: ${fonts}`);
      expect(fonts, lang).toMatch(/Inter.*Space Grotesk.*SIL Open Font License 1\.1/);
      const html = render(`/${lang}/legal-notice`, <LegalPage slug="legal-notice" credits={credits} />);
      expect(html).toContain(`data-testid="legal-fonts-credit">${fonts}</p>`);
    }
  });
});
