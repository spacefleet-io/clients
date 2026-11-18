/**
 * @test-id MOBILE-PLAYBACK-TIMELINE-SEEK-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why exists: a timeline seek (tap / drag the scrubber far away) took 1328-1551 ms on the OnePlus 6 (budget 1000 ms,
 * scenario `seek-timeline`). mpv logs after the seek event: ~260 ms fetching the cold audio segment, then ~1000-1100 ms
 * between `Decoder format` and `first video frame after restart shown`. Segments are 12 s with ONE keyframe each, so an
 * exact seek decodes up to ~290 HEVC frames from the keyframe to the target, and Android's MediaCodec decodes them at its
 * real-time pace unless it is told an `operating-rate`. With `vd-lavc-o=operating_rate=240` (ffmpeg's hevc_mediacodec
 * forwards it to MediaFormat `operating-rate`) that phase dropped to ~580 ms and the seek to 977-1098 ms.
 *
 * The rate cannot be a constant: the Qualcomm decoder REJECTS a rate above its performance point for the size (480 at
 * 1920x804 fell back to software decoding, `yuv420p`, 1642-1786 ms; its 4K point is 60). So the rate comes from the
 * hardware decoders' `supportedPerformancePoints` for the variant's size, and is passed per file at every `loadfile`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(__dirname, "../../../../packages/mobile-mpv-playback/android/src/main/java/com/spacefleet/mpvplayback");
const proxyServerPath = resolve(__dirname, "../../../../packages/mobile-media-proxy/android/src/main/java/com/spacefleet/mediaproxy/PlaybackHttpServer.kt");
const kt = (name: string): string => readFileSync(resolve(srcDir, name), "utf8");
const TEST_ID = "[MOBILE-PLAYBACK-TIMELINE-SEEK-001]";

describe("timeline seek: MediaCodec runs at its operating rate during the keyframe-to-target decode", () => {
  it("@regression-proof DecoderCaps derives the operating rate from the hardware decoders' performance points", () => {
    const caps = kt("mpv/DecoderCaps.kt");
    const fn = caps.indexOf("fun operatingRateFor(");
    console.info(TEST_ID, "DecoderCaps.operatingRateFor at", fn);
    expect(fn).toBeGreaterThan(-1);
    const body = caps.slice(fn);
    expect(body).toContain("supportedPerformancePoints");
    expect(body).toContain(".covers(");
    expect(body).toContain("hardware");
  });

  it("@regression-proof the proxy maps each master playlist URL to an `operating_rate` per-file option", () => {
    // The proxy carries no player: the mpv package installs DecoderCaps as the proxy's operating-rate hook.
    const server = readFileSync(proxyServerPath, "utf8");
    const pkg = kt("MpvPlaybackPackage.kt");
    console.info(TEST_ID, "server uses the operatingRate hook:", server.includes("MediaProxyHooks.operatingRate"), "mpv package installs DecoderCaps:", pkg.includes("DecoderCaps.operatingRateFor("));
    expect(server).toContain("MediaProxyHooks.operatingRate");
    expect(pkg).toMatch(/MediaProxyHooks\.operatingRate = [\s\S]*DecoderCaps\.operatingRateFor\(/);
    expect(server).toContain("vd-lavc-o=operating_rate=");
    expect(server).toContain("fun perFileDecoderOptions(url: String)");
  });

  it("@regression-proof every loadfile goes through MpvLoadfile, which appends the per-file decoder options", () => {
    const loadfile = kt("mpv/MpvLoadfile.kt");
    expect(loadfile).toContain("PlaybackHttpServer.perFileDecoderOptions(");
    for (const name of ["mpv/MpvControlModule.kt", "mpv/MpvSurfaceView.kt"]) {
      const src = kt(name);
      const raw = (src.match(/arrayOf\("loadfile"/g) ?? []).length;
      const routed = (src.match(/MpvLoadfile\.args\(/g) ?? []).length;
      console.info(TEST_ID, name, "raw loadfile arrays:", raw, "MpvLoadfile.args calls:", routed);
      expect(raw).toBe(0);
      expect(routed).toBeGreaterThan(0);
    }
  });

  it("no fixed operating rate in the global options (a too-high rate makes the decoder fall back to software)", () => {
    const view = kt("mpv/MpvSurfaceView.kt");
    expect(view).not.toMatch(/setOptionString\("vd-lavc-o"/);
  });
});
