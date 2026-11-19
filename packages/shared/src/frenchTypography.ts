/**
 * French typography (UX-I18N-15, WEB-LANG-04, REL-UPD-06): a narrow no-break space (U+202F) before `: ; ? ! %` and
 * inside `« »`, so a line never breaks before the sign. The tests of the apps' French strings share this one pattern.
 * The ellipsis rule (UX-I18N-16) holds in every language: app copy writes "…" (U+2026), never three dots.
 */

/**
 * An ASCII or U+00A0 space before the sign or inside « », the sign glued to the word, number or placeholder before it,
 * or two U+202F in a row (a visibly wider gap).
 */
export const FRENCH_SPACING = /[ \u00a0][:;?!%]|«[ \u00a0]|[ \u00a0]»|[^\W\d_][:;?!](?= )|[\d}]%|\u202f\u202f/u;

/** `key.path: text` for each string in a (nested) strings object that breaks the rule; URLs are not checked. */
export const frenchTypographyProblems = (strings: unknown, prefix = ""): string[] => {
  if (typeof strings === "string") {
    return FRENCH_SPACING.test(strings.replace(/\w+:\/\/\S+/g, "")) ? [`${prefix}: ${strings}`] : [];
  }
  if (strings === null || typeof strings !== "object") return [];
  return Object.entries(strings).flatMap(([key, value]) => frenchTypographyProblems(value, prefix ? `${prefix}.${key}` : key));
};

/** Three ASCII dots in a row, where app copy should have the ellipsis character "…" (U+2026). */
export const THREE_DOTS = /\.\.\./;

/** `key.path: text` for each string in a (nested) strings object that writes three dots instead of "…"; URLs are not checked. */
export const ellipsisProblems = (strings: unknown, prefix = ""): string[] => {
  if (typeof strings === "string") {
    return THREE_DOTS.test(strings.replace(/\w+:\/\/\S+/g, "")) ? [`${prefix}: ${strings}`] : [];
  }
  if (strings === null || typeof strings !== "object") return [];
  return Object.entries(strings).flatMap(([key, value]) => ellipsisProblems(value, prefix ? `${prefix}.${key}` : key));
};
