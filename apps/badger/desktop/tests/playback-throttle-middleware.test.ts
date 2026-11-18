import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { createPlaybackThrottle, installPlaybackThrottleControl } from "../src/main/playbackThrottle";

// =========================================================================
// Diagnostic logging helpers — per "Tests log generously" rule.
// =========================================================================

const SUITE = "playback-throttle-middleware";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpPlaybackThrottleSnapshot = (
  label: string,
  ctx: {
    envValue?: string | undefined;
    isActive?: boolean;
    bytesPerSecond?: number;
    bytesWritten?: number;
    writesCount?: number;
    writesSliceLengths?: number[];
    burstBytes?: number;
    chunkBytes?: number;
    expectedBytes?: number;
    elapsedMs?: number;
    expectedMs?: number;
    lowerBound?: number;
    upperBound?: number;
    onPaceCalls?: number;
    onPaceArgs?: unknown[];
    ended?: boolean;
    destroyed?: boolean;
    writableEnded?: boolean;
    autoDrain?: boolean;
    writeResult?: boolean;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] playback-throttle-middleware snapshot ===`);
    if (ctx.envValue !== undefined) console.error(`envValue: ${JSON.stringify(ctx.envValue)}`);
    if (ctx.isActive !== undefined) console.error(`isActive: ${ctx.isActive}`);
    if (ctx.bytesPerSecond !== undefined) console.error(`bytesPerSecond: ${ctx.bytesPerSecond}`);
    if (ctx.bytesWritten !== undefined) console.error(`bytesWritten: ${ctx.bytesWritten}`);
    if (ctx.writesCount !== undefined) console.error(`writesCount: ${ctx.writesCount}`);
    if (ctx.writesSliceLengths !== undefined) {
      console.error(`writesSliceLengths:\n${JSON.stringify(ctx.writesSliceLengths, jsonReplacer, 2)}`);
    }
    if (ctx.burstBytes !== undefined) console.error(`burstBytes: ${ctx.burstBytes}`);
    if (ctx.chunkBytes !== undefined) console.error(`chunkBytes: ${ctx.chunkBytes}`);
    if (ctx.expectedBytes !== undefined) console.error(`expectedBytes: ${ctx.expectedBytes}`);
    if (ctx.elapsedMs !== undefined) console.error(`elapsedMs: ${ctx.elapsedMs}`);
    if (ctx.expectedMs !== undefined) console.error(`expectedMs: ${ctx.expectedMs}`);
    if (ctx.lowerBound !== undefined) console.error(`lowerBound: ${ctx.lowerBound}`);
    if (ctx.upperBound !== undefined) console.error(`upperBound: ${ctx.upperBound}`);
    if (ctx.onPaceCalls !== undefined) console.error(`onPaceCalls: ${ctx.onPaceCalls}`);
    if (ctx.onPaceArgs !== undefined) {
      console.error(`onPaceArgs:\n${JSON.stringify(ctx.onPaceArgs, jsonReplacer, 2)}`);
    }
    if (ctx.ended !== undefined) console.error(`ended: ${ctx.ended}`);
    if (ctx.destroyed !== undefined) console.error(`destroyed: ${ctx.destroyed}`);
    if (ctx.writableEnded !== undefined) console.error(`writableEnded: ${ctx.writableEnded}`);
    if (ctx.autoDrain !== undefined) console.error(`autoDrain: ${ctx.autoDrain}`);
    if (ctx.writeResult !== undefined) console.error(`writeResult: ${ctx.writeResult}`);
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Minimal writable-stream shim. We can't use a real `http.ServerResponse`
// here — it needs an attached socket — and we want surgical control over
// when 'drain' fires for backpressure tests. EventEmitter gives us the
// emit/once surface the throttle relies on; the explicit `writes` array
// makes assertions over delivered chunks straightforward.
class FakeWritable extends EventEmitter {
  public writes: Buffer[] = [];
  public ended = false;
  public destroyed = false;
  public writable = true;
  public writableEnded = false;
  // When set to false, write() returns false (signaling backpressure) and we
  // do NOT auto-drain. The test must call `releaseDrain()` to emit 'drain'.
  public autoDrain = true;
  private blocked = false;

  write(
    chunk: Buffer | string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean {
    const callback =
      typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8")
        : Buffer.from(chunk);
    this.writes.push(buf);
    if (callback) callback();
    if (!this.autoDrain && this.blocked) return false;
    return true;
  }

  end(
    chunkOrCallback?: Buffer | string | Uint8Array | (() => void),
    encodingOrCallback?: BufferEncoding | (() => void),
    maybeCallback?: () => void,
  ): this {
    let cb: (() => void) | undefined;
    if (typeof chunkOrCallback === "function") {
      cb = chunkOrCallback;
    } else if (chunkOrCallback !== undefined) {
      this.write(
        chunkOrCallback as Buffer | string | Uint8Array,
        typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
      );
      if (typeof encodingOrCallback === "function") {
        cb = encodingOrCallback;
      } else {
        cb = maybeCallback;
      }
    }
    this.ended = true;
    this.writableEnded = true;
    if (cb) cb();
    return this;
  }

  destroy(_error?: Error): void {
    this.destroyed = true;
    this.writable = false;
  }

  totalBytes(): number {
    return this.writes.reduce((sum, buf) => sum + buf.length, 0);
  }

  // Helper for backpressure scenario: from now on, write() returns false
  // and the throttle should wait for an explicit 'drain' event.
  block() {
    this.autoDrain = false;
    this.blocked = true;
  }

  releaseDrain() {
    this.blocked = false;
    this.emit("drain");
  }
}

describe("createPlaybackThrottle", () => {
  describe("inactive states", () => {
    it("is inactive when env var is undefined", () => {
      const label = "inactive-undefined";
      console.info(`[${SUITE}:${label}] creating throttle with envValue=undefined`);
      const throttle = createPlaybackThrottle(undefined);
      const active = throttle.isActive();
      const bps = throttle.bytesPerSecond();
      console.info(`[${SUITE}:${label}] isActive=${active} bytesPerSecond=${bps}`);
      try {
        expect(active).toBe(false);
        expect(bps).toBe(0);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: undefined,
          isActive: active,
          bytesPerSecond: bps,
          expected: { isActive: false, bytesPerSecond: 0 },
          actual: { isActive: active, bytesPerSecond: bps },
          error: err,
        });
        throw err;
      }
    });

    it("is inactive when env var is an empty string", () => {
      const label = "inactive-empty-string";
      console.info(`[${SUITE}:${label}] creating throttle with envValue=""`);
      const throttle = createPlaybackThrottle("");
      const active = throttle.isActive();
      console.info(`[${SUITE}:${label}] isActive=${active}`);
      try {
        expect(active).toBe(false);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: "",
          isActive: active,
          expected: false,
          actual: active,
          error: err,
        });
        throw err;
      }
    });

    it("is inactive when env var is '0'", () => {
      const label = "inactive-zero";
      console.info(`[${SUITE}:${label}] creating throttle with envValue="0"`);
      const throttle = createPlaybackThrottle("0");
      const active = throttle.isActive();
      console.info(`[${SUITE}:${label}] isActive=${active}`);
      try {
        expect(active).toBe(false);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: "0",
          isActive: active,
          expected: false,
          actual: active,
          error: err,
        });
        throw err;
      }
    });

    it("is inactive when env var is negative", () => {
      const label = "inactive-negative";
      console.info(`[${SUITE}:${label}] creating throttle with envValue="-100"`);
      const throttle = createPlaybackThrottle("-100");
      const active = throttle.isActive();
      console.info(`[${SUITE}:${label}] isActive=${active}`);
      try {
        expect(active).toBe(false);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: "-100",
          isActive: active,
          expected: false,
          actual: active,
          error: err,
        });
        throw err;
      }
    });

    it("is inactive when env var is an unparseable string", () => {
      const label = "inactive-unparseable";
      console.info(`[${SUITE}:${label}] creating throttle with envValue="abc"`);
      const throttle = createPlaybackThrottle("abc");
      const active = throttle.isActive();
      console.info(`[${SUITE}:${label}] isActive=${active}`);
      try {
        expect(active).toBe(false);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: "abc",
          isActive: active,
          expected: false,
          actual: active,
          error: err,
        });
        throw err;
      }
    });

    it("wrap is a verbatim passthrough when inactive", () => {
      const label = "wrap-passthrough-when-inactive";
      console.info(`[${SUITE}:${label}] creating inactive throttle + FakeWritable`);
      const throttle = createPlaybackThrottle(undefined);
      const fake = new FakeWritable();
      const originalWrite = fake.write;
      const wrapped = throttle.wrap(fake);
      console.info(`[${SUITE}:${label}] wrapped===fake: ${wrapped === fake} fake.write===originalWrite: ${fake.write === originalWrite}`);
      try {
        expect(wrapped).toBe(fake);
        expect(fake.write).toBe(originalWrite);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: undefined,
          expected: { wrappedIsFake: true, writeUnchanged: true },
          actual: { wrappedIsFake: wrapped === fake, writeUnchanged: fake.write === originalWrite },
          error: err,
        });
        throw err;
      }
      const buf = Buffer.alloc(1024, 1);
      const result = wrapped.write(buf);
      console.info(
        `[${SUITE}:${label}] write returned ${result} writes.length=${fake.writes.length} writes[0].length=${fake.writes[0]?.length}`
      );
      try {
        expect(result).toBe(true);
        expect(fake.writes.length).toBe(1);
        expect(fake.writes[0].length).toBe(1024);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: undefined,
          writeResult: result,
          writesCount: fake.writes.length,
          writesSliceLengths: fake.writes.map((b) => b.length),
          expected: { writeResult: true, writesCount: 1, firstWriteLength: 1024 },
          actual: { writeResult: result, writesCount: fake.writes.length, firstWriteLength: fake.writes[0]?.length },
          error: err,
        });
        throw err;
      }
    });
  });

  describe("active throttling at 1500 kbps", () => {
    // 1500 kbps = 187 500 bytes/s. Burst capacity = 0.5 s * 187 500 = 93 750 bytes.
    const KBPS_VALUE = "1500";
    const BYTES_PER_SECOND = 187_500;
    const BURST_BYTES = 93_750; // 0.5s burst

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports active state and configured rate", () => {
      const label = "active-rate-config";
      console.info(`[${SUITE}:${label}] creating throttle with envValue=${KBPS_VALUE}`);
      const throttle = createPlaybackThrottle(KBPS_VALUE);
      const active = throttle.isActive();
      const bps = throttle.bytesPerSecond();
      console.info(`[${SUITE}:${label}] isActive=${active} bytesPerSecond=${bps}`);
      try {
        expect(active).toBe(true);
        expect(bps).toBe(BYTES_PER_SECOND);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          isActive: active,
          bytesPerSecond: bps,
          expected: { isActive: true, bytesPerSecond: BYTES_PER_SECOND },
          actual: { isActive: active, bytesPerSecond: bps },
          error: err,
        });
        throw err;
      }
    });

    it("flushes the first burst instantly (full bucket on start)", () => {
      const label = "flush-first-burst";
      console.info(`[${SUITE}:${label}] creating throttle with KBPS=${KBPS_VALUE} burst=${BURST_BYTES}`);
      const throttle = createPlaybackThrottle(KBPS_VALUE, {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);
      vi.setSystemTime(new Date(0));

      // Burst-sized write fits entirely in the bucket → flushes immediately.
      const buf = Buffer.alloc(BURST_BYTES, 7);
      console.info(`[${SUITE}:${label}] writing burst-sized buffer (${BURST_BYTES} bytes)`);
      const result = fake.write(buf);
      console.info(`[${SUITE}:${label}] write returned ${result} (pre-timer flush)`);
      try {
        expect(result).toBe(true);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          burstBytes: BURST_BYTES,
          writeResult: result,
          bytesWritten: fake.totalBytes(),
          writesCount: fake.writes.length,
          expected: { writeResult: true },
          actual: { writeResult: result },
          error: err,
        });
        throw err;
      }
      // No timers needed for immediate flush, but the throttle uses
      // setTimeout(0) as the next-tick to avoid recursion — advance once.
      vi.runOnlyPendingTimers();
      console.info(
        `[${SUITE}:${label}] post-runOnlyPendingTimers totalBytes=${fake.totalBytes()} writes.length=${fake.writes.length}`
      );
      try {
        expect(fake.totalBytes()).toBe(BURST_BYTES);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          burstBytes: BURST_BYTES,
          bytesWritten: fake.totalBytes(),
          writesCount: fake.writes.length,
          writesSliceLengths: fake.writes.map((b) => b.length),
          expected: { totalBytes: BURST_BYTES },
          actual: { totalBytes: fake.totalBytes() },
          error: err,
        });
        throw err;
      }
    });

    it("paces a 1 MiB write so total time ≈ 1MiB/bytesPerSecond", () => {
      const label = "pace-1mib";
      console.info(`[${SUITE}:${label}] setting up throttle with onPace observer`);
      const onPace = vi.fn<(bytes: number, delayMs: number) => void>();
      vi.setSystemTime(new Date(0));
      const throttle = createPlaybackThrottle(KBPS_VALUE, {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
        onPace,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);

      const ONE_MIB = 1_048_576;
      const buf = Buffer.alloc(ONE_MIB, 9);
      console.info(`[${SUITE}:${label}] writing ONE_MIB=${ONE_MIB} bytes (BYTES_PER_SECOND=${BYTES_PER_SECOND})`);
      fake.write(buf);

      // Expected wall time: (1 MiB - burst) / bytesPerSecond seconds, plus
      // burst-instant component. Total ≈ 1_048_576 / 187_500 ≈ 5592 ms.
      const expectedMs = Math.ceil(ONE_MIB / BYTES_PER_SECOND * 1000);
      console.info(`[${SUITE}:${label}] expectedMs=${expectedMs}`);

      // Drive the fake clock alongside the fake timers. We run a loop that
      // advances the clock then drains pending timers; this is the standard
      // pattern when the SUT uses Date.now and setTimeout in tandem.
      let elapsed = 0;
      const step = 50;
      while (elapsed < expectedMs + 200 && fake.totalBytes() < ONE_MIB) {
        vi.advanceTimersByTime(step);
        vi.setSystemTime(new Date(elapsed + step));
        elapsed += step;
      }
      console.info(
        `[${SUITE}:${label}] post-loop elapsed=${elapsed} totalBytes=${fake.totalBytes()} writes.length=${fake.writes.length} onPace.calls=${onPace.mock.calls.length}`
      );

      const lower = expectedMs * 0.9;
      const upper = expectedMs * 1.1 + 200; // burst grace + step granularity
      try {
        expect(fake.totalBytes()).toBe(ONE_MIB);
        // We allow a generous ±10% wall-time band because the throttle
        // rounds wait times up to whole ms.
        expect(elapsed).toBeGreaterThanOrEqual(lower);
        expect(elapsed).toBeLessThanOrEqual(upper);
        expect(onPace).toHaveBeenCalled();
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          bytesPerSecond: BYTES_PER_SECOND,
          burstBytes: BURST_BYTES,
          chunkBytes: ONE_MIB,
          expectedBytes: ONE_MIB,
          bytesWritten: fake.totalBytes(),
          writesCount: fake.writes.length,
          writesSliceLengths: fake.writes.map((b) => b.length),
          elapsedMs: elapsed,
          expectedMs,
          lowerBound: lower,
          upperBound: upper,
          onPaceCalls: onPace.mock.calls.length,
          onPaceArgs: onPace.mock.calls,
          expected: { totalBytes: ONE_MIB, elapsedMsRange: [lower, upper], onPaceCalled: true },
          actual: { totalBytes: fake.totalBytes(), elapsedMs: elapsed, onPaceCalls: onPace.mock.calls.length },
          error: err,
        });
        throw err;
      }
    });

    it("paces cumulative across multiple writes within ±5% of expected", () => {
      const label = "cumulative-pacing";
      console.info(`[${SUITE}:${label}] setting up throttle for 4×256KiB cumulative writes`);
      vi.setSystemTime(new Date(0));
      const throttle = createPlaybackThrottle(KBPS_VALUE, {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);

      // 4 writes of 256 KiB = 1 MiB total.
      const CHUNK = 256 * 1024;
      const TOTAL = CHUNK * 4;
      console.info(`[${SUITE}:${label}] writing 4 chunks of ${CHUNK} bytes each (TOTAL=${TOTAL})`);
      for (let i = 0; i < 4; i += 1) {
        fake.write(Buffer.alloc(CHUNK, i + 1));
      }

      // The bucket starts full, so the first BURST_BYTES go out instantly.
      // Only the remainder must be paced.
      const expectedMs = Math.ceil((TOTAL - BURST_BYTES) / BYTES_PER_SECOND * 1000);
      console.info(`[${SUITE}:${label}] expectedMs=${expectedMs} (TOTAL-BURST=${TOTAL - BURST_BYTES})`);
      let elapsed = 0;
      const step = 25;
      while (elapsed < expectedMs * 1.5 && fake.totalBytes() < TOTAL) {
        vi.advanceTimersByTime(step);
        vi.setSystemTime(new Date(elapsed + step));
        elapsed += step;
      }
      console.info(
        `[${SUITE}:${label}] post-loop elapsed=${elapsed} totalBytes=${fake.totalBytes()} writes.length=${fake.writes.length}`
      );

      const lower = expectedMs * 0.95;
      const upper = expectedMs * 1.05 + 100;
      try {
        expect(fake.totalBytes()).toBe(TOTAL);
        expect(elapsed).toBeGreaterThanOrEqual(lower);
        expect(elapsed).toBeLessThanOrEqual(upper);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          bytesPerSecond: BYTES_PER_SECOND,
          burstBytes: BURST_BYTES,
          chunkBytes: CHUNK,
          expectedBytes: TOTAL,
          bytesWritten: fake.totalBytes(),
          writesCount: fake.writes.length,
          writesSliceLengths: fake.writes.map((b) => b.length),
          elapsedMs: elapsed,
          expectedMs,
          lowerBound: lower,
          upperBound: upper,
          expected: { totalBytes: TOTAL, elapsedMsRange: [lower, upper] },
          actual: { totalBytes: fake.totalBytes(), elapsedMs: elapsed },
          error: err,
        });
        throw err;
      }
    });

    it("end() cancels pending timeouts and flushes cleanly", () => {
      const label = "end-cancels-pending";
      console.info(`[${SUITE}:${label}] setting up throttle + queuing 4×burst bytes`);
      vi.setSystemTime(new Date(0));
      const throttle = createPlaybackThrottle(KBPS_VALUE, {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);

      // Queue more than the bucket allows so pending timeouts exist.
      fake.write(Buffer.alloc(BURST_BYTES * 4, 1));
      console.info(`[${SUITE}:${label}] post-queue totalBytes=${fake.totalBytes()} destroying fake`);
      // Destroy mid-stream — pending timers should be cancelled.
      fake.destroy();
      console.info(`[${SUITE}:${label}] destroyed=${fake.destroyed} writable=${fake.writable}`);

      // Advance time well past when the rest WOULD have been delivered.
      vi.advanceTimersByTime(60_000);
      vi.setSystemTime(new Date(60_000));
      console.info(
        `[${SUITE}:${label}] after 60s advance: totalBytes=${fake.totalBytes()} destroyed=${fake.destroyed}`
      );

      // No exception, no further writes (target is destroyed).
      try {
        expect(fake.destroyed).toBe(true);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          burstBytes: BURST_BYTES,
          bytesWritten: fake.totalBytes(),
          writesCount: fake.writes.length,
          destroyed: fake.destroyed,
          expected: { destroyed: true },
          actual: { destroyed: fake.destroyed },
          error: err,
        });
        throw err;
      }
    });

    it("end() with no pending queue passes through immediately", () => {
      const label = "end-no-pending";
      console.info(`[${SUITE}:${label}] setting up throttle, calling end() with empty queue`);
      vi.setSystemTime(new Date(0));
      const throttle = createPlaybackThrottle(KBPS_VALUE, {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);

      fake.end();
      console.info(`[${SUITE}:${label}] ended=${fake.ended} writableEnded=${fake.writableEnded}`);
      try {
        expect(fake.ended).toBe(true);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          ended: fake.ended,
          writableEnded: fake.writableEnded,
          expected: { ended: true },
          actual: { ended: fake.ended },
          error: err,
        });
        throw err;
      }
    });

    it("respects backpressure: blocked target waits for drain", () => {
      const label = "backpressure-waits-for-drain";
      console.info(`[${SUITE}:${label}] setting up throttle + blocking downstream`);
      vi.setSystemTime(new Date(0));
      const throttle = createPlaybackThrottle(KBPS_VALUE, {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);

      // Block the downstream and queue a burst-sized write that would
      // otherwise flush in one go.
      fake.block();
      console.info(`[${SUITE}:${label}] writing burst-sized buffer while blocked`);
      fake.write(Buffer.alloc(BURST_BYTES, 5));
      vi.runOnlyPendingTimers();
      // First chunk delivered, but downstream returned false → throttle
      // paused before scheduling more. Queue is empty here because the
      // burst fit. To exercise the actual drain path, force a multi-chunk
      // delivery: queue more than burst.
      console.info(
        `[${SUITE}:${label}] after first burst (pre-clear): writes.length=${fake.writes.length} totalBytes=${fake.totalBytes()}`
      );
      fake.writes.length = 0;
      console.info(`[${SUITE}:${label}] queuing 2×burst (${BURST_BYTES * 2} bytes) while blocked`);
      fake.write(Buffer.alloc(BURST_BYTES * 2, 6));
      vi.setSystemTime(new Date(0));
      // Drive enough time for the second half to be scheduled and the
      // throttle to attempt another originalWrite that returns false.
      let elapsed = 0;
      while (elapsed < 5_000) {
        vi.advanceTimersByTime(50);
        vi.setSystemTime(new Date(elapsed + 50));
        elapsed += 50;
        if (fake.writes.length > 0) break;
      }
      const bytesBeforeDrain = fake.totalBytes();
      console.info(
        `[${SUITE}:${label}] post-loop pre-drain bytesBeforeDrain=${bytesBeforeDrain} elapsed=${elapsed} writes.length=${fake.writes.length}`
      );
      try {
        expect(bytesBeforeDrain).toBeGreaterThan(0);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          burstBytes: BURST_BYTES,
          bytesWritten: bytesBeforeDrain,
          writesCount: fake.writes.length,
          writesSliceLengths: fake.writes.map((b) => b.length),
          elapsedMs: elapsed,
          extra: { stage: "pre-drain assertion" },
          expected: { bytesBeforeDrain: "> 0" },
          actual: { bytesBeforeDrain },
          error: err,
        });
        throw err;
      }
      // Release drain; the rest of the queue should now flow.
      console.info(`[${SUITE}:${label}] releasing drain`);
      fake.releaseDrain();
      while (elapsed < 30_000 && fake.totalBytes() < BURST_BYTES * 2) {
        vi.advanceTimersByTime(50);
        vi.setSystemTime(new Date(elapsed + 50));
        elapsed += 50;
      }
      console.info(
        `[${SUITE}:${label}] post-drain elapsed=${elapsed} totalBytes=${fake.totalBytes()} writes.length=${fake.writes.length}`
      );
      try {
        expect(fake.totalBytes()).toBe(BURST_BYTES * 2);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          burstBytes: BURST_BYTES,
          expectedBytes: BURST_BYTES * 2,
          bytesWritten: fake.totalBytes(),
          writesCount: fake.writes.length,
          writesSliceLengths: fake.writes.map((b) => b.length),
          elapsedMs: elapsed,
          extra: { stage: "post-drain assertion" },
          expected: { totalBytes: BURST_BYTES * 2 },
          actual: { totalBytes: fake.totalBytes() },
          error: err,
        });
        throw err;
      }
    });

    it("splits chunks larger than the bucket capacity", () => {
      const label = "split-large-chunks";
      console.info(`[${SUITE}:${label}] setting up throttle for 3×burst single-write`);
      vi.setSystemTime(new Date(0));
      const throttle = createPlaybackThrottle(KBPS_VALUE, {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);

      // Single mega-write 3× the bucket. Should be paced piece by piece.
      const GIANT = BURST_BYTES * 3;
      console.info(`[${SUITE}:${label}] writing GIANT buffer (${GIANT} bytes, 3× burst)`);
      fake.write(Buffer.alloc(GIANT, 42));

      const expectedMs = Math.ceil(GIANT / BYTES_PER_SECOND * 1000);
      console.info(`[${SUITE}:${label}] expectedMs=${expectedMs}`);
      let elapsed = 0;
      const step = 50;
      while (elapsed < expectedMs * 1.2 && fake.totalBytes() < GIANT) {
        vi.advanceTimersByTime(step);
        vi.setSystemTime(new Date(elapsed + step));
        elapsed += step;
      }
      console.info(
        `[${SUITE}:${label}] post-loop elapsed=${elapsed} totalBytes=${fake.totalBytes()} writes.length=${fake.writes.length} maxSlice=${Math.max(...fake.writes.map((b) => b.length))}`
      );
      try {
        expect(fake.totalBytes()).toBe(GIANT);
        // No single delivered slice exceeded the bucket capacity.
        for (const slice of fake.writes) {
          expect(slice.length).toBeLessThanOrEqual(BURST_BYTES);
        }
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: KBPS_VALUE,
          burstBytes: BURST_BYTES,
          expectedBytes: GIANT,
          bytesWritten: fake.totalBytes(),
          writesCount: fake.writes.length,
          writesSliceLengths: fake.writes.map((b) => b.length),
          elapsedMs: elapsed,
          expectedMs,
          expected: { totalBytes: GIANT, allSlicesLeBurst: true },
          actual: {
            totalBytes: fake.totalBytes(),
            maxSliceLength: Math.max(...fake.writes.map((b) => b.length)),
          },
          error: err,
        });
        throw err;
      }
    });
  });

  describe("backpressure return value", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns false when queued bytes exceed one burst worth", () => {
      const label = "backpressure-returns-false";
      console.info(`[${SUITE}:${label}] setting up throttle, writing 300_000 bytes (> burst 93_750)`);
      vi.setSystemTime(new Date(0));
      const throttle = createPlaybackThrottle("1500", {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);
      // Burst = 93 750 bytes. Push a 300 000-byte write — far more than
      // one burst — should return false to signal backpressure.
      const result = fake.write(Buffer.alloc(300_000, 1));
      console.info(`[${SUITE}:${label}] write returned ${result}`);
      try {
        expect(result).toBe(false);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: "1500",
          chunkBytes: 300_000,
          burstBytes: 93_750,
          writeResult: result,
          expected: { writeResult: false },
          actual: { writeResult: result },
          error: err,
        });
        throw err;
      }
    });

    it("returns true when queued bytes fit within one burst", () => {
      const label = "backpressure-returns-true";
      console.info(`[${SUITE}:${label}] setting up throttle, writing 40_000 bytes (< burst 93_750)`);
      vi.setSystemTime(new Date(0));
      const throttle = createPlaybackThrottle("1500", {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);
      const result = fake.write(Buffer.alloc(40_000, 1));
      console.info(`[${SUITE}:${label}] write returned ${result}`);
      try {
        expect(result).toBe(true);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          envValue: "1500",
          chunkBytes: 40_000,
          burstBytes: 93_750,
          writeResult: result,
          expected: { writeResult: true },
          actual: { writeResult: result },
          error: err,
        });
        throw err;
      }
    });
  });

  // Issue #25: the ABR network-recovery e2e drops and restores the "link" while
  // a playback is running, so the rate is settable at runtime and responses
  // already wrapped pick the new rate up on their next refill.
  describe("runtime rate changes", () => {
    const BYTES_PER_SECOND_1500 = 187_500;
    const BURST_1500 = 93_750;
    const ONE_MIB = 1_048_576;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const driveClock = (fake: FakeWritable, fromMs: number, untilMs: number, stopAtBytes: number): number => {
      let elapsed = fromMs;
      const step = 50;
      while (elapsed < untilMs && fake.totalBytes() < stopAtBytes) {
        vi.advanceTimersByTime(step);
        vi.setSystemTime(new Date(elapsed + step));
        elapsed += step;
      }
      return elapsed;
    };

    /**
     * @test-id DESKTOP-PLAYBACK-THROTTLE-RUNTIME-001
     * @level unit
     */
    it("setKbps activates a throttle created without an env rate", () => {
      const label = "runtime-activate";
      const throttle = createPlaybackThrottle(undefined, {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      console.info(`[${SUITE}:${label}] before set isActive=${throttle.isActive()} kbps=${throttle.kbps()}`);
      throttle.setKbps(1500);
      const fake = new FakeWritable();
      throttle.wrap(fake);
      fake.write(Buffer.alloc(BURST_1500 * 2, 3));
      vi.advanceTimersByTime(1);
      const afterBurst = fake.totalBytes();
      driveClock(fake, 0, 600, BURST_1500 * 2);
      console.info(
        `[${SUITE}:${label}] isActive=${throttle.isActive()} kbps=${throttle.kbps()} bps=${throttle.bytesPerSecond()} afterBurst=${afterBurst} total=${fake.totalBytes()}`
      );
      try {
        expect(throttle.isActive()).toBe(true);
        expect(throttle.kbps()).toBe(1500);
        expect(throttle.bytesPerSecond()).toBe(BYTES_PER_SECOND_1500);
        expect(afterBurst).toBe(BURST_1500);
        expect(fake.totalBytes()).toBe(BURST_1500 * 2);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          isActive: throttle.isActive(),
          bytesPerSecond: throttle.bytesPerSecond(),
          bytesWritten: fake.totalBytes(),
          writesSliceLengths: fake.writes.map((b) => b.length),
          extra: { afterBurst },
          error: err,
        });
        throw err;
      }
    });

    /**
     * @test-id DESKTOP-PLAYBACK-THROTTLE-RUNTIME-002
     * @level unit
     */
    it("raising the rate speeds up an in-flight response", () => {
      const label = "runtime-raise";
      const throttle = createPlaybackThrottle("1500", {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);
      fake.write(Buffer.alloc(ONE_MIB, 5));
      let elapsed = driveClock(fake, 0, 1_000, ONE_MIB);
      const deliveredAtSwitch = fake.totalBytes();
      throttle.setKbps(3000);
      console.info(`[${SUITE}:${label}] t=${elapsed} delivered=${deliveredAtSwitch} → setKbps(3000)`);
      elapsed = driveClock(fake, elapsed, 10_000, ONE_MIB);
      const expectedMs = 1_000 + Math.ceil(((ONE_MIB - deliveredAtSwitch) / 375_000) * 1000);
      const unchangedMs = Math.ceil((ONE_MIB / BYTES_PER_SECOND_1500) * 1000);
      const lower = expectedMs * 0.85;
      const upper = expectedMs * 1.15 + 200;
      console.info(
        `[${SUITE}:${label}] done t=${elapsed} total=${fake.totalBytes()} expectedMs=${expectedMs} unchangedMs=${unchangedMs}`
      );
      try {
        expect(fake.totalBytes()).toBe(ONE_MIB);
        expect(elapsed).toBeGreaterThanOrEqual(lower);
        expect(elapsed).toBeLessThanOrEqual(upper);
        expect(elapsed).toBeLessThan(unchangedMs * 0.75);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          bytesWritten: fake.totalBytes(),
          writesSliceLengths: fake.writes.map((b) => b.length),
          elapsedMs: elapsed,
          expectedMs,
          lowerBound: lower,
          upperBound: upper,
          extra: { deliveredAtSwitch, unchangedMs },
          error: err,
        });
        throw err;
      }
    });

    /**
     * @test-id DESKTOP-PLAYBACK-THROTTLE-RUNTIME-003
     * @level unit
     */
    it("setKbps(0) releases an in-flight response on its next refill and stops wrapping new ones", () => {
      const label = "runtime-off";
      const throttle = createPlaybackThrottle("1500", {
        nowMs: () => vi.getMockedSystemTime()?.getTime() ?? 0,
      });
      const fake = new FakeWritable();
      throttle.wrap(fake);
      fake.write(Buffer.alloc(ONE_MIB, 6));
      let elapsed = driveClock(fake, 0, 1_000, ONE_MIB);
      const deliveredAtSwitch = fake.totalBytes();
      throttle.setKbps(0);
      console.info(`[${SUITE}:${label}] t=${elapsed} delivered=${deliveredAtSwitch} → setKbps(0)`);
      // The timer armed at the old rate fires within one 0.5 s burst period.
      elapsed = driveClock(fake, elapsed, 1_600, ONE_MIB);
      const next = new FakeWritable();
      throttle.wrap(next);
      next.write(Buffer.alloc(ONE_MIB, 1));
      const nextSync = next.totalBytes();
      console.info(
        `[${SUITE}:${label}] t=${elapsed} total=${fake.totalBytes()} isActive=${throttle.isActive()} nextSync=${nextSync}`
      );
      try {
        expect(deliveredAtSwitch).toBeLessThan(ONE_MIB);
        expect(fake.totalBytes()).toBe(ONE_MIB);
        expect(elapsed).toBeLessThanOrEqual(1_550);
        expect(throttle.isActive()).toBe(false);
        expect(throttle.kbps()).toBe(0);
        expect(throttle.bytesPerSecond()).toBe(0);
        expect(nextSync).toBe(ONE_MIB);
      } catch (err) {
        dumpPlaybackThrottleSnapshot(label, {
          isActive: throttle.isActive(),
          bytesWritten: fake.totalBytes(),
          elapsedMs: elapsed,
          extra: { deliveredAtSwitch, nextSync },
          error: err,
        });
        throw err;
      }
    });

    /**
     * @test-id DESKTOP-PLAYBACK-THROTTLE-RUNTIME-004
     * @level unit
     */
    it("rejects a negative or non-finite rate and keeps the current one", () => {
      const throttle = createPlaybackThrottle("1500");
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => throttle.setKbps(bad)).toThrow(RangeError);
      }
      console.info(`[${SUITE}:runtime-invalid] kbps after rejects=${throttle.kbps()}`);
      expect(throttle.kbps()).toBe(1500);
    });
  });
});

describe("installPlaybackThrottleControl", () => {
  afterEach(() => {
    globalThis.__sfPlaybackThrottle = undefined;
  });

  /**
   * @test-id DESKTOP-PLAYBACK-THROTTLE-CONTROL-001
   * @level unit
   */
  it("installs nothing unless SF_PLAYBACK_THROTTLE_CONTROL=1", () => {
    const target = { setThrottleKbps: vi.fn(), getThrottleKbps: vi.fn(() => 0) };
    const installed = installPlaybackThrottleControl(target, {});
    console.info(`[${SUITE}:control-off] installed=${installed} global=${typeof globalThis.__sfPlaybackThrottle}`);
    expect(installed).toBe(false);
    expect(globalThis.__sfPlaybackThrottle).toBeUndefined();
  });

  /**
   * @test-id DESKTOP-PLAYBACK-THROTTLE-CONTROL-002
   * @level unit
   */
  it("exposes set/get on globalThis.__sfPlaybackThrottle when enabled", () => {
    let kbps = 0;
    const target = {
      setThrottleKbps: vi.fn((next: number) => {
        kbps = next;
      }),
      getThrottleKbps: vi.fn(() => kbps),
    };
    const installed = installPlaybackThrottleControl(target, { SF_PLAYBACK_THROTTLE_CONTROL: "1" });
    globalThis.__sfPlaybackThrottle?.set(800);
    const got = globalThis.__sfPlaybackThrottle?.get();
    console.info(`[${SUITE}:control-on] installed=${installed} got=${got} setCalls=${JSON.stringify(target.setThrottleKbps.mock.calls)}`);
    expect(installed).toBe(true);
    expect(target.setThrottleKbps).toHaveBeenCalledWith(800);
    expect(got).toBe(800);
  });
});
