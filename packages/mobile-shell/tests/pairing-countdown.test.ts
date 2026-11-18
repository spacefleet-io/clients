/**
 * @test-id TV-PAIR-COUNTDOWN-001
 * @level unit
 * @why The sign-in screen counts down to the code's expiry; a negative or malformed "m:ss" would look broken.
 */
import { describe, expect, it } from "vitest";
import { formatCountdown } from "../src/pairing";

describe("pairing countdown", () => {
  it.each([
    [600_000, "10:00"],
    [65_000, "1:05"],
    [9_000, "0:09"],
    [999, "0:01"],
    [0, "0:00"],
    [-5_000, "0:00"],
  ])("shows %i ms as %s", (ms, expected) => {
    const shown = formatCountdown(ms);
    console.info("[tv-countdown:state]", { ms, shown, expected });
    expect(shown).toBe(expected);
  });
});
