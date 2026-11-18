/**
 * The product and brand names (UX-I18N-13): written the same in every language and never translated, by us or by a
 * browser or mail client that translates the page. The web marks each occurrence `translate="no"` (`@space/ui/brand-names`)
 * and the HTML emails do the same (`markBrandNamesInHtml` in `@space/email-templates/brand`).
 */
export const BRAND_NAMES = ["SpaceFleet", "SpaceBadger", "SpaceParrot", "Badger", "Parrot"] as const;

export type BrandName = (typeof BRAND_NAMES)[number];

// Longest first so "SpaceBadger" is one name, not "Space" + "Badger"; the all-caps forms are the email header's
// "SPACEFLEET" and similar display text. Case-sensitive: "spacefleet.io" or "/badger" in a URL are not names.
const NAMES_PATTERN = [...BRAND_NAMES, ...BRAND_NAMES.map((name) => name.toUpperCase())]
  .sort((a, b) => b.length - a.length)
  .join("|");

/** A fresh global regex matching each brand name as a whole word ("Badger-Maskottchen" matches "Badger"). */
export const brandNamePattern = (): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${NAMES_PATTERN})(?![\\p{L}\\p{N}_])`, "gu");

/** True when `text` holds at least one brand name. */
export const hasBrandName = (text: string): boolean => brandNamePattern().test(text);

/** One piece of a text split around its brand names. */
export type BrandTextPart = { text: string; brand: boolean };

/** `"Get Badger now"` → `[{text: "Get ", brand: false}, {text: "Badger", brand: true}, {text: " now", brand: false}]`. */
export const splitBrandNames = (text: string): BrandTextPart[] => {
  const parts: BrandTextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(brandNamePattern())) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), brand: false });
    parts.push({ text: match[0], brand: true });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), brand: false });
  return parts;
};
