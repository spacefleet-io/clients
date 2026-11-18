/**
 * @test-id MOBILE-SHELL-AUTH-BRAND-001
 * @level unit
 * @req UX-THEME-02[parrot]
 * @why Chris on the Pixel 8: Parrot's sign-in "doesn't have the floating mascot". The floating mascot is one shared
 *   component: it must float (10 pt, 3 s each way, looped), glow in the app's own accent, and load without
 *   react-native-reanimated, which Parrot does not ship.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const anim = vi.hoisted(() => ({
  timings: [] as { toValue: number; duration: number; useNativeDriver: boolean }[],
  started: 0,
  stopped: 0,
  set: [] as number[],
}));
const a11y = vi.hoisted(() => ({
  answer: Promise.resolve(false) as Promise<boolean>,
  listeners: [] as ((enabled: boolean) => void)[],
  removed: 0,
}));

vi.mock("react-native", () => {
  class Value {
    constructor(public value: number) {}
    setValue(next: number) {
      this.value = next;
      anim.set.push(next);
    }
  }
  return {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => a11y.answer,
      addEventListener: (event: string, listener: (enabled: boolean) => void) => {
        if (event === "reduceMotionChanged") a11y.listeners.push(listener);
        return { remove: () => a11y.removed++ };
      },
    },
    Animated: {
      Value,
      View: "AnimatedView",
      timing: (_value: unknown, config: { toValue: number; duration: number; useNativeDriver: boolean }) => {
        anim.timings.push(config);
        return config;
      },
      sequence: (steps: unknown[]) => steps,
      loop: (body: unknown) => ({ body, start: () => anim.started++, stop: () => anim.stopped++ }),
    },
    Easing: { inOut: () => undefined, ease: undefined },
    Image: "Image",
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
    Text: "Text",
    View: "View",
  };
});
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#40dd8f", textMuted: "#b6bace" } }),
}));

import { MOBILE_AUTH_BRAND_FLOAT, MobileAuthBrand } from "../src/components/mobile-auth-brand";

const mount = async (reduceMotion: boolean): Promise<ReactTestRenderer> => {
  a11y.answer = Promise.resolve(reduceMotion);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<MobileAuthBrand iconSource={{ uri: "mascot" }} subtitle="SIGN IN" />);
  });
  return renderer;
};

beforeEach(() => {
  anim.timings = [];
  anim.started = 0;
  anim.stopped = 0;
  anim.set = [];
  a11y.listeners = [];
  a11y.removed = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("MobileAuthBrand", () => {
  it("floats the mascot 10 pt up and back, 3 s each way, on the native driver, in a loop", async () => {
    const renderer = await mount(false);
    expect(MOBILE_AUTH_BRAND_FLOAT).toEqual({ distance: -10, legMs: 3000 });
    expect(anim.timings.map((t) => [t.toValue, t.duration, t.useNativeDriver])).toEqual([
      [-10, 3000, true],
      [0, 3000, true],
    ]);
    expect(anim.started).toBe(1);
    expect(renderer.root.findAll((node) => (node.type as unknown) === "AnimatedView")).toHaveLength(1);
    act(() => renderer.unmount());
    expect(anim.stopped).toBe(1);
    expect(a11y.removed).toBe(1);
  });

  // @req UX-A11Y-03[parrot,badger-mobile,badger-tv]
  it("stands still and starts no loop when the system asks for reduced motion (Android: animator scale 0)", async () => {
    const renderer = await mount(true);
    expect(anim.timings).toEqual([]);
    expect(anim.started).toBe(0);
    // The mascot is drawn at rest, where the float starts.
    expect(renderer.root.findAll((node) => (node.type as unknown) === "Image")).toHaveLength(1);
    expect(anim.set.at(-1)).toBe(0);
    act(() => renderer.unmount());
    expect(anim.started).toBe(0);
  });

  // @req UX-A11Y-03[parrot,badger-mobile,badger-tv]
  it("follows the setting while shown: stops the float when it turns on, floats again when it turns off", async () => {
    const renderer = await mount(false);
    expect(anim.started).toBe(1);
    act(() => a11y.listeners.forEach((listener) => listener(true)));
    expect(anim.stopped).toBe(1);
    expect(anim.started).toBe(1);
    expect(anim.set.at(-1)).toBe(0);
    act(() => a11y.listeners.forEach((listener) => listener(false)));
    expect(anim.started).toBe(2);
    act(() => renderer.unmount());
    expect(anim.stopped).toBe(2);
  });

  // @req UX-A11Y-03[parrot,badger-mobile,badger-tv]
  it("starts no loop before the system has answered", async () => {
    const { promise, resolve: answer } = Promise.withResolvers<boolean>();
    a11y.answer = promise;
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<MobileAuthBrand iconSource={{ uri: "mascot" }} />);
    });
    expect(anim.started).toBe(0);
    await act(async () => answer(true));
    expect(anim.started).toBe(0);
    act(() => renderer.unmount());
  });

  it("glows in the app's accent instead of a fixed Badger orange", async () => {
    const renderer = await mount(false);
    const image = renderer.root.find((node) => (node.type as unknown) === "Image");
    expect(image.props.source).toEqual({ uri: "mascot" });
    // The mascot's size (UX-PHONE-05) rides in the same style object as the glow colour.
    expect(image.props.style).toContainEqual(expect.objectContaining({ shadowColor: "#40dd8f" }));
    act(() => renderer.unmount());
  });

  it("does not need react-native-reanimated", () => {
    const source = readFileSync(new URL("../src/components/mobile-auth-brand.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("react-native-reanimated");
  });
});
