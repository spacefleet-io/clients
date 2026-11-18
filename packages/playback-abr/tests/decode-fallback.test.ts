/**
 * @test-id PLAYBACK-ABR-DECODE-FALLBACK-001
 * @level unit
 *
 * The decoder step the desktop runs (`stepDecoder`, then `stepNetworkAbr` when it has no verdict), fed simulated mpv stats
 * once a second the way the desktop ABR loop reads them: `time-pos`, `pause`, `seeking`, `frame-drop-count` +
 * `decoder-frame-drop-count`, `avsync`, `hwdec-current`, `video-format`, `demuxer-cache-state`. The desktop ladder keeps one
 * row per quality, so the H.264 row of a quality can sit behind its HEVC row: the desktop hands the ladder rebuilt with the
 * playing codec blocked as `decodeVariants`. Computers decode in software as a normal way to play (`decoderPolicy: "any"`,
 * PLAY-QUAL-06): only measured drops, desync or a stall are a verdict.
 */
import { describe, expect, it } from "vitest";
import {
  blendBps,
  createAbrController,
  noteSessionStarted,
  qualityRank,
  stepDecoder,
  stepNetworkAbr,
  type AbrAction,
  type AbrController,
  type AbrSample,
  type CacheConfig,
  type Variant,
} from "../src";

const LOG = "[decode-fallback]";
const T0 = 1_791_700_000_000;
/** Desktop's external mpv cache (@space/mpv external.ts). */
const CACHE: CacheConfig = { cacheSecs: 16, demuxerMaxBytes: 96 * 1024 * 1024 };
const v = (id: string, quality: string, codec: string, bitrateKbps: number): Variant => ({ id, quality, codec, bitrateKbps });
const HEVC_1080 = v("hevc-1080", "1080p", "hevc", 3000);
const H264_1080 = v("h264-1080", "1080p", "h264", 5000);
const HEVC_720 = v("hevc-720", "720p", "hevc", 1500);
const H264_720 = v("h264-720", "720p", "h264", 2500);
const H264_480 = v("h264-480", "480p", "h264", 1200);
const MIXED = [HEVC_1080, H264_1080, HEVC_720, H264_720];
const FAST = 50_000_000;

/** One desktop poll: mpv's stats at `atS` seconds of a playback that started at T0. */
type Stats = {
  atS: number;
  droppedFrames: number;
  position?: number;
  bufferSeconds?: number;
  pausedForCache?: boolean;
  paused?: boolean;
  avsyncSeconds?: number | null;
  hwdec?: string | null;
  videoCodec?: string | null;
  netBps?: number;
  decodeVariants?: Variant[];
};

const sample = (s: Stats): AbrSample => ({
  nowMs: T0 + s.atS * 1000,
  sampledAtMs: T0 + s.atS * 1000,
  voConfigured: true,
  pausedForCache: s.pausedForCache ?? false,
  bufferSeconds: s.bufferSeconds ?? 16,
  cacheReachedEof: false,
  netBps: s.netBps ?? FAST,
  cache: CACHE,
  position: s.position ?? 60 + s.atS,
  paused: s.paused ?? false,
  seeking: false,
  droppedFrames: s.droppedFrames,
  hwdec: s.hwdec === undefined ? "vaapi" : s.hwdec,
  videoCodec: s.videoCodec === undefined ? "hevc" : s.videoCodec,
  avsyncSeconds: s.avsyncSeconds ?? 0,
  decodeVariants: s.decodeVariants,
});

/** A desktop controller (`firstFrameFrom: "event"`, smoothed link meter, `decoderPolicy: "any"`) settled on `currentId`. */
const desktopController = (currentId: string, force = false): AbrController => {
  const ctrl = createAbrController(MIXED, { quality: "1080p", force }, T0 - 120_000, null, {
    firstFrameFrom: "event",
    netBpsIsSmoothed: true,
    decoderPolicy: "any",
  });
  noteSessionStarted(ctrl, T0 - 120_000);
  ctrl.quality = { ...ctrl.quality, currentId, mode: force ? "manual" : "auto" };
  ctrl.loadStartedAtMs = T0 - 61_000;
  ctrl.firstFrameAtMs = T0 - 60_000;
  return ctrl;
};

/** What the desktop ABR tick does: the decoder step first, the network step when it has nothing to say. */
const desktopTick = (ctrl: AbrController, ladder: Variant[], s: Stats): AbrAction =>
  stepDecoder(ctrl, ladder, sample(s)) ?? stepNetworkAbr(ctrl, ladder, sample(s));

