/**
 * The quality ladder: labels, ranks and the `Variant` every client maps its own format / rendition record onto.
 * Variant ids are opaque strings (desktop `format.id`, mobile `variant.id`); only `quality` and `codec` carry meaning.
 */
export const QUALITY_ORDER = ["2160p", "1080p", "720p", "480p", "360p", "240p", "144p"] as const;
export type QualityPreset = (typeof QUALITY_ORDER)[number];

/** Pixel height of each quality label (the ingest scale target). */
export const QUALITY_HEIGHT_PX: Record<string, number> = {
  "2160p": 2160,
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
  "360p": 360,
  "240p": 240,
  "144p": 144,
};

export type Variant = {
  id: string;
  /** Quality label (`QUALITY_ORDER`); an unknown label ranks below every known one. */
  quality: string;
  /**
   * The stored codec of the version (`h264`, `hevc`, `av1`, `vp9`, `mpeg2` ..., or the raw ffprobe name of a codec ingest
   * does not know); null when the client does not know it, which counts as H.264 (the safe side).
   */
  codec: string | null;
  bitrateKbps: number | null;
  /** RFC 6381 codec string (`hvc1.2.4.L153.B0`): carries the profile, hence the bit depth. */
  codecString?: string | null;
  /** Real picture size / frame rate when the library knows them: decoder probes prefer them. */
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  /**
   * The rung's media segments (start time, size on the wire), sorted by start, when the client knows them. A rung switch
   * must fetch the whole segment at the playing position first; the drain rule (`abrDecide`) needs these and is off without.
   */
  segments?: readonly VariantSegment[] | null;
};

/** One media segment of a rung: where it starts in the timeline and how many bytes it is. */
export type VariantSegment = { startSeconds: number; sizeBytes: number };

export const AUDIO_BITRATE_KBPS_FALLBACK = 128;
export const VARIANT_BITRATE_KBPS_FALLBACK = 5000;

/**
 * Place in `QUALITY_ORDER` (0 = best). A `<height>p` label outside the ladder ("420p", "1440p") ranks by its height between
 * its neighbours, so every client lists it in one place; a label with no height ranks below every known one.
 */
export const qualityRank = (quality: string): number => {
  const idx = (QUALITY_ORDER as readonly string[]).indexOf(quality);
  if (idx !== -1) return idx;
  const match = /^(\d{3,4})p$/.exec(quality.trim());
  if (!match) return QUALITY_ORDER.length;
  const height = Number(match[1]);
  return QUALITY_ORDER.filter((q) => QUALITY_HEIGHT_PX[q]! > height).length - 0.5;
};

export const isHevcCodec = (codec: string | null | undefined): boolean => /hevc|h\.?265|hev1|hvc1/i.test(codec ?? "");

export const isH264Codec = (codec: string | null | undefined): boolean => /h\.?264|avc/i.test(codec ?? "");

/**
 * The version is NOT H.264, so a decode-bound device falls back to the H.264 copy: HEVC, and every other original
 * (AV1, VP9, MPEG-2 ..., an unknown codec) the library keeps as uploaded. A codec the client does not know (null /
 * empty) is not flagged: nothing says it is heavy.
 */
export const needsH264Fallback = (codec: string | null | undefined): boolean => (codec ?? "").trim() !== "" && !isH264Codec(codec);

/**
 * Best -> worst. At equal rank the ingested original when it is not H.264 (HEVC, AV1, VP9 ...: kept as uploaded, usually
 * smaller at the same quality) comes before the H.264 rendition; a codec proven undecodable is banned (`bannedIds`), not
 * reordered. Generic so a client sorting its own version records (the web player's stored formats) uses this one order.
 */
export const sortVariantsBestToWorst = <T extends Pick<Variant, "quality" | "codec">>(variants: readonly T[]): T[] =>
  [...variants].sort(
    (a, b) => qualityRank(a.quality) - qualityRank(b.quality) || Number(needsH264Fallback(b.codec)) - Number(needsH264Fallback(a.codec)),
  );

/** Video + audio bits/s a rung needs on the wire. */
export const effectiveBitrateBps = (variant: Variant): number =>
  ((variant.bitrateKbps ?? VARIANT_BITRATE_KBPS_FALLBACK) + AUDIO_BITRATE_KBPS_FALLBACK) * 1000;

/** Best of the rungs strictly below `current` (the next one down), skipping banned ids. */
export const oneStepDown = (variants: Variant[], current: Variant, banned: ReadonlySet<string>): Variant | null => {
  const currentRank = qualityRank(current.quality);
  const candidates = sortVariantsBestToWorst(variants).filter(
    (v) => v.id !== current.id && !banned.has(v.id) && qualityRank(v.quality) > currentRank,
  );
  return candidates[0] ?? null;
};
