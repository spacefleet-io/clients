/**
 * @test-id MOBILE-SHELL-LIBRARY-HEADER-001
 * @level component
 * @why Chris 2026-11-21 (morning review) picked layout A of the phone library header drafts for Badger and Parrot:
 *   the switch, Filter with a count badge and Sort on one row, as on desktop, still fitting at a large font size. The
 *   drafts' layouts B (labelled buttons on a second row) and C (one "Filter & sort" button, applied chips) are gone.
 *   Rendered with react-test-renderer: react-native is replaced by host-element stand-ins.
 *
 * @req UX-LIB-04
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
vi.mock("lucide-react-native", () => ({ ArrowDownUp: "icon:ArrowDownUp", ListFilter: "icon:ListFilter" }));
vi.mock("../src/components/mobile-bottom-sheet", () => ({ MobileBottomSheet: "MobileBottomSheet", MobileSheetScrollView: "MobileSheetScrollView" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#f5c518", bg: "#000000", border: "#333333", surface: "#111111", text: "#ffffff", textMuted: "#999999" },
    accentTextHex: "#1a1a1a",
  }),
}));

import { MobileLibraryHeader, MobileLibrarySegmented } from "../src/components/mobile-library-row";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SUITE = "[MOBILE-SHELL-LIBRARY-HEADER-001]";
let tree: ReactTestRenderer | null = null;

const flat = (style: unknown): Record<string, unknown> =>
  typeof style === "function"
    ? flat(style({ pressed: false }))
    : Array.isArray(style)
      ? Object.assign({}, ...style.flat(Infinity).filter(Boolean).map(flat))
      : ((style as Record<string, unknown>) ?? {});
const text = (node: ReactTestInstance | string): string => (typeof node === "string" ? node : node.children.map(text).join(""));
const byId = (id: string) => tree!.root.findAll((n) => typeof n.type === "string" && n.props.testID === id);

const calls = { filter: 0, sort: 0, clear: 0 };
const mount = (filterCount: number) => {
  calls.filter = calls.sort = calls.clear = 0;
  act(() => {
    tree = create(
      <MobileLibraryHeader
        switcher={
          <MobileLibrarySegmented
            options={[
              { id: "albums", label: "Albums", testID: "library-tab-albums" },
              { id: "artists", label: "Artists", testID: "library-tab-artists" },
              { id: "songs", label: "Songs", testID: "library-tab-songs" },
            ]}
            value="albums"
            onChange={() => undefined}
          />
        }
        counts={filterCount > 0 ? [{ n: 3, text: "3 of 14 albums" }] : [{ n: 14, text: "14 albums" }, { n: 153, text: "153 songs" }]}
        filterCount={filterCount}
        onOpenFilter={() => void calls.filter++}
        onOpenSort={() => void calls.sort++}
        onClear={() => void calls.clear++}
        labels={{ filter: "Filter", sort: "Sort", clear: "Clear", filterActive: (count) => `Filter, ${count} on` }}
      />,
    );
  });
  return tree!;
};

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe("the phone library header is layout A (UX-LIB-04)", () => {
  it("@req UX-LIB-04 one row holds the switch, then Filter, then Sort; the counts sit on the line under it", () => {
    mount(0);
    const [header] = byId("library-header");
    const [row, under] = header!.children as ReactTestInstance[];
    const rowParts = (row!.children as ReactTestInstance[]).map((child) =>
      child.props.testID ?? (child.findAll((n) => n.props.testID === "library-tabs").length > 0 ? "switch" : String(child.type)),
    );
    console.info(SUITE, "row", JSON.stringify({ rowParts, rowStyle: flat(row!.props.style), counts: text(byId("library-counts")[0]!) }));
    expect(flat(row!.props.style)).toMatchObject({ flexDirection: "row" });
    expect(rowParts).toEqual(["switch", "library-filter-button", "library-sort-button"]);
    expect(under!.findAll((n) => n.props.testID === "library-counts")).toHaveLength(1);
    expect(text(byId("library-counts")[0]!)).toBe("14 albums  ·  153 songs");
    // Icon buttons only: no "Filter & sort" button, no labelled buttons, no applied-pick chips (layouts B and C).
    expect(byId("library-applied-chip")).toHaveLength(0);
    for (const id of ["library-filter-button", "library-sort-button"]) expect(byId(id)[0]!.findAll((n) => String(n.type) === "Text")).toHaveLength(0);
    expect(byId("library-filter-button")[0]!.findAll((n) => String(n.type) === "icon:ListFilter")).toHaveLength(1);
    expect(byId("library-sort-button")[0]!.findAll((n) => String(n.type) === "icon:ArrowDownUp")).toHaveLength(1);
    expect(byId("library-filter-button-badge")).toHaveLength(0);
    expect(byId("library-filter-clear")).toHaveLength(0);
    expect(byId("library-filter-button")[0]!.props.accessibilityLabel).toBe("Filter");
  });

  it("@req UX-LIB-04 with filters on, Filter is filled in the accent with the count in a badge, and Clear drops them", () => {
    mount(2);
    const filter = byId("library-filter-button")[0]!;
    const badge = byId("library-filter-button-badge")[0]!;
    console.info(SUITE, "active", JSON.stringify({ style: flat(filter.props.style), label: filter.props.accessibilityLabel, badge: text(badge), badgeStyle: flat(badge.props.style) }));
    expect(flat(filter.props.style)).toMatchObject({ backgroundColor: "#f5c518", borderColor: "#f5c518" });
    expect(filter.props.accessibilityLabel).toBe("Filter, 2 on");
    expect(text(badge)).toBe("2");
    expect(flat(badge.props.style)).toMatchObject({ position: "absolute", backgroundColor: "#ffffff" });
    expect(text(byId("library-counts")[0]!)).toBe("3 of 14 albums");
    act(() => byId("library-filter-clear")[0]!.props.onPress());
    act(() => filter.props.onPress());
    act(() => byId("library-sort-button")[0]!.props.onPress());
    expect(calls).toEqual({ filter: 1, sort: 1, clear: 1 });
  });

  // Contract changed on purpose (fix/staging-red-tests): the badge was capped at 1.5x, which UX-A11Y-05 forbids; UX-LIB-04
  // now has the badge grow with the phone's text size, uncapped.
  it("@req UX-LIB-04 at a large font size the buttons keep their size, the badge grows with the text uncapped and each tab sizes to its label", () => {
    mount(12);
    const sizes = ["library-filter-button", "library-sort-button"].map((id) => flat(byId(id)[0]!.props.style));
    const badge = byId("library-filter-button-badge")[0]!;
    const badgeText = badge.findByType("Text" as never);
    const tab = byId("library-tab-albums")[0]!;
    console.info(SUITE, "large text", JSON.stringify({ sizes, badge: flat(badge.props.style), badgeText: { maxFontSizeMultiplier: badgeText.props.maxFontSizeMultiplier, allowFontScaling: badgeText.props.allowFontScaling }, tab: flat(tab.props.style) }));
    for (const size of sizes) expect(size).toMatchObject({ width: 42, height: 42 });
    expect(badgeText.props.maxFontSizeMultiplier).toBeUndefined();
    expect(badgeText.props.allowFontScaling).toBeUndefined();
    // A pill whatever height the text gives it.
    expect(flat(badge.props.style).borderRadius).toBeGreaterThanOrEqual(999);
    // The badge grows with a two-digit count and its text instead of clipping it.
    expect(flat(badge.props.style)).toMatchObject({ minWidth: 19, minHeight: 19 });
    expect(flat(badge.props.style).height).toBeUndefined();
    expect(flat(tab.props.style)).toMatchObject({ flexGrow: 1, flexShrink: 1, flexBasis: "auto" });
    expect(tab.findByType("Text" as never).props.numberOfLines).toBe(1);
  });
});
