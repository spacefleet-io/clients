/**
 * PLAY-QUAL-07 / STOR-BW-07: the quality cap the storage silo reports while it is saturated (free account `480p`,
 * Starter and Standard `1080p`, Scale none). The server cannot see resolutions, so every client enforces the cap here:
 * Auto steps down to the best rung at or under the cap and may not climb back above it.
 *
 * Rank: a higher number is a lower quality (`qualityRank`).
 */
import { qualityRank, type Variant } from "./ladder";

export type QualityCap = "480p" | "1080p";

export type CapTarget = { kind: "switch"; id: string } | { kind: "stop" };

/** The highest rung Auto may reach while the cap applies: the Settings ceiling, or the cap when that is higher quality. */
export const capCeilingRank = (settingsCeilingRank: number, cap: QualityCap): number => Math.max(settingsCeilingRank, qualityRank(cap));

const bestFirst = (a: Variant, b: Variant): number =>
  qualityRank(a.quality) - qualityRank(b.quality) || (a.bitrateKbps ?? Infinity) - (b.bitrateKbps ?? Infinity);

/**
 * What the cap asks of the playing rung: null when nothing is to be done (current at or under the cap, or already the
 * best rung there), a switch to the best rung at or under the cap (the lighter among equals), or a stop. A ladder with no
 * rung under a `480p` cap means the free viewer cannot be served: stop. Under a `1080p` cap a paying viewer is never
 * stopped: with no rung at or under it the playback carries on as is.
 */
export const capTarget = (variants: readonly Variant[], currentId: string, cap: QualityCap): CapTarget | null => {
  const capRank = qualityRank(cap);
  const current = variants.find((variant) => variant.id === currentId);
  if (current && qualityRank(current.quality) >= capRank) return null;
  const best = variants.filter((variant) => qualityRank(variant.quality) >= capRank).sort(bestFirst)[0];
  if (best) return best.id === currentId ? null : { kind: "switch", id: best.id };
  return cap === "480p" ? { kind: "stop" } : null;
};
