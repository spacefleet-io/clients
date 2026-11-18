/**
 * @test-id PLAYBACK-ABR-RULES-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Auto-quality product rules (Chris, identical on every client):
 *  1. Auto is the default; the Settings quality is both the start rung and the ceiling; "Force this quality" pins one rung.
 *  2. Network: step down on low bandwidth, climb back to the Settings quality when it recovers, within a bounded time.
 *     Desktop shipped two bugs, checked here for BOTH clients' mpv cache configs (the package has no default cache):
 *       a. a rung was banned after a downshift and the ban was never lifted -> Auto could never get back to the top;
 *       b. upshift needed a 20 s buffer while the player is configured to buffer less (desktop 16 s) -> the gate could never open.
 *  3. Decoder: "network too slow" is told apart from "device cannot decode this"; decode-bound switches to the H.264 rendition
 *     of the same resolution (else the best lower H.264 rung); the codec downgrade is sticky for the file and never overrides Force.
 *
 * Every test logs what it measured (console.info) so a red/green run is self-explanatory.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_CLIMB_HOLD_MS,
  abrDecide,
  applyAbrDecision,
  cacheReachedEnd,
  createAbrController,
  createLagDetector,
  isHevcCodec,
  noteSwitchSettled,
  planHevcFallback,
  qualityRank,
  reachableBufferSeconds,
  stepAbr,
  stepLagDetector,
  type AbrState,
  type CacheConfig,
  type DecodeSample,
  type LagVerdict,
  type QualitySetting,
  type QualityState,
  type Variant,
} from "../src";

const v = (id: string, quality: string, codec: string, bitrateKbps: number): Variant => ({ id, quality, codec, bitrateKbps });

/** A realistic ladder: HEVC original 2160p, H.264 1080p + HEVC 1080p original, H.264 renditions below. */
const ladder = [
  v("u", "2160p", "hevc", 15_000),
  v("f", "1080p", "h264", 6_000),
  v("fh", "1080p", "hevc", 3_500),
  v("h", "720p", "h264", 2_500),
  v("s", "480p", "h264", 1_000),
];

/** Mobile's native player cache (MpvSurfaceView.kt: cache-secs 30, demuxer-max-bytes 32MiB; pinned in the mobile tests). */
const MOBILE_CACHE: CacheConfig = { cacheSecs: 30, demuxerMaxBytes: 32 * 1024 * 1024 };
/** Desktop's external mpv cache (@space/mpv external.ts: cache-secs 16, demuxer-max-bytes 96 MiB). */
const DESKTOP_CACHE: CacheConfig = { cacheSecs: 16, demuxerMaxBytes: 96 * 1024 * 1024 };
const CLIENT_CACHES: ReadonlyArray<readonly [string, CacheConfig]> = [
  ["mobile 30 s / 32 MiB", MOBILE_CACHE],
  ["desktop 16 s / 96 MiB", DESKTOP_CACHE],
];

const autoState = (currentId: string, over: Partial<QualityState> = {}): QualityState => ({
  mode: "auto",
  currentId,
  bannedIds: [],
  lastSwitchAtMs: null,
  lastReason: "start",
  ...over,
});

const abr = (over: Partial<AbrState> = {}): AbrState => ({
  variants: ladder,
  currentId: "f",
  ewmaBps: 40e6,
  bufferSeconds: 12,
  underrunSinceMs: null,
  lastSwitchAtMs: null,
  nowMs: 1_000_000,
  bannedIds: new Set(),
  cacheReachedEof: false,
  loadStartedAtMs: 0,
  firstFrameAtMs: 1_000,
  lastReloadAtMs: null,
  cache: MOBILE_CACHE,
  ...over,
});

