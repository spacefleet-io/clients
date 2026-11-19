/**
 * @test-id MOBILE-SHELL-MASCOT-LOADER-001
 * @level unit
 * @req UX-WAIT-02[badger-mobile]
 * @req UX-WAIT-02[badger-tv]
 * @why Chris (2026-11-18): the hovering badger moved one way, then snapped straight back to where it started. Each
 *   loading screen of a launch (and the player's launching modal) mounts its own loader, and every loader began the
 *   loop at its start, so the mascot jumped back at each handover. A loader now starts where the shared loop stands
 *   (the clock), on one endless 1.6 s loop on the native driver, so the next screen carries the motion on.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MASCOT_LOADERS } from "@space/shared/mascotLoader";
import { MobileMascotLoader } from "../src/components/mobile-mascot-loader";
import { flatStyle, kit, render, unmount, walk, type FakeInterpolation } from "./sky-test-kit";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { hookFakes } = await import("./sky-test-kit");
  return { ...actual, ...hookFakes, default: { ...actual, ...hookFakes } };
});
vi.mock("react-native", async () => (await import("./sky-test-kit")).reactNativeFake);
vi.mock("react-native-svg", () => {
  const stub = (props: unknown) => props;
  return { default: stub, G: stub, Path: stub, Ellipse: stub };
});

const mount = async (nowMs: number) => {
  vi.spyOn(Date, "now").mockReturnValue(nowMs);
  const tree = render(MobileMascotLoader, { app: "badger", source: 7, size: 320 });
  // The OS answers the reduced-motion question asynchronously.
  await vi.advanceTimersByTimeAsync(0);
  return tree;
};

/** The mascot layer's pose at the animated value's current progress (0 at mount). */
const mascotPoseAtStart = (tree: ReactNode) => {
  const layer = walk(tree).find((el) => {
    const transform = flatStyle(el).transform;
    return Array.isArray(transform) && transform.length > 0;
  })!;
  const [x, y] = flatStyle(layer).transform as { translateX?: FakeInterpolation; translateY?: FakeInterpolation }[];
  return { x: x!.translateX!.config.outputRange[0], y: y!.translateY!.config.outputRange[0] };
};

beforeEach(() => {
  kit.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the loading-screen mascot (phone and TV)", () => {
  it("starts where the shared loop stands, so the next loading screen does not snap the badger back", async () => {
    // 400 ms into a 1.6 s loop: a quarter of the way through.
    const tree = await mount(1_600 * 1_000 + 400);
    const expected = MASCOT_LOADERS.badger.pose(0.25)[0]!;
    const start = mascotPoseAtStart(tree);
    console.info(`[MOBILE-SHELL-MASCOT-LOADER-001] start pose ${JSON.stringify(start)} expected ${JSON.stringify(expected)}`);
    expect(start.x).toBeCloseTo(expected.x, 6);
    expect(start.y).toBeCloseTo(expected.y, 6);
  });

  it("runs one endless 1.6 s loop on the native driver", async () => {
    await mount(0);
    const running = kit.running();
    expect(running).toHaveLength(1);
    expect(running[0]!.kind).toBe("loop");
    expect(running[0]!.config).toMatchObject({ toValue: 1, duration: 1600, useNativeDriver: true });
    expect(running[0]!.value.value).toBe(0);
  });
});
