/**
 * Pure planning for offline downloads: which format of a file to save, which
 * storage objects that means, and how big it is. No React, no native modules
 * — unit tested in `tests/downloads-planner.test.ts`.
 *
 * Quality (OFFL-QUAL-01): the user picks it in the download prompt from
 * `scopeQualityChoices` (shared `listOfflineQualityChoices`); there is no
 * download-quality setting. A file without the chosen quality gets its
 * nearest lower one, else its nearest higher one (`resolveOfflineQuality`);
 * H.264 wins a same-quality tie. Files with no playable format are skipped
 * ("no-quality-available").
 * Audio: every audio track of the file. Subtitles: every subtitle object.
 */
import { trackBelongsToPlayingFile, type MediaDetails, type MediaFormat } from "@space/shared/libraryTypes";
import {
  listOfflineQualityChoices,
  offlineQualityHeight as heightOf,
  resolveOfflineQuality,
  type OfflineQualityChoices,
} from "@space/shared/offlineQualityChoice";
import type { DownloadItem, DownloadItemSpec } from "@space/mobile-media-proxy/downloads";
import { inScopeFileIds, type OfflineScope } from "./scope";

const isH264 = (codec: string | null | undefined): boolean => {
  const c = (codec ?? "").toLowerCase();
  return c.includes("264") || c.includes("avc");
};

const isPlayable = (f: MediaFormat): boolean =>
  Boolean(f.initKey) && f.chunks.length > 0 && heightOf(f.quality) > 0;

/** Same height: prefer H.264, then higher bitrate. */
const compareSameQuality = (a: MediaFormat, b: MediaFormat): number => {
  const h = Number(isH264(b.codec)) - Number(isH264(a.codec));
  if (h !== 0) return h;
  return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
};

/** The format to download for a file at the chosen quality, or null when no compatible one exists. */
export const selectDownloadFormat = (formats: MediaFormat[], quality: string): MediaFormat | null => {
  const playable = formats.filter(isPlayable);
  const resolved = resolveOfflineQuality(
    playable.map((f) => f.quality),
    quality,
  );
  if (!resolved) return null;
  return playable.filter((f) => heightOf(f.quality) === heightOf(resolved)).sort(compareSameQuality)[0] ?? null;
};

type Chunky = { initKey: string | null; initSize: number | null; chunks: Array<{ key: string; sizeBytes: number | null }> };

const collectTrackObjects = (track: Chunky, into: Map<string, number>): void => {
  const known = track.chunks.map((c) => c.sizeBytes ?? 0).filter((n) => n > 0);
  const average = known.length > 0 ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : 0;
  if (track.initKey && !into.has(track.initKey)) into.set(track.initKey, track.initSize ?? 0);
  for (const chunk of track.chunks) {
    if (!chunk.key || into.has(chunk.key)) continue;
    // Unknown chunk sizes are estimated from the track average so progress
    // and the free-space check stay meaningful.
    into.set(chunk.key, chunk.sizeBytes && chunk.sizeBytes > 0 ? chunk.sizeBytes : average);
  }
};

/**
 * Audio/subtitle tracks that belong to one playable file, scoped like the player (`trackBelongsToPlayingFile`).
 */
export const selectFileTracks = (details: MediaDetails, fileId: string, episodeId: string | null) => {
  const scoped = (track: { episodeId: string | null; fileId: string | null }): boolean => trackBelongsToPlayingFile(track, fileId, episodeId);
  return {
    audioTracks: details.audioTracks.filter(scoped),
    subtitleTracks: details.subtitleTracks.filter(scoped),
  };
};

export type SkipReason = "already-local" | "no-quality-available" | "no-file";

export type PlannedFile = {
  spec: DownloadItemSpec;
  /** Placement lookup key for the gateway (episode id, or null for a movie). */
  episodeId: string | null;
};

export type DownloadPlan = {
  items: PlannedFile[];
  skipped: Array<{ fileId: string; reason: SkipReason }>;
  totalEstimatedBytes: number;
};

const episodeLabel = (season: number, episode: number, name: string | null): string =>
  `S${season}E${episode}${name ? ` · ${name}` : ""}`;