describe("rule 2a: no sticky rung blacklist after a network downshift", () => {
  it("@bugfix @regression-proof applyAbrDecision never bans the rung a network downshift leaves", () => {
    const next = applyAbrDecision(autoState("f"), { action: "downshift", targetId: "h", reason: "underrun" }, 5_000);
    console.info(`[abr-rules] bannedIds after downshift 1080p->720p = ${JSON.stringify(next.bannedIds)}`);
    expect(next.currentId).toBe("h");
    expect(next.bannedIds, "a network downshift must not blacklist the rung: the network can recover").toEqual([]);
  });

  it("@bugfix @regression-proof after downshift + recovery Auto can climb back to the rung it left", () => {
    // Settings quality 1080p => ceiling rank 1; the 1080p original (HEVC) is the rung Auto left.
    let state = applyAbrDecision(autoState("fh"), { action: "downshift", targetId: "h", reason: "underrun" }, 5_000);
    const recovered = abr({ currentId: state.currentId, bannedIds: new Set(state.bannedIds), lastSwitchAtMs: 5_000, nowMs: 5_000 + 60_000, bufferSeconds: 25, ewmaBps: 40e6, ceilingRank: 1 });
    const decision = abrDecide(recovered);
    console.info(`[abr-rules] decision on a recovered link 60 s after the downshift = ${JSON.stringify(decision)}`);
    expect(decision).toEqual({ action: "upshift", targetId: "fh" });
    state = applyAbrDecision(state, decision, recovered.nowMs);
    expect(state.currentId).toBe("fh");
  });
});

describe.each(CLIENT_CACHES)("rule 2b: the upshift gate is reachable with the configured mpv cache (%s)", (_label, cache) => {
  it("@bugfix @regression-proof every rung's upshift buffer threshold is below what mpv can actually hold", () => {
    console.info(`[abr-rules] mpv cache config: cache-secs=${cache.cacheSecs} demuxer-max-bytes=${cache.demuxerMaxBytes}`);
    for (const rung of ladder.filter((candidate) => candidate.id !== "u")) {
      const reachable = reachableBufferSeconds(cache, rung);
      // Probe the gate: the lowest buffer level at which a healthy link makes Auto upshift from this rung.
      const target = ladder.find((candidate) => candidate.quality === (rung.quality === "480p" ? "720p" : rung.quality === "720p" ? "1080p" : "2160p"));
      if (!target || target.id === rung.id) continue;
      let gate: number | null = null;
      for (let buffer = 0; buffer <= reachable + 0.001; buffer += 0.25) {
        const d = abrDecide(abr({ cache, currentId: rung.id, bufferSeconds: buffer, lastSwitchAtMs: null, ewmaBps: 200e6 }));
        if (d.action === "upshift") {
          gate = buffer;
          break;
        }
      }
      console.info(`[abr-rules] rung ${rung.id} (${rung.quality} ${rung.codec} ${rung.bitrateKbps} kbps): mpv holds at most ${reachable.toFixed(1)} s, upshift gate opens at ${gate === null ? "never" : `${gate.toFixed(2)} s`}`);
      expect(gate, `upshift from ${rung.id} must open at some buffer level mpv can reach (max ${reachable.toFixed(1)} s)`).not.toBeNull();
    }
  });

  it("@bugfix @regression-proof a high-bitrate rung capped by demuxer-max-bytes can still upshift", () => {
    // 2160p HEVC at 90 Mbps: a few MiB of packets hold only a handful of seconds, far below any fixed 20 s gate.
    const heavy = [v("u", "2160p", "hevc", 90_000), v("f", "1080p", "h264", 30_000), v("fh", "1080p", "hevc", 25_000)];
    const reachable = reachableBufferSeconds(cache, heavy[1]!);
    const d = abrDecide(abr({ cache, variants: heavy, currentId: "f", bufferSeconds: reachable, ewmaBps: 400e6 }));
    console.info(`[abr-rules] heavy ladder: 1080p holds ${reachable.toFixed(1)} s at most; decision at full buffer = ${JSON.stringify(d)}`);
    expect(d).toEqual({ action: "upshift", targetId: "u" });
  });
});

