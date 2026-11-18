import { describe, expect, it } from "vitest";
import {
  buildOfflineFilename,
  resolveOfflineFilenameCollision,
  sanitizeOfflineFilename,
} from "../src/offlineFilename";

// On assertion failure, dump the input → computed-output mapping so a
// formatting/sanitization mismatch is diagnosable without re-running.
const dumpOfflineFilenameSnapshot = (
  label: string,
  cases: Array<{ input: unknown; got: unknown; want?: unknown }>,
) => {
  try {
    console.error(`=== [offline-filename:${label}] snapshot ===`);
    for (const c of cases) {
      console.error(
        `input=${JSON.stringify(c.input)} got=${JSON.stringify(c.got)}${c.want !== undefined ? ` want=${JSON.stringify(c.want)}` : ""}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("buildOfflineFilename", () => {
  it("formats a movie with year as '<title> (<year>).<ext>'", () => {
    console.info(`[offline-filename:movie-with-year] formatting "Lattice" (1999) mkv`);
    const got = buildOfflineFilename({ kind: "movie", title: "Lattice", year: 1999, container: "mkv" });
    if (got !== "Lattice (1999).mkv")
      dumpOfflineFilenameSnapshot("movie-with-year", [
        { input: { title: "Lattice", year: 1999 }, got, want: "Lattice (1999).mkv" },
      ]);
    expect(got).toBe("Lattice (1999).mkv");
  });

  it("omits the year when missing or non-finite", () => {
    console.info(`[offline-filename:movie-no-year] year=null / undefined / NaN should omit "(year)"`);
    const gotNull = buildOfflineFilename({ kind: "movie", title: "Unknown Movie", year: null, container: "mp4" });
    const gotMissing = buildOfflineFilename({ kind: "movie", title: "Unknown Movie", container: "mp4" });
    const gotNaN = buildOfflineFilename({ kind: "movie", title: "NaN Movie", year: Number.NaN, container: "mkv" });
    try {
      expect(gotNull).toBe("Unknown Movie.mp4");
      expect(gotMissing).toBe("Unknown Movie.mp4");
      expect(gotNaN).toBe("NaN Movie.mkv");
    } catch (err) {
      dumpOfflineFilenameSnapshot("movie-no-year", [
        { input: { title: "Unknown Movie", year: null }, got: gotNull, want: "Unknown Movie.mp4" },
        { input: { title: "Unknown Movie", year: undefined }, got: gotMissing, want: "Unknown Movie.mp4" },
        { input: { title: "NaN Movie", year: Number.NaN }, got: gotNaN, want: "NaN Movie.mkv" },
      ]);
      throw err;
    }
  });

  it("formats an episode with zero-padded S##E## and the episode title", () => {
    console.info(`[offline-filename:episode-full] Dust Park S02E03 with episode title`);
    const got = buildOfflineFilename({
      kind: "episode",
      showTitle: "Dust Park",
      seasonNumber: 2,
      episodeNumber: 3,
      episodeTitle: "Vento e Pietra",
      container: "mkv",
    });
    if (got !== "Dust Park - S02E03 - Vento e Pietra.mkv")
      dumpOfflineFilenameSnapshot("episode-full", [
        { input: "Dust Park S02E03", got, want: "Dust Park - S02E03 - Vento e Pietra.mkv" },
      ]);
    expect(got).toBe("Dust Park - S02E03 - Vento e Pietra.mkv");
  });

  it("omits the trailing title segment when episodeTitle is missing/blank", () => {
    console.info(`[offline-filename:episode-no-title] missing vs blank episodeTitle should both omit segment`);
    const gotMissing = buildOfflineFilename({
      kind: "episode",
      showTitle: "Dust Park",
      seasonNumber: 1,
      episodeNumber: 7,
      container: "mkv",
    });
    const gotBlank = buildOfflineFilename({
      kind: "episode",
      showTitle: "Dust Park",
      seasonNumber: 1,
      episodeNumber: 7,
      episodeTitle: "   ",
      container: "mkv",
    });
    try {
      expect(gotMissing).toBe("Dust Park - S01E07.mkv");
      expect(gotBlank).toBe("Dust Park - S01E07.mkv");
    } catch (err) {
      dumpOfflineFilenameSnapshot("episode-no-title", [
        { input: "S01E07 no title", got: gotMissing, want: "Dust Park - S01E07.mkv" },
        { input: "S01E07 blank title", got: gotBlank, want: "Dust Park - S01E07.mkv" },
      ]);
      throw err;
    }
  });

  it("trims surrounding whitespace from titles before formatting", () => {
    console.info(`[offline-filename:trim] "  Spaced Title  " should trim before formatting`);
    const got = buildOfflineFilename({ kind: "movie", title: "  Spaced Title  ", year: 2020, container: "mkv" });
    if (got !== "Spaced Title (2020).mkv")
      dumpOfflineFilenameSnapshot("trim-whitespace", [
        { input: "  Spaced Title  ", got, want: "Spaced Title (2020).mkv" },
      ]);
    expect(got).toBe("Spaced Title (2020).mkv");
  });

  it("zero-pads two-digit season and episode numbers", () => {
    console.info(`[offline-filename:zero-pad] season=12 episode=100`);
    const out = buildOfflineFilename({
      kind: "episode",
      showTitle: "Show",
      seasonNumber: 12,
      episodeNumber: 100,
      container: "mp4",
    });
    if (out !== "Show - S12E100.mp4")
      dumpOfflineFilenameSnapshot("zero-pad", [
        { input: "S12E100", got: out, want: "Show - S12E100.mp4" },
      ]);
    expect(out).toBe("Show - S12E100.mp4");
  });
});

describe("sanitizeOfflineFilename", () => {
  it("strips Windows-illegal characters", () => {
    const input = `a<b>c:d"e/f\\g|h?i*j.mkv`;
    console.info(`[offline-filename:strip-illegal] sanitizing input with reserved chars`);
    const got = sanitizeOfflineFilename(input);
    if (got !== "abcdefghij.mkv")
      dumpOfflineFilenameSnapshot("strip-illegal", [{ input, got, want: "abcdefghij.mkv" }]);
    expect(got).toBe("abcdefghij.mkv");
  });

  it("strips ASCII control characters", () => {
    console.info(`[offline-filename:strip-control] sanitizing "foo<SOH><STX>bar.mkv"`);
    const got = sanitizeOfflineFilename("foobar.mkv");
    if (got !== "foobar.mkv")
      dumpOfflineFilenameSnapshot("strip-control", [{ input: "foo<SOH><STX>bar.mkv", got, want: "foobar.mkv" }]);
    expect(got).toBe("foobar.mkv");
  });

  it("collapses whitespace runs to a single space", () => {
    console.info(`[offline-filename:collapse-ws] "a   b\tc.mkv" -> single spaces`);
    const got = sanitizeOfflineFilename("a   b\tc.mkv");
    if (got !== "a b c.mkv")
      dumpOfflineFilenameSnapshot("collapse-whitespace", [{ input: "a   b\\tc.mkv", got, want: "a b c.mkv" }]);
    expect(got).toBe("a b c.mkv");
  });

  it("trims trailing dots and spaces", () => {
    console.info(`[offline-filename:trim-trailing] trailing dots/spaces should be removed`);
    const gotDots = sanitizeOfflineFilename("foo . . . .mkv");
    const gotTrailing = sanitizeOfflineFilename("trailing dots...");
    try {
      expect(gotDots).toBe("foo.mkv");
      expect(gotTrailing).toBe("trailing dots");
    } catch (err) {
      dumpOfflineFilenameSnapshot("trim-trailing", [
        { input: "foo . . . .mkv", got: gotDots, want: "foo.mkv" },
        { input: "trailing dots...", got: gotTrailing, want: "trailing dots" },
      ]);
      throw err;
    }
  });

  it("suffixes Windows-reserved basenames (case-insensitive)", () => {
    console.info(`[offline-filename:reserved] CON/con/LPT1/PRN should get "_" suffix`);
    const cases = [
      { input: "CON.mkv", want: "CON_.mkv" },
      { input: "con.mkv", want: "con_.mkv" },
      { input: "LPT1.mp4", want: "LPT1_.mp4" },
      { input: "PRN", want: "PRN_" },
    ].map((c) => ({ ...c, got: sanitizeOfflineFilename(c.input) }));
    try {
      for (const c of cases) expect(c.got).toBe(c.want);
    } catch (err) {
      dumpOfflineFilenameSnapshot("reserved-basenames", cases);
      throw err;
    }
  });

  it("preserves Unicode codepoints outside the illegal set", () => {
    console.info(`[offline-filename:unicode] accented/CJK/emoji codepoints preserved`);
    const cases = [
      { input: "Vento e Pietra.mkv", want: "Vento e Pietra.mkv" },
      { input: "Héloïse — Détective.mkv", want: "Héloïse — Détective.mkv" },
      // Chinese / Japanese / emoji
      { input: "你好.mkv", want: "你好.mkv" },
      { input: "🚀 launch.mkv", want: "🚀 launch.mkv" },
    ].map((c) => ({ ...c, got: sanitizeOfflineFilename(c.input) }));
    try {
      for (const c of cases) expect(c.got).toBe(c.want);
    } catch (err) {
      dumpOfflineFilenameSnapshot("preserve-unicode", cases);
      throw err;
    }
  });

  it("truncates a long basename while preserving the extension", () => {
    const longBase = "a".repeat(300);
    console.info(`[offline-filename:truncate] 300-char basename + .mkv should cap base at 200`);
    const out = sanitizeOfflineFilename(`${longBase}.mkv`);
    try {
      expect(out.endsWith(".mkv")).toBe(true);
      // base capped at 200 chars + ".mkv" = 204 total
      expect(out.length).toBeLessThanOrEqual(204);
      expect(out.startsWith("a".repeat(200))).toBe(true);
    } catch (err) {
      dumpOfflineFilenameSnapshot("truncate-long-basename", [
        {
          input: "a*300 + .mkv",
          got: { length: out.length, tail: out.slice(-4), startsWith200: out.startsWith("a".repeat(200)) },
        },
      ]);
      throw err;
    }
  });

  it("falls back to 'untitled' when the input sanitizes to empty", () => {
    console.info(`[offline-filename:untitled] empty / all-illegal / all-dots -> "untitled"`);
    const cases = [
      { input: "", want: "untitled" },
      { input: "<<<>>>", want: "untitled" },
      { input: "...", want: "untitled" },
    ].map((c) => ({ ...c, got: sanitizeOfflineFilename(c.input) }));
    try {
      for (const c of cases) expect(c.got).toBe(c.want);
    } catch (err) {
      dumpOfflineFilenameSnapshot("fallback-untitled", cases);
      throw err;
    }
  });

  it("treats short alphanumeric trailing dots as an extension and lowercases it", () => {
    console.info(`[offline-filename:ext-lowercase] .MKV/.MP4 should lowercase`);
    const cases = [
      { input: "Movie.MKV", want: "Movie.mkv" },
      { input: "Movie.MP4", want: "Movie.mp4" },
    ].map((c) => ({ ...c, got: sanitizeOfflineFilename(c.input) }));
    try {
      for (const c of cases) expect(c.got).toBe(c.want);
    } catch (err) {
      dumpOfflineFilenameSnapshot("ext-lowercase", cases);
      throw err;
    }
  });

  it("does not treat title-internal dots as an extension when the tail has spaces or is too long", () => {
    console.info(`[offline-filename:internal-dots] title-internal dots not treated as extension`);
    // "Mr. & Mrs. Fenwick" — the part after the last dot (" Fenwick") starts with
    // a space, so the tail is NOT treated as an extension and the whole
    // string is the basename. The title is preserved verbatim.
    // "v1.2-rc1" — the tail "2-rc1" contains a hyphen, so it's not
    // alphanumeric per the rule; whole string treated as basename.
    const cases = [
      { input: "Mr. & Mrs. Fenwick", want: "Mr. & Mrs. Fenwick" },
      { input: "v1.2-rc1", want: "v1.2-rc1" },
    ].map((c) => ({ ...c, got: sanitizeOfflineFilename(c.input) }));
    try {
      for (const c of cases) expect(c.got).toBe(c.want);
    } catch (err) {
      dumpOfflineFilenameSnapshot("internal-dots", cases);
      throw err;
    }
  });

  it("handles non-string input defensively", () => {
    console.info(`[offline-filename:non-string] undefined/number inputs -> "untitled"`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gotUndefined = sanitizeOfflineFilename(undefined as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gotNumber = sanitizeOfflineFilename(123 as any);
    try {
      expect(gotUndefined).toBe("untitled");
      expect(gotNumber).toBe("untitled");
    } catch (err) {
      dumpOfflineFilenameSnapshot("non-string-input", [
        { input: "undefined", got: gotUndefined, want: "untitled" },
        { input: 123, got: gotNumber, want: "untitled" },
      ]);
      throw err;
    }
  });
});

describe("resolveOfflineFilenameCollision", () => {
  it("returns the desired name unchanged when no collision", () => {
    console.info(`[offline-filename:collision-none] no collision → name unchanged`);
    const gotEmpty = resolveOfflineFilenameCollision("Lattice (1999).mkv", new Set());
    const gotOther = resolveOfflineFilenameCollision("Lattice (1999).mkv", new Set(["Other.mkv"]));
    try {
      expect(gotEmpty).toBe("Lattice (1999).mkv");
      expect(gotOther).toBe("Lattice (1999).mkv");
    } catch (err) {
      dumpOfflineFilenameSnapshot("collision-none", [
        { input: "vs empty set", got: gotEmpty, want: "Lattice (1999).mkv" },
        { input: "vs {Other.mkv}", got: gotOther, want: "Lattice (1999).mkv" },
      ]);
      throw err;
    }
  });

  it("appends ' (2)' before the extension on first collision", () => {
    console.info(`[offline-filename:collision-first] exact collision → " (2)" before ext`);
    const got = resolveOfflineFilenameCollision(
      "Lattice (1999).mkv",
      new Set(["Lattice (1999).mkv"]),
    );
    if (got !== "Lattice (1999) (2).mkv")
      dumpOfflineFilenameSnapshot("collision-first", [
        { input: "vs {Lattice (1999).mkv}", got, want: "Lattice (1999) (2).mkv" },
      ]);
    expect(got).toBe("Lattice (1999) (2).mkv");
  });

  it("walks (2), (3), (4) … until a free slot is found", () => {
    const existing = new Set([
      "Lattice.mkv",
      "Lattice (2).mkv",
      "Lattice (3).mkv",
    ]);
    console.info(`[offline-filename:collision-walk] existing=${JSON.stringify([...existing])} → expect (4)`);
    const got = resolveOfflineFilenameCollision("Lattice.mkv", existing);
    if (got !== "Lattice (4).mkv")
      dumpOfflineFilenameSnapshot("collision-walk", [
        { input: [...existing], got, want: "Lattice (4).mkv" },
      ]);
    expect(got).toBe("Lattice (4).mkv");
  });

  it("appends a numeric suffix on inputs that have no extension", () => {
    console.info(`[offline-filename:collision-no-ext] extensionless collision → "foo (2)"`);
    const got = resolveOfflineFilenameCollision("foo", new Set(["foo"]));
    if (got !== "foo (2)")
      dumpOfflineFilenameSnapshot("collision-no-ext", [
        { input: "foo vs {foo}", got, want: "foo (2)" },
      ]);
    expect(got).toBe("foo (2)");
  });
});
