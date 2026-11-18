/**
 * @test-id DESKTOP-MEDIA-DETAIL-TRAILER-SURVIVES-REFRESH-001
 * @level unit (source-level)
 * @req LIB-DETAIL-05
 * @bugfix @regression-proof
 * @why #2682 (2026-11-16): MediaDetailsDialog's reset effect runs on every new `selectedDetails` object,
 *      and a library refresh (a progress save, a snapshot push, a playlist change) hands the page a new object for the
 *      same title. The effect closed the trailer menu and cleared the open trailer each time, so the menu's
 *      "Orchard trailer" button left the DOM under a click and an open trailer closed by itself
 *      (movie-playback.e2e.test.ts, LIB-DETAIL-05 test, 2 failures in 3 runs).
 *      The trailer state now resets only when the page moves to another title or closes.
 *
 * MediaDetailsDialog consumes ~25 context hooks, so it is not mounted here (see media-details-dialog-skeleton.test.tsx);
 * the end-to-end proof is the LIB-DETAIL-05 test in e2e/movie-playback.e2e.test.ts. This test pins the source: every
 * trailer reset in the reset effect sits in a block that runs only on a title change (`if (mediaChanged)`) or when
 * the page closes (`if (!selectedId)`).
 * @covers apps/badger/desktop/src/renderer/src/components/MediaDetailsDialog.tsx
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TAG = "[DESKTOP-MEDIA-DETAIL-TRAILER-SURVIVES-REFRESH-001]";
const source = readFileSync(resolve(process.cwd(), "src/renderer/src/components/MediaDetailsDialog.tsx"), "utf8");
// The reset effect: from its title-change test to its dependency list. The menu's own buttons and the outside-click
// handler close the menu too; those are user actions and stay out of scope.
const effectStart = source.indexOf("const mediaChanged =");
const effectEnd = source.indexOf("}, [selectedDetails, selectedId, i18n.language]);", effectStart);

/** The last line before the `{` of the innermost block that encloses `index`. */
function enclosingBlockHead(index: number): string {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      if (depth === 0) return source.slice(Math.max(0, i - 120), i).split("\n").pop()!.trim();
      depth -= 1;
    }
  }
  return "";
}

/** Each call of `call` inside the reset effect, with its line and the head of its enclosing block. */
function resetSites(call: string) {
  const sites: Array<{ line: number; head: string }> = [];
  for (let index = source.indexOf(call, effectStart); index !== -1 && index < effectEnd; index = source.indexOf(call, index + call.length)) {
    sites.push({ line: source.slice(0, index).split("\n").length, head: enclosingBlockHead(index) });
  }
  return sites;
}

const TITLE_CHANGE_OR_CLOSE = /^if \((mediaChanged|!selectedId)\)$/;

describe("MediaDetailsDialog trailer state survives a library refresh (#2682)", () => {
  it.each(["setActiveTrailerKey(null)", "setTrailerMenuOpen(false)"])(
    "%s runs only on a title change or when the page closes, never on a refresh of the same title",
    (call) => {
      console.info(`${TAG} reset effect spans chars ${effectStart}-${effectEnd}`);
      expect(effectStart, "reset effect found").toBeGreaterThan(0);
      expect(effectEnd, "reset effect end found").toBeGreaterThan(effectStart);
      const sites = resetSites(call);
      console.info(`${TAG} ${call}: ${sites.length} site(s)`);
      for (const site of sites) console.info(`${TAG}   line ${site.line}: enclosing block "${site.head}"`);
      // One site per branch the effect resets in: the page closing, a film, a show with no season, a show.
      expect(sites.length, `${call} sites`).toBeGreaterThanOrEqual(4);
      const unguarded = sites.filter((site) => !TITLE_CHANGE_OR_CLOSE.test(site.head));
      if (unguarded.length > 0) console.error(`${TAG} unguarded ${call}: ${JSON.stringify(unguarded)}`);
      expect(unguarded, `${call} outside a title-change/close block`).toEqual([]);
    }
  );
});
