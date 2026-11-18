/**
 * Unified mpv client interface — main process (Unix socket) and renderer
 * (preload bridge) both implement this shape so consumers can be written
 * against one contract regardless of transport.
 *
 * Tier-3 of the @space/mpv-protocol consolidation. The interface is
 * pure-TS: no Node imports, no React. Implementations live in their own
 * packages (`apps/badger/desktop/src/main/mpvSocketClient.ts` for the
 * socket-backed main-process client; `packages/desktop-mpv-playback/src/
 * preloadMpvClient.ts` for the renderer client that wraps
 * `window.sf.sendExternalMpvCommand` / `sendExternalMpvRequest`).
 *
 * Mirrors the @space/runtime-contracts pattern: a typed boundary that both
 * sides agree on, with concrete transports plugged in by package.
 *
 * Notes on the interface:
 *   - `state` exposes the lifecycle gist the engine needs to gate calls
 *     ("ready" vs "connecting"). Full state machine consolidation is Tier-5;
 *     in Tier-3 the field is a snapshot, not a subscription.
 *   - `getProperty` / `setProperty` are typed wrappers that delegate to
 *     `request()` and reuse the helpers from `properties.ts` — they preserve
 *     the existing "null on failure" / "boolean on ack" semantics.
 *   - `observe` is part of the interface for forward-compatibility with
 *     Tier-4's `observe_property` push migration. Tier-3 implementations
 *     throw `"observe_not_implemented"` from `observe()`. Engine callers
 *     keep using the 250 ms poll loop for now.
 *   - `waitForReady(timeoutMs)` moves the 12-attempt `time-pos` retry from
 *     the engine's `ensureExternalReady` (externalMpvController.ts:58+)
 *     into the client.
 *   - `dispose()` consolidates the multi-step teardown currently spread
 *     across `stopMpv` (kill process, unlink socket, cleanup OSC poll
 *     timer + file, optionally rm dataDir). Must be idempotent —
 *     React 19 strict-mode double-effects + repeat user-stop both call it.
 *   - `AbortSignal` on `getProperty` / `setProperty` is reserved for
 *     Tier-4+; Tier-3 implementations accept the param but currently
 *     ignore it.
 */

import type { MpvCommand, MpvResponse } from "./bridge";
import type { LifecycleState } from "./lifecycle";
import type { MpvProperty, MpvPropertyValue } from "./properties";

export type MpvClientState = "idle" | "connecting" | "ready" | "disposed";

/**
 * Wrap a value-handling callback in a trailing-throttle. The wrapper
 * delivers AT MOST one value per `windowMs` window:
 *
 *   - First call inside an idle window: fire immediately.
 *   - Subsequent calls inside the same window: stash the latest value;
 *     fire it once the window closes.
 *   - If `flush()` is called, deliver any pending value immediately and
 *     reset the window. Used by observers on unsubscribe so the trailing
 *     value isn't silently dropped.
 *
 * Trailing-only semantics match how mpv's `observe_property` pushes
 * `time-pos` at decode rate (30-60 Hz). Holding the latest sample for
 * the next 250 ms window keeps the UI cadence identical to the prior
 * `setInterval(250)` poll without bursting at the leading edge of every
 * window.
 *
 * The helper is pure-TS so it lives in the protocol package alongside
 * the other shared primitives (`@space/runtime-contracts` precedent). It
 * defaults its timer source to `globalThis.setTimeout` / `clearTimeout`
 * so it composes with `vi.useFakeTimers()` and the renderer's
 * `window.setTimeout` shim alike.
 *
 * Tier-4 of the @space/mpv-protocol consolidation.
 */
export type ThrottledObserver<T> = {
  /** Push the next value through the throttle. */
  next: (value: T) => void;
  /** Deliver any pending value synchronously and reset the timer. */
  flush: () => void;
  /** Cancel the timer and drop the pending value without delivering. */
  cancel: () => void;
};

export type CreateTrailingThrottleOptions = {
  /**
   * Custom `setTimeout` implementation. Defaults to `globalThis.setTimeout`.
   * Useful for plumbing the renderer's `window.setTimeout` shim and for
   * test harnesses that swap in fake timers.
   */
  setTimeoutFn?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
};

export const createTrailingThrottle = <T>(
  callback: (value: T) => void,
  windowMs: number,
  options: CreateTrailingThrottleOptions = {},
): ThrottledObserver<T> => {
  if (!(windowMs > 0)) {
    // Pass-through: no throttling — every call fires immediately.
    return {
      next: callback,
      flush: () => undefined,
      cancel: () => undefined,
    };
  }
  const scheduleTimeout =
    options.setTimeoutFn ??
    ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const cancelTimeout =
    options.clearTimeoutFn ??
    ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  let pending: { value: T } | null = null;
  let timerHandle: ReturnType<typeof setTimeout> | null = null;
  let lastFireAt = 0;
  const scheduleFlush = (delay: number) => {
    if (timerHandle !== null) return;
    timerHandle = scheduleTimeout(() => {
      timerHandle = null;
      if (pending !== null) {
        const value = pending.value;
        pending = null;
        lastFireAt = Date.now();
        callback(value);
      }
    }, Math.max(0, delay));
  };
  return {
    next: (value: T) => {
      const now = Date.now();
      const elapsed = now - lastFireAt;
      if (elapsed >= windowMs && timerHandle === null) {
        // Leading edge: fire immediately. mpv's first push after a
        // subscription should not be delayed by a full window.
        lastFireAt = now;
        pending = null;
        callback(value);
        return;
      }
      // Inside an active window: stash the latest value; let the
      // pending flush deliver it once the window closes.
      pending = { value };
      const delay = Math.max(0, windowMs - elapsed);
      scheduleFlush(delay);
    },
    flush: () => {
      if (timerHandle !== null) {
        cancelTimeout(timerHandle);
        timerHandle = null;
      }
      if (pending !== null) {
        const value = pending.value;
        pending = null;
        lastFireAt = Date.now();
        callback(value);
      }
    },
    cancel: () => {
      if (timerHandle !== null) {
        cancelTimeout(timerHandle);
        timerHandle = null;
      }
      pending = null;
    },
  };
};

