/**
 * @test-id PARROT-MOBILE-COVER-FADE-001
 * @level unit
 * @req PAR-LOOK-01[parrot]
 * @req PAR-META-04[parrot]
 * @req PAR-META-20[parrot]
 * @why PAR-LOOK-01 / PAR-META-04: a tile asks the cover cache for its own cover, which fades in over ~220 ms on the
 *   native driver once its picture has loaded. PAR-META-20 (Chris 2026-11-16: "loading must never look like not
 *   found"): while the cover is on its way (downloading, its picture loading, fetched again after a failed load, or the
 *   automatic cover pass still to ask for the album) a plain shimmer shows, never the drawn picture, which means "no
 *   cover". A cover already kept on the phone shows at once without a fade, a failed one leaves the drawing, and the
 *   album page / player show the small copy at once under the large one while it loads. Screens are called as
 *   functions against a mocked React Native with a tiny hook store, so each render step is visible.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  slot: 0,
  state: [] as unknown[],
  effects: [] as Array<() => void | (() => void)>,
  timings: [] as Array<{ config: Record<string, unknown>; started: boolean }>,
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-COVER-FADE-001] ${step}`, JSON.stringify(detail));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  // State kept by call order across "renders" (reset `slot` before each); effects are collected, run by the test.
  const useState = <T,>(initial: T) => {
    const index = hooks.slot++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index] as T, (next: T) => void (hooks.state[index] = next)];
  };
  const useEffect = (fn: () => void | (() => void)) => void hooks.effects.push(fn);
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useMemo = <T,>(fn: () => T) => fn();
  return { ...actual, default: { ...actual, useState, useEffect, useRef, useMemo }, useState, useEffect, useRef, useMemo };
});
vi.mock("react-native", () => {
  class Value {
    constructor(public value: number) {}
  }
  return {
    Animated: {
      Value,
      Image: "AnimatedImage",
      timing: (value: Value, config: Record<string, unknown>) => {
        const timing = { config, started: false };
        hooks.timings.push(timing);
        return {
          start: () => {
            timing.started = true;
            value.value = config.toValue as number;
          },
        };
      },
    },
    Image: "Image",
    Pressable: "Pressable",
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, absoluteFill: { position: "absolute" } },
    Text: "Text",
    View: "View",
  };
});
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
// The shared pulse stands in as a tag: its real module pulls the shell theme past this test's tiny React Native mock.
vi.mock("@space/mobile-shell/components", () => ({ MobileSkeletonPulse: "MobileSkeletonPulse" }));

import { COVER_FADE_MS, FadeInCover, ParrotArt } from "../src/screens/art";
import { albumCoversWaiting } from "../src/lib/picturesWaiting";
import { setPhoneCoverSource } from "../src/lib/covers";

const SHIMMER = "MobileSkeletonPulse";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
  }
  return out;
};
const layers = (tree: unknown) =>
  all(tree, (el) => ["Svg", "Text", "Image"].includes(el.type as string) || el.type === FadeInCover || el.type === SHIMMER).map((el) =>
    el.type === FadeInCover ? "cover" : el.type === SHIMMER ? "shimmer" : (el.type as string)
  );

/** A cover cache whose downloads the test answers by hand. */
const fakeSource = (kept: Record<string, string> = {}) => {
  const asked: string[] = [];
  const refetched: string[] = [];
  const answers = new Map<string, (uri: string | null) => void>();
  return {
    asked,
    refetched,
    answer: (key: string, uri: string | null) => answers.get(key)!(uri),
    source: {
      kept: (key: string | null | undefined) => (key ? (kept[key] ?? null) : null),
      uriFor: (key: string | null | undefined) => {
        asked.push(key!);
        return new Promise<string | null>((resolve) => answers.set(key!, resolve));
      },
      refetch: (key: string | null | undefined) => {
        refetched.push(key!);
        return new Promise<string | null>((resolve) => answers.set(key!, resolve));
      },
    },
  };
};

