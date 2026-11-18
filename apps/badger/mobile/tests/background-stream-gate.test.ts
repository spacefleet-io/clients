/**
 * @test-id MOBILE-BACKGROUND-STREAM-GATE-001
 * @level unit
 *
 * Why this exists: the live library change stream stayed open while the app sat in the background, holding a
 * connection and waking the JS thread for every heartbeat (#957). It now closes on background and reopens on return.
 */
import { describe, expect, it } from "vitest";
import { createBackgroundStreamGate } from "../src/lib/backgroundStreamGate";
import type { AppStateLike } from "../src/lib/foregroundSync";

const track = (initial: AppStateLike) => {
  const calls: string[] = [];
  const gate = createBackgroundStreamGate(initial, { open: () => calls.push("open"), close: () => calls.push("close") });
  return { gate, calls };
};

describe("background stream gate", () => {
  /** @req PERF-MOBILE-04[badger-mobile,badger-tv] */
  it("@regression-proof closes the stream on background and reopens it on return (#957)", () => {
    const { gate, calls } = track("active");
    expect(calls).toEqual(["open"]);
    gate.observe("background");
    expect(gate.isOpen()).toBe(false);
    gate.observe("active");
    expect(calls).toEqual(["open", "close", "open"]);
    expect(gate.isOpen()).toBe(true);
  });

  /** @req PERF-MOBILE-04[badger-mobile,badger-tv] */
  it("does not open a stream for an app that starts in the background", () => {
    const { gate, calls } = track("background");
    expect(calls).toEqual([]);
    gate.observe("active");
    expect(calls).toEqual(["open"]);
  });

  it("ignores transient and repeated states", () => {
    const { gate, calls } = track("unknown");
    gate.observe("inactive");
    gate.observe("active");
    gate.observe("unknown");
    gate.observe("background");
    gate.observe("background");
    gate.observe("inactive");
    expect(calls).toEqual(["open", "close"]);
  });
});
