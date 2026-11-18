/**
 * @test-id TV-SKY-REMOTE-001
 * @level unit
 * @why A TV has no touch and its lists scroll on focus without scroll events: each remote key must hold the sky
 *   still like a scroll in motion and release it only once the remote is quiet, so the 5 s quiet period starts from
 *   the last key (UX-SKY-01).
 */
import { describe, expect, it, vi } from "vitest";
import { createSkyCoverRegistry } from "../src/components/mobile-sky-covers";
import { createSkyRemoteInput, TV_KEY_SETTLE_MS } from "../src/components/mobile-sky-remote-input";
import { useSkyRemoteInput } from "../src/components/use-sky-remote-input";

// One render of `useSkyRemoteInput`: memo runs its factory, the TV event handler is kept to send keys by hand.
const hook = vi.hoisted(() => ({ tvHandler: undefined as undefined | (() => void), cleanups: [] as (() => void)[] }));
vi.mock("react", () => ({
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hook.cleanups.push(cleanup);
  },
}));
vi.mock("react-native", () => ({
  useTVEventHandler: (handler: () => void) => {
    hook.tvHandler = handler;
  },
}));

const fakeTimers = () => {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance: (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
};

describe("the TV remote holds the sky still (UX-SKY-01)", () => {
  // @req UX-SKY-01[badger-tv]
  it("holds while keys come and releases once the remote has been quiet for the settle time", () => {
    const clock = fakeTimers();
    const covers = createSkyCoverRegistry(clock);
    const seen: boolean[] = [];
    covers.subscribeScrolling((scrolling) => seen.push(scrolling));
    const remote = createSkyRemoteInput(covers, clock);

    remote.noteKey();
    expect(covers.isScrolling()).toBe(true);
    clock.advance(TV_KEY_SETTLE_MS - 1);
    remote.noteKey();
    clock.advance(TV_KEY_SETTLE_MS - 1);
    console.info("[tv-sky-remote] after two keys", JSON.stringify({ seen }));
    expect(covers.isScrolling()).toBe(true);
    clock.advance(1000);
    console.info("[tv-sky-remote] quiet", JSON.stringify({ seen }));
    expect(covers.isScrolling()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  // @req UX-SKY-01[badger-tv]
  it("dispose releases a hold still open", () => {
    const clock = fakeTimers();
    const covers = createSkyCoverRegistry(clock);
    const remote = createSkyRemoteInput(covers, clock);
    remote.noteKey();
    remote.dispose();
    clock.advance(1000);
    expect(covers.isScrolling()).toBe(false);
  });

  // @req UX-SKY-01[badger-tv]
  it("a screen using the hook (TV sign-in pages, main shell) holds its sky on a remote key, only while on top", () => {
    vi.useFakeTimers();
    const covers = createSkyCoverRegistry();
    useSkyRemoteInput(covers, false);
    hook.tvHandler?.();
    console.info("[tv-sky-remote] key on a covered screen", JSON.stringify({ scrolling: covers.isScrolling() }));
    expect(covers.isScrolling()).toBe(false);

    useSkyRemoteInput(covers);
    hook.tvHandler?.();
    console.info("[tv-sky-remote] key on the screen on top", JSON.stringify({ scrolling: covers.isScrolling() }));
    expect(covers.isScrolling()).toBe(true);
    vi.advanceTimersByTime(1000);
    console.info("[tv-sky-remote] remote quiet", JSON.stringify({ scrolling: covers.isScrolling() }));
    expect(covers.isScrolling()).toBe(false);
    for (const cleanup of hook.cleanups) cleanup();
    vi.useRealTimers();
  });
});
