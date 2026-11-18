/**
 * The "Play on TV" start command built on the phone (UX-TV-02): which title (and episode), and the phone's resume point,
 * computed exactly like the phone's own player would (same progress rows, same credits rule, same thresholds), so the TV
 * starts where the phone would have resumed. Below the resume threshold or past the credits the TV starts at 0.
 */
import type { MediaDetails } from "@space/shared/libraryTypes";
import { resolveResumeCandidateSeconds, type EpisodeResume } from "@space/shared/playbackResume";
import { selectMarkersForPlayback } from "../playback/nextEpisode";
import type { StartCommand } from "./protocol";

type StartDetails = Pick<MediaDetails, "type" | "progressPct" | "files" | "formats" | "skipMarkers">;

/** Duration of the file that plays: the movie's file, or the episode's file (matched on season / episode numbers). */
const fileDurationSeconds = (details: StartDetails, episode: { seasonNumber: number; episodeNumber: number } | null): number | null => {
  const file = episode
    ? details.files.find((candidate) => candidate.season === episode.seasonNumber && candidate.episode === episode.episodeNumber)
    : details.files[0];
  const format = file ? details.formats.find((candidate) => candidate.fileId === file.id) : details.formats[0];
  return format?.durationSeconds ?? null;
};

export const buildStartCommand = (input: {
  mediaId: string;
  details: StartDetails;
  /** The episode the phone's Play would start; null for a movie. */
  episode: { id: string; seasonNumber: number; episodeNumber: number } | null;
  episodeResume: Readonly<Record<string, EpisodeResume>>;
}): StartCommand => {
  const { mediaId, details, episode, episodeResume } = input;
  const markers = selectMarkersForPlayback(details.skipMarkers, episode?.id ?? null);
  const creditsStart = markers.find((marker) => marker.type === "credits")?.startSeconds ?? null;
  const fileDuration = fileDurationSeconds(details, episode);
  let positionSeconds: number | null;
  if (details.type === "tv" && episode) {
    const entry = episodeResume[episode.id];
    positionSeconds = entry
      ? resolveResumeCandidateSeconds(entry.progressPct, entry.durationSeconds ?? fileDuration, creditsStart, entry.positionSeconds)
      : null;
  } else {
    positionSeconds = resolveResumeCandidateSeconds(details.progressPct, fileDuration, creditsStart);
  }
  return {
    type: "start",
    mediaId,
    episodeId: details.type === "tv" ? (episode?.id ?? null) : null,
    positionSeconds: Math.max(0, Math.floor(positionSeconds ?? 0)),
    tracks: null,
  };
};
