/**
 * @bugfix tv-resume-credits-aware-completion (Phase 2 of TV-resume sweep)
 * @regression-proof
 *
 * Phase 2 replaces the flat 95 % completion ceiling with the actual
 * credits-start timestamp from TheIntroDB skip-markers when available,
 * falling back to 95 % when not. Rationale: "watched past the credits" is
 * the semantically correct "completed" signal; 95 % is a coarse
 * approximation that misclassifies long-credits episodes (60 min / 8 min
 * credits => 86.7 % actual completion, not 95 %) and short-credits ones
 * (22 min / 90 s credits => 93 % actual completion, slightly before 95 %).
 *
 * These tests pin the shared helper `isEpisodeCompleted` and the augmented
 * `resolveResumeCandidateSeconds` in `@space/shared/playbackResume` (moved
 * from packages/desktop-mpv-playback so desktop, phone and TV share one
 * source). They MUST FAIL against the pre-Phase-2 code:
 *   - `isEpisodeCompleted` did not exist (export missing).
 *   - `resolveResumeCandidateSeconds` had only 2 params (progressPct,
 *     durationSeconds) — passing a 3rd creditsStartSeconds would not have
 *     been consulted; an 85 %-watched-past-credits episode would still get
 *     a resume offer.
 *
 * Diagnostic logging: every test prints its inputs and the resolved
 * boolean / seconds, so a future failure points to the value mismatch
 * without needing to step through the helper.
 */

import { describe, expect, it } from "vitest";
import {
  COMPLETED_PCT_THRESHOLD,
  isEpisodeCompleted,
  resolveResumeCandidateSeconds,
  resolveWatchedPositionSeconds,
} from "../src/playbackResume";

