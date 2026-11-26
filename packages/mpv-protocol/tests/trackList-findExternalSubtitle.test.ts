/**
 * Divergence-resolving findExternalSubtitle test.
 *
 * Re-uses the fixture corpus harvested in Phase 1a
 * (tests/track-list-corpus.ts) so the
 * new consolidated matcher is judged against the SAME inputs the Lua and
 * old JS rules were measured against.
 *
 * Phase 1a surfaced 2 divergences that this matcher resolves per the
 * approved plan:
 *
 *   - fixture-3 (lang-mismatch): title matches but lang differs.
 *     OLD JS: no match. Lua without lang: match. Lua with lang: no match.
 *     RESOLUTION: no match — JS semantics win, require BOTH lang AND title.
 *
 *   - fixture-7 (undefined-url): the "off" path where url is undefined.
 *     OLD JS: matched the first external-filename-less track because
 *     undefined === undefined was true on the disjunction.
 *     RESOLUTION: no match — explicit `url !== undefined` guard prevents
 *     the silent match.
 *
 * For every other fixture, findExternalSubtitle MUST return the same id
 * as the corpus's `jsExpected` so behavior is unchanged on the happy paths.
 */

import { describe, expect, it } from "vitest";

import { findExternalSubtitle } from "../src/trackList";
import {
  TRACK_LIST_CORPUS,
  type MpvTrack as FixtureMpvTrack,
} from "./track-list-corpus";

/**
 * Which fixtures the divergence resolution flips relative to the old JS
 * behavior. Both flip to "no match" — see the file header for the why.
 */
const DIVERGENCE_OVERRIDES: Record<string, number | null> = {
  "fixture-7: off branch — undefined url matches undefined external-filename in JS, Lua skips": null,
};

// Per-suite dump helper. Body wrapped in try/catch so a dump failure can never
// mask the real matcher assertion. Surfaces the fixture query, the candidate
// tracks the matcher ran against, and the actual vs expected subtitle id.
const dumpMatcherSnapshot = (
  label: string,
  ctx: {
    fixtureName?: string;
    query?: unknown;
    tracks?: unknown;
    actual?: unknown;
    expected?: unknown;
  },
) => {
  try {
    console.error(`=== [mpv-protocol-trackList-findExternalSubtitle:${label}] snapshot ===`);
    console.error(`fixture=${JSON.stringify(ctx.fixtureName)}`);
    console.error(`query=${JSON.stringify(ctx.query)}`);
    console.error(`tracks=${JSON.stringify(ctx.tracks, null, 2)}`);
    console.error(`actual=${JSON.stringify(ctx.actual)} expected=${JSON.stringify(ctx.expected)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("findExternalSubtitle: consolidated matcher, divergences resolved", () => {
  console.info(
    `[mpv-protocol-trackList-findExternalSubtitle:setup] corpus fixtures=${TRACK_LIST_CORPUS.length} overrides=${Object.keys(DIVERGENCE_OVERRIDES).length}`,
  );
  for (const fixture of TRACK_LIST_CORPUS) {
    const override = Object.hasOwn(DIVERGENCE_OVERRIDES, fixture.name)
      ? DIVERGENCE_OVERRIDES[fixture.name]
      : undefined;
    const expectedId = override !== undefined ? override : fixture.jsExpected;
    it(`${fixture.name}`, () => {
      console.info(
        `[mpv-protocol-trackList-findExternalSubtitle:corpus] fixture="${fixture.name}" expectedId=${JSON.stringify(expectedId)} overridden=${override !== undefined}`,
      );
      const tracks = fixture.tracks as ReadonlyArray<FixtureMpvTrack>;
      const result = findExternalSubtitle(tracks, {
        url: fixture.query.url,
        expectedLang: fixture.query.expectedLang,
        expectedTitle: fixture.query.expectedTitle,
      });
      const resultId = typeof result?.id === "number" ? result.id : null;
      console.info(`[mpv-protocol-trackList-findExternalSubtitle:corpus] resultId=${JSON.stringify(resultId)}`);
      if (resultId !== expectedId) {
        dumpMatcherSnapshot("corpus", {
          fixtureName: fixture.name,
          query: fixture.query,
          tracks: fixture.tracks,
          actual: resultId,
          expected: expectedId,
        });
      }
      expect(resultId).toBe(expectedId);
    });
  }

  it("fixture-3 (lang-mismatch) returns no match — JS semantics win over Lua title-alone fallback", () => {
    console.info(`[mpv-protocol-trackList-findExternalSubtitle:fixture-3] asserting lang-mismatch yields no match`);
    const fixture3 = TRACK_LIST_CORPUS.find((f) => f.name.startsWith("fixture-3:"))!;
    if (fixture3.jsExpected !== null) {
      dumpMatcherSnapshot("fixture-3", {
        fixtureName: fixture3.name,
        query: fixture3.query,
        tracks: fixture3.tracks,
        actual: fixture3.jsExpected,
        expected: null,
      });
    }
    expect(fixture3.jsExpected).toBe(null);
    const result = findExternalSubtitle(fixture3.tracks, {
      url: fixture3.query.url,
      expectedLang: fixture3.query.expectedLang,
      expectedTitle: fixture3.query.expectedTitle,
    });
    console.info(`[mpv-protocol-trackList-findExternalSubtitle:fixture-3] result=${JSON.stringify(result)}`);
    if (result !== undefined) {
      dumpMatcherSnapshot("fixture-3", {
        fixtureName: fixture3.name,
        query: fixture3.query,
        tracks: fixture3.tracks,
        actual: result,
        expected: undefined,
      });
    }
    expect(result).toBeUndefined();
  });

  it("fixture-7 (undefined-url) returns no match — explicit url !== undefined guard", () => {
    console.info(`[mpv-protocol-trackList-findExternalSubtitle:fixture-7] asserting undefined-url yields no match`);
    const fixture7 = TRACK_LIST_CORPUS.find((f) => f.name.startsWith("fixture-7:"))!;
    if (fixture7.query.url !== undefined) {
      dumpMatcherSnapshot("fixture-7", {
        fixtureName: fixture7.name,
        query: fixture7.query,
        tracks: fixture7.tracks,
        actual: fixture7.query.url,
        expected: undefined,
      });
    }
    expect(fixture7.query.url).toBeUndefined();
    const result = findExternalSubtitle(fixture7.tracks, {
      url: fixture7.query.url,
      expectedLang: fixture7.query.expectedLang,
      expectedTitle: fixture7.query.expectedTitle,
    });
    console.info(`[mpv-protocol-trackList-findExternalSubtitle:fixture-7] result=${JSON.stringify(result)}`);
    if (result !== undefined) {
      dumpMatcherSnapshot("fixture-7", {
        fixtureName: fixture7.name,
        query: fixture7.query,
        tracks: fixture7.tracks,
        actual: result,
        expected: undefined,
      });
    }
    expect(result).toBeUndefined();
  });
});
