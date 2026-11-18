import { describe, expect, it } from "vitest";
import {
  PROGRESS_CEILING_PCT,
  PROGRESS_FLOOR_PCT,
  getProgressBand,
  getProgressLabelPct,
  getVisibleProgressPct,
} from "../src/progressBand";

describe("desktop progress helpers", () => {
  it("clamps progress and ensures tiny positive values remain visible", () => {
    expect(getVisibleProgressPct(-10)).toBe(0);
    expect(getVisibleProgressPct(0.2)).toBe(1);
    expect(getVisibleProgressPct(200)).toBe(100);
  });

  it("rounds visible progress for labels", () => {
    expect(getProgressLabelPct(0.2)).toBe(1);
    expect(getProgressLabelPct(33.6)).toBe(34);
  });
});

describe("[@bugfix][@regression-proof] getProgressBand — three-state classifier (not-started / in-progress / watched)", () => {
  // Bands shared by the dialog, dashboard tiles, and resume prompt so the
  // visual state and the prompt-fires decision can't drift apart. Lower band
  // matches the prompt's RESUME_PROMPT_MIN_PCT; upper band matches the
  // picker's COMPLETED_PCT_THRESHOLD.

  it("constants match the project-wide floor and ceiling (2 / 95)", () => {
    // Pin the values so a silent constant-bump in this file gets caught.
    expect(PROGRESS_FLOOR_PCT).toBe(2);
    expect(PROGRESS_CEILING_PCT).toBe(95);
  });

  it("classifies the bands by progressPct alone", () => {
    expect(getProgressBand(0)).toBe("not-started");
    expect(getProgressBand(1)).toBe("not-started"); // user-reported ghost-touch value
    expect(getProgressBand(1.99)).toBe("not-started"); // just under floor
    expect(getProgressBand(PROGRESS_FLOOR_PCT)).toBe("in-progress"); // boundary inclusive
    expect(getProgressBand(34)).toBe("in-progress");
    expect(getProgressBand(94.99)).toBe("in-progress"); // just under ceiling
    expect(getProgressBand(PROGRESS_CEILING_PCT)).toBe("watched"); // boundary inclusive
    expect(getProgressBand(96)).toBe("watched");
    expect(getProgressBand(100)).toBe("watched");
  });

  it("treats null / undefined / NaN as not-started (defensive default)", () => {
    expect(getProgressBand(null)).toBe("not-started");
    expect(getProgressBand(undefined)).toBe("not-started");
    expect(getProgressBand(Number.NaN)).toBe("not-started");
  });

  it("clamps out-of-range numeric input before classifying", () => {
    expect(getProgressBand(-10)).toBe("not-started");
    expect(getProgressBand(150)).toBe("watched");
  });
});

describe("[@bugfix][@regression-proof] getProgressBand — Phase 2 credits-aware classifier (skip-marker-derived ceiling)", () => {
  // Phase 2 lets callers pass per-episode credits-start so the band UI
  // marks an episode as "watched" the moment the user passes the actual
  // credits start (skip markers), not at the coarse 95 % approximation. The
  // 2nd-arg inputs object is optional — legacy calls (pct only) keep the
  // exact pre-Phase-2 behavior. These tests MUST FAIL against the
  // pre-Phase-2 getProgressBand (the 2nd arg was not accepted).

  it("[@bugfix][@regression-proof] watched past credits-start with pct below 95 % → 'watched' (long-credits show)", () => {
    // 60 min episode, credits at 52:00 (3120 s). User watched to 53:00
    // (3180 s = 88.3 %). Phase 1: 88.3 < 95 → "in-progress". Phase 2:
    // 3180 >= 3120 → "watched".
    const band = getProgressBand(88.3, {
      positionSeconds: 3180,
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    });
    console.info(`[band:credits-aware] 88.3 + credits → ${band} (expect watched)`);
    expect(band).toBe("watched");
  });

  it("[@bugfix][@regression-proof] watched BEFORE credits-start with pct below 95 % → 'in-progress' (credits never falsely demotes)", () => {
    const band = getProgressBand(50, {
      positionSeconds: 1800,
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    });
    console.info(`[band:credits-aware] 50 + credits (before) → ${band} (expect in-progress)`);
    expect(band).toBe("in-progress");
  });

  it("[@bugfix][@regression-proof] 96 % WITHOUT credits inputs → 'watched' (legacy 95 % rule preserved)", () => {
    expect(getProgressBand(96)).toBe("watched");
  });

  it("[@bugfix][@regression-proof] 96 % WITH credits inputs (but not past credits) → 'watched' via pct fallback", () => {
    // Watched 30 s of a 3600 s episode, credits at 3120. 30 < 3120 →
    // credits path says NOT completed. But pct 96 % >= 95 → fallback path
    // says completed. Result: "watched". This proves the OR semantics —
    // either path can elevate to watched, neither demotes.
    const band = getProgressBand(96, {
      positionSeconds: 30,
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    });
    console.info(`[band:or-semantics] 96 % + credits (not past) → ${band} (expect watched via pct)`);
    expect(band).toBe("watched");
  });

  it("[@bugfix][@regression-proof] short-credits show: 93 % past 20:30 credits in a 22-min episode → 'watched'", () => {
    const band = getProgressBand(93.94, {
      positionSeconds: 1240,
      durationSeconds: 1320,
      creditsStartSeconds: 1230,
    });
    console.info(`[band:short-credits] 93.94 % past credits → ${band} (expect watched)`);
    expect(band).toBe("watched");
  });

  it("[@bugfix][@regression-proof] credits-aware path uses persisted positionSeconds, not pct*duration (re-transcode drift)", () => {
    // pct=88 would compute 3168 s against 3600 s (past credits 3120).
    // But persisted positionSeconds=3000 — before credits. The classifier
    // must trust the persisted seconds: band = "in-progress".
    const band = getProgressBand(88, {
      positionSeconds: 3000,
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    });
    console.info(`[band:position-authoritative] 88 + position 3000 → ${band} (expect in-progress)`);
    expect(band).toBe("in-progress");
  });

  it("[@bugfix][@regression-proof] inputs with all null credits fields = same as no inputs (legacy 95 % rule)", () => {
    // The optional fields can come in as null (from a Map.get(...) ?? null
    // call in the consumer). They must degrade cleanly to the legacy path.
    expect(getProgressBand(96, { positionSeconds: null, durationSeconds: null, creditsStartSeconds: null })).toBe("watched");
    expect(getProgressBand(50, { positionSeconds: null, durationSeconds: null, creditsStartSeconds: null })).toBe("in-progress");
    expect(getProgressBand(1, { positionSeconds: null, durationSeconds: null, creditsStartSeconds: null })).toBe("not-started");
  });

  it("[@bugfix][@regression-proof] inputs object provided but creditsStartSeconds undefined → legacy pct rule still applies", () => {
    expect(getProgressBand(96, { positionSeconds: 100, durationSeconds: 200 })).toBe("watched");
    expect(getProgressBand(50, { positionSeconds: 100, durationSeconds: 200 })).toBe("in-progress");
  });

  it("[@bugfix][@regression-proof] floor band (pct < 2) stays 'not-started' even with credits data present (lower bound is pct-only)", () => {
    // A 1 % watched value is "not-started" regardless of credits — the
    // user effectively hasn't begun. Credits data must not flip this
    // (and physically can't, since 1 % of 3600 = 36 s is far below any
    // realistic credits start).
    const band = getProgressBand(1, {
      positionSeconds: 36,
      durationSeconds: 3600,
      creditsStartSeconds: 3120,
    });
    expect(band).toBe("not-started");
  });
});
