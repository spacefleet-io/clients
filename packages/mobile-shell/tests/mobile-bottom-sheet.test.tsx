/**
 * @test-id MOBILE-SHELL-BOTTOM-SHEET-001
 * @level unit
 * @why Main (2026-11-18, REL-GATE-09): every phone bottom sheet of Badger and Parrot is one shared sheet that a drag on
 *   its 44 pt handle zone moves with the finger, closing past a distance or on a flick and springing back otherwise; the
 *   backdrop stays in place and only fades with the sheet's offset; the corners are clear. These tests check the motion
 *   rules, then mount the sheet and drive its drag and its close. Chris (2026-11-21): on Android the sheet reaches the
 *   bottom of the screen with nothing of the page showing under it, its buttons clear of the navigation bar.
 * @req UX-SHEET-01[badger-mobile,parrot]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const { FakeValue, anim, platform, navBar } = vi.hoisted(() => {
  class FakeValue {
    value: number;
    constructor(value: number) {
      this.value = value;
    }
    setValue(value: number) {
      this.value = value;
    }
    stopAnimation() {}
    interpolate(config: { inputRange: number[]; outputRange: number[] }) {
      return { interpolation: config, source: this };
    }
  }
  return { FakeValue, anim: { finish: true }, platform: { OS: "ios" }, navBar: { bottom: 0 } };
});
type FakeValue = InstanceType<typeof FakeValue>;

vi.mock("react-native", async () => {
  const ReactActual = await import("react");
  const host =
    (name: string) =>
    ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
      ReactActual.createElement(name, props, children);
  const run = (value: FakeValue, toValue: number) => ({
    start: (done?: (result: { finished: boolean }) => void) => {
      if (anim.finish) value.setValue(toValue);
      done?.({ finished: anim.finish });
    },
  });
  return {
    Animated: {
      Value: FakeValue,
      View: host("AnimatedView"),
      timing: (value: FakeValue, config: { toValue: number }) => run(value, config.toValue),
      spring: (value: FakeValue, config: { toValue: number }) => run(value, config.toValue),
    },
    Easing: { in: (f: unknown) => f, out: (f: unknown) => f, cubic: () => 0 },
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    Modal: host("Modal"),
    Pressable: host("Pressable"),
    ScrollView: host("ScrollView"),
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles,
      absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
    },
    Text: host("Text"),
    View: host("View"),
    Platform: platform,
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});

type PanHandlers = { update?: (e: { translationY: number }) => void; end?: (e: { translationY: number; velocityY: number }) => void };
vi.mock("react-native-gesture-handler", async () => {
  const ReactActual = await import("react");
  const pan = () => {
    const handlers: PanHandlers & { enabled?: boolean } = {};
    const chain: Record<string, unknown> = { handlers };
    for (const name of ["runOnJS", "activeOffsetY", "failOffsetY", "failOffsetX", "requireExternalGestureToFail"]) {
      chain[name] = () => chain;
    }
    chain.enabled = (on: boolean) => {
      handlers.enabled = on;
      return chain;
    };
    chain.onUpdate = (fn: PanHandlers["update"]) => {
      handlers.update = fn;
      return chain;
    };
    chain.onEnd = (fn: PanHandlers["end"]) => {
      handlers.end = fn;
      return chain;
    };
    return chain;
  };
  return {
    Gesture: { Pan: pan, Native: pan },
    GestureDetector: ({ gesture, children }: { gesture: unknown; children: React.ReactNode }) =>
      ReactActual.createElement("GestureDetector", { gesture }, children),
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => ReactActual.createElement("GHRoot", null, children),
  };
});
vi.mock("react-native-safe-area-context", async () => {
  const ReactActual = await import("react");
  const SafeAreaInsetsContext = ReactActual.createContext<{ top: number; right: number; bottom: number; left: number } | null>(null);
  // The Modal's own provider measures its window: the navigation bar's height is its bottom inset.
  const SafeAreaProvider = ({ children }: { children: React.ReactNode }) =>
    ReactActual.createElement(SafeAreaInsetsContext.Provider, { value: { top: 0, right: 0, bottom: navBar.bottom, left: 0 } }, children);
  return { SafeAreaInsetsContext, SafeAreaProvider };
});
vi.mock("../src/components/mobile-render-boundary", () => ({
  MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { text: "#fff", surfaceRaised: "#222" },
    font: { family: { display: "Display" } },
  }),
}));

import { MobileBottomSheet, useMobileSheetClose } from "../src/components/mobile-bottom-sheet";
import {
  SHEET_CLOSE_DISTANCE,
  SHEET_CLOSE_VELOCITY,
  SHEET_HANDLE_HEIGHT,
  sheetBackdropInterpolation,
  sheetDragOffset,
  shouldCloseSheet,
} from "../src/components/mobile-bottom-sheet-motion";

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  anim.finish = true;
  platform.OS = "ios";
  navBar.bottom = 0;
});

const byTestId = (id: string): ReactTestInstance =>
  renderer!.root.find((node) => typeof node.type === "string" && node.props.testID === id);
/** A host element of that name (the mocks render React Native's views as plain string elements). */
const isHost = (node: ReactTestInstance, name: string): boolean => String(node.type) === name;
const flatStyle = (node: ReactTestInstance): Record<string, unknown> =>
  Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean));
