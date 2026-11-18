import { describe, expect, it } from "vitest";
import { STDIN_HIGH_WATER_MARK_BYTES, type StdinPumpStats, __testOnly } from "../src/index";

const SUITE = "pump-bun-sink";

const makeAsyncIterable = (chunks: Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) {
      yield chunk;
    }
  },
});

/**
 * Per-suite dump helper. Emits a `=== [pump-bun-sink:<label>] ===` delimited
 * block so CI can grep the snapshot out of the test log. Wrapped in try/catch
 * so a serialization failure here can never mask the real assertion failure.
 *
 * `state` carries whatever the calling test observed — write payloads, call
 * counts, ordering, tripwires. Everything is optional so each test passes only
 * the fields it tracks.
 */
const dumpPumpSnapshot = (
  label: string,
  state: {
    writes?: Uint8Array[] | number[];
    endCalls?: number;
    writeCount?: number;
    order?: string[];
    getWriterTouched?: boolean;
    expected?: unknown;
  },
): void => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (state.writes !== undefined) {
      const serialized = state.writes.map((w) =>
        w instanceof Uint8Array ? Array.from(w) : w,
      );
      console.error(`writes (${state.writes.length})=${JSON.stringify(serialized)}`);
    }
    if (state.writeCount !== undefined) {
      console.error(`writeCount=${state.writeCount}`);
    }
    if (state.endCalls !== undefined) {
      console.error(`endCalls=${state.endCalls}`);
    }
    if (state.order !== undefined) {
      console.error(`order=${JSON.stringify(state.order)}`);
    }
    if (state.getWriterTouched !== undefined) {
      console.error(`getWriterTouched=${state.getWriterTouched}`);
    }
    if (state.expected !== undefined) {
      console.error(`expected=${JSON.stringify(state.expected)}`);
    }
    console.error(`=== [${SUITE}:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

console.info(`[${SUITE}:setup] loaded pumpBunSink test-only export from packages/ffmpeg/src/index`);

/**
 * Regression coverage for the runtime crash that hit any replan/retranscode
 * job under Bun (visible in /tmp/spacefleet-runtime/runtime.log):
 *
 *   TypeError: target.getWriter is not a function.
 *     at packages/ffmpeg/src/index.ts:83  (pumpWebStream)
 *     at packages/ffmpeg/src/index.ts:288 (Bun spawn branch)
 *
 * Root cause: Bun's `proc.stdin` when `stdin: "pipe"` is a FileSink (with
 * .write() / .end()), NOT a WritableStream (.getWriter()). The TS error
 * TS2345 at index.ts:288 pointed at this exact mismatch and was
 * previously dismissed as pre-existing — it was active product debt.
 *
 * `pumpBunSink` is the FileSink-aware pump. Tests assert:
 *  1. Every chunk reaches `target.write()` in order.
 *  2. `target.end()` is awaited if it returns a promise.
 *  3. A throwing `write()` short-circuits without rejecting the pump
 *     (matches the original `pumpWebStream` "return on writer error"
 *     contract — ffmpeg exit code surfaces the failure).
 *  4. An async-iterator that throws mid-stream still calls `end()`.
 */
describe("pumpBunSink — Bun FileSink pump — @bugfix @regression-proof", () => {
  it("writes every chunk in order and calls end() exactly once", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6]),
    ];
    const writes: Uint8Array[] = [];
    let endCalls = 0;
    const target = {
      write: (c: Uint8Array) => {
        writes.push(c);
        return c.byteLength;
      },
      end: () => {
        endCalls += 1;
      },
    };
    console.info(`[${SUITE}:exec] feeding ${chunks.length} chunks into pumpBunSink`);
    await __testOnly.pumpBunSink(target, makeAsyncIterable(chunks));
    console.info(`[${SUITE}:exec] writes=${writes.length} end-calls=${endCalls}`);
    try {
      expect(writes).toEqual(chunks);
      expect(endCalls).toBe(1);
    } catch (err) {
      console.error(
        `[${SUITE}:fail] writes=${JSON.stringify(writes.map((w) => Array.from(w)))} endCalls=${endCalls}`,
      );
      dumpPumpSnapshot("writes-in-order-fail", {
        writes,
        endCalls,
        expected: { writes: chunks.map((c) => Array.from(c)), endCalls: 1 },
      });
      throw err;
    }
  });

  it("awaits a promise-returning end() (FileSink.end resolves once stdin is fully flushed)", async () => {
    const order: string[] = [];
    const target = {
      write: (_c: Uint8Array) => {
        order.push("write");
        return 0;
      },
      end: () =>
        new Promise<void>((resolve) => {
          order.push("end-start");
          setTimeout(() => {
            order.push("end-resolved");
            resolve();
          }, 5);
        }),
    };
    console.info(`[${SUITE}:exec] pumping with promise-returning end()`);
    await __testOnly.pumpBunSink(target, makeAsyncIterable([new Uint8Array([1])]));
    console.info(`[${SUITE}:exec] order=${JSON.stringify(order)}`);
    try {
      // The pump must have awaited the end() promise (not returned mid-flight)
      expect(order).toEqual(["write", "end-start", "end-resolved"]);
    } catch (err) {
      console.error(`[${SUITE}:fail] expected end() to be awaited; got ${JSON.stringify(order)}`);
      dumpPumpSnapshot("awaits-end-promise-fail", {
        order,
        expected: ["write", "end-start", "end-resolved"],
      });
      throw err;
    }
  });

  it("short-circuits cleanly when write() throws (mirrors pumpWebStream contract)", async () => {
    let writeCount = 0;
    let endCalls = 0;
    const target = {
      write: () => {
        writeCount += 1;
        throw new Error("EPIPE");
      },
      end: () => {
        endCalls += 1;
      },
    };
    console.info(`[${SUITE}:exec] pumping with always-throwing write()`);
    // Should NOT reject — the spec is "return on writer error" so the
    // child exit code surfaces the failure to the caller.
    await expect(
      __testOnly.pumpBunSink(
        target,
        makeAsyncIterable([new Uint8Array([1]), new Uint8Array([2])]),
      ),
    ).resolves.toBeUndefined();
    console.info(`[${SUITE}:exec] writeCount=${writeCount} endCalls=${endCalls}`);
    try {
      // First write throws → loop exits → end() still runs in finally.
      expect(writeCount).toBe(1);
      expect(endCalls).toBe(1);
    } catch (err) {
      console.error(
        `[${SUITE}:fail] writeCount=${writeCount} endCalls=${endCalls}`,
      );
      dumpPumpSnapshot("write-throws-short-circuit-fail", {
        writeCount,
        endCalls,
        expected: { writeCount: 1, endCalls: 1 },
      });
      throw err;
    }
  });

  it("still calls end() when the source iterator throws mid-stream", async () => {
    const writes: number[] = [];
    let endCalls = 0;
    const target = {
      write: (c: Uint8Array) => {
        writes.push(c[0]);
        return 1;
      },
      end: () => {
        endCalls += 1;
      },
    };
    const failingSource: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1]);
        yield new Uint8Array([2]);
        throw new Error("upstream-broke");
      },
    };
    console.info(`[${SUITE}:exec] pumping a source that throws after 2 chunks`);
    await expect(__testOnly.pumpBunSink(target, failingSource)).resolves.toBeUndefined();
    console.info(`[${SUITE}:exec] writes=${JSON.stringify(writes)} endCalls=${endCalls}`);
    try {
      expect(writes).toEqual([1, 2]);
      expect(endCalls).toBe(1);
    } catch (err) {
      console.error(`[${SUITE}:fail] writes=${JSON.stringify(writes)} endCalls=${endCalls}`);
      dumpPumpSnapshot("source-throws-still-ends-fail", {
        writes,
        endCalls,
        expected: { writes: [1, 2], endCalls: 1 },
      });
      throw err;
    }
  });

  it("calling getWriter() on the target is NOT attempted (the original crash signature)", async () => {
    // Belt-and-braces: assert pumpBunSink would NOT access .getWriter()
    // even if it existed. We give the target a getWriter property that
    // throws if touched.
    let getWriterTouched = false;
    const target = {
      write: (c: Uint8Array) => c.byteLength,
      end: () => undefined,
      get getWriter() {
        getWriterTouched = true;
        return () => {
          throw new Error("must not be called");
        };
      },
    };
    console.info(`[${SUITE}:exec] target has a tripwire getWriter getter; pump must not touch it`);
    await __testOnly.pumpBunSink(target, makeAsyncIterable([new Uint8Array([7])]));
    console.info(`[${SUITE}:exec] getWriterTouched=${getWriterTouched}`);
    try {
      expect(getWriterTouched).toBe(false);
    } catch (err) {
      console.error(`[${SUITE}:fail] pumpBunSink reached for .getWriter on a FileSink-shaped target`);
      dumpPumpSnapshot("getWriter-tripwire-fail", {
        getWriterTouched,
        expected: { getWriterTouched: false },
      });
      throw err;
    }
  });
});

/**
 * #25 NEW-retranscode-stdin-buffer: the retranscode source (download +
 * decrypt) is far faster than a CPU encode, and Bun's FileSink buffers every
 * write without bound. Pre-fix the pump never waited on the sink, so the whole
 * source sat in runtime memory (S1 job 9fc6bc45: RSS 172.7 → 622 MB in 12 s;
 * footprint peaks up to 2.6 GB). The fake sink below models a FileSink on a
 * pipe whose reader (ffmpeg) is slow: writes are accepted and buffered, a
 * macrotask drainer empties the buffer slowly, and flush() resolves once it is
 * empty — the behaviour observed on Bun 1.3.5 with a slow child.
 */
describe("pumpBunSink — stdin backpressure — @bugfix @regression-proof", () => {
  it("keeps a slow sink's pending bytes ≤ 2×HWM while a 200 MB source races ahead", async () => {
    const HWM = STDIN_HIGH_WATER_MARK_BYTES;
    const CHUNK_BYTES = 64 * 1024;
    const SOURCE_BYTES = 200 * 1024 * 1024;
    const DRAIN_PER_TICK = 256 * 1024;
    const chunk = new Uint8Array(CHUNK_BYTES);

    let pending = 0;
    let peakPending = 0;
    let drained = 0;
    let endCalls = 0;
    let flushCalls = 0;
    let drainerScheduled = false;
    let flushWaiters: Array<() => void> = [];
    const drainTick = () => {
      const n = Math.min(pending, DRAIN_PER_TICK);
      pending -= n;
      drained += n;
      if (pending > 0) {
        setImmediate(drainTick);
        return;
      }
      drainerScheduled = false;
      const waiters = flushWaiters;
      flushWaiters = [];
      for (const resolve of waiters) resolve();
    };
    const target = {
      write: (c: Uint8Array) => {
        pending += c.byteLength;
        if (pending > peakPending) peakPending = pending;
        if (!drainerScheduled) {
          drainerScheduled = true;
          setImmediate(drainTick);
        }
        return c.byteLength;
      },
      flush: () => {
        flushCalls += 1;
        if (pending === 0) return 0;
        const { promise, resolve } = Promise.withResolvers<number>();
        flushWaiters.push(() => resolve(0));
        return promise;
      },
      end: () => {
        endCalls += 1;
      },
    };
    const fastSource: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for (let sent = 0; sent < SOURCE_BYTES; sent += CHUNK_BYTES) yield chunk;
      },
    };

    console.info(
      `[${SUITE}:exec] pumping ${SOURCE_BYTES} B in ${CHUNK_BYTES} B chunks into a slow sink (hwm=${HWM})`,
    );
    let stats: StdinPumpStats | undefined;
    await __testOnly.pumpBunSink(target, fastSource, {
      onDone: (s) => {
        stats = s;
      },
    });
    // Let the drainer finish what end() left behind.
    while (pending > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    }
    console.info(
      `[${SUITE}:exec] peakPending=${peakPending} drained=${drained} flushCalls=${flushCalls} endCalls=${endCalls} stats=${JSON.stringify(stats)}`,
    );
    try {
      expect(peakPending).toBeLessThanOrEqual(2 * HWM);
      expect(drained).toBe(SOURCE_BYTES);
      expect(endCalls).toBe(1);
      expect(stats?.bytes).toBe(SOURCE_BYTES);
      expect(stats?.peakPendingBytes).toBeGreaterThanOrEqual(peakPending);
      expect(stats?.peakPendingBytes).toBeLessThanOrEqual(2 * HWM);
    } catch (err) {
      console.error(
        `[${SUITE}:fail] slow sink buffered ${peakPending} B (limit ${2 * HWM} B); drained=${drained}/${SOURCE_BYTES}`,
      );
      dumpPumpSnapshot("backpressure-fail", {
        endCalls,
        writeCount: flushCalls,
        expected: { peakPendingMax: 2 * HWM, drained: SOURCE_BYTES, endCalls: 1 },
      });
      throw err;
    }
  }, 60_000);
});

/**
 * #25 pump-unhandled-rejection (ultimate rerun on a Linux test machine, seed 1791529129542,
 * results/2026-10-15T20-58-09-757Z-1791529129542/timeline.jsonl:5420-5445):
 * the runtime exited 1 four times, each right after `/runtime/jobs/v2/cancel`
 * of a retranscode job:
 *   error: CANCELLED
 *     at apps/runtime/src/modules/badger/steps/deps-adapter.ts:1146 (makeSourceStream)
 *     at packages/ffmpeg/src/index.ts:228 (pumpBunSink prefetch `next = iterator.next()`)
 * The pump prefetches the next source chunk, then awaits the write() or
 * flush() promise of the current one. Pre-fix the prefetched promise had no
 * handler during that wait (it got one only in `finally`), so a source that
 * rejected meanwhile (the cancelled job's generator) was an unhandled
 * rejection, and Bun exits the process on those. The tests below make the
 * source reject while a slow write()/flush() is pending and assert that no
 * unhandled rejection fires, and that the error still reaches
 * `onSourceError` before `end()`.
 */
describe("pumpBunSink — source rejects during a slow write/flush (#25) — @bugfix @regression-proof", () => {
  const UR = `${SUITE}:unhandled`;

  // One event-loop turn (no wall-clock delay). Unhandled rejections are
  // reported once the microtask queue drains, so a promise held open past
  // this turn gives the runtime its chance to report one.
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  /**
   * Mirrors deps-adapter `makeSourceStream`: yields one piece, then the job is
   * cancelled and the next pull throws `CANCELLED`. `rejected` resolves once
   * the generator has thrown, so the sink can hold its promise open past it.
   */
  const makeCancelledSource = (log: string[]) => {
    const abort = new AbortController();
    const { promise: rejected, resolve: markRejected } = Promise.withResolvers<void>();
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1]);
        log.push("source:resumed-after-first-yield");
        abort.abort();
        try {
          if (abort.signal.aborted) throw new Error("CANCELLED");
          yield new Uint8Array([2]);
        } finally {
          log.push("source:threw-CANCELLED");
          markRejected();
        }
      },
    };
    return { source, rejected };
  };

  const runCase = async (
    label: string,
    makeTarget: (log: string[], rejected: Promise<void>) => Parameters<typeof __testOnly.pumpBunSink>[0],
    highWaterMark: number,
  ) => {
    const log: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
      log.push(`process:unhandledRejection(${reason instanceof Error ? reason.message : String(reason)})`);
      console.error(`[${UR}] unhandledRejection observed during ${label}: ${String(reason)}`);
    };
    process.on("unhandledRejection", onUnhandled);
    const sourceErrors: unknown[] = [];
    try {
      console.info(`[${SUITE}:setup] ${label}: source yields 1 piece then throws CANCELLED; hwm=${highWaterMark}`);
      const { source, rejected } = makeCancelledSource(log);
      const target = makeTarget(log, rejected);
      console.info(`[${SUITE}:exec] ${label}: pumping`);
      await __testOnly.pumpBunSink(target, source, {
        highWaterMark,
        onSourceError: (err) => {
          sourceErrors.push(err);
          log.push(`pump:onSourceError(${err instanceof Error ? err.message : String(err)})`);
        },
      });
      // Give a late unhandledRejection (Node/Bun emit it after the microtask
      // drain) a chance to surface before asserting.
      await nextTurn();
      await nextTurn();
      console.info(`[${SUITE}:assert] ${label}: log=${JSON.stringify(log)} unhandled=${unhandled.length}`);
      try {
        expect(unhandled).toEqual([]);
        expect(sourceErrors).toHaveLength(1);
        expect((sourceErrors[0] as Error).message).toBe("CANCELLED");
        // onSourceError (the caller kills ffmpeg there) runs before stdin ends.
        expect(log.indexOf("pump:onSourceError(CANCELLED)")).toBeGreaterThan(-1);
        expect(log.indexOf("pump:onSourceError(CANCELLED)")).toBeLessThan(log.indexOf("sink:end"));
        expect(log.filter((e) => e === "sink:end")).toHaveLength(1);
      } catch (err) {
        console.error(`[${SUITE}:fail] ${label}: unhandled=${unhandled.length} sourceErrors=${sourceErrors.length}`);
        dumpPumpSnapshot(`${label}-fail`, {
          order: log,
          expected: {
            unhandled: 0,
            onSourceError: "CANCELLED, once, before sink:end",
            endCalls: 1,
          },
        });
        throw err;
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  };

  it("source rejects while write() is pending: no unhandled rejection, onSourceError before end()", async () => {
    await runCase(
      "slow-write",
      (log, rejected) => ({
        write: (c: Uint8Array) => {
          log.push(`sink:write(${c[0]})`);
          // A write that only settles after the prefetched pull has rejected
          // and a macrotask (where an unhandled rejection is reported) passed.
          return rejected.then(nextTurn).then(() => {
            log.push(`sink:write-settled(${c[0]})`);
            return c.byteLength;
          });
        },
        end: () => {
          log.push("sink:end");
        },
      }),
      STDIN_HIGH_WATER_MARK_BYTES,
    );
  });

  it("source rejects while flush() is pending: no unhandled rejection, onSourceError before end()", async () => {
    await runCase(
      "slow-flush",
      (log, rejected) => ({
        write: (c: Uint8Array) => {
          log.push(`sink:write(${c[0]})`);
          return c.byteLength;
        },
        flush: () => {
          log.push("sink:flush");
          return rejected.then(nextTurn).then(() => {
            log.push("sink:flush-settled");
            return 0;
          });
        },
        end: () => {
          log.push("sink:end");
        },
      }),
      // hwm=1: the first 1-byte chunk already triggers the flush wait.
      1,
    );
  });
});
