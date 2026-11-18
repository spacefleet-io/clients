export type QualityPreset = "2160p" | "1080p" | "720p" | "480p" | "360p" | "240p" | "144p";
/** Codec of a rendition WE encode (transcode output): the only two codecs the encoders are ever asked for. */
export type CodecPreset = "h264" | "hevc";
/**
 * Codec of the original (source) format, as recorded in the library. A superset of `CodecPreset`: the original is
 * copied untouched, so it can be anything ffprobe reports. Known families are normalised; a codec we do not know keeps
 * its raw (lowercased) ffprobe name, and `"unknown"` means the probe reported none. Never used to pick an encoder.
 */
export type SourceCodec = CodecPreset | "av1" | "vp9" | "vp8" | "mpeg1" | "mpeg2" | "mpeg4" | "vc1" | "unknown" | (string & {});

/** ffprobe `codec_name` (any case) -> the label stored on the source format. Unknown names are kept raw, never h264. */
const SOURCE_CODEC_ALIASES: Record<string, SourceCodec> = {
  h264: "h264",
  avc: "h264",
  avc1: "h264",
  hevc: "hevc",
  h265: "hevc",
  av1: "av1",
  vp9: "vp9",
  vp8: "vp8",
  mpeg1video: "mpeg1",
  mpeg2video: "mpeg2",
  mpeg4: "mpeg4",
  vc1: "vc1",
};

export const normalizeSourceCodec = (ffprobeCodecName: string | null | undefined): SourceCodec => {
  const raw = (ffprobeCodecName ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  return Object.hasOwn(SOURCE_CODEC_ALIASES, raw) ? SOURCE_CODEC_ALIASES[raw]! : raw;
};

export const QUALITY_ORDER: QualityPreset[] = [
  "2160p",
  "1080p",
  "720p",
  "480p",
  "360p",
  "240p",
  "144p",
];

export const defaultCodecForQuality = (quality: QualityPreset): CodecPreset =>
  quality === "2160p" ? "hevc" : "h264";

export const pickReTranscodeSource = (
  target: QualityPreset,
  available: QualityPreset[],
): QualityPreset | null => {
  const tRank = QUALITY_ORDER.indexOf(target);
  if (tRank < 0) return null;
  if (available.includes(target)) return null;
  const candidates = available
    .filter((q) => {
      const r = QUALITY_ORDER.indexOf(q);
      return r >= 0 && r < tRank;
    })
    .sort((a, b) => QUALITY_ORDER.indexOf(b) - QUALITY_ORDER.indexOf(a));
  return candidates[0] ?? null;
};
