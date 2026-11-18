import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAsyncAction,
  DEFAULT_MIN_VISIBLE_MS,
  DEFAULT_SPINNER_DELAY_MS,
} from "../src/asyncAction";

// On assertion failure, dump enough state to diagnose the timer/callback
// interplay offline (per "Tests log generously": tests self-diagnose).
const dumpAsyncActionSnapshot = (
  label: string,
  state: {
    callCount?: number;
    sideEffects?: number[];
    onPendingChange?: ReturnType<typeof vi.fn>;
    onSpinnerChange?: ReturnType<typeof vi.fn>;
    onSuccess?: ReturnType<typeof vi.fn>;
    onError?: ReturnType<typeof vi.fn>;
    fn?: ReturnType<typeof vi.fn>;
    isPending?: boolean;
  },
) => {
  try {
    console.error(`=== [async-action:${label}] snapshot ===`);
    if (state.callCount !== undefined) console.error(`callCount=${state.callCount}`);
    if (state.sideEffects !== undefined)
      console.error(`sideEffects=${JSON.stringify(state.sideEffects)}`);
    if (state.isPending !== undefined) console.error(`isPending=${state.isPending}`);
    if (state.fn) console.error(`fn.callCount=${state.fn.mock.calls.length}`);
    if (state.onPendingChange)
      console.error(
        `onPendingChange calls=${JSON.stringify(state.onPendingChange.mock.calls.map(([v]) => v))}`,
      );
    if (state.onSpinnerChange)
      console.error(
        `onSpinnerChange calls=${JSON.stringify(state.onSpinnerChange.mock.calls.map(([v]) => v))}`,
      );
    if (state.onSuccess)
      console.error(`onSuccess calls=${JSON.stringify(state.onSuccess.mock.calls)}`);
    if (state.onError)
      console.error(
        `onError calls=${JSON.stringify(
          state.onError.mock.calls.map(([err, args]) => ({
            err: err instanceof Error ? err.message : String(err),
            args,
          })),
        )}`,
      );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("createAsyncAction", () => {
  beforeEach(() => {
    console.info(`[async-action:setup] installing fake timers`);
    vi.useFakeTimers();
  });

  afterEach(() => {
    console.info(`[async-action:teardown] restoring real timers`);
    vi.useRealTimers();
  });

  it("exports the expected default delay constants", () => {
    expect(DEFAULT_SPINNER_DELAY_MS).toBe(400);
    expect(DEFAULT_MIN_VISIBLE_MS).toBe(250);
  });

  // ── Case a: re-click drop ──────────────────────────────────────────────────
  it("(a) drops a second trigger() call within 50 ms — fn called exactly once", async () => {
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      // resolve after spinnerDelayMs so pending stays true when second trigger fires
      await new Promise<void>((r) => setTimeout(r, DEFAULT_SPINNER_DELAY_MS + 100));
    });

    const onPendingChange = vi.fn();
    const onSuccess = vi.fn();

    const action = createAsyncAction(fn, { onPendingChange, onSuccess });

    // First trigger — starts pending
    const p1 = action.trigger();

    // Advance 50 ms (still pending)
    vi.advanceTimersByTime(50);

    // Second trigger — should be dropped
    const p2 = action.trigger();

    // Let both settle
    console.info(`[async-action:case-a] flushing timers + awaiting both triggers`);
    await vi.runAllTimersAsync();
    await p1;
    await p2;

    if (callCount !== 1 || fn.mock.calls.length !== 1)
      dumpAsyncActionSnapshot("case-a-re-click-drop", { callCount, fn });
    expect(callCount).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── Case b: fast resolve — no spinner ────────────────────────────────────
  it("(b) fn resolves at 200 ms (under spinnerDelayMs=400) → onSpinnerChange(true) never called", async () => {
    const fn = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 200));
      return "done";
    });

    const onSpinnerChange = vi.fn();
    const onPendingChange = vi.fn();
    const onSuccess = vi.fn();

    const action = createAsyncAction(fn, {
      onSpinnerChange,
      onPendingChange,
      onSuccess,
      spinnerDelayMs: DEFAULT_SPINNER_DELAY_MS,
      minVisibleMs: DEFAULT_MIN_VISIBLE_MS,
    });

    console.info(`[async-action:case-b] triggering then flushing fast-resolve (200ms < 400ms delay)`);
    const p = action.trigger();
    await vi.runAllTimersAsync();
    await p;

    try {
      expect(onSpinnerChange).not.toHaveBeenCalledWith(true);
      // pending must go false again
      expect(onPendingChange).toHaveBeenLastCalledWith(false);
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onSuccess).toHaveBeenCalledWith("done", []);
    } catch (err) {
      dumpAsyncActionSnapshot("case-b-fast-resolve-no-spinner", {
        onSpinnerChange,
        onPendingChange,
        onSuccess,
      });
      throw err;
    }
  });

  // ── Case c: slow resolve — spinner shown then hidden after min-visible ────
  it("(c) fn resolves at 500 ms (>spinnerDelayMs=400) → spinner shown then hidden after ≥250 ms", async () => {
    const fn = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 500));
      return 42;
    });

    const onSpinnerChange = vi.fn();
    const onPendingChange = vi.fn();

    const action = createAsyncAction(fn, {
      onSpinnerChange,
      onPendingChange,
      spinnerDelayMs: DEFAULT_SPINNER_DELAY_MS, // 400
      minVisibleMs: DEFAULT_MIN_VISIBLE_MS,      // 250
    });

    const p = action.trigger();

    // Advance past spinnerDelayMs (400 ms) but before fn resolves (500 ms)
    console.info(`[async-action:case-c] advancing +450ms (past 400ms delay, before 500ms resolve)`);
    vi.advanceTimersByTime(450);
    // Spinner should now be visible
    if (!onSpinnerChange.mock.calls.some(([v]) => v === true))
      dumpAsyncActionSnapshot("case-c-spinner-not-shown-after-450ms", { onSpinnerChange });
    expect(onSpinnerChange).toHaveBeenCalledWith(true);

    // Capture the time spinner was shown
    const shownCallIndex = onSpinnerChange.mock.calls.findIndex(([v]) => v === true);
    expect(shownCallIndex).toBeGreaterThanOrEqual(0);

    // Advance remaining time so fn resolves (50 ms more = 500 total)
    console.info(`[async-action:case-c] advancing +50ms to resolve fn (total 500ms)`);
    vi.advanceTimersByTime(50);

    // At this point fn resolved but min-visible not yet elapsed (250 ms needed, only 50 ms past show)
    // spinner(false) must NOT have fired yet
    if (onSpinnerChange.mock.calls.some(([v]) => v === false))
      dumpAsyncActionSnapshot("case-c-spinner-hidden-before-min-visible", { onSpinnerChange });
    expect(onSpinnerChange).not.toHaveBeenCalledWith(false);

    // Advance past minVisibleMs (250 ms) since spinner was shown at ~400 ms; fn resolved at 500 ms,
    // so remaining = 250 - 50 = 200 ms more
    console.info(`[async-action:case-c] advancing +200ms past minVisibleMs to hide spinner`);
    vi.advanceTimersByTime(200);
    await vi.runAllTimersAsync();
    await p;

    // Now spinner(false) must have been called
    const calls = onSpinnerChange.mock.calls.map(([v]) => v);
    try {
      expect(calls).toContain(true);
      expect(calls).toContain(false);
      // true must come before false
      expect(calls.indexOf(true)).toBeLessThan(calls.indexOf(false));
    } catch (err) {
      dumpAsyncActionSnapshot("case-c-spinner-ordering", { onSpinnerChange });
      throw err;
    }
  });

  // ── Case d: fn throws → onError called, pending ends at false ────────────
  it("(d) fn throws → onError called once with error+args, pending ends at false", async () => {
    const boom = new Error("kaboom");
    const fn = vi.fn(async (..._args: [string, number]) => {
      throw boom;
    });

    const onError = vi.fn();
    const onPendingChange = vi.fn();
    const onSpinnerChange = vi.fn();
    const onSuccess = vi.fn();

    const action = createAsyncAction(fn, {
      onError,
      onPendingChange,
      onSpinnerChange,
      onSuccess,
    });

    console.info(`[async-action:case-d] triggering throwing fn with args ["hello", 99]`);
    const p = action.trigger("hello", 99);
    await vi.runAllTimersAsync();
    await p;

    try {
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(boom, ["hello", 99]);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith(false);
      expect(action.isPending()).toBe(false);
    } catch (err) {
      dumpAsyncActionSnapshot("case-d-throw", {
        onError,
        onSuccess,
        onPendingChange,
        isPending: action.isPending(),
      });
      throw err;
    }
  });

  // ── Case e: dispose() during pending → no callbacks after, no rejection ──
  it("(e) dispose() during pending → no onPendingChange/onSpinnerChange after dispose, no unhandled rejection", async () => {
    let resolveFn!: () => void;
    const fn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFn = resolve;
        }),
    );

    const onPendingChange = vi.fn();
    const onSpinnerChange = vi.fn();
    const onError = vi.fn();
    const onSuccess = vi.fn();

    const action = createAsyncAction(fn, {
      onPendingChange,
      onSpinnerChange,
      onError,
      onSuccess,
      spinnerDelayMs: DEFAULT_SPINNER_DELAY_MS,
    });

    const p = action.trigger();

    // Capture the call count just before dispose
    const pendingCallsBefore = onPendingChange.mock.calls.length;
    const spinnerCallsBefore = onSpinnerChange.mock.calls.length;

    // Dispose while still pending
    console.info(
      `[async-action:case-e] disposing while pending (pendingCallsBefore=${pendingCallsBefore} spinnerCallsBefore=${spinnerCallsBefore})`,
    );
    action.dispose();

    // Advance all timers (spinner timeout fires, fn would complete)
    vi.advanceTimersByTime(DEFAULT_SPINNER_DELAY_MS + 100);

    // Now resolve the fn promise — should not trigger any callbacks
    console.info(`[async-action:case-e] resolving disposed in-flight fn`);
    resolveFn();

    await vi.runAllTimersAsync();
    // Awaiting p must not throw (no unhandled rejection)
    await expect(p).resolves.toBeUndefined();

    // No NEW callbacks after dispose
    try {
      expect(onPendingChange.mock.calls.length).toBe(pendingCallsBefore);
      expect(onSpinnerChange.mock.calls.length).toBe(spinnerCallsBefore);
      expect(onError).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    } catch (err) {
      console.error(
        `[async-action:case-e] expected no NEW callbacks after dispose: pendingBefore=${pendingCallsBefore} pendingNow=${onPendingChange.mock.calls.length} spinnerBefore=${spinnerCallsBefore} spinnerNow=${onSpinnerChange.mock.calls.length}`,
      );
      dumpAsyncActionSnapshot("case-e-dispose-no-callbacks-after", {
        onPendingChange,
        onSpinnerChange,
        onError,
        onSuccess,
      });
      throw err;
    }
  });

  // Regression: Dashboard Play button spawned duplicate playback launches on
  // rapid clicks because handlePlayMedia incremented requestId per click. The
  // fix wraps it in createAsyncAction so re-clicks during pending are dropped
  // before any side effect (setPlaybackState) runs.
  it("@bugfix @regression-proof dashboard-play-re-click: trigger drops re-clicks while pending so duplicate requestId bumps cannot queue", async () => {
    // Precondition: fake timers active (from beforeEach). First trigger holds
    // an in-flight promise that we resolve manually so we can assert the
    // drop-behavior while pending === true.
    let resolveFn!: () => void;
    const sideEffects: number[] = [];
    const fn = vi.fn(async () => {
      // Stand-in for setPlaybackState / requestId bump. Must happen exactly
      // once per user intent, not once per click.
      sideEffects.push(sideEffects.length + 1);
      await new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
    });

    const action = createAsyncAction(fn);

    // First click
    console.info(`[async-action:bugfix-re-click] first click → starts pending`);
    const p1 = action.trigger();
    expect(action.isPending()).toBe(true);

    // Second click 5 ms later — the bug reproduction: user hits Play again
    // because no UI feedback appeared.
    console.info(`[async-action:bugfix-re-click] second click +5ms (should be dropped)`);
    vi.advanceTimersByTime(5);
    const p2Result = action.trigger();

    // Third click for good measure — real users clicked 2-3 times.
    console.info(`[async-action:bugfix-re-click] third click +5ms (should be dropped)`);
    vi.advanceTimersByTime(5);
    const p3Result = action.trigger();

    // Post-fix assertion: re-clicks during pending return undefined synchronously
    // (no queued launch). Pre-fix behavior (no drop) would have made fn run
    // multiple times and sideEffects.length would be > 1.
    await expect(p2Result).resolves.toBeUndefined();
    await expect(p3Result).resolves.toBeUndefined();
    try {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sideEffects).toEqual([1]);
    } catch (err) {
      console.error(
        `[async-action:bugfix-re-click] DUPLICATE LAUNCH: fn ran ${fn.mock.calls.length}x, sideEffects=${JSON.stringify(sideEffects)} (expected exactly 1)`,
      );
      dumpAsyncActionSnapshot("bugfix-re-click-duplicate-launch", { fn, sideEffects });
      throw err;
    }

    // Let the in-flight trigger complete cleanly.
    resolveFn();
    await vi.runAllTimersAsync();
    await p1;

    // After completion a subsequent trigger is allowed again.
    console.info(`[async-action:bugfix-re-click] post-completion trigger should be allowed again`);
    const p4 = action.trigger();
    if (fn.mock.calls.length !== 2)
      dumpAsyncActionSnapshot("bugfix-re-click-post-completion-trigger", { fn, sideEffects });
    expect(fn).toHaveBeenCalledTimes(2);
    // Resolve the second in-flight call so the test exits cleanly.
    resolveFn();
    await vi.runAllTimersAsync();
    await p4;
  });
});
