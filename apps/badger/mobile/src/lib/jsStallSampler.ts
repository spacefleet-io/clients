/**
 * JS-thread stall sampler.
 *
 * A `setInterval` that expects to fire every `intervalMs`. When the JS thread is busy (a long parse, a
 * synchronous crypto call, a burst of native-module round trips) the callback fires late; the drift is the
 * time the thread was unavailable to touch handling and animations. Drifts of at least `thresholdMs` are
 * logged as `perf.js_stall` (console.warn, so they survive release log filtering) with the stall's start
 * offset from the sampler start; `perf.js_stall.max` summarises the worst one every `summaryMs`.
 *
 * Correlate the offsets with the `library.*` log lines in logcat to find what ran during a stall.
 *
 * Android pauses JS timers while the app is in the background, so the first tick after a return would report the
 * whole absence as a stall (a 20 s trip to the home screen logged `{"ms":21488}` on a OnePlus 6 test phone). With `subscribeAppState`
 * the sampler skips ticks while the app is not active and restarts its clock when it comes back.
 *
 * Only development builds run it (`startJsStallSamplerInDevBuild`): in a store build the 50 ms timer would wake the
 * JS thread twenty times a second, foreground and background, to measure nobody's stalls (#957, PERF-MOBILE-04).
 */

import { currentMobileBuildEnv, isMobileDevBuild, type MobileBuildEnv } from "./devBuild";

type Timer = ReturnType<typeof globalThis.setInterval>;

export type JsStallSamplerOptions = {
  intervalMs?: number;
  thresholdMs?: number;
  summaryMs?: number;
  now?: () => number;
  setInterval?: (cb: () => void, ms: number) => Timer;
  clearInterval?: (handle: Timer) => void;
  log?: (event: string, data: Record<string, number>) => void;
  /** Reports app activity (true = foreground); returns an unsubscribe. Time in the background is never a stall. */
  subscribeAppState?: (listener: (active: boolean) => void) => () => void;
};

export type JsStallSampler = {
  stop: () => void;
  /** Longest drift seen since the sampler started, in ms. */
  maxStallMs: () => number;
};

const defaultLog = (event: string, data: Record<string, number>) => console.warn(event, JSON.stringify(data));

export const startJsStallSampler = (options: JsStallSamplerOptions = {}): JsStallSampler => {
  const intervalMs = options.intervalMs ?? 50;
  const thresholdMs = options.thresholdMs ?? 100;
  const summaryMs = options.summaryMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? defaultLog;
  const startedAt = now();
  let last = startedAt;
  let max = 0;
  let lastSummaryAt = startedAt;
  let summaryMax = 0;
  let active = true;
  const unsubscribe = options.subscribeAppState?.((nowActive) => {
    active = nowActive;
    // Restart the clock on return: the gap since the last foreground tick is time away, not a stall.
    if (nowActive) last = now();
  });
  const timer = (options.setInterval ?? globalThis.setInterval)(() => {
    const t = now();
    if (!active) {
      // A tick in the background (or the first one after a return, before the "active" event) measures nothing.
      last = t;
      return;
    }
    const drift = t - last - intervalMs;
    const stallStart = last + intervalMs;
    last = t;
    if (drift > max) max = drift;
    if (drift > summaryMax) summaryMax = drift;
    if (drift >= thresholdMs) log("perf.js_stall", { ms: Math.round(drift), atMs: Math.round(stallStart - startedAt) });
    if (t - lastSummaryAt >= summaryMs) {
      log("perf.js_stall.max", { ms: Math.round(summaryMax), totalMaxMs: Math.round(max), atMs: Math.round(t - startedAt) });
      lastSummaryAt = t;
      summaryMax = 0;
    }
  }, intervalMs);
  return {
    stop: () => {
      (options.clearInterval ?? globalThis.clearInterval)(timer);
      unsubscribe?.();
    },
    maxStallMs: () => max,
  };
};

/**
 * Starts the sampler in a development build (`__DEV__`, or a `profile` build made for dev-stack testing with
 * `SF_DEV_TICKET_KEY=1`, the build the PLAT-TV-07 measurements use); returns null in a store build.
 */
export const startJsStallSamplerInDevBuild = (
  env: MobileBuildEnv = currentMobileBuildEnv(),
  options?: JsStallSamplerOptions
): JsStallSampler | null => (isMobileDevBuild(env) ? startJsStallSampler(options) : null);
