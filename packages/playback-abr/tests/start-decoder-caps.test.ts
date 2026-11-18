/**
 * @test-id PLAYBACK-START-DECODER-CAPS-001
 * @level unit
 *
 * Start quality from the device's real decoder capabilities (Chris 2026-10-15 chat, D3; PLAY-QUAL-06):
 * the client asks the OS what the device decodes in hardware and starts on the best version it reports it can decode,
 * never above the Settings quality. Unknown caps change nothing. "Force this quality" still plays the forced rung when the
 * device cannot decode it, but the decision is logged. (Mobile feeds Android MediaCodecList answers; the package only needs
 * the per-version verdicts.)
 */
import { describe, expect, it } from "vitest";
import { createAbrController, pickStartVariant, planStart, stepAbr, type AbrAction, type DecoderVerdicts, type Variant } from "../src";

const v = (id: string, quality: string, codec: string, codecString: string, bitrateKbps: number): Variant => ({
  id,
  quality,
  codec,
  codecString,
  bitrateKbps,
});

/** The LOTR fixture on the dev stack: 2160p HEVC 10-bit, 1080p HEVC 8-bit, 1080p H.264, 480p H.264. */
const lotr = [
  v("u10", "2160p", "hevc", "hvc1.2.4.L153.B0", 6_000),
  v("f8", "1080p", "hevc", "hvc1.1.6.L120.90", 3_000),
  v("f264", "1080p", "h264", "avc1.640028", 5_000),
  v("s264", "480p", "h264", "avc1.64001e", 716),
];

/** Verdicts as the device reports them: every probe decodable in hardware unless listed in `hwNo`. */
const caps = (over: { hwNo?: string[] } = {}, variants: Variant[] = lotr): DecoderVerdicts => ({
  probes: variants.map((variant) => ({ id: variant.id, hardware: !(over.hwNo ?? []).includes(variant.id) })),
});

const AUTO = (quality: "2160p" | "1080p" | "720p" | "480p") => ({ quality, force: false });
const FORCE = (quality: "2160p" | "1080p" | "720p" | "480p") => ({ quality, force: true });

