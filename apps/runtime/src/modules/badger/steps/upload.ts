/**
 * Step: upload — resumable upload of encrypted chunks to the storage gateway.
 * Reads the persisted `MediaJobStateStore` and uploads any segment whose
 * `uploaded` flag is still false; previously-uploaded keys are recorded but
 * not re-sent. Updates the state file after each segment.
 *
 * Output shape (`step.outputs.uploadResult`): {
 *   producedSummary: { videoFormatCount, audioTrackCount, subtitleTrackCount },
 *   uploadedKeys: string[]
 * }
 *
 * The full `ProducedMedia` object is also handed to the deps for the commit
 * step to read out-of-band; we keep the in-event payload small to avoid
 * blowing up the event log.
 *
 * Scope: derived from the parent job's kind. A `source` job's upload step
 * uploads everything in MediaJobStateStore (source video + audio + subs).
 * A `format` job's upload step uploads only the variant directory's outputs.
 *
 * Honors abort: deps layer drops the in-flight HTTP request and stops the
 * loop. Already-uploaded segments stay uploaded — that's intentional, the
 * cancel cascade's artifact-cleanup is a separate concern (plan §4).
 */

import type { StepHandler } from "@space/runtime-jobs-engine/engineV2";
import { getBadgerStepDeps, type UploadResult } from "./deps";
import { armUploadFaultForJob, checkProgressFault } from "../../badger";
import { discardFormatOutputsIfCancelled } from "./discardOnCancel";
import { resolveJobPlacementId } from "./placement";
import { runWithStepLog } from "./jobLog";

const requireString = (
  payload: Record<string, unknown>,
  key: string,
  errorCode: string
): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(errorCode);
  }
  return value;
};

export const uploadStepHandler: StepHandler = async (ctx) => {
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const deps = getBadgerStepDeps();
  const userId = requireString(
    ctx.job.payload,
    "userId",
    "STEP_UPLOAD_MISSING_USER_ID"
  );
  // The token is plumbed through job payload by the submit handler. If a
  // future submission path forgets to set it, we surface a deterministic error.
  const token = typeof ctx.job.payload.token === "string" ? ctx.job.payload.token : "";

  const isFormatJob = ctx.job.kind === "format";
  const variant = isFormatJob
    ? requireString(ctx.job.payload, "variant", "STEP_UPLOAD_MISSING_VARIANT")
    : undefined;

  // Fault-injection (test-only). Arms the upload-fault wrapper before any
  // chunks are pushed; the wrapper sits in front of mediaProcessor's
  // `uploadStorageObject` via `configureMediaIngestRuntime`. Honors
  // SF_FAULT_HANG_UPLOAD_MS (first-chunk hang) and SF_FAULT_FAIL_UPLOAD_AT_CHUNK
  // (synthetic gateway-unreachable). No-op when env unset.
  armUploadFaultForJob();
  const faultState = { ffmpegAborted: false, processExitFired: false };
  ctx.reportProgress(1, "Uploading", "uploading");
  const placementId = await resolveJobPlacementId(ctx.job, deps);
  console.info("[badger.steps.upload] upload start", {
    jobId: ctx.job.jobId,
    kind: ctx.job.kind,
    variant: variant ?? null,
    placementId,
    startedAt: new Date().toISOString(),
  });
  let result: UploadResult;
  try {
    result = await runWithStepLog(ctx, "upload", (onLog) => deps.uploadOutputs({
      userId,
      jobId: ctx.job.jobId,
      token,
      scope: isFormatJob ? "format" : "source",
      variant,
      placementId,
      signal: ctx.signal,
      onProgress: (pct) => {
        // Fires SF_FAULT_PROCESS_EXIT_AFTER_PCT inline when configured. No-op
        // otherwise. The kill-ffmpeg pct check is a no-op here (stage=uploading).
        checkProgressFault(faultState, "uploading", pct, undefined, ctx.job.jobId);
        ctx.reportProgress(Math.max(1, Math.min(99, pct)), "Uploading", "uploading");
      },
      // Upload `pct MiB/s eta` lines go to runtime.log as `[runtime][job <id>][upload] ...`.
      onLog,
    }));
    if (ctx.signal.aborted) throw new Error("CANCELLED");
  } catch (err) {
    // A cancelled format job never resumes: drop its local encode outputs.
    await discardFormatOutputsIfCancelled(ctx, userId);
    throw err;
  }
  console.info("[badger.steps.upload] upload end", {
    jobId: ctx.job.jobId,
    kind: ctx.job.kind,
    variant: variant ?? null,
    uploadedKeyCount: result.uploadedKeys.length,
    finishedAt: new Date().toISOString(),
  });

  ctx.emitOutputs({
    uploadResult: {
      producedSummary: {
        videoFormatCount: result.produced.videoFormats.length,
        audioTrackCount: result.produced.audioTracks.length,
        subtitleTrackCount: result.produced.subtitleTracks.length,
      },
      uploadedKeys: result.uploadedKeys,
      // Stash the full produced object on the step record for the commit step
      // to consume. The engine serializes step.outputs to JSON in the DB, so
      // the produced shape (which is itself JSON-safe) round-trips cleanly.
      produced: result.produced,
    },
  });
  ctx.reportProgress(100, "Uploaded", "uploading");
};
