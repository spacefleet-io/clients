/**
 * @test-id MOBILE-FGSYNC-001
 * @level unit
 * Pure-logic scheduler: covers debounce on background→active, and the new
 * triggerFromPush() variant which must
 *   - fire immediately (after debounce) when foreground
 *   - defer until next active when backgrounded
 */
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import {
  createForegroundSyncScheduler,
  FOREGROUND_SYNC_DEBOUNCE_MS,
} from "../src/lib/foregroundSync";

// Dump-on-failure: print the debounce window + observed sync invocations so a
// failing call-count assertion shows what the scheduler actually did.
// try/catch so a dump failure can't mask the real assertion.
const dumpSyncSnapshot = (label: string, onSync: Mock, observed: string[]) => {
  try {
    console.error(`=== [foreground-sync:${label}] snapshot ===`);
    console.error(`debounceMs=${FOREGROUND_SYNC_DEBOUNCE_MS} observed-transitions=${JSON.stringify(observed)}`);
    console.error(`onSync.calls=${onSync.mock.calls.length} callArgs=${JSON.stringify(onSync.mock.calls)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("foregroundSync scheduler", () => {
  it("fires once on background -> active", () => {
    console.info(`[foreground-sync:bg-to-active] debounceMs=${FOREGROUND_SYNC_DEBOUNCE_MS}`);
    vi.useFakeTimers();
    const onSync = vi.fn();
    const sched = createForegroundSyncScheduler(onSync);
    const observed = ["active", "background", "active"];
    sched.observe("active");
    sched.observe("background");
    sched.observe("active");
    console.info(`[foreground-sync:bg-to-active] advancing timers by ${FOREGROUND_SYNC_DEBOUNCE_MS}ms`);
    vi.advanceTimersByTime(FOREGROUND_SYNC_DEBOUNCE_MS);
    console.info(`[foreground-sync:bg-to-active] onSync calls=${onSync.mock.calls.length} (expected 1)`);
    if (onSync.mock.calls.length !== 1) dumpSyncSnapshot("bg-to-active", onSync, observed);
    expect(onSync).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("treats inactive as transient (no transition update)", () => {
    console.info(`[foreground-sync:inactive-transient] debounceMs=${FOREGROUND_SYNC_DEBOUNCE_MS}`);
    vi.useFakeTimers();
    const onSync = vi.fn();
    const sched = createForegroundSyncScheduler(onSync);
    const observed = ["background", "inactive", "active"];
    sched.observe("background");
    sched.observe("inactive");
    sched.observe("active");
    console.info(`[foreground-sync:inactive-transient] advancing timers by ${FOREGROUND_SYNC_DEBOUNCE_MS}ms`);
    vi.advanceTimersByTime(FOREGROUND_SYNC_DEBOUNCE_MS);
    console.info(`[foreground-sync:inactive-transient] onSync calls=${onSync.mock.calls.length} (expected 1)`);
    if (onSync.mock.calls.length !== 1) dumpSyncSnapshot("inactive-transient", onSync, observed);
    expect(onSync).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("triggerFromPush() while foreground schedules a sync", () => {
    console.info(`[foreground-sync:push-foreground] debounceMs=${FOREGROUND_SYNC_DEBOUNCE_MS}`);
    vi.useFakeTimers();
    const onSync = vi.fn();
    const sched = createForegroundSyncScheduler(onSync);
    const observed = ["active", "push"];
    sched.observe("active");
    sched.triggerFromPush();
    console.info(`[foreground-sync:push-foreground] advancing timers by ${FOREGROUND_SYNC_DEBOUNCE_MS}ms`);
    vi.advanceTimersByTime(FOREGROUND_SYNC_DEBOUNCE_MS);
    console.info(`[foreground-sync:push-foreground] onSync calls=${onSync.mock.calls.length} (expected 1)`);
    if (onSync.mock.calls.length !== 1) dumpSyncSnapshot("push-foreground", onSync, observed);
    expect(onSync).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("triggerFromPush() while backgrounded defers until next active", () => {
    console.info(`[foreground-sync:push-deferred] debounceMs=${FOREGROUND_SYNC_DEBOUNCE_MS}`);
    vi.useFakeTimers();
    const onSync = vi.fn();
    const sched = createForegroundSyncScheduler(onSync);
    const observed = ["background", "push"];
    sched.observe("background");
    sched.triggerFromPush();
    vi.advanceTimersByTime(FOREGROUND_SYNC_DEBOUNCE_MS);
    console.info(`[foreground-sync:push-deferred] while-backgrounded onSync calls=${onSync.mock.calls.length} (expected 0)`);
    if (onSync.mock.calls.length !== 0) dumpSyncSnapshot("push-deferred-while-bg", onSync, observed);
    expect(onSync).not.toHaveBeenCalled();
    observed.push("active");
    sched.observe("active");
    vi.advanceTimersByTime(FOREGROUND_SYNC_DEBOUNCE_MS);
    // Either the background→active debounce OR the pending push wakeup
    // should produce exactly one sync.
    console.info(`[foreground-sync:push-deferred] after returning to active onSync calls=${onSync.mock.calls.length} (expected 1)`);
    if (onSync.mock.calls.length !== 1) dumpSyncSnapshot("push-deferred-after-active", onSync, observed);
    expect(onSync).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cancel() clears a pending push trigger", () => {
    console.info(`[foreground-sync:cancel] debounceMs=${FOREGROUND_SYNC_DEBOUNCE_MS}`);
    vi.useFakeTimers();
    const onSync = vi.fn();
    const sched = createForegroundSyncScheduler(onSync);
    const observed = ["active", "push", "cancel"];
    sched.observe("active");
    sched.triggerFromPush();
    sched.cancel();
    console.info(`[foreground-sync:cancel] advancing timers by ${FOREGROUND_SYNC_DEBOUNCE_MS * 2}ms after cancel`);
    vi.advanceTimersByTime(FOREGROUND_SYNC_DEBOUNCE_MS * 2);
    console.info(`[foreground-sync:cancel] onSync calls=${onSync.mock.calls.length} (expected 0)`);
    if (onSync.mock.calls.length !== 0) dumpSyncSnapshot("cancel", onSync, observed);
    expect(onSync).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
