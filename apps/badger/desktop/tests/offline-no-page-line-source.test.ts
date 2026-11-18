/**
 * @test-id DESKTOP-OFFLINE-NO-PAGE-LINE-001
 * @level unit
 * @req UX-NOTICE-02[badger-desktop]
 * @why Chris 2026-11-13 (design feedback): offline and "sync paused, using local data" are normal states said by the
 *   top bar's small chip and one passing toast. Home and the Library drew the sync-paused sentence as an info box at
 *   the top of the page ("Sync is temporarily unavailable. You're using local data until it recovers."), a second
 *   message for the same state that pushed every row down for as long as it lasted. Source-level: rendering the full
 *   pages needs the whole library context; the rule is that neither page draws the library's fallback message.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGES = ["src/renderer/src/pages/Dashboard.tsx", "src/renderer/src/pages/Library.tsx"];

describe("offline and sync-paused states draw no line in the pages", () => {
  for (const page of PAGES) {
    it(`@bugfix @regression-proof ${page} draws no sync-paused or offline box`, () => {
      const source = readFileSync(join(process.cwd(), page), "utf8");
      const hits = source
        .split("\n")
        .map((line, index) => ({ line: index + 1, text: line.trim() }))
        .filter(({ text }) => /syncUnavailableWarning \?|<NoticeSurface tone="info">\{error\}/.test(text));
      console.info(`[DESKTOP-OFFLINE-NO-PAGE-LINE-001] ${page} hits=${JSON.stringify(hits)}`);
      expect(hits).toEqual([]);
    });
  }
});
