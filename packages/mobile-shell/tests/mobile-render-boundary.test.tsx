/**
 * @test-id MOBILE-SHELL-RENDER-BOUNDARY-001
 * @level unit
 * @why UX-CRASH-01: one screen that throws while rendering must show a small notice with Retry in its place, in the
 *   app's language with the same words as the web guard, instead of React unmounting the whole phone app.
 */
import { RENDER_ERROR_COPY } from "@space/shared/renderError";
import { describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => {
  type Stub = ((props: unknown) => unknown) & { displayName?: string };
  const make = (name: string): Stub => {
    const stub: Stub = (props) => props;
    stub.displayName = name;
    return stub;
  };
  return { PressableStub: make("PressableStub"), TextStub: make("TextStub"), ViewStub: make("ViewStub"), lang: { value: "fr" } };
});

vi.mock("react-native", () => ({
  Pressable: stubs.PressableStub,
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: stubs.TextStub,
  View: stubs.ViewStub,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: {}, accentHex: "#ffb357", accentTextHex: "#121421" }),
}));
vi.mock("../src/i18n", () => ({ getCurrentLanguage: () => stubs.lang.value }));
// The window notice's sky and mascot, as plain host nodes (their own tests cover them).
vi.mock("../src/components/mobile-app-backdrop", () => ({ default: "MobileAppBackdrop" }));
vi.mock("../src/components/mobile-auth-brand", () => ({ MobileAuthBrand: "MobileAuthBrand" }));

import { MobileRenderBoundary, MobileRenderFallback } from "../src/components/mobile-render-boundary";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

const texts = (node: unknown, out: unknown[] = []): unknown[] => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  const element = node as Element;
  if (element.type === stubs.TextStub) out.push(element.props.children);
  texts(element.props?.children, out);
  return out;
};

describe("MobileRenderBoundary", () => {
  it("swaps a crashed screen for the shared notice with its one button, and Try again mounts it anew", () => {
    const boundary = new MobileRenderBoundary({ name: "screen:Album", resetKey: "a", children: "screen" });
    // The screen sits under a key that "Try again" changes, so its component state starts over.
    const content = boundary.render() as Element & { key: string | null };
    expect(content.props.children).toBe("screen");
    expect(content.key).toBe("0");

    boundary.state = { ...boundary.state, ...MobileRenderBoundary.getDerivedStateFromError(new Error("boom")) };
    const fallback = boundary.render() as Element;
    expect(fallback.type).toBe(MobileRenderFallback);
    expect(fallback.props.name).toBe("screen:Album");

    const tree = MobileRenderFallback({ name: "screen:Album", onRetry: () => undefined }) as unknown as Element;
    expect(tree.props.testID).toBe("render-boundary:screen:Album");
    expect(texts(tree)).toEqual([RENDER_ERROR_COPY.fr.message, RENDER_ERROR_COPY.fr.detail, RENDER_ERROR_COPY.fr.retry]);

    const setState = vi.fn();
    boundary.setState = setState;
    boundary.retry();
    const update = setState.mock.calls[0][0] as (state: { generation: number }) => unknown;
    expect(update({ generation: 0 })).toEqual({ error: null, retrying: false, generation: 1 });
  });

  it("clears the error when the route changes", () => {
    const state = { error: new Error("boom"), resetKey: "a", generation: 0, retrying: false };
    expect(MobileRenderBoundary.getDerivedStateFromProps({ name: "s", resetKey: "a" }, state)).toBeNull();
    expect(MobileRenderBoundary.getDerivedStateFromProps({ name: "s", resetKey: "b" }, state)).toEqual({ error: null, resetKey: "b", retrying: false });
  });

  it("logs which screen crashed", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boundary = new MobileRenderBoundary({ name: "screen:Home" });
    boundary.componentDidCatch(new Error("boom"), { componentStack: "\n at Home" });
    expect(error).toHaveBeenCalledWith("[render-boundary] screen:Home crashed: boom", "\n at Home");
    error.mockRestore();
  });
});
