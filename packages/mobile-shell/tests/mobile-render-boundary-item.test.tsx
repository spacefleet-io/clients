/**
 * @test-id MOBILE-SHELL-RENDER-BOUNDARY-004
 * @level unit
 * @why UX-CRASH-01: on the phone and TV apps one card or row of a long list that throws while rendering shows
 *   "This item can't be shown." in its own place, in the app's language, and the other items of the list stay.
 */
// @req UX-CRASH-01[badger-mobile] @req UX-CRASH-01[badger-tv]: one broken list cell shows the placeholder, the list stays.
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RENDER_ERROR_COPY } from "@space/shared/renderError";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const lang = vi.hoisted(() => ({ value: "de" }));

// Host components: the test renderer draws them as plain nodes.
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { bg: "#000", surface: "#111", border: "#333", text: "#fff", textMuted: "#aaa" },
    accentHex: "#ffb357",
    accentTextHex: "#121421",
  }),
}));
vi.mock("../src/i18n", () => ({ getCurrentLanguage: () => lang.value }));
// The window notice's sky and mascot, as plain host nodes (their own tests cover them).
vi.mock("../src/components/mobile-app-backdrop", () => ({ default: "MobileAppBackdrop" }));
vi.mock("../src/components/mobile-auth-brand", () => ({ MobileAuthBrand: "MobileAuthBrand" }));

import { MobileRenderBoundary, guardRenderItem } from "../src/components/mobile-render-boundary";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Row = { id: string; title: string };
const rows: Row[] = [
  { id: "a", title: "Alien" },
  { id: "b", title: "broken" },
  { id: "c", title: "Casablanca" },
];

const Card = ({ row }: { row: Row }) => {
  if (row.id === "b") throw new Error("boom in card");
  return React.createElement("Text", { testID: `card:${row.id}` }, row.title);
};

/** A FlatList stand-in: calls `renderItem` for each row, as the list does for its cells. */
const List = ({ renderItem }: { renderItem: (info: { item: Row; index: number }) => React.ReactNode }) =>
  React.createElement(
    "View",
    { testID: "list" },
    rows.map((item, index) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item, index }))),
  );

const byTestId = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll((node: { props: { testID?: string }; type: unknown }) => node.props.testID === testID && typeof node.type === "string");
const texts = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node: { type: unknown }) => String(node.type) === "Text").map((node: { props: { children?: unknown } }) => node.props.children);

describe("MobileRenderBoundary item guard", () => {
  let errors: MockInstance<typeof console.error>;
  beforeEach(() => {
    lang.value = "de";
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it("guardRenderItem: the broken cell shows the placeholder, the other cells stay", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(List, { renderItem: guardRenderItem<Row>("song-row", ({ item }) => React.createElement(Card, { row: item })) }));
    });
    expect(byTestId(renderer, "card:a")).toHaveLength(1);
    expect(byTestId(renderer, "card:c")).toHaveLength(1);
    expect(byTestId(renderer, "render-boundary-item:song-row:b")).toHaveLength(1);
    expect(texts(renderer)).toContain(RENDER_ERROR_COPY.de.itemFailed);
    expect(texts(renderer)).not.toContain(RENDER_ERROR_COPY.de.retry);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("song-row:b crashed"))).toBe(true);
  });

  it("catches a throw while the cell's element is built, not only while it renders", () => {
    lang.value = "nl";
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(List, {
          renderItem: ({ item }) =>
            React.createElement(MobileRenderBoundary, {
              name: `library-card:${item.id}`,
              variant: "item",
              style: { width: 120 },
              children: () => {
                if (item.id === "b") throw new Error("bad props");
                return React.createElement("Text", { testID: `card:${item.id}` }, item.title);
              },
            }),
        }),
      );
    });
    expect(byTestId(renderer, "card:a")).toHaveLength(1);
    expect(byTestId(renderer, "card:c")).toHaveLength(1);
    const [placeholder] = byTestId(renderer, "render-boundary-item:library-card:b");
    expect(placeholder.props.style).toContainEqual({ width: 120 });
    expect(texts(renderer)).toContain(RENDER_ERROR_COPY.nl.itemFailed);
  });
});