describe("rule 3: decode-bound is not network-bound", () => {
  const sample = (over: Partial<DecodeSample & { bufferSeconds: number; avsyncSeconds: number | null }>): DecodeSample => ({
    nowMs: 0,
    sampledAtMs: over.nowMs ?? 0,
    timePos: 10,
    paused: false,
    pausedForCache: false,
    seeking: false,
    droppedFrames: 0,
    hwdecCurrent: "mediacodec",
    videoCodecIsNonH264: true,
    ...over,
  });

  it("@bugfix @regression-proof frame drops with a starved buffer are a network problem, not decode lag", () => {
    const detector = createLagDetector();
    stepLagDetector(detector, sample({ nowMs: 0, timePos: 10, bufferSeconds: 0.4 } as never));
    const verdict = stepLagDetector(detector, sample({ nowMs: 5_000, timePos: 15, droppedFrames: 120, bufferSeconds: 0.4 } as never));
    console.info(`[abr-rules] verdict with buffer 0.4 s and 120 drops = ${JSON.stringify(verdict)}`);
    expect(verdict.lag).toBe(false);
  });

  it("@bugfix @regression-proof drops with a healthy buffer are decode lag, for H.264 too", () => {
    const detector = createLagDetector();
    stepLagDetector(detector, sample({ nowMs: 0, timePos: 10, videoCodecIsNonH264: false, bufferSeconds: 25 } as never));
    const verdict = stepLagDetector(detector, sample({ nowMs: 5_000, timePos: 15, droppedFrames: 120, videoCodecIsNonH264: false, bufferSeconds: 25 } as never));
    console.info(`[abr-rules] H.264 verdict with buffer 25 s and 120 drops = ${JSON.stringify(verdict)}`);
    expect(verdict).toEqual({ lag: true, reason: "frame-drops" });
  });

  it("@bugfix @regression-proof sustained A/V desync with a healthy buffer is decode lag", () => {
    const detector = createLagDetector();
    let verdict: LagVerdict = { lag: false };
    for (let t = 0; t <= 6_000 && !verdict.lag; t += 500) {
      verdict = stepLagDetector(detector, sample({ nowMs: t, timePos: 10 + t / 1000, bufferSeconds: 25, avsyncSeconds: 1.2 } as never));
    }
    console.info(`[abr-rules] verdict with avsync 1.2 s, buffer 25 s = ${JSON.stringify(verdict)}`);
    expect(verdict).toEqual({ lag: true, reason: "avsync" });
  });

  it("sticky codec downgrade: HEVC is banned for the file and a recovered link never climbs back into it", () => {
    const plan = planHevcFallback(ladder, autoState("fh"), 10_000)!;
    expect(plan.target.id).toBe("f");
    let state = plan.state;
    for (let t = 20_000; t <= 20_000 + 3_600_000; t += 30_000) {
      const d = abrDecide(abr({ currentId: state.currentId, bannedIds: new Set(state.bannedIds), lastSwitchAtMs: state.lastSwitchAtMs, nowMs: t, bufferSeconds: 25, ewmaBps: 400e6 }));
      if (d.action === "upshift") state = applyAbrDecision(state, d, t);
    }
    const final = ladder.find((candidate) => candidate.id === state.currentId)!;
    console.info(`[abr-rules] after 1 h of healthy network the file plays ${final.quality} ${final.codec}`);
    expect(final.codec).toBe("h264");
  });
});

// --- End-to-end controller simulation (the same `stepAbr` the player runs per snapshot) -------------------

type SimEvent = { tSec: number; from: string; to: string; trigger: string; reason: string };

type SimOptions = {
  /** Ladder the file has; default the shared `ladder`. */
  variants?: Variant[];
  setting: QualitySetting;
  seconds: number;
  /** Network capacity in bits/s at second `t`. */
  capacityBps: (tSec: number) => number;
  /** Frames dropped during this second while playing `variant` (the device cannot decode it). */
  dropsPerSec?: (tSec: number, variant: Variant) => number;
  /** The client's mpv cache; default mobile's. */
  cache?: CacheConfig;
};

