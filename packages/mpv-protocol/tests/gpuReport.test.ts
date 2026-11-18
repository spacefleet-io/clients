/**
 * @test-id MPV-GPU-REPORT-001
 * @level unit
 * @why MPV-GPU-02: the phone and TV players log, in release builds, one native `playback.gpu` line naming the decoder and
 *   the video output mpv really uses; the e2e harnesses (e2e-phone `nativeGpuLines`, e2e-tv `gpuReports`) read it back
 *   through this one parser. Pins the Android and iOS line shapes, logcat / unified-log prefixes, `none` before a decoder
 *   exists, and the gpu/cpu + hardware/software verdict (Android TV direct render counts as GPU output).
 *   The rule cells stay pending until a run on real devices.
 * @req MPV-GPU-02[badger-mobile,badger-tv]
 */
import { describe, expect, it } from "vitest";
import { MPV_GPU_REPORT_TAG, parseMpvGpuReport } from "../src/renderPath";

const ID = "MPV-GPU-REPORT-001";
const log = (phase: string, data: unknown) => console.info(`[${ID}] ${phase}`, JSON.stringify(data));

const parse = (name: string, line: string) => {
  log(`${name}: line`, line);
  const report = parseMpvGpuReport(line);
  log(`${name}: report`, report);
  return report;
};

describe("parseMpvGpuReport", () => {
  it("Android phone logcat line: hardware decode on the GPU vo", () => {
    const r = parse("android-phone", "1762400000.123  4321  4400 I MpvPlayback: playback.gpu hwdec-current=mediacodec current-vo=gpu codec=hevc 3840x2160");
    expect(r).toEqual({
      hwdec: "mediacodec",
      vo: "gpu",
      codec: "hevc",
      width: 3840,
      height: 2160,
      pixfmt: null,
      render: { rendering: "gpu", decoding: "hardware" },
    });
  });

  it("Android TV direct render counts as GPU output", () => {
    const r = parse("android-tv", "I MpvPlayback: playback.gpu hwdec-current=mediacodec current-vo=mediacodec_embed codec=h264 1920x1080");
    expect(r?.vo).toBe("mediacodec_embed");
    expect(r?.render).toEqual({ rendering: "gpu", decoding: "hardware" });
  });

  it("software decode reads as such", () => {
    const r = parse("software", "playback.gpu hwdec-current=no current-vo=gpu codec=av1 1280x720");
    expect(r?.render).toEqual({ rendering: "gpu", decoding: "software" });
  });

  it("iOS unified-log line with the pixel formats", () => {
    const r = parse("ios", "2026-11-06 04:00:00.000 Badger[123:456] [com.spacefleet.mpvplayback] playback.gpu hwdec-current=videotoolbox current-vo=gpu-next codec=hevc 3840x1608 pixfmt=videotoolbox/p010");
    expect(r).toMatchObject({ hwdec: "videotoolbox", vo: "gpu-next", codec: "hevc", width: 3840, height: 1608, pixfmt: "videotoolbox/p010" });
    expect(r?.render).toEqual({ rendering: "gpu", decoding: "hardware" });
  });

  it("`none` and empty values before the decoder exists read as null / unknown", () => {
    const r = parse("none", "playback.gpu hwdec-current=none current-vo=none codec= 0x0");
    expect(r).toEqual({ hwdec: null, vo: null, codec: null, width: null, height: null, pixfmt: null, render: { rendering: "unknown", decoding: "unknown" } });
  });

  it("other lines hold no report", () => {
    log("tag", MPV_GPU_REPORT_TAG);
    expect(parse("other", "I MpvPlayback: playback.audio ao=audiotrack passthrough=ac3 pcm-channels=stereo")).toBeNull();
    expect(parse("readback-failed", "W MpvPlayback: playback.gpu readback failed: mpv core is not live")).toBeNull();
  });
});
