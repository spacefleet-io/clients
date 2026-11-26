/**
 * Parity test: lock current JS applyExternalSubtitle matching cell-by-cell.
 *
 * The JS find() block lives at useMpvPlaybackEngine.ts:1513–1518:
 *
 *   const existing = trackList.find(
 *     (t) =>
 *       t?.type === "sub" &&
 *       (t["external-filename"] === url ||
 *         (t.lang === expectedLang && t.title === expectedTitle)),
 *   );
 *
 * This test inlines that rule directly (no React, no hook, no imports from
 * the renderer). The inline copy is intentional: it mirrors the current
 * behavior so that Phase 1b's @space/mpv-protocol `findExternalSubtitle`
 * can be pointed at these same fixtures when it takes over ownership.
 *
 * Comment: "this mirrors useMpvPlaybackEngine.ts:1513–1518 and will be moved
 * to @space/mpv-protocol in Phase 1b".
 */

import { describe, expect, it } from "vitest";
import { TRACK_LIST_CORPUS, type MpvTrack } from "@space/mpv-protocol/tests/track-list-corpus";

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

// On a parity mismatch, dump the fixture inputs and the matched track so the
// failing corpus row is diagnosable offline without re-deriving it from the
// fixture name. Body wrapped in try/catch so a dump failure can't mask the
// real assertion failure.
const dumpParitySnapshot = (
  label: string,
  fixture: (typeof TRACK_LIST_CORPUS)[number],
  result: MpvTrack | undefined,
  resultId: number | null,
) => {
  try {
    console.error(`=== [parity-track-list:${label}] mismatch snapshot ===`);
    console.error(`fixture.name=${JSON.stringify(fixture.name)}`);
    console.error(
      `query: url=${JSON.stringify(fixture.query.url)} expectedLang=${JSON.stringify(
        fixture.query.expectedLang,
      )} expectedTitle=${JSON.stringify(fixture.query.expectedTitle)}`,
    );
    console.error(`jsExpected=${JSON.stringify(fixture.jsExpected)} actualResultId=${JSON.stringify(resultId)}`);
    console.error(`matched track:\n${JSON.stringify(result ?? null, null, 2)}`);
    console.error(`tracks (${fixture.tracks.length}):\n${JSON.stringify(fixture.tracks, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("parity: JS track-list matching (applyExternalSubtitle find())", () => {
  console.info(`[parity-track-list:setup] corpus fixtures=${TRACK_LIST_CORPUS.length}`);
  for (const fixture of TRACK_LIST_CORPUS) {
    it(`${fixture.name}`, () => {
      console.info(
        `[parity-track-list:run] fixture=${JSON.stringify(fixture.name)} tracks=${fixture.tracks.length} expected=${JSON.stringify(
          fixture.jsExpected,
        )}`,
      );
      const result = findExternalSubtitleJs(
        fixture.tracks,
        fixture.query.url,
        fixture.query.expectedLang,
        fixture.query.expectedTitle,
      );
      const resultId = typeof result?.id === "number" ? result.id : null;
      if (resultId !== fixture.jsExpected) {
        dumpParitySnapshot(`mismatch-${fixture.name}`, fixture, result, resultId);
      }
      expect(resultId).toBe(fixture.jsExpected);
    });
  }
});
