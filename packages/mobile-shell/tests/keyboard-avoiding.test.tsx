/**
 * @test-id MOBILE-SHELL-KEYBOARD-AVOID-001
 * @level unit
 * @bugfix @regression-proof
 * @why Found on the emulator (2026-11-08, Android 16): focusing the e-mail field of Parrot's sign-in left it under
 *   the on-screen keyboard. An app built for Android 15 or later is drawn edge to edge on Android 15 and up, so the
 *   window no longer shrinks for the keyboard. React Native's `KeyboardAvoidingView` is no cure there: with "padding"
 *   it lifted the form, but once the keyboard closed it squeezed the whole form out of sight (its "keyboard hidden"
 *   event puts the keyboard at the top of the screen). Edge-to-edge Android now pads the form by the keyboard's height
 *   while it is up and by nothing once it is down; iOS keeps `KeyboardAvoidingView`; older Android keeps the window
 *   resize. Shared by Badger (sign-in, key) and Parrot (setup, sign-in, key).
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => {
  type Stub = ((props: unknown) => unknown) & { displayName?: string };
  const ViewStub: Stub = (props) => props;
  ViewStub.displayName = "ViewStub";
  const AvoidingStub: Stub = (props) => props;
  AvoidingStub.displayName = "KeyboardAvoidingViewStub";
  const platform = { OS: "android", Version: 36 as number | string };
  const listeners: string[] = [];
  return { ViewStub, AvoidingStub, platform, listeners };
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useState = <T,>(initial: T) => [initial, () => undefined] as const;
  const useEffect = (effect: () => unknown) => void effect();
  return { ...actual, default: { ...actual, useState, useEffect }, useState, useEffect };
});
vi.mock("react-native", () => ({
  Keyboard: {
    addListener: (name: string) => {
      stubs.listeners.push(name);
      return { remove: () => undefined };
    },
  },
  KeyboardAvoidingView: stubs.AvoidingStub,
  Platform: stubs.platform,
  View: stubs.ViewStub,
}));

import { KeyboardAvoidingForm, keyboardInsetAfter, keyboardLiftFor } from "../src/keyboard";

type Element = { type: unknown; props: Record<string, unknown> };
const render = (os: string, version: number | string): Element => {
  stubs.platform.OS = os;
  stubs.platform.Version = version;
  stubs.listeners.length = 0;
  return KeyboardAvoidingForm({ style: { flex: 1 }, iosOffset: 90, children: "form" }) as unknown as Element;
};

describe("keyboardLiftFor", () => {
  it("uses KeyboardAvoidingView on iOS", () => {
    const lift = keyboardLiftFor("ios", "18.0");
    console.info("keyboard lift", { os: "ios", lift });
    expect(lift).toBe("avoiding-view");
  });

  it("pads by the keyboard on Android 15 and later, where the window no longer shrinks for it", () => {
    for (const api of [35, 36]) {
      const lift = keyboardLiftFor("android", api);
      console.info("keyboard lift", { os: "android", api, lift });
      expect(lift).toBe("keyboard-inset");
    }
  });

  it("leaves older Android to the window resize", () => {
    for (const api of [26, 33, 34]) {
      const lift = keyboardLiftFor("android", api);
      console.info("keyboard lift", { os: "android", api, lift });
      expect(lift).toBe("window-resize");
    }
  });
});

describe("keyboardInsetAfter", () => {
  it("is the keyboard's height while it is shown and nothing once it is hidden", () => {
    const shown = keyboardInsetAfter(true, { endCoordinates: { screenX: 0, screenY: 0, width: 411, height: 297 } });
    const hidden = keyboardInsetAfter(false);
    console.info("keyboard inset", { shown, hidden });
    expect(shown).toBe(297);
    expect(hidden).toBe(0);
  });
});

describe("KeyboardAvoidingForm", () => {
  it("on Android 16 is a plain view that listens for the keyboard, never KeyboardAvoidingView", () => {
    const element = render("android", 36);
    console.info("android 16 form", { isView: element.type === stubs.ViewStub, listeners: [...stubs.listeners] });
    expect(element.type).toBe(stubs.ViewStub);
    expect(element.props.style).toEqual([{ flex: 1 }, { paddingBottom: 0 }]);
    expect(stubs.listeners).toEqual(["keyboardDidShow", "keyboardDidHide"]);
  });

  it("on iOS is KeyboardAvoidingView with padding and the header offset", () => {
    const element = render("ios", "18.0");
    console.info("ios form", { props: { ...element.props, children: undefined }, listeners: [...stubs.listeners] });
    expect(element.type).toBe(stubs.AvoidingStub);
    expect(element.props).toMatchObject({ behavior: "padding", keyboardVerticalOffset: 90 });
    expect(stubs.listeners).toEqual([]);
  });

  it("on older Android adds no padding and listens to nothing", () => {
    const element = render("android", 33);
    expect(element.type).toBe(stubs.ViewStub);
    expect(element.props.style).toEqual([{ flex: 1 }, { paddingBottom: 0 }]);
    expect(stubs.listeners).toEqual([]);
  });
});
