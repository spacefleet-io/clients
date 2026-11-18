import type { MediaDetails, MediaEpisode } from "@space/shared/libraryTypes";
import { pickShowPlayEpisode } from "@space/shared/showPlayEpisode";

/** Key of an episode in the set returned by `uploadedEpisodeKeys`. */
export const episodeFileKey = (seasonNumber: number, episodeNumber: number): string => `${seasonNumber}-${episodeNumber}`;

/** `season-episode` keys of the episodes of a show that have a file (a show lists episodes it has no file for). */
export const uploadedEpisodeKeys = (details: MediaDetails | null): Set<string> => {
  if (!details || details.type !== "tv") return new Set<string>();
  return new Set(
    details.files
      .filter((file) => typeof file.season === "number" && typeof file.episode === "number")
      .map((file) => episodeFileKey(file.season as number, file.episode as number)),
  );
};

/** Seasons with at least one episode file. */
export const uploadedSeasonNumbers = (keys: ReadonlySet<string>): Set<number> => {
  const seasons = new Set<number>();
  keys.forEach((key) => {
    const [season] = key.split("-");
    seasons.add(Number(season));
  });
  return seasons;
};

/** The episode a show's Play button starts: the last played one, else the first one with a file (`pickShowPlayEpisode`). */
export const playEpisode = (
  details: MediaDetails | null,
  resumeEpisodeId: string | null,
  keys: ReadonlySet<string>,
): MediaEpisode | null => {
  if (!details || details.type !== "tv") return null;
  return pickShowPlayEpisode(details.episodes, {
    resumeEpisodeId,
    hasFile: (episode) => keys.has(episodeFileKey(episode.seasonNumber, episode.episodeNumber)),
  });
};
