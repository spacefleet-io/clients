/**
 * Episode labels and the skip markers of the item playing. Which episode comes before / after lives in
 * `@space/shared/playableEpisodes`, shared with the desktop and web players.
 */
import type { MediaDetails, MediaSkipMarker } from "@space/shared/libraryTypes";
import type { SkipMarkerLike } from "./skipMarkers";

type MediaEpisode = MediaDetails["episodes"][number];

/** "S1E03": same code the desktop app shows on its Play button. */
export const formatEpisodeCode = (seasonNumber: number, episodeNumber: number): string =>
  `S${seasonNumber}E${String(episodeNumber).padStart(2, "0")}`;

export const formatEpisodeLabel = (episode: MediaEpisode | null | undefined): string | null => {
  if (!episode) return null;
  const code = formatEpisodeCode(episode.seasonNumber, episode.episodeNumber);
  return episode.name ? `${code} - ${episode.name}` : code;
};

/** Skip markers that apply to the item being played (episode-scoped for TV, media-scoped for movies). */
export const selectMarkersForPlayback = (
  markers: MediaSkipMarker[] | undefined,
  episodeId: string | null,
): SkipMarkerLike[] =>
  (markers ?? [])
    .filter((marker) =>
      episodeId ? marker.episodeId === episodeId : marker.episodeId === null || marker.episodeId === undefined,
    )
    .filter(
      (marker) =>
        (marker.type === "intro" || marker.type === "credits") &&
        Number.isFinite(marker.startSeconds) &&
        Number.isFinite(marker.endSeconds) &&
        marker.endSeconds > marker.startSeconds,
    )
    .map((marker) => ({ type: marker.type, startSeconds: marker.startSeconds, endSeconds: marker.endSeconds }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
