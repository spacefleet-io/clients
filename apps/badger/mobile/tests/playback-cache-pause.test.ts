/**
 * @test-id MOBILE-PLAYBACK-CACHE-PAUSE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: MpvSurfaceView set `cache-pause=no`, so mpv never raised
 * `paused-for-cache`. A network underrun then looked like "playing, but
 * time-pos frozen" and the HEVC lag detector reported `stall` after 5 s: the
 * player fell back to H.264 and banned HEVC for the session on a phone that
 * decodes it fine. The same dead flag also disabled the rebuffering spinner,
 * ABR's underrun downshift and the seek/switch settle guards. The detector's
 * contract is: an underrun is only distinguishable from decode lag if mpv
 * reports it, so the native player MUST run with `cache-pause=yes`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createLagDetector, stepLagDetector, type DecodeSample, type LagVerdict } from "@space/playback-abr";

const SURFACE_VIEW = resolve(
  __dirname,
  "../../../../packages/mobile-mpv-playback/android/src/main/java/com/spacefleet/mpvplayback/mpv/MpvSurfaceView.kt",
);

const sample = (over: Partial<DecodeSample>): DecodeSample => ({
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

// @req PLAY-CODEC-01
describe("network underrun vs HEVC decode lag", () => {
  it("@bugfix @regression-proof the native player lets mpv pause for cache so underruns are reported", () => {
    const source = readFileSync(SURFACE_VIEW, "utf8");
    const match = source.match(/setOptionString\("cache-pause",\s*"(\w+)"\)/);
    console.info(`[playback-cache-pause] cache-pause option in MpvSurfaceView.kt = ${match?.[1] ?? "<unset: mpv default yes>"}`);
    expect(match?.[1] ?? "yes", "cache-pause=no hides network underruns behind a frozen time-pos").toBe("yes");
  });

  it("@bugfix @regression-proof an underrun reported as paused-for-cache for 30 s never counts as decode lag", () => {
    const detector = createLagDetector();
    const verdicts: LagVerdict[] = [];
    for (let t = 0; t <= 30_000; t += 1_000) {
      verdicts.push(stepLagDetector(detector, sample({ nowMs: t, timePos: 10, pausedForCache: true })));
    }
    console.info(`[playback-cache-pause] verdicts=${JSON.stringify(verdicts.filter((v) => v.lag))}`);
    expect(verdicts.every((v) => !v.lag)).toBe(true);
  });

  it("@bugfix @regression-proof a stall NOT reported as paused-for-cache is still decode lag (decoder starved)", () => {
    const detector = createLagDetector();
    stepLagDetector(detector, sample({ nowMs: 0, timePos: 10 }));
    expect(stepLagDetector(detector, sample({ nowMs: 5_000, timePos: 10.2 }))).toEqual({ lag: true, reason: "stall" });
  });
});
