/**
 * @test-id PLAYBACK-ABR-DRAIN-DOWNSHIFT-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Badger Android phone suite on a OnePlus 6 test phone, case abr-recovery: "no quality switch within 95 s of
 * the 1000 kbit/s throttle (still 1002x420)": the reload to 420p was still fetching its first segment at +95 s; its switch
 * log only came at +102.7 s.
 *
 * Evidence (shard badger-phone-1, logcat): throttle at device time 1794556120.370. From +25 s the estimate sat at
 * ~0.99 Mbit/s against 2.25 Mbit/s + audio (x0.85 = ~2.02 Mbit/s needed). The buffer stayed pinned at 30 s until +60 s (a
 * prefetched 11 MB segment), then drained ~1 s/s (27.5 / 22.5 / 17.5 / 12.5 / 7.5 at +65..+85). The buffer-low rule
 * (< 5 s) fired at +88.5 s; the switch is a reload that had to fetch a whole 2.1 MB 420p segment at 1 Mbit/s first
 * (12.8 s), so the switch landed at +102.7 s, after the buffer had run dry.
 *
 * Fix (Option A, Main 2026-11-13): drain rule in `abrDecide`. Speed below the current rung's need AND the buffer falling AND,
 * at its measured drain rate, empty before the whole segment of the next rung down could be fetched (+ BUFFER_LOW_S) ->
 * step down then. Off without a drain rate, a position or segment sizes, and never on a healthy (not falling) buffer or a
 * sufficient link.
 */
import { describe, expect, it } from "vitest";
import {
  BUFFER_LOW_S,
  DRAIN_SWITCH_MARGIN_S,
  abrDecide,
  createAbrController,
  noteSwitchSettled,
  stepNetworkAbr,
  switchRefillSeconds,
  trackBufferDrain,
  type AbrAction,
  type AbrController,
  type AbrState,
  type CacheConfig,
  type Variant,
  type VariantSegment,
} from "../src";

const LOG = "[abr-drain-downshift]";
const MOBILE_CACHE: CacheConfig = { cacheSecs: 30, demuxerMaxBytes: 32 * 1024 * 1024 };
const SEGMENT_S = 12;
const segments = (bytes: number): VariantSegment[] =>
  Array.from({ length: 600 }, (_, i) => ({ startSeconds: i * SEGMENT_S, sizeBytes: bytes }));

// The suite's ladder: 1920x804 at 2250 kbit/s (1080p), 1002x420 at 716 kbit/s (420p); segment sizes from the run.
const R_1080 = (withSegments: boolean): Variant => ({
  id: "v-1080",
  quality: "1080p",
  codec: "h264",
  bitrateKbps: 2250,
  segments: withSegments ? segments(4_900_000) : undefined,
});
const R_420 = (withSegments: boolean): Variant => ({
  id: "v-420",
  quality: "420p",
  codec: "h264",
  bitrateKbps: 716,
  segments: withSegments ? segments(2_095_000) : undefined,
});
const ladder = (withSegments: boolean): Variant[] => [R_1080(withSegments), R_420(withSegments)];

const T0 = 1_794_556_120_370;
const THROTTLED_BPS = 990_000;
const START_POS_S = 200;

/** The run's buffer: pinned at 30 s for 60 s, 27.5 s at +65, then -1 s/s. */
const traceBuffer = (t: number): number => (t <= 60 ? 30 : t <= 65 ? 30 - 0.5 * (t - 60) : Math.max(0, 27.5 - (t - 65)));
/** Throughput estimate: still settling for the first 25 s, then ~0.99 Mbit/s. */
const traceBps = (t: number): number => (t < 25 ? 3_000_000 : THROTTLED_BPS);

const newController = (variants: Variant[]): AbrController => {
  const ctrl = createAbrController(variants, { quality: "1080p", force: false }, T0 - 120_000, null, { netBpsIsSmoothed: true });
  // Played for a minute before the throttle (first frame long past, no recent reload).
  for (let t = -60; t < 0; t += 1) {
    stepNetworkAbr(ctrl, variants, sample(t, 30, 20_000_000));
  }
  return ctrl;
};

const sample = (t: number, bufferSeconds: number, netBps: number, pausedForCache = false) => ({
  nowMs: T0 + t * 1000,
  voConfigured: true,
  pausedForCache,
  bufferSeconds,
  cacheReachedEof: false,
  netBps,
  cache: MOBILE_CACHE,
  position: START_POS_S + t,
});

