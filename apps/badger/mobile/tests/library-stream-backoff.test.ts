/**
 * @test-id MOBILE-LIB-STREAM-BACKOFF-001
 * @level unit
 * @why Phase 7 replaces the fixed 5s SSE reconnect delay
 *   (`library.tsx` — old `setTimeout(connect, 5000)`) with exponential
 *   backoff (1s → 2s → 4s → 8s → 16s → 30s cap), reset on the next successful
 *   `library.stream.open`. This pins the math so a regression to a constant
 *   delay or to a wrong cap fails loudly.
 * @regression-proof
 *   Pre-fix: a flaky network meant unbounded reconnect storms hammering the
 *   API every 5s. Post-fix: the first failure waits 1s, the second 2s, …,
 *   capped at 30s — and a single successful open resets back to 1s.
 */
import { describe, expect, it } from "vitest";
import { computeStreamBackoff } from "../src/lib/streamBackoff";

// Dump-on-failure: print the full computed backoff curve (attempts 0..N) so a
// failing delay assertion shows the whole schedule, not just the one bad value.
// try/catch so a dump failure can't mask the real assertion.
const dumpBackoffSchedule = (label: string, maxAttempt: number) => {
  try {
    const schedule: Array<{ attempt: number; ms: number }> = [];
    for (let a = 0; a <= maxAttempt; a++) {
      schedule.push({ attempt: a, ms: computeStreamBackoff(a) });
    }
    console.error(`=== [library-stream-backoff:${label}] schedule ===`);
    console.error(`computeStreamBackoff(0..${maxAttempt}):\n${JSON.stringify(schedule)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("computeStreamBackoff — schedule", () => {
  it("attempt 0 → 1s", () => {
    expect(computeStreamBackoff(0)).toBe(1_000);
  });

  it("attempt 1 → 2s", () => {
    expect(computeStreamBackoff(1)).toBe(2_000);
  });

  it("attempt 2 → 4s", () => {
    expect(computeStreamBackoff(2)).toBe(4_000);
  });

  it("attempt 3 → 8s", () => {
    expect(computeStreamBackoff(3)).toBe(8_000);
  });

  it("attempt 4 → 16s", () => {
    expect(computeStreamBackoff(4)).toBe(16_000);
  });

  it("attempt 5 → 30s (cap kicks in below natural 32s)", () => {
    expect(computeStreamBackoff(5)).toBe(30_000);
  });

  it("attempt 10 → 30s (cap holds)", () => {
    expect(computeStreamBackoff(10)).toBe(30_000);
  });

  it("attempt 100 → 30s (cap holds at extremes)", () => {
    expect(computeStreamBackoff(100)).toBe(30_000);
  });

  it("negative attempts collapse to base 1s (defensive)", () => {
    expect(computeStreamBackoff(-1)).toBe(1_000);
    expect(computeStreamBackoff(-99)).toBe(1_000);
  });
});

describe("backoff scheduler — successive failures escalate, success resets", () => {
  it("five successive failures produce monotonically increasing delays", () => {
    console.info(`[library-stream-backoff:escalate] simulating 5 successive failures`);
    const delays: number[] = [];
    let attempts = 0;
    for (let i = 0; i < 5; i++) {
      const d = computeStreamBackoff(attempts);
      console.info(`[library-stream-backoff:escalate] failure #${i} attempts=${attempts} delay=${d}ms`);
      delays.push(d);
      attempts += 1;
    }
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000];
    if (JSON.stringify(delays) !== JSON.stringify(expected)) {
      console.error(`[library-stream-backoff:escalate] delays=${JSON.stringify(delays)} expected=${JSON.stringify(expected)}`);
      dumpBackoffSchedule("escalate", 6);
    }
    expect(delays).toEqual(expected);
  });

  it("a successful open resets attempts to 0 → next failure waits 1s", () => {
    console.info(`[library-stream-backoff:reset] simulating 4 failures then a successful open`);
    let attempts = 0;
    // simulate 4 failures
    for (let i = 0; i < 4; i++) attempts += 1;
    const afterFailures = computeStreamBackoff(attempts);
    console.info(`[library-stream-backoff:reset] after 4 failures attempts=${attempts} delay=${afterFailures}ms (expected 16000)`);
    if (afterFailures !== 16_000) dumpBackoffSchedule("reset-pre", attempts);
    expect(afterFailures).toBe(16_000);

    // simulate stream.open → reset
    attempts = 0;
    const afterReset = computeStreamBackoff(attempts);
    console.info(`[library-stream-backoff:reset] after stream.open reset attempts=${attempts} delay=${afterReset}ms (expected 1000)`);
    if (afterReset !== 1_000) dumpBackoffSchedule("reset-post", 2);
    expect(afterReset).toBe(1_000);
  });

  it("never exceeds the 30s cap once attempts > log2(30)", () => {
    console.info(`[library-stream-backoff:cap] verifying cap holds for attempts 5..19`);
    // log2(30) ≈ 4.9 — so attempt 5 should already be capped
    for (let attempts = 5; attempts < 20; attempts++) {
      const d = computeStreamBackoff(attempts);
      if (d !== 30_000) {
        console.error(`[library-stream-backoff:cap] attempts=${attempts} delay=${d}ms broke 30000 cap`);
        dumpBackoffSchedule("cap", 20);
      }
      expect(d).toBe(30_000);
    }
  });
});
