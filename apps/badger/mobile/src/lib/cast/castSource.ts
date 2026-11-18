/**
 * What a cast needs about one (title, episode): the ingest metadata of the file, the library key and how the native server
 * reaches the encrypted objects. The same lookups `usePlayerSession` does for the phone's own player (file, tracks, offline
 * copy, silo gateway), minus everything that only the player screen uses (markers, next episode, traffic report), and
 * without ever starting the loopback proxy: a cast is served by the LAN server only.
 */
import { findMediaPlacementId } from "@space/shared/mediaPlacement";
import { trackBelongsToPlayingFile, type MediaDetails, type MediaEpisode } from "@space/shared/libraryTypes";
import type { TrackPrefs } from "@space/shared/trackPrefs";
import type { LibraryContextValue } from "../../store/library";
import type { PlayerErrorCode } from "../../screens/player/usePlayerSession";
import { getStoredLibraryKey } from "../onboarding";
import { resolveGatewayCandidates } from "../playbackGateway";
import { filterToDownloadedFormat, resolveOfflinePlayback } from "../downloads/offlinePlayback";
import { buildIngestMetadata } from "../playback/ingestMetadata";
import { resolveResumeCandidateSeconds } from "@space/shared/playbackResume";
import { getViewingScope } from "../profiles/activeViewingScope";
import { selectMarkersForPlayback } from "../playback/nextEpisode";
import type { CastSource } from "./castFlow";

const APP_ID = "badger";

export type LoadedCastSource = {
  source: CastSource;
  details: MediaDetails;
  episode: MediaEpisode | null;
  durationSeconds: number;
  /** Where the cast starts: the resume position (the same rule as the phone's "Resume at"), or 0. */
  startSeconds: number;
  trackPrefs: TrackPrefs | null;
};

export const loadCastSource = async (
  lib: Pick<LibraryContextValue, "awaitDatasetReady" | "getMediaDetails" | "getPlayableTrackIds" | "getPlaybackChunks" | "getEpisodeResumeMap" | "getTrackPrefs">,
  authToken: string,
  mediaId: string,
  episodeId: string | null,
): Promise<{ ok: true; value: LoadedCastSource } | { ok: false; code: PlayerErrorCode }> => {
  const libraryKeyBase64 = await getStoredLibraryKey().catch(() => null);
  if (!libraryKeyBase64) return { ok: false, code: "missingLibraryKey" };

  await lib.awaitDatasetReady("playback");
  const [details, playableIds] = await Promise.all([lib.getMediaDetails(mediaId, { chunks: false }), lib.getPlayableTrackIds(mediaId)]);
  if (!details) return { ok: false, code: "titleMissing" };
  const episode = episodeId ? details.episodes.find((item) => item.id === episodeId) ?? null : null;
  const file =
    details.type === "movie"
      ? details.files[0] ?? null
      : episode
        ? details.files.find((item) => item.season === episode.seasonNumber && item.episode === episode.episodeNumber) ?? null
        : details.files[0] ?? null;
  if (!file) return { ok: false, code: "noPlayableFile" };
  console.info("[cast.source] file", JSON.stringify({ mediaId, episodeId, fileId: file.id, playableIds: playableIds.length }));

  const fileFormats = details.formats.filter((format) => format.fileId === file.id);
  const offline = await resolveOfflinePlayback(file.id).catch(() => null);
  const offlineFormats = offline ? filterToDownloadedFormat(fileFormats, offline) : [];
  const useOffline = offlineFormats.length > 0;
  const formatsWithoutChunks = useOffline ? offlineFormats : fileFormats;
  const belongsToFile = (track: { episodeId?: string | null; fileId?: string | null }) => trackBelongsToPlayingFile(track, file.id, episode?.id ?? null);
  const audioTracksWithoutChunks = details.audioTracks.filter(belongsToFile);
  const subtitleTracks = details.subtitleTracks.filter(belongsToFile);
  const chunks = await lib.getPlaybackChunks(
    formatsWithoutChunks.map((format) => format.id),
    audioTracksWithoutChunks.map((track) => track.id),
  );
  const formats = formatsWithoutChunks.map((format) => ({ ...format, chunks: chunks.formats[format.id] ?? [] }));
  const audioTracks = audioTracksWithoutChunks.map((track) => ({ ...track, chunks: chunks.audio[track.id] ?? [] }));
  const formatIds = new Set(formats.map((format) => format.id));
  const fileDurationSeconds = formats[0]?.durationSeconds ?? 0;
  const metadata = buildIngestMetadata({
    formats,
    audioTracks,
    subtitleTracks,
    chapters: (details.chapters ?? []).filter((chapter) => formatIds.has(chapter.formatId)),
    durationSeconds: fileDurationSeconds,
  });
  if (metadata.videos.length === 0) return { ok: false, code: "notAvailable" };

  let proxyConfig: CastSource["proxyConfig"];
  if (useOffline) {
    proxyConfig = { clientKind: "offline" };
  } else {
    // STOR-BW-11: the cast server's tunnel session names the active profile, like the player's. None resolved is a
    // client bug: start nothing rather than guess one.
    const profileId = getViewingScope().profileId;
    if (!profileId) {
      console.warn("[cast.source] profile missing", JSON.stringify({ mediaId, fileId: file.id }));
      return { ok: false, code: "startFailed" };
    }
    try {
      const gatewayBaseUrls = await resolveGatewayCandidates(authToken, findMediaPlacementId(details, episode?.id ?? null));
      proxyConfig = { clientKind: "storage-tunnel", gatewayBaseUrls, authToken, appId: APP_ID, profileId };
    } catch (err) {
      console.warn("[cast.source] gateway resolve failed", JSON.stringify({ error: String(err) }));
      return { ok: false, code: "gatewayUnavailable" };
    }
  }

  const markers = selectMarkersForPlayback(details.skipMarkers, episode?.id ?? null);
  const creditsStart = markers.find((marker) => marker.type === "credits")?.startSeconds ?? null;
  let startSeconds: number | null;
  if (episode) {
    const entry = (await lib.getEpisodeResumeMap(mediaId).catch(() => null))?.[episode.id];
    startSeconds = entry
      ? resolveResumeCandidateSeconds(entry.progressPct, entry.durationSeconds ?? fileDurationSeconds, creditsStart, entry.positionSeconds)
      : null;
  } else {
    startSeconds = resolveResumeCandidateSeconds(details.progressPct, fileDurationSeconds, creditsStart);
  }
  const trackPrefs = await lib.getTrackPrefs(mediaId).catch(() => null);

  return {
    ok: true,
    value: {
      source: { metadata, libraryKeyBase64, proxyConfig },
      details,
      episode,
      durationSeconds: metadata.videos[0]?.durationSeconds ?? fileDurationSeconds,
      startSeconds: startSeconds ?? 0,
      trackPrefs,
    },
  };
};