export type MpvObserveOptions = {
  /**
   * Throttle window in milliseconds. When set, the observer fires at most
   * once per window; the trailing value within the window is dispatched
   * once the window closes. Reserved for Tier-4 push-property migration.
   */
  throttleMs?: number;
};

export type MpvObserveUnsubscribe = () => void;

export type MpvObserveCallback<P extends MpvProperty> = (
  value: MpvPropertyValue<P> | null,
) => void;

/**
 * Tier-5 — push subscription on the full lifecycle state machine
 * (see `./lifecycle`). The callback fires with the current state on
 * subscription (so subscribers don't race the first transition) and
 * then again on every transition. Returns an unsubscribe function
 * that is safe to call multiple times.
 *
 * Used by the renderer-side `useMpvLifecycleStore` hook (in
 * `@space/desktop-mpv-playback`) to drop the 7 lifecycle refs in
 * `useMpvPlaybackEngine.ts` in favor of one explicit snapshot.
 */
export type SubscribeLifecycleCallback = (state: LifecycleState) => void;
export type SubscribeLifecycleUnsubscribe = () => void;

export interface MpvClient {
  /**
   * Coarse lifecycle snapshot. Kept as a simple field for backwards
   * compatibility with Tier-3 callers; the Tier-5 push subscription on
   * the full lifecycle state machine is available via
   * `subscribeLifecycle()`.
   */
  readonly state: MpvClientState;

  /**
   * Send a fire-and-forget command. The implementation MUST still wait for
   * the mpv ACK so script-message and similar commands aren't lost on
   * socket close (regression fix preserved from externalMpv.ts:184).
   */
  command(cmd: MpvCommand): Promise<MpvResponse>;

  /**
   * Send a request and resolve with mpv's correlated response.
   */
  request(cmd: MpvCommand): Promise<MpvResponse>;

  /**
   * Typed property read. Returns `null` when mpv reports a real error or
   * the response is malformed (preserves existing "soft failure" semantics
   * that callers already handle).
   *
   * `signal` is accepted but ignored in Tier-3 implementations; Tier-4+
   * may wire cancellation through the transport layer.
   */
  getProperty<P extends MpvProperty>(
    property: P,
    signal?: AbortSignal,
  ): Promise<MpvPropertyValue<P> | null>;

  /**
   * Typed property write. Returns true on `error: "success"` (or no error
   * field), false on real failure.
   *
   * `signal` is accepted but ignored in Tier-3 implementations.
   */
  setProperty<P extends MpvProperty>(
    property: P,
    value: MpvPropertyValue<P>,
    signal?: AbortSignal,
  ): Promise<boolean>;

  /**
   * Subscribe to property-change events. Returns an unsubscribe function.
   *
   * Tier-3 implementations throw `"observe_not_implemented"` — the engine
   * continues to use polling. Tier-4 fills this in by wiring
   * `observe_property` for the push-friendly subset (time-pos, duration,
   * pause, mute, volume, eof-reached) and using the multiplexed
   * `sf-mpv-external-message` channel.
   */
  observe<P extends MpvProperty>(
    property: P,
    callback: MpvObserveCallback<P>,
    options?: MpvObserveOptions,
  ): MpvObserveUnsubscribe;

  /**
   * Poll `time-pos` until mpv responds successfully (12 attempts with
   * 150 ms + attempt × 25 ms backoff, matching the engine pattern).
   * Returns true if mpv responded with a usable shape within the budget,
   * false on timeout. Idempotent — concurrent callers share the same
   * in-flight promise.
   */
  waitForReady(timeoutMs: number): Promise<boolean>;

  /**
   * Tear down the underlying transport and any owned resources. Must be
   * idempotent. After resolution, `state` is `"disposed"` and subsequent
   * `command`/`request` calls reject or return synthetic-error responses
   * (implementations document their choice).
   */
  dispose(): Promise<void>;

  /**
   * Subscribe to lifecycle state transitions. The callback fires
   * synchronously with the current state once at registration, then
   * again on every subsequent transition. Returns an unsubscribe
   * function that is safe to call multiple times.
   *
   * Tier-5 — replaces the renderer's 7 lifecycle refs in
   * `useMpvPlaybackEngine.ts` with one explicit snapshot. Implementations
   * dispatch the pure reducer from `./lifecycle` on every internal event
   * source (process spawn, socket events, exit, dispose, user-stop)
   * and emit the resulting state to subscribers.
   */
  subscribeLifecycle(
    callback: SubscribeLifecycleCallback,
  ): SubscribeLifecycleUnsubscribe;
}