type Switch = { t: number; bufferSeconds: number; action: Extract<AbrAction, { kind: "switch" }> };

/** Replays the throttled stretch at 1 Hz until the first switch (or `untilS`). */
const replayThrottle = (withSegments: boolean, untilS = 120): Switch | null => {
  const variants = ladder(withSegments);
  const ctrl = newController(variants);
  expect(ctrl.quality.currentId).toBe("v-1080");
  for (let t = 0; t <= untilS; t += 1) {
    const buffer = traceBuffer(t);
    const action = stepNetworkAbr(ctrl, variants, sample(t, buffer, traceBps(t)));
    if (action.kind === "switch") {
      console.info(`${LOG} segments=${withSegments} switch t=+${t}s buffer=${buffer}s detail=${JSON.stringify(action.detail)}`);
      return { t, bufferSeconds: buffer, action };
    }
  }
  console.info(`${LOG} segments=${withSegments} no switch within ${untilS}s`);
  return null;
};

describe("ABR drain rule (@bugfix @regression-proof abr-recovery)", () => {
  it("the refill a switch needs is the whole segment at the position, at the measured speed", () => {
    const refill = switchRefillSeconds(R_420(true), START_POS_S + 70, THROTTLED_BPS);
    expect(refill).not.toBeNull();
    expect(refill!).toBeCloseTo((2_095_000 * 8) / THROTTLED_BPS, 6);
    expect(switchRefillSeconds(R_420(false), START_POS_S, THROTTLED_BPS)).toBeNull();
    expect(switchRefillSeconds(R_420(true), START_POS_S, 0)).toBeNull();
    expect(DRAIN_SWITCH_MARGIN_S).toBe(BUFFER_LOW_S);
  });

  it("before (no drain inputs): the run's trace only steps down under BUFFER_LOW_S, with less buffer than the switch needs", () => {
    const hit = replayThrottle(false);
    expect(hit).not.toBeNull();
    expect(hit!.action.detail).toEqual({ action: "downshift", targetId: "v-420", reason: "buffer-low" });
    expect(hit!.bufferSeconds).toBeLessThan(BUFFER_LOW_S);
    const refill = switchRefillSeconds(R_420(true), START_POS_S + hit!.t, THROTTLED_BPS)!;
    // The reload would run the buffer dry: this is the stall the device showed.
    expect(hit!.bufferSeconds).toBeLessThan(refill);
  });

  /** @req PLAY-ABR-01[badger-mobile,badger-tv] */
  it("after: the same trace steps down on the drain while the buffer still covers the 420p segment fetch", () => {
    const hit = replayThrottle(true);
    expect(hit).not.toBeNull();
    expect(hit!.action.detail).toEqual({ action: "downshift", targetId: "v-420", reason: "drain" });
    const refill = switchRefillSeconds(R_420(true), START_POS_S + hit!.t, THROTTLED_BPS)!;
    expect(hit!.bufferSeconds).toBeGreaterThanOrEqual(refill);
    // Never while the buffer was still pinned (healthy) at 30 s.
    expect(hit!.t).toBeGreaterThan(60);
    const before = replayThrottle(false)!;
    expect(hit!.t).toBeLessThan(before.t);
  });

  it("no downshift on a healthy buffer: pinned at 30 s on a link too slow for the rung", () => {
    const variants = ladder(true);
    const ctrl = newController(variants);
    for (let t = 0; t <= 300; t += 1) {
      const action = stepNetworkAbr(ctrl, variants, sample(t, 30, THROTTLED_BPS));
      expect(action.kind, `t=+${t}s`).toBe("hold");
    }
  });

  it("no downshift while the link sustains the rung, even with the buffer falling", () => {
    const variants = ladder(true);
    const ctrl = newController(variants);
    for (let t = 0; t <= 20; t += 1) {
      const action = stepNetworkAbr(ctrl, variants, sample(t, 30 - t, 3_000_000));
      expect(action.kind, `t=+${t}s`).toBe("hold");
    }
  });

  it("no downshift while the buffer bobs around a healthy level (falls and refills)", () => {
    const variants = ladder(true);
    const ctrl = newController(variants);
    for (let t = 0; t <= 300; t += 1) {
      const buffer = 28 + 2 * Math.sin(t / 3);
      const action = stepNetworkAbr(ctrl, variants, sample(t, buffer, THROTTLED_BPS));
      expect(action.kind, `t=+${t}s buffer=${buffer.toFixed(2)}`).toBe("hold");
    }
  });

  /** @req PLAY-ABR-01[badger-mobile,badger-tv] @req PLAY-ABR-02[badger-mobile,badger-tv] */
  it("no oscillation: one drain downshift, then holds on the lower rung until the link recovers, then one climb", () => {
    const variants = [...ladder(true), { id: "v-240", quality: "240p", codec: "h264", bitrateKbps: 300, segments: segments(450_000) }];
    const ctrl = newController(variants);
    const switches: string[] = [];
    let t = 0;
    for (; t <= 120; t += 1) {
      const action = stepNetworkAbr(ctrl, variants, sample(t, traceBuffer(t), traceBps(t)));
      if (action.kind === "switch") {
        switches.push(`${action.targetId}@${t}`);
        break;
      }
    }
    expect(switches).toHaveLength(1);
    expect(ctrl.quality.currentId).toBe("v-420");
    noteSwitchSettled(ctrl, T0 + (t + 14) * 1000);
    // Still throttled: the 420p buffer refills, sometimes dips; the link sustains 420p, so nothing moves.
    for (let s = t + 15; s <= t + 300; s += 1) {
      const buffer = Math.min(30, 2 + (s - t - 15) * 0.2) - ((s % 10) < 3 ? 1 : 0);
      const action = stepNetworkAbr(ctrl, variants, sample(s, buffer, THROTTLED_BPS));
      if (action.kind === "switch") switches.push(`${action.targetId}@${s}`);
    }
    expect(switches).toHaveLength(1);
    // Throttle released: back to 1080p once, and stays there.
    const release = t + 301;
    for (let s = release; s <= release + 300; s += 1) {
      const action = stepNetworkAbr(ctrl, variants, sample(s, 30, 20_000_000));
      if (action.kind === "switch") {
        switches.push(`${action.targetId}@${s}`);
        noteSwitchSettled(ctrl, T0 + s * 1000);
      }
    }
    console.info(`${LOG} oscillation switches=${JSON.stringify(switches)}`);
    expect(switches.map((s) => s.split("@")[0])).toEqual(["v-420", "v-1080"]);
  });

  it("the drain rule is off without segment sizes, a position or a drain rate", () => {
    const base: AbrState = {
      variants: ladder(true),
      currentId: "v-1080",
      ewmaBps: THROTTLED_BPS,
      bufferSeconds: 15,
      underrunSinceMs: null,
      lastSwitchAtMs: null,
      nowMs: T0,
      bannedIds: new Set(),
      cacheReachedEof: false,
      loadStartedAtMs: T0 - 120_000,
      firstFrameAtMs: T0 - 119_000,
      lastReloadAtMs: null,
      cache: MOBILE_CACHE,
      bufferDrainRate: 1,
      positionSeconds: START_POS_S,
    };
    expect(abrDecide(base)).toEqual({ action: "downshift", targetId: "v-420", reason: "drain" });
    expect(abrDecide({ ...base, variants: ladder(false) })).toEqual({ action: "hold" });
    expect(abrDecide({ ...base, positionSeconds: null })).toEqual({ action: "hold" });
    expect(abrDecide({ ...base, bufferDrainRate: null })).toEqual({ action: "hold" });
    expect(abrDecide({ ...base, lastReloadAtMs: T0 - 1_000 })).toEqual({ action: "hold", downshiftHeld: "reload" });
  });

  it("the drain rate needs a falling buffer over at least DRAIN_MIN_SPAN_MS; a stall clears it", () => {
    const history: Parameters<typeof trackBufferDrain>[0] = [];
    expect(trackBufferDrain(history, 0, 30, false)).toBeNull();
    expect(trackBufferDrain(history, 1_000, 29, false)).toBeNull();
    expect(trackBufferDrain(history, 2_000, 28, false)).toBeNull();
    expect(trackBufferDrain(history, 3_000, 27, false)).toBeCloseTo(1, 6);
    expect(trackBufferDrain(history, 4_000, 31, false)).toBeNull();
    expect(trackBufferDrain(history, 5_000, 20, true)).toBeNull();
    expect(history).toHaveLength(0);
  });
});
