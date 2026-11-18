import { afterEach, describe, expect, it, vi } from "vitest";
import { isDoubleTap, isVerticalSwipe, levelAfterSwipe, surfaceTap, swipeTarget } from "../src/gestures";

describe("player slide gestures", () => {
  it("left half is brightness, right half is volume", () => {
    expect(swipeTarget(100, 1000)).toBe("brightness");
    expect(swipeTarget(499, 1000)).toBe("brightness");
    expect(swipeTarget(500, 1000)).toBe("volume");
  });

  it("only clear vertical moves count as slides, so taps and double taps still reach the surface", () => {
    expect(isVerticalSwipe(0, 8)).toBe(false);
    expect(isVerticalSwipe(20, 25)).toBe(false);
    expect(isVerticalSwipe(5, -30)).toBe(true);
  });

  it("sliding up raises the level, down lowers it, clamped to mute..max", () => {
    // 1000 px tall player: a full sweep is 700 px.
    expect(levelAfterSwipe(0.5, -350, 1000)).toBeCloseTo(1);
    expect(levelAfterSwipe(0.5, 350, 1000)).toBeCloseTo(0);
    expect(levelAfterSwipe(0.2, -70, 1000)).toBeCloseTo(0.3);
    expect(levelAfterSwipe(0.9, -2000, 1000)).toBe(1);
    expect(levelAfterSwipe(0.1, 2000, 1000)).toBe(0);
  });
});

describe("double tap", () => {
  afterEach(() => vi.useRealTimers());

  /** @bugfix @regression-proof On the phone a double tap whose second press came ~220 ms after the first release never seeked:
   * the player compared release-to-release times as JS handled them (Date.now), and a stalled JS thread or a 40 ms+ press
   * pushed that past 300 ms. Android's rule is first release -> second press, on the touch events' own timestamps. */
  it("times taps by when the finger touched, not when a stalled JS thread got round to them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const first = surfaceTap({ locationX: 900, downAt: 5_000, upAt: 5_040 }, 1000);
    vi.setSystemTime(10_450);
    const second = surfaceTap({ locationX: 920, downAt: 5_260, upAt: 5_380 }, 1000);
    expect(isDoubleTap(first, second)).toBe(true);
  });

  it("needs the same half and a second press within 300 ms of the first release", () => {
    const right = surfaceTap({ locationX: 900, downAt: 0, upAt: 50 }, 1000);
    expect(isDoubleTap(right, surfaceTap({ locationX: 100, downAt: 150, upAt: 200 }, 1000))).toBe(false);
    expect(isDoubleTap(right, surfaceTap({ locationX: 900, downAt: 351, upAt: 400 }, 1000))).toBe(false);
    expect(isDoubleTap(null, right)).toBe(false);
    expect(surfaceTap({ locationX: 100, downAt: 0, upAt: 0 }, 1000).side).toBe("left");
  });
});
