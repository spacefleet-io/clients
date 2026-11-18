import { describe, expect, it } from "vitest";
import { QUALITY_ORDER, defaultCodecForQuality } from "../src/quality";
import {
  estimateBitrateKbps,
  estimateFromFile,
  estimateFromSourceFormat,
  estimateSizeMb,
} from "../src/labQueueShared";

const SUITE = "quality-estimators";

const dumpLadder = (
  label: string,
  rows: ReadonlyArray<{ quality: string; value: number }>,
) => {
  try {
    console.error(`=== [${SUITE}:${label}] ladder snapshot ===`);
    for (const row of rows) {
      console.error(`  ${row.quality.padEnd(6)} -> ${row.value}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

/**
 * Regression coverage for the AddQualityModal size-estimate bug
 * (screenshot 2026-05-25): the "add more qualities" form showed 420p as
 * ~5.7 GB (larger than the 2.9 GB 1080p source) because 420p was present in
 * QUALITY_ORDER but missing from the three estimator tables in
 * labQueueShared.ts. The lookup fell through to base["1080p"] (5000 kbps),
 * producing a size estimate *larger* than the source itself.
 *
 * Two-pronged guarantee:
 *  1. 420p is removed from the YouTube-aligned ladder (the team's stated
 *     intent — 144/240/360/480/720/1080/2160 only).
 *  2. ANY future addition of a QUALITY_ORDER entry that lacks a matching
 *     bitrate/size/ratio row would silently fall back to the highest preset's
 *     value and break monotonicity. Strict-decreasing assertions across the
 *     whole ladder catch that class of bug, not just the 420p instance.
 */
describe("quality estimator ladder is monotonic — @bugfix @regression-proof", () => {
  it("420p is not in QUALITY_ORDER (YouTube-aligned ladder)", () => {
    console.info(`[${SUITE}:exec] QUALITY_ORDER=${JSON.stringify(QUALITY_ORDER)}`);
    try {
      expect(QUALITY_ORDER).not.toContain("420p");
    } catch (err) {
      dumpLadder(
        "qualityorder-includes-420p",
        QUALITY_ORDER.map((q, i) => ({ quality: q, value: i })),
      );
      throw err;
    }
  });

  it("estimateBitrateKbps decreases strictly across QUALITY_ORDER (h264)", () => {
    const ladder = QUALITY_ORDER.map((quality) => ({
      quality,
      value: estimateBitrateKbps(quality, "h264"),
    }));
    console.info(`[${SUITE}:exec] estimateBitrateKbps h264 ladder=${JSON.stringify(ladder)}`);
    try {
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i].value).toBeLessThan(ladder[i - 1].value);
      }
    } catch (err) {
      dumpLadder("bitrate-h264-non-monotonic", ladder);
      throw err;
    }
  });

  it("estimateBitrateKbps decreases strictly across QUALITY_ORDER (hevc)", () => {
    const ladder = QUALITY_ORDER.map((quality) => ({
      quality,
      value: estimateBitrateKbps(quality, "hevc"),
    }));
    console.info(`[${SUITE}:exec] estimateBitrateKbps hevc ladder=${JSON.stringify(ladder)}`);
    try {
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i].value).toBeLessThan(ladder[i - 1].value);
      }
    } catch (err) {
      dumpLadder("bitrate-hevc-non-monotonic", ladder);
      throw err;
    }
  });

  it("estimateSizeMb decreases strictly across QUALITY_ORDER (movie, default codec)", () => {
    const ladder = QUALITY_ORDER.map((quality) => ({
      quality,
      value: estimateSizeMb(quality, defaultCodecForQuality(quality), "movie"),
    }));
    console.info(`[${SUITE}:exec] estimateSizeMb movie ladder=${JSON.stringify(ladder)}`);
    try {
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i].value).toBeLessThan(ladder[i - 1].value);
      }
    } catch (err) {
      dumpLadder("sizemb-movie-non-monotonic", ladder);
      throw err;
    }
  });

  it("estimateFromFile decreases strictly across the sub-source ladder for a 2900 MB 1080p source (Cartographer-scale)", () => {
    // The modal only shows presets *below* the source quality (pickReTranscodeSource
    // returns null when target rank >= source rank), so the realistic monotonicity
    // contract is over the sub-source ladder. This is the exact path that produced
    // the broken 420p row pre-fix: estimateFromFile fell back to ratio 0.7 (1080p),
    // which equaled the source-side estimate.
    const sourceSizeMb = 2900; // mirrors the reported Cartographer movie source.
    const sourceIdx = QUALITY_ORDER.indexOf("1080p");
    const subSourceLadder = QUALITY_ORDER.slice(sourceIdx + 1).map((quality) => ({
      quality,
      value: estimateFromFile(sourceSizeMb, quality, defaultCodecForQuality(quality), "movie"),
    }));
    console.info(`[${SUITE}:exec] estimateFromFile Cartographer-source sub-ladder=${JSON.stringify(subSourceLadder)}`);
    try {
      for (let i = 1; i < subSourceLadder.length; i++) {
        expect(subSourceLadder[i].value).toBeLessThan(subSourceLadder[i - 1].value);
      }
    } catch (err) {
      dumpLadder("fromfile-non-monotonic", subSourceLadder);
      throw err;
    }
  });

  it("estimateFromFile keeps a sub-source 720p estimate when source is 2900 MB (no 2.8-GB-out-of-2.9-GB anomaly)", () => {
    // Pre-fix the modal used estimateBitrateKbps + duration, which produced
    // ~2.8 GB for 720p given a ~150-min movie — i.e. ~96% of the source.
    // estimateFromFile is the ratio-based path; a 720p target must stay
    // well below the source size and well above the 480p estimate.
    const sourceSizeMb = 2900;
    const v720 = estimateFromFile(sourceSizeMb, "720p", "h264", "movie");
    const v480 = estimateFromFile(sourceSizeMb, "480p", "h264", "movie");
    console.info(`[${SUITE}:exec] 720p=${v720} MB 480p=${v480} MB source=${sourceSizeMb} MB`);
    try {
      expect(v720).toBeLessThan(sourceSizeMb * 0.7); // must be meaningfully smaller than source
      expect(v720).toBeGreaterThan(v480);
    } catch (err) {
      dumpLadder("720p-vs-source", [
        { quality: "source-1080p", value: sourceSizeMb },
        { quality: "720p", value: v720 },
        { quality: "480p", value: v480 },
      ]);
      throw err;
    }
  });
});

/**
 * Pixel-ratio + constant-audio estimator (`estimateFromSourceFormat`).
 *
 * Fixes the follow-up complaint after the 420p removal: even the
 * ratio-based estimator still over-counted at low resolutions because
 * audio bitrate is fixed (~96 kbps) while the ratio scales the FULL
 * source bitrate (audio + video). For a 2.6 Mbps 1080p Cartographer source, the
 * 360p→240p gap was only ~150 MB, with absolute numbers (638/464 MB)
 * larger than users expect.
 *
 * New model: scale ONLY the source video bitrate by pixel ratio, keep
 * audio constant, cap by the static bitrate ceiling. Reproduces
 * streaming-quality estimates while staying sensible for high-bitrate
 * disc remuxes (the cap kicks in for them at low resolutions).
 */
describe("estimateFromSourceFormat — pixel-ratio model — @bugfix @regression-proof", () => {
  // Cartographer-scale fixture: 1080p source, 2.9 GB, 150 min ≈ 2641 kbps total.
  const CARTOGRAPHER = {
    sourceSizeMb: 2900,
    sourceQuality: "1080p" as const,
    durationSeconds: 150 * 60,
    mediaType: "movie" as const,
  };

  it("produces a 360p estimate under 500 MB for a Cartographer-scale 1080p source (was 638 MB pre-fix)", () => {
    const v360 = estimateFromSourceFormat({
      ...CARTOGRAPHER,
      targetQuality: "360p",
      targetCodec: "h264",
    });
    console.info(`[${SUITE}:exec] Cartographer 360p estimate=${v360} MB (pre-fix ratio-based was 638)`);
    try {
      expect(v360).not.toBeNull();
      expect(v360!).toBeGreaterThan(150); // not unrealistically small
      expect(v360!).toBeLessThan(500); // user-reported expectation
    } catch (err) {
      dumpLadder("cartographer-360p-too-large", [{ quality: "360p", value: v360 ?? -1 }]);
      throw err;
    }
  });

  it("keeps a meaningful gap (>150 MB) between 360p and 240p for Cartographer-scale source", () => {
    const v360 = estimateFromSourceFormat({
      ...CARTOGRAPHER,
      targetQuality: "360p",
      targetCodec: "h264",
    });
    const v240 = estimateFromSourceFormat({
      ...CARTOGRAPHER,
      targetQuality: "240p",
      targetCodec: "h264",
    });
    const gap = (v360 ?? 0) - (v240 ?? 0);
    console.info(`[${SUITE}:exec] Cartographer 360p=${v360} MB 240p=${v240} MB gap=${gap} MB`);
    try {
      expect(v360).not.toBeNull();
      expect(v240).not.toBeNull();
      expect(gap).toBeGreaterThan(150);
    } catch (err) {
      dumpLadder("cartographer-360-240-gap-too-narrow", [
        { quality: "360p", value: v360 ?? -1 },
        { quality: "240p", value: v240 ?? -1 },
        { quality: "gap", value: gap },
      ]);
      throw err;
    }
  });

  it("decreases strictly across the sub-source ladder for Cartographer-scale source", () => {
    const ladder = QUALITY_ORDER.slice(QUALITY_ORDER.indexOf("1080p") + 1).map((quality) => ({
      quality,
      value:
        estimateFromSourceFormat({
          ...CARTOGRAPHER,
          targetQuality: quality,
          targetCodec: defaultCodecForQuality(quality),
        }) ?? -1,
    }));
    console.info(`[${SUITE}:exec] Cartographer sub-source ladder=${JSON.stringify(ladder)}`);
    try {
      for (const row of ladder) {
        expect(row.value).toBeGreaterThan(0);
      }
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i].value).toBeLessThan(ladder[i - 1].value);
      }
    } catch (err) {
      dumpLadder("cartographer-sub-source-not-monotonic", ladder);
      throw err;
    }
  });

  it("caps target bitrate by the static ceiling for high-bitrate disc remux sources", () => {
    // 12 GB / 150 min ≈ 11.4 Mbps 1080p remux. Without a cap, the pixel
    // ratio would push 720p video bitrate to ~5 Mbps — wasteful and
    // unrealistic for a fresh 720p encode. The static cap (estimateBitrateKbps
    // 720p h264 = 2500 kbps) should kick in.
    const v720 = estimateFromSourceFormat({
      sourceSizeMb: 12000,
      sourceQuality: "1080p",
      durationSeconds: 150 * 60,
      mediaType: "movie",
      targetQuality: "720p",
      targetCodec: "h264",
    });
    console.info(`[${SUITE}:exec] disc-remux-source 720p estimate=${v720} MB (capped)`);
    try {
      expect(v720).not.toBeNull();
      // 2500 kbps cap + 96 kbps audio = 2596 kbps * 9000 / 8 / 1024 ≈ 2853 MB.
      // Allow a small tolerance.
      expect(v720!).toBeLessThan(3000);
      expect(v720!).toBeGreaterThan(2500);
    } catch (err) {
      dumpLadder("disc-remux-720p-uncapped", [{ quality: "720p", value: v720 ?? -1 }]);
      throw err;
    }
  });

  it("returns null when source quality is unknown (caller falls back to ratio estimator)", () => {
    const v = estimateFromSourceFormat({
      ...CARTOGRAPHER,
      sourceQuality: "unknown-quality",
      targetQuality: "360p",
      targetCodec: "h264",
    });
    console.info(`[${SUITE}:exec] unknown source quality -> ${v}`);
    try {
      expect(v).toBeNull();
    } catch (err) {
      console.error(`[${SUITE}:exec] expected null, got ${v}`);
      throw err;
    }
  });

  it("returns null when duration is missing (caller falls back)", () => {
    const v = estimateFromSourceFormat({
      ...CARTOGRAPHER,
      durationSeconds: null,
      targetQuality: "360p",
      targetCodec: "h264",
    });
    console.info(`[${SUITE}:exec] missing duration -> ${v}`);
    try {
      expect(v).toBeNull();
    } catch (err) {
      console.error(`[${SUITE}:exec] expected null, got ${v}`);
      throw err;
    }
  });

  it("returns null when target quality is >= source (modal already filters these)", () => {
    const v = estimateFromSourceFormat({
      ...CARTOGRAPHER,
      targetQuality: "2160p",
      targetCodec: "hevc",
    });
    console.info(`[${SUITE}:exec] target 2160p with 1080p source -> ${v}`);
    try {
      expect(v).toBeNull();
    } catch (err) {
      console.error(`[${SUITE}:exec] expected null, got ${v}`);
      throw err;
    }
  });

  it("applies the TV factor (×0.85) for episodic media", () => {
    const movie = estimateFromSourceFormat({
      ...CARTOGRAPHER,
      targetQuality: "360p",
      targetCodec: "h264",
      mediaType: "movie",
    });
    const tv = estimateFromSourceFormat({
      ...CARTOGRAPHER,
      targetQuality: "360p",
      targetCodec: "h264",
      mediaType: "tv",
    });
    console.info(`[${SUITE}:exec] movie 360p=${movie} tv 360p=${tv}`);
    try {
      expect(movie).not.toBeNull();
      expect(tv).not.toBeNull();
      expect(tv!).toBeLessThan(movie!);
      // ~15% reduction expected (×0.85 factor, rounding-tolerant).
      expect(tv!).toBeGreaterThan(Math.round(movie! * 0.75));
    } catch (err) {
      console.error(`[${SUITE}:exec] TV factor mismatch movie=${movie} tv=${tv}`);
      throw err;
    }
  });
});
