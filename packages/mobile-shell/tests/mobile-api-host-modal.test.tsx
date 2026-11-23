/**
 * @test-id MOBILE-SHELL-API-HOST-MODAL-001
 * @level unit
 * @bugfix @regression-proof
 * @why The tap-outside-to-close backdrop and the card are Pressables, which iOS
 *   exposes as one accessible element each by default. The whole "Connection
 *   hosts" window collapsed into a single block: VoiceOver (and the device UI
 *   tests on an iPhone, 2026-10-16) could not reach the host field or the
 *   Save / Use default buttons inside it.
 */
import React from "react";
import type * as ReactModule from "react";
import { describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => {
  type Stub = ((props: unknown) => unknown) & { displayName?: string };
  const make = (name: string): Stub => {
    const stub: Stub = (props) => props;
    stub.displayName = name;
    return stub;
  };
  return {
    ModalStub: make("ModalStub"),
    PressableStub: make("PressableStub"),
    TextInputStub: make("TextInputStub"),
    ViewStub: make("ViewStub"),
    TextStub: make("TextStub"),
  };
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  const useState = <T,>(initial: T) => [initial, () => undefined] as const;
  const useCallback = <T,>(fn: T) => fn;
  return { ...actual, default: { ...actual, useState, useCallback }, useState, useCallback };
});
vi.mock("react-native", () => ({
  Modal: stubs.ModalStub,
  Pressable: stubs.PressableStub,
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: stubs.TextStub,
  TextInput: stubs.TextInputStub,
  View: stubs.ViewStub,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: {}, accentTextHex: "#000" }),
}));
vi.mock("../src/components/mobile-render-boundary", () => ({
  MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

import { MobileApiHostModal } from "../src/components/mobile-api-host-modal";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

const collect = (node: unknown, type: unknown, out: Element[] = []): Element[] => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, type, out);
    return out;
  }
  const element = node as Element;
  if (element.type === type) out.push(element);
  collect(element.props?.children, type, out);
  return out;
};

const labels = {
  title: "Connection hosts",
  subtitle: "s",
  label: "Custom host",
  placeholder: "api.spacefleet.io",
  hint: "h",
  useDefault: "Use default",
  save: "Save",
  saving: "Saving...",
  error: "e",
};

describe("MobileApiHostModal accessibility", () => {
  const tree = MobileApiHostModal({
    visible: true,
    onClose: () => undefined,
    currentHost: "",
    onSave: async () => undefined,
    labels,
  }) as unknown as Element;
  const pressables = collect(tree, stubs.PressableStub);

  it("keeps the backdrop and card from swallowing the controls inside them", () => {
    const [backdrop, card] = pressables;
    expect(backdrop?.props.accessible).toBe(false);
    expect(card?.props.accessible).toBe(false);
  });

  it("exposes the host field and both actions as their own labelled controls", () => {
    const input = collect(tree, stubs.TextInputStub)[0];
    expect(input?.props.accessibilityLabel).toBe("Custom host");
    const actions = pressables.slice(2);
    expect(actions.map((p) => p.props.accessibilityRole)).toEqual(["button", "button"]);
  });
});
