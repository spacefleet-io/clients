import { describe, expect, it } from "vitest";
import {
  findMediaLanguage,
  formatMediaLanguageLabel,
  formatMediaLanguageOptionLabel,
  getMediaLanguageFlag,
} from "../src/media-languages";

describe("media language helpers", () => {
  it("returns language metadata for known code", () => {
    const fr = findMediaLanguage("fr");
    expect(fr?.englishName).toBe("French");
  });

  it("returns fallback label for unknown code", () => {
    expect(formatMediaLanguageLabel("zz")).toBe("ZZ");
  });

  it("formats option labels with flag and localized label", () => {
    const label = formatMediaLanguageOptionLabel("fr");
    expect(label).toContain("🇫🇷");
    expect(label.toLowerCase()).toContain("fr");
  });

  // @bugfix badger-desktop-walk-7-language-flags
  // @regression-proof The flag was the language code read as a country: Basque, Esperanto, Catalan got 🌐 or a wrong
  // country, Belarusian/Albanian/Armenian got none. Flags now come from an explicit language→country map.
  it("shows a flag only where a country stands for the language", () => {
    const flags = Object.fromEntries(["___", "eu", "eo", "ca", "be", "sq", "hy", "my", "ch", "xx", "fr"].map((c) => [c, getMediaLanguageFlag(c)]));
    console.log("[lang-flags]", JSON.stringify(flags));
    expect(flags).toEqual({
      ___: "",
      eu: "",
      eo: "",
      ca: "",
      be: "🇧🇾",
      sq: "🇦🇱",
      hy: "🇦🇲",
      my: "🇲🇲",
      ch: "🇬🇺",
      xx: "🌐",
      fr: "🇫🇷",
    });
    expect(formatMediaLanguageOptionLabel("eu")).toBe(formatMediaLanguageLabel("eu"));
  });
});
