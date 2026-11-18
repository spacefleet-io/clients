/**
 * Scrolls in motion, for the sky's motion gate (UX-SKY-01). A scroll in motion
 * (finger down or momentum) counts as input held: the stars hold still and no
 * shooting star flies until every scroll settled and the quiet period passed.
 * Shooting stars fly anywhere, like the site's hero, and simply pass behind
 * opaque content, so nothing here measures the screen.
 *
 * Pure logic, no React Native: the React side is `mobile-sky-cover.tsx`.
 */

export type SkyCoverRegistry = {
  /** A scroll source (page, list, pager, TV remote) starts moving. Starts are idempotent per source. */
  scrollBegan: (source: object) => void;
  /** The source stopped for good (drag released without momentum, or momentum ended). */
  scrollEnded: (source: object) => void;
  /** True while any source is scrolling or has not settled yet. */
  isScrolling: () => boolean;
  /** Called with true when a scroll starts and with false once every scroll settled. */
  subscribeScrolling: (listener: (scrolling: boolean) => void) => () => void;
};

/**
 * A drag release is followed by the momentum start in a later event; waiting
 * this long before calling a scroll settled keeps those two as one scroll.
 */
export const SKY_SCROLL_SETTLE_MS = 120;

export type SkyTimers = {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
};

const defaultTimers: SkyTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id as number),
};

export const createSkyCoverRegistry = ({ setTimer, clearTimer }: SkyTimers = defaultTimers): SkyCoverRegistry => {
  const moving = new Set<object>();
  const listeners = new Set<(scrolling: boolean) => void>();
  let scrolling = false;
  let settleTimer: unknown;
  let settlePending = false;

  const emit = (next: boolean) => {
    scrolling = next;
    for (const listener of Array.from(listeners)) listener(next);
  };
  const settle = () => {
    settlePending = false;
    settleTimer = undefined;
    emit(false);
  };

  return {
    scrollBegan: (source) => {
      moving.add(source);
      if (settlePending) {
        clearTimer(settleTimer);
        settleTimer = undefined;
        settlePending = false;
      }
      if (!scrolling) emit(true);
    },
    scrollEnded: (source) => {
      if (!moving.delete(source) || moving.size > 0 || settlePending) return;
      settlePending = true;
      settleTimer = setTimer(settle, SKY_SCROLL_SETTLE_MS);
    },
    isScrolling: () => scrolling,
    subscribeScrolling: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export type SkyScrollHandlers = {
  onScrollBeginDrag: () => void;
  onScrollEndDrag: () => void;
  onMomentumScrollBegin: () => void;
  onMomentumScrollEnd: () => void;
};

/**
 * Scroll events of one ScrollView / FlatList as a scroll source: a drag or a
 * momentum in motion is a scroll in progress. A drag released into momentum
 * stays one scroll (see SKY_SCROLL_SETTLE_MS).
 */
export const createSkyScrollHandlers = (registry: SkyCoverRegistry): SkyScrollHandlers => {
  const source = {};
  const began = () => registry.scrollBegan(source);
  const ended = () => registry.scrollEnded(source);
  return { onScrollBeginDrag: began, onScrollEndDrag: ended, onMomentumScrollBegin: began, onMomentumScrollEnd: ended };
};