/** Minimal player model: buffer fills at capacity/bitrate, drains 1 s/s, stalls at 0, a switch flushes the cache. */
const simulate = (opts: SimOptions) => {
  const vs = opts.variants ?? ladder;
  const cache = opts.cache ?? MOBILE_CACHE;
  const ctrl = createAbrController(vs, opts.setting, 0);
  const events: SimEvent[] = [];
  const timeline: string[] = [];
  let buffer = 0;
  let position = 1;
  let stalled = true;
  let dropped = 0;
  for (let t = 0; t <= opts.seconds; t++) {
    const nowMs = t * 1000;
    const current = vs.find((candidate) => candidate.id === ctrl.quality.currentId)!;
    const bps = ((current.bitrateKbps ?? 5000) + 128) * 1000;
    const reachable = reachableBufferSeconds(cache, current);
    const capacity = opts.capacityBps(t);
    const fetching = buffer < reachable - 0.5;
    buffer = Math.min(reachable, Math.max(0, buffer + (fetching ? capacity / bps : 0)));
    if (stalled && buffer >= 2) stalled = false;
    if (!stalled) {
      buffer = Math.max(0, buffer - 1);
      position += 1;
      dropped += opts.dropsPerSec?.(t, current) ?? 0;
      if (buffer <= 0) stalled = true;
    }
    const action = stepAbr(ctrl, vs, {
      nowMs,
      sampledAtMs: nowMs,
      voConfigured: true,
      position,
      paused: false,
      pausedForCache: stalled,
      seeking: false,
      bufferSeconds: buffer,
      cacheReachedEof: cacheReachedEnd(7_200, position + buffer),
      cache,
      netBps: fetching ? capacity : 0,
      droppedFrames: dropped,
      hwdec: "mediacodec",
      videoCodec: current.codec,
      avsyncSeconds: null,
    });
    if (action.kind === "switch") {
      const target = vs.find((candidate) => candidate.id === action.targetId)!;
      events.push({ tSec: t, from: `${current.quality} ${current.codec}`, to: `${target.quality} ${target.codec}`, trigger: action.trigger, reason: action.reason });
      noteSwitchSettled(ctrl, nowMs);
      buffer = 0;
      stalled = false;
    }
    if (t % 30 === 0) timeline.push(`t=${t}s ${vs.find((candidate) => candidate.id === ctrl.quality.currentId)!.quality} buf=${buffer.toFixed(1)}s`);
  }
  console.info(`[abr-rules] sim timeline: ${timeline.join(" | ")}`);
  console.info(`[abr-rules] sim switches: ${JSON.stringify(events)}`);
  return { ctrl, events };
};

const AUTO_1080: QualitySetting = { quality: "1080p", force: false };
const FORCE_1080: QualitySetting = { quality: "1080p", force: true };
const FAST = 60e6;
const SLOW = 1.5e6;

describe.each(CLIENT_CACHES)("rule 2: Auto follows the network down and back up (controller simulation, %s)", (_label, cache) => {
  it("@bugfix @regression-proof steps down under throttle and is back at the Settings quality within a bounded time", () => {
    const throttleEnd = 240;
    const { ctrl, events } = simulate({ cache, setting: AUTO_1080, seconds: 900, capacityBps: (t) => (t >= 60 && t < throttleEnd ? SLOW : FAST) });
    const down = events.find((event) => event.trigger === "network" && event.reason === "abr-downshift");
    const back = events.find((event) => event.tSec >= throttleEnd && event.reason === "abr-upshift" && event.to.startsWith("1080p"));
    console.info(`[abr-rules] first downshift at ${down?.tSec}s, back at the Settings quality at ${back?.tSec}s (throttle ended ${throttleEnd}s)`);
    expect(down, "Auto must step down when bandwidth drops").toBeDefined();
    expect(back, "Auto must climb back to the Settings quality").toBeDefined();
    expect(back!.tSec - throttleEnd, "recovery time is bounded").toBeLessThanOrEqual(MAX_CLIMB_HOLD_MS / 1000 + 30);
    expect(ctrl.quality.bannedIds).toEqual([]);
  });

  it("@bugfix @regression-proof stays bounded after repeated throttle cycles (anti-flap backs off but is capped)", () => {
    const cycles = [[60, 120], [200, 260], [340, 400]];
    const throttled = (t: number) => cycles.some(([from, to]) => t >= from! && t < to!);
    const lastEnd = cycles[cycles.length - 1]![1]!;
    const { events } = simulate({ cache, setting: AUTO_1080, seconds: 1_200, capacityBps: (t) => (throttled(t) ? SLOW : FAST) });
    const back = events.find((event) => event.tSec >= lastEnd && event.reason === "abr-upshift" && event.to.startsWith("1080p"));
    console.info(`[abr-rules] after ${cycles.length} throttle cycles back at the top at ${back?.tSec}s (last throttle ended ${lastEnd}s)`);
    expect(back).toBeDefined();
    expect(back!.tSec - lastEnd).toBeLessThanOrEqual(MAX_CLIMB_HOLD_MS / 1000 + 30);
  });

  it("never climbs above the Settings quality", () => {
    const { ctrl } = simulate({ cache, setting: { quality: "720p", force: false }, seconds: 600, capacityBps: () => FAST });
    const final = ladder.find((candidate) => candidate.id === ctrl.quality.currentId)!;
    console.info(`[abr-rules] Settings 720p on a fast link plays ${final.quality}`);
    expect(final.quality).toBe("720p");
  });
});

