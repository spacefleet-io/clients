/**
 * Step: identify — parses the filename and (eventually) runs a catalog match.
 * If `job.payload.hints.mediaId` is already set (typical case: the desktop
 * has already identified the title via attach_metadata), this step is a
 * pass-through that just records the hint as the canonical id.
 *
 * Output shape (`step.outputs.identifyResult`): {@link IdentifyResult} from
 * `./deps`. Carries `mediaId | null`, parsed title, season/episode, year, and
 * `preexistingHint: boolean` so downstream commit can tell whether a catalog
 * match still needs to be made.
 *
 * Honors abort. Pure function w.r.t. the filesystem — no ffmpeg, no network.
 */

import type { StepHandler } from "../../../core/jobs/engineV2";
import { getBadgerStepDeps } from "./deps";

type Hints = {
  mediaId?: string | null;
  season?: number | null;
  episode?: number | null;
};

const readHints = (payload: Record<string, unknown>): Hints => {
  const hints = payload.hints;
  if (!hints || typeof hints !== "object") return {};
  return hints as Hints;
};

export const identifyStepHandler: StepHandler = async (ctx) => {
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const deps = getBadgerStepDeps();
  const filename = ctx.job.payload?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("STEP_IDENTIFY_MISSING_FILENAME");
  }
  const hint = readHints(ctx.job.payload);
  ctx.reportProgress(10, "Identifying", "identifying");
  const result = await deps.identify({ filename, hint });
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  ctx.emitOutputs({ identifyResult: result });
  ctx.reportProgress(100, "Identified", "identifying");
};
