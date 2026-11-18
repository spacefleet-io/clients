/**
 * @test-id MOBILE-SHELL-STATIC-SKY-001
 * @level unit
 * @why UX-SKY-02: the phone and TV sky is the site hero's: its 150 stars, and
 *   its 3 shooting stars on the 315 deg path (head heading lower-left, tail up
 *   and to the right) drawn with the bundled 200 px tail picture. The apps'
 *   stars stand still (Chris 2026-11-16: the twinkle slowed the device): one
 *   react-native-svg layer of 150 circles, nothing Animated around them. The
 *   animated sky runs only its shooting stars, on React Native core Animated
 *   with the native driver (Parrot mobile has no Reanimated). The still sky
 *   (weak phone or Off) is the same picture frozen: no Animated, no timers, no
 *   listeners.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SKY_COLOR,
  SKY_SHOOTING_OPACITY_KEYS,
  SKY_SHOOTING_ROTATE_DEG,
  SKY_SHOOTING_TRAVEL_PX,
  SKY_STAR_COUNT,
} from "@space/shared/starSky";
import { flatStyle, kit, render, stubs, walk, type El, type FakeInterpolation } from "./sky-test-kit";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { hookFakes } = await import("./sky-test-kit");
  return { ...actual, ...hookFakes, default: { ...actual, ...hookFakes } };
});
vi.mock("react-native", async () => (await import("./sky-test-kit")).reactNativeFake);
vi.mock("react-native-svg", async () => (await import("./sky-test-kit")).reactNativeSvgFake);
// The nebula is react-native-svg, drawn once; here only its place under the stars matters.
vi.mock("../src/components/mobile-nebula", () => ({ MobileNebula: Object.assign(() => null, { displayName: "MobileNebula" }) }));
vi.mock("../src/components/mobile-sky-mode", async () => {
  const { kit: k } = await import("./sky-test-kit");
  return { useMobileSkyMode: () => k.mode };
});

const comets = async () => {
  const { createUserInputSignal } = await import("../src/components/mobile-user-input");
  const { createSkyCoverRegistry } = await import("../src/components/mobile-sky-covers");
  return { input: createUserInputSignal(), covers: createSkyCoverRegistry() };
};

const isStar = (el: El) => el.type === stubs.CircleStub;
const starLayers = (tree: El[]) => tree.filter((el) => el.type === stubs.SvgStub);

beforeEach(() => {
  kit.reset();
  vi.restoreAllMocks();
});

describe("still sky", () => {
  // @req UX-SKY-02[badger-mobile]
  it("draws the hero's 150 stars and 3 frozen shooting stars at 315 deg with plain Views and the tail picture", async () => {
    kit.mode = "static";
    kit.animatedAllowed = false;
    const { default: MobileAppBackdrop } = await import("../src/components/mobile-app-backdrop");
    const tree = walk(render(MobileAppBackdrop, { comets: await comets() }));
    const stars = tree.filter(isStar);
    expect(starLayers(tree)).toHaveLength(1);
    const heads = tree.filter((el) => JSON.stringify(flatStyle(el).transform ?? "").includes("rotate"));
    const pictures = tree.filter((el) => el.type === stubs.ImageStub);
    console.info(
      `[mobile-static-sky:test] still stars=${stars.length} heads=${heads.length} rotations=${JSON.stringify(heads.map((el) => flatStyle(el).transform))} pictures=${pictures.length}`,
    );
    // Rendering the whole tree already proves no Animated.View / Value / listener ran (the fakes throw).
    expect(stars).toHaveLength(SKY_STAR_COUNT);
    expect(heads).toHaveLength(3);
    for (const head of heads) expect(flatStyle(head).transform).toEqual([{ rotate: `${SKY_SHOOTING_ROTATE_DEG}deg` }]);
    expect(pictures).toHaveLength(3);
  });

  // @req UX-SKY-01[badger-mobile]
  it("starts no timer, animation or listener", async () => {
    kit.mode = "static";
    kit.animatedAllowed = false;
    const timers = vi.spyOn(globalThis, "setTimeout");
    const intervals = vi.spyOn(globalThis, "setInterval");
    const { default: MobileAppBackdrop } = await import("../src/components/mobile-app-backdrop");
    walk(render(MobileAppBackdrop, { paused: false, comets: await comets() }));
    console.info(`[mobile-static-sky:test] still timers=${timers.mock.calls.length} intervals=${intervals.mock.calls.length} values=${kit.values.length}`);
    expect(timers).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();
    expect(kit.values).toHaveLength(0);
    expect(kit.appState.listeners.size).toBe(0);
    expect(kit.keyboard.size).toBe(0);
  });
});

describe("animated sky", () => {
  // @req UX-SKY-02[badger-mobile]
  it("renders the nebula, then MobileStarSky over it, when the mode is animated", async () => {
    const { MobileSkyPaint } = await import("../src/components/mobile-sky-paint");
    const fragment = (MobileSkyPaint as unknown as { type: (props: unknown) => React.ReactElement<{ children: React.ReactElement[] }> }).type({});
    const names = fragment.props.children.map((child) => (child.type as { displayName?: string }).displayName);
    console.info(`[mobile-static-sky:test] animated mode renders ${JSON.stringify(names)}`);
    expect(names).toEqual(["MobileNebula", "MobileStarSky"]);
  });

  // @req UX-SKY-02[badger-mobile]
  it("draws the 150 stars as one still Svg layer: nothing Animated wraps them, no twinkle runs", async () => {
    const { MobileStarSky } = await import("../src/components/mobile-star-sky");
    const tree = walk(render(MobileStarSky, { comets: await comets() }));
    const layers = starLayers(tree);
    const stars = walk(layers[0]?.props.children ?? []).filter(isStar);
    const animatedViews = tree.filter((el) => el.type === stubs.AnimatedViewStub);
    const starsUnderAnimated = animatedViews.flatMap((view) => walk(view.props.children).filter(isStar));
    const first = stars[0]?.props as Record<string, unknown> | undefined;
    console.info(
      `[mobile-static-sky:test] star layers=${layers.length} stars=${stars.length} animatedViews=${animatedViews.length} starsUnderAnimated=${starsUnderAnimated.length} values=${kit.values.length} first=${JSON.stringify(first)}`,
    );
    expect(layers).toHaveLength(1);
    expect(stars).toHaveLength(SKY_STAR_COUNT);
    expect(starsUnderAnimated).toHaveLength(0);
    // The only Animated views are the 3 shooting stars, and the only values theirs.
    expect(animatedViews).toHaveLength(3);
    expect(kit.values).toHaveLength(3);
    for (const star of stars) {
      const props = star.props as Record<string, unknown>;
      expect(props.fill).toBe(SKY_COLOR);
      expect(String(props.cx)).toMatch(/%$/);
      expect(String(props.cy)).toMatch(/%$/);
      expect(typeof props.opacity).toBe("number");
    }
  });

  // @req UX-SKY-02[badger-mobile]
  it("draws 3 shooting stars at 315 deg that travel 1500 px along the tail axis with the hero's opacity keys", async () => {
    const { MobileStarSky } = await import("../src/components/mobile-star-sky");
    const tree = walk(render(MobileStarSky, { comets: await comets() }));
    const heads = tree.filter((el) => el.type === stubs.ViewStub && JSON.stringify(flatStyle(el).transform ?? "").includes("rotate"));
    const flyers = tree.filter((el) => el.type === stubs.AnimatedViewStub && Array.isArray(flatStyle(el).transform));
    const pictures = tree.filter((el) => el.type === stubs.ImageStub);
    const travel = (flatStyle(flyers[0]!).transform as { translateX: FakeInterpolation }[])[0]!.translateX.config;
    const fade = (flatStyle(flyers[0]!).opacity as FakeInterpolation).config;
    console.info(
      `[mobile-static-sky:test] comets heads=${heads.length} at=${JSON.stringify(heads.map((el) => [flatStyle(el).top, flatStyle(el).right]))} travel=${JSON.stringify(travel)} fade=${JSON.stringify(fade)}`,
    );
    expect(heads).toHaveLength(3);
    for (const head of heads) {
      expect(flatStyle(head).transform).toEqual([{ rotate: `${SKY_SHOOTING_ROTATE_DEG}deg` }]);
      expect(String(flatStyle(head).top)).toMatch(/%$/);
      expect(String(flatStyle(head).right)).toMatch(/%$/);
    }
    expect(flyers).toHaveLength(3);
    expect(pictures).toHaveLength(3);
    expect(travel.outputRange).toEqual([0, -SKY_SHOOTING_TRAVEL_PX]);
    expect(fade.inputRange).toEqual(SKY_SHOOTING_OPACITY_KEYS.map(([p]) => p));
    expect(fade.outputRange).toEqual(SKY_SHOOTING_OPACITY_KEYS.map(([, o]) => o));
  });

  // @req UX-SKY-02[badger-mobile]
  it("draws no shooting star without comets (covered sky)", async () => {
    const { MobileStarSky } = await import("../src/components/mobile-star-sky");
    const tree = walk(render(MobileStarSky, {}));
    const pictures = tree.filter((el) => el.type === stubs.ImageStub);
    console.info(`[mobile-static-sky:test] no-comets pictures=${pictures.length} stars=${tree.filter(isStar).length}`);
    expect(pictures).toHaveLength(0);
    expect(tree.filter(isStar)).toHaveLength(SKY_STAR_COUNT);
  });
});
