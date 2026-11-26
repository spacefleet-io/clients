/**
 * Step: transcode — runs ffmpeg to produce one quality variant (e.g. 720p,
 * 360p) from the source file. One step per format job. Restart deletes
 * partial DASH for the in-flight variant and restarts the encode; finished
 * variant outputs already on disk are detected by `MediaJobStateStore` and
 * skipped.
 *
 * Output shape (`step.outputs.transcodeResult`): { variant, jobDir,
 * segmentCount }.
 *
 * Honors abort: deps layer kills the ffmpeg child on signal. A user/parent
 * cancel (not a graceful runtime stop) then removes the job's partial encode
 * outputs — see `./discardOnCancel`.
 *
 * The job's `payload.variant` (set by `submit_sources`) tells us which
 * variant to produce. The job's `payload.filename` is the input. Pinning to
 * a stable input file is the engine's job — this handler trusts the path.
 */

import type { StepHandler } from "../../../core/jobs/engineV2";
import { getBadgerStepDeps } from "./deps";
import { checkProgressFault } from "../../badger";
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

export const transcodeStepHandler: StepHandler = async (ctx) => {
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const deps = getBadgerStepDeps();
  const userId = requireString(
    ctx.job.payload,
    "userId",
    "STEP_TRANSCODE_MISSING_USER_ID"
  );
  const filename = requireString(
    ctx.job.payload,
    "filename",
    "STEP_TRANSCODE_MISSING_FILENAME"
  );
  const variant = requireString(
    ctx.job.payload,
    "variant",
    "STEP_TRANSCODE_MISSING_VARIANT"
  );
  // Per-step fault state — refs persist across onProgress emits within this
  // handler. See `apps/runtime/src/modules/badger.ts:checkProgressFault`.
  // For SF_FAULT_KILL_FFMPEG_AT_PCT we don't have access to the controller in
  // V2 (the engine owns it); the helper logs + sets the flag, and we throw a
  // synthetic error AFTER the inner call returns to surface the simulated
  // failure. SF_FAULT_PROCESS_EXIT_AFTER_PCT fires inline (process.exit, no
  // controller needed). Both flags are no-ops when unset.
  const faultState = { ffmpegAborted: false, processExitFired: false };
  ctx.reportProgress(1, `Transcoding ${variant}`, "transcoding");
  const placementId = await resolveJobPlacementId(ctx.job, deps);
  console.info("[badger.steps.transcode] encode start", {
    jobId: ctx.job.jobId,
    variant,
    parentJobIds: ctx.job.parentJobIds,
    startedAt: new Date().toISOString(),
  });
  try {
    const result = await runWithStepLog(ctx, "transcode", (onLog) => deps.transcodeFormat({
      userId,
      jobId: ctx.job.jobId,
      inputPath: filename,
      variant,
      placementId,
      signal: ctx.signal,
      // Phase F split: the transcode step does encode only — it reports
      // `stage="transcoding"` progress straight through to the badge. The
      // upload step (a dedicated engineV2 step on the upload lane) handles
      // the encrypted-chunk push and its own `stage="uploading"` reporting.
      // The deps adapter never emits `stage="uploading"` from
      // `transcodeFormat`; the conditional is kept as a defensive no-op so
      // a legacy-mode test (`processMediaJob` injection) that DOES emit
      // both stages doesn't accidentally flip the transcode badge.
      onProgress: (stage, pct) => {
        if (stage !== "transcoding") return;
        // Fault-injection (test-only). Fires `process.exit(137)` when
        // SF_FAULT_PROCESS_EXIT_AFTER_PCT crosses; flags ffmpeg-abort when
        // SF_FAULT_KILL_FFMPEG_AT_PCT crosses (rethrown below). No-op when env unset.
        checkProgressFault(faultState, "transcoding", pct, undefined, ctx.job.jobId);
        ctx.reportProgress(Math.max(1, Math.min(99, pct)), `Transcoding ${variant}`, "transcoding");
      },
      // ffmpeg stderr goes to runtime.log as `[runtime][job <id>][transcode] ...`.
      onLog,
    }));
    if (faultState.ffmpegAborted) {
      throw new Error(
        `sf_fault: ffmpeg aborted via SF_FAULT_KILL_FFMPEG_AT_PCT (jobId=${ctx.job.jobId})`
      );
    }
    if (ctx.signal.aborted) throw new Error("CANCELLED");
    ctx.emitOutputs({
      transcodeResult: {
        variant: result.variant,
        jobDir: result.jobDir,
        segmentCount: result.segmentCount,
      },
    });
    console.info("[badger.steps.transcode] encode end", {
      jobId: ctx.job.jobId,
      variant,
      segmentCount: result.segmentCount,
      finishedAt: new Date().toISOString(),
    });
    ctx.reportProgress(100, `Transcoded ${variant}`, "transcoding");
  } catch (err) {
    await discardFormatOutputsIfCancelled(ctx, userId);
    throw err;
  }
};
