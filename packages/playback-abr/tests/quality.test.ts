import { describe, expect, it } from "vitest";
import {
  abrDecide,
  applyAbrDecision,
  createLagDetector,
  createQualityState,
  isHevcCodec,
  pickStartVariant,
  planHevcFallback,
  resetLagDetector,
  selectQuality,
  stepLagDetector,
  blendBps,
  type AbrState,
  type CacheConfig,
  type DecodeSample,
  type Variant,
} from "../src";

/** A client's configured mpv cache (mobile: MpvSurfaceView.kt). Every client passes its own; the package has no default. */
const CACHE: CacheConfig = { cacheSecs: 30, demuxerMaxBytes: 32 * 1024 * 1024 };

const v = (id: string, quality: string, codec = "h264", bitrateKbps: number | null = 4000): Variant => ({ id, quality, codec, bitrateKbps });
const variants = [v("u", "2160p", "hevc", 15000), v("f", "1080p", "h264", 6000), v("fh", "1080p", "hevc", 3500), v("h", "720p", "h264", 2500), v("s", "480p", "h264", 1000)];

const auto1080 = { quality: "1080p", force: false } as const;

describe("start variant", () => {
  it("starts at the Settings quality, preferring the HEVC original at equal rank", () => {
    expect(pickStartVariant(variants, "1080p")?.id).toBe("fh");
  });
  it("explicit preferences pick that rung or the nearest lower", () => {
    expect(pickStartVariant(variants, "720p")?.id).toBe("h");
    expect(pickStartVariant(variants, "2160p")?.id).toBe("u");
    expect(pickStartVariant([v("a", "480p")], "1080p")?.id).toBe("a");
    expect(pickStartVariant([], "1080p")).toBeNull();
  });
  it("Auto is the default mode; only Force this quality pins", () => {
    expect(createQualityState(variants, { quality: "720p", force: false }).mode).toBe("auto");
    expect(createQualityState(variants, { quality: "720p", force: true }).mode).toBe("manual");
  });
});

const abr = (over: Partial<AbrState> = {}): AbrState => ({
  variants, currentId: "f", ewmaBps: 40e6, bufferSeconds: 12, underrunSinceMs: null, lastSwitchAtMs: null,
  nowMs: 100_000, bannedIds: new Set(), cacheReachedEof: false, loadStartedAtMs: 0, firstFrameAtMs: 1000, lastReloadAtMs: null, cache: CACHE, ...over,
});

describe("abrDecide", () => {
  it("holds when healthy", () => {
    expect(abrDecide(abr()).action).toBe("hold");
  });
  it("downshifts on a sustained underrun", () => {
    const d = abrDecide(abr({ underrunSinceMs: 90_000, ewmaBps: 3e6 }));
    expect(d.action).toBe("downshift");
  });
  it("upshifts with a full buffer and headroom after the cooldown", () => {
    const d = abrDecide(abr({ currentId: "h", bufferSeconds: 30, lastSwitchAtMs: 0 }));
    expect(d.action).toBe("upshift");
  });
  it("holds downshifts right after the first frame", () => {
    expect(abrDecide(abr({ underrunSinceMs: 98_000, firstFrameAtMs: 99_000, ewmaBps: 1e6 })).action).toBe("hold");
  });
  it("applyAbrDecision only acts in auto mode and never bans a rung it leaves", () => {
    const auto = createQualityState(variants, auto1080);
    const next = applyAbrDecision(auto, { action: "downshift", targetId: "h", reason: "underrun" }, 5);
    expect(next.currentId).toBe("h");
    expect(next.bannedIds).toEqual([]);
    const manual = selectQuality(auto, "s", 1);
    expect(applyAbrDecision(manual, { action: "upshift", targetId: "f" }, 5)).toBe(manual);
  });
  it("EWMA ignores empty samples", () => {
    expect(blendBps(5, 0)).toBe(5);
    expect(blendBps(0, 8000)).toBe(8000);
  });
});

describe("selectQuality", () => {
  it("auto hands control back without changing the rung", () => {
    const manual = selectQuality(createQualityState(variants, auto1080), "h", 1);
    expect(manual.mode).toBe("manual");
    const auto = selectQuality(manual, "auto", 2);
    expect(auto.mode).toBe("auto");
    expect(auto.currentId).toBe("h");
  });
});

describe("HEVC fallback", () => {
  it("detects HEVC codec names", () => {
    expect(isHevcCodec("hevc")).toBe(true);
    expect(isHevcCodec("h264")).toBe(false);
  });
  it("falls back to H.264 at the same rung and bans all HEVC variants", () => {
    const state = { ...createQualityState(variants, auto1080), currentId: "fh" };
    const plan = planHevcFallback(variants, state, 7)!;
    expect(plan.target.id).toBe("f");
    expect(plan.state.bannedIds).toEqual(expect.arrayContaining(["u", "fh"]));
  });
  it("returns null with no H.264 variant", () => {
    const only = [v("u", "2160p", "hevc")];
    expect(planHevcFallback(only, createQualityState(only, auto1080), 0)).toBeNull();
  });
});


describe("lag detector", () => {
  const sample = (over: Partial<DecodeSample>): DecodeSample => ({
    nowMs: 0, sampledAtMs: over.nowMs ?? 0, timePos: 10, paused: false, pausedForCache: false, seeking: false, droppedFrames: 0, hwdecCurrent: "mediacodec", videoCodecIsNonH264: true, ...over,
  });
  it("flags software decode of HEVC immediately", () => {
    expect(stepLagDetector(createLagDetector(), sample({ hwdecCurrent: "no" }))).toEqual({ lag: true, reason: "software-decode" });
  });
  it("ignores H.264", () => {
    expect(stepLagDetector(createLagDetector(), sample({ hwdecCurrent: "no", videoCodecIsNonH264: false })).lag).toBe(false);
  });
  it("flags sustained frame drops after the window", () => {
    const d = createLagDetector();
    stepLagDetector(d, sample({ nowMs: 0, timePos: 10 }));
    expect(stepLagDetector(d, sample({ nowMs: 5000, timePos: 15, droppedFrames: 100 }))).toEqual({ lag: true, reason: "frame-drops" });
  });
  it("flags stalls (little media progress)", () => {
    const d = createLagDetector();
    stepLagDetector(d, sample({ nowMs: 0, timePos: 10 }));
    expect(stepLagDetector(d, sample({ nowMs: 5000, timePos: 10.5 }))).toEqual({ lag: true, reason: "stall" });
  });
  it("is quiet during the settle window after a seek/switch", () => {
    const d = createLagDetector();
    resetLagDetector(d, 0);
    expect(stepLagDetector(d, sample({ nowMs: 1000, hwdecCurrent: "no" })).lag).toBe(false);
    expect(stepLagDetector(d, sample({ nowMs: 3500, hwdecCurrent: "no" })).lag).toBe(true);
  });
});
