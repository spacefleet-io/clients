/**
 * Per-media silo placement (#145), library side: which `placementId` one
 * playable media (a film, or one episode) already lives under. Every object
 * ingest produced for it is keyed `media/<placementId>/...`, so any of its
 * keys names the silo. Used by clients that add objects to an existing media
 * (desktop add-subtitle) or read it back (mobile playback gateway pick).
 */
import type { MediaDetails } from "./libraryTypes";
import { parseMediaPlacementIdFromObjectKey } from "./storagePlacement";

type ScopedTrack = { episodeId: string | null; fileId: string | null };

/**
 * The playable unit is picked the way playback picks it: a film → its first
 * file; an episode → the file matching its season/episode (first file when
 * the episode id is unknown). Only objects scoped to that unit count — an
 * unscoped track could belong to a sibling episode on another silo.
 *
 * Returns null for legacy (`shards/...` / bare) keys or a media without
 * objects; callers then allocate a fresh placementId.
 */
export const findMediaPlacementId = (
  details: Pick<MediaDetails, "type" | "episodes" | "files" | "formats" | "audioTracks" | "subtitleTracks">,
  episodeId: string | null
): string | null => {
  const episode = episodeId ? (details.episodes.find((item) => item.id === episodeId) ?? null) : null;
  const file =
    details.type === "tv" && episode
      ? (details.files.find(
          (item) => item.season === episode.seasonNumber && item.episode === episode.episodeNumber
        ) ?? null)
      : (details.files[0] ?? null);
  const inUnit = (track: ScopedTrack): boolean => {
    if (episode && track.episodeId) return track.episodeId === episode.id;
    return file !== null && track.fileId === file.id;
  };

  const keys: Array<string | null> = [];
  for (const format of details.formats) {
    if (file === null || format.fileId !== file.id) continue;
    keys.push(format.initKey, ...format.chunks.map((chunk) => chunk.key));
  }
  for (const track of details.audioTracks) {
    if (inUnit(track)) keys.push(track.initKey, ...track.chunks.map((chunk) => chunk.key));
  }
  for (const track of details.subtitleTracks) {
    if (inUnit(track)) keys.push(track.objectKey);
  }
  for (const key of keys) {
    const placementId = key ? parseMediaPlacementIdFromObjectKey(key) : null;
    if (placementId) return placementId;
  }
  return null;
};

/**
 * Every placement one media's objects live under, each with the episode it belongs to (null for a film or an
 * object not tied to one episode). Over-quota screens (ACCT-OVER-01/04) use it to name the placements the server
 * lists, since the server never knows titles. Every key counts, not only the playable unit's first file.
 */
export const mediaPlacementUnits = (
  details: Pick<MediaDetails, "type" | "episodes" | "files" | "formats" | "audioTracks" | "subtitleTracks">
): Map<string, string | null> => {
  const episodeOfFile = (fileId: string | null): string | null => {
    if (details.type !== "tv" || !fileId) return null;
    const file = details.files.find((item) => item.id === fileId);
    if (!file) return null;
    return details.episodes.find((ep) => ep.seasonNumber === file.season && ep.episodeNumber === file.episode)?.id ?? null;
  };
  const units = new Map<string, string | null>();
  const add = (key: string | null, episodeId: string | null) => {
    const placementId = key ? parseMediaPlacementIdFromObjectKey(key) : null;
    if (!placementId) return;
    // A placement already tied to an episode keeps it; an unscoped object never erases it.
    if (!units.has(placementId) || units.get(placementId) === null) units.set(placementId, episodeId);
  };
  for (const format of details.formats) {
    const episodeId = episodeOfFile(format.fileId);
    add(format.initKey, episodeId);
    for (const chunk of format.chunks) add(chunk.key, episodeId);
  }
  for (const track of details.audioTracks) {
    const episodeId = track.episodeId ?? episodeOfFile(track.fileId);
    add(track.initKey, episodeId);
    for (const chunk of track.chunks) add(chunk.key, episodeId);
  }
  for (const track of details.subtitleTracks) add(track.objectKey, track.episodeId ?? episodeOfFile(track.fileId));
  return units;
};
