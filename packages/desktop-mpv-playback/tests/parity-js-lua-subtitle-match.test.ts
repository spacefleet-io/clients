/**
 * Parity test: JS rule vs Lua subtitle_exists rule.
 *
 * This test encodes the Lua `subtitle_exists` function from
 * packages/mpv/resources/osc/sf.lua:13–32 verbatim in TypeScript and runs
 * BOTH the JS rule and the Lua rule against every fixture in the corpus.
 * Assertions are against pre-recorded expected values, so the test PASSES even
 * for the divergent cells — the divergence is EXPECTED and is surfaced via
 * console.log so the main agent can feed the list into Phase 1b's spawn context.
 *
 * Expected divergent fixture:
 *   fixture-3: title matches but lang differs
 *     JS:             null      (lang+title branch requires BOTH)
 *     luaWithLang:    false     (lang guard fails)
 *     luaWithoutLang: true      (title alone suffices when lang param is nil)
 *
 * The divergence means that after Phase 1b consolidation, sf.lua and the JS
 * engine can silently disagree about which subtitle to select when the caller
 * passes an undefined lang to Lua. The divergence report at the end of this
 * file's test run makes that visible at the cheap unit layer.
 */

import { describe, expect, it } from "vitest";
import { TRACK_LIST_CORPUS, type MpvTrack } from "@space/mpv-protocol/tests/track-list-corpus";

// ----- Inline copy of sf.lua:13–32 subtitle_exists -----
// this mirrors packages/mpv/resources/osc/sf.lua:13–32 and will be moved to
// @space/mpv-protocol in Phase 1b.
function luaSubtitleExists(
  tracks: MpvTrack[],
  url: string | null,
  title: string | null,
  lang: string | null,
): boolean {
  for (const track of tracks) {
    if (track.type !== "sub") continue;
    const externalName = track["external-filename"];
    if (url && externalName === url) return true;
    if (title && track.title === title) {
      if (!lang || track.lang === lang) return true;
    }
  }
  return false;
}
// ----- end inline copy -----

// ----- Inline copy of useMpvPlaybackEngine.ts:1513–1518 -----
// this mirrors useMpvPlaybackEngine.ts:1513–1518 and will be moved to
// @space/mpv-protocol in Phase 1b.
function findExternalSubtitleJs(
  trackList: MpvTrack[],
  url: string | undefined,
  expectedLang: string,
  expectedTitle: string,
): MpvTrack | undefined {
  return trackList.find(
    (t) =>
      t?.type === "sub" &&
      (t["external-filename"] === url ||
        (t.lang === expectedLang && t.title === expectedTitle)),
  );
}
// ----- end inline copy -----

// On assertion failure, dump the full per-fixture parity cell so the JS↔Lua
// divergence can be diagnosed offline (suite-id: parity-js-lua-subtitle-match).
// Wrapped in try/catch so a dump failure can never mask the real assertion.
const dumpParitySnapshot = (
  label: string,
  fixture: (typeof TRACK_LIST_CORPUS)[number],
  observed: {
    jsId: number | null;
    jsMatched: boolean;
    luaWithLang: boolean;
    luaWithoutLang: boolean;
  },
) => {
  try {
    console.error(`=== [parity-js-lua-subtitle-match:${label}] cell snapshot ===`);
    console.error(`fixture.name=${fixture.name}`);
    console.error(`query=${JSON.stringify(fixture.query)}`);
    console.error(
      `expected: jsExpected=${JSON.stringify(fixture.jsExpected)} luaWithLang=${JSON.stringify(
        fixture.luaWithLang,
      )} luaWithoutLang=${JSON.stringify(fixture.luaWithoutLang)}`,
    );
    console.error(
      `observed: jsId=${JSON.stringify(observed.jsId)} jsMatched=${observed.jsMatched} luaWithLang=${observed.luaWithLang} luaWithoutLang=${observed.luaWithoutLang}`,
    );
    console.error(`tracks:\n${JSON.stringify(fixture.tracks, null, 2)}`);
    console.error(`=== [parity-js-lua-subtitle-match:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("parity: JS rule vs Lua subtitle_exists — divergent cells surfaced", () => {
  const divergences: string[] = [];

  console.info(
    `[parity-js-lua-subtitle-match:setup] corpus size=${TRACK_LIST_CORPUS.length} fixtures`,
  );

  for (const fixture of TRACK_LIST_CORPUS) {
    it(`${fixture.name}`, () => {
      console.info(
        `[parity-js-lua-subtitle-match:run] fixture=${fixture.name} tracks=${fixture.tracks.length} query=${JSON.stringify(fixture.query)}`,
      );
      const jsResult = findExternalSubtitleJs(
        fixture.tracks,
        fixture.query.url,
        fixture.query.expectedLang,
        fixture.query.expectedTitle,
      );
      const jsId = typeof jsResult?.id === "number" ? jsResult.id : null;
      const jsMatched = jsId !== null;

      const luaWithLang = luaSubtitleExists(
        fixture.tracks,
        fixture.query.url ?? null,
        fixture.query.expectedTitle || null,
        fixture.query.expectedLang || null,
      );

      const luaWithoutLang = luaSubtitleExists(
        fixture.tracks,
        fixture.query.url ?? null,
        fixture.query.expectedTitle || null,
        null,
      );

      console.info(
        `[parity-js-lua-subtitle-match:run] fixture=${fixture.name} observed jsId=${JSON.stringify(jsId)} luaWithLang=${luaWithLang} luaWithoutLang=${luaWithoutLang}`,
      );

      // Assert against pre-recorded expectations (encoding known asymmetry).
      // Guard each assertion with a dump so a parity break surfaces the full
      // cell (expected vs observed + tracks) before the expect throws.
      const observed = { jsId, jsMatched, luaWithLang, luaWithoutLang };
      if (jsId !== fixture.jsExpected) dumpParitySnapshot(`${fixture.name}-js-mismatch`, fixture, observed);
      expect(jsId).toBe(fixture.jsExpected);
      if (luaWithLang !== fixture.luaWithLang)
        dumpParitySnapshot(`${fixture.name}-lua-with-lang-mismatch`, fixture, observed);
      expect(luaWithLang).toBe(fixture.luaWithLang);
      if (luaWithoutLang !== fixture.luaWithoutLang)
        dumpParitySnapshot(`${fixture.name}-lua-without-lang-mismatch`, fixture, observed);
      expect(luaWithoutLang).toBe(fixture.luaWithoutLang);

      // Surface any divergent cells for Phase 1b — a cell diverges when the JS
      // matched result disagrees with either Lua variant.
      if (jsMatched !== luaWithLang || jsMatched !== luaWithoutLang) {
        const entry = [
          `DIVERGENCE — ${fixture.name}:`,
          `  JS matched=${jsMatched} (id=${jsId})`,
          `  luaWithLang=${luaWithLang}`,
          `  luaWithoutLang=${luaWithoutLang}`,
        ].join("\n");
        divergences.push(entry);
        console.log(entry);
      }
    });
  }

  it("divergence-report summary", () => {
    // This test always passes — it just prints the full divergence list once
    // so CI logs capture it even when individual tests are filtered.
    if (divergences.length > 0) {
      console.log(
        "\n=== JS vs Lua subtitle_exists divergent cells ===\n" +
          divergences.join("\n\n") +
          "\n=== end divergence report ===\n",
      );
    } else {
      console.log("\n=== JS vs Lua subtitle_exists: no divergences found ===\n");
    }
    // No assertion — divergences are expected and pre-recorded in the corpus.
    expect(true).toBe(true);
  });
});
