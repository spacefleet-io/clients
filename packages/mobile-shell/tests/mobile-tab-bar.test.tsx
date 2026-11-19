/**
 * @test-id MOBILE-SHELL-TAB-BAR-001
 * @level unit
 * @req UX-THEME-02[parrot]
 * @why Parrot's phone gets the fleet's bottom tab bar (Library / Settings, PAR-LOOK-01). The shared bar was built on
 *   react-native-reanimated, which Parrot does not ship; it now runs on React Native's own Animated (native driver),
 *   as `MobileAuthBrand` does, with the same springs, so Badger's bar looks and moves as before. Pins: no reanimated,
 *   the `@space/mobile-shell/tab-bar` entry point, the dot snapping to the first tab then sliding with the indicator
 *   spring, the pressed-tab spring, and the tab semantics (role, selected, upper-case label).
 */
import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const anim = vi.hoisted(() => ({
  springs: [] as { toValue: number; damping: number; stiffness: number; mass: number; useNativeDriver: boolean }[],
  set: [] as number[],
  width: 360,
  // The tabs' measured spans (x and width from the bar's left edge): as if their onLayout already ran; none = not yet.
  spans: {} as Record<string, { x: number; width: number }>,
}));

const log = (step: string, detail: unknown) => console.info(`[MOBILE-SHELL-TAB-BAR-001] ${step}`, JSON.stringify(detail));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useEffect = (fn: () => void | (() => void)) => void fn();
  // The bar's measured width: as if onLayout already ran.
  const useState = <T,>(initial: T) => [typeof initial === "number" ? anim.width : typeof initial === "object" ? anim.spans : initial, () => undefined];
  return { ...actual, default: { ...actual, useRef, useEffect, useState }, useRef, useEffect, useState };
});
vi.mock("react-native", () => {
  class Value {
    constructor(public value: number) {}
    setValue(next: number) {
      anim.set.push(next);
      this.value = next;
    }
  }
  return {
    Animated: {
      Value,
      View: "AnimatedView",
      spring: (_value: unknown, config: (typeof anim.springs)[number]) => {
        anim.springs.push(config);
        return { start: () => undefined, stop: () => undefined };
      },
    },
    Platform: { select: (options: { default: unknown }) => options.default },
    Pressable: "Pressable",
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
    Text: "Text",
    View: "View",
    Vibration: { vibrate: () => undefined },
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#40dd8f", textMuted: "#b6bace", textDim: "#555" },
    font: { family: { sans: "Inter" } },
  }),
}));
vi.mock("../src/components/mobile-sky-cover", () => ({ SkyCover: "SkyCover" }));

import { MOBILE_TAB_BAR_SPRINGS, MOBILE_TAB_DISABLED_OPACITY, MobileTabBar } from "../src/components/mobile-tab-bar";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
  }
  return out;
};

const Icon = () => null;
const tabs = [
  { id: "library", label: "Library", icon: Icon },
  { id: "settings", label: "Settings", icon: Icon },
];

