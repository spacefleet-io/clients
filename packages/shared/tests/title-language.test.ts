// @req ACCT-PROF-03
import { describe, expect, it } from "vitest";
import { mergeProfileSettings, parseProfileSettings, serializeProfileSettings } from "../src/profileSettings";
import {
  isLatinOriginal,
  isLatinScriptText,
  needsTitleFallback,
  needsTitleLanguageQuestion,
  originalSetLanguage,
  parseTitleVariants,
  profileTitleLanguage,
  serializeTitleVariants,
  shownTitleArt,
  TITLE_LANGUAGE_ASKED_SINCE,
  titleLanguageTexts,
  titleVariantsKey,
  withTitleLanguageTexts,
} from "../src/titleLanguage";

describe("script detection", () => {
  it("reads every letter, ignoring digits and punctuation", () => {
    expect(isLatinScriptText("La Haine")).toBe(true);
    expect(isLatinScriptText("Amélie: Le Fabuleux Destin d'Amélie Poulain (2001)")).toBe(true);
    expect(isLatinScriptText("Ödön: Łódź, Ñandú")).toBe(true);
    expect(isLatinScriptText("ドラゴンボールZ 神と神")).toBe(false);
    expect(isLatinScriptText("Брат 2")).toBe(false);
    expect(isLatinScriptText("Ζορμπάς")).toBe(false);
    expect(isLatinScriptText("기생충")).toBe(false);
    expect(isLatinScriptText("Dragon Ball Z 神と神")).toBe(false);
    expect(isLatinScriptText("1917")).toBe(true);
  });

  it("decides by the original title's letters, the language code only without a title", () => {
    expect(isLatinOriginal({ originalTitle: "Lepa sela lepo gore", originalLanguage: "sr" })).toBe(true);
    expect(isLatinOriginal({ originalTitle: "ドラゴンボールZ 神と神", originalLanguage: "ja" })).toBe(false);
    expect(isLatinOriginal({ originalTitle: null, originalLanguage: "ja" })).toBe(false);
    expect(isLatinOriginal({ originalTitle: "", originalLanguage: "fr" })).toBe(true);
    expect(isLatinOriginal({ originalTitle: null, originalLanguage: null })).toBe(false);
  });

  it("asks the English title when the account-language answer is not in Latin letters", () => {
    expect(needsTitleFallback("ドラゴンボールZ 神と神")).toBe(true);
    expect(needsTitleFallback("Dragon Ball Z: Battle of Gods")).toBe(false);
    expect(needsTitleFallback(null)).toBe(false);
  });
});

describe("originalSetLanguage", () => {
  it("fetches a Latin original in its own language", () => {
    expect(originalSetLanguage({ originalTitle: "La Haine", originalLanguage: "fr" }, "en")).toBe("fr");
  });

  it("keeps the account-language set for a non-Latin original, the account's own language or an unknown one", () => {
    expect(originalSetLanguage({ originalTitle: "ドラゴンボールZ 神と神", originalLanguage: "ja" }, "en")).toBeNull();
    expect(originalSetLanguage({ originalTitle: "La Haine", originalLanguage: "fr" }, "fr")).toBeNull();
    expect(originalSetLanguage({ originalTitle: "Something", originalLanguage: null }, "en")).toBeNull();
  });
});

describe("profile option", () => {
  it("reads an unset option as App language everywhere", () => {
    expect(profileTitleLanguage(null)).toBe("app");
    expect(profileTitleLanguage({ titleLanguage: "bogus" })).toBe("app");
    expect(profileTitleLanguage({ titleLanguage: "original" })).toBe("original");
  });

  it("asks only a profile created after the rule that never answered", () => {
    const before = { createdAt: "2026-01-01T00:00:00.000Z" };
    const after = { createdAt: TITLE_LANGUAGE_ASKED_SINCE };
    expect(needsTitleLanguageQuestion(before, null)).toBe(false);
    expect(needsTitleLanguageQuestion(after, null)).toBe(true);
    expect(needsTitleLanguageQuestion(after, { titleLanguage: "app" })).toBe(false);
  });

  it("is stored in the profile settings and survives a round trip", () => {
    const settings = mergeProfileSettings(null, { titleLanguage: "original" }, "2026-11-17T10:00:00.000Z");
    expect(parseProfileSettings(serializeProfileSettings(settings))?.titleLanguage).toBe("original");
    expect(parseProfileSettings(JSON.stringify({ titleLanguage: "fr", updatedAt: "2026-11-17T10:00:00.000Z" }))?.titleLanguage).toBeUndefined();
  });
});

