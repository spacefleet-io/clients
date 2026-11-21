import { describe, expect, it } from "vitest";
import { isPreferredFocus, preferredFocusTarget, railScrollOffset } from "./focusOrder";

describe("TV focus order", () => {
  it("[TV-SHELL-FOCUS-001] the first card of the first non-empty rail takes the initial focus", () => {
    console.info("[TV-SHELL-FOCUS-001] phase=start");
    const rails = [{ items: [] }, { items: ["a", "b"] }, { items: ["c"] }];
    const target = preferredFocusTarget(rails);
    console.info("[TV-SHELL-FOCUS-001] phase=target", target);
    expect(target).toEqual({ railIndex: 1, itemIndex: 0 });
    expect(isPreferredFocus(target, 1, 0)).toBe(true);
    expect(isPreferredFocus(target, 1, 1)).toBe(false);
    expect(isPreferredFocus(target, 0, 0)).toBe(false);
    expect(isPreferredFocus(target, 2, 0)).toBe(false);
  });

  it("[TV-SHELL-FOCUS-002] there is no preferred card when no rail has titles", () => {
    console.info("[TV-SHELL-FOCUS-002] phase=start");
    expect(preferredFocusTarget([])).toBeNull();
    expect(preferredFocusTarget([{ items: [] }])).toBeNull();
    expect(isPreferredFocus(null, 0, 0)).toBe(false);
  });

  it("[TV-SHELL-FOCUS-003] a rail keeps the focused card second from the left and never scrolls past its ends", () => {
    console.info("[TV-SHELL-FOCUS-003] phase=start");
    const base = { itemLength: 100, itemCount: 12, viewportWidth: 500 };
    const offsets = [0, 1, 2, 5, 11].map((focusedIndex) => railScrollOffset({ ...base, focusedIndex }));
    console.info("[TV-SHELL-FOCUS-003] phase=offsets", offsets);
    // First two cards: no scroll; middle: previous card peeks; last: clamped to the end (12 * 100 - 500).
    expect(offsets).toEqual([0, 0, 100, 400, 700]);
  });

  it("[TV-SHELL-FOCUS-004] a rail shorter than the viewport never scrolls", () => {
    console.info("[TV-SHELL-FOCUS-004] phase=start");
    expect(railScrollOffset({ focusedIndex: 3, itemLength: 100, itemCount: 4, viewportWidth: 800 })).toBe(0);
  });
});
