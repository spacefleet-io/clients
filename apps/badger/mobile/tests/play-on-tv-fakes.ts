/** Shared fakes for the Play on TV unit tests (UX-TV-02): a manual clock whose timers fire only on `advance`. */
export type ManualClock = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Moves time forward, firing due timers in order (timers armed while firing run too when due). */
  advance: (ms: number) => void;
  pending: () => number;
};

export const createManualClock = (start = 0): ManualClock => {
  let time = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    setTimer(fn, ms) {
      nextId += 1;
      timers.set(nextId, { at: time + ms, fn });
      return nextId;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = end;
    },
    pending: () => timers.size,
  };
};
