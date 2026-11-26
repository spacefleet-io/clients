/**
 * The line of passing notices every app draws (UX-NOTICE-01, UX-NOTICE-03, UX-NOTICE-11): a short stack on the
 * computers and web, one card at a time on the phone and TV. Each visible notice has its own timer, which stops while
 * the pointer or focus is on it and starts a full period again when they leave. A repeat (same key) replaces the
 * earlier copy where it stands, with a fresh timer, instead of stacking. The app can take a notice back (`withdraw`).
 *
 * State plus timers only, no drawing: the overlays draw what `visible()` holds. `onDismiss` runs once per notice
 * whatever ended it, which is where callers mark it seen. While held (a screen such as the player covers the app)
 * nothing shows and no timer runs, so a notice is only dismissed, and marked seen, after it was actually on screen.
 */
import { NOTICE_TIMINGS } from "./kinds";

/** `withdrawn`: what the notice was about ended (the connection came back), so the app took it back (UX-NOTICE-02). */
export type NoticeDismissReason = "timeout" | "opened" | "closed" | "back" | "withdrawn";

export type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type NoticeQueueOptions<T> = {
  keyOf: (item: T) => string;
  /** Time on screen while nobody points at or focuses it; `null`: no timer (the TV's one-time message). */
  durationOf?: (item: T) => number | null;
  /** Used when `durationOf` is not given. */
  durationMs?: number;
  /** How many show at once (`MAX_VISIBLE`); the rest wait in order. Default 1. */
  maxVisible?: number;
  onDismiss?: (item: T, reason: NoticeDismissReason) => void;
  timers?: Timers;
  log?: (event: string, payload: Record<string, unknown>) => void;
};

export type NoticeQueue<T> = {
  /** The oldest visible notice (the one card on the phone and TV). */
  current: () => T | null;
  /** Visible notices, oldest first. A new array only when the line changed, so it can feed `useSyncExternalStore`. */
  visible: () => readonly T[];
  show: (item: T) => void;
  /** Ends the visible notice with this key, or the oldest visible one when no key is given. */
  dismiss: (reason: NoticeDismissReason, key?: string) => void;
  /** Takes back the notice with this key: gone at once if showing (reason `withdrawn`), dropped unseen if waiting. */
  withdraw: (key: string) => void;
  /**
   * The pointer or focus is on a notice (`key`) or on the whole stack (no key): its timer stops; leaving starts a full
   * period again (UX-NOTICE-03).
   */
  setPaused: (paused: boolean, key?: string) => void;
  /**
   * While held (another screen, such as the player, covers the app) nothing shows: visible notices go back to the front
   * of the line, unseen, and new ones wait. Releasing shows them again with a full period.
   */
  setHeld: (held: boolean) => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

type Slot<T> = { item: T; key: string; paused: boolean; timer: unknown };

export const createNoticeQueue = <T>({
  keyOf,
  durationOf,
  durationMs = NOTICE_TIMINGS.headsUpMs,
  maxVisible = 1,
  onDismiss,
  timers = defaultTimers,
  log,
}: NoticeQueueOptions<T>): NoticeQueue<T> => {
  const slots: Slot<T>[] = [];
  const waiting: T[] = [];
  let held = false;
  let snapshot: readonly T[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    snapshot = slots.map((slot) => slot.item);
    for (const listener of listeners) listener();
  };

  const stopTimer = (slot: Slot<T>) => {
    if (slot.timer !== null) timers.clearTimeout(slot.timer);
    slot.timer = null;
  };
  const startTimer = (slot: Slot<T>) => {
    stopTimer(slot);
    if (slot.paused) return;
    const ms = durationOf ? durationOf(slot.item) : durationMs;
    if (ms === null) return;
    slot.timer = timers.setTimeout(() => {
      slot.timer = null;
      end(slot, "timeout");
    }, ms);
  };

  const fill = () => {
    let added = false;
    while (!held && slots.length < maxVisible && waiting.length > 0) {
      const item = waiting.shift() as T;
      const slot: Slot<T> = { item, key: keyOf(item), paused: false, timer: null };
      slots.push(slot);
      log?.("notice.show", { key: slot.key, visible: slots.length, waiting: waiting.length });
      startTimer(slot);
      added = true;
    }
    return added;
  };

  const end = (slot: Slot<T>, reason: NoticeDismissReason) => {
    const index = slots.indexOf(slot);
    if (index < 0) return;
    stopTimer(slot);
    slots.splice(index, 1);
    log?.("notice.dismiss", { key: slot.key, reason });
    onDismiss?.(slot.item, reason);
    fill();
    changed();
  };

  const show = (item: T) => {
    const key = keyOf(item);
    const slot = slots.find((s) => s.key === key);
    if (slot) {
      slot.item = item;
      startTimer(slot);
      log?.("notice.replaced", { key, shown: true });
      changed();
      return;
    }
    const index = waiting.findIndex((w) => keyOf(w) === key);
    if (index >= 0) {
      waiting[index] = item;
      log?.("notice.replaced", { key, shown: false });
      return;
    }
    waiting.push(item);
    if (fill()) changed();
    else log?.("notice.queued", { key, waiting: waiting.length, held });
  };

  return {
    current: () => slots[0]?.item ?? null,
    visible: () => snapshot,
    show,
    dismiss: (reason, key) => {
      const slot = key === undefined ? slots[0] : slots.find((s) => s.key === key);
      if (slot) end(slot, reason);
    },
    withdraw: (key) => {
      const index = waiting.findIndex((w) => keyOf(w) === key);
      if (index >= 0) {
        waiting.splice(index, 1);
        log?.("notice.withdrawn", { key, shown: false });
      }
      const slot = slots.find((s) => s.key === key);
      if (slot) end(slot, "withdrawn");
    },
    setPaused: (paused, key) => {
      for (const slot of slots) {
        if ((key !== undefined && slot.key !== key) || slot.paused === paused) continue;
        slot.paused = paused;
        log?.("notice.paused", { key: slot.key, paused });
        if (paused) stopTimer(slot);
        else startTimer(slot);
      }
    },
    setHeld: (next) => {
      if (held === next) return;
      held = next;
      log?.("notice.held", { held, visible: slots.map((s) => s.key), waiting: waiting.length });
      if (held) {
        if (slots.length === 0) return;
        for (const slot of slots) stopTimer(slot);
        // Back to the front of the line, unseen. They leave the screen, so they no longer hold the pointer or focus
        // (the blur may never arrive): released, they start unpaused.
        waiting.unshift(...slots.map((slot) => slot.item));
        slots.length = 0;
        changed();
      } else if (fill()) changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      for (const slot of slots) stopTimer(slot);
      listeners.clear();
    },
  };
};