describe("MobileTabBar on React Native Animated", () => {
  it("does not need react-native-reanimated, and has its own entry point", () => {
    const source = readFileSync(new URL("../src/components/mobile-tab-bar.tsx", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(source).not.toMatch(/from "react-native-reanimated"/);
    expect(pkg.exports["./tab-bar"]).toBe("./src/components/mobile-tab-bar.tsx");
  });

  it("snaps the dot onto the active tab first, then slides with the indicator spring", () => {
    anim.set.length = 0;
    anim.springs.length = 0;
    const tree = MobileTabBar({ tabs, activeTab: "settings", onTabChange: () => undefined }) as unknown as Element;
    // 360 wide, 12 padding, 2 tabs: slot 168, centre of tab 2 = 12 + 168 + 84 = 264, minus half the 6 pt dot.
    log("first placement", anim.set);
    expect(anim.set).toEqual([261]);
    expect(anim.springs).toEqual([]);
    expect(all(tree, (el) => el.props?.testID === "mobile-tab-dot")).toHaveLength(1);
  });

  it("each tab is a selectable tab with an upper-case label; pressing springs it down and back", () => {
    anim.springs.length = 0;
    const tree = MobileTabBar({ tabs, activeTab: "library", onTabChange: () => undefined }) as unknown as Element;
    const buttons = all(tree, (el) => typeof el.type === "function" && el.type !== Icon);
    expect(buttons).toHaveLength(2);
    const rendered = (buttons[0].type as (props: unknown) => Element)(buttons[0].props);
    const [pressable] = all(rendered, (el) => el.type === "Pressable");
    expect(pressable.props.accessibilityRole).toBe("tab");
    expect(pressable.props.accessibilityState).toEqual({ selected: true, disabled: false });
    expect(all(rendered, (el) => el.type === "Text")[0].props.children).toBe("LIBRARY");
    (pressable.props.onPressIn as () => void)();
    (pressable.props.onPressOut as () => void)();
    log("press springs", anim.springs);
    expect(anim.springs).toEqual([
      { toValue: 0.9, ...MOBILE_TAB_BAR_SPRINGS.press, useNativeDriver: true },
      { toValue: 1, ...MOBILE_TAB_BAR_SPRINGS.press, useNativeDriver: true },
    ]);
  });

  // Parrot's French phone cut "BIBLIOTHÈQUE" to "BIBLIOTHÈQ…" (op9, 2026-11-19), German "EINSTELLUNGEN" too. In both
  // looks a tab is as wide as its label plus an equal share of the room left, so a long label takes room from a short
  // one; the label keeps the phone's text size (UX-A11Y-05: no shrink-to-fit), and the dot centres on the measured tab.
  // @req UX-PHONE-11[badger-mobile,parrot]
  it("a tab is as wide as its label, never shrinks its text, and the dot centres on the measured tab", () => {
    for (const look of ["classic", "badger"] as const) {
      const tree = MobileTabBar({ tabs, activeTab: "library", onTabChange: () => undefined, look }) as unknown as Element;
      const buttons = all(tree, (el) => typeof el.type === "function" && el.type !== Icon);
      const rendered = (buttons[0].type as (props: unknown) => Element)(buttons[0].props);
      const tabStyle = Object.assign({}, ...(rendered.props.style as object[]).flat());
      const label = all(rendered, (el) => el.type === "Text")[0];
      log("tab fit", { look, tabStyle, label: label.props, onLayout: typeof rendered.props.onLayout });
      expect(tabStyle).toMatchObject({ flexGrow: 1, flexShrink: 1, flexBasis: "auto" });
      expect(tabStyle).not.toHaveProperty("flex");
      expect(typeof rendered.props.onLayout).toBe("function");
      expect(label.props.numberOfLines).toBe(1);
      expect(label.props).not.toHaveProperty("adjustsFontSizeToFit");
      expect(label.props).not.toHaveProperty("minimumFontScale");
    }
    anim.set.length = 0;
    anim.spans = { library: { x: 12, width: 100 }, settings: { x: 112, width: 236 } };
    try {
      MobileTabBar({ tabs, activeTab: "settings", onTabChange: () => undefined });
    } finally {
      anim.spans = {};
    }
    // The measured settings tab: 112 + 236 / 2 = 230, minus half the 6 dp dot.
    log("dot on measured tab", anim.set);
    expect(anim.set).toEqual([227]);
  });

  // @req UX-PHONE-06
  it("the Badger look draws the mockup's bar: labels as written, semibold, 22 dp icons, a 5 dp dot without glow", () => {
    anim.set.length = 0;
    const tree = MobileTabBar({ tabs, activeTab: "library", onTabChange: () => undefined, look: "badger" }) as unknown as Element;
    const buttons = all(tree, (el) => typeof el.type === "function" && el.type !== Icon);
    const rendered = (buttons[0].type as (props: unknown) => Element)(buttons[0].props);
    const label = all(rendered, (el) => el.type === "Text")[0];
    const icon = all(rendered, (el) => el.type === Icon)[0];
    const labelStyle = Object.assign({}, ...(label.props.style as object[]).flat());
    const [dot] = all(tree, (el) => el.props?.testID === "mobile-tab-dot");
    const dotStyle = Object.assign({}, ...(dot.props.style as (object | null)[]).flat().filter(Boolean));
    log("badger look", { label: label.props.children, labelStyle, iconSize: icon.props.size, dotStyle, set: anim.set });
    expect(label.props.children).toBe("Library");
    expect(labelStyle).toMatchObject({ fontWeight: "600", letterSpacing: 0, fontSize: 11 });
    expect(icon.props.size).toBe(22);
    expect(dotStyle).toMatchObject({ width: 5, height: 5, shadowOpacity: 0, elevation: 0 });
    // 360 wide, 12 padding, 2 tabs: centre of tab 1 = 12 + 84 = 96, minus half the 5 dp dot.
    expect(anim.set).toEqual([93.5]);
  });

  it("keeps the springs Badger's bar had", () => {
    expect(MOBILE_TAB_BAR_SPRINGS).toEqual({
      indicator: { damping: 22, stiffness: 240, mass: 0.35 },
      press: { damping: 15, stiffness: 350, mass: 0.3 },
    });
  });

  // @req UX-NOTICE-02[badger-mobile]
  it("a status badge (the offline sign) floats on the bar's top edge: no tab moves and the bar keeps its height", () => {
    anim.set.length = 0;
    const plain = MobileTabBar({ tabs, activeTab: "library", onTabChange: () => undefined, look: "badger" }) as unknown as Element;
    anim.set.length = 0;
    const badge = React.createElement("OfflineSign");
    const tree = MobileTabBar({ tabs, activeTab: "library", onTabChange: () => undefined, look: "badger", badge }) as unknown as Element;
    const [layer] = all(tree, (el) => el.props?.testID === "mobile-tab-bar-badge");
    const layerStyle = Object.assign({}, ...[layer?.props.style].flat(3).filter(Boolean));
    const barStyle = (el: Element) => Object.assign({}, ...[el.props.style].flat(3).filter(Boolean));
    log("badge layer", { layerStyle, pointerEvents: layer?.props.pointerEvents, bar: barStyle(tree), plainBar: barStyle(plain) });
    expect(all(layer, (el) => el.type === "OfflineSign")).toHaveLength(1);
    expect(layerStyle).toMatchObject({ position: "absolute", left: 0, right: 0 });
    expect(layerStyle.top).toBeLessThan(0);
    expect(layer.props.pointerEvents).toBe("box-none");
    expect(barStyle(tree)).toEqual(barStyle(plain));
    // The tabs are the same elements in the same order with or without the badge.
    const tabIds = (el: Element) => all(el, (n) => typeof n.type === "function" && n.type !== Icon).map((n) => n.props.tab);
    expect(tabIds(tree)).toEqual(tabIds(plain));
    expect(all(plain, (el) => el.props?.testID === "mobile-tab-bar-badge")).toHaveLength(0);
  });

  // @req UX-LIBTAB-01[parrot]
  // @req UX-LIBTAB-01[badger-mobile]
  // Chris, 2026-11-18, on a test phone: "I can't click the library and playlists buttons on the bottom menu, but they are not
  // greyed out at all so it's very confusing and looks like a bug". The theme's dim colour (#9ca0b1) next to the idle
  // one (#b6bace) did not read as disabled: a disabled tab is the idle colour at half opacity, as on desktop and TV.
  it.each(["classic", "badger"] as const)("%s look: a disabled tab is the idle tab at half opacity, never the dim colour", (look) => {
    const second = (disabledTabs: string[]) => {
      const tree = MobileTabBar({ tabs, activeTab: "library", onTabChange: () => undefined, disabledTabs, look }) as unknown as Element;
      const buttons = all(tree, (el) => typeof el.type === "function" && el.type !== Icon);
      const rendered = (buttons[1].type as (props: unknown) => Element)(buttons[1].props);
      const [pressable] = all(rendered, (el) => el.type === "Pressable");
      const label = all(rendered, (el) => el.type === "Text")[0];
      const icon = all(rendered, (el) => el.type === Icon)[0];
      return {
        opacity: Object.assign({}, ...[pressable.props.style].flat(3).filter(Boolean)).opacity ?? 1,
        labelColour: Object.assign({}, ...[label.props.style].flat(3).filter(Boolean)).color,
        iconColour: icon.props.color,
        disabled: pressable.props.disabled,
      };
    };
    const idle = second([]);
    const disabled = second([tabs[1].id]);
    log(`${look} disabled look`, { idle, disabled });
    expect(MOBILE_TAB_DISABLED_OPACITY).toBe(0.5);
    expect(idle).toEqual({ opacity: 1, labelColour: "#b6bace", iconColour: "#b6bace", disabled: false });
    expect(disabled).toEqual({ opacity: 0.5, labelColour: "#b6bace", iconColour: "#b6bace", disabled: true });
  });
});