describe("rule 1: Force this quality pins the rung", () => {
  it("makes zero switches through a throttle cycle", () => {
    const { ctrl, events } = simulate({ setting: FORCE_1080, seconds: 600, capacityBps: (t) => (t >= 60 && t < 240 ? SLOW : FAST) });
    console.info(`[abr-rules] forced 1080p, throttle cycle: ${events.length} switches`);
    expect(events).toEqual([]);
    expect(ctrl.quality.mode).toBe("manual");
  });

  it("makes zero switches under decode lag, and raises the pinned notice once instead", () => {
    const ctrl = createAbrController(ladder, FORCE_1080, 0);
    let verdicts = 0;
    let drops = 0;
    for (let t = 0; t < 120; t++) {
      drops += 40;
      const action = stepAbr(ctrl, ladder, {
        nowMs: t * 1000, sampledAtMs: t * 1000, voConfigured: true, position: 10 + t, paused: false, pausedForCache: false, seeking: false,
        bufferSeconds: 25, cacheReachedEof: false, cache: MOBILE_CACHE, netBps: FAST, droppedFrames: drops, hwdec: "mediacodec", videoCodec: "hevc", avsyncSeconds: null,
      });
      expect(["hold", "too-weak"]).toContain(action.kind);
      if (action.kind === "too-weak") {
        verdicts++;
        expect(action.pinned).toBe(true);
      }
    }
    console.info(`[abr-rules] forced 1080p, decode lag for 120 s: 0 switches, ${verdicts} notice(s)`);
    expect(verdicts).toBe(1);
    expect(ctrl.quality.currentId).toBe("fh");
  });
});

describe("rule 3: decode-bound switches to H.264 and stays there (controller simulation)", () => {
  it("@bugfix @regression-proof HEVC the device cannot decode -> H.264 at the same resolution, never back to HEVC", () => {
    const { ctrl, events } = simulate({
      setting: AUTO_1080,
      seconds: 3_600,
      capacityBps: () => FAST,
      dropsPerSec: (_t, variant) => (isHevcCodec(variant.codec) ? 30 : 0),
    });
    console.info(`[abr-rules] decode-bound sim: ${JSON.stringify(events)}`);
    const first = events[0];
    expect(first).toMatchObject({ trigger: "decoder", from: "1080p hevc", to: "1080p h264" });
    expect(events.filter((event) => event.to.endsWith("hevc"))).toEqual([]);
    expect(events.length, "exactly one switch: no flapping back into HEVC").toBe(1);
    expect(ctrl.quality.bannedIds).toEqual(expect.arrayContaining(["u", "fh"]));
  });

  it("H.264 that the device cannot decode steps down one rung and Auto never climbs back into it", () => {
    const { ctrl, events } = simulate({
      setting: { quality: "1080p", force: false },
      seconds: 3_600,
      capacityBps: () => FAST,
      dropsPerSec: (_t, variant) => (!isHevcCodec(variant.codec) && qualityRank(variant.quality) <= qualityRank("1080p") ? 30 : isHevcCodec(variant.codec) ? 30 : 0),
    });
    console.info(`[abr-rules] H.264-bound sim: ${JSON.stringify(events)}`);
    const final = ladder.find((candidate) => candidate.id === ctrl.quality.currentId)!;
    expect(final.quality).toBe("720p");
    expect(events.map((event) => event.to)).toEqual(["1080p h264", "720p h264"]);
  });
});

