/**
 * @test-id MOBILE-TAB-PAGER-001
 * @level component
 * @why Chris 2026-11-15 (#2503): Parrot's phone did not swipe between tabs while Badger's did. The pager is now one
 *   shared component: a swipe settles on a page and selects its tab, a tab tap scrolls the pager, and off-screen pages
 *   mount once the app is idle.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pager = vi.hoisted(() => ({ scrollTo: vi.fn(), idle: [] as Array<() => void> }));

vi.mock("react-native", async () => {
  // vi.mock factories are hoisted above the static imports, so React is loaded inside the factory.
  const ReactModule = await import("react");
  const ScrollView = ReactModule.forwardRef((props: Record<string, unknown>, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({ scrollTo: pager.scrollTo }));
    return ReactModule.createElement("ScrollView", props, props.children as React.ReactNode);
  });
  return {
    ScrollView,
    View: "View",
    StyleSheet: { create: <T,>(styles: T) => styles },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});
vi.mock("../src/components/mobile-sky-cover", () => ({ useSkyScroll: () => ({}) }));

import { MobileTabPager } from "../src/components/mobile-tab-pager";

const TABS = ["home", "library", "playlists", "settings"] as const;

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  pager.scrollTo.mockClear();
  pager.idle = [];
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => pager.idle.push(cb));
  vi.stubGlobal("cancelIdleCallback", () => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.restoreAllMocks();
});

const render = async (activeTab: string, onTabChange: (id: string) => void) => {
  const element = (tab: string) => (
    <MobileTabPager tabIds={TABS} activeTab={tab} onTabChange={onTabChange}>
      {(id) => <View testID={`content-${id}`} />}
    </MobileTabPager>
  );
  await act(async () => {
    renderer = create(element(activeTab));
  });
  return (tab: string) => act(async () => renderer!.update(element(tab)));
};
const View = "View" as unknown as React.ComponentType<{ testID: string }>;
const contents = () => renderer!.root.findAll((n) => typeof n.props.testID === "string" && n.props.testID.startsWith("content-") && typeof n.type === "string").map((n) => n.props.testID as string);
const scrollView = () => renderer!.root.find((n) => String(n.type) === "ScrollView");

/** @req UX-PHONE-09 */
describe("phone tab pager", () => {
  it("selects the tab of the page a swipe settles on", async () => {
    const onTabChange = vi.fn();
    await render("home", onTabChange);
    expect(scrollView().props.pagingEnabled).toBe(true);
    expect(scrollView().props.horizontal).toBe(true);
    await act(async () => scrollView().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 2 * 400 } } }));
    expect(onTabChange).toHaveBeenCalledWith("playlists");
  });

  it("does not report a swipe that came back to the open page", async () => {
    const onTabChange = vi.fn();
    await render("library", onTabChange);
    await act(async () => scrollView().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 400 } } }));
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it("opens on the active tab's page and scrolls there when a tab is tapped", async () => {
    const update = await render("settings", vi.fn());
    expect(scrollView().props.contentOffset).toEqual({ x: 3 * 400, y: 0 });
    pager.scrollTo.mockClear();
    await update("library");
    expect(pager.scrollTo).toHaveBeenCalledWith({ x: 400, animated: true });
  });

  it("renders only the open page until the app is idle, then every page", async () => {
    const update = await render("home", vi.fn());
    expect(contents()).toEqual(["content-home"]);
    await update("library");
    expect(contents()).toEqual(["content-home", "content-library"]);
    await act(async () => pager.idle.forEach((cb) => cb()));
    expect(contents()).toEqual(TABS.map((id) => `content-${id}`));
  });
});
