import type { RuntimeJobRecord } from "./models";

export const DEFAULT_RUNTIME_JOB_MAX_ATTEMPTS = 3;

export const backoffMsForRuntimeJobAttempt = (attemptCount: number) => {
  const boundedAttempt = Math.max(0, Math.floor(attemptCount));
  return Math.min(60_000, 1_000 * 2 ** boundedAttempt);
};

export const getRuntimeJobAttemptCount = (job: Pick<RuntimeJobRecord, "attemptCount">) =>
  Math.max(0, Math.floor(job.attemptCount ?? 0));

export const getRuntimeJobMaxAttempts = (job: Pick<RuntimeJobRecord, "maxAttempts">) => {
  if (job.maxAttempts === null) return null;
  if (job.maxAttempts === undefined) return DEFAULT_RUNTIME_JOB_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(job.maxAttempts));
};

export const canScheduleRuntimeJobRetry = (job: Pick<RuntimeJobRecord, "retryable" | "attemptCount" | "maxAttempts">) => {
  if (!job.retryable) return false;
  const maxAttempts = getRuntimeJobMaxAttempts(job);
  if (maxAttempts === null) return true;
  return getRuntimeJobAttemptCount(job) < maxAttempts;
};

export const isRuntimeJobReadyToRunAt = (
  job: Pick<RuntimeJobRecord, "status" | "cancelRequested" | "nextAttemptAt">,
  nowIso: string
) => {
  if (job.status !== "queued" || job.cancelRequested) return false;
  if (!job.nextAttemptAt) return true;
  return Date.parse(job.nextAttemptAt) <= Date.parse(nowIso);
};

