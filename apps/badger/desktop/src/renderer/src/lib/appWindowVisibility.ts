// Renderer side of main's hidden/visible flag for the app window (issue #25
// P19/M7). The window hides while external mpv plays, but it runs with
// `backgroundThrottling: false`, so Chromium keeps every timer at full rate
// and `document.visibilityState` stays "visible". Main pushes the real state
// over IPC; renderer loops read it here to skip UI-only work while hidden.

import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "app-window-visibility" });

export type AppWindowVisibilityChange = { hidden: boolean; atMs: number; reason: string };
type Listener = (change: AppWindowVisibilityChange) => void;

let hidden = false;
let installed = false;
const listeners = new Set<Listener>();

const apply = (change: AppWindowVisibilityChange) => {
  if (change.hidden === hidden) return;
  hidden = change.hidden;
  // Issue #25 P1 residual: Chromium never learns the window is hidden, so CSS
  // animations (job spinner, dashboard chevrons) keep ticking the compositor.
  // styles.css pauses every animation under this mark.
  if (typeof document !== "undefined") document.documentElement.toggleAttribute("data-app-window-hidden", hidden);
  log.info(
    { hidden: change.hidden, atMs: change.atMs, reason: change.reason, listeners: listeners.size },
    `[app-window-visibility] hidden=${change.hidden} reason=${change.reason}`,
  );
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (err) {
      log.warn({ err: String(err) }, "[app-window-visibility] listener failed");
    }
  }
};

// Lazily bound to the preload bridge on first use, so the module costs
// nothing in the startup entry chunk and works without `window.sf` (tests).
const ensureInstalled = () => {
  if (installed) return;
  installed = true;
  const sf = typeof window === "undefined" ? undefined : window.sf;
  if (!sf?.onAppWindowVisibility) return;
  sf.onAppWindowVisibility(apply);
  // A renderer that (re)loads while the window is already hidden.
  void sf.getAppWindowVisibility?.()
    .then((state) => {
      if (state) apply(state);
    })
    .catch((err: unknown) => log.warn({ err: String(err) }, "[app-window-visibility] initial state fetch failed"));
};

/** True while main reports the app window hidden (external mpv playing, tray). */
export const isAppWindowHidden = (): boolean => {
  ensureInstalled();
  return hidden;
};

export const subscribeAppWindowVisibility = (listener: Listener): (() => void) => {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * A setter for UI-only state that drops writes while the window is hidden and
 * keeps the latest value; on show it applies that value once, so the UI is
 * current the moment it becomes visible. `skipped` counts dropped writes.
 */
export const createHiddenCoalescedSetter = <T,>(set: (value: T) => void) => {
  let pending: { value: T } | null = null;
  let skipped = 0;
  const unsubscribe = subscribeAppWindowVisibility((change) => {
    if (change.hidden || !pending) return;
    const { value } = pending;
    pending = null;
    set(value);
  });
  return {
    set: (value: T) => {
      if (hidden) {
        pending = { value };
        skipped += 1;
        return;
      }
      pending = null;
      set(value);
    },
    skipped: () => skipped,
    dispose: unsubscribe,
  };
};

/** Cadence of the external-mpv poll and ABR tick while the window is hidden (issue #25 P19-residual). */
export const HIDDEN_LOOP_INTERVAL_MS = 1_000;

/**
 * `setInterval` that runs at `visibleMs` while the window is visible and at
 * `hiddenMs` while main reports it hidden. Re-arms on every flip; on show it
 * also runs `fn` once right away so the UI is current without waiting a tick.
 */
export const createVisibilityAwareInterval = (
  fn: () => void,
  { visibleMs, hiddenMs = HIDDEN_LOOP_INTERVAL_MS }: { visibleMs: number; hiddenMs?: number },
) => {
  const periodFor = (isHidden: boolean) => (isHidden ? Math.max(visibleMs, hiddenMs) : visibleMs);
  let periodMs = periodFor(isAppWindowHidden());
  let id = window.setInterval(fn, periodMs);
  const unsubscribe = subscribeAppWindowVisibility((change) => {
    const next = periodFor(change.hidden);
    if (next === periodMs) return;
    window.clearInterval(id);
    periodMs = next;
    id = window.setInterval(fn, periodMs);
    if (!change.hidden) fn();
  });
  return {
    periodMs: () => periodMs,
    dispose: () => {
      unsubscribe();
      window.clearInterval(id);
    },
  };
};

/** Test seam: drive the flag as main's IPC would. */
export const __setAppWindowHiddenForTests = (change: AppWindowVisibilityChange): void => {
  installed = true;
  apply(change);
};

/** Test seam: reset module state between tests. */
export const __resetAppWindowVisibilityForTests = (): void => {
  hidden = false;
  if (typeof document !== "undefined") document.documentElement.removeAttribute("data-app-window-hidden");
  installed = false;
  listeners.clear();
};
