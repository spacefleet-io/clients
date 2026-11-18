/**
 * Pure-logic helper for the AppState foreground-sync effect.
 *
 * The mobile app should call `db.syncFromRemoteIfNewer()` exactly once when
 * the user brings the app back to foreground after backgrounding it. Multiple
 * rapid AppState transitions (background→active→inactive→active) within the
 * debounce window must still produce only one sync call.
 *
 * This module exposes a small state-machine + scheduler that is easy to test
 * without React or react-native imports.
 */

export type AppStateLike = "active" | "background" | "inactive" | "unknown";

export const FOREGROUND_SYNC_DEBOUNCE_MS = 1_000;

type SchedulerDeps<Handle> = {
  setTimeout: (cb: () => void, ms: number) => Handle;
  clearTimeout: (handle: Handle) => void;
};

/** Handle produced by the platform `setTimeout` (a number on Hermes, an object on Node/Bun). */
export type PlatformTimerHandle = ReturnType<typeof globalThis.setTimeout>;

const defaultDeps: SchedulerDeps<PlatformTimerHandle> = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export type ForegroundSyncScheduler = {
  /** Feed an AppState change into the scheduler. */
  observe: (state: AppStateLike) => void;
  /** Cancel any pending sync. */
  cancel: () => void;
  /**
   * Trigger a sync as if a foreground push had arrived. If the app is in
   * foreground, fires immediately. If in background, sets a pending flag so
   * the next `active` transition syncs without waiting for the next debounce.
   */
  triggerFromPush: () => void;
};

const buildScheduler = <Handle>(
  onSync: () => void,
  deps: SchedulerDeps<Handle>,
): ForegroundSyncScheduler => {
  let lastResolved: AppStateLike = "unknown";
  let pendingTimer: Handle | null = null;
  let pushPending = false;

  const cancel = () => {
    if (pendingTimer != null) {
      deps.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const schedule = () => {
    cancel();
    pendingTimer = deps.setTimeout(() => {
      pendingTimer = null;
      onSync();
    }, FOREGROUND_SYNC_DEBOUNCE_MS);
  };

  const observe = (state: AppStateLike) => {
    // `inactive` is transient — don't update lastResolved.
    if (state === "inactive") return;

    const prev = lastResolved;
    lastResolved = state;

    if (prev === "background" && state === "active") {
      schedule();
      pushPending = false;
      return;
    }
    if (state === "active" && pushPending) {
      // Background push arrived while we were already active or backgrounded;
      // drain on next active tick.
      pushPending = false;
      schedule();
    }
  };

  const triggerFromPush = () => {
    if (lastResolved === "active") {
      schedule();
      return;
    }
    pushPending = true;
  };

  return { observe, cancel, triggerFromPush };
};

/**
 * Builds a scheduler that fires `onSync` once, debounced by
 * `FOREGROUND_SYNC_DEBOUNCE_MS`, after a `background → active` transition.
 *
 * - `inactive` is treated as a no-op for transitions (matches iOS where
 *   `inactive` is the brief layer between `active` and `background`).
 * - Multiple `active` events without an intervening `background` do NOT
 *   re-arm the timer.
 *
 * `deps` overrides the timer functions (tests inject fakes); the handle type
 * is whatever the injected `setTimeout` returns.
 */
export const createForegroundSyncScheduler = <Handle>(
  onSync: () => void,
  deps?: SchedulerDeps<Handle>,
): ForegroundSyncScheduler => {
  if (deps) return buildScheduler(onSync, deps);
  return buildScheduler(onSync, defaultDeps);
};
