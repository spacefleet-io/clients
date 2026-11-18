/**
 * @test-id MOBILE-CAST-008
 * @level unit
 * @why The cast screen has no ±10 s buttons any more (UX-TV-03, Chris 2026-11-09): a double tap on the left or right half
 *   of its touch pad seeks, with the player's double-tap rule. Pins which side seeks which way and that a third tap starts
 *   a new pair instead of seeking again.
 */
import { describe, expect, it } from "vitest";
import { DOUBLE_TAP_MS, levelAfterSwipe } from "@space/mobile-mpv-playback/gestures";
import { castPadTap } from "../src/lib/cast/castGestures";

const WIDTH = 400;
const tap = (x: number, downAt: number) => ({ locationX: x, downAt, upAt: downAt + 60 });

describe("castPadTap", () => {
  it("does not seek on a single tap and remembers it", () => {
    const first = castPadTap(null, tap(50, 1000), WIDTH);
    expect(first.seek).toBeNull();
    expect(first.last?.side).toBe("left");
  });

  it("seeks back on a left double tap and forward on a right one", () => {
    const left = castPadTap(castPadTap(null, tap(50, 1000), WIDTH).last, tap(60, 1200), WIDTH);
    expect(left.seek).toBe(-1);
    const right = castPadTap(castPadTap(null, tap(350, 1000), WIDTH).last, tap(340, 1200), WIDTH);
    expect(right.seek).toBe(1);
  });

  it("clears the pair after a double tap, so a third tap does not seek again", () => {
    const second = castPadTap(castPadTap(null, tap(350, 1000), WIDTH).last, tap(350, 1200), WIDTH);
    expect(second.last).toBeNull();
    expect(castPadTap(second.last, tap(350, 1400), WIDTH).seek).toBeNull();
  });

  it("does not seek when the halves differ or the second tap comes too late", () => {
    expect(castPadTap(castPadTap(null, tap(50, 1000), WIDTH).last, tap(350, 1200), WIDTH).seek).toBeNull();
    expect(castPadTap(castPadTap(null, tap(50, 1000), WIDTH).last, tap(50, 1060 + DOUBLE_TAP_MS + 1), WIDTH).seek).toBeNull();
  });
});

describe("pad volume slide", () => {
  it("raises the volume when sliding up and lowers it when sliding down, within 0..1", () => {
    expect(levelAfterSwipe(0.5, -100, 800)).toBeGreaterThan(0.5);
    expect(levelAfterSwipe(0.5, 100, 800)).toBeLessThan(0.5);
    expect(levelAfterSwipe(0.9, -2000, 800)).toBe(1);
  });
});