/** Plan the download of one file; `{ skip }` + reason when it cannot be downloaded. */
export const planFile = (
  details: MediaDetails,
  fileId: string,
  quality: string,
): PlannedFile | { skip: SkipReason } => {
  const file = details.files.find((f) => f.id === fileId);
  if (!file) return { skip: "no-file" };

  const episode =
    file.season != null && file.episode != null
      ? (details.episodes.find((e) => e.seasonNumber === file.season && e.episodeNumber === file.episode) ?? null)
      : null;

  const format = selectDownloadFormat(
    details.formats.filter((f) => f.fileId === file.id),
    quality,
  );
  if (!format) return { skip: "no-quality-available" };

  const objects = new Map<string, number>();
  collectTrackObjects(format, objects);
  const { audioTracks, subtitleTracks } = selectFileTracks(details, file.id, episode?.id ?? null);
  for (const track of audioTracks) collectTrackObjects(track, objects);
  for (const sub of subtitleTracks) {
    if (sub.objectKey && !objects.has(sub.objectKey)) objects.set(sub.objectKey, 0);
  }

  const estimatedBytes = [...objects.values()].reduce((a, b) => a + b, 0);
  const isEpisode = file.season != null && file.episode != null;

  return {
    episodeId: episode?.id ?? null,
    spec: {
      id: file.id,
      mediaId: details.id,
      title: details.title,
      subtitle: isEpisode ? episodeLabel(file.season!, file.episode!, episode?.name ?? null) : null,
      kind: isEpisode ? "episode" : "movie",
      seasonNumber: file.season,
      episodeNumber: file.episode,
      quality: format.quality,
      formatId: format.id,
      codec: format.codec,
      estimatedBytes,
      objects: [...objects.entries()],
    },
  };
};

/**
 * Plan the scopes of one download request. Files that are already downloaded
 * or already in the queue (in any non-failed state) are reported as
 * "already-local" and not planned again (desktop `skipAlreadyLocal`); failed
 * items are planned again so "retry" through the pill re-queues them.
 */
export const planScope = (
  details: MediaDetails,
  scopes: readonly OfflineScope[],
  quality: string,
  existing: ReadonlyArray<Pick<DownloadItem, "id" | "status">>,
): DownloadPlan => {
  const items: PlannedFile[] = [];
  const skipped: DownloadPlan["skipped"] = [];
  const { toPlan, alreadyLocal } = filesToPlan(details, scopes, existing);
  for (const fileId of alreadyLocal) skipped.push({ fileId, reason: "already-local" });

  for (const fileId of toPlan) {
    const planned = planFile(details, fileId, quality);
    if ("skip" in planned) {
      skipped.push({ fileId, reason: planned.skip });
      continue;
    }
    items.push(planned);
  }

  return {
    items,
    skipped,
    totalEstimatedBytes: items.reduce((sum, p) => sum + p.spec.estimatedBytes, 0),
  };
};

/** In-scope file ids (scopes in order, no duplicates), split into those to plan and those already local. */
const filesToPlan = (
  details: MediaDetails,
  scopes: readonly OfflineScope[],
  existing: ReadonlyArray<Pick<DownloadItem, "id" | "status">>,
): { toPlan: string[]; alreadyLocal: string[] } => {
  const existingById = new Map(existing.map((i) => [i.id, i.status] as const));
  const seen = new Set<string>();
  const toPlan: string[] = [];
  const alreadyLocal: string[] = [];
  for (const scope of scopes) {
    for (const fileId of inScopeFileIds(details, scope)) {
      if (seen.has(fileId)) continue;
      seen.add(fileId);
      const status = existingById.get(fileId);
      if (status && status !== "failed") alreadyLocal.push(fileId);
      else toPlan.push(fileId);
    }
  }
  return { toPlan, alreadyLocal };
};

/**
 * The download prompt's choices for the files a request would download
 * (OFFL-QUAL-01): every playable quality across them, each with the batch
 * size at that quality. `prompt` is false when every file has one quality.
 */
export const scopeQualityChoices = (
  details: MediaDetails,
  scopes: readonly OfflineScope[],
  existing: ReadonlyArray<Pick<DownloadItem, "id" | "status">>,
): OfflineQualityChoices => {
  const { toPlan } = filesToPlan(details, scopes, existing);
  const files = toPlan.map((fileId) => {
    const formats = details.formats.filter((f) => f.fileId === fileId && isPlayable(f));
    const heights = [...new Set(formats.map((f) => heightOf(f.quality)))];
    const options = heights.flatMap((height) => {
      const planned = planFile(details, fileId, `${height}p`);
      return "skip" in planned ? [] : [{ quality: planned.spec.quality, bytes: planned.spec.estimatedBytes }];
    });
    return { fileId, options };
  });
  return listOfflineQualityChoices(files);
};