describe("@bugfix @regression-proof isEpisodeCompleted — credits-aware completion (Phase 2)", () => {
  // -- Credits-aware path --

  it("@bugfix @regression-proof watched past credits-start at 85% completes the episode (long-credits show)", () => {
    // Long-credits show: 60 min episode (3600 s), credits start at 52:00
    // (3120 s). Watched to 53:00 (3180 s) — 88.3 % of duration. Under the
    // legacy flat 95 % rule this would be in-progress. With credits-aware:
    // 3180 >= 3120 => completed.
    const inputs = {
      progressPct: 88.3,
      positionSeconds: 3180,
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    };
    const result = isEpisodeCompleted(inputs);
    console.info(`[credits-aware] ${JSON.stringify(inputs)} → ${result} (expect true)`);
    expect(result).toBe(true);
  });

  it("@bugfix @regression-proof watched BEFORE credits-start (50 % through a 60-min episode, credits at 52:00) is NOT completed", () => {
    const inputs = {
      progressPct: 50,
      positionSeconds: 1800,
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    };
    const result = isEpisodeCompleted(inputs);
    console.info(`[credits-aware] ${JSON.stringify(inputs)} → ${result} (expect false — before credits)`);
    expect(result).toBe(false);
  });

  it("@bugfix @regression-proof short-credits show: 93% with credits at 20:30 (in a 22:00 episode) completes — pct alone wouldn't reach 95", () => {
    // 22-min episode (1320 s), credits start at 20:30 (1230 s). User
    // watched to 20:40 (1240 s, 93.94 %). Legacy 95 % rule: NOT
    // completed. Credits-aware: 1240 >= 1230 => completed.
    const inputs = {
      progressPct: 93.94,
      positionSeconds: 1240,
      durationSeconds: 1320,
      creditsStartSeconds: 1230,
    };
    const result = isEpisodeCompleted(inputs);
    console.info(`[credits-aware] ${JSON.stringify(inputs)} → ${result} (expect true — past credits despite <95 %)`);
    expect(result).toBe(true);
  });

  it("@bugfix @regression-proof prefers persisted positionSeconds over pct*duration when both are provided", () => {
    // Persisted positionSeconds 3000 (before credits at 3120). The pct
    // (88.3 %) * duration (3600) would compute ~3180, which IS past credits.
    // The helper must trust the persisted absolute time, not the derived
    // approximation. Otherwise a re-transcode that shifted duration would
    // wrongly flip the completion state.
    const inputs = {
      progressPct: 88.3,        // would compute 3180 against 3600 (past credits)
      positionSeconds: 3000,    // persisted authoritative time, before credits
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    };
    const result = isEpisodeCompleted(inputs);
    console.info(`[credits-aware] ${JSON.stringify(inputs)} → ${result} (expect false — persisted seconds is authoritative)`);
    expect(result).toBe(false);
  });

  // -- Fallback to legacy 95 % --

  it("@bugfix @regression-proof no creditsStartSeconds → falls back to 95 % rule (true at 95)", () => {
    const inputs = { progressPct: COMPLETED_PCT_THRESHOLD, durationSeconds: 3600 };
    const result = isEpisodeCompleted(inputs);
    console.info(`[fallback-95] ${JSON.stringify(inputs)} → ${result} (expect true — legacy 95 %)`);
    expect(result).toBe(true);
  });

  it("@bugfix @regression-proof no creditsStartSeconds → falls back to 95 % rule (false at 94.99)", () => {
    const inputs = { progressPct: 94.99, durationSeconds: 3600 };
    const result = isEpisodeCompleted(inputs);
    console.info(`[fallback-95] ${JSON.stringify(inputs)} → ${result} (expect false — below 95 %)`);
    expect(result).toBe(false);
  });

  it("@bugfix @regression-proof low pct + credits-aware inputs → NOT completed (credits never falsely demotes an in-progress episode)", () => {
    // User watched 5 % of a long-credits show. We KNOW the credits start
    // at 52:00 — but they're clearly nowhere near it. The credits path
    // must not flip the answer to true; the pct fallback says 5 % < 95 %
    // → false.
    const inputs = {
      progressPct: 5,
      positionSeconds: 180, // 3 min in
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    };
    const result = isEpisodeCompleted(inputs);
    console.info(`[credits-aware:safety] ${JSON.stringify(inputs)} → ${result} (expect false)`);
    expect(result).toBe(false);
  });

  // -- Graceful degradation: missing / malformed inputs --

  it("@bugfix @regression-proof null progressPct → not completed (cannot decide)", () => {
    expect(isEpisodeCompleted({ progressPct: null })).toBe(false);
  });

  it("@bugfix @regression-proof undefined progressPct → not completed (cannot decide)", () => {
    expect(isEpisodeCompleted({ progressPct: undefined })).toBe(false);
  });

  it("@bugfix @regression-proof NaN creditsStartSeconds → falls back to pct rule (95 % ceiling)", () => {
    const inputs = {
      progressPct: 96,
      positionSeconds: 3300,
      durationSeconds: 3600,
      creditsStartSeconds: Number.NaN,
    };
    const result = isEpisodeCompleted(inputs);
    console.info(`[fallback-nan-credits] ${JSON.stringify({ ...inputs, creditsStartSeconds: "NaN" })} → ${result} (expect true via pct rule)`);
    expect(result).toBe(true);
  });

  it("@bugfix @regression-proof creditsStartSeconds=0 is treated as 'no credits data' (falls back to pct rule)", () => {
    // 0 is not a valid credits-start (no episode credits at second 0).
    // The helper must NOT treat it as "watched past credits=0" for any
    // positive position, which would mark everything completed instantly.
    const inputs = {
      progressPct: 30,
      positionSeconds: 30,
      durationSeconds: 3600,
      creditsStartSeconds: 0,
    };
    const result = isEpisodeCompleted(inputs);
    console.info(`[fallback-zero-credits] ${JSON.stringify(inputs)} → ${result} (expect false — 0 is treated as missing)`);
    expect(result).toBe(false);
  });

  it("@bugfix @regression-proof missing duration AND no persisted seconds → cannot compute position; falls back to pct rule", () => {
    // Duration unknown + no positionSeconds: the helper can't derive an
    // absolute watched time. It must fall through to the pct ceiling.
    const inputs = {
      progressPct: 96,
      creditsStartSeconds: 3120,
    };
    const result = isEpisodeCompleted(inputs);
    console.info(`[no-duration] ${JSON.stringify(inputs)} → ${result} (expect true — pct rule)`);
    expect(result).toBe(true);
  });
});

