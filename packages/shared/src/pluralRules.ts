/**
 * Plural forms where the engine has no `Intl.PluralRules`: Hermes, the phones' and TVs' JavaScript engine, ships
 * Collator, DateTimeFormat and NumberFormat only, so `new Intl.PluralRules(...)` throws there (a Parrot phone's
 * album Delete said nothing because of it). The client languages' own cardinal rules (CLDR) stand in.
 */

type Category = "one" | "many" | "other";

const base = (language: string) => language.toLowerCase().split(/[-_]/)[0] ?? "";

/** CLDR cardinal rules of the client languages (en, fr, nl, de, es); others say "one" for exactly 1 only. */
const cardinal = (language: string, n: number): Category => {
  const lang = base(language);
  const abs = Math.abs(n);
  const integer = Number.isInteger(abs);
  const millions = integer && abs !== 0 && abs % 1_000_000 === 0;
  if (lang === "fr") return Math.trunc(abs) <= 1 ? "one" : millions ? "many" : "other";
  if (lang === "es") return abs === 1 ? "one" : millions ? "many" : "other";
  return integer && abs === 1 ? "one" : "other";
};

const categories = (language: string): Category[] => (["fr", "es"].includes(base(language)) ? ["one", "many", "other"] : ["one", "other"]);

/** `n`'s cardinal plural category in `language`: the engine's when it has `Intl.PluralRules`, else the CLDR rule above. */
export const pluralCategory = (language: string, n: number): string =>
  typeof Intl.PluralRules === "function" ? new Intl.PluralRules(language).select(n) : cardinal(language, n);

/**
 * Gives an engine without `Intl.PluralRules` (Hermes) a small one built on the rules above, so i18next's `_one` /
 * `_many` / `_other` keys and any `new Intl.PluralRules` read right in every client language. Ordinals answer
 * "other". A no-op where the engine has its own. Returns whether it installed.
 */
export const installClientPluralRules = (): boolean => {
  if (typeof Intl.PluralRules === "function") return false;
  class ClientPluralRules {
    private readonly locale: string;
    private readonly type: "cardinal" | "ordinal";
    constructor(locales?: string | readonly string[], options?: { type?: "cardinal" | "ordinal" }) {
      this.locale = (Array.isArray(locales) ? locales[0] : (locales as string | undefined)) ?? "en";
      this.type = options?.type ?? "cardinal";
    }
    select(n: number): string {
      return this.type === "ordinal" ? "other" : cardinal(this.locale, n);
    }
    resolvedOptions() {
      return { locale: this.locale, type: this.type, pluralCategories: this.type === "ordinal" ? ["other"] : categories(this.locale) };
    }
    static supportedLocalesOf(locales: string | readonly string[]): string[] {
      return Array.isArray(locales) ? [...locales] : [locales as string];
    }
  }
  Object.defineProperty(Intl, "PluralRules", { value: ClientPluralRules, configurable: true, writable: true });
  return true;
};
