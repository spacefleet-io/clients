/**
 * @bugfix mpv-resume-prompt-at-zero
 * @regression-proof
 *
 * PLAY-RESUME-01: a resume is offered only when the saved position is at least
 * 2% of the runtime AND at least 15 s, and below the completion ceiling. One
 * module (`@space/shared/playbackResume`) decides it for desktop, phone and TV.
 *
 * History guarded here:
 * - Bug 1 (original): no floor at all. A near-zero stored `progressPct` (real
 *   example: 0.0065 on a ~23-min episode ≈ 0.09 s) rendered "00:00:00" and still
 *   prompted.
 * - Desktop then used an OR floor (2% OR 15 s), so a few seconds of a short
 *   clip, or 1% of a long film, still prompted while phone/TV used AND. The
 *   spec settled on AND for every app; the OR cases below are now refusals.
 * - The completion ceiling (95%, or the credits start) is symmetric: a finished
 *   episode restarts from 0 without a prompt.
 */

import { describe, expect, it } from "vitest";
import {
  COMPLETED_PCT_THRESHOLD,
  RESUME_PROMPT_MIN_PCT,
  RESUME_PROMPT_MIN_SECONDS,
  resolveResumeCandidateSeconds,
} from "../src/playbackResume";

const probe = (label: string, pct: number | null, duration: number | null) => {
  const seconds = resolveResumeCandidateSeconds(pct, duration);
  console.info(
    `[resume-floor:${label}] pct=${pct} duration=${duration} → candidate=${seconds} (floors: ${RESUME_PROMPT_MIN_PCT}% AND ${RESUME_PROMPT_MIN_SECONDS}s, ceiling ${COMPLETED_PCT_THRESHOLD}%)`,
  );
  return seconds;
};

// @req PLAY-RESUME-01
describe("@bugfix @regression-proof resolveResumeCandidateSeconds — 2% AND 15 s floor (PLAY-RESUME-01)", () => {
  it("floor constants are 2% and 15 s", () => {
    console.info(`[resume-floor:constants] pct=${RESUME_PROMPT_MIN_PCT} seconds=${RESUME_PROMPT_MIN_SECONDS}`);
    expect(RESUME_PROMPT_MIN_PCT).toBe(2);
    expect(RESUME_PROMPT_MIN_SECONDS).toBe(15);
  });

  it("@bugfix @regression-proof near-zero progress (0.0065% — the real bug value) resolves to null", () => {
    expect(probe("near-zero", 0.0065, 1380)).toBeNull();
  });

  it("@bugfix @regression-proof sub-1% race values (0.46% / 0.51% of 23 min) resolve to null", () => {
    expect(probe("race-0.46", 0.4639, 1380)).toBeNull();
    expect(probe("race-0.51", 0.5172, 1380)).toBeNull();
  });

  it("short clip at a high % but under 15 s (86.5% of 9.84 s = 8.5 s) is NOT offered (former OR case)", () => {
    expect(probe("short-high-pct", 86.5, 9.84)).toBeNull();
  });

  it("long film past 15 s but under 2% (1% of 2 h = 72 s) is NOT offered (former OR case)", () => {
    expect(probe("long-low-pct", 1, 7200)).toBeNull();
  });

  it("just under the % floor (1.9% of 1000 s = 19 s) is NOT offered", () => {
    expect(probe("pct-just-under", 1.9, 1000)).toBeNull();
  });

  it("just under the seconds floor (14 s = 10% of 140 s) is NOT offered", () => {
    expect(probe("seconds-just-under", 10, 140)).toBeNull();
  });

  it("both floors met exactly (2% of 750 s = 15 s) IS offered", () => {
    expect(probe("both-exact", 2, 750)).toBe(15);
  });

  it("both floors met (2% of 1000 s = 20 s; 50% of 1380 s = 690 s) IS offered", () => {
    expect(probe("both-met-20", 2, 1000)).toBe(20);
    expect(probe("mid", 50, 1380)).toBe(690);
  });

  it("out-of-range / invalid progress resolves to null", () => {
    expect(probe("zero", 0, 1380)).toBeNull();
    expect(probe("hundred", 100, 1380)).toBeNull();
    expect(probe("nonsense", 150, 1380)).toBeNull();
    expect(probe("no-duration", 50, 0)).toBeNull();
    expect(probe("null-pct", null, 1380)).toBeNull();
    expect(probe("null-duration", 50, null)).toBeNull();
    expect(probe("nan", Number.NaN, 1380)).toBeNull();
  });
});

describe("@bugfix @regression-proof resolveResumeCandidateSeconds — completion ceiling (symmetric upper bound)", () => {
  // Bug: at 99% the prompt still fired with "Resume from 22:45?" because the
  // only upper guard was the strict 100% cap. Playing a finished episode
  // restarts from 0 without asking.

  it("@bugfix @regression-proof exactly COMPLETED_PCT_THRESHOLD (95%) resolves to null (treated as watched)", () => {
    expect(probe("ceiling-exact", COMPLETED_PCT_THRESHOLD, 1380)).toBeNull();
  });

  it("@bugfix @regression-proof 96% and 99% (the reported 'Resume from 22:45?' value) resolve to null", () => {
    expect(probe("ceiling-96", 96, 1380)).toBeNull();
    expect(probe("ceiling-99", 99, 1380)).toBeNull();
  });

  it("@bugfix @regression-proof just under the ceiling (94.99%) still resumes", () => {
    const seconds = probe("ceiling-under", 94.99, 1380);
    expect(seconds).not.toBeNull();
    expect(seconds!).toBeGreaterThan(1300);
    expect(seconds!).toBeLessThan(1320);
  });
});