const offsetOf = (sheet: ReactTestInstance) => (flatStyle(sheet).transform as [{ translateY: FakeValue }])[0].translateY;
const handlePan = (): PanHandlers => {
  const detector = renderer!.root.find(
    (node) => isHost(node, "GestureDetector") && node.findAll((inner) => inner.props.testID === "s-handle").length > 0,
  );
  const gesture: { handlers: PanHandlers } = detector.props.gesture;
  return gesture.handlers;
};

const mount = (props: Partial<React.ComponentProps<typeof MobileBottomSheet>> = {}, children?: React.ReactNode) => {
  const onClose = vi.fn();
  const onClosed = vi.fn();
  act(() => {
    renderer = create(
      <MobileBottomSheet visible onClose={onClose} onClosed={onClosed} testID="s" title="Up next" {...props}>
        {children}
      </MobileBottomSheet>,
    );
  });
  return { onClose, onClosed };
};

describe("sheet motion rules", () => {
  it("closes past the distance or on a downward flick, and springs back otherwise", () => {
    expect(shouldCloseSheet(SHEET_CLOSE_DISTANCE + 1, 0)).toBe(true);
    expect(shouldCloseSheet(SHEET_CLOSE_DISTANCE - 1, 0)).toBe(false);
    expect(shouldCloseSheet(20, SHEET_CLOSE_VELOCITY + 1)).toBe(true);
    expect(shouldCloseSheet(20, SHEET_CLOSE_VELOCITY - 1)).toBe(false);
    expect(shouldCloseSheet(-200, -3000)).toBe(false);
  });

  it("follows the finger down and never rises above its open position", () => {
    expect(sheetDragOffset(75)).toBe(75);
    expect(sheetDragOffset(-40)).toBe(0);
  });

  it("maps the backdrop from fully dark with the sheet up to clear with the sheet out, clamped", () => {
    expect(sheetBackdropInterpolation(800)).toEqual({ inputRange: [0, 800], outputRange: [1, 0], extrapolate: "clamp" });
    expect(SHEET_HANDLE_HEIGHT).toBeGreaterThanOrEqual(44);
  });
});

