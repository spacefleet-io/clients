/**
 * @test-id MOBILE-PLAYBACK-DECODER-CAPS-001
 * @level unit
 *
 * What the phone reports about the versions it can decode (Chris 2026-10-15 chat, D3; PLAY-QUAL-06): the player asks
 * Android's MediaCodecList what the phone decodes in hardware (max size, frame rate, profile) and hands the per-version
 * verdicts to `@space/playback-abr`, whose `planStart` tests live in packages/playback-abr/tests/start-decoder-caps.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDecoderProbes,
  describeDecoderCaps,
  isTenBitCodec,
  mimeForCodec,
  variantProbe,
  type DecoderCaps,
} from "../src/lib/playback/decoderCaps";
import type { Variant } from "@space/playback-abr";

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

/** Caps as the phone reports them: every probe decodable in hardware unless listed in `hwNo`; `swNo` also fails software. */
const caps = (over: { hwNo?: string[]; swNo?: string[] } = {}, variants: Variant[] = lotr): DecoderCaps => ({
  sdk: 30,
  codecs: [
    { mime: "video/avc", hardware: { name: "c2.qti.avc.decoder", maxWidth: 4096, maxHeight: 2160, maxFps: 120, tenBit: false }, software: { name: "c2.android.avc.decoder", maxWidth: 4080, maxHeight: 4080, maxFps: null, tenBit: false } },
    { mime: "video/hevc", hardware: { name: "c2.qti.hevc.decoder", maxWidth: 4096, maxHeight: 2160, maxFps: 120, tenBit: true }, software: { name: "c2.android.hevc.decoder", maxWidth: 4096, maxHeight: 4096, maxFps: null, tenBit: false } },
  ],
  probes: variants.map((variant) => ({
    id: variant.id,
    hardware: !(over.hwNo ?? []).includes(variant.id),
    software: !(over.swNo ?? []).includes(variant.id),
  })),
});

describe("variantProbe: what the library knows about a version, as a decoder question", () => {
  /** @req PLAY-QUAL-06 */
  it("maps codec to mime, reads 10-bit from the codec string, and sizes the rung from its quality label", () => {
    const probe = variantProbe(lotr[0]!);
    console.info(`[decoder-caps] probe(2160p hevc10) = ${JSON.stringify(probe)}`);
    expect(probe).toMatchObject({ id: "u10", mime: "video/hevc", width: 3840, height: 2160, tenBit: true });
    expect(variantProbe(lotr[1]!)).toMatchObject({ mime: "video/hevc", height: 1080, tenBit: false });
    expect(variantProbe(lotr[2]!)).toMatchObject({ mime: "video/avc", height: 1080, tenBit: false });
  });

  /** @req PLAY-QUAL-06 */
  it("uses the real width/height/frame rate when the version carries them, never the nominal ones", () => {
    const probe = variantProbe({ ...lotr[0]!, width: 3840, height: 1610, fps: 23.976 });
    expect(probe).toMatchObject({ width: 3840, height: 1610, fps: 23.976 });
  });

  it("knows the codec families and 10-bit profiles", () => {
    expect(mimeForCodec("hevc")).toBe("video/hevc");
    expect(mimeForCodec("h264")).toBe("video/avc");
    expect(isTenBitCodec("hevc", "hvc1.2.4.L153.B0")).toBe(true);
    expect(isTenBitCodec("hevc", "hev1.2.4.L120.90")).toBe(true);
    expect(isTenBitCodec("hevc", "hvc1.1.6.L120.90")).toBe(false);
    expect(isTenBitCodec("h264", "avc1.640028")).toBe(false);
    expect(isTenBitCodec("h264", "avc1.6e0028")).toBe(true);
    expect(isTenBitCodec("hevc", null)).toBe(false);
  });

  /** @bugfix @regression-proof @req PLAY-QUAL-06 (#303): an AV1 / VP9 original was asked of the H.264 decoder. */
  it("@bugfix @regression-proof asks the decoder about the real codec of an AV1 / VP9 / MPEG-2 original", () => {
    expect(mimeForCodec("av1")).toBe("video/av01");
    expect(mimeForCodec("vp9")).toBe("video/x-vnd.on2.vp9");
    expect(mimeForCodec("vp8")).toBe("video/x-vnd.on2.vp8");
    expect(mimeForCodec("mpeg2")).toBe("video/mpeg2");
    expect(variantProbe(v("a", "1080p", "av1", "av01.0.08M.08", 3_000))).toMatchObject({ mime: "video/av01", tenBit: false });
    expect(variantProbe(v("p", "1080p", "vp9", "vp09.00.40.08", 3_000))).toMatchObject({ mime: "video/x-vnd.on2.vp9" });
  });

  it("@bugfix @regression-proof sends no probe for a codec it cannot name: no verdict, never a wrong one", () => {
    const odd = v("x", "1080p", "wmv3", "", 3_000);
    expect(mimeForCodec("wmv3")).toBeNull();
    expect(variantProbe(odd)).toBeNull();
    expect(buildDecoderProbes([...lotr, odd]).map((probe) => probe.id)).toEqual(["u10", "f8", "f264", "s264"]);
  });

  it("builds one probe per version", () => {
    expect(buildDecoderProbes(lotr).map((probe) => probe.id)).toEqual(["u10", "f8", "f264", "s264"]);
  });
});

describe("describeDecoderCaps (the playback.decoder.caps log line)", () => {
  /** @req PLAY-QUAL-06 */
  it("reports hardware vs software and the max size per codec", () => {
    const text = describeDecoderCaps(caps());
    console.info(`[decoder-caps] ${text}`);
    expect(text).toContain("video/hevc");
    expect(text).toContain("hw=4096x2160");
    expect(text).toContain("sw=4096x4096");
  });
});

describe("native contract", () => {
  const read = (relative: string) => readFileSync(resolve(__dirname, "../../../..", relative), "utf8");

  /** @req PLAY-QUAL-06 */
  it("the module reads MediaCodecList(REGULAR_CODECS) and exposes getDecoderCaps to JS", () => {
    const caps = read("packages/mobile-mpv-playback/android/src/main/java/com/spacefleet/mpvplayback/mpv/DecoderCaps.kt");
    const module = read("packages/mobile-mpv-playback/android/src/main/java/com/spacefleet/mpvplayback/mpv/MpvControlModule.kt");
    const binding = read("packages/mobile-mpv-playback/src/MpvControl.ts");
    expect(caps).toContain("MediaCodecList(MediaCodecList.REGULAR_CODECS)");
    expect(caps).toContain("isHardwareAccelerated");
    expect(caps).toContain("areSizeAndRateSupported");
    expect(caps).toContain("playback.decoder.caps");
    expect(module).toMatch(/@ReactMethod\s+fun getDecoderCaps\(/);
    expect(binding).toContain("getDecoderCaps");
  });
});
