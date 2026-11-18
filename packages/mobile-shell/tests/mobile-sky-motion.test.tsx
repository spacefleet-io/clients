/**
 * @test-id MOBILE-SHELL-SKY-MOTION-001
 * @level unit
 * @why UX-SKY-01 on phone and TV: the hero's shooting stars fly only while
 *   nobody uses the app. A held finger, a scroll in motion or the keyboard
 *   makes the sky still (shooting stars hidden and stopped) until 5 s of quiet;
 *   a paused shell (Player), a backgrounded app or reduced motion turns it off
 *   (nothing running). The 150 stars never animate (Chris 2026-11-16): the only
 *   loops are the 3 shooting stars, on the native driver, and going live again
 *   restarts each one from its own delay, like the hero's page load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKY_IDLE_MS, SKY_SHOOTING_DELAY_S } from "@space/shared/starSky";
import { kit, render, unmount } from "./sky-test-kit";
import { createSkyCoverRegistry } from "../src/components/mobile-sky-covers";
import { createUserInputSignal } from "../src/components/mobile-user-input";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { hookFakes } = await import("./sky-test-kit");
  return { ...actual, ...hookFakes, default: { ...actual, ...hookFakes } };
});
vi.mock("react-native", async () => (await import("./sky-test-kit")).reactNativeFake);
vi.mock("react-native-svg", async () => (await import("./sky-test-kit")).reactNativeSvgFake);

const touches = (count: number) => ({ nativeEvent: { touches: Array.from({ length: count }, () => ({})) } });
/** Longest delay before every shooting star has started. */
const ALL_STARTED_MS = SKY_SHOOTING_DELAY_S * 1000 + 1;

const mount = async (props: { paused?: boolean } = {}) => {
  const { MobileStarSky } = await import("../src/components/mobile-star-sky");
  const comets = { input: createUserInputSignal(), covers: createSkyCoverRegistry() };
  const draw = (next: { paused?: boolean }) => render(MobileStarSky, { ...next, comets });
  draw(props);
  // The OS answers the reduced-motion question asynchronously.
  await vi.advanceTimersByTimeAsync(0);
  return { comets, draw };
};

const snapshot = (label: string) => {
  const running = kit.running();
  const comets = running.filter((anim) => anim.config && anim.config.duration >= 2000 && anim.config.duration <= 4000);
  console.info(
    `[mobile-sky-motion:test] ${label}: running=${running.length} comets=${comets.length} nativeDriver=${running.every((anim) => anim.config?.useNativeDriver)} values=${JSON.stringify(kit.values.map((v) => Number(v.value.toFixed(2))))}`,
  );
  return { running, comets };
};

