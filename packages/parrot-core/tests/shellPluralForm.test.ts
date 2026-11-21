/**
 * @req PAR-LIB-03[parrot]
 * @bugfix The phone's engine (Hermes) has no `Intl.PluralRules`; the shell's "one"/"other" pick must not need it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { shellCountKey, shellPluralForm } from "../src/shellStrings";

const T = "[PARROT-CORE-SHELL-PLURAL]";
const real = Intl.PluralRules;
const withoutPluralRules = () => Object.defineProperty(Intl, "PluralRules", { value: undefined, configurable: true, writable: true });

afterEach(() => {
  Object.defineProperty(Intl, "PluralRules", { value: real, configurable: true, writable: true });
});

describe("shellPluralForm", () => {
  it("PAR-LIB-03: without Intl.PluralRules (Hermes) it picks the same form as the engine's rules for every shell language", () => {
    const counts = [0, 1, 2, 13];
    const languages = ["en", "fr", "nl", "de", "es"];
    const withIntl = languages.map((language) => counts.map((n) => shellPluralForm(language, n)));
    withoutPluralRules();
    const withoutIntl = languages.map((language) => counts.map((n) => shellPluralForm(language, n)));
    console.info(T, "forms", JSON.stringify({ languages, counts, withIntl, withoutIntl }));
    expect(withoutIntl).toEqual(withIntl);
    expect(shellCountKey("fr", "song", 0)).toBe("library.count.song.one");
    expect(shellCountKey("en", "album", 0)).toBe("library.count.album.other");
  });
});
