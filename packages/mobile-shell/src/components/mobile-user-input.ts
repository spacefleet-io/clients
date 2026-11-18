/**
 * Touch input seen by a screen root, for the backdrop's idle shooting star
 * (UX-SKY-01). The root view spreads `touchHandlers`; touch events bubble to it
 * from every child without making it the responder, so taps, scrolls and
 * swipes all count. `held` is true from the first finger down until the last
 * finger lifts.
 */
type TouchEventLike = { nativeEvent: { touches: ArrayLike<unknown> } };

export type UserInputSignal = {
  touchHandlers: {
    onTouchStart: (event: TouchEventLike) => void;
    onTouchEnd: (event: TouchEventLike) => void;
    onTouchCancel: (event: TouchEventLike) => void;
  };
  subscribe: (listener: (held: boolean) => void) => () => void;
};

export const createUserInputSignal = (): UserInputSignal => {
  const listeners = new Set<(held: boolean) => void>();
  let held = false;
  const set = (next: boolean) => {
    if (next === held) return;
    held = next;
    for (const listener of listeners) listener(held);
  };
  return {
    touchHandlers: {
      onTouchStart: () => set(true),
      onTouchEnd: (event) => set(event.nativeEvent.touches.length > 0),
      onTouchCancel: () => set(false),
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
