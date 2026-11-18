/**
 * How much of a TV show is watched (LIB-PROG-01): the watched part of every episode the show has aired, out of all of
 * them, not out of the episodes that happen to be in the vault. Pure, so every app (desktop runtime, phone, TV) and the
 * metadata service share one formula.
 *
 * - "Aired" = a regular episode (season 1 and up; specials in season 0 never count) whose air date is today or earlier.
 * - The total is the aired regular episodes of the show's episode list (its metadata) when the list carries air
 *   dates; else the metadata's episode count (`total_episodes`); else the regular episodes the list holds. A show added
 *   without metadata only lists the episodes in the vault, so only then does the vault decide the total.
 */

/** Today as `YYYY-MM-DD` (UTC), the form the metadata's air dates use. */
export const airDateToday = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

export type EpisodeAirInfo = { seasonNumber: number; airDate: string | null };

const isRegular = (episode: { seasonNumber: number }): boolean => Number.isFinite(episode.seasonNumber) && episode.seasonNumber > 0;

/** Regular episodes aired by `today` (`YYYY-MM-DD`); 0 when the list has no air dates. */
export const airedEpisodeCount = (episodes: readonly EpisodeAirInfo[], today: string): number => {
  let count = 0;
  for (const episode of episodes) {
    const airDate = typeof episode.airDate === "string" ? episode.airDate.slice(0, 10) : "";
    if (isRegular(episode) && airDate.length === 10 && airDate <= today) count += 1;
  }
  return count;
};

/** Where a show's episode total came from (logged with the number, so a wrong percentage can be traced). */
export type ShowTotalSource = "aired" | "metadata" | "episodes";

export type ShowEpisodeTotal = { total: number; source: ShowTotalSource };

/**
 * The number of episodes a show's watched percentage is counted out of: aired regular episodes of its episode list,
 * else the metadata's episode count, else the regular episodes listed; null when nothing is known.
 */
export const showEpisodeTotal = (input: {
  episodes: readonly EpisodeAirInfo[];
  totalEpisodes: number | null | undefined;
  today: string;
}): ShowEpisodeTotal | null => {
  const aired = airedEpisodeCount(input.episodes, input.today);
  if (aired > 0) return { total: aired, source: "aired" };
  const metadata = Number(input.totalEpisodes);
  if (Number.isFinite(metadata) && metadata > 0) return { total: Math.floor(metadata), source: "metadata" };
  const listed = input.episodes.filter(isRegular).length;
  return listed > 0 ? { total: listed, source: "episodes" } : null;
};

/**
 * A show's watched percentage (0-100): the summed watched percentage of its regular episodes over `total`. Specials
 * never count, as they are not in the total.
 */
export const showWatchedPct = (episodes: readonly { seasonNumber: number; progressPct: number }[], total: number): number => {
  if (!Number.isFinite(total) || total <= 0) return 0;
  let sum = 0;
  for (const episode of episodes) {
    const pct = Number(episode.progressPct);
    if (isRegular(episode) && Number.isFinite(pct)) sum += Math.max(0, Math.min(100, pct));
  }
  return Math.max(0, Math.min(100, sum / total));
};

/** A show's episode row as both library databases store it (`media_episodes`). */
export type ShowEpisodeRow = { id: string; season_number: number | null; air_date: string | null };

export type ShowProgressAggregate = {
  progressPct: number;
  lastWatchedAt: string;
  total: number;
  source: ShowTotalSource;
  /** Episodes the library lists for the show. */
  listed: number;
  /** Episodes with a stored resume entry. */
  withProgress: number;
};

/**
 * A show's progress row (LIB-PROG-01) from its episode rows, its metadata episode count and the active profile's
 * episode resumes: the watched percentage over the aired total, and the latest resume time (else `now`). Null when the
 * library lists no episode of the show or no total is known.
 */
export const showProgressAggregate = (input: {
  episodeRows: readonly ShowEpisodeRow[];
  totalEpisodes: number | null | undefined;
  resume: Readonly<Record<string, { progressPct: number; updatedAt: string | null }>>;
  today: string;
  now: string;
}): ShowProgressAggregate | null => {
  if (input.episodeRows.length === 0) return null;
  const episodes = input.episodeRows.map((row) => ({ seasonNumber: Number(row.season_number), airDate: row.air_date ? String(row.air_date) : null }));
  const total = showEpisodeTotal({ episodes, totalEpisodes: input.totalEpisodes, today: input.today });
  if (!total) return null;
  const seasonById = new Map(input.episodeRows.map((row, index) => [String(row.id), episodes[index].seasonNumber]));
  const watched: { seasonNumber: number; progressPct: number }[] = [];
  let latest: string | null = null;
  for (const [episodeId, entry] of Object.entries(input.resume)) {
    watched.push({ seasonNumber: seasonById.get(episodeId) ?? 0, progressPct: entry.progressPct });
    if (entry.updatedAt && (!latest || entry.updatedAt > latest)) latest = entry.updatedAt;
  }
  return {
    progressPct: showWatchedPct(watched, total.total),
    lastWatchedAt: latest ?? input.now,
    total: total.total,
    source: total.source,
    listed: episodes.length,
    withProgress: watched.length
  };
};
