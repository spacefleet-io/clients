/**
 * @test-id MPV-SHEETSCROLL-001
 * @level unit
 * @why UX-TV-01 (issue 2754): a TV track menu opens with the focus on the selected row. When that row sits below the
 *   menu's first screenful (a 20th subtitle track), the menu must scroll to it, or the focus ring is off screen and the
 *   user sees no focus at all. `selectedRowScrollY` is the offset `PlayerControls.tsx` scrolls the menu to on TV.
 */
import { describe, expect, it } from "vitest";
import { selectedRowScrollY } from "../src/trackRows";

describe("selectedRowScrollY", () => {
  it("leaves the menu at the top when the selected row is already in view", () => {
    expect(selectedRowScrollY({ y: 0, height: 60 }, 400)).toBeNull();
    expect(selectedRowScrollY({ y: 340, height: 60 }, 400)).toBeNull();
  });

  it("scrolls a row below the fold to the middle of the menu", () => {
    // 20th row of 60 px in a 400 px menu: its top at 1140, centred = 1140 - (400 - 60) / 2.
    expect(selectedRowScrollY({ y: 1140, height: 60 }, 400)).toBe(970);
  });

  it("scrolls a row cut by the bottom edge", () => {
    expect(selectedRowScrollY({ y: 360, height: 60 }, 400)).toBe(190);
  });

  it("does nothing until the menu has a height", () => {
    expect(selectedRowScrollY({ y: 1140, height: 60 }, 0)).toBeNull();
  });
});
