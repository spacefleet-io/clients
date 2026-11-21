/**
 * TV rail and grid geometry. TV-SCALE-LAYOUT-001 (UX-TV-13): an Apple TV reports 1920x1080 points for the screen Android
 * TV reports as 960x540 dp, so the layout was drawn at half size there (Chris 2026-11-06: "the font is way too small").
 * The geometry is the 960x540 design at the window's scale: exactly twice as big at 1920x1080, the same columns.
 *
 * @req UX-TV-13[badger-tv]
 */
import { describe, expect, it, vi } from "vitest";
import {
  TV_CARD_GAP,
  TV_LIBRARY_COLUMNS,
  TV_LIBRARY_GAP_X,
  TV_PANEL_CONTENT_X,
  TV_SAFE_MARGIN_X,
  TV_SCREEN_X,
  tvGridColumns,
  tvHomeCardWidth,
  tvLibraryCardWidth,
  tvRailCardWidth,
} from "../src/tv/layout";
import { scaleStyle, scaleStyleSheet } from "@space/shared/uiScale";
import { tvScaleForWindow } from "../src/tv/tvScale";

// tvScale.ts also holds the hooks, which read the window from react-native; these tests only use its pure functions.
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: 960, height: 540 }),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Platform: { OS: "android", isTV: true },
}));

describe("TV layout", () => {
  it("[TV-SHELL-LAYOUT-001] about five and a half cards are visible across a 1080p rail", () => {
    console.info("[TV-SHELL-LAYOUT-001] phase=start");
    const width = tvRailCardWidth(960, 1); // 1920px at density 2
    console.info("[TV-SHELL-LAYOUT-001] phase=width", width);
    const visible = (960 - TV_SAFE_MARGIN_X) / (width + TV_CARD_GAP);
    expect(visible).toBeGreaterThan(5.3);
    expect(visible).toBeLessThan(5.7);
  });

  it("[TV-SHELL-LAYOUT-002] card width stays within the readable bounds on tiny and huge windows", () => {
    console.info("[TV-SHELL-LAYOUT-002] phase=start");
    expect(tvRailCardWidth(200, 1)).toBe(110);
    expect(tvRailCardWidth(5000, 1)).toBe(260);
  });

  it("[TV-SHELL-LAYOUT-003] the grid has at least one column and its cards fit inside the panel, inside the safe margins", () => {
    console.info("[TV-SHELL-LAYOUT-003] phase=start");
    for (const windowWidth of [100, 640, 960, 1280, 1920]) {
      const columns = tvGridColumns(windowWidth, 1);
      const cardWidth = tvRailCardWidth(windowWidth, 1);
      const used = columns * cardWidth + (columns - 1) * TV_CARD_GAP;
      console.info("[TV-SHELL-LAYOUT-003] phase=grid", { windowWidth, columns, used });
      expect(columns).toBeGreaterThanOrEqual(1);
      if (columns > 1) expect(used).toBeLessThanOrEqual(windowWidth - Math.max(TV_SAFE_MARGIN_X, TV_PANEL_CONTENT_X) * 2);
    }
  });
});

