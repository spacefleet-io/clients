/**
 * @test-id PLAYBACK-ABR-NETWORK-ONLY-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * The network-only entry point (`stepNetworkAbr`) is the desktop's network half: it runs after `stepDecoder` (which owns the
 * device-can't-keep-up path, see decode-fallback.test.ts), with the desktop's own
 * mpv cache (16 s / 96 MiB) and a first frame that is an event (`firstFrameFrom: "event"`). Chris 2026-10-15: desktop and
 * mobile share ONE auto-quality package, so the product rules must hold through this entry point too:
 *  - Auto steps down when bandwidth drops and climbs back to the Settings quality when it recovers, in bounded time;
 *  - there is NO rung ban after a network downshift (the desktop used to ban the rung it left, forever);
 *  - the upshift buffer gate is reachable with the desktop's cache (it used to need 20 s with a 16 s cache);
 *  - "Force this quality" / a manual pick (mode "manual") never switches, whatever the network does; when the link cannot
 *    sustain the pinned rung it gets a `warn` (PLAY-QUAL-03), rate limited, recommending the best lower rung that fits.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_CLIMB_HOLD_MS,
  PINNED_WARN_COOLDOWN_MS,
  createAbrController,
  noteFirstFrame,
  noteLaunch,
  noteLoadStarted,
  noteSessionStarted,
  noteSwitchSettled,
  qualityRank,
  reachableBufferSeconds,
  stepNetworkAbr,
  type CacheConfig,
  type QualityMode,
  type Variant,
} from "../src";

const LOG = "[network-only]";
const DESKTOP_CACHE: CacheConfig = { cacheSecs: 16, demuxerMaxBytes: 96 * 1024 * 1024 };
const v = (id: string, quality: string, codec: string, bitrateKbps: number): Variant => ({ id, quality, codec, bitrateKbps });
const ladder = [v("u", "2160p", "hevc", 15_000), v("f", "1080p", "h264", 6_000), v("h", "720p", "h264", 2_500), v("s", "480p", "h264", 1_000)];
const FAST = 60e6;
const SLOW = 1.5e6;

type SimOptions = { ceiling: string; mode: QualityMode; seconds: number; capacityBps: (tSec: number) => number };
type SimEvent = { tSec: number; from: string; to: string; reason: string };

/** Minimal player model the way the desktop engine drives it: 1 Hz ticks, a reload per switch, mpv's playback-restart = first frame. */
const simulate = (opts: SimOptions) => {
  const ctrl = createAbrController(ladder, { quality: opts.ceiling as "1080p", force: opts.mode === "manual" }, 0, null, { firstFrameFrom: "event" });
  noteLaunch(ctrl);
  noteSessionStarted(ctrl, 0);
  noteLoadStarted(ctrl, 0);
  noteFirstFrame(ctrl, 1_000);
  const events: SimEvent[] = [];
  let buffer = 0;
  let stalled = true;
  for (let t = 0; t <= opts.seconds; t++) {
    const nowMs = t * 1000;
    const current = ladder.find((candidate) => candidate.id === ctrl.quality.currentId)!;
    const bps = ((current.bitrateKbps ?? 5000) + 128) * 1000;
    const reachable = reachableBufferSeconds(DESKTOP_CACHE, current);
    const capacity = opts.capacityBps(t);
    const fetching = buffer < reachable - 0.5;
    buffer = Math.min(reachable, Math.max(0, buffer + (fetching ? capacity / bps : 0)));
    if (stalled && buffer >= 2) stalled = false;
    if (!stalled) {
      buffer = Math.max(0, buffer - 1);
      if (buffer <= 0) stalled = true;
    }
    ctrl.settingsCeilingRank = qualityRank(opts.ceiling as "1080p");
    ctrl.quality = { ...ctrl.quality, mode: opts.mode };
    const action = stepNetworkAbr(ctrl, ladder, {
      nowMs,
      voConfigured: true,
      pausedForCache: stalled,
      bufferSeconds: buffer,
      cacheReachedEof: false,
      netBps: fetching ? capacity : 0,
      cache: DESKTOP_CACHE,
    });
    if (action.kind === "switch") {
      const target = ladder.find((candidate) => candidate.id === action.targetId)!;
      events.push({ tSec: t, from: current.quality, to: target.quality, reason: action.reason });
      // The engine reloads the new rung: the buffer starts empty and the reload clock restarts.
      noteSwitchSettled(ctrl, nowMs);
      noteFirstFrame(ctrl, nowMs + 500);
      buffer = 0;
      stalled = false;
    }
  }
  console.info(`${LOG} switches: ${JSON.stringify(events)}`);
  return { ctrl, events };
};

