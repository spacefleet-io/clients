/**
 * Per-media silo placement (#145) for subtitles attached in the import dialog.
 *
 * One playable media (a film, or one episode) lives on ONE silo, keyed by the
 * placementId of its ingest source job. A subtitle file dropped next to a
 * video joins that video's placement:
 * - the episode's video is being ingested in the same submit → the subtitle
 *   uploads AFTER the submit, under the `placementId` the runtime returned for
 *   that source (a re-submitted, deduped source returns the id its existing
 *   job already uses, so the subtitle still lands next to the video);
 * - subtitles only, for a media already in the library → the placementId
 *   parsed from that film's / episode's existing object keys;
 * - neither (legacy `shards/` keys, unknown episode, legacy deduped source) →
 *   null, and the upload IPC mints a fresh placement.
 *
 * TV: every episode file is its own source job, so its own placement; a
 * subtitle binds to the file of ITS episode only.
 */
import type { LabQueueFileInput } from "../../../shared/labQueueShared";
import { findMediaPlacementId } from "@space/shared/mediaPlacement";
import { isValidPlacementId } from "@space/shared/storagePlacement";
import { isV2SourceEntry, type V2SubmitSource } from "./fileIngestionV2Translate";

type PlacementDetails = Parameters<typeof findMediaPlacementId>[0];

/**
 * The source file an episode's attached subtitles bind to: the primary
 * (transcode) video when it is submitted as a source, else the first entry
 * that actually ingests a video. Null when the episode submits no video.
 */
export const pickSubtitleBindFilename = (
  files: ReadonlyArray<LabQueueFileInput>,
  primaryPath: string | null
): string | null => {
  const videoSources = files.filter((file) => isV2SourceEntry(file) && file.includeSource);
  return (
    videoSources.find((file) => file.filename === primaryPath)?.filename ?? videoSources[0]?.filename ?? null
  );
};

/**
 * Pairs each submitted source with the runtime's answer (the submit handler
 * answers in request order) → filename → placementId. Invalid / null ids are
 * left out so the caller falls back to minting.
 */
export const placementIdsBySourceFilename = (
  sources: ReadonlyArray<Pick<V2SubmitSource, "filename">>,
  submitted: ReadonlyArray<{ placementId: string | null }>
): Map<string, string> => {
  const byFilename = new Map<string, string>();
  sources.forEach((source, index) => {
    const placementId = submitted[index]?.placementId ?? null;
    if (placementId && isValidPlacementId(placementId)) byFilename.set(source.filename, placementId);
  });
  return byFilename;
};

/**
 * placementId of a film / episode already in the library, parsed from its
 * existing keys. TV needs the episode: without it any sibling episode's silo
 * could be picked, so an unknown episode yields null.
 */
export const existingMediaPlacementId = (
  details: PlacementDetails | null,
  season: number | null,
  episode: number | null
): string | null => {
  if (!details) return null;
  if (details.type !== "tv") return findMediaPlacementId(details, null);
  if (season === null || episode === null) return null;
  const match = details.episodes.find((item) => item.seasonNumber === season && item.episodeNumber === episode);
  return match ? findMediaPlacementId(details, match.id) : null;
};
