// Token-bucket pacing middleware for the local playback HTTP server.
//
// Purpose: when a positive rate N kbps is set — initially from the
// `SF_PLAYBACK_THROTTLE_KBPS` env var, at runtime via `setKbps` (issue #25:
// the ABR network-recovery e2e drops and restores the "link" mid-playback) —
// outgoing chunk bytes are paced so that observed throughput on
// `/playback/object/*` (and HLS segment) responses approaches N kbps. Used by
// the ABR tests to force a real, network-shaped slow link without involving
// the OS networking stack. Off (wrap is a pass-through) while the rate is 0 —
// env var unset, empty, "0", or unparseable — so production runs see zero
// overhead.
//
// Implementation notes:
// * Bucket capacity = 0.5 s worth of bytes. The half-second burst smooths
//   over Node's chunky writes (which arrive in 16-64 KiB pieces) while still
//   converging on the target rate over multi-second responses.
// * `wrap(target)` returns the same stream reference with `write` and `end`
//   monkey-patched. We deliberately return the original target rather than a
//   transform stream so existing back-pressure / header semantics on the
//   `http.ServerResponse` continue to work exactly as before.
// * The wrapper preserves the standard `write` return contract: it returns
//   `false` when an internal queue has built up (the caller should pause
//   producing). We emit `'drain'` on the target once the queue clears,
//   matching Node's stream protocol.
// * Cleanup is idempotent. `end`/`destroy` cancels any pending setTimeout
//   so no orphan timers fire after the response has finished.
// * A rate change reaches responses already wrapped on their next refill
//   (rate 0 releases their queue at once). A response wrapped while the rate
//   was 0 stays unpaced.

import type { EventEmitter } from "node:events";

export type PlaybackThrottle = {
  isActive(): boolean;
  /**
   * The current rate in bytes per second. Zero when inactive.
   */
  bytesPerSecond(): number;
  /** The current rate in kbps. Zero when inactive. */
  kbps(): number;
  /**
   * Change the rate at runtime; 0 turns pacing off. Throws RangeError on a
   * negative or non-finite rate.
   */
  setKbps(kbps: number): void;
  /**
   * Pace writes on `target`. Mutates `target` in-place (monkey-patches
   * `write`/`end`/`destroy`) and returns the same reference so call sites
   * can do `throttle.wrap(res).write(buf)`.
   *
   * When the throttle is inactive this is a no-op pass-through: the stream
   * is returned unmodified.
   */
  wrap<T extends NodeJS.WritableStream>(target: T): T;
};

type WritableLike = NodeJS.WritableStream & Partial<EventEmitter> & {
  destroyed?: boolean;
  destroy?: (error?: Error) => void;
};

type PlaybackThrottleOptions = {
  onPace?: (bytes: number, delayMs: number) => void;
  nowMs?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

export const PLAYBACK_THROTTLE_BURST_SECONDS = 0.5;

/**
 * Bytes a freshly wrapped response sends instantly: the bucket starts full
 * with `PLAYBACK_THROTTLE_BURST_SECONDS` worth of the configured rate. Shared
 * with the ultimate suite's ttff transfer floor (e2e-ultimate/lib/ttffStages).
 */
export const playbackThrottleBurstBytes = (kbps: number): number =>
  Math.max(1, Math.floor(Math.floor((kbps * 1000) / 8) * PLAYBACK_THROTTLE_BURST_SECONDS));

const parseKbps = (value: string | undefined): number => {
  if (!value) return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed <= 0) return 0;
  return parsed;
};

declare global {
  var __sfPlaybackThrottle: { set(kbps: number): void; get(): number } | undefined;
}

/**
 * Test seam (issue #25): with SF_PLAYBACK_THROTTLE_CONTROL=1 the Playwright
 * driver changes the playback throttle mid-run via
 * `electronApp.evaluate(() => globalThis.__sfPlaybackThrottle.set(kbps))`.
 * Returns whether the control was installed.
 */
export const installPlaybackThrottleControl = (
  target: { setThrottleKbps(kbps: number): void; getThrottleKbps(): number },
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (env.SF_PLAYBACK_THROTTLE_CONTROL !== "1") return false;
  globalThis.__sfPlaybackThrottle = {
    set: (kbps) => target.setThrottleKbps(kbps),
    get: () => target.getThrottleKbps(),
  };
  return true;
};

