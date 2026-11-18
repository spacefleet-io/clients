/**
 * @test-id OPTIMISTIC-FAILURE-BURST-001
 * @bugfix
 * @regression-proof
 * @level unit
 * @issue #25 (ultimate stress run, finding P5)
 * @why A runtime restart fails every library write in flight at once. In c015
 *      the renderer logged 247 "optimistic write failed; reverted UI" in 3 s
 *      (436-506 in c041/c060/c062), each one rolling the library state back
 *      (a full re-render) and raising its own error toast. Every one of the
 *      four multi-minute renderer CPU spins (101-123 % for 2.5-9 min) started
 *      with such a burst. The failure path must cost one rollback per field and
 *      one toast per burst, and must never revert a newer optimistic value.
 * @covers apps/badger/desktop/src/renderer/src/lib/optimisticWriteFailures.ts,
 *         apps/badger/desktop/src/renderer/src/lib/libraryContext.tsx (runOptimisticWrite wiring)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createOptimisticWriteTracker,
  OPTIMISTIC_FAILURE_TOAST_WINDOW_MS,
} from "../src/renderer/src/lib/optimisticWriteFailures";

const TAG = "[optimistic-failure-burst]";
const MESSAGE = "Couldn't save playback progress — change reverted";

const createHarness = () => {
  let clock = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const toasts: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const tracker = createOptimisticWriteTracker({
    notifyError: (message) => toasts.push(message),
    log: (fields) => logs.push(fields),
    now: () => clock,
    setTimer: (fn, ms) => timers.push({ at: clock + ms, fn }),
  });
  /** Deterministic clock: run every timer due by `clock + ms`. */
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((t) => t.at <= clock)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.fn();
    }
  };
  const dump = (label: string) =>
    console.error(`${TAG}[${label}] toasts=${toasts.length} logs(last 5)=${JSON.stringify(logs.slice(-5))} pendingTimers=${timers.length}`);
  return { tracker, toasts, logs, advance, dump };
};

describe("[@bugfix][@regression-proof] optimistic write failure burst (#25 P5)", () => {
  it("247 failed progress writes for one episode: one rollback (the newest write), one toast", () => {
    const h = createHarness();
    const rollbacks: number[] = [];
    // The burst: 247 writes issued in order, all fail when the runtime dies.
    const tickets = Array.from({ length: 247 }, () => h.tracker.begin("progress:episode:e1"));
    tickets.forEach((ticket, index) => {
      h.tracker.failed(ticket, () => rollbacks.push(index), MESSAGE, new TypeError("fetch failed"));
    });
    console.info(`${TAG} burst: rollbacks=${JSON.stringify(rollbacks)} toasts=${h.toasts.length}`);
    try {
      expect(rollbacks).toEqual([246]);
      expect(h.toasts).toEqual([MESSAGE]);
      expect(h.logs.filter((l) => l.event === "optimistic_write_failed")).toHaveLength(247);
    } catch (err) {
      h.dump("burst");
      throw err;
    }
  });

  it("an older write failing after a newer one never reverts the newer value", () => {
    const h = createHarness();
    const older = h.tracker.begin("default-audio:m1:");
    const newer = h.tracker.begin("default-audio:m1:");
    const olderRollback = vi.fn();
    h.tracker.succeeded(newer);
    h.tracker.failed(older, olderRollback, "Couldn't update default audio — change reverted", new Error("boom"));
    expect(olderRollback).not.toHaveBeenCalled();
  });

  it("different fields roll back independently; unkeyed writes always roll back", () => {
    const h = createHarness();
    const a = h.tracker.begin("progress:episode:e1");
    const b = h.tracker.begin("progress:episode:e2");
    const c = h.tracker.begin(null);
    const calls: string[] = [];
    h.tracker.failed(a, () => calls.push("a"), MESSAGE, new Error("x"));
    h.tracker.failed(b, () => calls.push("b"), MESSAGE, new Error("x"));
    h.tracker.failed(c, () => calls.push("c"), MESSAGE, new Error("x"));
    expect(calls).toEqual(["a", "b", "c"]);
    expect(h.toasts).toHaveLength(1);
  });

  it("toasts again after the coalescing window and logs one summary for the suppressed ones", () => {
    const h = createHarness();
    for (let i = 0; i < 5; i += 1) h.tracker.failed(h.tracker.begin(null), () => {}, MESSAGE, new Error("x"));
    h.advance(OPTIMISTIC_FAILURE_TOAST_WINDOW_MS);
    const summary = h.logs.find((l) => l.event === "optimistic_write_failures_coalesced");
    console.info(`${TAG} window summary=${JSON.stringify(summary)}`);
    expect(summary).toMatchObject({ suppressedToasts: 4, message: MESSAGE });
    h.tracker.failed(h.tracker.begin(null), () => {}, MESSAGE, new Error("x"));
    expect(h.toasts).toHaveLength(2);
  });

  it("distinct messages each get their own toast", () => {
    const h = createHarness();
    h.tracker.failed(h.tracker.begin(null), () => {}, MESSAGE, new Error("x"));
    h.tracker.failed(h.tracker.begin(null), () => {}, "Couldn't save audio track — change reverted", new Error("x"));
    expect(h.toasts).toHaveLength(2);
  });

  // No RTL harness mounts LibraryProvider (see library-context-errors.test.ts),
  // so the wiring is pinned at the source level: runOptimisticWrite must route
  // failures through the tracker and must not toast per failure itself.
  it("LibraryProvider's runOptimisticWrite routes every failure through the tracker", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/renderer/src/lib/libraryContext.tsx", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("const runOptimisticWrite = useCallback(");
    const body = source.slice(start, source.indexOf("\n  );", start));
    console.info(`${TAG} runOptimisticWrite body:\n${body}`);
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("optimisticWrites.failed(ticket, rollback, revertErrorMessage, err)");
    expect(body).not.toContain("notifyError(");
    expect(body).not.toMatch(/\brollback\(\)/);
    // Every caller passes a field key so a burst collapses to one rollback.
    const callers = source.match(/runOptimisticWrite\(\n\s+[^\n]+/g) ?? [];
    console.info(`${TAG} callers=${JSON.stringify(callers)}`);
    expect(callers.length).toBeGreaterThanOrEqual(7);
    for (const caller of callers) expect(caller).toMatch(/runOptimisticWrite\(\n\s+(`|episodeId \? `)/);
  });
});