describe("@bugfix @regression-proof resolveWatchedPositionSeconds — pick the best absolute time source", () => {
  it("prefers persisted positionSeconds when present and finite", () => {
    expect(
      resolveWatchedPositionSeconds({
        progressPct: 50,
        positionSeconds: 1500,
        durationSeconds: 3600,
      })
    ).toBe(1500);
  });

  it("derives from pct * duration when positionSeconds is missing", () => {
    expect(
      resolveWatchedPositionSeconds({
        progressPct: 50,
        durationSeconds: 3600,
      })
    ).toBe(1800);
  });

  it("returns null when neither source is computable", () => {
    expect(resolveWatchedPositionSeconds({ progressPct: null })).toBeNull();
    expect(resolveWatchedPositionSeconds({ progressPct: 50 })).toBeNull(); // no duration
    expect(
      resolveWatchedPositionSeconds({ progressPct: 50, durationSeconds: 0 })
    ).toBeNull(); // duration must be > 0
  });

  it("ignores a negative positionSeconds (treats as missing)", () => {
    // Negative position would be a serialization bug; we must not trust
    // it and must fall through to pct * duration.
    expect(
      resolveWatchedPositionSeconds({
        progressPct: 50,
        positionSeconds: -10,
        durationSeconds: 3600,
      })
    ).toBe(1800);
  });

  it("ignores NaN positionSeconds (treats as missing)", () => {
    expect(
      resolveWatchedPositionSeconds({
        progressPct: 50,
        positionSeconds: Number.NaN,
        durationSeconds: 3600,
      })
    ).toBe(1800);
  });
});

describe("@bugfix @regression-proof resolveResumeCandidateSeconds — credits-aware suppression of the resume prompt", () => {
  // Bug: a long-credits episode watched to e.g. 88 % (just past credits)
  // still triggered the resume prompt, because the only upper guard was
  // the flat 95 % ceiling. With Phase 2 the helper accepts an optional
  // creditsStartSeconds; when the watched position is past credits, the
  // prompt is suppressed (treated as watched). Mirrors the picker rule.

  it("@bugfix @regression-proof 88% watched past credits-start (long-credits show) suppresses the prompt", () => {
    // creditsStart=3120 s in a 3600 s episode. 88 % = 3168 s, past credits.
    const seconds = resolveResumeCandidateSeconds(88, 3600, 3120, 3168);
    console.info(`[resume-credits-aware] 88%/3600s/credits=3120/pos=3168 → ${seconds} (expect null — past credits)`);
    expect(seconds).toBeNull();
  });

  it("@bugfix @regression-proof 50% before credits-start still offers the prompt (in-progress)", () => {
    // 50 % of 3600 s = 1800 s, well before credits at 3120 s.
    const seconds = resolveResumeCandidateSeconds(50, 3600, 3120, 1800);
    console.info(`[resume-credits-aware] 50%/3600s/credits=3120/pos=1800 → ${seconds} (expect ~1800)`);
    expect(seconds).not.toBeNull();
    expect(seconds!).toBeGreaterThan(1700);
    expect(seconds!).toBeLessThan(1900);
  });

  it("@bugfix @regression-proof credits-aware path coexists with legacy 95% ceiling — 96% still null even with no credits", () => {
    // Legacy callers (no creditsStartSeconds) still get the symmetric
    // 95 % ceiling — Phase 2 is purely additive on the upper bound.
    expect(resolveResumeCandidateSeconds(96, 3600)).toBeNull();
  });

  it("@bugfix @regression-proof legacy 2-arg signature still works (backward compatibility)", () => {
    // The existing MediaPlaybackController call site uses
    // resolveResumeCandidateSeconds(pct, duration) without credits data.
    // It must continue to behave exactly as before Phase 2.
    expect(resolveResumeCandidateSeconds(50, 3600)).toBeCloseTo(1800, 5);
    expect(resolveResumeCandidateSeconds(96, 3600)).toBeNull(); // legacy 95 % cap
    expect(resolveResumeCandidateSeconds(0.01, 3600)).toBeNull(); // legacy floor
  });

  it("@bugfix @regression-proof returns the persisted positionSeconds (not pct*duration) when both are provided and resume is valid", () => {
    // Persisted authoritative position = 1500. pct (50) * duration (3600)
    // = 1800. The helper must return 1500, not 1800 — the persisted seconds
    // is the source of truth.
    const seconds = resolveResumeCandidateSeconds(50, 3600, /* credits */ null, /* position */ 1500);
    console.info(`[resume-credits-aware] 50%/3600s/credits=null/pos=1500 → ${seconds} (expect 1500)`);
    expect(seconds).toBe(1500);
  });

  it("@bugfix @regression-proof short-credits show: 93% watched past 20:30 credits in a 22:00 episode → null (treated as watched)", () => {
    // Phase 2 specifically un-suppresses the "narrow window" the legacy
    // 95 % rule missed: episodes already past credits but below 95 %.
    const seconds = resolveResumeCandidateSeconds(93.94, 1320, 1230, 1240);
    console.info(`[resume-credits-aware] 93.94%/1320s/credits=1230/pos=1240 → ${seconds} (expect null)`);
    expect(seconds).toBeNull();
  });
});