describe("network-only ABR with the desktop cache (16 s / 96 MiB)", () => {
  /** @req PLAY-ABR-01[badger-desktop,badger-mobile] @req PLAY-ABR-02[badger-desktop,badger-mobile] */
  it("@bugfix @regression-proof steps down under throttle, and is back at the Settings quality in bounded time, with no rung banned", () => {
    const throttleEnd = 240;
    const { ctrl, events } = simulate({ ceiling: "1080p", mode: "auto", seconds: 900, capacityBps: (t) => (t >= 60 && t < throttleEnd ? SLOW : FAST) });
    const down = events.find((event) => event.reason === "abr-downshift");
    const back = events.find((event) => event.tSec >= throttleEnd && event.reason === "abr-upshift" && event.to === "1080p");
    console.info(`${LOG} first downshift at ${down?.tSec}s, back at 1080p at ${back?.tSec}s (throttle ended ${throttleEnd}s)`);
    expect(down, "Auto must step down when bandwidth drops").toBeDefined();
    expect(back, "Auto must climb back to the Settings quality").toBeDefined();
    expect(back!.tSec - throttleEnd).toBeLessThanOrEqual(MAX_CLIMB_HOLD_MS / 1000 + 30);
    expect(ctrl.quality.bannedIds).toEqual([]);
  });

  /** @req PLAY-ABR-02[badger-desktop,badger-mobile] */
  it("@bugfix @regression-proof recovers after repeated throttle cycles (the climb hold backs off but is capped)", () => {
    const cycles = [[60, 120], [200, 260], [340, 400]];
    const throttled = (t: number) => cycles.some(([from, to]) => t >= from! && t < to!);
    const lastEnd = cycles[cycles.length - 1]![1]!;
    const { events } = simulate({ ceiling: "1080p", mode: "auto", seconds: 1_200, capacityBps: (t) => (throttled(t) ? SLOW : FAST) });
    const back = events.find((event) => event.tSec >= lastEnd && event.reason === "abr-upshift" && event.to === "1080p");
    console.info(`${LOG} back at the top at ${back?.tSec}s (last throttle ended ${lastEnd}s)`);
    expect(back).toBeDefined();
    expect(back!.tSec - lastEnd).toBeLessThanOrEqual(MAX_CLIMB_HOLD_MS / 1000 + 30);
  });

  /** @req PLAY-QUAL-02[badger-desktop,badger-mobile,badger-tv] */
  it("never climbs above the Settings quality", () => {
    const { ctrl } = simulate({ ceiling: "720p", mode: "auto", seconds: 600, capacityBps: () => FAST });
    expect(ladder.find((candidate) => candidate.id === ctrl.quality.currentId)!.quality).toBe("720p");
  });

  /** @req PLAY-QUAL-04[badger-desktop,badger-mobile,badger-tv] */
  it("a pinned rung (Force, or a pick inside the player) makes zero switches through a throttle cycle", () => {
    const { events } = simulate({ ceiling: "1080p", mode: "manual", seconds: 600, capacityBps: (t) => (t >= 60 && t < 240 ? SLOW : FAST) });
    console.info(`${LOG} pinned 1080p, throttle cycle: ${events.length} switches`);
    expect(events).toEqual([]);
  });

  it("holds before the player is past its ready gate", () => {
    const ctrl = createAbrController(ladder, { quality: "1080p", force: false }, 0, null, { firstFrameFrom: "event" });
    const action = stepNetworkAbr(ctrl, ladder, {
      nowMs: 120_000,
      voConfigured: false,
      pausedForCache: true,
      bufferSeconds: 0,
      cacheReachedEof: false,
      netBps: 100_000,
      cache: DESKTOP_CACHE,
    });
    expect(action).toEqual({ kind: "hold" });
  });

  it("@bugfix @regression-proof a reader at EOF with an empty-looking buffer is not starvation (no downshift)", () => {
    const ctrl = createAbrController(ladder, { quality: "1080p", force: false }, 0, null, { firstFrameFrom: "event" });
    noteLaunch(ctrl);
    noteSessionStarted(ctrl, 0);
    noteLoadStarted(ctrl, 0);
    noteFirstFrame(ctrl, 1_000);
    for (let t = 60; t <= 120; t++) {
      const action = stepNetworkAbr(ctrl, ladder, {
        nowMs: t * 1000,
        voConfigured: true,
        pausedForCache: false,
        bufferSeconds: 0.3,
        cacheReachedEof: true,
        netBps: 0,
        cache: DESKTOP_CACHE,
      });
      expect(action, `t=${t}`).toEqual({ kind: "hold" });
    }
  });

  describe("pinned rung network warning (PLAY-QUAL-03)", () => {
    const pinned = () => {
      const ctrl = createAbrController(ladder, { quality: "1080p", force: true }, 0, null, { firstFrameFrom: "event" });
      noteLaunch(ctrl);
      noteSessionStarted(ctrl, 0);
      noteLoadStarted(ctrl, 0);
      noteFirstFrame(ctrl, 1_000);
      return ctrl;
    };
    const sample = (nowMs: number, netBps: number, extra: { cacheReachedEof?: boolean } = {}) => ({
      nowMs,
      voConfigured: true,
      pausedForCache: false,
      bufferSeconds: 12,
      cacheReachedEof: extra.cacheReachedEof ?? false,
      netBps,
      cache: DESKTOP_CACHE,
    });

    /** @req PLAY-QUAL-03[badger-desktop] */
    it("@bugfix @regression-proof warns once a minute with the best lower rung the link sustains, and never switches", () => {
      const ctrl = pinned();
      // 3 Mbps sustains 720p ((2500+128) kbps * 0.85 = 2.23 Mbps) but not 1080p.
      const actions = [];
      for (let t = 10; t <= 130; t++) actions.push({ t, action: stepNetworkAbr(ctrl, ladder, sample(t * 1000, 3e6)) });
      const warns = actions.filter((a) => a.action.kind === "warn");
      console.info(`${LOG} pinned warns at ${JSON.stringify(warns.map((w) => w.t))}`);
      expect(warns.map((w) => w.t)).toEqual([10, 10 + PINNED_WARN_COOLDOWN_MS / 1000, 10 + (2 * PINNED_WARN_COOLDOWN_MS) / 1000]);
      expect(warns[0]!.action).toEqual({ kind: "warn", reason: "pinned-network-insufficient", recommendedId: "h" });
      expect(actions.some((a) => a.action.kind === "switch")).toBe(false);
      expect(ctrl.quality.currentId).toBe("f");
    });

    /** @req PLAY-QUAL-03[badger-desktop] */
    it("does not warn when the pinned rung is sustainable, when nothing lower fits, or at the end of the file", () => {
      const sustainable = pinned();
      expect(stepNetworkAbr(sustainable, ladder, sample(10_000, FAST))).toEqual({ kind: "hold" });
      const hopeless = pinned();
      expect(stepNetworkAbr(hopeless, ladder, sample(10_000, 100_000))).toEqual({ kind: "hold" });
      const eof = pinned();
      expect(stepNetworkAbr(eof, ladder, sample(10_000, 3e6, { cacheReachedEof: true }))).toEqual({ kind: "hold" });
    });

    /** @req PLAY-QUAL-03[badger-desktop] */
    it("stays silent while the load is still waiting for its first frame (an empty link reading is not a verdict)", () => {
      const ctrl = createAbrController(ladder, { quality: "1080p", force: true }, 0, null, { firstFrameFrom: "event" });
      noteLaunch(ctrl);
      noteSessionStarted(ctrl, 0);
      noteLoadStarted(ctrl, 0);
      expect(stepNetworkAbr(ctrl, ladder, sample(4_000, 3e6))).toEqual({ kind: "hold" });
      noteFirstFrame(ctrl, 4_500);
      expect(stepNetworkAbr(ctrl, ladder, sample(5_000, 3e6))).toEqual({ kind: "hold" });
      expect(stepNetworkAbr(ctrl, ladder, sample(8_000, 3e6)).kind).toBe("warn");
    });

    it("Auto never returns a warn", () => {
      const ctrl = createAbrController(ladder, { quality: "1080p", force: false }, 0, null, { firstFrameFrom: "event" });
      noteLaunch(ctrl);
      noteSessionStarted(ctrl, 0);
      noteLoadStarted(ctrl, 0);
      noteFirstFrame(ctrl, 1_000);
      for (let t = 10; t < 100; t++) expect(stepNetworkAbr(ctrl, ladder, sample(t * 1000, 3e6)).kind).not.toBe("warn");
    });
  });
});
