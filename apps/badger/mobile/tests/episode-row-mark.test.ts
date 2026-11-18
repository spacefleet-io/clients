/**
 * @test-id MOBILE-EPISODE-ROW-MARK-001
 * @level unit
 * @why Phone walk 2026-11-12: watched episodes had no visible mark on the title page. `episodeRowMark` decides the
 *   row's tick (watched) or bar (started).
 */
// @req PLAY-RESUME-02[badger-mobile]
import { describe, expect, it } from "vitest";
import { episodeRowMark } from "../src/lib/phoneDetails";

const resume = (progressPct: number, positionSeconds: number | null = null, durationSeconds: number | null = null) => ({
  progressPct,
  positionSeconds,
  durationSeconds,
  updatedAt: null,
});

describe("phone episode row mark", () => {
  it("@req PLAY-RESUME-02 a watched episode gets the tick, a started one the bar, an unstarted one nothing", () => {
    expect(episodeRowMark(resume(100, 2700, 2700))).toEqual({ kind: "watched", progressPct: 100 });
    expect(episodeRowMark(resume(96))).toEqual({ kind: "watched", progressPct: 100 });
    expect(episodeRowMark(resume(40, 1080, 2700))).toEqual({ kind: "progress", progressPct: 40 });
    expect(episodeRowMark(resume(0))).toEqual({ kind: "none", progressPct: 0 });
    expect(episodeRowMark(undefined)).toEqual({ kind: "none", progressPct: 0 });
  });
});
