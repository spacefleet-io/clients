/**
 * Step: probe — runs ffprobe over the source file to capture container,
 * stream, codec, bitrate, and duration metadata.
 *
 * Output shape (`step.outputs.probeResult`): {@link ProbeResult} from `./deps`.
 * Carries duration, video codec/dims, source-quality guess, audio/subtitle
 * counts, per-stream summary, and chapter list. The `identify` step reads
 * `parsedTitle` from filename, NOT from this output; the `extract`/`transcode`
 * steps consume the codec + duration metadata to plan their ffmpeg invocations.
 *
 * Honors `signal.aborted` — the underlying ffprobe child is cancelled by the
 * deps layer when the signal fires.
 *
 * Idempotent: re-running on the same file produces identical outputs.
 */

import type { StepHandler } from "../../../core/jobs/engineV2";
import { getBadgerStepDeps } from "./deps";

const requireFilename = (job: { payload: Record<string, unknown> }): string => {
  const filename = job.payload?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("STEP_PROBE_MISSING_FILENAME");
  }
  return filename;
};

export const probeStepHandler: StepHandler = async (ctx) => {
  const deps = getBadgerStepDeps();
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const filename = requireFilename(ctx.job);
  ctx.reportProgress(1, "Probing", "probing");
  const result = await deps.probe(filename, ctx.signal);
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  ctx.emitOutputs({ probeResult: result });
  ctx.reportProgress(100, "Probed", "probing");
};
