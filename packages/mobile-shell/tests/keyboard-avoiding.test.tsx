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
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

import { KeyboardAvoidingForm, keyboardCoverage, keyboardInsetAfter, keyboardLiftFor } from "../src/keyboard";

type Element = { type: unknown; props: Record<string, unknown> };
const render = (os: string, version: number | string, translucentModal?: boolean): Element => {
  stubs.platform.OS = os;
  stubs.platform.Version = version;
  stubs.listeners.length = 0;
  return KeyboardAvoidingForm({ style: { flex: 1 }, iosOffset: 90, translucentModal, children: "form" }) as unknown as Element;
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

  it("pads by the keyboard on any Android inside a statusBarTranslucent Modal, whose window never shrinks", () => {
    for (const api of [26, 34, 36]) {
      const lift = keyboardLiftFor("android", api, true);
      console.info("keyboard lift", { os: "android", api, translucentModal: true, lift });
      expect(lift).toBe("keyboard-inset");
    }
    expect(keyboardLiftFor("ios", "18.0", true)).toBe("avoiding-view");
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

// A statusBarTranslucent Modal runs under the navigation bar, which the keyboard's reported height leaves out: on op9
// (804 dp screen) the keyboard's top sat at 505 dp but its height read 283, so padding by the height hid the buttons.
describe("keyboardCoverage", () => {
  it("is the stretch of the form below the keyboard's top edge, and nothing while it is hidden or unmeasured", () => {
    const covered = keyboardCoverage(804, 505);
    console.info("keyboard coverage", { covered, hidden: keyboardCoverage(804, null), unmeasured: keyboardCoverage(null, 505) });
    expect(covered).toBe(299);
    expect(keyboardCoverage(804, null)).toBe(0);
    expect(keyboardCoverage(null, 505)).toBe(0);
    expect(keyboardCoverage(400, 505)).toBe(0);
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

  it("in a statusBarTranslucent Modal on older Android listens for the keyboard", () => {
    const element = render("android", 34, true);
    console.info("android 14 modal form", { isView: element.type === stubs.ViewStub, listeners: [...stubs.listeners] });
    expect(element.type).toBe(stubs.ViewStub);
    expect(element.props.style).toEqual([{ flex: 1 }, { paddingBottom: 0 }]);
    expect(typeof element.props.onLayout).toBe("function");
    expect(stubs.listeners).toEqual(["keyboardDidShow", "keyboardDidHide"]);
  });
});

// #3350 S47: Parrot's Edit details and playlist name dialogs still used a raw `KeyboardAvoidingView` "padding" after
// the shared fix, so on Android 15+ they could slide out of sight. Every phone form goes through KeyboardAvoidingForm.
describe("phone forms", () => {
  it("no app or shared phone package uses KeyboardAvoidingView except keyboard.tsx", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const dirs = ["apps/badger/mobile/src", "apps/parrot/mobile/src", "packages/mobile-shell/src"];
    const raw = dirs.flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.tsx?$/.test(file))
        .map((file) => relative(root, join(root, dir, file)))
        .filter((file) => file !== "packages/mobile-shell/src/keyboard.tsx" && readFileSync(join(root, file), "utf8").includes("KeyboardAvoidingView"))
    );
    console.info("[keyboard] raw KeyboardAvoidingView", raw);
    expect(raw).toEqual([]);
  });
});
