/**
 * Step: extract — produces source-quality DASH segments, chunks them, and
 * encrypts each chunk with the user's master key. Resumable via on-disk
 * MediaJobStateStore (`encodingComplete` short-circuits already-finished
 * outputs; segment-uploaded flags stay scoped to the upload step).
 *
 * Output shape (`step.outputs.extractResult`): {@link ExtractResult} from
 * `./deps`. Carries `jobDir`, the full `JobState` (so the `upload` step can
 * read pending segments), and a convenience `segmentCount`.
 *
 * Honors abort: the deps layer kills the running ffmpeg child via the
 * `AbortSignal` and any partial DASH directory will be picked up on the next
 * run via `MediaJobStateStore`. We do NOT rm -rf `<jobDir>/source/` on abort —
 * the explicit resume path is the safer behavior.
 *
 * NOTE: this step does the encode + chunk + encrypt. Upload is the next step.
 * The deps adapter is responsible for skipping outputs whose `encodingComplete`
 * is already true (the existing legacy short-circuit).
 */

import type { StepHandler } from "@space/runtime-jobs-engine/engineV2";
import { getBadgerStepDeps } from "./deps";
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

type TrackOverride = { index: number; language: string; label: string };

const readTrackOverrides = (
  payload: Record<string, unknown>,
  key: "audioOverrides" | "subtitleOverrides"
): TrackOverride[] => {
  const raw = payload[key];
  if (!Array.isArray(raw)) return [];
  const result: TrackOverride[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (
      typeof o.index === "number" &&
      Number.isInteger(o.index) &&
      o.index >= 0 &&
      typeof o.language === "string" &&
      typeof o.label === "string"
    ) {
      result.push({ index: o.index, language: o.language, label: o.label });
    }
  }
  return result;
};

export const extractStepHandler: StepHandler = async (ctx) => {
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const deps = getBadgerStepDeps();
  const userId = requireString(
    ctx.job.payload,
    "userId",
    "STEP_EXTRACT_MISSING_USER_ID"
  );
  const filename = requireString(
    ctx.job.payload,
    "filename",
    "STEP_EXTRACT_MISSING_FILENAME"
  );
  const audioOverrides = readTrackOverrides(ctx.job.payload, "audioOverrides");
  const subtitleOverrides = readTrackOverrides(
    ctx.job.payload,
    "subtitleOverrides"
  );
  ctx.reportProgress(1, "Extracting", "extracting");
  const placementId = await resolveJobPlacementId(ctx.job, deps);
  const result = await runWithStepLog(ctx, "extract", (onLog) => deps.extractSource({
    userId,
    jobId: ctx.job.jobId,
    inputPath: filename,
    audioOverrides,
    subtitleOverrides,
    placementId,
    signal: ctx.signal,
    // Legacy processMediaJob is monolithic (encode + chunk + encrypt + upload
    // all in one call), so the engine's `upload` step runs as a no-op
    // pass-through after extract returns. Without threading `stage` through,
    // the source-job badge sits on "extracting" for the entire duration —
    // including the upload tail, which is most of the wall-clock time on
    // large files. Bridge `stage="uploading"` through to a stageCode
    // transition so the renderer's badge walks `extracting → uploading`
    // mid-step. The trailing engine `upload` step still emits `uploading`
    // briefly (no-op pass-through), then `commit` emits `committing`.
    onProgress: (stage, pct) => {
      const clamped = Math.max(1, Math.min(99, pct));
      if (stage === "uploading") {
        ctx.reportProgress(clamped, "Uploading", "uploading");
      } else {
        ctx.reportProgress(clamped, "Extracting", "extracting");
      }
    },
    // Tool output (ffmpeg stderr, upload lines) goes to runtime.log as
    // `[runtime][job <id>][extract] ...` (issue #671 R9).
    onLog,
  }));
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  ctx.emitOutputs({
    extractResult: {
      jobDir: result.jobDir,
      segmentCount: result.segmentCount,
      // Don't serialize the full JobState into the event log — it can be 10s of KB.
      // The commit/upload steps re-read it from MediaJobStateStore via the deps.
    },
  });
  // The legacy processMediaJob runs ffmpeg encode AND chunk upload in a
  // single call; by the time it returns, both phases are done. Anchor the
  // step's terminal progress on `uploading` (rather than `extracting`) so
  // the badge doesn't snap backward to extracting after the upload-stage
  // transitions emitted above.
  ctx.reportProgress(100, "Uploaded", "uploading");
};
