/**
 * What the phone can really decode (`MpvControl.getDecoderCaps`: Android reads `MediaCodecList` natively, the iPhone uses
 * Apple's published limits for its model, `@space/mobile-mpv-playback` `iosDecoderCaps.ts`) and how the
 * start quality uses it (Chris 2026-10-15 chat, D3; spec PLAY-QUAL-06). Pure: no React, no native.
 *
 * Only what the device reports counts: a version the device did not answer for is "unknown", never "undecodable".
 * The library stores a version's quality label, codec and codec string but not its pixel size or frame rate, so a probe for
 * such a version asks about the label's nominal size (16:9 at the label's height) at 30 fps. Real width/height/fps on the
 * `Variant` win as soon as the library carries them.
 */
import type { CodecCaps, DecoderCaps, DecoderLimits, DecoderProbe, ProbeResult } from "@space/mobile-mpv-playback";
import { QUALITY_HEIGHT_PX, isH264Codec, isHevcCodec, type Variant } from "@space/playback-abr";

export const MIME_AVC = "video/avc";
export const MIME_HEVC = "video/hevc";
export const MIME_AV1 = "video/av01";
export const MIME_VP9 = "video/x-vnd.on2.vp9";
export const NOMINAL_FPS = 30;

export type { CodecCaps, DecoderCaps, DecoderLimits, DecoderProbe, ProbeResult };

/** The library's source codec labels (`normalizeSourceCodec`, #303) that MediaCodec has a mime for besides H.264 / HEVC. */
const MIME_BY_CODEC: Record<string, string> = {
  av1: MIME_AV1,
  vp9: MIME_VP9,
  vp8: "video/x-vnd.on2.vp8",
  mpeg2: "video/mpeg2",
  mpeg4: "video/mp4v-es",
};

/**
 * The MediaCodec mime to ask about. No codec (an older row) = H.264, as before. A codec we cannot name returns null: the
 * version gets no probe, so it stays "unknown" (eligible), never judged by the wrong decoder (AV1 used to be asked of AVC).
 */
export const mimeForCodec = (codec: string | null | undefined): string | null => {
  const name = (codec ?? "").trim().toLowerCase();
  if (!name || isH264Codec(name)) return MIME_AVC;
  if (isHevcCodec(name)) return MIME_HEVC;
  return Object.hasOwn(MIME_BY_CODEC, name) ? MIME_BY_CODEC[name]! : null;
};

/** HEVC `hvc1.2.*` / `hev1.2.*` = Main10; AVC `avc1.PPCCLL` with profile_idc 110 / 122 / 244 = High10 / 4:2:2 / 4:4:4. */
export const isTenBitCodec = (codec: string | null | undefined, codecString: string | null | undefined): boolean => {
  const text = (codecString ?? "").toLowerCase();
  if (isHevcCodec(codec)) return /^(?:hvc1|hev1)\.[abc]?2(?:\.|$)/.test(text);
  const match = /^avc[13]\.([0-9a-f]{2})/.exec(text);
  return match ? [0x6e, 0x7a, 0xf4].includes(parseInt(match[1]!, 16)) : false;
};

const even = (value: number): number => Math.round(value / 2) * 2;

export const variantProbe = (variant: Variant): DecoderProbe | null => {
  const mime = mimeForCodec(variant.codec);
  if (!mime) {
    console.info(`[decoderCaps] no mime for codec "${variant.codec}" (version ${variant.id}): no decoder probe, verdict stays unknown`);
    return null;
  }
  const height = variant.height ?? QUALITY_HEIGHT_PX[variant.quality] ?? 1080;
  return {
    id: variant.id,
    mime,
    width: variant.width ?? even((height * 16) / 9),
    height,
    fps: variant.fps ?? NOMINAL_FPS,
    tenBit: isTenBitCodec(variant.codec, variant.codecString),
  };
};

export const buildDecoderProbes = (variants: Variant[]): DecoderProbe[] =>
  variants.flatMap((variant) => {
    const probe = variantProbe(variant);
    return probe ? [probe] : [];
  });

const limitsText = (limits: DecoderLimits | null): string =>
  limits ? `${limits.maxWidth}x${limits.maxHeight}${limits.maxFps ? `@${limits.maxFps}` : ""}${limits.tenBit ? "+10bit" : ""}` : "none";

/** One line for `playback.decoder.caps`: per mime the hardware and software maximum. */
export const describeDecoderCaps = (caps: DecoderCaps): string =>
  `sdk=${caps.sdk} ` + caps.codecs.map((codec) => `${codec.mime} hw=${limitsText(codec.hardware)} sw=${limitsText(codec.software)}`).join("; ");