/** Plays `seconds` of 1 Hz polls at `dropsPerSecond`; returns every non-hold action with its time. */
const play = (
  ctrl: AbrController,
  ladder: Variant[],
  opts: { fromS?: number; seconds: number; dropsPerSecond: number; dropsAtStart?: number } & Omit<Stats, "atS" | "droppedFrames">,
) => {
  const { fromS = 0, seconds, dropsPerSecond, dropsAtStart = 0, ...rest } = opts;
  const actions: Array<{ atS: number; action: AbrAction }> = [];
  for (let i = 0; i <= seconds; i++) {
    const atS = fromS + i;
    const action = desktopTick(ctrl, ladder, { ...rest, atS, droppedFrames: dropsAtStart + Math.floor(i * dropsPerSecond) });
    if (action.kind !== "hold") {
      actions.push({ atS, action });
      console.info(`${LOG} t=${atS}s action=${JSON.stringify(action)} current=${ctrl.quality.currentId} banned=${JSON.stringify(ctrl.quality.bannedIds)} ceiling=${ctrl.quality.decodeCeilingRank ?? "none"}`);
    }
  }
  return actions;
};

describe("desktop decoder step: a device that can't keep up gets a lighter version (PLAY-CODEC-01)", () => {
  /** @req PLAY-CODEC-01[badger-desktop] */
  it("HEVC 1080p dropping 10 frames a second with a full buffer goes to the H.264 1080p row hidden behind it, HEVC banned", () => {
    const ctrl = desktopController(HEVC_1080.id);
    const live = [HEVC_1080, H264_720];
    const actions = play(ctrl, live, { seconds: 10, dropsPerSecond: 10, decodeVariants: [H264_1080, H264_720] });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.atS).toBeLessThanOrEqual(6);
    expect(actions[0]!.action).toMatchObject({ kind: "switch", targetId: H264_1080.id, trigger: "decoder", reason: "hevc-fallback" });
    expect(ctrl.quality.bannedIds).toEqual(expect.arrayContaining([HEVC_1080.id]));
  });

  /** @req PLAY-CODEC-01[badger-desktop] */
  it("no H.264 at the same resolution: the best lower H.264 rung", () => {
    const ctrl = desktopController(HEVC_1080.id);
    const actions = play(ctrl, [HEVC_1080, HEVC_720, H264_720], { seconds: 10, dropsPerSecond: 10 });
    expect(actions[0]?.action).toMatchObject({ kind: "switch", targetId: H264_720.id, reason: "hevc-fallback" });
  });

  /** @req PLAY-CODEC-01[badger-desktop] */
  it("H.264 dropping frames steps down one rung at a time, never starting anything new", () => {
    const ctrl = desktopController(H264_1080.id);
    const ladder = [H264_1080, H264_720, H264_480];
    const first = play(ctrl, ladder, { seconds: 8, dropsPerSecond: 10, videoCodec: "h264" });
    expect(first[0]?.action).toMatchObject({ kind: "switch", targetId: H264_720.id, trigger: "decoder", reason: "decode-fallback" });
    // Still dropping on 720p: the 3 s settle after the switch, then one more rung.
    const second = play(ctrl, ladder, { fromS: 9, seconds: 12, dropsPerSecond: 10, dropsAtStart: 500, videoCodec: "h264" });
    expect(second[0]?.action).toMatchObject({ kind: "switch", targetId: H264_480.id, reason: "decode-fallback" });
  });

  /** @req PLAY-CODEC-01[badger-desktop] */
  it("no H.264 copy at all: the next lighter version of any codec (HEVC 1080p -> HEVC 720p)", () => {
    const ctrl = desktopController(HEVC_1080.id);
    const actions = play(ctrl, [HEVC_1080, HEVC_720], { seconds: 10, dropsPerSecond: 10 });
    expect(actions[0]?.action).toMatchObject({ kind: "switch", targetId: HEVC_720.id, reason: "decode-fallback" });
    expect(ctrl.quality.bannedIds).not.toContain(HEVC_720.id);
  });

  /** @req PLAY-CODEC-01[badger-desktop] */
  it("A/V desync with a full buffer is a verdict too", () => {
    const ctrl = desktopController(H264_1080.id);
    const actions = play(ctrl, [H264_1080, H264_720], { seconds: 8, dropsPerSecond: 0, avsyncSeconds: 0.9, videoCodec: "h264" });
    expect(actions[0]?.action).toMatchObject({ kind: "switch", targetId: H264_720.id, detail: { lag: true, reason: "avsync" } });
  });

  /** @req PLAY-CODEC-01[badger-desktop] */
  it("drops while the buffer starves are the network's, never the device's", () => {
    const ctrl = desktopController(HEVC_1080.id);
    const decisions: AbrAction[] = [];
    for (let s = 0; s <= 12; s++) {
      const stats: Stats = { atS: s, droppedFrames: s * 10, bufferSeconds: 0.5, pausedForCache: s % 3 === 0, netBps: 900_000 };
      const decoder = stepDecoder(ctrl, MIXED, sample(stats));
      console.info(`${LOG} starved t=${s}s decoder=${JSON.stringify(decoder)}`);
      expect(decoder).toBeNull();
      decisions.push(stepNetworkAbr(ctrl, MIXED, sample(stats)));
    }
    expect(ctrl.quality.bannedIds).toEqual([]);
    expect(decisions.some((a) => a.kind === "switch" && a.trigger === "decoder")).toBe(false);
  });

  /** @req PLAY-CODEC-01[badger-desktop] */
  it("a few stray drops and software decoding alone are no verdict on a computer", () => {
    const ctrl = desktopController(HEVC_1080.id);
    expect(play(ctrl, MIXED, { seconds: 30, dropsPerSecond: 2 })).toEqual([]);
    expect(play(ctrl, MIXED, { fromS: 31, seconds: 30, dropsPerSecond: 0, dropsAtStart: 60, hwdec: "no" })).toEqual([]);
  });
});

