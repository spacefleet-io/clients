/**
 * @test-id MOBILE-SHELL-NOTICE-OVERLAY-001
 * @level unit
 * @req UX-NOTICE-01[badger-mobile]
 * @why Chris 2026-11-12 (chat): the "New device added" notice sat above the Settings title and pushed every page down.
 *   A notice now floats over the page: `MobileShellFrame` draws its `overlay` beside the pages, never inside them, and
 *   `MobileNoticeToast` is absolutely positioned under the status bar (safe-area inset). The pages render exactly the
 *   same with and without a notice. Tapping the card opens, the cross closes.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };

vi.mock("react-native", () => ({
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles,
    absoluteFill: { position: "absolute" },
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)),
  },
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => INSETS }));
vi.mock("lucide-react-native", () => ({ X: "XIcon" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { bg: "#000", accent: "#ffb357", accentSoft: "#372d2a", textMuted: "#aaa" } }),
}));
vi.mock("../src/components/mobile-app-backdrop", () => ({ default: () => null }));
vi.mock("../src/components/mobile-sky-cover", () => ({
  SkyCoversProvider: ({ children }: { children: React.ReactNode }) => children,
  useSkyScroll: () => ({}),
}));
vi.mock("../src/components/mobile-sky-mode", () => ({ useMobileSkyMode: () => "static" }));
vi.mock("../src/components/mobile-sky-covers", () => ({
  createSkyCoverRegistry: () => ({}),
  createSkyScrollHandlers: () => ({}),
}));
vi.mock("../src/components/mobile-user-input", () => ({ createUserInputSignal: () => ({ touchHandlers: {} }) }));
vi.mock("../src/components/mobile-tab-bar", () => ({ MobileTabBar: () => "TabBar" }));

import { MobileShellFrame } from "../src/components/mobile-shell-frame";
import { MobileNoticeToast } from "../src/components/mobile-notice-toast";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// The pager mounts off-screen pages on an idle callback; this test only looks at the open one.
vi.stubGlobal("requestIdleCallback", () => 0);
vi.stubGlobal("cancelIdleCallback", () => undefined);

const log = (step: string, detail: unknown) => console.info(`[MOBILE-SHELL-NOTICE-OVERLAY-001] ${step}`, JSON.stringify(detail));
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
const byTestId = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll((n: ReactTestInstance) => n.props.testID === testID && typeof n.type === "string");

const TABS = [
  { id: "home", label: "Home", icon: () => null },
  { id: "settings", label: "Settings", icon: () => null },
];

const page = (tabId: string) => React.createElement("Text", { testID: `title-${tabId}` }, tabId);

const renderFrame = (overlay: React.ReactNode, handlers = { onOpen: vi.fn(), onClose: vi.fn() }) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileShellFrame tabs={TABS} activeTab="settings" onTabChange={() => undefined} overlay={overlay}>
        {page}
      </MobileShellFrame>,
    );
  });
  return { renderer, handlers };
};

const toast = (handlers: { onOpen: () => void; onClose: () => void }) => (
  <MobileNoticeToast
    testID="new-device-notice"
    title="New device added: Den TV (TV)"
    hint="Tap to see your devices. Not you? Sign it out there."
    accessibilityLabel="New device added. Open your devices."
    closeLabel="Dismiss notice"
    onOpen={handlers.onOpen}
    onClose={handlers.onClose}
  />
);

describe("notices float over the phone pages (UX-NOTICE-01)", () => {
  it("leaves the pages exactly as they are and draws the notice absolutely, under the status bar", () => {
    const without = renderFrame(null);
    const handlers = { onOpen: vi.fn(), onClose: vi.fn() };
    const withNotice = renderFrame(toast(handlers), handlers);

    const pagesWithout = without.renderer.root.findByType("ScrollView" as never);
    const pagesWith = withNotice.renderer.root.findByType("ScrollView" as never);
    log("pages", { without: serialize(pagesWithout), with: serialize(pagesWith) });
    // The pager and every page in it are identical: the notice is not one of their children.
    expect(JSON.stringify(serialize(pagesWith))).toBe(JSON.stringify(serialize(pagesWithout)));
    expect(pagesWith.findAll((n: ReactTestInstance) => n.props.testID === "new-device-notice")).toHaveLength(0);

    const [layer] = byTestId(withNotice.renderer, "new-device-notice-layer");
    const style = flat(layer.props.style);
    log("layer", { style, pointerEvents: layer.props.pointerEvents });
    expect(style.position).toBe("absolute");
    expect(style.top).toBe(INSETS.top + 8);
    expect(layer.props.pointerEvents).toBe("box-none");
    // A sibling of the pager's container, after the tab bar: over everything, in nothing.
    const root = withNotice.renderer.root.findAll((n: ReactTestInstance) => String(n.type) === "View")[0];
    expect(root.findAll((n: ReactTestInstance) => n === layer)).toHaveLength(1);
    expect(byTestId(without.renderer, "new-device-notice-layer")).toHaveLength(0);
  });

  it("tapping the card opens, the cross closes", () => {
    const handlers = { onOpen: vi.fn(), onClose: vi.fn() };
    const { renderer } = renderFrame(toast(handlers), handlers);
    const [open] = byTestId(renderer, "new-device-notice-open");
    const [close] = byTestId(renderer, "new-device-notice-close");
    log("controls", { open: open.props.accessibilityLabel, close: close.props.accessibilityLabel });
    expect(open.props.accessibilityLabel).toBe("New device added. Open your devices.");
    expect(close.props.accessibilityLabel).toBe("Dismiss notice");
    act(() => open.props.onPress());
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    act(() => close.props.onPress());
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});

/** The rendered subtree as plain data (type, props without functions, children), to compare two renders. */
const serialize = (node: ReactTestInstance | string): unknown => {
  if (typeof node === "string") return node;
  const props = Object.fromEntries(
    Object.entries(node.props).filter(([key, value]) => key !== "children" && typeof value !== "function"),
  );
  return { type: typeof node.type === "string" ? node.type : "component", props, children: node.children.map(serialize) };
};