// --- Chris 2026-10-15 chat, D1: network drops are temporary, device limits are sticky --------------------

/** H.264-only ladder: nothing to ban, every decode verdict is a rung step. */
const h264Ladder = [v("f", "1080p", "h264", 6_000), v("h", "720p", "h264", 2_500), v("s", "480p", "h264", 1_000)];
/** The device decodes rungs at or below 480p only. */
const heavyAbove480 = (_t: number, variant: Variant) => (qualityRank(variant.quality) < qualityRank("480p") ? 30 : 0);
const rungOf = (vs: Variant[], id: string | null) => vs.find((candidate) => candidate.id === id)!;

describe("D1: H.264 too heavy for the device (sticky, one rung at a time)", () => {
  /** @req PLAY-CODEC-01[badger-mobile] @req PLAY-CODEC-02[badger-mobile] */
  it("@bugfix @regression-proof steps down ONE rung per verdict, repeatedly, and never climbs back for the file", () => {
    const { ctrl, events } = simulate({
      variants: h264Ladder,
      setting: AUTO_1080,
      seconds: 3_600,
      capacityBps: () => FAST,
      dropsPerSec: heavyAbove480,
    });
    console.info(`[abr-rules] H.264 ladder, device handles <=480p only: ${JSON.stringify(events)}`);
    expect(events.map((event) => `${event.trigger}:${event.to}`)).toEqual(["decoder:720p h264", "decoder:480p h264"]);
    expect(rungOf(h264Ladder, ctrl.quality.currentId).quality).toBe("480p");
    expect(ctrl.quality.decodeCeilingRank).toBe(qualityRank("480p"));
  });

  /** @req PLAY-ABR-02[badger-desktop,badger-mobile] @req PLAY-CODEC-02[badger-mobile] */
  it("@bugfix @regression-proof network recovery never climbs above the decode-sticky ceiling", () => {
    const { ctrl, events } = simulate({
      variants: h264Ladder,
      setting: AUTO_1080,
      seconds: 3_600,
      // 1080p is too heavy for the device; later the network collapses and recovers
      capacityBps: (t) => (t >= 400 && t < 700 ? SLOW : FAST),
      dropsPerSec: (_t, variant) => (variant.id === "f" ? 30 : 0),
    });
    console.info(`[abr-rules] decode ceiling + network cycle: ${JSON.stringify(events)}`);
    const decodeStep = events.find((event) => event.trigger === "decoder");
    expect(decodeStep).toMatchObject({ from: "1080p h264", to: "720p h264" });
    expect(events.some((event) => event.trigger === "network" && event.reason === "abr-downshift"), "the network drop still steps down").toBe(true);
    expect(events.some((event) => event.to === "1080p h264"), "never back into the rung the device could not decode").toBe(false);
    const back = events.find((event) => event.tSec >= 700 && event.reason === "abr-upshift");
    expect(back?.to, "the network recovered: Auto climbs back, up to the ceiling").toBe("720p h264");
    expect(rungOf(h264Ladder, ctrl.quality.currentId).quality).toBe("720p");
  });

  /** @req PLAY-ABR-01[badger-desktop,badger-mobile] @req PLAY-CODEC-02[badger-mobile] */
  it("a network downshift is temporary (no decode ceiling), a decoder verdict is not", () => {
    const network = simulate({ variants: h264Ladder, setting: AUTO_1080, seconds: 900, capacityBps: (t) => (t >= 60 && t < 240 ? SLOW : FAST) });
    expect(network.ctrl.quality.decodeCeilingRank ?? null).toBeNull();
    expect(rungOf(h264Ladder, network.ctrl.quality.currentId).quality, "back at the Settings quality").toBe("1080p");
    const decoder = simulate({ variants: h264Ladder, setting: AUTO_1080, seconds: 120, capacityBps: () => FAST, dropsPerSec: heavyAbove480 });
    expect(decoder.ctrl.quality.decodeCeilingRank).toBeDefined();
    expect(decoder.ctrl.quality.decodeCeilingRank).not.toBeNull();
  });

  /** @req PLAY-QUAL-03[badger-mobile,badger-tv] @req PLAY-CODEC-02[badger-mobile] */
  it("Force always wins: a pinned rung the device cannot decode never moves, through any network", () => {
    const { ctrl, events } = simulate({
      variants: h264Ladder,
      setting: FORCE_1080,
      seconds: 1_800,
      capacityBps: (t) => (t >= 100 && t < 400 ? SLOW : FAST),
      dropsPerSec: heavyAbove480,
    });
    console.info(`[abr-rules] forced 1080p on a device that cannot decode it: ${events.length} switches`);
    expect(events).toEqual([]);
    expect(ctrl.quality.currentId).toBe("f");
  });

  /** @req PLAY-CODEC-01[badger-mobile] */
  it("HEVC with no H.264 copy steps down to the next lighter rung instead of giving up", () => {
    const hevcOnly = [v("a", "2160p", "hevc", 12_000), v("b", "1080p", "hevc", 4_000), v("c", "720p", "hevc", 2_000)];
    const { ctrl, events } = simulate({
      variants: hevcOnly,
      setting: { quality: "2160p", force: false },
      seconds: 1_800,
      capacityBps: () => FAST,
      dropsPerSec: (_t, variant) => (variant.id === "c" ? 0 : 30),
    });
    console.info(`[abr-rules] HEVC-only ladder: ${JSON.stringify(events)}`);
    expect(events.map((event) => event.to)).toEqual(["1080p hevc", "720p hevc"]);
    expect(rungOf(hevcOnly, ctrl.quality.currentId).id).toBe("c");
  });
});

