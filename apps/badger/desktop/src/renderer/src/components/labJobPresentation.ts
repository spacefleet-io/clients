import i18n, { type TFunction } from "i18next";

import { formatJobOutputLabel, type LabJob } from "@/lib/labJobs";
import { formatUploadSpeedLabel } from "@/lib/uploadSpeed";

export const buildActiveLabJobPresentation = (
  job: LabJob,
  enableCodecSelection: boolean,
  t: TFunction
) => {
  // Download jobs carry the show/episode in the manifest but `matchedTo` may be
  // the show row OR absent (media not synced), so don't gate them on
  // matchedTo?.type === "tv" the way ingest jobs are — the detectedSeason/episode
  // pair is sufficient to show which episode is being saved.
  const episodeLabel =
    (job.matchedTo?.type === "tv" || job.jobType === "download" || job.jobType === "export") &&
    job.detectedSeason &&
    job.detectedEpisode
      ? `S${String(job.detectedSeason).padStart(2, "0")}E${String(job.detectedEpisode).padStart(2, "0")}`
      : null;
  const producedLabel = job.produced?.videoFormats?.length
    ? job.produced.videoFormats
        .map((format) => formatJobOutputLabel(format.quality, format.codec, enableCodecSelection))
        .join(", ")
    : null;
  const selectedLabel = job.selectedFormats?.length
    ? job.selectedFormats
        .map((format) => formatJobOutputLabel(format.quality, format.codec, enableCodecSelection))
        .join(", ")
    : null;
  const formatLabel = producedLabel ?? selectedLabel;
  const baseOutputLabel =
    job.jobType === "source"
      ? producedLabel
        ? `${t("lab.source")} · ${producedLabel}`
        : t("lab.queue.sourceIngest")
      : job.jobType === "transcode"
        ? formatLabel
          ? `${t("lab.queue.transcode")} · ${formatLabel}`
          : t("lab.queue.transcode")
        : job.jobType === "download"
          ? t("lab.queue.offlineDownloading")
          : job.jobType === "export"
            ? t("lab.queue.exportDownloading")
          : job.includeAudio || job.includeSubtitles
            ? t("lab.queue.tracks")
            : formatLabel ?? t("lab.queue.job");
  // Surface the current micro-stage (Extracting / Uploading / Committing) on
  // running rows so the V2 sidebar reflects the actual phase. A waiting row
  // carries no stage: its badge reads "Waiting · #N in line" (#2499), and the
  // last step's label ("Transcoded 360p") would read as still running.
  const showsStage =
    job.status !== "done" &&
    job.status !== "cancelled" &&
    job.status !== "failed" &&
    job.status !== "waiting";
  const outputLabel =
    showsStage && job.stageLabel ? `${baseOutputLabel} · ${job.stageLabel}` : baseOutputLabel;
  const outputHelp =
    job.jobType === "source"
      ? t("lab.queue.help.sourceIngest")
      : job.jobType === "transcode"
        ? t("lab.queue.help.transcode")
        : job.jobType === "download"
          ? t("lab.queue.help.offlineDownloading")
          : job.jobType === "export"
            ? t("lab.queue.help.exportDownloading")
          : job.includeAudio || job.includeSubtitles
            ? t("lab.queue.help.tracks")
            : t("lab.queue.help.job");
  // Download jobs do not have per-track sub-jobs (the runtime muxes all of
  // them into a single output file). The trackChips array stays empty so
  // the sidebar row reads cleanly.
  const trackChips = job.jobType === "download" || job.jobType === "export"
    ? []
    : ([
        job.includeSource ? t("lab.queue.splitSource") : null,
        job.includeAudio ? t("lab.audio") : null,
        job.includeSubtitles ? t("lab.subtitles") : null,
        job.includeChapters ? t("lab.queue.chapters") : null,
      ].filter(Boolean) as string[]);
  const canStart = job.status === "ready" || job.status === "failed";
  const uploadSpeedLabel = job.status === "uploading" ? formatUploadSpeedLabel(t, job.uploadSpeedMbps) : null;

  return {
    episodeLabel,
    outputLabel,
    outputHelp,
    trackChips,
    canStart,
    uploadSpeedLabel,
  };
};

export const buildCompletedLabJobPresentation = (
  job: LabJob,
  enableCodecSelection: boolean,
  t: TFunction
) => {
  const formatList = (job.produced?.videoFormats ?? job.selectedFormats ?? [])
    .map((format) => formatJobOutputLabel(format.quality, format.codec, enableCodecSelection))
    .join(", ");
  // Source jobs have no produced/selectedFormats of their own — the formats
  // list is empty and would fall back to the generic "Job" label. Mirror the
  // active-state presenter: "Source · {produced}" when produced formats
  // exist, plain "Source ingest" otherwise.
  const outputSummary =
    job.jobType === "source"
      ? formatList
        ? `${t("lab.source")} · ${formatList}`
        : t("lab.queue.sourceIngest")
      : job.jobType === "download"
        ? t("lab.queue.offlineSavedOffline")
        : job.jobType === "export"
          ? t("lab.queue.exportSaved")
        : formatList;

  const completedTime = job.completedAt ? new Date(job.completedAt).toLocaleString(i18n.language) : "";
  const completedMeta = job.completedAt
    ? {
        time: completedTime,
        duration: formatCompletedDuration(job.createdAt, job.completedAt),
        label: t("lab.completedMeta", {
          time: completedTime,
          duration: formatCompletedDuration(job.createdAt, job.completedAt),
        }),
      }
    : null;

  return {
    outputSummary,
    completedMeta,
  };
};

const formatCompletedDuration = (start: string, end?: string) => {
  if (!end) return "";
  const durationMs = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};
