/**
 * @test-id MOBILE-PLAYBACK-AUTOPLAY-NEXT-EPISODE-001
 * @level unit
 *
 * PLAY-NEXT-01: when an episode ends the next one starts automatically; on by default, switched off in
 * Settings. The pure decision lives in `getNextPlayableEpisode` (WHICH episode starts) and in the
 * end-of-media branch of `selectPillAction` / `stepAutoSkip` (WHETHER it starts by itself: the
 * "Next episode will start in" pre-roll fires only when autoplay is on). The final end-of-file card
 * in `PlayerScreen` (`countdown: settings.autoplayNextEpisode ? N : null`) is inline in the screen and
 * is not covered here.
 */
import { describe, expect, it } from "vitest";
import { getNextPlayableEpisode } from "@space/shared/playableEpisodes";
import {
  AUTO_SKIP_DELAY_SECONDS,
  createAutoSkipState,
  END_OF_MEDIA_KEY,
  selectPillAction,
  stepAutoSkip,
  type PillConfig,
} from "../src/lib/playback/skipMarkers";

type Media = Parameters<typeof getNextPlayableEpisode>[0];

const DURATION = 1400;

/** A tv show with `count` playable episodes of season 1 (every episode has a file, format and audio track). */
const show = (count: number): Media => {
  const numbers = Array.from({ length: count }, (_, i) => i + 1);
  return {
    type: "tv",
    episodes: numbers.map((n) => ({ id: `ep-${n}`, seasonNumber: 1, episodeNumber: n, name: `Episode ${n}` })),
    files: numbers.map((n) => ({ id: `file-${n}`, season: 1, episode: n })),
    formats: numbers.map((n) => ({ id: `fmt-${n}`, fileId: `file-${n}`, initKey: "init", chunks: [{ key: "c" }] })),
    audioTracks: numbers.map((n) => ({ id: `aud-${n}`, episodeId: `ep-${n}`, initKey: "init", chunks: [{ key: "c" }] })),
  } as unknown as Media;
};

/** No credits marker, so the end-of-media fallback is the only next-episode trigger. */
const config = (over: Partial<PillConfig> = {}): PillConfig => ({
  markers: [],
  hasNextEpisode: true,
  autoplayNextEpisode: true,
  autoSkipIntro: false,
  autoSkipCredits: true,
  ...over,
});

/** Plays one media-second per step from `from` to `to`; returns how many times the auto-start fired. */
const playThrough = (cfg: PillConfig, from: number, to: number) => {
  const state = createAutoSkipState();
  let fired = 0;
  let firedKey: string | null = null;
  for (let t = from; t <= to; t += 1) {
    const step = stepAutoSkip(state, { timePos: t, duration: DURATION, paused: false }, cfg);
    if (step.fire) {
      fired += 1;
      firedKey = step.action?.key ?? null;
    }
  }
  return { fired, firedKey };
};

describe("which episode autoplay starts", () => {
  // @req PLAY-NEXT-01[badger-mobile,badger-tv]
  it("is the next playable episode of the one that ended, crossing no gaps and stopping after the last", () => {
    const media = show(3);
    expect(getNextPlayableEpisode(media, "ep-1")?.id).toBe("ep-2");
    expect(getNextPlayableEpisode(media, "ep-2")?.id).toBe("ep-3");
    expect(getNextPlayableEpisode(media, "ep-3"), "the last episode has nothing to autoplay").toBeNull();
  });
});

