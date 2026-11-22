import type { LabJob } from "../../../shared/labQueueShared";

const isTerminalLabJobStatus = (status: LabJob["status"]) =>
  status === "done" || status === "failed" || status === "cancelled";

// UX-HOME-05: a failed job can no longer make progress, so it is not active. It used to stay in `activeJobs`,
// and Home drew a permanent "Preparing…" overlay on a playable title whose one format job had failed (Ted Lasso,
// 2026-11-22). A failed job is neither completed: it is listed, with its reason, only in the Jobs panel (UX-JOBS-01).
export const splitLabJobsByCompletion = (jobs: LabJob[]) => ({
  activeJobs: jobs.filter((job) => !isTerminalLabJobStatus(job.status)),
  completedJobs: jobs.filter((job) => job.status === "done" || job.status === "cancelled"),
});

export const hasProcessingLabJobs = (jobs: LabJob[]) => jobs.some((job) => !isTerminalLabJobStatus(job.status));
