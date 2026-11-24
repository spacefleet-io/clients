/**
 * @test-id MOBILE-SHELL-TV-CARD-ROW-001
 * @level unit
 * @why Quality audit #3350 S58: Badger TV's Home rail and Parrot TV's rows of cards were two copies of one row. Both apps
 *   now draw `TvCardRow`, so the row's focus guide (TV-RAIL-FOCUS-001: Up or Down into a row lands on its last focused
 *   card), its "See all" path, its self-scroll and its per-card crash boundary are checked here once for both.
 *   Rendered with react-test-renderer: react-native is replaced by host-element stand-ins.
 *
 * @req UX-TV-01[badger-tv]
 * @req PAR-TV-03[parrot-tv]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ scrolls: [] as number[] }));

vi.mock("react-native", async () => {
  // vi.mock factories run before the file's imports, so React is loaded here.
  const react = await import("react");
  const FlatList = react.forwardRef((props: Record<string, unknown>, ref) => {
    react.useImperativeHandle(ref, () => ({ scrollToOffset: ({ offset }: { offset: number }) => void h.scrolls.push(offset) }));
    return react.createElement("FlatList", props);
  });
  return {
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: "View",
    Text: "Text",
    TVFocusGuideView: "TVFocusGuideView",
    FlatList,
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
vi.mock("../src/components", () => ({ SkyCover: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../src/components/mobile-render-boundary", () => ({
  MobileRenderBoundary: ({ name, children }: { name: string; children: () => React.ReactNode }) => React.createElement("Boundary", { name }, children()),
}));
vi.mock("../src/tv/TvFocusable", () => ({ TvFocusable: "TvFocusable" }));
vi.mock("../src/tv/TvText", () => ({ TvTitle: "TvTitle" }));
vi.mock("../src/tv/tokens", () => ({ TV_SPACE: { screenX: 36, headingGap: 11 }, TV_TYPE: { body: { fontFamily: "body" } }, TV_COLOR: { muted: "#999" } }));
vi.mock("@space/shared/uiScale", () => ({ scaleStyleSheet: <T,>(styles: T) => styles }));

import { TV_CARD_GROW_ROOM, TvCardRow } from "../src/tv/TvCardRow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Item = { id: string };
const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
const isType = (name: string) => (node: { type: unknown }) => node.type === name;
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, number>;

const renderRow = (props: { seeAll?: { label: string; onPress: () => void } } = {}) => {
  const focusers: (() => void)[] = [];
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <TvCardRow
        title="Recently added"
        items={items}
        keyOf={(item) => item.id}
        cardWidth={100}
        cardHeight={140}
        gap={10}
        testID="row"
        titleTestID="row-title"
        renderCard={(item, index, onFocus) => {
          focusers[index] = onFocus;
          return React.createElement("Card", { id: item.id });
        }}
        {...props}
      />,
    );
  });
  const list = tree.root.find(isType("FlatList"));
  const cells: ReactTestRenderer[] = [];
  act(() => {
    items.forEach((item, index) => cells.push(create(list.props.renderItem({ item, index }))));
  });
  return { tree, list, cells, focusers };
};

afterEach(() => {
  h.scrolls.length = 0;
  vi.restoreAllMocks();
});

describe("TvCardRow (TV-RAIL-FOCUS-001, #3350 S58)", () => {
  it("@req UX-TV-01 the cards sit in a full-width focus guide with autoFocus, under the heading", () => {
    const { tree, list } = renderRow();
    const guide = tree.root.findAll(isType("TVFocusGuideView")).find((node) => node.props.autoFocus);
    expect(guide).toBeDefined();
    expect(guide?.findAll(isType("FlatList"))).toHaveLength(1);
    expect(tree.root.find(isType("TvTitle")).props.testID).toBe("row-title");
    // The list holds the card plus the grow room above and below it.
    expect(flat(list.props.style).height).toBe(140 + TV_CARD_GROW_ROOM * 2);
    expect(list.props.initialNumToRender).toBe(items.length);
  });

  it("@req PAR-TV-03 'See all' is offered only when asked, and Right past the last card leads to it", () => {
    const without = renderRow();
    expect(without.tree.root.findAll(isType("TvFocusable"))).toHaveLength(0);
    expect(without.list.props.ListFooterComponent).toBeUndefined();

    const onPress = vi.fn();
    const { tree, list } = renderRow({ seeAll: { label: "See all", onPress } });
    const seeAll = tree.root.find(isType("TvFocusable"));
    expect(seeAll.props.testID).toBe("row-see-all");
    expect(seeAll.props.accessibilityLabel).toBe("See all, Recently added");
    expect(seeAll.props.onPress).toBe(onPress);
    expect(list.props.ListFooterComponent.props.testID).toBe("row-to-see-all");
    expect(flat(list.props.ListFooterComponent.props.style)).toEqual({ width: 100, height: 140 });
  });

  it("@req UX-TV-01 a focused card scrolls the row and logs tv.rail.focus for the e2e harness", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { focusers } = renderRow();
    act(() => focusers[2]());
    expect(h.scrolls).toHaveLength(1);
    const [event, payload] = info.mock.calls.find(([name]) => name === "tv.rail.focus") ?? [];
    expect(event).toBe("tv.rail.focus");
    expect(JSON.parse(String(payload))).toMatchObject({ title: "Recently added", focusedIndex: 2, offset: h.scrolls[0] });
  });

  it("@req UX-CRASH-01 each card has its own crash boundary named after its key", () => {
    const { cells } = renderRow();
    expect(cells.map((cell) => cell.root.find(isType("Boundary")).props.name)).toEqual(["tv-card:a", "tv-card:b", "tv-card:c"]);
    expect(cells[1].root.find(isType("Card")).props.id).toBe("b");
  });
});
