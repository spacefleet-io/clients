/**
 * Rule 3 (decode-bound vs network-bound): a stall verdict must be judged on the NATIVE sample clock, never on the
 * time the JS thread happened to process a snapshot.
 *
 * Field evidence, run 2026-10-15T10-52-18-417Z (hevc-matrix, normal): the JS thread was starved for ~30 s
 * (`library.db.flush.index.done ms:16135`, `first_frame_ms:31912`), then `playback.hevc.lag {reason:"stall",
 * bufferS:30}` fired and dropped a perfectly healthy HEVC stream to H.264 while the SBProbe lines showed
 * `pos` advancing 1.0 s/s, `hwdec:"mediacodec"`, `cacheDur:30`. The detector measured wall time with `Date.now()` at
 * processing time but media progress from the snapshot's own `time-pos`: a snapshot re-processed later (the player
 * effect re-runs on any dependency change while the 1 Hz poll is stuck behind a blocked JS thread) looked like
 * "5 s passed, the video moved 0 s".
 */
import { describe, expect, it } from "vitest";
import {
  createAbrController,
  createLagDetector,
  stepAbr,
  stepLagDetector,
  type CacheConfig,
  type DecodeSample,
  type LagVerdict,
  type Variant,
} from "../src";

/** A client's configured mpv cache; the package has no default. */
const CACHE: CacheConfig = { cacheSecs: 30, demuxerMaxBytes: 32 * 1024 * 1024 };

const sample = (over: Partial<DecodeSample>): DecodeSample => ({
  nowMs: 0,
  sampledAtMs: 0,
  timePos: 10,
  paused: false,
  pausedForCache: false,
  seeking: false,
  droppedFrames: 0,
  hwdecCurrent: "mediacodec",
  videoCodecIsNonH264: true,
  bufferSeconds: 30,
  ...over,
});

// @req PLAY-CODEC-01[badger-mobile]
describe("lag detector clock (rule 3)", () => {
  it("@bugfix @regression-proof a healthy snapshot re-processed 5 s later by the JS thread is not a stall", () => {
    const detector = createLagDetector();
    const first = sample({ nowMs: 1_000, sampledAtMs: 1_000, timePos: 31 });
    const verdicts: LagVerdict[] = [stepLagDetector(detector, first)];
    // The poll is stuck behind a blocked JS thread: the effect re-runs with the SAME native snapshot, JS time moves on.
    for (let jsNow = 2_000; jsNow <= 8_000; jsNow += 1_000) {
      verdicts.push(stepLagDetector(detector, { ...first, nowMs: jsNow }));
    }
    console.info(`[lag-clock] same snapshot re-processed over 7 s of JS time: ${JSON.stringify(verdicts.filter((v) => v.lag))}`);
    expect(verdicts.filter((v) => v.lag)).toEqual([]);
  });

  it("@bugfix @regression-proof a late-delivered snapshot (JS blocked, native clock fine) is not a stall", () => {
    const detector = createLagDetector();
    stepLagDetector(detector, sample({ nowMs: 1_000, sampledAtMs: 1_000, timePos: 31 }));
    // Native sampled 1 Hz and position advanced 1 s/s; JS got the first fresh sample only 9 s later.
    const verdict = stepLagDetector(detector, sample({ nowMs: 10_000, sampledAtMs: 2_000, timePos: 32 }));
    const later = stepLagDetector(detector, sample({ nowMs: 10_050, sampledAtMs: 6_000, timePos: 36 }));
    console.info(`[lag-clock] late delivery verdicts: ${JSON.stringify([verdict, later])}`);
    expect(verdict.lag).toBe(false);
    expect(later.lag).toBe(false);
  });

  it("@bugfix @regression-proof the full controller keeps HEVC when the same snapshot is replayed with a later JS clock", () => {
    const ladder: Variant[] = [
      { id: "h", quality: "1080p", codec: "hevc", bitrateKbps: 2073 },
      { id: "f", quality: "1080p", codec: "h264", bitrateKbps: 2250 },
    ];
    const ctrl = createAbrController(ladder, { quality: "1080p", force: false }, 0);
    const base = {
      voConfigured: true,
      position: 31,
      paused: false,
      pausedForCache: false,
      seeking: false,
      bufferSeconds: 30,
      cacheReachedEof: false,
      cache: CACHE,
      netBps: 2.9e6,
      droppedFrames: 0,
      hwdec: "mediacodec",
      videoCodec: "hevc",
      avsyncSeconds: 0,
      sampledAtMs: 40_000,
    };
    const actions = [];
    for (let jsNow = 40_000; jsNow <= 52_000; jsNow += 1_000) actions.push(stepAbr(ctrl, ladder, { ...base, nowMs: jsNow }));
    const decoderSwitches = actions.filter((a) => a.kind === "switch" && a.trigger === "decoder");
    console.info(`[lag-clock] decoder switches from a replayed snapshot: ${decoderSwitches.length}`);
    expect(decoderSwitches).toEqual([]);
  });

  it("a real stall on the native clock is still detected (position frozen while sampled 5 s apart)", () => {
    const detector = createLagDetector();
    stepLagDetector(detector, sample({ nowMs: 100, sampledAtMs: 0, timePos: 10 }));
    stepLagDetector(detector, sample({ nowMs: 2_600, sampledAtMs: 2_500, timePos: 10.1 }));
    const verdict = stepLagDetector(detector, sample({ nowMs: 5_100, sampledAtMs: 5_000, timePos: 10.2 }));
    console.info(`[lag-clock] frozen position over 5 native seconds: ${JSON.stringify(verdict)}`);
    expect(verdict).toEqual({ lag: true, reason: "stall" });
  });
});