const render = (props: Parameters<typeof ParrotArt>[0]) => {
  hooks.slot = 0;
  hooks.effects = [];
  return ParrotArt(props) as unknown as Element;
};
const cleanups: Array<() => void> = [];
const runEffects = () =>
  hooks.effects.forEach((effect) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  });

describe("a tile's cover", () => {
  beforeEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    hooks.state = [];
    hooks.timings = [];
    setPhoneCoverSource(null);
  });

  it("shimmers while the cover downloads and loads, then fades it in and shows no shimmer (PAR-META-20)", async () => {
    const cache = fakeSource();
    setPhoneCoverSource(cache.source);
    const props = { seed: "al-lo", size: 160, label: "Low Orbit", coverKey: "assets/small-lo" };

    const first = render(props);
    log("first render", layers(first));
    // On its way: a shimmer, never the drawn picture ("no cover").
    expect(layers(first)).toEqual(["shimmer"]);
    runEffects();
    expect(cache.asked).toEqual(["assets/small-lo"]);

    cache.answer("assets/small-lo", "file:///cache/parrot-covers/assets_small-lo.img");
    await vi.waitFor(() => expect(hooks.state[0]).not.toBeNull());
    const second = render(props);
    const cover = all(second, (el) => el.type === FadeInCover)[0]!;
    log("after the download", { layers: layers(second), cover: cover.props });
    // The shimmer stays under the cover until its picture has loaded; the cover is the top layer.
    expect(layers(second)).toEqual(["shimmer", "cover"]);
    expect(cover.props).toMatchObject({ uri: "file:///cache/parrot-covers/assets_small-lo.img", fade: true });
    (cover.props.onShown as () => void)();
    const loaded = render(props);
    log("after the picture loaded", layers(loaded));
    expect(layers(loaded)).toEqual(["Svg", "Text", "cover"]);
  });

  it("starts transparent and fades in on the native driver when its picture has loaded", () => {
    const image = FadeInCover({ uri: "file:///x.img", fade: true, onError: () => undefined }) as unknown as Element;
    const style = image.props.style as Array<Record<string, { value: number }>>;
    const opacity = style[1]!.opacity!;
    log("before load", { type: image.type, opacity: opacity.value, timings: hooks.timings.length });
    expect(image.type).toBe("AnimatedImage");
    expect(opacity.value).toBe(0);
    expect(hooks.timings).toHaveLength(0);

    (image.props.onLoad as () => void)();
    log("after load", { opacity: opacity.value, timings: hooks.timings });
    expect(hooks.timings).toHaveLength(1);
    expect(hooks.timings[0]).toMatchObject({ started: true, config: { toValue: 1, useNativeDriver: true, duration: COVER_FADE_MS } });
    expect(COVER_FADE_MS).toBeGreaterThanOrEqual(200);
    expect(COVER_FADE_MS).toBeLessThanOrEqual(250);
    expect(opacity.value).toBe(1);
  });

  it("shows a cover already kept on the phone at once, with no fade and no download", () => {
    const cache = fakeSource({ "assets/small-lo": "file:///cache/parrot-covers/assets_small-lo.img" });
    setPhoneCoverSource(cache.source);
    const tree = render({ seed: "al-lo", size: 160, label: "Low Orbit", coverKey: "assets/small-lo" });
    runEffects();
    const cover = all(tree, (el) => el.type === FadeInCover)[0]!;
    log("kept", { layers: layers(tree), cover: cover.props, asked: cache.asked });
    expect(cover.props).toMatchObject({ uri: "file:///cache/parrot-covers/assets_small-lo.img", fade: false });
    expect(cache.asked).toEqual([]);

    const image = FadeInCover({ uri: "file:///x.img", fade: false, onError: () => undefined }) as unknown as Element;
    const opacity = (image.props.style as Array<Record<string, { value: number }>>)[1]!.opacity!;
    (image.props.onLoad as () => void)();
    expect(opacity.value).toBe(1);
    expect(hooks.timings).toHaveLength(0);
  });

  it("keeps the drawing when the cover cannot be had or its picture fails to load", async () => {
    const cache = fakeSource();
    setPhoneCoverSource(cache.source);
    const props = { seed: "al-x", size: 120, label: "Broken", coverKey: "assets/broken" };
    render(props);
    runEffects();
    cache.answer("assets/broken", null);
    await vi.waitFor(() => expect(hooks.state[0]).toEqual({ key: "assets/broken", uri: null }));
    const failed = render(props);
    log("download failed", layers(failed));
    expect(layers(failed)).toEqual(["Svg", "Text"]);

    // @bugfix @regression-proof: a picture that downloads but will not load (a broken kept file) is fetched once more
    // under a fresh address, shimmering meanwhile (PAR-META-20); only a second failure leaves the drawing for good.
    hooks.state[0] = { key: "assets/broken", uri: "file:///bad.img" };
    const shown = render(props);
    (all(shown, (el) => el.type === FadeInCover)[0]!.props.onError as () => void)();
    const retrying = render(props);
    log("load failed, fetching again", { layers: layers(retrying), refetched: cache.refetched });
    expect(cache.refetched).toEqual(["assets/broken"]);
    expect(layers(retrying)).toEqual(["shimmer"]);

    cache.answer("assets/broken", "file:///bad.img");
    await vi.waitFor(() => expect(hooks.state[1]).toEqual({ key: "assets/broken", uri: "file:///bad.img?retry=1", done: true }));
    const again = render(props);
    const cover = all(again, (el) => el.type === FadeInCover)[0]!;
    log("fetched again", { layers: layers(again), cover: cover.props });
    expect(cover.props).toMatchObject({ uri: "file:///bad.img?retry=1", fade: true });

    (cover.props.onError as () => void)();
    const after = render(props);
    log("failed again", layers(after));
    expect(layers(after)).toEqual(["Svg", "Text"]);
    expect(cache.refetched).toEqual(["assets/broken"]);
  });

  it("shows no cover and asks for none when the album has none", () => {
    const cache = fakeSource();
    setPhoneCoverSource(cache.source);
    const tree = render({ seed: "al-none", size: 120, label: "No Picture", coverKey: null });
    runEffects();
    expect(layers(tree)).toEqual(["Svg", "Text"]);
    expect(cache.asked).toEqual([]);
  });

  it("shimmers while the automatic cover pass still has the album to ask, and draws the picture once it found none (PAR-META-20)", () => {
    const cache = fakeSource();
    setPhoneCoverSource(cache.source);
    albumCoversWaiting.set(["al-due"]);
    const props = { seed: "al-due", size: 120, label: "Due", coverKey: null };
    const waiting = render(props);
    runEffects();
    log("pass waiting", layers(waiting));
    expect(layers(waiting)).toEqual(["shimmer"]);
    expect(cache.asked).toEqual([]);

    albumCoversWaiting.set([]);
    const settled = render(props);
    log("pass settled, no cover", layers(settled));
    expect(layers(settled)).toEqual(["Svg", "Text"]);
    // Another album the pass is not asking keeps its drawing.
    albumCoversWaiting.set(["al-other"]);
    expect(layers(render(props))).toEqual(["Svg", "Text"]);
    albumCoversWaiting.clear();
  });

  it("on the album page and the player, shows the small copy at once under the large one while that loads", () => {
    const cache = fakeSource({ "assets/small-lo": "file:///cache/parrot-covers/assets_small-lo.img" });
    setPhoneCoverSource(cache.source);
    const tree = render({ seed: "al-lo", size: 220, coverKey: "assets/large-lo", previewKey: "assets/small-lo" });
    runEffects();
    const preview = all(tree, (el) => el.type === "Image")[0];
    log("album header", { layers: layers(tree), preview: preview?.props, asked: cache.asked });
    expect(preview?.props.source).toEqual({ uri: "file:///cache/parrot-covers/assets_small-lo.img" });
    // The large copy is the one fetched for the header.
    expect(cache.asked).toEqual(["assets/large-lo"]);
  });
});
