/**
 * The website pages whose views are counted (OPS-BIZ-06): a language-less key per public page and the sign-up page.
 * The website sends one of these keys; the API counts only these, so nothing else (an id, a full address) can be stored.
 * The legal pages keep their slug (WEB-LEGAL-01, `LEGAL_SLUGS` in `@space/legal`; a website test keeps both in step).
 * The key-storage guide counts as `key-storage` (its address is under `/docs/privacy/`).
 */
export const WEBSITE_VISIT_PAGES = [
  "home",
  "pricing",
  "badger",
  "parrot",
  "downloads",
  "downloads/kodi",
  "downloads/jellyfin",
  "start",
  "key-storage",
  "developers/api",
  "report",
  "support",
  "signup",
  "legal-notice",
  "privacy",
  "terms",
  "account-deletion",
  "security",
  "security-acknowledgments",
] as const;

export type WebsiteVisitPage = (typeof WEBSITE_VISIT_PAGES)[number];

export const isWebsiteVisitPage = (value: string): value is WebsiteVisitPage => (WEBSITE_VISIT_PAGES as readonly string[]).includes(value);
