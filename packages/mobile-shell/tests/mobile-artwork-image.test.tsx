/**
 * @test-id MOBILE-SHELL-ARTWORK-IMAGE-001
 * @level unit
 * @req UX-WAIT-03
 * @why Chris 2026-11-16: a poster still loading showed as a plain black box, which "looks like something is broken and
 *   doesn't say something is happening". The phone and TV tile shows the platform's small spinner while it waits (a
 *   still ring under reduced motion), fades the picture in on the native driver, and falls back to an icon with the
 *   title (or the caller's own fallback, a face's initials), never a spinner forever.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fades = vi.hoisted(() => ({ timings: [] as { toValue: number; duration: number; useNativeDriver: boolean }[] }));
const a11y = vi.hoisted(() => ({ listeners: [] as ((enabled: boolean) => void)[] }));

vi.mock("react-native", () => {
  class Value {
    value: number;
    constructor(value: number) {
      this.value = value;
    }
    setValue(next: number) {
      this.value = next;
    }
  }
  return {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: (event: string, listener: (enabled: boolean) => void) => {
        if (event === "reduceMotionChanged") a11y.listeners.push(listener);
        return { remove: () => undefined };
      },
    },
    ActivityIndicator: "ActivityIndicator",
    Animated: {
      Value,
      Image: "AnimatedImage",
      timing: (value: Value, config: { toValue: number; duration: number; useNativeDriver: boolean }) => {
        fades.timings.push(config);
        return { start: () => value.setValue(config.toValue), stop: () => undefined };
      },
    },
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {}, absoluteFillObject: {} },
    Text: "Text",
    View: "View",
  };
});
vi.mock("lucide-react-native", () => ({ Film: "FilmIcon", UserRound: "PersonIcon" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { surface: "#242638", textMuted: "#b6bace" }, font: { family: { sans: "Inter" } } }),
}));

import { ARTWORK_LOAD_TIMEOUT_MS, ARTWORK_SPINNER_DELAY_MS, type ArtworkSource } from "@space/shared/artworkImage";
import { MOBILE_ARTWORK_FADE_MS, MobileArtworkImage, type MobileArtworkImageProps } from "../src/components/mobile-artwork-image";

let renderer: ReactTestRenderer | null = null;
const all = (type: string) => renderer!.root.findAll((n: ReactTestInstance) => (n.type as unknown) === type);
const byId = (testID: string) => renderer!.root.findAll((n) => n.props.testID === testID && typeof n.type === "string");
const look = () => {
  const image = all("AnimatedImage")[0];
  const fallback = byId("artwork-fallback")[0];
  return {
    spinner: all("ActivityIndicator").length > 0,
    ring: byId("artwork-spinner").length > 0 && all("ActivityIndicator").length === 0,
    image: image ? (image.props.source as { uri: string }).uri : null,
    fallback: fallback ? fallback.findAll((n) => (n.type as unknown) === "Text").map((n) => n.props.children) : null,
    icon: fallback
      ? fallback.findAll((n) => (n.type as unknown) === "FilmIcon" || (n.type as unknown) === "PersonIcon").map((n) => String(n.type))
      : null,
  };
};
const render = (source: ArtworkSource, props: Partial<MobileArtworkImageProps> = {}) =>
  act(() => {
    const element = <MobileArtworkImage source={source} label="Heat" {...props} />;
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  fades.timings = [];
  renderer = null;
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.useRealTimers();
});

describe("MobileArtworkImage (UX-WAIT-03)", () => {
  it("shows the platform spinner after 150 ms while the picture is fetched, then fades the picture in once drawn", async () => {
    render({ kind: "pending" });
    // The OS answers that motion is allowed: the module-wide reduced-motion store leaves its still default.
    await act(async () => {
      await Promise.resolve();
    });
    const early = look();
    advance(ARTWORK_SPINNER_DELAY_MS);
    const waiting = look();
    render({ kind: "url", url: "file:///heat.jpg" });
    const drawing = look();
    act(() => all("AnimatedImage")[0]!.props.onLoad());
    const loaded = look();
    const image = all("AnimatedImage")[0]!;
    console.info("[MOBILE-SHELL-ARTWORK-IMAGE-001] looks", JSON.stringify({ early, waiting, drawing, loaded, fades: fades.timings }));
    expect(early.spinner).toBe(false);
    expect(waiting).toMatchObject({ spinner: true, image: null, fallback: null });
    expect(drawing).toMatchObject({ spinner: true, image: "file:///heat.jpg", fallback: null });
    expect(loaded).toMatchObject({ spinner: false, ring: false, image: "file:///heat.jpg", fallback: null });
    expect(fades.timings.at(-1)).toEqual({ toValue: 1, duration: MOBILE_ARTWORK_FADE_MS, useNativeDriver: true });
    expect(image.props.style[1].opacity.value, "the picture ends fully shown").toBe(1);
    expect(image.props.resizeMethod).toBe("resize");
  });

  it("under reduced motion the spinner is a still ring", () => {
    render({ kind: "pending" });
    act(() => a11y.listeners.forEach((listener) => listener(true)));
    advance(ARTWORK_SPINNER_DELAY_MS);
    const still = look();
    act(() => a11y.listeners.forEach((listener) => listener(false)));
    console.info("[MOBILE-SHELL-ARTWORK-IMAGE-001] reduced", JSON.stringify(still));
    expect(still).toMatchObject({ spinner: false, ring: true });
  });

  it("a picture that will not draw shows the film icon and the title, and tells the app's error log", () => {
    const onImageError = vi.fn();
    render({ kind: "url", url: "file:///broken.jpg" }, { onImageError });
    act(() => all("AnimatedImage")[0]!.props.onError({ nativeEvent: { error: "decode" } }));
    const failed = look();
    console.info("[MOBILE-SHELL-ARTWORK-IMAGE-001] error", JSON.stringify(failed));
    expect(failed).toEqual({ spinner: false, ring: false, image: null, fallback: ["Heat"], icon: ["FilmIcon"] });
    expect(onImageError).toHaveBeenCalledTimes(1);
  });

  it("a stalled fetch moves to the fallback after 15 s, never a spinner forever; a face shows its own fallback", () => {
    render({ kind: "pending" }, { icon: "person", label: undefined, fallback: React.createElement("Text", null, "AP") });
    advance(ARTWORK_LOAD_TIMEOUT_MS - 1);
    const before = look();
    advance(1);
    const after = look();
    console.info("[MOBILE-SHELL-ARTWORK-IMAGE-001] stall", JSON.stringify({ before, after }));
    expect(before.fallback).toBeNull();
    expect(after).toEqual({ spinner: false, ring: false, image: null, fallback: ["AP"], icon: [] });
  });

  it("no picture shows the person icon alone for a face; a decorative backdrop shows neither spinner nor fallback", () => {
    render({ kind: "none" }, { icon: "person", label: undefined });
    expect(look()).toEqual({ spinner: false, ring: false, image: null, fallback: [], icon: ["PersonIcon"] });
    act(() => renderer!.unmount());
    renderer = null;
    render({ kind: "pending" }, { decorative: true });
    advance(ARTWORK_LOAD_TIMEOUT_MS);
    expect(look()).toEqual({ spinner: false, ring: false, image: null, fallback: null, icon: null });
  });
});