export const createPlaybackThrottle = (
  kbpsEnvValue: string | undefined,
  options: PlaybackThrottleOptions = {},
): PlaybackThrottle => {
  const nowMs = options.nowMs ?? Date.now;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const onPace = options.onPace;

  // Rate state, read by every wrapped response on each refill.
  let kbps = 0;
  let bytesPerSecond = 0;
  let bytesPerMs = 0;
  // Half-second burst capacity. Always at least 1 byte so the bucket can
  // drain even at absurdly low configured rates; unbounded while off.
  let capacity = Number.POSITIVE_INFINITY;

  const setKbps = (next: number) => {
    if (!Number.isFinite(next) || next < 0) {
      throw new RangeError(`playback throttle kbps must be a finite number >= 0, got ${next}`);
    }
    kbps = next;
    bytesPerSecond = next > 0 ? Math.floor((next * 1000) / 8) : 0;
    bytesPerMs = bytesPerSecond / 1000;
    capacity = next > 0 ? playbackThrottleBurstBytes(next) : Number.POSITIVE_INFINITY;
  };
  setKbps(parseKbps(kbpsEnvValue));

  const wrap = <T extends NodeJS.WritableStream>(target: T): T => {
    if (kbps <= 0) return target;
    const stream = target as unknown as WritableLike;
    const originalWrite = stream.write.bind(stream) as NodeJS.WritableStream["write"];
    const originalEnd = stream.end.bind(stream) as NodeJS.WritableStream["end"];
    const originalDestroy = stream.destroy ? stream.destroy.bind(stream) : undefined;

    // Token bucket state: start full so the first burst flushes instantly
    // (matches typical CDN behaviour and keeps short responses snappy).
    let tokens = capacity;
    let lastRefillMs = nowMs();

    // Queue of pending chunk slices waiting for token availability. Each
    // entry contains the bytes and the original caller's callback (if any).
    type PendingSlice = {
      bytes: Buffer;
      callback?: (error?: Error | null) => void;
    };
    const queue: PendingSlice[] = [];
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let queueBytesAhead = 0;
    let drainNeeded = false;
    let ended = false;
    let endCallback: (() => void) | undefined;

    const refill = () => {
      const now = nowMs();
      if (bytesPerMs <= 0) {
        // Turned off while this response was paced: release everything.
        tokens = Number.POSITIVE_INFINITY;
        lastRefillMs = now;
        return;
      }
      const elapsed = now - lastRefillMs;
      if (elapsed > 0) {
        tokens += elapsed * bytesPerMs;
        lastRefillMs = now;
      }
      // Also clamps a bucket left over from a higher (or unbounded) rate.
      tokens = Math.min(capacity, tokens);
    };

    const cancelTimer = () => {
      if (pendingTimer) {
        clearTimeoutImpl(pendingTimer);
        pendingTimer = null;
      }
    };

    const isTargetClosed = (): boolean => {
      if (stream.destroyed) return true;
      // Some streams (ServerResponse) expose `writable` as a getter.
      const writable = (stream as { writable?: boolean }).writable;
      return writable === false;
    };

    const emitDrainIfNeeded = () => {
      if (!drainNeeded) return;
      if (queue.length > 0 || queueBytesAhead > 0) return;
      drainNeeded = false;
      // Best-effort drain emit; not all writable streams emit drain directly
      // from external callers, but http.ServerResponse extends EventEmitter
      // so this works for our actual call site.
      const emitter = stream as unknown as EventEmitter;
      if (typeof emitter.emit === "function") {
        emitter.emit("drain");
      }
    };

    const flushNow = () => {
      pendingTimer = null;
      if (isTargetClosed()) {
        // Drop pending callbacks with no error; consumer is gone.
        while (queue.length > 0) {
          const slice = queue.shift();
          slice?.callback?.();
        }
        queueBytesAhead = 0;
        return;
      }
      refill();
      while (queue.length > 0) {
        const head = queue[0];
        if (tokens >= head.bytes.length) {
          tokens -= head.bytes.length;
          queueBytesAhead -= head.bytes.length;
          queue.shift();
          onPace?.(head.bytes.length, 0);
          const continued = originalWrite(head.bytes, head.callback);
          if (!continued) {
            // Underlying target is full — wait for its real drain before
            // continuing. We re-arm via `once('drain')` below.
            const emitter = stream as unknown as EventEmitter;
            if (typeof emitter.once === "function") {
              emitter.once("drain", () => {
                if (queue.length > 0) {
                  scheduleNextFlush();
                } else if (ended) {
                  finalizeEnd();
                }
              });
            }
            return;
          }
        } else {
          // Partial: ship what we can right now, push the rest back.
          if (tokens > 0) {
            const ready = head.bytes.subarray(0, Math.floor(tokens));
            const remaining = head.bytes.subarray(Math.floor(tokens));
            head.bytes = remaining;
            tokens = 0;
            onPace?.(ready.length, 0);
            const continued = originalWrite(ready);
            queueBytesAhead -= ready.length;
            if (!continued) {
              const emitter = stream as unknown as EventEmitter;
              if (typeof emitter.once === "function") {
                emitter.once("drain", () => {
                  if (queue.length > 0) {
                    scheduleNextFlush();
                  } else if (ended) {
                    finalizeEnd();
                  }
                });
              }
              return;
            }
          }
          scheduleNextFlush();
          return;
        }
      }
      emitDrainIfNeeded();
      if (ended && queue.length === 0) {
        finalizeEnd();
      }
    };

    const scheduleNextFlush = () => {
      if (pendingTimer) return;
      if (queue.length === 0) return;
      refill();
      const head = queue[0];
      const deficit = Math.max(0, head.bytes.length - tokens);
      const waitMs = deficit > 0 ? Math.ceil(deficit / bytesPerMs) : 0;
      if (waitMs <= 0) {
        // Already enough tokens — flush on next tick to avoid recursion.
        pendingTimer = setTimeoutImpl(flushNow, 0);
        return;
      }
      onPace?.(0, waitMs);
      pendingTimer = setTimeoutImpl(flushNow, waitMs);
    };

    const finalizeEnd = () => {
      if (!ended) return;
      if (queue.length > 0) return;
      cancelTimer();
      originalEnd(endCallback);
    };

    // Patch write. Signature unions are wide; we coerce internally and only
    // ever call back with the official shapes.
    const patchedWrite = ((
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      maybeCallback?: (error?: Error | null) => void,
    ): boolean => {
      const callback =
        typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
      const encoding =
        typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, encoding ?? "utf8")
          : Buffer.from(chunk);
      if (buf.length === 0) {
        if (callback) callback();
        return true;
      }

      // Chunks larger than capacity get split into bucket-sized pieces so the
      // bucket can drain steadily instead of starving on one giant write.
      const slices: Buffer[] = [];
      if (buf.length > capacity) {
        for (let offset = 0; offset < buf.length; offset += capacity) {
          slices.push(buf.subarray(offset, Math.min(buf.length, offset + capacity)));
        }
      } else {
        slices.push(buf);
      }

      // Attach the user callback only to the LAST slice — Node's contract is
      // that the callback fires once the buffer has been handed off, and we
      // only consider the write "complete" when the final slice ships.
      slices.forEach((slice, index) => {
        const isLast = index === slices.length - 1;
        queue.push({
          bytes: slice,
          callback: isLast ? callback : undefined,
        });
        queueBytesAhead += slice.length;
      });

      // Try to drain immediately under the bucket.
      if (queue.length === slices.length) {
        // queue was empty before this push; safe to start the loop.
        if (!pendingTimer) {
          scheduleNextFlush();
        }
      }

      // Backpressure: if the queue is now holding more than 1 burst worth
      // ahead, signal the caller to slow down.
      if (queueBytesAhead > capacity) {
        drainNeeded = true;
        return false;
      }
      return true;
    }) as NodeJS.WritableStream["write"];

    const patchedEnd = ((
      chunkOrCallback?: string | Uint8Array | (() => void),
      encodingOrCallback?: BufferEncoding | (() => void),
      maybeCallback?: () => void,
    ): WritableLike => {
      let chunk: string | Uint8Array | undefined;
      let cb: (() => void) | undefined;
      let encoding: BufferEncoding | undefined;
      if (typeof chunkOrCallback === "function") {
        cb = chunkOrCallback;
      } else if (chunkOrCallback !== undefined) {
        chunk = chunkOrCallback;
        if (typeof encodingOrCallback === "function") {
          cb = encodingOrCallback;
        } else if (typeof encodingOrCallback === "string") {
          encoding = encodingOrCallback;
          cb = maybeCallback;
        }
      }
      ended = true;
      endCallback = cb;
      if (chunk !== undefined && (typeof chunk === "string" ? chunk.length > 0 : chunk.length > 0)) {
        if (typeof chunk === "string") {
          patchedWrite(chunk, encoding);
        } else {
          patchedWrite(chunk);
        }
      }
      if (queue.length === 0 && !pendingTimer) {
        finalizeEnd();
      }
      return stream;
    }) as NodeJS.WritableStream["end"];

    const patchedDestroy = (error?: Error) => {
      cancelTimer();
      queue.length = 0;
      queueBytesAhead = 0;
      if (originalDestroy) {
        originalDestroy(error);
      }
    };

    Object.defineProperty(stream, "write", { value: patchedWrite, configurable: true, writable: true });
    Object.defineProperty(stream, "end", { value: patchedEnd, configurable: true, writable: true });
    if (originalDestroy) {
      Object.defineProperty(stream, "destroy", { value: patchedDestroy, configurable: true, writable: true });
    }

    return target;
  };

  return {
    isActive: () => kbps > 0,
    bytesPerSecond: () => bytesPerSecond,
    kbps: () => kbps,
    setKbps,
    wrap,
  };
};
