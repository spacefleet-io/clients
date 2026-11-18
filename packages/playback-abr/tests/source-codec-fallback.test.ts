/**
 * @bugfix @regression-proof
 * Issue #303: ingest used to label every AV1 / VP9 / MPEG-2 original "h264", so the decode fallback treated it as
 * "H.264, safe". Now that the real codec is stored, an original that is not H.264 is decode-heavy like HEVC: when the
 * device cannot keep up, Auto falls back to the H.264 copy of the same resolution (else the best lower H.264 one), bans
 * every non-H.264 version for the file, and never starts a new transcode.
 *
 * @req PLAY-CODEC-01[badger-mobile]
 * @req PLAY-CODEC-02[badger-mobile]
 */
import { describe, expect, it } from "vitest";
import {
  createQualityState,
  isH264Codec,
  isHevcCodec,
  needsH264Fallback,
  planDecodeFallback,
  planHevcFallback,
  sortVariantsBestToWorst,
  stepLagDetector,
  createLagDetector,
  type DecodeSample,
  type Variant,
} from "../src";

const v = (id: string, quality: string, codec: string | null, bitrateKbps: number | null = 4000): Variant => ({ id, quality, codec, bitrateKbps });
const auto1080 = { quality: "1080p", force: false } as const;

describe("codec predicates", () => {
  it("only H.264 spellings (and a codec the client does not know) are safe; everything else needs the H.264 copy", () => {
    for (const codec of ["hevc", "h265", "av1", "vp9", "vp8", "mpeg2", "mpeg4", "vc1", "prores", "unknown"]) {
      expect(needsH264Fallback(codec), codec).toBe(true);
    }
    for (const codec of ["h264", "H.264", "avc", "avc1", null, undefined, ""]) {
      expect(needsH264Fallback(codec), String(codec)).toBe(false);
    }
    expect(isH264Codec("avc1")).toBe(true);
    expect(isH264Codec("av1")).toBe(false);
    // HEVC stays its own predicate (10-bit probe, mime mapping).
    expect(isHevcCodec("av1")).toBe(false);
  });
});

describe.each(["av1", "vp9", "mpeg2"])("%s original decode fallback", (codec) => {
  const ladder = [v("src", "1080p", codec, 3000), v("h264-1080", "1080p", "h264", 6000), v("h264-720", "720p", "h264", 2500), v("h264-480", "480p", "h264", 1000)];

  it("falls back to the H.264 copy at the same resolution and bans the original", () => {
    const state = { ...createQualityState(ladder, auto1080), currentId: "src" };
    const plan = planDecodeFallback(ladder, state, 9)!;
    expect(plan.target.id).toBe("h264-1080");
    expect(plan.state.bannedIds).toContain("src");
    expect(plan.state.lastSwitchAtMs).toBe(9);
    expect(planHevcFallback(ladder, state, 9)!.target.id).toBe("h264-1080");
  });

  it("falls back to the best lower H.264 rung when there is no H.264 copy at that resolution", () => {
    const lower = [v("src", "2160p", codec, 9000), v("h264-720", "720p", "h264", 2500), v("h264-480", "480p", "h264", 1000)];
    const state = { ...createQualityState(lower, { quality: "2160p", force: false }), currentId: "src" };
    const plan = planDecodeFallback(lower, state, 1)!;
    expect(plan.target.id).toBe("h264-720");
    expect(plan.state.bannedIds).toContain("src");
  });

  it("never starts a transcode: with no H.264 copy at all there is nothing to fall back to", () => {
    const only = [v("src", "1080p", codec, 3000)];
    const state = createQualityState(only, auto1080);
    expect(planDecodeFallback(only, state, 0)).toBeNull();
  });

  it("an H.264 rung that is too heavy still steps down H.264 only, never into the original", () => {
    const state = { ...createQualityState(ladder, auto1080), currentId: "h264-1080" };
    const plan = planDecodeFallback(ladder, state, 3)!;
    expect(plan.target.id).toBe("h264-720");
  });

  it("sorts the non-H.264 original ahead of the H.264 rendition at equal rank, like HEVC", () => {
    expect(sortVariantsBestToWorst(ladder).map((variant) => variant.id)).toEqual(["src", "h264-1080", "h264-720", "h264-480"]);
  });
});

describe("best-to-worst sort", () => {
  it("sorts any rung carrying a quality and codec (the web player's stored versions) without touching the input", () => {
    const stored = [
      { quality: "720p", codec: "h264", objectKey: "a" },
      { quality: "1080p", codec: "h264", objectKey: "b" },
      { quality: "1080p", codec: "hevc", objectKey: "c" },
    ] as const;
    const sorted = sortVariantsBestToWorst(stored);
    expect(sorted.map((format) => format.objectKey)).toEqual(["c", "b", "a"]);
    expect(sorted[0]).toBe(stored[2]);
    expect(stored.map((format) => format.objectKey)).toEqual(["a", "b", "c"]);
  });
});

describe("software decode verdict", () => {
  const sample = (over: Partial<DecodeSample>): DecodeSample => ({
    nowMs: 1000,
    sampledAtMs: 1000,
    timePos: 10,
    paused: false,
    pausedForCache: false,
    seeking: false,
    droppedFrames: 0,
    hwdecCurrent: "no",
    videoCodecIsNonH264: true,
    ...over,
  });
  it("software decoding of an AV1 / VP9 original is decode-bound at once, like HEVC", () => {
    expect(stepLagDetector(createLagDetector(), sample({}))).toEqual({ lag: true, reason: "software-decode" });
  });
  it("software decoding of H.264 is not a verdict by itself", () => {
    expect(stepLagDetector(createLagDetector(), sample({ videoCodecIsNonH264: false })).lag).toBe(false);
  });
});
