/**
 * @test-id MOBILE-HOME-RAIL-001
 * @level component
 * @why Audit #3350 S57: Badger's `PosterRail` and Parrot's Home `Shelf` were two copies of one titled sideways row
 *   with "See all". They drifted: Parrot's rows had no windowing or item measuring, its "See all" did not say which
 *   row it opens, and each app placed its crash placeholders differently. Both apps' Home rows are now the shell's
 *   `MobileHomeRail`; the apps keep only their heading type and spacing.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  FlatList: "FlatList",
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../src/theme", () => ({ useMobileShellTheme: () => ({ colors: { text: "#fff", textMuted: "#aaa" } }) }));
const sky = vi.hoisted(() => ({ onScroll: () => undefined }));
vi.mock("../src/components/mobile-sky-cover", () => ({ useSkyScroll: () => sky }));
// The crash placeholder, as a named host node around its item (its own tests cover what it shows).
vi.mock("../src/components/mobile-render-boundary", () => ({
  MobileRenderBoundary: ({ name, style, children }: { name: string; style: unknown; children: () => React.ReactNode }) =>
    React.createElement("Boundary", { name, style }, children()),
}));

import { MobileHomeRail, type MobileHomeRailProps } from "../src/components/mobile-home-rail";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Row = { id: string; title: string };
const rows: Row[] = [
  { id: "a", title: "Alien" },
  { id: "b", title: "Brazil" },
  { id: "c", title: "Casablanca" },
];
const keyOf = (row: Row) => row.id;
const renderItem = (row: Row) => React.createElement("Text", { testID: `card:${row.id}` }, row.title);

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

const render = async (props: Partial<MobileHomeRailProps<Row>> = {}) => {
  await act(async () => {
    renderer = create(
      <MobileHomeRail title="Movies" items={rows} keyOf={keyOf} renderItem={renderItem} itemWidth={120} boundaryName="home-card" testID="home-rail-movies" {...props} />,
    );
  });
  const root = renderer!.root;
  const list = root.findByType("FlatList" as never);
  return { root, list: list.props as Record<string, unknown> };
};

describe("MobileHomeRail: a Home row of either app", () => {
  it("@req UX-PHONE-09[badger-mobile,parrot] the row is the shared rail: horizontal, nested scrolling on, windowed", async () => {
    const { list } = await render();
    console.info("[home-rail:list]", JSON.stringify({ horizontal: list.horizontal, nested: list.nestedScrollEnabled, windowSize: list.windowSize }));
    expect(list).toMatchObject({ horizontal: true, nestedScrollEnabled: true, data: rows, initialNumToRender: 4, maxToRenderPerBatch: 4, windowSize: 5, removeClippedSubviews: true });
    expect((list.keyExtractor as (row: Row) => string)(rows[1]!)).toBe("b");
  });

  it("@req UX-PHONE-01[badger-mobile] @req PAR-HOME-01[parrot] the heading names the row and its See all says which row it opens", async () => {
    const onPress = vi.fn();
    const { root } = await render({ seeAll: { label: "See all", onPress } });
    const header = root.findByProps({ accessibilityRole: "header" });
    const seeAll = root.findByProps({ testID: "home-rail-movies-see-all" });
    console.info("[home-rail:see-all]", JSON.stringify({ header: header.props.children, label: seeAll.props.accessibilityLabel }));
    expect(header.props.children).toBe("Movies");
    expect(seeAll.props).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "See all, Movies", hitSlop: 10 });
    seeAll.props.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("@req UX-PHONE-01[badger-mobile] without See all the heading has none", async () => {
    const { root } = await render();
    expect(root.findAll((node) => node.props.testID === "home-rail-movies-see-all")).toHaveLength(0);
  });

  it("@req UX-PHONE-01[badger-mobile] items are measured by width plus gap from the inset; snap stops on an item's edge", async () => {
    const { list } = await render({ gap: 16, inset: 16, snap: true });
    const layout = list.getItemLayout as (data: unknown, index: number) => { length: number; offset: number; index: number };
    console.info("[home-rail:layout]", JSON.stringify([0, 1, 2].map((i) => layout(rows, i))));
    expect(layout(rows, 0)).toEqual({ length: 136, offset: 16, index: 0 });
    expect(layout(rows, 2)).toEqual({ length: 136, offset: 288, index: 2 });
    expect(list).toMatchObject({ snapToInterval: 136, decelerationRate: "fast", contentContainerStyle: { paddingHorizontal: 16 } });
  });

  it("@req PAR-HOME-01[parrot] a free row (Parrot) has no snap; the page sky follows it only when asked", async () => {
    const free = await render();
    expect(free.list.snapToInterval).toBeUndefined();
    expect(free.list.decelerationRate).toBeUndefined();
    expect(free.list.onScroll).toBeUndefined();
    await act(async () => renderer?.unmount());
    const following = await render({ followSky: true });
    expect(following.list.onScroll).toBe(sky.onScroll);
  });

  it("@req UX-CRASH-01[badger-mobile,parrot] each item sits in its own crash placeholder, named by row and key, sized as the item", async () => {
    const { list } = await render({ itemHeight: 180 });
    const cell = (list.renderItem as (info: { item: Row }) => React.ReactElement)({ item: rows[2]! });
    await act(async () => {
      renderer?.unmount();
      renderer = create(cell);
    });
    const boundary = renderer!.root.findByType("Boundary" as never);
    console.info("[home-rail:boundary]", JSON.stringify(boundary.props.name));
    expect(boundary.props).toMatchObject({ name: "home-card:c", style: { width: 120, height: 180, margin: 0 } });
    expect(renderer!.root.findByProps({ testID: "card:c" }).props.children).toBe("Casablanca");
  });
});
