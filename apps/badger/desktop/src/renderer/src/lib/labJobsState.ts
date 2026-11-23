import type { LabJob } from "../../../shared/labQueueShared";

export const splitLabJobsByCompletion = (jobs: LabJob[]) => ({
  activeJobs: jobs.filter((job) => job.status !== "done" && job.status !== "cancelled"),
  completedJobs: jobs.filter((job) => job.status === "done" || job.status === "cancelled"),
});

export const hasProcessingLabJobs = (jobs: LabJob[]) =>
  jobs.some((job) => job.status !== "done" && job.status !== "failed" && job.status !== "cancelled");
