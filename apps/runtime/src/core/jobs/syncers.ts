import type { RuntimeJobRecord } from "@space/runtime-jobs";
import { buildBadgerRuntimeIngestJobId, buildBadgerRuntimeJobRecord } from "@space/runtime-jobs";
import { runtimeJobsStore } from "./store";
import { normalizeBadgerJobLike, type BadgerJobLike } from "./normalizers";

const nowIso = () => new Date().toISOString();

export const buildBadgerRuntimeJob = (job: BadgerJobLike, userId: string | null): RuntimeJobRecord => {
  const existing = runtimeJobsStore.get(buildBadgerRuntimeIngestJobId(userId, job.id));
  return buildBadgerRuntimeJobRecord({
    job,
    userId,
    existing,
    nowIso: nowIso(),
  });
};

export const upsertBadgerRuntimeJobs = (jobs: BadgerJobLike[], userId: string | null) =>
  runtimeJobsStore.upsertMany(jobs.map((job) => buildBadgerRuntimeJob(job, userId)));

const badgerOwnerSegment = (userId: string | null) => (userId && userId.trim().length > 0 ? userId.trim() : "active");

const buildDeletedBadgerRuntimeJobTombstones = (jobs: RuntimeJobRecord[]) => {
  const finishedAt = nowIso();
  return jobs.map((job) => ({
    ...job,
    status: "cancelled" as const,
    stageCode: "cancelled",
    stageLabel: "Cancelled",
    retryable: false,
    errorCode: null,
    errorMessage: null,
    finishedAt,
    updatedAt: finishedAt,
  }));
};

const replaceBadgerRuntimeJobsSnapshot = (jobs: BadgerJobLike[], userId: string | null) => {
  const ownerSegment = badgerOwnerSegment(userId);
  const incoming = jobs.map((job) => buildBadgerRuntimeJob(job, userId));
  const incomingIds = new Set(incoming.map((job) => job.jobId));
  const staleJobs = runtimeJobsStore
    .list(
      {
        app: "badger",
        includeCompleted: true,
      },
      ["badger"]
    )
    .filter((job) => job.jobId.startsWith(`badger:ingest:${ownerSegment}:`) && !incomingIds.has(job.jobId));
  if (staleJobs.length > 0) {
    runtimeJobsStore.deleteMany(staleJobs.map((job) => job.jobId));
  }
  if (incoming.length > 0) {
    runtimeJobsStore.upsertMany(incoming);
  }
  return [...buildDeletedBadgerRuntimeJobTombstones(staleJobs), ...incoming];
};

export const syncBadgerRuntimeJobsFromCommandResult = (command: string, result: Record<string, unknown>) => {
  if (command !== "badger.ingest.list_jobs" && !Array.isArray(result.jobs)) {
    return [];
  }
  if (
    command !== "badger.ingest.open" &&
    command !== "badger.ingest.apply" &&
    command !== "badger.ingest.list_jobs"
  ) {
    return [];
  }
  const userId = typeof result.userId === "string" ? result.userId : null;
  const jobs = (Array.isArray(result.jobs) ? result.jobs : []).flatMap((item) => {
    const job = normalizeBadgerJobLike(item);
    return job ? [job] : [];
  });
  if (command === "badger.ingest.list_jobs" && result.opened === false) {
    return [];
  }
  return command === "badger.ingest.list_jobs"
    ? replaceBadgerRuntimeJobsSnapshot(jobs, userId)
    : upsertBadgerRuntimeJobs(jobs, userId);
};

export const syncBadgerRuntimeJobsFromEventPayload = (
  channel: string,
  event: string,
  payload: Record<string, unknown>
) => {
  if (channel !== "ingest" || event !== "ingest.jobs_updated" || !Array.isArray(payload.jobs)) return [];
  const userId = typeof payload.userId === "string" ? payload.userId : null;
  const jobs = payload.jobs.flatMap((item) => {
    const job = normalizeBadgerJobLike(item);
    return job ? [job] : [];
  });
  return replaceBadgerRuntimeJobsSnapshot(jobs, userId);
};
