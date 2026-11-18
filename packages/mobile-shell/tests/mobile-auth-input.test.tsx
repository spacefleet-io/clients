/**
 * @test-id MOBILE-SHELL-AUTH-INPUT-001
 * @level unit
 * @bugfix @regression-proof
 * @why On iOS a TextInput is only as tall as its text line, so inside the 56 pt
 *   sign-in field only a thin strip was tappable: Chris could barely focus the
 *   email field on his iPhone. A tap anywhere on the field (icon, padding,
 *   empty space) must focus the text input.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => {
  type Stub = ((props: unknown) => unknown) & { displayName?: string };
  const PressableStub: Stub = (props) => props;
  PressableStub.displayName = "PressableStub";
  const TextInputStub: Stub = (props) => props;
  TextInputStub.displayName = "TextInputStub";
  const ViewStub: Stub = (props) => props;
  ViewStub.displayName = "ViewStub";
  return { PressableStub, TextInputStub, ViewStub };
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useState = <T,>(initial: T) => [initial, () => undefined] as const;
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useCallback = <T,>(fn: T) => fn;
  return { ...actual, default: { ...actual, useState, useRef, useCallback }, useState, useRef, useCallback };
});
vi.mock("react-native", () => ({
  Image: () => null,
  Platform: { isTV: false, OS: "ios" },
  Pressable: stubs.PressableStub,
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: () => null,
  TextInput: stubs.TextInputStub,
  View: stubs.ViewStub,
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: () => null },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withRepeat: () => 0,
  withSequence: () => 0,
  withTiming: () => 0,
  withSpring: () => 0,
  Easing: { inOut: () => undefined, ease: undefined },
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#f4a261", text: "#fff", textDim: "#64768f" } }),
}));

import { MobileAuthInput } from "../src/components/mobile-auth-form";

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

describe("MobileAuthInput", () => {
  it("focuses the text input when the field is tapped anywhere", () => {
    const tree = MobileAuthInput({ value: "", onChangeText: () => undefined, placeholder: "Email" }) as Element;

    const input = findByType(tree, stubs.TextInputStub);
    expect(input).toBeDefined();
    const focus = vi.fn();
    const ref = (input?.props.ref ?? input?.ref) as { current: unknown } | undefined;
    expect(ref).toBeDefined();
    if (ref) ref.current = { focus };

    expect(tree.type).toBe(stubs.PressableStub);
    const onPress = tree.props.onPress as (() => void) | undefined;
    expect(onPress).toBeTypeOf("function");
    onPress?.();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  // @bugfix @regression-proof: a tester's iPhone sent a different password than the one they typed (2x 401, same
  // credentials via curl = 200). Without textContentType iOS offers Strong Password autofill and autocorrect on
  // the field; the credentials fields must opt out of autocorrect/spellcheck and declare what they are.
  it("never autocorrects or spellchecks, even when the caller sets nothing", () => {
    const tree = MobileAuthInput({ value: "", onChangeText: () => undefined, placeholder: "Password" }) as Element;
    const input = findByType(tree, stubs.TextInputStub);
    expect(input?.props.autoCorrect).toBe(false);
    expect(input?.props.spellCheck).toBe(false);
    expect(input?.props.autoCapitalize).toBe("none");
  });

  it("forwards textContentType and autoComplete to the native text input", () => {
    const tree = MobileAuthInput({
      value: "",
      onChangeText: () => undefined,
      placeholder: "Password",
      secureTextEntry: true,
      textContentType: "password",
      autoComplete: "password",
    }) as Element;
    const input = findByType(tree, stubs.TextInputStub);
    expect(input?.props.textContentType).toBe("password");
    expect(input?.props.autoComplete).toBe("password");
    expect(input?.props.secureTextEntry).toBe(true);
  });
});
