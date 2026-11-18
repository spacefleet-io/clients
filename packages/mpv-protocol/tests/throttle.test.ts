/**
 * Unit tests for {@link createTrailingThrottle}. Used by `MpvClient.observe`
 * implementations to throttle high-rate properties like `time-pos`.
 *
 * Tier-4 of the @space/mpv-protocol consolidation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrailingThrottle } from "../src/client";

// Per-suite dump helper: console.error's the throttle delivery sequence
// (received) against what was expected, plus a virtual clock marker, so a
// timing-window failure is diagnosable from CI logs. Body wrapped in try/catch
// so a dump failure can't mask the real assertion.
const dumpThrottle = (label: string, received: readonly number[], expected: readonly number[]): void => {
  try {
    console.error(`=== [throttle:${label}] delivery snapshot ===`);
    console.error(`received: ${JSON.stringify(received)}`);
    console.error(`expected: ${JSON.stringify(expected)}`);
    console.error(`virtual now=${Date.now()} timerCount=${vi.getTimerCount()}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Assert `received` equals `expected`, dumping the delivery sequence on failure.
const expectReceived = (label: string, received: readonly number[], expected: readonly number[]): void => {
  try {
    expect(received).toEqual(expected);
  } catch (err) {
    dumpThrottle(label, received, expected);
    throw err;
  }
};

describe("createTrailingThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the leading-edge value immediately", () => {
    const received: number[] = [];
    const throttle = createTrailingThrottle<number>((v) => received.push(v), 250);
    throttle.next(1);
    expect(received).toEqual([1]);
  });

  it("delivers the trailing value once the window closes", () => {
    console.info(`[throttle:trailing] window=250ms leading=1 then pending 2,3,4`);
    const received: number[] = [];
    const throttle = createTrailingThrottle<number>((v) => received.push(v), 250);
    throttle.next(1); // leading-edge: immediate
    expectReceived("trailing-after-leading", received, [1]);
    throttle.next(2); // suppressed: held as pending
    throttle.next(3); // updates the pending value
    throttle.next(4); // updates the pending value
    expectReceived("trailing-pending-suppressed", received, [1]);
    vi.advanceTimersByTime(250);
    // Trailing flush delivers the latest queued value (4), not (2) or (3).
    expectReceived("trailing-flushed", received, [1, 4]);
  });

  it("delivers across multiple windows in sequence", () => {
    console.info(`[throttle:multi-window] window=100ms across two windows`);
    const received: number[] = [];
    const throttle = createTrailingThrottle<number>((v) => received.push(v), 100);
    // Window 1: leading=1, trailing=2 fires after 100ms
    throttle.next(1);
    throttle.next(2);
    vi.advanceTimersByTime(100);
    expectReceived("multi-window-1", received, [1, 2]);
    // Advance past the previous window so the next call is a leading-edge.
    vi.advanceTimersByTime(150);
    // Window 2: leading=3 fires immediately, trailing=5 fires after 100ms
    throttle.next(3);
    throttle.next(4);
    throttle.next(5);
    expectReceived("multi-window-2-leading", received, [1, 2, 3]);
    vi.advanceTimersByTime(100);
    expectReceived("multi-window-2-trailing", received, [1, 2, 3, 5]);
  });

  it("returns a pass-through when windowMs <= 0", () => {
    const received: number[] = [];
    const throttle = createTrailingThrottle<number>((v) => received.push(v), 0);
    throttle.next(1);
    throttle.next(2);
    throttle.next(3);
    expect(received).toEqual([1, 2, 3]);
  });

  it("flush() delivers any pending value synchronously", () => {
    const received: number[] = [];
    const throttle = createTrailingThrottle<number>((v) => received.push(v), 250);
    throttle.next(1);
    throttle.next(2);
    expect(received).toEqual([1]);
    throttle.flush();
    expect(received).toEqual([1, 2]);
  });

  it("flush() is a no-op when there is no pending value", () => {
    const received: number[] = [];
    const throttle = createTrailingThrottle<number>((v) => received.push(v), 250);
    throttle.flush();
    expect(received).toEqual([]);
    throttle.next(1);
    expect(received).toEqual([1]);
    throttle.flush();
    // No additional pending value to flush.
    expect(received).toEqual([1]);
  });

  it("cancel() drops the pending value without delivering", () => {
    const received: number[] = [];
    const throttle = createTrailingThrottle<number>((v) => received.push(v), 250);
    throttle.next(1);
    throttle.next(2);
    throttle.cancel();
    vi.advanceTimersByTime(500);
    // Cancel after the leading edge: pending (2) is dropped.
    expect(received).toEqual([1]);
  });

  it("respects a custom setTimeout/clearTimeout pair", () => {
    const received: number[] = [];
    const calls: Array<{ kind: "set" | "clear"; delay?: number }> = [];
    const handles = new Map<number, ReturnType<typeof setTimeout>>();
    let id = 1;
    const setTimeoutFn = (cb: () => void, ms: number) => {
      const handle = setTimeout(cb, ms) as unknown as ReturnType<typeof setTimeout>;
      handles.set(id, handle);
      calls.push({ kind: "set", delay: ms });
      id += 1;
      return handle;
    };
    const clearTimeoutFn = (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
      calls.push({ kind: "clear" });
    };
    const throttle = createTrailingThrottle<number>(
      (v) => received.push(v),
      250,
      { setTimeoutFn, clearTimeoutFn },
    );
    console.info(`[throttle:custom-timers] window=250ms with injected setTimeout/clearTimeout`);
    throttle.next(1);
    throttle.next(2);
    try {
      expect(calls.some((c) => c.kind === "set" && c.delay === 250)).toBe(true);
    } catch (err) {
      console.error(`=== [throttle:custom-timers] timer-calls snapshot ===`);
      console.error(`calls: ${JSON.stringify(calls)}`);
      throw err;
    }
    vi.advanceTimersByTime(250);
    expectReceived("custom-timers", received, [1, 2]);
  });
});
