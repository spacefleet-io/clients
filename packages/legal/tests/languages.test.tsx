import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  LEGAL_CONTENT,
  LEGAL_LANGUAGES,
  LEGAL_SLUGS,
  parseLegalInline,
  resolveLegalLanguage,
  type LegalLanguage,
} from "../src/index";
import { LegalLinks, LegalPage } from "../src/components";

/** Every string leaf of a value, keyed by its path (array indexes included), so two versions line up block by block. */
const leaves = (value: unknown, path = ""): Map<string, string> => {
  const out = new Map<string, string>();
  if (typeof value === "string") out.set(path, value);
  else if (Array.isArray(value)) value.forEach((item, i) => leaves(item, `${path}[${i}]`).forEach((v, k) => out.set(k, v)));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) leaves(item, path ? `${path}.${key}` : key).forEach((v, k) => out.set(k, v));
  return out;
};

/** What a translation must carry over untouched: links to other pages, web and email addresses, and every number. */
const placeholders = (text: string) => ({
  pages: parseLegalInline(text).flatMap((part) => (part.kind === "page" ? [part.slug] : [])),
  urls: parseLegalInline(text).flatMap((part) => (part.kind === "url" ? [part.href] : [])),
  numbers: (text.match(/\d+/g) ?? []).sort(),
});

const PREVAILS: Record<LegalLanguage, string> = {
  en: "If the language versions of this page differ, the French version prevails.",
  fr: "En cas de divergence entre les versions linguistiques de cette page, la version française prévaut.",
  nl: "Als de taalversies van deze pagina van elkaar verschillen, heeft de Franse versie voorrang.",
  de: "Weichen die Sprachfassungen dieser Seite voneinander ab, ist die französische Fassung maßgeblich.",
  es: "Si las versiones lingüísticas de esta página difieren, prevalece la versión francesa.",
};

const render = (path: string, element: React.ReactElement) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:lang/*" element={element} />
      </Routes>
    </MemoryRouter>,
  );

describe("Dutch, German and Spanish legal pages (WEB-LEGAL-13)", () => {
  // @req WEB-LEGAL-13[web]
  it("the website serves the legal pages in English, French, Dutch, German and Spanish", () => {
    console.info(`[legal:languages] LEGAL_LANGUAGES=${LEGAL_LANGUAGES.join(",")}`);
    expect([...LEGAL_LANGUAGES]).toEqual(["en", "fr", "nl", "de", "es"]);
    for (const lang of LEGAL_LANGUAGES) expect(Object.keys(LEGAL_CONTENT[lang].pages).sort()).toEqual([...LEGAL_SLUGS].sort());
  });

  // @req WEB-LEGAL-13[web]
  it("nl, de and es have exactly the English keys, block for block", () => {
    const en = [...leaves(LEGAL_CONTENT.en).keys()];
    for (const lang of ["nl", "de", "es"] as const) {
      const keys = [...leaves(LEGAL_CONTENT[lang]).keys()];
      const missing = en.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !en.includes(key));
      console.info(`[legal:languages] ${lang}: ${keys.length} strings (en ${en.length}), missing ${missing.length}, extra ${extra.length}`);
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      const empty = [...leaves(LEGAL_CONTENT[lang])].filter(([, text]) => !text.trim()).map(([key]) => key);
      expect(empty, `${lang} has empty strings`).toEqual([]);
    }
  });

  // @req WEB-LEGAL-13[web]
  it("nl, de and es keep every page link, address and number of the French text, which prevails", () => {
    const fr = leaves(LEGAL_CONTENT.fr);
    for (const lang of ["nl", "de", "es"] as const) {
      const mismatches: string[] = [];
      for (const [key, text] of leaves(LEGAL_CONTENT[lang])) {
        const want = placeholders(fr.get(key)!);
        const got = placeholders(text);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push(`${key}\n    fr ${JSON.stringify(want)}\n    ${lang} ${JSON.stringify(got)}`);
        }
      }
      console.info(`[legal:languages] ${lang}: placeholder mismatches vs fr: ${mismatches.length}`);
      if (mismatches.length) console.info(mismatches.join("\n"));
      expect(mismatches).toEqual([]);
      // Untranslated copies would pass the checks above: no string may equal the English or French one unless it is a name or address.
      const en = leaves(LEGAL_CONTENT.en);
      const copied = [...leaves(LEGAL_CONTENT[lang])]
        .filter(([key, text]) => text.split(" ").length > 4 && (text === en.get(key) || text === fr.get(key)))
        .filter(([, text]) => !/Gunzenhausen|^Chris-Alexandre/.test(text))
        .map(([key]) => key);
      expect(copied, `${lang} strings copied from en/fr`).toEqual([]);
    }
  });

  // @req WEB-LEGAL-13[web]
  it("every language version says the French version prevails", () => {
    for (const lang of LEGAL_LANGUAGES) {
      console.info(`[legal:languages] ${lang} updated: ${LEGAL_CONTENT[lang].updated}`);
      expect(LEGAL_CONTENT[lang].updated).toContain(PREVAILS[lang]);
      expect(LEGAL_CONTENT[lang].updated).toMatch(/2026/);
    }
  });

  // @req WEB-LEGAL-13[web]
  it("LegalPage renders /nl/<slug>, /de/<slug> and /es/<slug> in that language, with the precedence line and same-language links", () => {
    for (const lang of ["nl", "de", "es"] as const) {
      for (const slug of LEGAL_SLUGS) {
        const html = render(`/${lang}/${slug}`, <LegalPage slug={slug} />);
        const content = LEGAL_CONTENT[lang];
        expect(html).toContain(`data-testid="legal-${slug}"`);
        expect(html).toContain(content.pages[slug].title.replace(/'/g, "&#x27;"));
        expect(html).toContain(PREVAILS[lang]);
        for (const section of content.pages[slug].sections) expect(html).toContain(section.heading.replace(/'/g, "&#x27;"));
        const links = parseLegalInline(JSON.stringify(content.pages[slug])).flatMap((p) => (p.kind === "page" ? [p.slug] : []));
        for (const other of links) expect(html).toContain(`href="/${lang}/${other}"`);
        expect(html).not.toContain("page:");
        console.info(`[legal:languages] rendered /${lang}/${slug}: ${html.length} chars, ${links.length} page links`);
      }
    }
    const nlFooter = renderToStaticMarkup(<LegalLinks language="nl-BE" />);
    const deFooter = renderToStaticMarkup(<LegalLinks language="de" />);
    const esFooter = renderToStaticMarkup(<LegalLinks language="es-ES" />);
    for (const [lang, html] of [["nl", nlFooter], ["de", deFooter], ["es", esFooter]] as const) {
      expect(html).toContain(`href="/${lang}/privacy"`);
      expect(html).toContain(`>${LEGAL_CONTENT[lang].nav.privacy}</a>`);
    }
  });

  // @req WEB-LEGAL-13[web]
  it("resolves a regional tag to its legal language and any other language to English", () => {
    expect(resolveLegalLanguage("fr-CA")).toBe("fr");
    expect(resolveLegalLanguage("nl")).toBe("nl");
    expect(resolveLegalLanguage("it")).toBe("en");
    expect(resolveLegalLanguage(undefined)).toBe("en");
    const html = render("/it/privacy", <LegalPage slug="privacy" />);
    expect(html).toContain(LEGAL_CONTENT.en.pages.privacy.title);
  });
});
