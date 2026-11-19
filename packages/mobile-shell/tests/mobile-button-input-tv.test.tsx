/**
 * @test-id MOBILE-SHELL-BUTTON-INPUT-TV-001
 * @level unit
 * @bugfix @regression-proof
 * @why On the real Google TV "Salon" (2026-11-08) the "Media library key" screen showed no focus at all: its key
 *   field and its Validate key / Sign out buttons are the shared MobileInput and MobileButton, which drew no
 *   ring for the remote. On TV they must ring the focused control like the sign-in form; the phone keeps its look.
 * @req UX-TV-17[badger-tv]
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const stubs = vi.hoisted(() => {
  type Stub = ((props: unknown) => unknown) & { displayName?: string };
  const PressableStub: Stub = (props) => props;
  const TextInputStub: Stub = (props) => props;
  const ViewStub: Stub = (props) => props;
  const platform = { isTV: false, OS: "android" };
  const state = { focused: false };
  return { PressableStub, TextInputStub, ViewStub, platform, state };
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useState = <T,>(initial: T) => [(typeof initial === "boolean" ? stubs.state.focused : initial) as T, () => undefined] as const;
  return { ...actual, default: { ...actual, useState }, useState };
});
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Platform: stubs.platform,
  Pressable: stubs.PressableStub,
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: () => null,
  TextInput: stubs.TextInputStub,
  View: stubs.ViewStub,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#f4a261", text: "#fff", textMuted: "#999", controlBorder: "#333", surfaceRaised: "#222", danger: "#e00" },
    accentTextHex: "#000",
  }),
}));

import { MobileButtonFace } from "../src/components/mobile-button-face";
import { MobileInput } from "../src/components/mobile-input";
import { TV_FOCUS_RING_WIDTH, TV_FOCUS_SCALE } from "../src/components/tv-focus";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

const findByType = (node: unknown, type: unknown): Element | undefined => {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type);
      if (hit) return hit;
    }
    return undefined;
  }
  const element = node as Element;
  if (element.type === type) return element;
  return findByType(element.props?.children, type);
};

const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? (style as Record<string, unknown>) : {};

const renderButton = (variant: "primary" | "secondary" = "primary") =>
  MobileButtonFace({ label: "Validate key", onPress: () => undefined, variant }) as Element;
const renderInput = () =>
  findByType(MobileInput({ label: "Enter your key", value: "", onChangeText: () => undefined }), stubs.TextInputStub)!;

afterEach(() => {
  stubs.platform.isTV = false;
  stubs.state.focused = false;
});

describe("shared button and field on TV — @req UX-TV-17[badger-tv]", () => {
  it("rings and grows the focused button in the text colour, ring laid out while idle", () => {
    stubs.platform.isTV = true;
    for (const variant of ["primary", "secondary"] as const) {
      const idle = renderButton(variant);
      stubs.state.focused = true;
      const focused = flat(renderButton(variant).props.style);
      stubs.state.focused = false;
      console.log(`[button-tv] ${variant} idle/focused`, flat(idle.props.style), focused);
      expect(idle.props.onFocus).toBeTypeOf("function");
      expect(flat(idle.props.style).borderWidth).toBe(TV_FOCUS_RING_WIDTH);
      expect(flat(idle.props.style).borderColor).toBe("transparent");
      expect(focused.borderWidth).toBe(TV_FOCUS_RING_WIDTH);
      expect(focused.borderColor).toBe("#fff");
      expect(focused.transform).toEqual([{ scale: TV_FOCUS_SCALE }]);
    }
  });

  it("rings the focused field in the accent colour", () => {
    stubs.platform.isTV = true;
    const idle = flat(renderInput().props.style);
    stubs.state.focused = true;
    const input = renderInput();
    const focused = flat(input.props.style);
    console.log("[input-tv] idle/focused", idle, focused);
    expect(input.props.onFocus).toBeTypeOf("function");
    expect(idle.borderWidth).toBe(TV_FOCUS_RING_WIDTH);
    expect(focused.borderWidth).toBe(TV_FOCUS_RING_WIDTH);
    expect(focused.borderColor).toBe("#f4a261");
  });

  it("keeps the phone's look: no ring, no focus handlers", () => {
    stubs.state.focused = true;
    const button = renderButton();
    const input = renderInput();
    expect(button.props.onFocus).toBeUndefined();
    expect(flat(button.props.style).transform).toBeUndefined();
    expect(flat(input.props.style).borderWidth).toBe(1);
    expect(flat(input.props.style).borderColor).toBe("#333");
  });

  it("starts the remote on a button marked as the preferred focus, on TV only", () => {
    const props = { label: "Cancel", onPress: () => undefined, hasTVPreferredFocus: true };
    stubs.platform.isTV = true;
    const tv = MobileButtonFace(props) as Element;
    const plain = renderButton();
    stubs.platform.isTV = false;
    const phone = MobileButtonFace(props) as Element;
    console.log("[button-tv] preferred focus tv/plain/phone", tv.props.hasTVPreferredFocus, plain.props.hasTVPreferredFocus, phone.props.hasTVPreferredFocus);
    expect(tv.props.hasTVPreferredFocus).toBe(true);
    expect(plain.props.hasTVPreferredFocus).toBeUndefined();
    expect(phone.props.hasTVPreferredFocus).toBeUndefined();
  });

  // The grey-out rule (AuditTvs 2026-11-18): a disabled control is its idle colour at 50% opacity, as the setup pills,
  // the tab bar and the TV's own buttons; MobileButton had 0.6.
  it("greys a disabled button at half opacity, on phone and TV", () => {
    for (const isTV of [false, true]) {
      stubs.platform.isTV = isTV;
      stubs.state.focused = false;
      const idle = flat(renderButton().props.style);
      const off = flat((MobileButtonFace({ label: "Validate key", onPress: () => undefined, disabled: true }) as Element).props.style);
      console.log("[button-tv] disabled opacity", isTV ? "tv" : "phone", idle.opacity, off.opacity);
      expect(idle.opacity).toBeUndefined();
      expect(off.opacity).toBe(0.5);
    }
    stubs.platform.isTV = false;
  });
});
