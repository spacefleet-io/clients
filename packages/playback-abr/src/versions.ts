/**
 * LIB-DETAIL-02: the versions a detail page shows as chips ("4K · HEVC", "1080p · H.264") and the one Play starts on.
 * Play's pick is the start decision every player already makes (`planStart`, PLAY-QUAL-02/06): the Settings quality,
 * else the best below it, among the versions this device can decode. Nothing here is new playback logic.
 */
import { isH264Codec, isHevcCodec, qualityRank, type Variant } from "./ladder";
import { planStart, decodableBy, type DecoderPolicy, type DecoderVerdicts, type QualitySetting } from "./start";

/** A stored video version as both apps hold it (`MediaFormat` on desktop and web). */
export type VersionLike = {
  id: string;
  quality: string;
  codec: string | null;
  bitrateKbps?: number | null;
  codecString?: string | null;
};

const CODEC_NAMES: Record<string, string> = { av1: "AV1", vp9: "VP9", vp8: "VP8", mpeg2: "MPEG-2", mpeg2video: "MPEG-2", mpeg4: "MPEG-4" };

/** "HEVC", "H.264", "AV1" ...; an unknown codec in upper case; none = "". */
export const codecDisplayName = (codec: string | null | undefined): string => {
  const raw = (codec ?? "").trim();
  if (!raw) return "";
  if (isHevcCodec(raw)) return "HEVC";
  if (isH264Codec(raw)) return "H.264";
  return CODEC_NAMES[raw.toLowerCase()] ?? raw.toUpperCase();
};

/** "4K" for 2160p, "8K" for 4320p, else the stored label ("1080p"). */
export const qualityDisplayName = (quality: string): string => {
  const label = quality.trim();
  if (label === "2160p") return "4K";
  if (label === "4320p") return "8K";
  return label;
};

/** "4K · HEVC". */
export const versionLabel = (version: Pick<VersionLike, "quality" | "codec">): string =>
  [qualityDisplayName(version.quality), codecDisplayName(version.codec)].filter(Boolean).join(" · ");

export type VersionChip = { id: string; label: string };

/** One chip per distinct label, best first (the quality ladder order; at one resolution the stored order). */
export const versionChips = (versions: readonly VersionLike[]): VersionChip[] => {
  const sorted = versions
    .map((version, index) => ({ version, index }))
    .sort((a, b) => qualityRank(a.version.quality) - qualityRank(b.version.quality) || a.index - b.index);
  const seen = new Set<string>();
  const chips: VersionChip[] = [];
  for (const { version } of sorted) {
    const label = versionLabel(version);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    chips.push({ id: version.id, label });
  }
  return chips;
};

/** A browser's HEVC answer (PLAT-WEB-04 probes) as decoder verdicts: HEVC versions decode only when the probe said yes. */
export const hevcVerdicts = (versions: readonly VersionLike[], hevcPlays: boolean): DecoderVerdicts => ({
  probes: versions.filter((version) => isHevcCodec(version.codec)).map((version) => ({ id: version.id, hardware: hevcPlays })),
});

const toVariant = (version: VersionLike): Variant => ({
  id: version.id,
  quality: version.quality,
  codec: version.codec,
  bitrateKbps: version.bitrateKbps ?? null,
  codecString: version.codecString ?? null,
});

/**
 * The version Play starts on: `planStart` with the device's Settings quality and decoder verdicts. Null when there is no
 * version, or when the device reported it can decode none of them (the web then offers the desktop player, PLAT-WEB-04).
 */
export const pickPlayVersion = <T extends VersionLike>(
  versions: readonly T[],
  setting: QualitySetting,
  caps: DecoderVerdicts | null = null,
  policy: DecoderPolicy = "hardware-first",
): T | null => {
  const picked = planStart(versions.map(toVariant), setting, caps, policy).variant;
  if (!picked || !decodableBy(caps, policy)(picked.id)) return null;
  return versions.find((version) => version.id === picked.id) ?? null;
};
