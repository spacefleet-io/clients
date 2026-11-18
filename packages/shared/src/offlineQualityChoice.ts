/**
 * Offline download quality choice (OFFL-QUAL-01), shared by the desktop
 * runtime estimate and the phone download planner.
 *
 * A quality label is `<height>p` (ingest labels the real frame height, so a
 * 1002x420 encode is "420p"); everything is compared by that height. Labels
 * without a height are ignored.
 *
 * - `listOfflineQualityChoices`: every quality available across a title or a
 *   batch (a season, several titles), highest first, each with the total
 *   batch size at that quality and the files that fall back to another
 *   quality ("3 episodes don't have 1080p: they get 720p"). `prompt` is false
 *   when every file has a single quality: the download then starts directly.
 * - `resolveOfflineQuality`: the quality one file gets for the chosen one:
 *   the same, else the nearest lower, else the nearest higher.
 */

export type OfflineQualityOption = {
  quality: string;
  /** Download size of the file at this quality (video + audio + subtitles). */
  bytes: number;
};

export type OfflineQualityFile = {
  fileId: string;
  options: OfflineQualityOption[];
};

export type OfflineQualityFallback = {
  /** Quality those files get instead of the chosen one. */
  quality: string;
  count: number;
};

export type OfflineQualityChoice = {
  quality: string;
  /** Total size of the batch when this quality is chosen (fallbacks included). */
  totalBytes: number;
  /** Files without this quality, grouped by the quality they get instead; highest first. */
  fallbacks: OfflineQualityFallback[];
};

export type OfflineQualityChoices = {
  /** Highest quality first. Empty when no file has a usable quality. */
  choices: OfflineQualityChoice[];
  /** Ask the user: at least one file has more than one quality. */
  prompt: boolean;
};

/** Frame height of a `<height>p` label, 0 when the label has none. */
export const offlineQualityHeight = (quality: string): number => {
  const match = /^(\d{3,4})p$/.exec(quality.trim());
  return match ? Number(match[1]) : 0;
};

/** Distinct usable qualities, highest first. */
const distinctQualities = (qualities: readonly string[]): string[] => {
  const byHeight = new Map<number, string>();
  for (const q of qualities) {
    const h = offlineQualityHeight(q);
    if (h > 0 && !byHeight.has(h)) byHeight.set(h, q);
  }
  return [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([, q]) => q);
};

/**
 * The quality a file with `available` qualities gets when the user chose
 * `chosen`: the same height, else the nearest lower one, else the nearest
 * higher one. Null when the file has no usable quality.
 */
export const resolveOfflineQuality = (available: readonly string[], chosen: string): string | null => {
  const target = offlineQualityHeight(chosen);
  const qualities = distinctQualities(available);
  if (qualities.length === 0) return null;
  const atOrBelow = qualities.find((q) => offlineQualityHeight(q) <= target);
  return atOrBelow ?? qualities[qualities.length - 1] ?? null;
};

export const listOfflineQualityChoices = (files: readonly OfflineQualityFile[]): OfflineQualityChoices => {
  const usable = files
    .map((file) => {
      // Two options at the same height: keep the first (callers pass their preferred one first).
      const bytesByQuality = new Map<string, number>();
      const seenHeights = new Set<number>();
      for (const option of file.options) {
        const height = offlineQualityHeight(option.quality);
        if (height === 0 || seenHeights.has(height)) continue;
        seenHeights.add(height);
        bytesByQuality.set(option.quality, Math.max(0, option.bytes));
      }
      return { fileId: file.fileId, bytesByQuality };
    })
    .filter((file) => file.bytesByQuality.size > 0);

  const all = distinctQualities(usable.flatMap((file) => [...file.bytesByQuality.keys()]));
  const choices = all.map((quality): OfflineQualityChoice => {
    let totalBytes = 0;
    const fallbackCounts = new Map<string, number>();
    for (const file of usable) {
      const available = [...file.bytesByQuality.keys()];
      const resolved = resolveOfflineQuality(available, quality)!;
      totalBytes += file.bytesByQuality.get(resolved) ?? 0;
      if (offlineQualityHeight(resolved) !== offlineQualityHeight(quality)) {
        fallbackCounts.set(resolved, (fallbackCounts.get(resolved) ?? 0) + 1);
      }
    }
    const fallbacks = [...fallbackCounts.entries()]
      .map(([q, count]) => ({ quality: q, count }))
      .sort((a, b) => offlineQualityHeight(b.quality) - offlineQualityHeight(a.quality));
    return { quality, totalBytes, fallbacks };
  });

  return { choices, prompt: usable.some((file) => file.bytesByQuality.size > 1) };
};
