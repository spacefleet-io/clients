/**
 * @test-id MOBILE-SHELL-SKY-LAYER-001
 * @level unit
 * @why UX-SKY-04: every Badger and Parrot phone and TV screen stands on the desktop's sky (navy ground, nebula,
 *   stars), never a flat black page. The app-wide layer and each navigator screen's layer paint it; a screen that
 *   paints its own sky (the tab shell, sign-in, Parrot's pages) takes it over, so one screen never runs two star
 *   fields (UX-SKY-01); a covered screen's sky stands still; the navigator itself paints nothing over it.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

// Host components: the test renderer draws them as plain nodes.
vi.mock("react-native", () => ({
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  View: "View",
}));
vi.mock("../src/theme", () => ({ useMobileShellTheme: () => ({ colors: { bg: "#121421" } }) }));
// The painting itself (nebula and stars) has its own tests; here it is one plain node per sky.
vi.mock("../src/components/mobile-sky-paint", () => ({ MobileSkyPaint: "MobileSkyPaint" }));

import MobileAppBackdrop from "../src/components/mobile-app-backdrop";
import { MobileSkyLayer, MobileSkyScreenLayout, mobileNavigationTheme } from "../src/components/mobile-sky-layer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const skies = (renderer: ReactTestRenderer) => renderer.root.findAll((node) => (node.type as unknown) === "MobileSkyPaint");

const draw = (tree: React.ReactElement) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(tree);
  });
  return renderer;
};

/** A React Navigation screen's `navigation`, enough for the layout: focus state and focus/blur listeners. */
const fakeNavigation = (focused: boolean) => {
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  const navigation = {
    focused,
    isFocused: () => navigation.focused,
    addListener: (type: "focus" | "blur", listener: () => void) => {
      listeners[type].add(listener);
      return () => listeners[type].delete(listener);
    },
    emit: (type: "focus" | "blur") => {
      navigation.focused = type === "focus";
      act(() => listeners[type].forEach((listener) => listener()));
    },
  };
  return navigation;
};

describe("MobileSkyLayer (UX-SKY-04)", () => {
  // @req UX-SKY-04[badger-mobile]
  // @req UX-SKY-04[parrot]
  it("paints the sky over the desktop's navy ground behind a screen that has none", () => {
    const renderer = draw(
      <MobileSkyLayer>
        <View testID="setup-step" />
      </MobileSkyLayer>,
    );
    expect(skies(renderer)).toHaveLength(1);
    const ground = renderer.root.findAll((node) => (node.type as unknown) === "View")[0];
    expect(ground.props.style).toEqual(expect.arrayContaining([{ backgroundColor: "#121421" }]));
  });

  // @req UX-SKY-04[badger-mobile]
  // @req UX-SKY-04[parrot]
  it("gives each navigator screen its own sky and the app-wide layer stands down: one star field", () => {
    const navigation = fakeNavigation(true);
    const renderer = draw(
      <MobileSkyLayer>
        <MobileSkyScreenLayout navigation={navigation}>
          <View testID="settings" />
        </MobileSkyScreenLayout>
      </MobileSkyLayer>,
    );
    expect(skies(renderer)).toHaveLength(1);
    expect(skies(renderer)[0].props.paused).toBe(false);
    // Covered by another screen: its stars stand still (UX-SKY-01).
    navigation.emit("blur");
    expect(skies(renderer)[0].props.paused).toBe(true);
    navigation.emit("focus");
    expect(skies(renderer)[0].props.paused).toBe(false);
  });

  it("leaves the sky to a screen that paints its own with shooting stars, and takes it back when it goes", () => {
    const comets = { input: {}, covers: {} } as never;
    const tree = (withBackdrop: boolean) => (
      <MobileSkyLayer>
        <MobileSkyScreenLayout navigation={fakeNavigation(true)}>
          {withBackdrop ? <MobileAppBackdrop comets={comets} /> : <View testID="plain" />}
        </MobileSkyScreenLayout>
      </MobileSkyLayer>
    );
    const renderer = draw(tree(true));
    expect(skies(renderer)).toHaveLength(1);
    expect(skies(renderer)[0].props.comets).toBe(comets);
    act(() => renderer.update(tree(false)));
    expect(skies(renderer)).toHaveLength(1);
    expect(skies(renderer)[0].props.comets).toBeUndefined();
  });

  it("draws no sky of its own on a see-through screen (the video player, a sheet): the app-wide one shows", () => {
    const renderer = draw(
      <MobileSkyLayer>
        <MobileSkyScreenLayout navigation={fakeNavigation(true)} sky={false}>
          <View testID="player" />
        </MobileSkyScreenLayout>
      </MobileSkyLayer>,
    );
    expect(skies(renderer)).toHaveLength(1);
    expect(skies(renderer)[0].props.paused).toBeUndefined();
  });

  // @req UX-SKY-04[badger-mobile]
  // @req UX-SKY-04[parrot]
  it("makes the navigator's screens and headers transparent over the sky", () => {
    const base = { dark: false, colors: { background: "#000", card: "#000", text: "#000", primary: "#000", border: "#000", notification: "#f00" } };
    const theme = mobileNavigationTheme(base, { text: "#eee", accent: "#ffb257", border: "#333" });
    expect(theme.dark).toBe(true);
    expect(theme.colors).toMatchObject({ background: "transparent", card: "transparent", text: "#eee", primary: "#ffb257", border: "#333", notification: "#f00" });
  });
});

const View = (props: { testID: string }) => React.createElement("View", props);
