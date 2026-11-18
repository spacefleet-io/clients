import { describe, expect, test } from "vitest";
import { clampLevel, levelAt, percentOf, stepLevel } from "../src/level";

// @req PAR-PLAY-05
describe("volume slider maths (PAR-PLAY-05)", () => {
  test("a finger on the track maps left→0, right→1, clamped outside", () => {
    const cases: [number, number, number][] = [[0, 300, 0], [150, 300, 0.5], [300, 300, 1], [-40, 300, 0], [400, 300, 1], [10, 0, 0]];
    for (const [x, w, want] of cases) {
      console.info("levelAt", { x, w, got: levelAt(x, w), want });
      expect(levelAt(x, w)).toBeCloseTo(want);
    }
  });

  test("an accessibility step moves one stream step and stops at the ends", () => {
    expect(stepLevel(0.5, 1, 1 / 15)).toBeCloseTo(0.567, 3);
    expect(stepLevel(0.98, 1, 1 / 15)).toBe(1);
    expect(stepLevel(0.02, -1, 1 / 15)).toBe(0);
  });

  test("bad input never leaves 0..1", () => {
    expect(clampLevel(Number.NaN)).toBe(0);
    expect(clampLevel(2)).toBe(1);
    expect(percentOf(0.333)).toBe(33);
  });
});
