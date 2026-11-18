/**
 * A show's episode names and synopses in the interface language (LIB-LANG-01), applied to the details the library
 * stored. One source for every phone and TV surface that names an episode: the title page's episode list, the
 * player's header, its next-episode card and the resume prompt, so they always agree.
 */
import { episodeKey, type LocalizedEpisodeMap } from "@space/metadata-client";
import type { MediaDetails, MediaEpisode } from "@space/shared/libraryTypes";

/** The episode with its name and synopsis in the interface language, else as stored. */
export const localizeEpisode = <E extends MediaEpisode | null>(episode: E, localized: LocalizedEpisodeMap): E => {
  if (!episode || localized.size === 0) return episode;
  const found = localized.get(episodeKey(episode.seasonNumber, episode.episodeNumber));
  if (!found) return episode;
  return { ...episode, name: found.name ?? episode.name, overview: found.overview ?? episode.overview };
};

/** The details with every episode localized; the same object when there is nothing to change. */
export const localizeShowDetails = (details: MediaDetails | null, localized: LocalizedEpisodeMap): MediaDetails | null => {
  if (!details || localized.size === 0) return details;
  return { ...details, episodes: details.episodes.map((episode) => localizeEpisode(episode, localized)) };
};

/** What the player names: the show and the episodes it plays, offers next and offers before. */
export type PlaybackNames = {
  details: MediaDetails | null;
  episode: MediaEpisode | null;
  nextEpisode: MediaEpisode | null;
  previousEpisode: MediaEpisode | null;
};

/**
 * The player's session with every episode it names in the interface language, from the same map as the episode list.
 * Only names and synopses change: ids, files and numbers stay as loaded, so playback is untouched.
 */
export const localizePlayback = <S extends PlaybackNames>(session: S, localized: LocalizedEpisodeMap): S => {
  if (localized.size === 0) return session;
  return {
    ...session,
    details: localizeShowDetails(session.details, localized),
    episode: localizeEpisode(session.episode, localized),
    nextEpisode: localizeEpisode(session.nextEpisode, localized),
    previousEpisode: localizeEpisode(session.previousEpisode, localized),
  };
};
