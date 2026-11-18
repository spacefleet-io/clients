/**
 * In-app notices that float over the page (UX-NOTICE-01): one at a time, each gone after a fixed time or as soon as the
 * user acts on it. Shared by the phone and TV shells; the overlay components only draw what `current` holds.
 *
 * The queue never touches layout: it is state plus one timer. `onDismiss` runs once per notice whatever ended it (the
 * timer, a tap that opened its target, the close control or Back), which is where callers mark it seen. While held (a
 * screen such as the player covers the shell) nothing shows and no timer runs, so a notice is only ever dismissed, and
 * marked seen, after it was actually on screen.
 */
import { useEffect, useMemo, useState } from "react";

/** How long a notice stays when nobody touches it. One value for every client, so the notice reads the same everywhere. */
export const NOTICE_DURATION_MS = 8_000;

/** `withdrawn`: what the notice was about ended (the connection came back), so the app took it back (UX-NOTICE-02). */
export type NoticeDismissReason = "timeout" | "opened" | "closed" | "back" | "withdrawn";

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type NoticeQueueOptions<T> = {
  /** Two notices with the same key are one notice: a repeat while it waits or shows is dropped. */
  keyOf: (item: T) => string;
  onDismiss?: (item: T, reason: NoticeDismissReason) => void;
  durationMs?: number;
  timers?: Timers;
  log?: (event: string, payload: Record<string, unknown>) => void;
};

export type NoticeQueue<T> = {
  current: () => T | null;
  show: (item: T) => void;
  dismiss: (reason: NoticeDismissReason) => void;
  /** Takes back the notice with this key: gone at once if showing (reason `withdrawn`), dropped unseen if waiting. */
  withdraw: (key: string) => void;
  /** While paused (the TV notice holds the remote's focus) the timer is stopped; resuming starts a full period again. */
  setPaused: (paused: boolean) => void;
  /**
   * While held (another screen, such as the player, covers the shell) nothing shows: a notice that was showing goes back
   * to the front of the queue, unseen, and new ones wait. Releasing shows the first one with a full period.
   */
  setHeld: (held: boolean) => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export const createNoticeQueue = <T>({
  keyOf,
  onDismiss,
  durationMs = NOTICE_DURATION_MS,
  timers = defaultTimers,
  log,
}: NoticeQueueOptions<T>): NoticeQueue<T> => {
  let shown: T | null = null;
  const waiting: T[] = [];
  let paused = false;
  let held = false;
  let timer: unknown = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const stopTimer = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const startTimer = () => {
    stopTimer();
    if (shown === null || paused) return;
    timer = timers.setTimeout(() => {
      timer = null;
      dismiss("timeout");
    }, durationMs);
  };

  const showNext = () => {
    shown = held ? null : (waiting.shift() ?? null);
    if (shown !== null) log?.("notice.show", { key: keyOf(shown), waiting: waiting.length });
    startTimer();
    notify();
  };

  const dismiss = (reason: NoticeDismissReason) => {
    if (shown === null) return;
    const item = shown;
    stopTimer();
    shown = null;
    log?.("notice.dismiss", { key: keyOf(item), reason });
    onDismiss?.(item, reason);
    showNext();
  };

  const show = (item: T) => {
    const key = keyOf(item);
    if ((shown !== null && keyOf(shown) === key) || waiting.some((w) => keyOf(w) === key)) {
      log?.("notice.duplicate", { key });
      return;
    }
    waiting.push(item);
    if (shown === null && !held) showNext();
    else log?.("notice.queued", { key, waiting: waiting.length, held });
  };

  const withdraw = (key: string) => {
    const index = waiting.findIndex((w) => keyOf(w) === key);
    if (index >= 0) {
      waiting.splice(index, 1);
      log?.("notice.withdrawn", { key, shown: false });
    }
    if (shown !== null && keyOf(shown) === key) dismiss("withdrawn");
  };

  return {
    current: () => shown,
    show,
    dismiss,
    withdraw,
    setPaused: (next) => {
      if (paused === next) return;
      paused = next;
      log?.("notice.paused", { paused });
      if (paused) stopTimer();
      else startTimer();
    },
    setHeld: (next) => {
      if (held === next) return;
      held = next;
      log?.("notice.held", { held, shown: shown === null ? null : keyOf(shown), waiting: waiting.length });
      if (held && shown !== null) {
        stopTimer();
        waiting.unshift(shown);
        shown = null;
        // The notice leaves the screen, so it no longer holds the remote's focus (its blur may never arrive).
        paused = false;
        notify();
      } else if (!held && shown === null) showNext();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      stopTimer();
      listeners.clear();
    },
  };
};

/** The queue for one shell, kept for the shell's lifetime. `onDismiss` may change between renders; the latest one runs. */
export const useNoticeQueue = <T>(options: NoticeQueueOptions<T>) => {
  const [latest] = useState(() => ({ options }));
  latest.options = options;
  const queue = useMemo(
    () =>
      createNoticeQueue<T>({
        ...latest.options,
        keyOf: (item) => latest.options.keyOf(item),
        onDismiss: (item, reason) => latest.options.onDismiss?.(item, reason),
      }),
    [latest],
  );
  const [current, setCurrent] = useState<T | null>(null);
  useEffect(() => {
    const unsubscribe = queue.subscribe(() => setCurrent(queue.current()));
    return () => {
      unsubscribe();
      queue.dispose();
    };
  }, [queue]);
  return { current, show: queue.show, dismiss: queue.dismiss, withdraw: queue.withdraw, setPaused: queue.setPaused, setHeld: queue.setHeld };
};
