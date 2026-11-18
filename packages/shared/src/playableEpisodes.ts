/**
 * Which episodes of a series can play (are uploaded) and which one comes before / after the one playing: the previous /
 * next episode buttons beside play / pause (PLAY-OVL-03) and the next episode that plays at the end (PLAY-NEXT-01), the
 * same on the desktop, the phone, the TV and the web player. Pinned in `apps/badger/mobile/tests/playback-next-episode.test.ts`
 * and `apps/badger/desktop/tests/episode-playback.test.ts`.
 */
import type { MediaDetails } from "./libraryTypes";

type MediaEpisode = MediaDetails["episodes"][number];

export type PlayableSource = Pick<MediaDetails, "type" | "episodes" | "files" | "formats" | "audioTracks">;

/**
 * "season:episode" of every episode with a stored picture (a format with an init and segments) and audio.
 * `tracksWithChunks`: ids of the formats / audio tracks that have segment rows, for details loaded without their
 * segments (empty `chunks` lists). Without it the lists themselves are checked.
 */
export const getPlayableEpisodeKeySet = (media: PlayableSource, tracksWithChunks?: ReadonlySet<string>): Set<string> => {
  const playableKeys = new Set<string>();
  if (media.type !== "tv") return playableKeys;
  const hasChunks = (track: { id: string; chunks?: unknown[] }): boolean =>
    tracksWithChunks ? tracksWithChunks.has(track.id) : Boolean(track.chunks?.length);
  const playableFileIds = new Set(
    media.formats.filter((format) => Boolean(format.initKey && hasChunks(format))).map((format) => format.fileId),
  );
  const playableEpisodeIds = new Set(
    media.audioTracks
      .filter((track) => track.episodeId && track.initKey && hasChunks(track))
      .map((track) => track.episodeId as string),
  );
  for (const file of media.files) {
    if (typeof file.season !== "number" || typeof file.episode !== "number") continue;
    if (!playableFileIds.has(file.id)) continue;
    const episode = media.episodes.find(
      (candidate) => candidate.seasonNumber === file.season && candidate.episodeNumber === file.episode,
    );
    if (!episode) continue;
    if (!playableEpisodeIds.has(episode.id)) continue;
    playableKeys.add(`${file.season}:${file.episode}`);
  }
  return playableKeys;
};

/** The uploaded episodes in season / episode order (specials, season 0, first); [] for a movie. */
export const getPlayableEpisodesOrdered = (media: PlayableSource, tracksWithChunks?: ReadonlySet<string>): MediaEpisode[] => {
  if (media.type !== "tv") return [];
  const playableKeys = getPlayableEpisodeKeySet(media, tracksWithChunks);
  return media.episodes
    .filter((episode) => playableKeys.has(`${episode.seasonNumber}:${episode.episodeNumber}`))
    .slice()
    .sort((left, right) => left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber);
};

/** The uploaded episode after `episodeId`, or null on the last one, a movie or an episode outside the playable order. */
export const getNextPlayableEpisode = (
  media: PlayableSource,
  episodeId: string | null | undefined,
  tracksWithChunks?: ReadonlySet<string>,
): MediaEpisode | null => {
  if (!episodeId || media.type !== "tv") return null;
  const ordered = getPlayableEpisodesOrdered(media, tracksWithChunks);
  const index = ordered.findIndex((episode) => episode.id === episodeId);
  if (index < 0) return null;
  return ordered[index + 1] ?? null;
};

/**
 * The uploaded episode before `episodeId`, or null on the first one, a movie or an episode outside the playable order:
 * the player's previous-episode button shows only when this is set (PLAY-OVL-03). Specials (season 0) stay out of that
 * order unless a special is playing, so S1E1 has no previous episode even when specials are uploaded. Next episode needs
 * no such filter: specials sort first, so they never follow a regular one.
 */
export const getPreviousPlayableEpisode = (
  media: PlayableSource,
  episodeId: string | null | undefined,
  tracksWithChunks?: ReadonlySet<string>,
): MediaEpisode | null => {
  if (!episodeId || media.type !== "tv") return null;
  const playable = getPlayableEpisodesOrdered(media, tracksWithChunks);
  const current = playable.find((episode) => episode.id === episodeId);
  if (!current) return null;
  const ordered = current.seasonNumber === 0 ? playable : playable.filter((episode) => episode.seasonNumber !== 0);
  const index = ordered.indexOf(current);
  return index > 0 ? (ordered[index - 1] ?? null) : null;
};
