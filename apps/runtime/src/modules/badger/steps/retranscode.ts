/**
 * Step: retranscode — post-ingest re-transcode pipeline. Wired into the
 * `retranscode → upload → commit` step chain that engineV2 picks when a
 * format job's `payload.retranscode === true`.
 *
 * Unlike `transcode`, there's no local source file: the source media is
 * already in encrypted object storage as DASH segments. This step:
 *   1. Reads the source format's chunk list (ordered) + initKey from
 *      library-db.
 *   2. Builds an async iterator that yields the init segment then each
 *      media segment in order — every yield triggers a download +
 *      decrypt — and pipes the byte stream straight to ffmpeg's stdin
 *      (`-i pipe:0`). No staged temp dir, no contiguous file on disk.
 *   3. Runs the Phase 3 encoder via `produceMediaOutputs` in streaming
 *      mode with `targetVariants: [<variant>]` + `inputStream` — probe
 *      is skipped (sourceQualityOverride drives quality) and the
 *      single-variant constraint is enforced (a stream is consumable
 *      once, can't fan out without buffering).
 *
 * Why streaming: a 1080p source format can be 20+ GB; staging to disk
 * doubles peak disk pressure and serialises download-then-encode when
 * they could pipeline. Streaming starts the encode as soon as init +
 * first segment arrive, with disk footprint bounded by the encode's own
 * DASH output.
 *
 * Single-attempt: encodeDashVideoWithFallback's CPU-retry path is
 * disabled in streaming mode — the stream is consumable once and can't
 * be replayed. A hardware-encode failure surfaces directly so the user
 * can re-trigger the replan; the deps adapter does NOT silently retry.
 *
 * Honors `ctx.signal`: a cancel between yields stops download
 * immediately; the ffmpeg child is killed by the engine's existing abort
 * plumbing, which closes stdin via the ffmpeg helper's pump-then-end
 * path.
 */

import type { StepHandler } from "../../../core/jobs/engineV2";
import { getBadgerStepDeps } from "./deps";
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

export const retranscodeStepHandler: StepHandler = async (ctx) => {
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const deps = getBadgerStepDeps();
  if (!deps.retranscodeFormat) {
    throw new Error(
      "STEP_RETRANSCODE_DEP_MISSING — buildBadgerStepDeps must wire retranscodeFormat for post-ingest replan jobs"
    );
  }
  const userId = requireString(
    ctx.job.payload,
    "userId",
    "STEP_RETRANSCODE_MISSING_USER_ID"
  );
  const fileId = requireString(
    ctx.job.payload,
    "fileId",
    "STEP_RETRANSCODE_MISSING_FILE_ID"
  );
  const targetVariant = requireString(
    ctx.job.payload,
    "targetVariant",
    "STEP_RETRANSCODE_MISSING_TARGET_VARIANT"
  );
  const sourceFormatId = requireString(
    ctx.job.payload,
    "sourceFormatId",
    "STEP_RETRANSCODE_MISSING_SOURCE_FORMAT_ID"
  );
  const sourceVariant = requireString(
    ctx.job.payload,
    "sourceVariant",
    "STEP_RETRANSCODE_MISSING_SOURCE_VARIANT"
  );
  // mediaId is also required: the deps adapter uses it to look up the
  // file's format list in library-db. The replan handler stamps it on the
  // job record's mediaId field AND on the payload; we read the payload
  // copy here for consistency with the other required fields.
  const mediaId =
    typeof ctx.job.payload.mediaId === "string" && ctx.job.payload.mediaId.length > 0
      ? ctx.job.payload.mediaId
      : ctx.job.mediaId;
  if (!mediaId) {
    throw new Error("STEP_RETRANSCODE_MISSING_MEDIA_ID");
  }
  ctx.reportProgress(1, `Re-transcoding ${targetVariant}`, "transcoding");
  // `retranscodeFormat` is guarded above; the closure loses that narrowing.
  const result = await runWithStepLog(ctx, "retranscode", (onLog) => deps.retranscodeFormat!({
    userId,
    jobId: ctx.job.jobId,
    mediaId,
    fileId,
    targetVariant,
    sourceFormatId,
    sourceVariant,
    signal: ctx.signal,
    onProgress: (stage, pct) => {
      if (stage !== "transcoding") return;
      ctx.reportProgress(
        Math.max(1, Math.min(99, pct)),
        `Re-transcoding ${targetVariant}`,
        "transcoding"
      );
    },
    onLog,
  }));
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  ctx.emitOutputs({
    transcodeResult: {
      variant: result.variant,
      jobDir: result.jobDir,
      segmentCount: result.segmentCount,
    },
  });
  ctx.reportProgress(100, `Re-transcoded ${targetVariant}`, "transcoding");
};
