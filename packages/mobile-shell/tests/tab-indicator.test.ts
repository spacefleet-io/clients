import { describe, expect, it } from "vitest";
import { tabIndicatorCenter } from "../src/components/mobile-tab-bar-geometry";

// @bugfix @regression-proof
// The active-tab dot was positioned as a percentage of the full bar width,
// ignoring the bar's horizontal padding, so it drifted off the icon (left of
// the first tab, right of the last). It must sit on the centre of the tab slot.
describe("tabIndicatorCenter", () => {
  const width = 1080;
  const padding = 12;

  it("centres the dot on each tab slot inside the bar padding", () => {
    const slot = (width - padding * 2) / 3;
    expect(tabIndicatorCenter({ width, padding, count: 3, index: 0 })).toBeCloseTo(padding + slot / 2);
    expect(tabIndicatorCenter({ width, padding, count: 3, index: 1 })).toBeCloseTo(width / 2);
    expect(tabIndicatorCenter({ width, padding, count: 3, index: 2 })).toBeCloseTo(width - padding - slot / 2);
  });

  it("is symmetric: first and last tabs sit equally far from their edges", () => {
    const first = tabIndicatorCenter({ width, padding, count: 4, index: 0 });
    const last = tabIndicatorCenter({ width, padding, count: 4, index: 3 });
    expect(first).toBeCloseTo(width - last);
  });
});
