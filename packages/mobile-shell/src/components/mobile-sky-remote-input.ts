/**
 * The TV remote as input for the sky (UX-SKY-01). A TV has no touch and its lists scroll by themselves when the
 * focus moves (no drag, no momentum events), so every remote key counts as a scroll that is in motion: the sky
 * holds still (no shooting star) while keys keep coming. Once the remote has been quiet for
 * `TV_KEY_SETTLE_MS` (long enough for the focus scroll animation to end) the scroll ends and the sky's usual quiet
 * period (5 s, `SKY_IDLE_MS`) starts.
 */
import type { SkyCoverRegistry } from "./mobile-sky-covers";

/** Remote quiet time after which the screen is taken as still (focus scroll animations take about 300 ms). */
export const TV_KEY_SETTLE_MS = 450;

export type SkyRemoteTimers = {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
};

export type SkyRemoteInput = {
  /** A remote key (or the focus move it caused). */
  noteKey: () => void;
  /** The shell left the tree: a scroll still open must not hold the star for good. */
  dispose: () => void;
};

const defaultTimers: SkyRemoteTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id as number),
};

export const createSkyRemoteInput = (
  covers: Pick<SkyCoverRegistry, "scrollBegan" | "scrollEnded">,
  timers: SkyRemoteTimers = defaultTimers,
): SkyRemoteInput => {
  const source = {};
  let timer: unknown;
  const end = () => {
    timer = undefined;
    covers.scrollEnded(source);
  };
  return {
    noteKey: () => {
      covers.scrollBegan(source);
      if (timer !== undefined) timers.clearTimer(timer);
      timer = timers.setTimer(end, TV_KEY_SETTLE_MS);
    },
    dispose: () => {
      if (timer === undefined) return;
      timers.clearTimer(timer);
      end();
    },
  };
};
