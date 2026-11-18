/**
 * @test-id MOBILE-PLAYBACK-CACHE-CONFIG-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * The shared ABR (`@space/playback-abr`) derives its upshift buffer gate from the mpv cache the client configured (rule 2b:
 * the gate must be reachable). Mobile passes `MOBILE_DEFAULT_CACHE_CONFIG` whenever the native snapshot has no live values, so
 * that constant must equal what `MpvSurfaceView.kt` really sets - read from the Kotlin source so the two cannot drift.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { abrDecide, reachableBufferSeconds, type AbrState, type Variant } from "@space/playback-abr";
import { MOBILE_DEFAULT_CACHE_CONFIG } from "../src/lib/playback/rungSwitch";

const MPV_SURFACE_VIEW = resolve(
  __dirname,
  "../../../../packages/mobile-mpv-playback/android/src/main/java/com/spacefleet/mpvplayback/mpv/MpvSurfaceView.kt",
);

const configuredCache = (): { cacheSecs: number; demuxerMaxBytes: number } => {
  const src = readFileSync(MPV_SURFACE_VIEW, "utf8");
  const secs = Number(/setOptionString\("cache-secs",\s*"(\d+)"\)/.exec(src)?.[1]);
  const bytesMatch = /setOptionString\("demuxer-max-bytes",\s*"(\d+)(MiB|KiB)"\)/.exec(src);
  const demuxerMaxBytes = Number(bytesMatch?.[1]) * (bytesMatch?.[2] === "MiB" ? 1024 * 1024 : 1024);
  return { cacheSecs: secs, demuxerMaxBytes };
};

const v = (id: string, quality: string, codec: string, bitrateKbps: number): Variant => ({ id, quality, codec, bitrateKbps });
const ladder = [
  v("u", "2160p", "hevc", 15_000),
  v("f", "1080p", "h264", 6_000),
  v("fh", "1080p", "hevc", 3_500),
  v("h", "720p", "h264", 2_500),
  v("s", "480p", "h264", 1_000),
];

const abr = (over: Partial<AbrState>): AbrState => ({
  variants: ladder,
  currentId: "h",
  ewmaBps: 200e6,
  bufferSeconds: 0,
  underrunSinceMs: null,
  lastSwitchAtMs: null,
  nowMs: 3_600_000,
  bannedIds: new Set(),
  cacheReachedEof: false,
  loadStartedAtMs: null,
  firstFrameAtMs: null,
  lastReloadAtMs: null,
  cache: MOBILE_DEFAULT_CACHE_CONFIG,
  ...over,
});

describe("mobile mpv cache configuration", () => {
  it("MOBILE_DEFAULT_CACHE_CONFIG equals what MpvSurfaceView.kt configures", () => {
    const kotlin = configuredCache();
    console.info(`[cache-config] Kotlin: ${JSON.stringify(kotlin)}, TS constant: ${JSON.stringify(MOBILE_DEFAULT_CACHE_CONFIG)}`);
    expect(MOBILE_DEFAULT_CACHE_CONFIG).toEqual(kotlin);
  });

  /** @req PLAY-ABR-02 */
  it("@bugfix @regression-proof the upshift gate opens at a buffer level the Kotlin-configured cache can hold, for every rung", () => {
    const cache = configuredCache();
    for (const rung of ladder.filter((candidate) => candidate.id !== "u")) {
      const reachable = reachableBufferSeconds(cache, rung);
      let gate: number | null = null;
      for (let buffer = 0; buffer <= reachable + 0.001; buffer += 0.25) {
        if (abrDecide(abr({ currentId: rung.id, bufferSeconds: buffer, cache })).action === "upshift") {
          gate = buffer;
          break;
        }
      }
      console.info(`[cache-config] ${rung.id}: holds ${reachable.toFixed(1)} s, upshift gate opens at ${gate ?? "never"} s`);
      expect(gate, `upshift from ${rung.id} must open within the reachable ${reachable.toFixed(1)} s`).not.toBeNull();
    }
  });
});
