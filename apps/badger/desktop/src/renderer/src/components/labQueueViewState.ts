import { shouldShowJobForMedia, type LabJob } from "@/lib/labJobs";

export const buildLabQueueViewState = (input: {
  jobs: LabJob[];
  activeJobs: LabJob[];
  completedJobs: LabJob[];
  mediaFilterId?: string | null;
  presetMediaType?: "movie" | "tv" | null;
}) => {
  const filteredJobs = input.mediaFilterId
    ? input.jobs.filter((job) => shouldShowJobForMedia(job, input.mediaFilterId))
    : input.jobs;
  const filteredActive = input.mediaFilterId
    ? input.activeJobs.filter((job) => shouldShowJobForMedia(job, input.mediaFilterId))
    : input.activeJobs;
  const filteredCompleted = input.mediaFilterId
    ? input.completedJobs.filter((job) => shouldShowJobForMedia(job, input.mediaFilterId))
    : input.completedJobs;

  const singleMediaMode = Boolean(input.mediaFilterId);
  const singleMediaTvMode =
    singleMediaMode &&
    (input.presetMediaType === "tv" ||
      filteredJobs.some(
        (job) =>
          (typeof job.detectedSeason === "number" && typeof job.detectedEpisode === "number") ||
          (typeof job.manualSeason === "number" && typeof job.manualEpisode === "number")
      ));

  return {
    filteredJobs,
    filteredActive,
    filteredCompleted,
    singleMediaMode,
    singleMediaTvMode,
  };
};