describe("MobileBottomSheet", () => {
  it("slides only the sheet: the backdrop is a separate fixed layer whose opacity follows the sheet's offset", () => {
    mount();
    const sheet = byTestId("s");
    const backdrop = byTestId("s-backdrop");
    expect(offsetOf(sheet).value).toBe(0);
    const backdropStyle = flatStyle(backdrop);
    expect(backdropStyle.transform).toBeUndefined();
    const opacity = backdropStyle.opacity as { interpolation: unknown; source: FakeValue };
    expect(opacity.source).toBe(offsetOf(sheet));
    expect(opacity.interpolation).toEqual(sheetBackdropInterpolation(800));
    // The backdrop is not inside the sheet, so the sheet's transform never moves it.
    let parent: ReactTestInstance | null = backdrop.parent;
    while (parent) {
      expect(parent).not.toBe(sheet);
      parent = parent.parent;
    }
  });

  it("has clear rounded corners and a 44 pt drag zone holding the handle and the title", () => {
    mount();
    const style = flatStyle(byTestId("s"));
    expect(style.borderTopLeftRadius ?? style.borderRadius).toBeGreaterThan(0);
    expect(style.overflow).toBe("hidden");
    const zone = byTestId("s-handle");
    expect(flatStyle(zone).minHeight).toBeGreaterThanOrEqual(SHEET_HANDLE_HEIGHT);
    expect(zone.findAll((node) => isHost(node, "Text")).map((node) => node.props.children)).toEqual(["Up next"]);
  });

  it("follows a drag on the handle and springs back when released short", () => {
    const { onClose } = mount();
    const offset = offsetOf(byTestId("s"));
    act(() => handlePan().update!({ translationY: 90 }));
    expect(offset.value).toBe(90);
    act(() => handlePan().end!({ translationY: 90, velocityY: 200 }));
    expect(offset.value).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when dragged past the distance: slides out, reports the close, then the end of the slide", () => {
    const { onClose, onClosed } = mount();
    act(() => handlePan().end!({ translationY: SHEET_CLOSE_DISTANCE + 10, velocityY: 0 }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onClosed.mock.invocationCallOrder[0]);
    expect(renderer!.root.find((node) => isHost(node, "Modal")).props.visible).toBe(false);
  });

  it("closes on a backdrop tap, and a close from inside runs its follow-up after onClose", () => {
    const after = vi.fn();
    const Inner = () => {
      const close = useMobileSheetClose();
      return <Pressable_ testID="pick" onPress={() => close(after)} />;
    };
    const Pressable_ = (props: { testID: string; onPress: () => void }) => React.createElement("Pressable", props);
    const { onClose } = mount({}, <Inner />);
    act(() => byTestId("pick").props.onPress());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(after.mock.invocationCallOrder[0]);

    const second = mount();
    act(() => byTestId("s-backdrop").find((node) => isHost(node, "Pressable")).props.onPress());
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it("slides out without reporting a close when hidden from outside", () => {
    const { onClose, onClosed } = mount();
    act(() =>
      renderer!.update(
        <MobileBottomSheet visible={false} onClose={onClose} onClosed={onClosed} testID="s">
          {null}
        </MobileBottomSheet>,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("on Android runs on under the navigation bar to the screen bottom, its content kept clear of the bar", () => {
    platform.OS = "android";
    navBar.bottom = 48;
    mount({}, React.createElement("Pressable", { testID: "apply" }));
    const sheet = byTestId("s");
    const room = byTestId("s-nav-bar-room");
    expect(flatStyle(room).height).toBe(48);
    // The room is the last thing in the sheet, under its content: the sheet's own colour fills the bar's strip.
    const inside = sheet.findAll((node) => typeof node.type === "string" && node.props.testID !== undefined).map((node) => node.props.testID);
    expect(inside.slice(-2)).toEqual(["apply", "s-nav-bar-room"]);
    // The backdrop fills the whole window, which Android draws under the bar (ModalWindows.kt).
    expect(flatStyle(byTestId("s-backdrop"))).toMatchObject({ position: "absolute", bottom: 0 });
  });

  it("adds no room without a navigation bar, nor on iOS", () => {
    platform.OS = "android";
    mount();
    expect(renderer!.root.findAll((node) => node.props.testID === "s-nav-bar-room")).toHaveLength(0);
    act(() => renderer?.unmount());
    platform.OS = "ios";
    navBar.bottom = 34;
    mount();
    expect(renderer!.root.findAll((node) => node.props.testID === "s-nav-bar-room")).toHaveLength(0);
  });
});
