/**
 * @test-id MOBILE-SHELL-FRAME-KEYBOARD-001
 * @level component
 * @bugfix @regression-proof
 * @why Exploratory walk on the OnePlus 6 (2026-11-12): typing in a field (search, sign-in in Settings) pushed the bottom
 *   tab bar up on top of the keyboard, over the field being typed in. The bar hides while the keyboard is up.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const keyboard = vi.hoisted(() => ({ listeners: new Map<string, Set<() => void>>() }));

vi.mock("react-native", () => ({
  Keyboard: {
    addListener: (name: string, listener: () => void) => {
      const set = keyboard.listeners.get(name) ?? new Set();
      set.add(listener);
      keyboard.listeners.set(name, set);
      return { remove: () => set.delete(listener) };
    },
  },
  ScrollView: "ScrollView",
  View: "View",
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("../src/theme", () => ({ useMobileShellTheme: () => ({ colors: { bg: "#000" } }) }));
vi.mock("../src/components/mobile-app-backdrop", () => ({ default: () => null }));
vi.mock("../src/components/mobile-tab-bar", () => ({ MobileTabBar: "MobileTabBar" }));

import { MobileShellFrame } from "../src/components/mobile-shell-frame";

vi.stubGlobal("requestIdleCallback", () => 0);
vi.stubGlobal("cancelIdleCallback", () => undefined);

const emit = (name: string) => {
  for (const listener of keyboard.listeners.get(name) ?? []) listener();
};

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

/** @req UX-PHONE-01[badger-mobile] */
describe("phone shell: the tab bar while typing", () => {
  it("hides the bottom tab bar while the keyboard is up and brings it back once it closes", async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const tabs = [{ id: "home", label: "Home", icon: () => null }];
    await act(async () => {
      renderer = create(
        <MobileShellFrame tabs={tabs as never} activeTab="home" onTabChange={() => undefined} showBackdrop={false}>
          {(tabId) => tabId}
        </MobileShellFrame>,
      );
    });
    const bars = () => renderer!.root.findAll((node) => String(node.type) === "MobileTabBar").length;
    const closed = bars();
    await act(async () => emit("keyboardDidShow"));
    const typing = bars();
    await act(async () => emit("keyboardDidHide"));
    const after = bars();
    console.info("tab bar", { closed, typing, after });
    expect([closed, typing, after]).toEqual([1, 0, 1]);
  });
});