describe("pickStartVariant with real decoder capabilities", () => {
  /** @req PLAY-QUAL-06[badger-mobile] */
  it("unknown caps (null / not reported) change nothing: the Settings rung, as before", () => {
    for (const quality of ["2160p", "1080p", "720p", "480p"] as const) {
      const without = pickStartVariant(lotr, quality)?.id;
      expect(pickStartVariant(lotr, quality, null)?.id).toBe(without);
      expect(pickStartVariant(lotr, quality, { probes: [] })?.id).toBe(without);
    }
    expect(pickStartVariant(lotr, "2160p")?.id).toBe("u10");
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("a phone that decodes everything starts on the Settings quality (OnePlus 6 at 4K starts 2160p HEVC 10-bit)", () => {
    expect(pickStartVariant(lotr, "2160p", caps())?.id).toBe("u10");
    expect(pickStartVariant(lotr, "1080p", caps())?.id).toBe("f8");
  });

  /** @req PLAY-QUAL-06[badger-mobile] @req PLAY-QUAL-02[badger-desktop,badger-mobile,badger-tv] */
  it("never starts above the Settings quality, however capable the phone is", () => {
    expect(pickStartVariant(lotr, "480p", caps())?.id).toBe("s264");
    const ladder = [...lotr, v("h264-720", "720p", "h264", "avc1.64001f", 2_500)];
    expect(pickStartVariant(ladder, "720p", caps({}, ladder))?.id).toBe("h264-720");
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("starts on the best version the hardware can decode when the Settings rung is too much for it", () => {
    const start = planStart(lotr, AUTO("2160p"), caps({ hwNo: ["u10"] }));
    console.info(`[decoder-caps] 4K not decodable in hardware: ${JSON.stringify({ start: start.variant?.id, reason: start.reason })}`);
    expect(start.variant?.id).toBe("f8");
    expect(start.reason).toBe("decoder-limit");
    expect(start.baseline?.id).toBe("u10");
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("a phone with no hardware HEVC decoder starts on the H.264 copy of the same resolution", () => {
    expect(pickStartVariant(lotr, "2160p", caps({ hwNo: ["u10", "f8"] }))?.id).toBe("f264");
    expect(pickStartVariant(lotr, "1080p", caps({ hwNo: ["u10", "f8"] }))?.id).toBe("f264");
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("when nothing is decodable in hardware it starts on the lightest version (real evidence, no guess upward)", () => {
    const start = planStart(lotr, AUTO("1080p"), caps({ hwNo: ["u10", "f8", "f264", "s264"] }));
    expect(start.variant?.id).toBe("s264");
    expect(start.reason).toBe("decoder-limit");
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("a version the device did not report on counts as unknown, not as undecodable", () => {
    const partial: DecoderVerdicts = { ...caps(), probes: caps().probes.filter((probe) => probe.id !== "u10") };
    expect(pickStartVariant(lotr, "2160p", partial)?.id).toBe("u10");
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("Settings quality below every version: lightest version above it that the hardware decodes", () => {
    const high = [lotr[0]!, lotr[1]!, lotr[2]!];
    expect(pickStartVariant(high, "480p", caps({}, high))?.id).toBe("f264");
    expect(pickStartVariant(high, "480p", caps({ hwNo: ["f264"] }, high))?.id).toBe("f8");
  });
});

describe("Force this quality with decoder capabilities", () => {
  /** @req PLAY-QUAL-03[badger-mobile] @req PLAY-QUAL-06[badger-mobile] */
  it("plays the forced rung even when the hardware cannot decode it, and says so", () => {
    const start = planStart(lotr, FORCE("2160p"), caps({ hwNo: ["u10"] }));
    console.info(`[decoder-caps] forced 4K, undecodable: ${JSON.stringify({ start: start.variant?.id, reason: start.reason, forcedUndecodable: start.forcedUndecodable })}`);
    expect(start.variant?.id).toBe("u10");
    expect(start.reason).toBe("forced");
    expect(start.forcedUndecodable).toBe(true);
  });

  /** @req PLAY-QUAL-03[badger-mobile] @req PLAY-QUAL-06[badger-mobile] */
  it("keeps the forced resolution but takes the codec the hardware decodes at that resolution", () => {
    const start = planStart(lotr, FORCE("1080p"), caps({ hwNo: ["f8"] }));
    expect(start.variant?.id).toBe("f264");
    expect(start.forcedUndecodable).toBe(false);
  });

  /** @req PLAY-QUAL-03[badger-mobile] */
  it("a forced rung the hardware decodes is not flagged", () => {
    const start = planStart(lotr, FORCE("2160p"), caps());
    expect(start).toMatchObject({ forcedUndecodable: false, reason: "forced" });
    expect(start.variant?.id).toBe("u10");
  });

  /** @req PLAY-QUAL-03[badger-mobile] @req PLAY-QUAL-06[badger-mobile] */
  it("the controller starts on the capability-limited rung in Auto and on the forced rung under Force", () => {
    const limited = caps({ hwNo: ["u10"] });
    const auto = createAbrController(lotr, AUTO("2160p"), 0, limited);
    const forced = createAbrController(lotr, FORCE("2160p"), 0, limited);
    expect(auto.quality.currentId).toBe("f8");
    expect(auto.quality.mode).toBe("auto");
    expect(auto.settingsCeilingRank).toBe(0);
    expect(auto.quality.decodeCeilingRank, "Auto never climbs into a rung the device reported it cannot decode").toBe(1);
    expect(auto.quality.bannedIds).toEqual(["u10"]);
    expect(forced.quality.currentId).toBe("u10");
    expect(forced.quality.mode).toBe("manual");
  });
});

describe("capability bans", () => {
  /** @req PLAY-QUAL-06[badger-mobile] */
  it("nothing is banned when the device decodes nothing in hardware: there would be nowhere left to go", () => {
    const none = createAbrController(lotr, AUTO("1080p"), 0, caps({ hwNo: ["u10", "f8", "f264", "s264"] }));
    expect(none.quality.currentId).toBe("s264");
    expect(none.quality.bannedIds).toEqual([]);
  });

  /** @req PLAY-QUAL-06[badger-mobile] */
  it("a start that is not limited by the decoder sets no ceiling and bans nothing", () => {
    const ok = createAbrController(lotr, AUTO("1080p"), 0, caps());
    expect(ok.quality.decodeCeilingRank ?? null).toBeNull();
    expect(ok.quality.bannedIds).toEqual([]);
  });
});

/**
 * PLAY-QUAL-06 on a TV (and a computer): hardware AND software decoders count. The TV app runs the phone's PlayerScreen,
 * which passes `decoderPolicy: "any"` when `IS_TV` (rendered check: `apps/badger/mobile/src/tv/screens/tvPlayerScreen.test.tsx`).
 * Native answers per probe whether a software decoder handles it too (`DecoderCaps.kt` `software`, `iosDecoderCaps.ts`).
 */
describe("decoder policy: a TV counts software decoders too", () => {
  /** Verdicts with a software answer: hardware unless in `hwNo`, software unless in `swNo`. */
  const both = (over: { hwNo?: string[]; swNo?: string[] } = {}, variants: Variant[] = lotr): DecoderVerdicts => ({
    probes: variants.map((variant) => ({
      id: variant.id,
      hardware: !(over.hwNo ?? []).includes(variant.id),
      software: !(over.swNo ?? []).includes(variant.id),
    })),
  });
  const LOG = "[decoder-policy]";

  /** @req PLAY-QUAL-06[badger-tv] */
  it("4K HEVC only a software decoder handles: the TV starts it, the phone starts the hardware 1080p", () => {
    const verdicts = both({ hwNo: ["u10"] });
    const tv = planStart(lotr, AUTO("2160p"), verdicts, "any");
    const phone = planStart(lotr, AUTO("2160p"), verdicts, "hardware-first");
    console.info(`${LOG} 4K software-only: tv=${JSON.stringify({ id: tv.variant?.id, reason: tv.reason })} phone=${JSON.stringify({ id: phone.variant?.id, reason: phone.reason })}`);
    expect(tv.variant?.id).toBe("u10");
    expect(tv.reason).toBe("settings");
    expect(phone.variant?.id).toBe("f8");
    expect(phone.reason).toBe("decoder-limit");
  });

  /** @req PLAY-QUAL-06[badger-tv] */
  it("at one resolution the TV still prefers the copy its hardware decodes", () => {
    const start = planStart(lotr, AUTO("1080p"), both({ hwNo: ["u10", "f8"] }), "any");
    console.info(`${LOG} 1080p HEVC software-only, H.264 hardware: ${JSON.stringify({ id: start.variant?.id, reason: start.reason })}`);
    expect(start.variant?.id).toBe("f264");
  });

  /** @req PLAY-QUAL-06[badger-tv] */
  it("a probe with no software answer counts by its hardware answer only; nothing decodable at all starts the lightest", () => {
    const silent: DecoderVerdicts = { probes: lotr.map((variant) => ({ id: variant.id, hardware: variant.id !== "u10" })) };
    const noSoftwareAnswer = planStart(lotr, AUTO("2160p"), silent, "any");
    const nothing = planStart(lotr, AUTO("1080p"), both({ hwNo: ["u10", "f8", "f264", "s264"], swNo: ["u10", "f8", "f264", "s264"] }), "any");
    console.info(`${LOG} no software answer -> ${noSoftwareAnswer.variant?.id}; nothing decodable -> ${nothing.variant?.id}`);
    expect(noSoftwareAnswer.variant?.id).toBe("f8");
    expect(nothing.variant?.id).toBe("s264");
    expect(nothing.reason).toBe("decoder-limit");
  });

  /** @req PLAY-QUAL-06[badger-tv] */
  it("Force on a rung only software decodes is not flagged undecodable on a TV", () => {
    const verdicts = both({ hwNo: ["u10"] });
    const tv = planStart(lotr, FORCE("2160p"), verdicts, "any");
    const phone = planStart(lotr, FORCE("2160p"), verdicts);
    console.info(`${LOG} forced 4K software-only: tv=${JSON.stringify(tv.forcedUndecodable)} phone=${JSON.stringify(phone.forcedUndecodable)}`);
    expect(tv).toMatchObject({ reason: "forced", forcedUndecodable: false });
    expect(tv.variant?.id).toBe("u10");
    expect(phone.forcedUndecodable).toBe(true);
  });

  /** @req PLAY-QUAL-06[badger-tv] */
  it("the TV controller starts there with no ban and no decode ceiling; the phone controller bans the software-only rung", () => {
    const verdicts = both({ hwNo: ["u10"] });
    const tv = createAbrController(lotr, AUTO("2160p"), 0, verdicts, { decoderPolicy: "any" });
    const phone = createAbrController(lotr, AUTO("2160p"), 0, verdicts);
    console.info(`${LOG} controllers: tv=${JSON.stringify(tv.quality)} phone=${JSON.stringify(phone.quality)}`);
    expect(tv.decoderPolicy).toBe("any");
    expect(tv.quality.currentId).toBe("u10");
    expect(tv.quality.bannedIds).toEqual([]);
    expect(tv.quality.decodeCeilingRank ?? null).toBeNull();
    expect(phone.decoderPolicy).toBe("hardware-first");
    expect(phone.quality.currentId).toBe("f8");
    expect(phone.quality.bannedIds).toEqual(["u10"]);
  });

  /** @req PLAY-QUAL-06[badger-tv] */
  it("on a TV smooth software decoding is not a device verdict; dropped frames still move it to a lighter version", () => {
    const cache = { cacheSecs: 30, demuxerMaxBytes: 32 * 1024 * 1024 };
    const run = (decoderPolicy: "any" | "hardware-first", dropsPerSecond: number): AbrAction[] => {
      const ctrl = createAbrController(lotr, AUTO("2160p"), 0, both({ hwNo: ["u10"] }), { decoderPolicy });
      ctrl.quality = { ...ctrl.quality, currentId: "u10", bannedIds: [], decodeCeilingRank: null };
      const actions: AbrAction[] = [];
      for (let t = 0; t < 30; t++) {
        const action = stepAbr(ctrl, lotr, {
          nowMs: t * 1000, sampledAtMs: t * 1000, voConfigured: true, position: 10 + t, paused: false, pausedForCache: false, seeking: false,
          bufferSeconds: 25, cacheReachedEof: false, cache, netBps: 60e6, droppedFrames: t * dropsPerSecond, hwdec: "no", videoCodec: "hevc", avsyncSeconds: null,
        });
        if (action.kind !== "hold") actions.push(action);
      }
      console.info(`${LOG} software HEVC 4K policy=${decoderPolicy} drops/s=${dropsPerSecond}: ${JSON.stringify(actions)} current=${ctrl.quality.currentId}`);
      return actions;
    };
    expect(run("any", 0)).toEqual([]);
    const tvStruggling = run("any", 10);
    expect(tvStruggling[0]).toMatchObject({ kind: "switch", trigger: "decoder" });
    const phone = run("hardware-first", 0);
    expect(phone[0]).toMatchObject({ kind: "switch", trigger: "decoder" });
  });
});
