import { describe, expect, it } from "vitest";
import {
  COMPLETED_PCT_THRESHOLD,
  RESUME_PROMPT_MIN_PCT,
  RESUME_PROMPT_MIN_SECONDS,
  buildEpisodeResumeValue,
  episodeResumeKey,
  isEpisodeCompleted,
  parseEpisodeResumeValue,
  progressPctFromPosition,
  resolveResumeCandidateSeconds,
} from "@space/shared/playbackResume";
import { isEpisodeResumable, shouldPersistProgress } from "../src/lib/playback/resume";

// The phone and TV use the same module as desktop (@space/shared/playbackResume), so
// there is no separate desktop copy to keep in parity any more.
// @req PLAY-RESUME-02[badger-mobile,badger-tv]
describe("shared constants + watched decision", () => {
  it("uses the shared constants (2%, 15 s, 95%)", () => {
    console.info(
      `playback-resume: constants pct=${RESUME_PROMPT_MIN_PCT} seconds=${RESUME_PROMPT_MIN_SECONDS} completed=${COMPLETED_PCT_THRESHOLD}`,
    );
    expect(RESUME_PROMPT_MIN_PCT).toBe(2);
    expect(RESUME_PROMPT_MIN_SECONDS).toBe(15);
    expect(COMPLETED_PCT_THRESHOLD).toBe(95);
  });

  it("counts an episode watched at 95%, or earlier once past the credits start", () => {
    const cases = [
      { input: { progressPct: 95, durationSeconds: 2700 }, want: true },
      { input: { progressPct: 94.9, durationSeconds: 2700 }, want: false },
      // Past the start of the end credits counts as watched even below 95%.
      { input: { progressPct: 93, durationSeconds: 2700, creditsStartSeconds: 2500, positionSeconds: 2511 }, want: true },
      // A known credits start never makes a position before it look watched.
      { input: { progressPct: 50, durationSeconds: 2700, creditsStartSeconds: 2500, positionSeconds: 1350 }, want: false },
    ];
    for (const { input, want } of cases) {
      const got = isEpisodeCompleted(input);
      console.info(`playback-resume: isEpisodeCompleted(${JSON.stringify(input)}) -> ${got} (want ${want})`);
      expect(got).toBe(want);
    }
  });
});

// @bugfix PLAY-RESUME-01: the phone and TV offered resume when EITHER threshold was reached (20 s into a 2 h film).
// @req PLAY-RESUME-01[badger-mobile,badger-tv]
describe("resume offer needs both thresholds: at least 2% AND at least 15 s watched", () => {
  const offer = (pct: number, duration: number, position?: number | null) => {
    const seconds = resolveResumeCandidateSeconds(pct, duration, null, position);
    console.info(`playback-resume: offer(pct=${pct}, duration=${duration}s, position=${position ?? "-"}) -> ${seconds}`);
    return seconds;
  };

  it("offers nothing below 2% even with plenty of seconds watched (20 s into a 2 h film, 1% of 2 h = 72 s)", () => {
    expect(offer(20 / 72, 7200, 20)).toBeNull();
    expect(offer(1, 7200)).toBeNull();
    expect(offer(1.99, 7200, 143)).toBeNull();
  });

  it("offers nothing below 15 s even at a high percent of a short clip (86.5% of 9.84 s)", () => {
    expect(offer(86.5, 9.84)).toBeNull();
    expect(offer(50, 20, 10)).toBeNull();
    expect(offer(10, 140, 14.9)).toBeNull();
  });

  it("offers the position once both are reached, right at the thresholds", () => {
    expect(offer(2, 750)).toBe(15);
    expect(offer(2, 7200, 144)).toBe(144);
    expect(offer(50, 1380)).toBe(690);
  });

  it("offers nothing for a finished title or garbage input", () => {
    expect(offer(95, 1380)).toBeNull();
    expect(offer(0, 1380)).toBeNull();
    expect(offer(Number.NaN, 1380)).toBeNull();
    expect(offer(50, 0)).toBeNull();
  });

  it("the details Play button reads Resume only under the same rule", () => {
    const resume = (progressPct: number, positionSeconds: number | null, durationSeconds: number) => ({ progressPct, positionSeconds, durationSeconds, updatedAt: null });
    expect(isEpisodeResumable(resume(1, 72, 7200))).toBe(false);
    expect(isEpisodeResumable(resume(60, 12, 20))).toBe(false);
    expect(isEpisodeResumable(resume(3, 216, 7200))).toBe(true);
  });
});

