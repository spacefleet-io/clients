/**
 * TV-RAIL-FOCUS-001 (UX-TV-01: UP / DOWN move between rows and up to the tabs). tvOS moves the focus only to what lies in
 * the pressed direction: from the second card of "Recently added", UP found nothing above it when the row above
 * ("Continue watching") held one card at the left, and the focus stayed put however often UP was pressed (Apple TV
 * simulator, 2026-10-23: 24 UP presses, no focus change). Each rail's cards therefore sit in a full-width
 * `TVFocusGuideView` with `autoFocus`: a move into the row lands on its last focused card (the first one at first).
 * TV-RAIL-SKY-001 (UX-TV-05, UX-TV-11, v2 redesign approved by Chris 2026-11-12 (chat)): the row sits straight on the sky
 * at the screen margin, under a Title-case heading with no count and no panel.
 * Rendered with react-test-renderer: react-native is replaced by host-element stand-ins.
 *
 * @bugfix @regression-proof
 * @req UX-TV-01[badger-tv]
 * @req UX-TV-05[badger-tv]
 * @req UX-TV-11[badger-tv]
 * @req UX-TV-13[badger-tv]
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MediaRow } from "@space/shared/libraryTypes";
import { TV_RAIL_GROW_ROOM, TvRail } from "./TvRail";
import { TV_SPACE } from "../ui/tokens";

/** The window: 960x540 dp (Android TV at 1080p) unless a test switches it to an Apple TV's 1920x1080 points. */
const windowSize = vi.hoisted(() => ({ width: 960, height: 540 }));

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    FlatList: host("FlatList"),
    TVFocusGuideView: host("TVFocusGuideView"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    useWindowDimensions: () => windowSize,
  };
});
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./TvPosterCard", () => ({ TvPosterCard: "TvPosterCard", tvPosterCardHeight: (width: number) => width * 2 }));

const items = [{ id: "a", title: "A" }, { id: "b", title: "B" }] as unknown as MediaRow[];
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, number | string>;
const isType = (name: string) => (node: { type: unknown }) => (node.type as unknown) === name;

const renderRail = (props: Partial<React.ComponentProps<typeof TvRail>> = {}) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<TvRail title="Recently added" items={items} cardWidth={107} onOpenMedia={() => undefined} {...props} />);
  });
  return tree;
};

const renderCell = (tree: ReactTestRenderer, index: number) => {
  const list = tree.root.find(isType("FlatList"));
  let cell!: ReactTestRenderer;
  act(() => {
    cell = create(list.props.renderItem({ item: items[index], index }));
  });
  return cell.root.find(isType("TvPosterCard"));
};

describe("TvRail (TV-RAIL-FOCUS-001)", () => {
  it("puts the rail's cards in a full-width TVFocusGuideView with autoFocus", () => {
    const tree = renderRail();
    const guides = tree.root.findAll(isType("TVFocusGuideView"));
    console.info("[TV-RAIL-FOCUS-001] guides", JSON.stringify(guides.map((g) => ({ autoFocus: g.props.autoFocus }))));
    expect(guides).toHaveLength(1);
    expect(guides[0].props.autoFocus).toBe(true);
    // The list (the cards) is inside the guide, so a move into the row anywhere along its width reaches it.
    expect(guides[0].findAll(isType("FlatList"))).toHaveLength(1);
  });

  it("@req UX-TV-01 only the card at preferredFocusIndex asks for the first focus", () => {
    const tree = renderRail({ preferredFocusIndex: 0 });
    expect(renderCell(tree, 0).props.hasTVPreferredFocus).toBe(true);
    expect(renderCell(tree, 1).props.hasTVPreferredFocus).toBe(false);
    const none = renderRail();
    expect(renderCell(none, 0).props.hasTVPreferredFocus).toBe(false);
  });
});

describe("TvRail on the sky (TV-RAIL-SKY-001)", () => {
  it("@req UX-TV-05 heads the row with its Title-case section title and no count", () => {
    const tree = renderRail();
    const header = tree.root.find((n) => isType("Text")(n) && n.props.accessibilityRole === "header");
    const style = flat(header.props.style);
    console.info("[TV-RAIL-SKY-001] heading", JSON.stringify(style));
    expect(header.props.children).toBe("Recently added");
    expect(style.textTransform).toBeUndefined();
    expect(style.fontSize).toBe(16);
    // No nested count text.
    expect(header.findAll((n) => isType("Text")(n) && n !== header)).toHaveLength(0);
  });

  it("@req UX-TV-11 no panel: no border, background or margin; heading and first poster at the screen margin", () => {
    const tree = renderRail();
    const rail = flat(tree.root.findAll(isType("View"))[0].props.style);
    const header = flat(tree.root.find((n) => isType("Text")(n) && n.props.accessibilityRole === "header").props.style);
    const content = flat(tree.root.find(isType("FlatList")).props.contentContainerStyle);
    console.info("[TV-RAIL-SKY-001] rail", JSON.stringify({ rail, header, content }));
    expect(rail.borderWidth).toBeUndefined();
    expect(rail.backgroundColor).toBeUndefined();
    expect(rail.marginHorizontal).toBeUndefined();
    expect(header.paddingHorizontal).toBe(TV_SPACE.screenX);
    expect(content.paddingHorizontal).toBe(TV_SPACE.screenX);
    // The heading sits the heading gap above the posters, the grow room included.
    expect(Number(header.marginBottom) + Number(content.paddingVertical)).toBe(TV_SPACE.headingGap);
  });

  it("@req UX-TV-11 cards show the watch state only when asked, never the type badge; the list holds the grown poster", () => {
    const tree = renderRail({ showProgress: true });
    const card = renderCell(tree, 0);
    const list = tree.root.find(isType("FlatList"));
    expect(card.props.showProgress).toBe(true);
    expect(card.props.showType).toBeUndefined();
    expect(flat(list.props.style).height).toBe(107 * 2 + TV_RAIL_GROW_ROOM * 2);
  });
});

/**
 * TV-SCALE-RAIL-001 (UX-TV-13): on an Apple TV (1920x1080 points) every size is the 960x540 design at the window's
 * scale: exactly twice at 1920x1080.
 */
describe("TvRail on an Apple TV (TV-SCALE-RAIL-001)", () => {
  const measure = (width: number, height: number, cardWidth: number) => {
    windowSize.width = width;
    windowSize.height = height;
    try {
      const tree = renderRail({ cardWidth });
      const list = tree.root.find(isType("FlatList"));
      return {
        header: flat(tree.root.find((n) => isType("Text")(n) && n.props.accessibilityRole === "header").props.style),
        content: flat(list.props.contentContainerStyle),
        listHeight: flat(list.props.style).height as number,
      };
    } finally {
      windowSize.width = 960;
      windowSize.height = 540;
    }
  };

  it("@req UX-TV-13 a 1920x1080-point window draws the 960x540 rail at exactly twice the size", () => {
    const android = measure(960, 540, 107);
    const apple = measure(1920, 1080, 214);
    console.info("[TV-SCALE-RAIL-001]", JSON.stringify({ android, apple }));
    for (const part of ["header", "content"] as const) {
      for (const [key, before] of Object.entries(android[part])) {
        if (typeof before === "number") expect(apple[part][key]).toBe(before * 2);
      }
    }
    expect(apple.listHeight).toBe(android.listHeight * 2);
  });
});
