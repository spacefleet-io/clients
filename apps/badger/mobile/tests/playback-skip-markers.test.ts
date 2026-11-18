import { describe, expect, it } from "vitest";
import {
  AUTO_SKIP_DELAY_SECONDS,
  createAutoSkipState,
  selectPillAction,
  stepAutoSkip,
  suppressAutoSkip,
  type PillConfig,
} from "../src/lib/playback/skipMarkers";

const config = (over: Partial<PillConfig> = {}): PillConfig => ({
  markers: [
    { type: "intro", startSeconds: 30, endSeconds: 90 },
    { type: "credits", startSeconds: 1300, endSeconds: 1400 },
  ],
  hasNextEpisode: true,
  autoplayNextEpisode: true,
  autoSkipIntro: false,
  autoSkipCredits: false,
  ...over,
});

// @req PLAY-NEXT-02[badger-mobile,badger-tv]
describe("selectPillAction", () => {
  it("shows nothing outside markers", () => {
    expect(selectPillAction(10, 1400, config())).toBeNull();
  });
  it("shows Skip intro inside the intro and seeks to its end", () => {
    const pill = selectPillAction(40, 1400, config());
    expect(pill?.kind).toBe("skip_intro");
    expect(pill?.seekToSeconds).toBe(90);
  });
  it("credits with a next episode become Next episode", () => {
    expect(selectPillAction(1310, 1400, config())?.kind).toBe("next_episode");
  });
  it("credits without a next episode are Skip credits", () => {
    const pill = selectPillAction(1310, 1400, config({ hasNextEpisode: false }));
    expect(pill?.kind).toBe("skip_credits");
    expect(pill?.seekToSeconds).toBe(1400);
  });
  it("falls back to end-of-media for the next episode when there is no credits marker", () => {
    const pill = selectPillAction(1390, 1400, config({ markers: [] }));
    expect(pill?.kind).toBe("next_episode");
    expect(pill?.endOfMediaFallback).toBe(true);
  });
});

describe("stepAutoSkip", () => {
  it("fires once after 5 s of media time inside the intro", () => {
    const state = createAutoSkipState();
    const cfg = config({ autoSkipIntro: true });
    let fired = 0;
    stepAutoSkip(state, { timePos: 29, duration: 1400, paused: false }, cfg);
    let t = 29;
    for (let i = 0; i < 20; i++) {
      t += 1;
      const step = stepAutoSkip(state, { timePos: t, duration: 1400, paused: false }, cfg);
      if (step.fire) fired += 1;
    }
    expect(fired).toBe(1);
    console.info(`playback-skip-markers: auto-skip fired after ${AUTO_SKIP_DELAY_SECONDS}s of media time`);
  });
  it("does not count paused time", () => {
    const state = createAutoSkipState();
    const cfg = config({ autoSkipIntro: true });
    stepAutoSkip(state, { timePos: 29, duration: 1400, paused: false }, cfg);
    for (let i = 0; i < 10; i++) {
      expect(stepAutoSkip(state, { timePos: 31, duration: 1400, paused: true }, cfg).fire).toBe(false);
    }
  });
  it("@bugfix @regression-proof does not auto-skip when a seek lands mid-marker from before it", () => {
    const state = createAutoSkipState();
    const cfg = config({ autoSkipIntro: true });
    stepAutoSkip(state, { timePos: 5, duration: 1400, paused: false }, cfg);
    for (let t = 60; t < 80; t++) {
      expect(stepAutoSkip(state, { timePos: t, duration: 1400, paused: false }, cfg).fire).toBe(false);
    }
  });
  it("never fires after the user suppressed it", () => {
    const state = createAutoSkipState();
    const cfg = config({ autoSkipIntro: true });
    stepAutoSkip(state, { timePos: 29, duration: 1400, paused: false }, cfg);
    const first = stepAutoSkip(state, { timePos: 31, duration: 1400, paused: false }, cfg);
    suppressAutoSkip(state, first.action!.key);
    for (let t = 32; t < 60; t++) {
      expect(stepAutoSkip(state, { timePos: t, duration: 1400, paused: false }, cfg).fire).toBe(false);
    }
  });
  it("does not auto-fire when the setting is off", () => {
    const state = createAutoSkipState();
    for (let t = 29; t < 80; t++) {
      expect(stepAutoSkip(state, { timePos: t, duration: 1400, paused: false }, config()).fire).toBe(false);
    }
  });
});