beforeEach(() => {
  kit.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("createUserInputSignal", () => {
  // @req UX-SKY-01[badger-mobile]
  it("reports a touch held from the first finger down until the last finger lifts or the touch is cancelled", () => {
    const signal = createUserInputSignal();
    const seen: boolean[] = [];
    const unsubscribe = signal.subscribe((held) => seen.push(held));
    signal.touchHandlers.onTouchStart(touches(1));
    signal.touchHandlers.onTouchStart(touches(2));
    signal.touchHandlers.onTouchEnd(touches(1));
    signal.touchHandlers.onTouchEnd(touches(0));
    signal.touchHandlers.onTouchStart(touches(1));
    signal.touchHandlers.onTouchCancel(touches(0));
    unsubscribe();
    signal.touchHandlers.onTouchStart(touches(1));
    console.info(`[mobile-sky-motion:test] held transitions=${JSON.stringify(seen)}`);
    expect(seen).toEqual([true, false, true, false]);
  });
});

describe("MobileStarSky motion gate", () => {
  // @req UX-SKY-01[badger-mobile]
  it("goes live once the OS says no reduced motion: only the 3 shooting stars loop, on the native driver, after their delays", async () => {
    kit.reduceMotion.enabled = false;
    await mount();
    // One Animated value per shooting star; none for the stars.
    expect(kit.values).toHaveLength(3);
    expect(snapshot("before delays").running).toHaveLength(0);
    vi.advanceTimersByTime(ALL_STARTED_MS);
    const { running, comets } = snapshot("live");
    expect(running).toHaveLength(3);
    expect(comets).toHaveLength(3);
    expect(running.every((anim) => anim.kind === "loop" && anim.config?.useNativeDriver === true && anim.config.toValue === 1)).toBe(true);
  });

  // @req UX-SKY-01[badger-mobile]
  it("a held touch makes it still: shooting stars hidden and stopped; live again after 5 s of quiet and their delay", async () => {
    const { comets } = await mount();
    vi.advanceTimersByTime(ALL_STARTED_MS);
    kit.values.forEach((value) => value.setValue(0.3));

    comets.input.touchHandlers.onTouchStart(touches(1));
    snapshot("finger down");
    expect(kit.running()).toHaveLength(0);
    // Back at progress 0, which is opacity 0.
    expect(kit.values.map((value) => value.value)).toEqual([0, 0, 0]);

    comets.input.touchHandlers.onTouchEnd(touches(0));
    vi.advanceTimersByTime(SKY_IDLE_MS - 1);
    expect(snapshot("4.999 s after release").running).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(snapshot("5 s after release").running.length).toBeLessThanOrEqual(3);
    vi.advanceTimersByTime(SKY_SHOOTING_DELAY_S * 1000 + 1);
    expect(kit.running().filter((anim) => anim.kind === "loop")).toHaveLength(3);
  });

  // @req UX-SKY-01[badger-mobile]
  it("a scroll in motion holds it still like a finger", async () => {
    const { comets } = await mount();
    vi.advanceTimersByTime(ALL_STARTED_MS);
    comets.covers.scrollBegan({});
    expect(snapshot("scrolling").running).toHaveLength(0);
  });

  // @req UX-SKY-01[badger-mobile]
  it("AppState background turns it off: every animation stopped, stars at rest; active again goes live", async () => {
    await mount();
    vi.advanceTimersByTime(ALL_STARTED_MS);
    kit.values.forEach((value) => value.setValue(0.5));
    for (const listener of kit.appState.listeners) listener("background");
    snapshot("background");
    expect(kit.running()).toHaveLength(0);
    expect(kit.values.map((value) => value.value)).toEqual(kit.values.map(() => 0));
    vi.advanceTimersByTime(60_000);
    expect(kit.running()).toHaveLength(0);
    for (const listener of kit.appState.listeners) listener("active");
    vi.advanceTimersByTime(ALL_STARTED_MS);
    expect(snapshot("active again").running).toHaveLength(3);
  });

  // @req UX-SKY-01[badger-mobile]
  it("paused (Player over the shell) turns it off and nothing starts", async () => {
    const { draw } = await mount();
    vi.advanceTimersByTime(ALL_STARTED_MS);
    expect(kit.running()).toHaveLength(3);
    draw({ paused: true });
    vi.advanceTimersByTime(60_000);
    expect(snapshot("paused").running).toHaveLength(0);
    draw({ paused: false });
    vi.advanceTimersByTime(ALL_STARTED_MS);
    expect(snapshot("unpaused").running).toHaveLength(3);
  });

  // @req UX-SKY-01[badger-mobile]
  it("reduced motion keeps it off from the start, and turning it on later stops everything", async () => {
    kit.reduceMotion.enabled = true;
    await mount();
    vi.advanceTimersByTime(60_000);
    expect(snapshot("reduced motion at start").running).toHaveLength(0);
    for (const listener of kit.reduceMotion.listeners) listener(false);
    vi.advanceTimersByTime(ALL_STARTED_MS);
    expect(kit.running()).toHaveLength(3);
    for (const listener of kit.reduceMotion.listeners) listener(true);
    expect(snapshot("reduced motion turned on").running).toHaveLength(0);
  });

  // @req UX-SKY-01[badger-mobile]
  it("unmounting stops every loop and removes every listener", async () => {
    await mount();
    vi.advanceTimersByTime(ALL_STARTED_MS);
    unmount();
    vi.advanceTimersByTime(60_000);
    console.info(`[mobile-sky-motion:test] unmounted: running=${kit.running().length} listeners=${kit.appState.listeners.size + kit.reduceMotion.listeners.size + kit.keyboard.size}`);
    expect(kit.running()).toHaveLength(0);
    expect(kit.appState.listeners.size + kit.reduceMotion.listeners.size + kit.keyboard.size).toBe(0);
  });
});
