/**
 * Which episode a show's main Play starts (LIB-DETAIL-01), one rule for every Badger app: the episode the profile
 * last played, else the first episode with a file not yet watched (when the app knows what is watched), else the
 * first episode with a file. Episodes are in season / episode order.
 */
export const pickShowPlayEpisode = <E extends { id: string }>(
  episodes: readonly E[],
  options: {
    /** The episode last played on this profile; it wins even without a file here (the app says why it cannot play). */
    resumeEpisodeId: string | null;
    hasFile: (episode: E) => boolean;
    /** Omitted when the app does not know which episodes are watched. */
    isWatched?: (episode: E) => boolean;
  }
): E | null => {
  const resume = options.resumeEpisodeId ? episodes.find((episode) => episode.id === options.resumeEpisodeId) : undefined;
  if (resume) return resume;
  const withFile = episodes.filter(options.hasFile);
  const { isWatched } = options;
  return (isWatched ? withFile.find((episode) => !isWatched(episode)) : undefined) ?? withFile[0] ?? null;
};