describe("TV scale (TV-SCALE-LAYOUT-001)", () => {
  it("@req UX-TV-13 Android TV's 960x540 dp window is the design (scale 1); an Apple TV's 1920x1080 points is scale 2", () => {
    const cases = [
      [960, 540, 1],
      [1920, 1080, 2],
      [1280, 720, 1280 / 960],
      [3840, 2160, 4],
      [1920, 540, 1],
      [100, 100, 0.5],
    ] as const;
    for (const [width, height, expected] of cases) {
      const scale = tvScaleForWindow(width, height);
      console.info("[TV-SCALE-LAYOUT-001] phase=scale", { width, height, scale });
      expect(scale).toBeCloseTo(expected, 10);
    }
    expect(tvScaleForWindow(0, 0)).toBe(1);
  });

  it("@req UX-TV-13 a rail card and the grid on a 1920x1080-point window are the 960x540 ones at twice the size", () => {
    const androidCard = tvRailCardWidth(960, tvScaleForWindow(960, 540));
    const appleCard = tvRailCardWidth(1920, tvScaleForWindow(1920, 1080));
    const androidColumns = tvGridColumns(960, 1);
    const appleColumns = tvGridColumns(1920, 2);
    console.info("[TV-SCALE-LAYOUT-001] phase=geometry", { androidCard, appleCard, androidColumns, appleColumns });
    expect(androidCard).toBe(150);
    expect(appleCard).toBe(androidCard * 2);
    expect(appleColumns).toBe(androidColumns);
    // The visible share of the rail is the same on both: about five and a half cards.
    const appleVisible = (1920 - TV_SAFE_MARGIN_X * 2) / (appleCard + TV_CARD_GAP * 2);
    const androidVisible = (960 - TV_SAFE_MARGIN_X) / (androidCard + TV_CARD_GAP);
    expect(appleVisible).toBeCloseTo(androidVisible, 10);
    // The card bounds scale too: a huge Apple TV window no longer caps the card at the dp maximum.
    expect(tvRailCardWidth(10000, 2)).toBe(520);
    expect(tvRailCardWidth(400, 2)).toBe(220);
    // The grid's margins: what is left either side of the columns doubles.
    const androidLeft = 960 - (androidColumns * androidCard + (androidColumns - 1) * TV_CARD_GAP);
    const appleLeft = 1920 - (appleColumns * appleCard + (appleColumns - 1) * TV_CARD_GAP * 2);
    console.info("[TV-SCALE-LAYOUT-001] phase=margins", { androidLeft, appleLeft });
    expect(appleLeft).toBe(androidLeft * 2);
  });

  it("@req UX-TV-13 a style sheet keeps its sizes at scale 1 and doubles every length at scale 2, nothing else", () => {
    const sheet = {
      box: {
        flex: 1,
        opacity: 0.4,
        zIndex: 3,
        width: "100%",
        padding: 8,
        marginHorizontal: 32,
        gap: 6,
        borderRadius: 6,
        borderWidth: 1,
        fontSize: 14,
        lineHeight: 18,
        letterSpacing: 1.32,
        fontWeight: "900",
        shadowOffset: { width: 0, height: 4 },
        shadowRadius: 10,
        transform: [{ scale: 1.06 }, { translateY: -2 }],
      },
    };
    const same = scaleStyleSheet(sheet, 1);
    const doubled = scaleStyleSheet(sheet, 2);
    console.info("[TV-SCALE-LAYOUT-001] phase=sheet", JSON.stringify({ same, doubled }));
    expect(same).toBe(sheet);
    expect(scaleStyleSheet(sheet, 2)).toBe(doubled);
    expect(doubled.box).toEqual({
      flex: 1,
      opacity: 0.4,
      zIndex: 3,
      width: "100%",
      padding: 16,
      marginHorizontal: 64,
      gap: 12,
      borderRadius: 12,
      borderWidth: 2,
      fontSize: 28,
      lineHeight: 36,
      letterSpacing: 2.64,
      fontWeight: "900",
      shadowOffset: { width: 0, height: 8 },
      shadowRadius: 20,
      transform: [{ scale: 1.06 }, { translateY: -4 }],
    });
    expect(scaleStyle([{ height: 4 }, false, null, [{ marginTop: 6 }]], 2)).toEqual([{ height: 8 }, false, null, [{ marginTop: 12 }]]);
  });
});

describe("TV Home and Library posters (v2 redesign, UX-TV-05, UX-TV-11)", () => {
  it("@req UX-TV-05 Home's posters are 107 dp wide (the mockup's 214 px row), twice that on an Apple TV", () => {
    expect(tvHomeCardWidth(1)).toBe(107);
    expect(tvHomeCardWidth(2)).toBe(214);
  });

  it("@req UX-TV-11 eight Library posters fill the room between the 36 dp margins, and keep fitting at scale 2", () => {
    for (const [windowWidth, scale] of [
      [960, 1],
      [1920, 2],
      [1280, 1],
    ] as const) {
      const width = tvLibraryCardWidth(windowWidth, scale);
      const row = TV_LIBRARY_COLUMNS * width + (TV_LIBRARY_COLUMNS - 1) * TV_LIBRARY_GAP_X * scale;
      console.info("[UX-TV-11] library card", JSON.stringify({ windowWidth, scale, width, row }));
      expect(row).toBeLessThanOrEqual(windowWidth - TV_SCREEN_X * 2 * scale);
      expect(row + TV_LIBRARY_COLUMNS).toBeGreaterThan(windowWidth - TV_SCREEN_X * 2 * scale);
    }
    expect(tvLibraryCardWidth(960, 1)).toBe(96);
    expect(tvLibraryCardWidth(1920, 2)).toBe(192);
  });
});
