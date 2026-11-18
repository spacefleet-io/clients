/** Lowest regular season (above 0) among `numbers`, else the first one listed; null when there is none. */
const lowestRegular = (numbers: readonly number[]): number | null => {
  let lowest: number | null = null;
  for (const n of numbers) {
    if (n > 0 && (lowest === null || n < lowest)) lowest = n;
  }
  return lowest ?? numbers[0] ?? null;
};

/**
 * Season a show's page opens on (UX-TV-08): the one being resumed, else the first season with a file in the library,
 * else the first regular season. Season 0 is TMDB's "Specials" (extras), so it is chosen only when no regular season
 * qualifies.
 */
export const defaultSeason = (
  seasonNumbers: readonly number[],
  resumeSeason: number | null,
  seasonsWithFiles: ReadonlySet<number>,
): number => {
  if (resumeSeason !== null) return resumeSeason;
  return lowestRegular(seasonNumbers.filter((n) => seasonsWithFiles.has(n))) ?? lowestRegular(seasonNumbers) ?? 1;
};