// --- D2: nothing lighter left -> say so, once ----------------------------------------------------------------

type Feed = Partial<Parameters<typeof stepAbr>[2]>;

/** Drives a controller one second at a time with drops that never stop. Returns every action that was not a plain hold. */
const driveStruggle = (variants: Variant[], setting: QualitySetting, seconds: number, over: Feed = {}) => {
  const ctrl = createAbrController(variants, setting, 0);
  const actions: Array<{ tSec: number; action: ReturnType<typeof stepAbr> }> = [];
  let drops = 0;
  for (let t = 0; t < seconds; t++) {
    drops += 40;
    const current = rungOf(variants, ctrl.quality.currentId);
    const action = stepAbr(ctrl, variants, {
      nowMs: t * 1000,
      sampledAtMs: t * 1000,
      voConfigured: true,
      position: 10 + t,
      paused: false,
      pausedForCache: false,
      seeking: false,
      bufferSeconds: 25,
      cacheReachedEof: false,
      cache: MOBILE_CACHE,
      netBps: FAST,
      droppedFrames: drops,
      hwdec: "mediacodec",
      videoCodec: current.codec,
      avsyncSeconds: null,
      ...over,
    });
    if (action.kind === "switch") noteSwitchSettled(ctrl, t * 1000);
    if (action.kind !== "hold") actions.push({ tSec: t, action });
  }
  return { ctrl, actions };
};

