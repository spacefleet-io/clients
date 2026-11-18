import type { MediaDetails, MediaRow } from "@/lib/libraryDb";
import type { LabJob } from "@/lib/labJobs";
import { estimateFromFile, estimateFromSourceFormat } from "@/lib/labJobs";

export const buildManualMatches = (manualQuery: string | undefined, movies: MediaRow[], tv: MediaRow[]) => {
  const normalized = (manualQuery ?? "").trim().toLowerCase();
  if (!normalized) return [];
  return [...movies, ...tv]
    .filter(
      (item) =>
        item.title.toLowerCase().includes(normalized) || item.originalTitle?.toLowerCase().includes(normalized)
    )
    .slice(0, 5);
};

export const resolveLabJobEpisodeSelectionState = (params: {
  job: LabJob;
  media: MediaRow[];
  getMediaDetails: (id: string) => MediaDetails | null;
}) => {
  const { job, media, getMediaDetails } = params;
  const effectiveSeason = job.manualSeason ?? job.detectedSeason;
  const effectiveEpisode = job.manualEpisode ?? job.detectedEpisode;
  const selectedMedia = media.find((m) => m.id === (job.manualSelectedId ?? job.matchedMediaId));
  const selectedDetails = selectedMedia ? getMediaDetails(selectedMedia.id) : null;
  const detailsForEpisodes = selectedDetails ?? (job.pendingDetails ? { seasons: job.pendingDetails.seasons, episodes: job.pendingDetails.episodes } : null);
  const needsEpisodeSelection =
    job.videoMeta !== undefined &&
    (selectedMedia?.type === "tv" || job.matchedTo?.type === "tv") &&
    detailsForEpisodes &&
    (!effectiveSeason || !effectiveEpisode);

  return {
    effectiveSeason,
    effectiveEpisode,
    selectedMedia,
    selectedDetails,
    detailsForEpisodes,
    needsEpisodeSelection,
  };
};

export const estimateLabJobOutputTotal = (job: LabJob, mediaType: "movie" | "tv") =>
  (job.selectedFormats ?? []).reduce((sum, format) => {
    // Same fallback chain as AddQualityModal: prefer the pixel-ratio
    // estimator (needs source quality + duration + size), fall back to the
    // file-size ratio when LabJob is missing either of those fields
    // (older snapshots, mid-ingest jobs without probed videoMeta).
    const pixelRatio = estimateFromSourceFormat({
      sourceSizeMb: job.sizeMb ?? null,
      sourceQuality: job.sourceQuality ?? null,
      targetQuality: format.quality,
      targetCodec: format.codec,
      durationSeconds: job.videoMeta?.durationSec ?? null,
      mediaType,
    });
    if (pixelRatio !== null) return sum + pixelRatio;
    return sum + estimateFromFile(job.sizeMb, format.quality, format.codec, mediaType);
  }, 0);
