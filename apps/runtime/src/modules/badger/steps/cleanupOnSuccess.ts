/**
 * Local-output cleanup for SUCCEEDED ingest jobs (issue #671, R1).
 *
 * Every source or format job encodes into `<transcode base>/<userId>/<jobId>`
 * and uploads from there. Once the job succeeded (upload done, library rows
 * committed) that directory, about the size of the media, has no further use:
 * a finished job never resumes, and a retry or replan gets a fresh job id.
 * The legacy ingest path removed it; the engineV2 path left it forever.
 *
 * This subscriber removes the directory when `runtime.jobs.succeeded` fires
 * for a badger `source` or `format` job. Failed and cancelled jobs are not
 * touched here (cancelled format jobs have {@link registerFormatCancelCleanup}).
 */
import type { EngineV2 } from "../../../core/jobs/engineV2";
import { getBadgerStepDeps } from "./deps";

export const registerIngestSuccessCleanup = (engine: EngineV2): void => {
  engine.subscribe((event) => {
    if (event.event !== "runtime.jobs.succeeded") return;
    const job = event.payload.job as
      | { app?: unknown; kind?: unknown; payload?: Record<string, unknown> }
      | undefined;
    if (!job || job.app !== "badger") return;
    if (job.kind !== "source" && job.kind !== "format") return;
    const userId = job.payload?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      console.warn("[badger.steps] succeeded ingest job has no userId; transcode dir kept", {
        jobId: event.jobId,
        kind: job.kind,
      });
      return;
    }
    void (async () => {
      const deps = getBadgerStepDeps();
      if (!deps.removeJobDir) return;
      await deps.removeJobDir({
        userId,
        jobId: event.jobId,
        reason: `${job.kind as string}-job-succeeded`,
      });
    })().catch((err: unknown) => {
      console.warn("[badger.steps] succeeded-job transcode cleanup failed", {
        jobId: event.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
};
