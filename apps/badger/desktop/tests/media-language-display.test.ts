import { describe, expect, it } from "vitest";
import { MEDIA_LANGUAGE_OPTIONS } from "@space/shared";
import {
  formatMediaLanguageLabelForUi,
  formatTrackDisplayLabel,
  sortedMediaLanguageOptionsForUi,
} from "@space/shared/mediaLanguageDisplay";

describe("desktop media language display", () => {
  it("returns translated undefined label for und/undefined values", () => {
    expect(formatMediaLanguageLabelForUi("und", "fr", "Non identifiee")).toBe("Non identifiee");
    expect(formatMediaLanguageLabelForUi("undefined", "en", "Undefined")).toBe("Undefined");
  });

  it("normalizes legacy 3-letter codes", () => {
    const fr = formatMediaLanguageLabelForUi("fra", "en", "Undefined");
    expect(fr.toLowerCase()).toContain("french");
  });

  it("formats option label with flag", () => {
    const value = sortedMediaLanguageOptionsForUi("fr", "Non identifiee").find((o) => o.code === "fr")?.label;
    expect(value).toBe("Français 🇫🇷");
  });

  // @bugfix badger-desktop-walk-7-language-list
  // @regression-proof The language select showed "No Language" untranslated, raw "xx"/"cn" names, lower-case French
  // names, Basque/Esperanto/Catalan under a made-up country flag, and Akan/Romanian/Ndebele twice.
  /** @req UX-I18N-11[badger-desktop] */
  it.each(["en", "fr", "nl", "de", "es"])("lists each language once under a sane name and flag (%s)", (ui) => {
    const sorted = sortedMediaLanguageOptionsForUi(ui, "Undefined");
    const labels = sorted.map((o) => o.label);
    console.log(`[lang-list ${ui}]`, labels.slice(0, 12).join(" | "));
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(labels.length);
    for (const label of labels) {
      expect(label, label).not.toContain(";");
      expect(label.charAt(0), label).toBe(label.charAt(0).toLocaleUpperCase(ui));
    }
    const byCode = new Map(sorted.map((o) => [o.code, o.label]));
    for (const code of ["eu", "eo", "ca"]) expect(byCode.get(code), code).not.toMatch(/\p{Regional_Indicator}/u);
    expect(byCode.get("be")).toContain("🇧🇾");
    expect(byCode.get("sq")).toContain("🇦🇱");
    expect(byCode.get("hy")).toContain("🇦🇲");
  });

  it("names no-language in the UI language", () => {
    expect(formatMediaLanguageLabelForUi("xx", "fr")).toBe("Aucune langue");
    expect(formatMediaLanguageLabelForUi("xx", "de")).toBe("Keine Sprache");
    expect(formatMediaLanguageLabelForUi("xx", "en")).toBe("No language");
  });
});

describe("formatTrackDisplayLabel", () => {
  it("returns lang only when no descriptor", () => {
    expect(formatTrackDisplayLabel("fr", "", "en")).toBe("French");
    expect(formatTrackDisplayLabel("en", null, "en")).toBe("English");
  });

  it("joins language and descriptor with ' - '", () => {
    expect(formatTrackDisplayLabel("fr", "test", "en")).toBe("French - test");
    expect(formatTrackDisplayLabel("en", "deaf", "en")).toBe("English - deaf");
  });

  // @bugfix french-french-test-duplicate-language-prefix
  // @regression-proof When ingest baked the language name into the label
  // (e.g. label="French test" for a fr-tagged track), formatting concatenated
  // them and produced "French French test". The formatter must detect and
  // strip the redundant leading language token.
  it("strips redundant leading language token from descriptor", () => {
    expect(formatTrackDisplayLabel("fr", "French test", "en")).toBe("French - test");
    expect(formatTrackDisplayLabel("fr", "French - test", "en")).toBe("French - test");
    expect(formatTrackDisplayLabel("fr", "French: test", "en")).toBe("French - test");
    expect(formatTrackDisplayLabel("en", "English DEAF", "en")).toBe("English - DEAF");
  });

  it("returns lang only when descriptor is exactly the language name", () => {
    expect(formatTrackDisplayLabel("fr", "french", "en")).toBe("French");
    expect(formatTrackDisplayLabel("fr", "French", "en")).toBe("French");
  });

  it("renders label verbatim when language is und", () => {
    expect(formatTrackDisplayLabel("und", "custom-track-name", "en")).toBe("custom-track-name");
    expect(formatTrackDisplayLabel(null, "custom-track-name", "en")).toBe("custom-track-name");
  });

  it("falls back to undefinedLabel when language is und and no label", () => {
    expect(formatTrackDisplayLabel("und", "", "en", "Audio")).toBe("Audio");
    expect(formatTrackDisplayLabel("und", null, "en")).toBe("Undefined");
  });

  // @bugfix badger-desktop-walk-13-track-labels
  // @regression-proof Subtitles read "French - FRE" next to audio "French - Français", always in English: a descriptor
  // that only names the language again must collapse, and the language reads in the UI language.
  it("drops a descriptor that only names the language and names it in the UI language", () => {
    const cases: [string, string, string, string][] = [
      ["fr", "FRE", "fr", "Français"],
      ["fr", "FRE", "en", "French"],
      ["fr", "Français", "en", "French"],
      ["fr", "French - Français", "en", "French"],
      ["en", "English", "fr", "Anglais"],
      ["en", "eng", "fr", "Anglais"],
      ["fr", "French SDH", "fr", "Français - SDH"],
      ["fr", "Français SDH", "fr", "Français - SDH"],
      ["nl", "dut", "en", "Dutch"],
      ["es", "Spanish (Hearing impaired)", "en", "Spanish (Hearing impaired)"],
      ["fr", "Frenchy", "en", "French - Frenchy"],
    ];
    for (const [lang, label, ui, expected] of cases) {
      const got = formatTrackDisplayLabel(lang, label, ui);
      console.log(`[track-label] ${lang}/${label}/${ui} -> ${got}`);
      expect(got).toBe(expected);
    }
  });
});

// #928: the language pickers sorted ~190 options with a comparator that rebuilt both labels and a collator per
// comparison, then recomputed each label per rendered select (~0.4 s per render on a Celeron N4000).
describe("sortedMediaLanguageOptionsForUi", () => {
  it.each(["en", "fr", "ja"])("lists every option once, labelled and sorted by label (%s)", (ui) => {
    const sorted = sortedMediaLanguageOptionsForUi(ui, "Undefined");
    expect(sorted.map((o) => o.code).sort()).toEqual(MEDIA_LANGUAGE_OPTIONS.map((o) => o.code).sort());
    const collator = new Intl.Collator(ui, { sensitivity: "base" });
    for (let i = 1; i < sorted.length; i += 1) {
      expect(collator.compare(sorted[i - 1]!.label, sorted[i]!.label)).toBeLessThanOrEqual(0);
    }
  });

  it("builds the list once per UI language and undefined label", () => {
    expect(sortedMediaLanguageOptionsForUi("fr", "Non identifiée")).toBe(sortedMediaLanguageOptionsForUi("fr", "Non identifiée"));
    expect(sortedMediaLanguageOptionsForUi("fr", "Non identifiée")).not.toBe(sortedMediaLanguageOptionsForUi("en", "Non identifiée"));
    expect(sortedMediaLanguageOptionsForUi("fr", "Non identifiée")).not.toBe(sortedMediaLanguageOptionsForUi("fr", "Undefined"));
  });
});