// @req PLAY-RESUME-03
describe("episode_resume_v1 key/value", () => {
  it("uses the desktop key", () => {
    expect(episodeResumeKey("abc")).toBe("episode_resume_v1:abc");
  });

  it("round-trips the desktop JSON shape", () => {
    const raw = buildEpisodeResumeValue({ progressPct: 42.123456, positionSeconds: 600.4, durationSeconds: 1400, updatedAt: "2026-01-01T00:00:00.000Z" });
    const parsed = parseEpisodeResumeValue(raw);
    expect(parsed?.progressPct).toBeCloseTo(42.1235, 4);
    expect(parsed?.positionSeconds).toBeCloseTo(600.4, 1);
    expect(parsed?.durationSeconds).toBe(1400);
  });

  it("parses legacy values without timing and rejects garbage", () => {
    expect(parseEpisodeResumeValue(JSON.stringify({ progressPct: 10, updatedAt: "x" }))?.positionSeconds).toBeNull();
    expect(parseEpisodeResumeValue("nope")).toBeNull();
    expect(parseEpisodeResumeValue(null)).toBeNull();
  });
});

describe("progress helpers", () => {
  it("computes percent", () => {
    expect(progressPctFromPosition(50, 200)).toBeCloseTo(25, 3);
    expect(progressPctFromPosition(5, 0)).toBe(0);
  });
});

describe("shouldPersistProgress", () => {
  const base = { durationSeconds: 1000, lastSavedPositionSeconds: null as number | null, force: false };
  it("never writes near-zero unless the user started over", () => {
    expect(shouldPersistProgress({ ...base, positionSeconds: 0.2, force: true })).toBe(false);
    expect(shouldPersistProgress({ ...base, positionSeconds: 0.2, force: true, allowZero: true })).toBe(true);
  });
  it("skips unchanged positions and tiny movements", () => {
    expect(shouldPersistProgress({ ...base, positionSeconds: 100, lastSavedPositionSeconds: 100.2, force: true })).toBe(false);
    expect(shouldPersistProgress({ ...base, positionSeconds: 100.7, lastSavedPositionSeconds: 100 })).toBe(false);
    expect(shouldPersistProgress({ ...base, positionSeconds: 105, lastSavedPositionSeconds: 100 })).toBe(true);
    expect(shouldPersistProgress({ ...base, positionSeconds: 100.7, lastSavedPositionSeconds: 100, force: true })).toBe(true);
  });
  it("rejects invalid input", () => {
    expect(shouldPersistProgress({ ...base, positionSeconds: Number.NaN })).toBe(false);
    expect(shouldPersistProgress({ ...base, positionSeconds: 50, durationSeconds: 0 })).toBe(false);
  });
});

describe("details Play button: Resume vs Play", () => {
  const resume = (progressPct: number, positionSeconds: number | null = null) => ({
    progressPct,
    positionSeconds,
    durationSeconds: 1200,
    updatedAt: null,
  });

  it("says Resume only when playback will offer to resume", () => {
    expect(isEpisodeResumable(undefined)).toBe(false);
    expect(isEpisodeResumable(resume(40, 480))).toBe(true);
    // Finished episode restarts from the top: Play, not Resume.
    expect(isEpisodeResumable(resume(COMPLETED_PCT_THRESHOLD))).toBe(false);
    // A few seconds in is not worth resuming.
    expect(isEpisodeResumable(resume(0.5, 6))).toBe(false);
  });
});
