/**
 * @test-id MOBILE-SHELL-LIBRARY-FILTER-PICKER-001
 * @level component
 * @why UX-LIST-01: a list that depends on the library (genres, actors, the facets) never spreads in full inside the
 *   phone's Filter sheet. Up to MOBILE_FILTER_CHIP_LIMIT choices it is plain chips; past it a search narrows the list,
 *   the picks stay on top, only the first MOBILE_FILTER_CHIP_LIMIT matches show and a "+N more" chip shows the rest in
 *   place. Badger mobile's LibraryScreen draws its genres, actors and facets with this picker inside the scrolling
 *   MobileLibrarySheet. Rendered with react-test-renderer: react-native is replaced by host-element stand-ins.
 *
 * @req UX-LIST-01[badger-mobile]
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
    colors: { accent: "#f5c518", bg: "#000000", border: "#333333", controlBorder: "#444444", surface: "#111111", text: "#ffffff", textDim: "#777777", textMuted: "#999999" },
    accentTextHex: "#1a1a1a",
  }),
}));

import { MOBILE_FILTER_CHIP_LIMIT, MobileLibraryFilterPicker, type MobileLibraryChoice } from "../src/components/mobile-library-row";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SUITE = "[MOBILE-SHELL-LIBRARY-FILTER-PICKER-001]";
let tree: ReactTestRenderer | null = null;
let picked: string[] = [];

const text = (node: ReactTestInstance | string): string => (typeof node === "string" ? node : node.children.map(text).join(""));
const host = (n: ReactTestInstance, type: string) => (n.type as unknown) === type;
const chips = () => tree!.root.findAll((n) => host(n, "Pressable")).map(text);
const search = () => tree!.root.findAll((n) => host(n, "TextInput"));

const actors = (count: number): MobileLibraryChoice[] =>
  Array.from({ length: count }, (_, i) => ({ value: `actor-${i + 1}`, label: `Actor ${String(i + 1).padStart(2, "0")}` }));

const mount = (options: MobileLibraryChoice[], selected: string[] = []) => {
  picked = selected;
  const render = () => (
    <MobileLibraryFilterPicker
      options={options}
      selected={picked}
      onChange={(next) => {
        picked = next;
        act(() => tree!.update(render()));
      }}
      searchPlaceholder="Search actors"
      emptyText="No actors"
      moreLabel={(count) => `+${count} more`}
      testID="library-actors-picker"
    />
  );
  act(() => {
    tree = create(render());
  });
};

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe(`${SUITE} UX-LIST-01: library-driven filter lists stay short in the phone's Filter sheet`, () => {
  it(`${SUITE} a list up to the limit shows every choice as a chip and no search`, () => {
    mount(actors(MOBILE_FILTER_CHIP_LIMIT));
    expect(MOBILE_FILTER_CHIP_LIMIT).toBe(15);
    expect(chips()).toHaveLength(15);
    expect(search()).toHaveLength(0);
  });

  it(`${SUITE} a longer list shows a search, the first 15 choices and a "+N more" chip that shows the rest in place`, () => {
    mount(actors(40));
    expect(search()).toHaveLength(1);
    expect(search()[0]!.props.testID).toBe("library-actors-picker-search");
    const shown = chips();
    expect(shown).toHaveLength(16);
    expect(shown.slice(0, 15)).toEqual(actors(15).map((a) => a.label));
    expect(shown[15]).toBe("+25 more");

    const more = tree!.root.find((n) => host(n, "Pressable") && n.props.testID === "library-filter-more");
    act(() => more.props.onPress());
    expect(chips()).toHaveLength(40);
    expect(chips()).not.toContain("+25 more");
  });

  it(`${SUITE} the search narrows the chips and the picks stay on top`, () => {
    mount(actors(40), ["actor-33"]);
    expect(chips()[0]).toBe("Actor 33");
    act(() => search()[0]!.props.onChangeText("actor 1"));
    // Actor 10–19 match ("Actor 01" does not contain "actor 1"); the pick stays first whatever the query.
    expect(chips()).toEqual(["Actor 33", ...Array.from({ length: 10 }, (_, i) => `Actor ${10 + i}`)]);
  });
});
