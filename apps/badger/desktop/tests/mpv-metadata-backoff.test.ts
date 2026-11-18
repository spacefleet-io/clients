/**
 * Unit pinning for the `sendMetadataWithBackoff` helper extracted in Phase 2b
 * of the playback-engine hardening plan. The helper collapsed three
 * duplicated inline retry loops in `useMpvPlaybackEngine.ts` into one pure
 * function; the duplication had let the loops drift subtly across paste-jobs
 * (different local variable names, slightly different break-condition
 * ordering), so this file pins the shared semantics so future drift can't
 * silently land.
 *
 * Loop semantics under test (must match what the legacy inline loops did
 * byte-for-byte):
 *   1. With default delays `[0, 100, 300]` and a `send()` that NEVER fails,
 *      exactly ONE call lands at t=0. The retry budget is unused.
 *   2. With one failing call followed by a success, the second call lands
 *      after a 100 ms sleep (the delays[1] backoff). No third call happens.
 *   3. With two failing calls followed by a success, the third call lands
 *      after an additional 300 ms (delays[1] + delays[2] = 400 ms total).
 *   4. With ALL three calls failing (failed > 0 each), the helper exhausts
 *      the schedule and returns the third (last) result.
 *   5. As soon as ANY call returns `socketMissing: true`, the helper STOPS
 *      retrying — mpv tore down and per-command warnings are useless noise.
 *   6. Explicit empty-delays guard is NOT covered (programmer error at the
 *      call site; documented in the helper file).
 *
 * Tests log generously per project convention: each attempt logs its
 * index + result so a failed assertion
 * surfaces the full timeline without a debugger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type MetadataBackoffResult,
  sendMetadataWithBackoff,
} from "../src/renderer/src/lib/mpvMetadataBackoff";

const OK: MetadataBackoffResult = { sent: 4, failed: 0, socketMissing: false };
const PARTIAL_FAIL: MetadataBackoffResult = { sent: 2, failed: 2, socketMissing: false };
const SOCKET_GONE: MetadataBackoffResult = { sent: 0, failed: 4, socketMissing: true };

describe("sendMetadataWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the first send IMMEDIATELY (no initial delay) and breaks on failed === 0", async () => {
    const send = vi.fn<() => Promise<MetadataBackoffResult>>().mockResolvedValue(OK);

    const promise = sendMetadataWithBackoff(send);
    // Resolve the awaited send() microtask without advancing fake-timer
    // clock — the first iteration's delays[0] = 0 path must NOT depend on
    // any timer firing. (delays[0] > 0 is false → no setTimeout posted.)
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    console.info("[backoff-test:immediate] call-count=%d result=%o", send.mock.calls.length, result);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toBe(OK);
  });

  it("retries with the 100 ms backoff on first failure, then breaks on success at attempt #2", async () => {
    const send = vi.fn<() => Promise<MetadataBackoffResult>>()
      .mockResolvedValueOnce(PARTIAL_FAIL)
      .mockResolvedValueOnce(OK);

    const promise = sendMetadataWithBackoff(send);

    // Attempt 0 fires immediately (delays[0] = 0 → no real wait). Flush the
    // microtask the first send() awaits on.
    await vi.advanceTimersByTimeAsync(0);
    console.info("[backoff-test:retry-100] after t=0 calls=%d", send.mock.calls.length);
    expect(send).toHaveBeenCalledTimes(1);

    // At this point the helper is parked inside `await new Promise(setTimeout(100))`.
    // Advance LESS than 100 ms — the second send must NOT have fired yet.
    await vi.advanceTimersByTimeAsync(99);
    console.info("[backoff-test:retry-100] after t=99 calls=%d (must still be 1)", send.mock.calls.length);
    expect(send, "second attempt fired too early — backoff schedule broken").toHaveBeenCalledTimes(1);

    // Cross the 100 ms threshold — the 100 ms backoff resolves and attempt
    // #2 fires.
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    console.info("[backoff-test:retry-100] final calls=%d result=%o", send.mock.calls.length, result);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toBe(OK);
  });

  it("retries through the FULL 100 ms then 300 ms schedule when failures persist, lands attempt #3 at +400 ms", async () => {
    const send = vi.fn<() => Promise<MetadataBackoffResult>>()
      .mockResolvedValueOnce(PARTIAL_FAIL)
      .mockResolvedValueOnce(PARTIAL_FAIL)
      .mockResolvedValueOnce(OK);

    const promise = sendMetadataWithBackoff(send);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    // First retry: 100 ms backoff.
    await vi.advanceTimersByTimeAsync(100);
    console.info("[backoff-test:full-schedule] after t=+100 calls=%d", send.mock.calls.length);
    expect(send).toHaveBeenCalledTimes(2);

    // Second retry: 300 ms backoff. Verify the half-way point doesn't
    // accidentally trigger an early send (would indicate the second-retry
    // delay collapsed to 100 ms — the duplication bug this file guards).
    await vi.advanceTimersByTimeAsync(150);
    console.info("[backoff-test:full-schedule] after t=+250 calls=%d (must still be 2)", send.mock.calls.length);
    expect(send, "third attempt fired before the 300 ms backoff elapsed").toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    console.info("[backoff-test:full-schedule] final calls=%d result=%o", send.mock.calls.length, result);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result).toBe(OK);
  });

  it("returns the LAST result when the entire schedule exhausts with failures", async () => {
    const send = vi.fn<() => Promise<MetadataBackoffResult>>().mockResolvedValue(PARTIAL_FAIL);

    const promise = sendMetadataWithBackoff(send);
    await vi.advanceTimersByTimeAsync(0);   // attempt 0
    await vi.advanceTimersByTimeAsync(100); // attempt 1
    await vi.advanceTimersByTimeAsync(300); // attempt 2
    const result = await promise;

    console.info("[backoff-test:exhaust] calls=%d result=%o", send.mock.calls.length, result);
    expect(send).toHaveBeenCalledTimes(3);
    // Helper must return the LAST observed result on exhaustion — not null,
    // not undefined, not a re-aggregated total.
    expect(result).toEqual(PARTIAL_FAIL);
  });

  it("STOPS retrying as soon as socketMissing flips true (no point sending more — socket is gone)", async () => {
    // Bug class: pre-extraction, all three inline loops correctly bailed on
    // socketMissing — but the duplication meant the check could drift on
    // one path without anyone noticing. This pins the shared semantics.
    const send = vi.fn<() => Promise<MetadataBackoffResult>>()
      .mockResolvedValueOnce(PARTIAL_FAIL)
      .mockResolvedValueOnce(SOCKET_GONE)
      // This third response must NEVER be observed — helper bails at #2.
      .mockResolvedValueOnce(OK);

    const promise = sendMetadataWithBackoff(send);
    await vi.advanceTimersByTimeAsync(0);   // attempt 0 — PARTIAL_FAIL, no socketMissing → retry scheduled
    await vi.advanceTimersByTimeAsync(100); // attempt 1 — SOCKET_GONE → bail
    // No more timers should be pending — let the promise settle.
    const result = await promise;

    console.info("[backoff-test:socket-bail] calls=%d result=%o", send.mock.calls.length, result);
    expect(send, "helper kept retrying after socketMissing — wasted commands during tear-down").toHaveBeenCalledTimes(2);
    expect(result).toBe(SOCKET_GONE);
  });

  it("respects a CUSTOM delays array (signature contract — options.delays override)", async () => {
    // Sanity check the override path even though all three call sites
    // currently use the default. Lets future call sites tune without
    // touching the helper.
    const send = vi.fn<() => Promise<MetadataBackoffResult>>()
      .mockResolvedValueOnce(PARTIAL_FAIL)
      .mockResolvedValueOnce(OK);

    const promise = sendMetadataWithBackoff(send, { delays: [0, 50] });

    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    // Crossing 50 ms (not 100) must trigger the retry.
    await vi.advanceTimersByTimeAsync(49);
    expect(send, "custom delay ignored — helper used the default schedule").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    console.info("[backoff-test:custom-delays] calls=%d result=%o", send.mock.calls.length, result);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toBe(OK);
  });
});