describe("D2: the device is not powerful enough (nothing lighter left)", () => {
  /** @req PLAY-CODEC-03[badger-mobile] */
  it("@bugfix @regression-proof lowest rung still dropping frames -> exactly one too-weak notice, no switch", () => {
    const { ctrl, actions } = driveStruggle(h264Ladder, { quality: "480p", force: false }, 120);
    console.info(`[abr-rules] too-weak at lowest rung: ${JSON.stringify(actions.map((a) => [a.tSec, a.action.kind]))}`);
    expect(actions.filter((a) => a.action.kind === "too-weak")).toHaveLength(1);
    expect(actions.filter((a) => a.action.kind === "switch")).toEqual([]);
    expect(ctrl.quality.currentId).toBe("s");
  });

  /** @req PLAY-CODEC-03[badger-mobile] */
  it("walks the whole ladder first: switch, switch, then the notice (and only the notice, once)", () => {
    const { actions } = driveStruggle(h264Ladder, AUTO_1080, 300);
    const kinds = actions.map((a) => a.action.kind);
    console.info(`[abr-rules] full walk: ${JSON.stringify(actions.map((a) => [a.tSec, a.action.kind]))}`);
    expect(kinds).toEqual(["switch", "switch", "too-weak"]);
  });

  /** @req PLAY-CODEC-03[badger-mobile] */
  it("a single-version file that cannot be decoded smoothly gets the notice", () => {
    const only = [v("only", "1080p", "h264", 6_000)];
    const { actions } = driveStruggle(only, AUTO_1080, 60);
    expect(actions.map((a) => a.action.kind)).toEqual(["too-weak"]);
  });

  /** @req PLAY-CODEC-03[badger-mobile] @req PLAY-ABR-01[badger-desktop,badger-mobile] */
  it("a starved buffer at the lowest rung is the NETWORK: never the notice", () => {
    const { actions } = driveStruggle(h264Ladder, { quality: "480p", force: false }, 120, { bufferSeconds: 0.5, pausedForCache: false });
    console.info(`[abr-rules] starved buffer at lowest rung: ${JSON.stringify(actions.map((a) => a.action.kind))}`);
    expect(actions.filter((a) => a.action.kind === "too-weak")).toEqual([]);
  });

  /** @req PLAY-QUAL-03[badger-mobile] @req PLAY-CODEC-03[badger-mobile] */
  it("Force on a rung with lighter versions available: nothing switches, the notice appears once with the unpin hint", () => {
    const { ctrl, actions } = driveStruggle(h264Ladder, FORCE_1080, 120);
    expect(actions.filter((a) => a.action.kind === "switch")).toEqual([]);
    const notices = actions.filter((a) => a.action.kind === "too-weak");
    console.info(`[abr-rules] forced 1080p struggling with lighter rungs available: ${notices.length} notice(s), pinned=${notices.map((n) => n.action.kind === "too-weak" && n.action.pinned)}`);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.action.kind === "too-weak" && notices[0]!.action.pinned).toBe(true);
    expect(ctrl.quality.currentId).toBe("f");
  });

  /** @req PLAY-QUAL-03[badger-mobile] @req PLAY-CODEC-03[badger-mobile] */
  it("Force on the lightest rung: still no switch, one pinned notice", () => {
    const { ctrl, actions } = driveStruggle(h264Ladder, { quality: "480p", force: true }, 120);
    expect(actions.filter((a) => a.action.kind === "switch")).toEqual([]);
    expect(actions.filter((a) => a.action.kind === "too-weak")).toHaveLength(1);
    expect(ctrl.quality.currentId).toBe("s");
  });

  /** @req PLAY-CODEC-03[badger-mobile] @req PLAY-CODEC-01[badger-mobile] */
  it("software HEVC with no lighter version is judged on dropped frames, not assumed unwatchable", () => {
    const hevcOnly = [v("c", "720p", "hevc", 2_000)];
    const quiet = createAbrController(hevcOnly, { quality: "720p", force: false }, 0);
    let verdict: ReturnType<typeof stepAbr> | undefined;
    for (let t = 0; t < 60; t++) {
      verdict = stepAbr(quiet, hevcOnly, {
        nowMs: t * 1000, sampledAtMs: t * 1000, voConfigured: true, position: 10 + t, paused: false, pausedForCache: false, seeking: false,
        bufferSeconds: 25, cacheReachedEof: false, cache: MOBILE_CACHE, netBps: FAST, droppedFrames: 0, hwdec: "no", videoCodec: "hevc", avsyncSeconds: null,
      });
      expect(verdict.kind, "smooth software decode is not a problem").toBe("hold");
    }
    const { actions } = driveStruggle(hevcOnly, { quality: "720p", force: false }, 60, { hwdec: "no" });
    expect(actions.map((a) => a.action.kind)).toEqual(["too-weak"]);
  });
});
