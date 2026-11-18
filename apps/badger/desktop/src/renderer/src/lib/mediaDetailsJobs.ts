type LocalJobLike = {
  matchedMediaId?: string | null;
  status: string;
  progress?: number | null;
};

type SharedIngestJobLike = {
  mediaId?: string | null;
  status: string;
  progressPct?: number | null;
};

const TERMINAL_LOCAL_STATUSES = new Set(["done", "failed"]);
const TERMINAL_SHARED_STATUSES = new Set(["completed", "failed", "cancelled"]);

export const isMediaDetailsLocalJobActive = (job: LocalJobLike) => !TERMINAL_LOCAL_STATUSES.has(job.status);

export const isMediaDetailsSharedJobActive = (job: SharedIngestJobLike) =>
  !TERMINAL_SHARED_STATUSES.has(job.status);

export const buildMediaDetailsJobSummary = <
  TLocalJob extends LocalJobLike,
  TSharedJob extends SharedIngestJobLike,
>(
  mediaId: string | null | undefined,
  params: {
    jobs: TLocalJob[];
    activeJobs: TLocalJob[];
    ingestJobs: TSharedJob[];
  }
) => {
  if (!mediaId) {
    return {
      activeJobsForMedia: [] as TLocalJob[],
      jobsForMedia: [] as TLocalJob[],
      sharedIngestJobsForMedia: [] as TSharedJob[],
      hasProcessingJobsForMedia: false,
      processingProgress: null as number | null,
    };
  }

  const activeJobsForMedia = params.activeJobs.filter((job) => job.matchedMediaId === mediaId);
  const jobsForMedia = params.jobs.filter((job) => job.matchedMediaId === mediaId);
  const sharedIngestJobsForMedia = params.ingestJobs.filter((job) => job.mediaId === mediaId);

  const hasProcessingJobsForMedia =
    jobsForMedia.some(isMediaDetailsLocalJobActive) ||
    sharedIngestJobsForMedia.some(isMediaDetailsSharedJobActive);

  const localActive = activeJobsForMedia.map((job) => (Number.isFinite(job.progress) ? Number(job.progress) : 0));
  const sharedActive = sharedIngestJobsForMedia
    .filter(isMediaDetailsSharedJobActive)
    .map((job) => (Number.isFinite(job.progressPct) ? Number(job.progressPct) : 0));
  const all = [...localActive, ...sharedActive];
  const processingProgress =
    all.length > 0 ? Math.round(all.reduce((sum, value) => sum + value, 0) / all.length) : null;

  return {
    activeJobsForMedia,
    jobsForMedia,
    sharedIngestJobsForMedia,
    hasProcessingJobsForMedia,
    processingProgress,
  };
};
