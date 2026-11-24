/**
 * @test-id MOBILE-SKELETON-001
 * @level component
 * @why Quality audit #3350 (S25): Badger's SkeletonPulse (800 ms, 0.55 ↔ 1) and Parrot's Shimmer (700 ms, 0.45 ↔ 0.9)
 *   breathed at different speeds, and neither matched the desktop's `animate-pulse`. Both phones now draw loading
 *   placeholders with the shared `MobileSkeletonPulse` / `MobileSkeletonBlock` on one timing, the desktop's: 1 → 0.5 → 1
 *   over 2 s. A pulse with nothing inside is itself a grey block (Parrot's cover and photo placeholders, PAR-META-20).
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const anim = vi.hoisted(() => ({
  timings: [] as Array<Record<string, unknown>>,
  loops: 0,
  started: 0,
  stopped: 0,
}));

vi.mock("react-native", () => {
  class Value {
    constructor(public value: number) {}
  }
  return {
    Animated: {
      Value,
      View: "AnimatedView",
      timing: (_value: Value, config: Record<string, unknown>) => {
        anim.timings.push(config);
        return { config };
      },
      sequence: (steps: unknown[]) => ({ steps }),
      loop: (body: unknown) => {
        anim.loops++;
        return { body, start: () => void anim.started++, stop: () => void anim.stopped++ };
      },
    },
    Easing: { bezier: (...points: number[]) => `bezier(${points.join(",")})` },
    View: "View",
  };
});
vi.mock("../src/theme", () => ({ useMobileShellTheme: () => ({ colors: { surfaceRaised: "#1b2030" } }) }));

import { MOBILE_SKELETON_PULSE, MobileSkeletonBlock, MobileSkeletonPulse } from "../src/components/mobile-skeleton";

const log = (step: string, detail: unknown) => console.info(`[MOBILE-SKELETON-001] ${step}`, JSON.stringify(detail));

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  anim.timings = [];
  anim.loops = anim.started = anim.stopped = 0;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

const render = async (element: React.ReactElement) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(element);
  });
  return renderer!;
};
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? (style as Record<string, unknown>) : {};

describe("MobileSkeletonPulse (PAR-META-20, REL-FAM-03)", () => {
  it("@req PAR-META-20[parrot] @req REL-FAM-03[badger-mobile,parrot] pulses 1 → 0.5 → 1 over 2 s like the desktop, in one native loop", async () => {
    const tree = await render(
      <MobileSkeletonPulse testID="poster-grid-skeleton">
        <MobileSkeletonBlock width={120} height={180} />
        <MobileSkeletonBlock width="60%" height={14} radius={4} />
      </MobileSkeletonPulse>
    );
    log("timing", { pulse: MOBILE_SKELETON_PULSE, timings: anim.timings, loops: anim.loops });
    expect(MOBILE_SKELETON_PULSE).toEqual({ halfMs: 1000, low: 0.5, high: 1 });
    expect(anim.loops).toBe(1);
    expect(anim.started).toBe(1);
    expect(anim.timings).toEqual([
      { toValue: 0.5, duration: 1000, easing: "bezier(0.4,0,0.6,1)", useNativeDriver: true },
      { toValue: 1, duration: 1000, easing: "bezier(0.4,0,0.6,1)", useNativeDriver: true },
    ]);
    const pulse = tree.root.findByType("AnimatedView" as never);
    // Hidden from touch and the screen reader; its own surface stays clear when it holds blocks.
    expect(pulse.props).toMatchObject({ testID: "poster-grid-skeleton", pointerEvents: "none", accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" });
    expect(flat(pulse.props.style).backgroundColor).toBeUndefined();
    const blocks = tree.root.findAllByType("View" as never).map((block) => flat(block.props.style));
    log("blocks", blocks);
    expect(blocks).toEqual([
      { width: 120, height: 180, borderRadius: 8, backgroundColor: "#1b2030" },
      { width: "60%", height: 14, borderRadius: 4, backgroundColor: "#1b2030" },
    ]);
    await act(async () => renderer?.unmount());
    renderer = null;
    expect(anim.stopped).toBe(1);
  });

  it("@req PAR-META-20[parrot] with nothing inside it is itself a grey block, sized by the screen's style", async () => {
    const tree = await render(<MobileSkeletonPulse testID="parrot-art-shimmer" style={{ width: 64, height: 64, borderRadius: 6 }} />);
    const style = flat(tree.root.findByType("AnimatedView" as never).props.style);
    log("bare", style);
    expect(style).toMatchObject({ backgroundColor: "#1b2030", width: 64, height: 64, borderRadius: 6 });
    expect(style.opacity).toBeDefined();
  });
});
