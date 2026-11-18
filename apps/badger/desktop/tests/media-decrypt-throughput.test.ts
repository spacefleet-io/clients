// @bugfix @regression-proof issue #25 P12 — "#126 decrypt ~3.5x slower per
// MiB". Bucketing the ultimate run's `object.payload.fetched` logs by object
// size shows the cause: large (~5.5 MiB video) objects decrypt at the same
// ~5–6 ms/MiB as the old synchronous path, but SMALL objects (~0.2 MiB audio /
// low-tier video, the majority of fetches) went from p50 0–1 ms to 5–6 ms.
// A seek fans out to big and small keys at once; the ≤2-worker pool spread
// them by queue length only, so a small object waited behind a multi-MB GCM
// pass on the same worker (head-of-line blocking).
//
// The fix keeps every decrypt off the main loop and gives small objects their
// own worker lane, so they never queue behind a large decrypt.
//
// Red-first assertion (load-robust ordering, not a wall-clock budget): with
// the pool busy on large objects, a small object submitted right after must
// resolve before the first large one. Pre-fix it queued behind one (POOL_SIZE
// ≤ 2) and never did. Best-of-TRIALS, like media-decrypt-event-loop.test.ts,
// so a one-off scheduler stall on a shared CI runner cannot fail it alone; a
// structural queue fails every trial.
//
// Also measured and logged on every run: large-object MiB/s, isolated small
// latency, small latency under the fan-out, and the main event-loop delay
// during the fan-out (kept under the same 20 ms budget as the #126 test).
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptMediaObject, deriveMediaMasterKey, encryptMediaObject, setMediaMasterKey } from "../src/main/mediaCrypto";

const TAG = "[media-decrypt-throughput]";
const LARGE_BYTES = 8 * 1024 * 1024;
const SMALL_BYTES = 200 * 1024;
const LARGE_IN_FLIGHT = 2;
const TRIALS = 5;
const MAX_LOOP_DELAY_MS = 20;
const MIB = 1024 * 1024;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

describe("media decrypt: small objects never queue behind large ones (@bugfix @regression-proof issue #25 P12)", () => {
  let large: Buffer;
  let small: Buffer;

  beforeAll(async () => {
    setMediaMasterKey(deriveMediaMasterKey(crypto.randomBytes(32)));
    large = encryptMediaObject(crypto.randomBytes(LARGE_BYTES), 32 * 1024);
    small = encryptMediaObject(crypto.randomBytes(SMALL_BYTES), 4 * 1024);
    // Warm the workers so thread start-up is not measured.
    await Promise.all([
      decryptMediaObject(Buffer.from(large)),
      decryptMediaObject(Buffer.from(large)),
      decryptMediaObject(Buffer.from(small)),
    ]);
  });

  afterAll(() => {
    setMediaMasterKey(null);
  });

  it("reports large-object throughput and isolated small-object latency", async () => {
    const largeMs: number[] = [];
    const smallMs: number[] = [];
    for (let i = 0; i < TRIALS; i += 1) {
      const largeInput = Buffer.from(large);
      let t = performance.now();
      await decryptMediaObject(largeInput);
      largeMs.push(performance.now() - t);
      const smallInput = Buffer.from(small);
      t = performance.now();
      await decryptMediaObject(smallInput);
      smallMs.push(performance.now() - t);
    }
    const largeMiBps = LARGE_BYTES / MIB / (median(largeMs) / 1000);
    console.info(
      `${TAG} isolated: large ${(LARGE_BYTES / MIB).toFixed(1)} MiB p50 ${median(largeMs).toFixed(2)} ms ` +
        `(${largeMiBps.toFixed(0)} MiB/s, ${(median(largeMs) / (LARGE_BYTES / MIB)).toFixed(2)} ms/MiB); ` +
        `small ${(SMALL_BYTES / 1024).toFixed(0)} KiB p50 ${median(smallMs).toFixed(2)} ms ` +
        `(${(median(smallMs) / (SMALL_BYTES / MIB)).toFixed(2)} ms/MiB); trials large [${largeMs.map((v) => v.toFixed(1)).join(", ")}] small [${smallMs.map((v) => v.toFixed(2)).join(", ")}]`,
    );
    expect(largeMs).toHaveLength(TRIALS);
  });

  it("a small object submitted while large ones are decrypting resolves first", async () => {
    type Trial = { smallMs: number; firstLargeMs: number; loopDelayMs: number; smallFirst: boolean };
    const trials: Trial[] = [];
    for (let i = 0; i < TRIALS; i += 1) {
      const largeInputs = Array.from({ length: LARGE_IN_FLIGHT }, () => Buffer.from(large));
      const smallInput = Buffer.from(small);
      const histogram = monitorEventLoopDelay({ resolution: 1 });
      histogram.enable();
      await sleep(5);
      const t0 = performance.now();
      const largeDone = largeInputs.map((input) => decryptMediaObject(input).then(() => performance.now() - t0));
      const smallDone = decryptMediaObject(smallInput).then(() => performance.now() - t0);
      const [smallMs, ...largeMsList] = await Promise.all([smallDone, ...largeDone]);
      await sleep(5);
      histogram.disable();
      const firstLargeMs = Math.min(...largeMsList);
      trials.push({ smallMs, firstLargeMs, loopDelayMs: histogram.max / 1e6, smallFirst: smallMs < firstLargeMs });
    }
    console.info(
      `${TAG} fan-out ${LARGE_IN_FLIGHT}×${(LARGE_BYTES / MIB).toFixed(0)} MiB + 1×${(SMALL_BYTES / 1024).toFixed(0)} KiB: ` +
        trials
          .map(
            (trial, index) =>
              `#${index} small ${trial.smallMs.toFixed(2)} ms vs first large ${trial.firstLargeMs.toFixed(2)} ms ` +
              `(smallFirst=${trial.smallFirst}) loop max ${trial.loopDelayMs.toFixed(1)} ms`,
          )
          .join("; ") +
        ` | small p50 ${median(trials.map((trial) => trial.smallMs)).toFixed(2)} ms`,
    );
    expect(
      trials.some((trial) => trial.smallFirst),
      "small object must not wait for a large decrypt in at least one trial",
    ).toBe(true);
    expect(Math.min(...trials.map((trial) => trial.loopDelayMs))).toBeLessThanOrEqual(MAX_LOOP_DELAY_MS);
  }, 60_000);
});