describe("desktop decoder step: the fallback sticks for the file and never overrides Force (PLAY-CODEC-02)", () => {
  /** @req PLAY-CODEC-02[badger-desktop] */
  it("after stepping down for drops, 5 minutes of a fast link and smooth playback never climb back above the lighter rung", () => {
    const ctrl = desktopController(H264_1080.id);
    const ladder = [H264_1080, H264_720, H264_480];
    play(ctrl, ladder, { seconds: 8, dropsPerSecond: 10, videoCodec: "h264" });
    expect(ctrl.quality.currentId).toBe(H264_720.id);
    expect(ctrl.quality.decodeCeilingRank).toBe(qualityRank("720p"));
    const later = play(ctrl, ladder, { fromS: 9, seconds: 300, dropsPerSecond: 0, dropsAtStart: 100, videoCodec: "h264", netBps: 400_000_000 });
    expect(later.filter((a) => a.action.kind === "switch")).toEqual([]);
    expect(ctrl.quality.currentId).toBe(H264_720.id);
  });

  /** @req PLAY-CODEC-02[badger-desktop] */
  it("after the HEVC fallback, Auto never climbs back into HEVC", () => {
    const ctrl = desktopController(HEVC_1080.id);
    play(ctrl, MIXED, { seconds: 8, dropsPerSecond: 10 });
    expect(ctrl.quality.currentId).toBe(H264_1080.id);
    for (let s = 10; s <= 600; s++) {
      desktopTick(ctrl, MIXED, { atS: s, droppedFrames: 100, videoCodec: "h264", netBps: 400_000_000 });
      expect(ctrl.quality.currentId?.startsWith("hevc")).toBe(false);
    }
  });

  /** @req PLAY-CODEC-02[badger-desktop] @req PLAY-QUAL-03[badger-desktop] */
  it("Force on: the same drops switch nothing; the device-too-weak notice comes once, with the Force hint", () => {
    const ctrl = desktopController(HEVC_1080.id, true);
    const actions = play(ctrl, MIXED, { seconds: 60, dropsPerSecond: 10 });
    expect(actions.filter((a) => a.action.kind === "switch")).toEqual([]);
    expect(actions.map((a) => a.action)).toEqual([{ kind: "too-weak", verdict: { lag: true, reason: "frame-drops" }, pinned: true }]);
    expect(ctrl.quality.currentId).toBe(HEVC_1080.id);
    expect(ctrl.quality.bannedIds).toEqual([]);
  });
});

describe("desktop decoder step: nothing lighter left (PLAY-CODEC-03)", () => {
  /** @req PLAY-CODEC-03[badger-desktop] */
  it("dropping frames on the lightest version: `too-weak` once for the file, no switch", () => {
    const ctrl = desktopController(H264_480.id);
    // A link that sustains 480p but not a climb to 720p, so only the decoder step can act.
    const actions = play(ctrl, [H264_1080, H264_720, H264_480], { seconds: 60, dropsPerSecond: 10, videoCodec: "h264", netBps: 2_000_000 });
    expect(actions.map((a) => a.action)).toEqual([{ kind: "too-weak", verdict: { lag: true, reason: "frame-drops" }, pinned: false }]);
    expect(ctrl.quality.currentId).toBe(H264_480.id);
  });
});

describe("netBpsIsSmoothed", () => {
  it("adopts the client's estimate as is", () => {
    const ctrl = desktopController(H264_1080.id);
    ctrl.ewmaBps = 1_000_000;
    stepNetworkAbr(ctrl, MIXED, sample({ atS: 0, droppedFrames: 0, netBps: 9_000_000 }));
    expect(ctrl.ewmaBps).toBe(9_000_000);
  });

  it("smooths every sample with blendBps by default (mobile and any client without a meter)", () => {
    const ctrl = createAbrController(MIXED, { quality: "1080p", force: false }, T0 - 120_000);
    ctrl.ewmaBps = 1_000_000;
    stepNetworkAbr(ctrl, MIXED, sample({ atS: 0, droppedFrames: 0, netBps: 9_000_000 }));
    expect(ctrl.ewmaBps).toBe(blendBps(1_000_000, 9_000_000));
    expect(ctrl.ewmaBps).not.toBe(9_000_000);
  });
});
