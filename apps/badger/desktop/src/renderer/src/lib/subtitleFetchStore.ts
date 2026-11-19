import type { MediaDetails } from "@space/shared/libraryTypes";
import { findMediaPlacementId } from "@space/shared/mediaPlacement";
import type { StoreFetchedSubtitleDeps } from "@space/shared/subtitleFetch";
import { subtitlePickPatch, type TrackPrefsPatch } from "@space/shared/trackPrefs";
import { metadataClient } from "@/lib/metadataTickets";
import type { AddSubtitleTrack } from "@/lib/playbackTypes";

/**
 * How the computer app stores a fetched subtitle (PLAY-SUBGET-01, -02): downloaded through the metadata service,
 * encrypted into the vault on the media's silo like an added subtitle file, added as a track, remembered as the
 * film's or show's subtitle. Shared by the "Get subtitles" dialog and the player's "Get more subtitles…" row.
 */
export const subtitleFetchStoreDeps = (params: {
  media: MediaDetails;
  episodeId: string | null;
  token: string | null;
  addSubtitleTrack: AddSubtitleTrack;
  setTrackPrefs: (mediaId: string, patch: TrackPrefsPatch) => Promise<void>;
}): StoreFetchedSubtitleDeps => {
  const { media, episodeId, token, addSubtitleTrack, setTrackPrefs } = params;
  return {
    download: (fileId) => metadataClient.subtitleFile(fileId),
    upload: async (content, format) => {
      if (!token) throw new Error("AUTH_REQUIRED");
      // Per-media silo placement (#145), like an added subtitle file.
      const placementId = findMediaPlacementId(media, episodeId);
      const uploaded = await window.sf?.uploadSubtitleContent?.({ token, content, format, placementId });
      if (!uploaded?.key) throw new Error("subtitle_upload_failed");
      return uploaded.key;
    },
    addTrack: (track) =>
      addSubtitleTrack(media.id, episodeId, track.language, track.label, track.objectKey, track.format, track.source),
    rememberChoice: async (choice) => {
      const patch = subtitlePickPatch(choice);
      if (patch) await setTrackPrefs(media.id, patch);
    },
  };
};
