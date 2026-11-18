import de from "./locales/de.json";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import nl from "./locales/nl.json";
import es from "./locales/es.json";
import { accountDeletionPath, type AccountDeletionApp } from "@space/shared/accountDeletionLabels";
import { PUBLISHER_POSTAL_ADDRESS, withPublisherPostalAddress } from "./publisher";

/**
 * The legal pages (WEB-LEGAL-01), served by the website on spacefleet.io.
 */
export const LEGAL_SLUGS = [
  "legal-notice",
  "privacy",
  "terms",
  "account-deletion",
  "security",
  "security-acknowledgments",
] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/** The pages the footer links to; the acknowledgments page is reached from the security policy (REL-SEC-01). */
export const LEGAL_FOOTER_SLUGS = LEGAL_SLUGS.filter((slug) => slug !== "security-acknowledgments");

/** The website's legal languages (WEB-LEGAL-13); every version says the French one prevails. */
export const LEGAL_LANGUAGES = ["en", "fr", "nl", "de", "es"] as const;
export type LegalLanguage = (typeof LEGAL_LANGUAGES)[number];

/**
 * A paragraph, or a bulleted list. Text may hold `[label](page:<slug>)` links to another legal page. A list item the
 * apps link to carries an `id`, rendered as its anchor (the privacy policy's `error-reports`, REL-LOG-06).
 */
export type LegalListItem = string | { id: string; text: string };
export type LegalBlock = string | { items: LegalListItem[] };
export const legalItemText = (item: LegalListItem): string => (typeof item === "string" ? item : item.text);
export type LegalSection = { heading: string; blocks: LegalBlock[] };
export type LegalPageContent = { title: string; intro: string; sections: LegalSection[] };
/**
 * The consent shown before paying and at sign-up (WEB-LEGAL-18): the two boxes a checkout needs (the terms, and the
 * express request to start at once, Code de la consommation art. L221-25), what to say when they are not ticked, and the
 * sign-up line. Text may hold `[label](page:<slug>)` links. ACCT-NEWS-01: `newsBox` is the sign-up's unticked "send me
 * SpaceFleet news" box; `news` / `newsHint` name the on/off switch in account settings. Every client with a sign-up or
 * an account settings page reads these, through `newsOptInText`.
 */
export type LegalConsent = {
  heading: string;
  terms: string;
  startNow: string;
  required: string;
  signup: string;
  newsBox: string;
  news: string;
  newsHint: string;
};
export type LegalContent = {
  nav: { label: string } & Record<LegalSlug, string>;
  updated: string;
  /** The words around the data credits (UX-SET-02, WEB-LEGAL-17); read through `@space/legal/credits`. The credited
   * sources come from the metadata service in the apps and from the server/site-only list on the website
   * (META-SRC-09). `openSource` is the line that opens each app's credits place (UX-SET-03), with `{app}` for the
   * app's name. */
  credits: {
    about: string;
    heading: string;
    intro: string;
    unavailable: string;
    openSource: { notice: string; link: string; flags: string; fonts: string };
  };
  consent: LegalConsent;
  pages: Record<LegalSlug, LegalPageContent>;
};

const LOCALES: Record<LegalLanguage, LegalContent> = { en, fr, nl, de, es };

/**
 * The texts of `language` with their placeholders filled.
 * - WEB-LEGAL-04: the account deletion page names each app's labels from `@space/shared/accountDeletionLabels`, the
 *   strings the apps themselves show, so the page can't drift from the apps. The text holds `{{accountDeletionPath.<app>}}`.
 * - WEB-LEGAL-02, WEB-LEGAL-03, WEB-LEGAL-05: the legal notice's and the privacy policy's publisher address, the terms'
 *   postal withdrawal route and the model form's address come from `PUBLISHER_POSTAL_ADDRESS` (`./publisher`), and are
 *   left out while it is null (a list item that held only the address goes too). `postalAddress` exists for the tests.
 */
export const legalContentFor = (
  language: LegalLanguage,
  postalAddress: string | null = PUBLISHER_POSTAL_ADDRESS,
): LegalContent => {
  const json = JSON.stringify(LOCALES[language]).replace(
    /\{\{accountDeletionPath\.(mobile|desktop|web)\}\}/g,
    (_, app: AccountDeletionApp) => accountDeletionPath(app, language),
  );
  // The address goes into JSON text, so it is escaped as a JSON string body.
  const address = postalAddress === null ? null : JSON.stringify(postalAddress).slice(1, -1);
  return JSON.parse(withPublisherPostalAddress(json, address), (_, value: unknown) =>
    Array.isArray(value) ? value.filter((item) => item !== "") : value,
  ) as LegalContent;
};

export const LEGAL_CONTENT: Record<LegalLanguage, LegalContent> = {
  en: legalContentFor("en"),
  fr: legalContentFor("fr"),
  nl: legalContentFor("nl"),
  de: legalContentFor("de"),
  es: legalContentFor("es"),
};

/** The legal language for a route or UI language, English otherwise. */
export const resolveLegalLanguage = (value: string | undefined): LegalLanguage =>
  LEGAL_LANGUAGES.find((lang) => lang === value?.split("-")[0]) ?? "en";

/** ACCT-NEWS-01: the News box and switch wording in the language of `value` (a UI or account language), English otherwise. */
export const newsOptInText = (value: string | undefined): Pick<LegalConsent, "newsBox" | "news" | "newsHint"> => {
  const { newsBox, news, newsHint } = LEGAL_CONTENT[resolveLegalLanguage(value)].consent;
  return { newsBox, news, newsHint };
};

export const isLegalSlug = (value: string): value is LegalSlug => (LEGAL_SLUGS as readonly string[]).includes(value);

export const legalPath = (lang: LegalLanguage, slug: LegalSlug): string => `/${lang}/${slug}`;

export type LegalInline =
  | { kind: "text"; text: string }
  | { kind: "page"; text: string; slug: LegalSlug }
  | { kind: "url"; text: string; href: string };

const INLINE_PATTERN = /\[([^\]]+)\]\(page:([a-z-]+)\)|https?:\/\/[^\s)]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Splits a text block into plain text, links to other legal pages, web addresses and email addresses. */
export const parseLegalInline = (text: string): LegalInline[] => {
  const parts: LegalInline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    let raw = match[0];
    const start = match.index;
    if (match[1] !== undefined) {
      const slug = match[2];
      if (!isLegalSlug(slug)) throw new Error(`unknown legal page link: ${slug}`);
      if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });
      parts.push({ kind: "page", text: match[1], slug });
      last = start + raw.length;
      continue;
    }
    raw = raw.replace(/[.,;:]+$/, "");
    if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });
    parts.push({ kind: "url", text: raw, href: raw.includes("@") && !raw.startsWith("http") ? `mailto:${raw}` : raw });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
};
