/**
 * @test-id MOBILE-LIB-FOREGROUND-SYNC-001
 * @level unit
 * @why Phase 9 wires `AppState.addEventListener("change", ...)` so that the
 *   library calls `db.syncFromRemoteIfNewer()` exactly once when the user
 *   brings the app back to foreground after backgrounding it. Pre-fix: the DB
 *   was never refreshed on resume; users saw stale data until they manually
 *   reloaded.
 * @regression-proof
 *   Critical invariants:
 *   - background → active triggers exactly one sync (after debounce).
 *   - background → active → background → active within debounce → still one sync.
 *   - active → active (no intervening background) does NOT trigger a sync.
 *   - inactive transitions are no-ops (iOS has them as a brief layer).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createForegroundSyncScheduler,
  FOREGROUND_SYNC_DEBOUNCE_MS,
  type AppStateLike,
} from "../src/lib/foregroundSync";

const makeFakeTimer = () => {
  type ScheduledItem = { cb: () => void; ms: number; id: number };
  const queue: ScheduledItem[] = [];
  let nextId = 1;

  const setTimeout = (cb: () => void, ms: number) => {
    const item: ScheduledItem = { cb, ms, id: nextId++ };
    queue.push(item);
    return item.id;
  };

  const clearTimeout = (handle: unknown) => {
    const idx = queue.findIndex((item) => item.id === handle);
    if (idx >= 0) queue.splice(idx, 1);
  };

  const advance = (ms: number) => {
    // Drain any items whose delay is <= ms (in registration order).
    const ready = queue.filter((item) => item.ms <= ms);
    ready.forEach((item) => {
      const idx = queue.indexOf(item);
      if (idx >= 0) queue.splice(idx, 1);
      item.cb();
    });
  };

  return { setTimeout, clearTimeout, advance, queueSize: () => queue.length };
};

const driveScheduler = (
  states: AppStateLike[],
  onSync: () => void,
  fakeTimer: ReturnType<typeof makeFakeTimer>,
) => {
  const scheduler = createForegroundSyncScheduler(onSync, {
    setTimeout: fakeTimer.setTimeout,
    clearTimeout: fakeTimer.clearTimeout,
  });
  states.forEach((state) => scheduler.observe(state));
  return scheduler;
};

// On assertion failure, dump the sync call count + remaining fake-timer queue
// so a debounce/transition regression is diagnosable from CI logs alone.
// Wrapped in try/catch so a dump failure can never mask the original error.
const dumpForegroundSyncSnapshot = (
  label: string,
  ctx: { sync: ReturnType<typeof vi.fn>; timer: ReturnType<typeof makeFakeTimer>; states?: string[] },
) => {
  try {
    console.error(`=== [library-foreground-sync:${label}] snapshot ===`);
    console.error(`debounceMs=${FOREGROUND_SYNC_DEBOUNCE_MS}`);
    if (ctx.states) console.error(`states observed=${JSON.stringify(ctx.states)}`);
    console.error(`sync: calls=${ctx.sync.mock.calls.length}`);
    console.error(`fakeTimer: pendingQueueSize=${ctx.timer.queueSize()}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("foreground sync scheduler", () => {
  it("background → active triggers sync once after the debounce window", () => {
    const states = ["background", "active"];
    console.info(`[library-foreground-sync:bg-active-once] driving states=${JSON.stringify(states)}`);
    const sync = vi.fn();
    const timer = makeFakeTimer();
    driveScheduler(states as AppStateLike[], sync, timer);

    // Before debounce elapses, no call.
    try {
      expect(sync).not.toHaveBeenCalled();
    } catch (err) {
      dumpForegroundSyncSnapshot("bg-active-once-fired-before-debounce", { sync, timer, states });
      throw err;
    }

    console.info(`[library-foreground-sync:bg-active-once] advancing timer by ${FOREGROUND_SYNC_DEBOUNCE_MS}ms`);
    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS);
    try {
      expect(sync).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("bg-active-once-wrong-count", { sync, timer, states });
      throw err;
    }
  });

  it("rapid background → active → background → active within debounce → still one sync", () => {
    const states = ["background", "active", "background", "active"];
    console.info(`[library-foreground-sync:rapid-flicker] driving states=${JSON.stringify(states)}`);
    const sync = vi.fn();
    const timer = makeFakeTimer();
    driveScheduler(states as AppStateLike[], sync, timer);

    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS);
    try {
      expect(sync).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("rapid-flicker-wrong-count", { sync, timer, states });
      throw err;
    }
  });

  it("active → active (no intervening background) does NOT trigger sync", () => {
    const states = ["active", "active", "active"];
    console.info(`[library-foreground-sync:active-active-noop] driving states=${JSON.stringify(states)}`);
    const sync = vi.fn();
    const timer = makeFakeTimer();
    driveScheduler(states as AppStateLike[], sync, timer);

    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS * 5);
    try {
      expect(sync).not.toHaveBeenCalled();
    } catch (err) {
      dumpForegroundSyncSnapshot("active-active-noop-unexpected-fire", { sync, timer, states });
      throw err;
    }
  });

  it("inactive transitions are ignored (iOS-only intermediate state)", () => {
    const sync = vi.fn();
    const timer = makeFakeTimer();

    // Simulate iOS: active → inactive → background → inactive → active
    const states = ["active", "inactive", "background", "inactive", "active"];
    console.info(`[library-foreground-sync:ios-inactive] driving states=${JSON.stringify(states)}`);
    driveScheduler(states as AppStateLike[], sync, timer);

    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS);
    try {
      expect(sync).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("ios-inactive-wrong-count", { sync, timer, states });
      throw err;
    }
  });

  it("multiple background→active cycles separated by debounce → multiple syncs", () => {
    console.info("[library-foreground-sync:multi-cycle] driving 2 bg→active cycles separated by debounce");
    const sync = vi.fn();
    const timer = makeFakeTimer();
    const scheduler = createForegroundSyncScheduler(sync, {
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    scheduler.observe("background");
    scheduler.observe("active");
    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS);
    try {
      expect(sync).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("multi-cycle-first-wrong-count", { sync, timer });
      throw err;
    }

    scheduler.observe("background");
    scheduler.observe("active");
    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS);
    try {
      expect(sync).toHaveBeenCalledTimes(2);
    } catch (err) {
      dumpForegroundSyncSnapshot("multi-cycle-second-wrong-count", { sync, timer });
      throw err;
    }
  });

  it("cancel() drops a pending sync", () => {
    console.info("[library-foreground-sync:cancel] arming then cancelling a pending sync");
    const sync = vi.fn();
    const timer = makeFakeTimer();
    const scheduler = createForegroundSyncScheduler(sync, {
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    scheduler.observe("background");
    scheduler.observe("active");
    try {
      expect(timer.queueSize()).toBe(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("cancel-arm-queue-wrong", { sync, timer });
      throw err;
    }

    scheduler.cancel();
    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS);
    try {
      expect(sync).not.toHaveBeenCalled();
    } catch (err) {
      dumpForegroundSyncSnapshot("cancel-still-fired", { sync, timer });
      throw err;
    }
  });

  it("starting from unknown → active does NOT trigger sync (only background→active)", () => {
    const states = ["active"];
    console.info(`[library-foreground-sync:unknown-active-noop] driving states=${JSON.stringify(states)}`);
    const sync = vi.fn();
    const timer = makeFakeTimer();
    driveScheduler(states as AppStateLike[], sync, timer);

    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS);
    try {
      expect(sync).not.toHaveBeenCalled();
    } catch (err) {
      dumpForegroundSyncSnapshot("unknown-active-noop-unexpected-fire", { sync, timer, states });
      throw err;
    }
  });

  it("debounce is exactly 1000ms (regression guard against tuning to 0)", () => {
    expect(FOREGROUND_SYNC_DEBOUNCE_MS).toBe(1_000);
  });

  it("rapid-fire background→active flickers cancel and re-arm the same single sync", () => {
    console.info("[library-foreground-sync:rearm] driving 3 bg→active arms, expecting single queued sync each time");
    const sync = vi.fn();
    const timer = makeFakeTimer();
    const scheduler = createForegroundSyncScheduler(sync, {
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    // First arming
    scheduler.observe("background");
    scheduler.observe("active");
    try {
      expect(timer.queueSize()).toBe(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("rearm-first-queue-wrong", { sync, timer });
      throw err;
    }

    // Second arming cancels the first
    scheduler.observe("background");
    scheduler.observe("active");
    try {
      expect(timer.queueSize()).toBe(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("rearm-second-queue-wrong", { sync, timer });
      throw err;
    }

    // Third arming cancels the second
    scheduler.observe("background");
    scheduler.observe("active");
    try {
      expect(timer.queueSize()).toBe(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("rearm-third-queue-wrong", { sync, timer });
      throw err;
    }

    timer.advance(FOREGROUND_SYNC_DEBOUNCE_MS);
    try {
      expect(sync).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpForegroundSyncSnapshot("rearm-final-wrong-count", { sync, timer });
      throw err;
    }
  });
});
