/**
 * @test-id MOBILE-SHELL-AUTH-FORM-TV-001
 * @level unit
 * @bugfix @regression-proof
 * @why On the real Google TV "Salon" (2026-11-08) the TV password form showed no focus on the email field, the
 *   password field or the sign-in button, and text typed after moving down still went into the email field: the
 *   field's wrapper took the remote's focus instead of the text input. On TV the wrapper must not be focusable, the
 *   fields, the button and the forgot-password link must show the TV focus ring, and the keyboard's action key must reach the caller. The phone
 *   keeps its look; its field wrapper is not focusable either (Pixel 8, 2026-11-13: Tab from the email parked the focus
 *   on the password's invisible wrapper and the typed keys were lost, UX-PHONE-08).
 * @req UX-TV-16[badger-tv]
 * @req UX-PHONE-08[badger-mobile]
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => {
  type Stub = ((props: unknown) => unknown) & { displayName?: string };
  const PressableStub: Stub = (props) => props;
  PressableStub.displayName = "PressableStub";
  const TextInputStub: Stub = (props) => props;
  TextInputStub.displayName = "TextInputStub";
  const ViewStub: Stub = (props) => props;
  ViewStub.displayName = "ViewStub";
  const platform = { isTV: false, OS: "android" };
  // `useState` returns the value the test sets, so a render can be taken "while focused".
  const state = { focused: false };
  return { PressableStub, TextInputStub, ViewStub, platform, state };
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useState = <T,>(initial: T) => [(typeof initial === "boolean" ? stubs.state.focused : initial) as T, () => undefined] as const;
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useCallback = <T,>(fn: T) => fn;
  return { ...actual, default: { ...actual, useState, useRef, useCallback }, useState, useRef, useCallback };
});
vi.mock("react-native", () => ({
  Image: () => null,
  Platform: stubs.platform,
  Pressable: stubs.PressableStub,
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: () => null,
  TextInput: stubs.TextInputStub,
  View: stubs.ViewStub,
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: stubs.ViewStub },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: () => 0,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#f4a261", text: "#fff", textDim: "#64768f", controlBorder: "#333" }, accentTextHex: "#000" }),
}));

import { MobileAuthButton, MobileAuthInput, MobileAuthLink } from "../src/components/mobile-auth-form";
import { TV_FOCUS_RING_WIDTH } from "../src/components/tv-focus";

// React 18 keeps `ref` on the element; React 19 also exposes it as a prop.
type Element = { type: unknown; ref?: unknown; props: Record<string, unknown> & { children?: unknown } };

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

const renderInput = (extra: Record<string, unknown> = {}) =>
  MobileAuthInput({ value: "", onChangeText: () => undefined, placeholder: "Email", ...extra }) as Element;
const renderButton = () => {
  const outer = MobileAuthButton({ label: "Sign in", onPress: () => undefined }) as Element;
  return findByType(outer, stubs.PressableStub)!;
};
const renderLink = () => MobileAuthLink({ label: "FORGOT PASSWORD?", onPress: () => undefined, color: "#64768f" }) as Element;

afterEach(() => {
  stubs.platform.isTV = false;
  stubs.state.focused = false;
});

describe("sign-in form on TV — @req UX-TV-16[badger-tv]", () => {
  it("lets the remote focus the text input, not its wrapper", () => {
    stubs.platform.isTV = true;
    const wrap = renderInput();
    console.log("[auth-form-tv] wrapper focusable on TV:", wrap.props.focusable);
    expect(wrap.props.focusable).toBe(false);
  });

  it("rings the focused field in the accent colour with the TV ring width", () => {
    stubs.platform.isTV = true;
    const idle = flat(renderInput().props.style);
    stubs.state.focused = true;
    const focused = flat(renderInput().props.style);
    console.log("[auth-form-tv] field idle/focused", idle, focused);
    expect(idle.borderWidth).toBe(TV_FOCUS_RING_WIDTH);
    expect(focused.borderWidth).toBe(TV_FOCUS_RING_WIDTH);
    expect(focused.borderColor).toBe("#f4a261");
    expect(idle.borderColor).not.toBe(focused.borderColor);
  });

  it("rings and grows the focused sign-in button, with the ring laid out while idle", () => {
    stubs.platform.isTV = true;
    const idle = flat(renderButton().props.style);
    stubs.state.focused = true;
    const button = renderButton();
    const focused = flat(button.props.style);
    console.log("[auth-form-tv] button idle/focused", idle, focused);
    expect(button.props.onFocus).toBeTypeOf("function");
    expect(idle.borderWidth).toBe(TV_FOCUS_RING_WIDTH);
    expect(idle.borderColor).toBe("transparent");
    expect(focused.borderColor).toBe("#fff");
    expect(focused.transform).toEqual([{ scale: 1.06 }]);
  });

  it("hands the keyboard's action key to the caller and keeps the keyboard open on Next", () => {
    stubs.platform.isTV = true;
    const onSubmitEditing = vi.fn();
    const ref = { current: null };
    const input = findByType(renderInput({ returnKeyType: "next", onSubmitEditing, inputRef: ref }), stubs.TextInputStub)!;
    expect(input.props.returnKeyType).toBe("next");
    expect(input.props.submitBehavior).toBe("submit");
    (input.props.onSubmitEditing as () => void)();
    expect(onSubmitEditing).toHaveBeenCalledTimes(1);
    expect(input.props.ref ?? input.ref).toBe(ref);
  });

  it("rings the focused forgot-password link in the text colour", () => {
    stubs.platform.isTV = true;
    const idle = flat(renderLink().props.style);
    stubs.state.focused = true;
    const link = renderLink();
    const focused = flat(link.props.style);
    expect(link.props.onFocus).toBeTypeOf("function");
    expect(idle.borderWidth).toBe(TV_FOCUS_RING_WIDTH);
    expect(idle.borderColor).toBe("transparent");
    expect(focused.borderColor).toBe("#fff");
  });
});

describe("sign-in form on the phone", () => {
  /** @req UX-PHONE-08[badger-mobile] @bugfix @regression-proof */
  it("never lets the field's wrapper take the keyboard focus (Tab from the email reaches the password's text input)", () => {
    const wrap = renderInput();
    console.log("[auth-form-phone] wrapper focusable on phone:", wrap.props.focusable);
    expect(wrap.props.focusable).toBe(false);
  });

  it("keeps the 1 dp field border and the unringed button", () => {
    const wrap = renderInput();
    expect(flat(wrap.props.style).borderWidth).toBe(1);
    const button = renderButton();
    expect(button.props.onFocus).toBeUndefined();
    expect(flat(button.props.style).borderWidth).toBeUndefined();
    const input = findByType(renderInput(), stubs.TextInputStub)!;
    expect(input.props.returnKeyType).toBeUndefined();
    expect(input.props.submitBehavior).toBeUndefined();
    const link = renderLink();
    expect(link.props.onFocus).toBeUndefined();
    expect(flat(link.props.style).borderWidth).toBeUndefined();
  });
});