describe("variant row", () => {
  const record = {
    rowLanguage: "en",
    rowTitle: "Hate",
    original: { language: "fr", title: "La Haine", posterPath: "asset:p::k", backdropPath: "/tmdb-backdrop.jpg" },
    fetchedAt: "2026-11-17T10:00:00.000Z",
  };

  it("round-trips and refuses unreadable values", () => {
    expect(titleVariantsKey("m1")).toBe("title_variants_v1:m1");
    expect(parseTitleVariants(serializeTitleVariants(record))).toEqual(record);
    expect(parseTitleVariants("")).toBeNull();
    expect(parseTitleVariants("{")).toBeNull();
    expect(parseTitleVariants(JSON.stringify({ v: 2, rowLanguage: "en", rowTitle: "x" }))).toBeNull();
  });

  it("shows the original set with Original version, keeping row pictures not copied yet", () => {
    const row = { title: "Hate", posterPath: "asset:row-poster::k", backdropPath: "asset:row-backdrop::k" };
    expect(shownTitleArt(row, record, "app")).toEqual(row);
    expect(shownTitleArt(row, record, "original")).toEqual({ title: "La Haine", posterPath: "asset:p::k", backdropPath: "asset:row-backdrop::k" });
    expect(shownTitleArt(row, { ...record, original: null }, "original")).toEqual(row);
    expect(shownTitleArt(row, null, "original")).toEqual(row);
  });

  // @bugfix @regression-proof Chris 2026-11-18: the Bardock TV special (TMDB 39323) showed its Japanese title under
  // "Original version". An original set in non-Latin letters, from whatever app wrote it, is never shown.
  it("never shows an original set in non-Latin letters", () => {
    const row = { title: "Dragon Ball Z - Le Père de Son Gokû", posterPath: "asset:fr-poster::k", backdropPath: "asset:backdrop::k" };
    const japanese = {
      ...record,
      rowLanguage: "fr",
      rowTitle: row.title,
      original: {
        language: "ja",
        title: "ドラゴンボールZ たったひとりの最終決戦〜フリーザに挑んだZ戦士 孫悟空の父〜",
        posterPath: "asset:ja-poster::k",
        backdropPath: "asset:backdrop::k",
      },
    };
    const shown = shownTitleArt(row, japanese, "original");
    console.info("Bardock under Original version", { shown });
    expect(shown).toEqual(row);
  });
});

describe("texts", () => {
  it("offers both options in the five app languages, each example as translated title vs Latin-script original", () => {
    for (const language of ["en", "fr", "nl", "de", "es"] as const) {
      const texts = titleLanguageTexts[language];
      expect(texts.question).toBeTruthy();
      expect(texts.app.label).not.toBe(texts.original.label);
      expect(texts.app.examples).toHaveLength(2);
      expect(texts.original.examples).toHaveLength(2);
      texts.app.examples.forEach((translated, i) => {
        const original = texts.original.examples[i];
        expect(translated).not.toBe(original);
        // A non-Latin original is replaced under "Original version", so it can never illustrate the option.
        expect(isLatinScriptText(original)).toBe(true);
        expect(isLatinScriptText(translated)).toBe(true);
      });
      expect(JSON.stringify(texts)).not.toMatch(/dragon ball|buono|brute et le truand/i);
      expect(withTitleLanguageTexts({ other: 1 }, language)).toEqual({ other: 1, titleLanguage: texts });
    }
    expect(titleLanguageTexts.en.app.examples).toEqual(["Amélie", "Life Is Beautiful"]);
    expect(titleLanguageTexts.en.original.examples).toEqual(["Le Fabuleux Destin d'Amélie Poulain", "La vita è bella"]);
    expect(titleLanguageTexts.fr.app.examples).toEqual(["Les Dents de la mer", "La Ligne verte"]);
    expect(titleLanguageTexts.fr.original.examples).toEqual(["Jaws", "The Green Mile"]);
  });
});