describe("whether the next episode starts by itself at the end of an episode", () => {
  // @req PLAY-NEXT-01[badger-mobile,badger-tv]
  it("autoplay on: the end-of-media pill counts down and starts the next episode once, after the 5 s pre-roll", () => {
    const cfg = config({ autoplayNextEpisode: true });
    const pill = selectPillAction(DURATION - 10, DURATION, cfg);
    expect(pill).toMatchObject({ kind: "next_episode", endOfMediaFallback: true, autoSkip: true, countdown: 10 });
    // Playback crosses the 15 s boundary naturally (a seek straight into it would not auto-start).
    const { fired, firedKey } = playThrough(cfg, DURATION - 20, DURATION - 1);
    expect(fired).toBe(1);
    expect(firedKey).toBe(END_OF_MEDIA_KEY);
    expect(AUTO_SKIP_DELAY_SECONDS).toBe(5);
  });

  // @req PLAY-NEXT-01[badger-mobile,badger-tv]
  it("autoplay off: the pill is still offered to tap but has no countdown and never starts the next episode by itself", () => {
    const cfg = config({ autoplayNextEpisode: false, autoSkipCredits: true });
    const pill = selectPillAction(DURATION - 10, DURATION, cfg);
    expect(pill).toMatchObject({ kind: "next_episode", endOfMediaFallback: true, autoSkip: false, countdown: null });
    expect(playThrough(cfg, DURATION - 20, DURATION).fired).toBe(0);
  });

  // @req PLAY-NEXT-01[badger-mobile,badger-tv]
  it("the last episode (no next episode) never autostarts anything, autoplay on or off", () => {
    for (const autoplayNextEpisode of [true, false]) {
      const cfg = config({ autoplayNextEpisode, hasNextEpisode: false });
      expect(selectPillAction(DURATION - 10, DURATION, cfg)).toBeNull();
      expect(playThrough(cfg, DURATION - 20, DURATION).fired).toBe(0);
    }
  });

  // @req PLAY-NEXT-01[badger-mobile,badger-tv]
  it("nothing is offered before the final 15 s, so the next episode never starts mid-episode", () => {
    const cfg = config();
    expect(selectPillAction(DURATION - 16, DURATION, cfg)).toBeNull();
    expect(playThrough(cfg, 100, DURATION - 16).fired).toBe(0);
  });
});

describe("whether the next episode starts by itself from a credits marker", () => {
  const credits = [{ type: "credits" as const, startSeconds: 1300, endSeconds: 1400 }];

  // @req PLAY-NEXT-01[badger-mobile,badger-tv]
  it("autoplay on + auto-skip credits on: the credits pill starts the next episode once, after the 5 s pre-roll", () => {
    const cfg = config({ markers: credits, autoplayNextEpisode: true, autoSkipCredits: true });
    expect(selectPillAction(1310, DURATION, cfg)).toMatchObject({ kind: "next_episode", autoSkip: true });
    const { fired, firedKey } = playThrough(cfg, 1295, 1399);
    console.log("credits marker, autoplay on", { fired, firedKey });
    expect(fired).toBe(1);
  });

  // @req PLAY-NEXT-01[badger-mobile,badger-tv]
  it("autoplay off: the credits pill is still offered to tap but never starts the next episode by itself", () => {
    const cfg = config({ markers: credits, autoplayNextEpisode: false, autoSkipCredits: true });
    const pill = selectPillAction(1310, DURATION, cfg);
    const { fired, firedKey } = playThrough(cfg, 1295, 1399);
    console.log("credits marker, autoplay off", { pill, fired, firedKey });
    expect(pill).toMatchObject({ kind: "next_episode", autoSkip: false, countdown: null });
    expect(fired, "autoplay off must stop the credits pill from auto-starting the next episode").toBe(0);
  });

  // @req PLAY-NEXT-01[badger-mobile,badger-tv]
  it("autoplay off does not stop Skip credits on the last episode (that skips the credits, it starts no episode)", () => {
    const cfg = config({ markers: credits, hasNextEpisode: false, autoplayNextEpisode: false, autoSkipCredits: true });
    expect(selectPillAction(1310, DURATION, cfg)).toMatchObject({ kind: "skip_credits", autoSkip: true });
    expect(playThrough(cfg, 1295, 1399).fired).toBe(1);
  });
});
