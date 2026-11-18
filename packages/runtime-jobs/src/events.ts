import type { RuntimeJobEventPayload, RuntimeJobRecord } from "./models";

export const buildRuntimeJobEventPayload = (job: RuntimeJobRecord): RuntimeJobEventPayload => ({
  jobId: job.jobId,
  app: job.app,
  kind: job.kind,
  status: job.status,
  stageCode: job.stageCode,
  stageLabel: job.stageLabel,
  progress: job.progress,
  payload: job.payload,
  outputs: job.outputs,
  updatedAt: job.updatedAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  errorCode: job.errorCode,
  errorMessage: job.errorMessage,
  retryable: job.retryable,
});
