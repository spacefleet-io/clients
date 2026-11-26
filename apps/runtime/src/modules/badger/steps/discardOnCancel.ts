/**
 * Local-output cleanup for cancelled format jobs (#25).
 *
 * A format job's transcode now runs while its source is still uploading, so a
 * source failure or cancel can cancel the format job with a finished or
 * half-written encode on disk (`<transcode base>/<userId>/<formatJobId>`). A
 * cancelled job never resumes (a retry gets a fresh jobId), so that directory
 * is dead weight. Two paths remove it:
 *
 *  - {@link discardFormatOutputsIfCancelled}: from inside the running
 *    transcode/upload handler, AFTER the aborted encoder/upload returned, so
 *    nothing is still writing into the directory.
 *  - {@link registerFormatCancelCleanup}: an engine subscriber for jobs
 *    cancelled BETWEEN steps (e.g. transcode done, upload waiting on the
 *    source upload). A job with a step still running is left to the handler.
 *    It also handles the boot re-announce (`CANCELLED_BEFORE_RESTART_REASON`)
 *    of a job cancelled mid-step whose handler died with the process.
 *
 * A graceful runtime stop (`isEngineShutdownAbort`) is NOT a cancel: the step
 * is requeued and resumes next boot, so its outputs are kept.
 *
 * Both paths pass the job's `mediaId` and whether its `commit` step ever
 * started, so the adapter never releases objects a committed media_formats
 * row may serve (PR #143 review: a boot re-announce of a job cancelled
 * mid-commit, whose library batch landed before the process died).
 */
import {
  CANCELLED_BEFORE_RESTART_REASON,
  INTERRUPTED_BY_RESTART_REASON,
  isEngineShutdownAbort,
  type EngineV2,
  type StepHandlerCtx,
} from "@space/runtime-jobs-engine/engineV2";
import { getBadgerStepDeps } from "./deps";

export const discardFormatOutputsIfCancelled = async (
  ctx: StepHandlerCtx,
  userId: string
): Promise<void> => {
  if (ctx.job.kind !== "format") return;
  if (!ctx.signal.aborted || isEngineShutdownAbort(ctx.signal)) return;
  const deps = getBadgerStepDeps();
  if (!deps.discardJobOutputs) return;
  await deps.discardJobOutputs({
    userId,
    jobId: ctx.job.jobId,
    reason: `format-${ctx.step.kind}-cancelled`,
    mediaId: ctx.job.mediaId,
    commitStarted: ctx.step.kind === "commit",
  });
};

export const registerFormatCancelCleanup = (engine: EngineV2): void => {
  engine.subscribe((event) => {
    if (event.event !== "runtime.jobs.cancelled") return;
    const job = event.payload.job as
      | { jobId?: unknown; kind?: unknown; app?: unknown; mediaId?: unknown; payload?: Record<string, unknown> }
      | undefined;
    if (!job || job.app !== "badger" || job.kind !== "format") return;
    const userId = job.payload?.userId;
    if (typeof userId !== "string" || userId.length === 0) return;
    const jobId = event.jobId;
    // Boot hydration announces every job left `running` as cancelled with
    // this reason, then requeues and resumes it (engineV2 start()). Its
    // outputs feed the resumed commit (PR #143 re-review P2).
    if (event.payload.reason === INTERRUPTED_BY_RESTART_REASON) {
      console.info("[badger.steps] restart-interrupted format job resumes; outputs kept", { jobId });
      return;
    }
    void (async () => {
      const found = await engine.get(jobId);
      if (found?.job.status !== "cancelled") {
        console.info("[badger.steps] cancel event for a job that is not cancelled; outputs kept", {
          jobId,
          status: found?.job.status ?? null,
          reason: event.payload.reason ?? null,
        });
        return;
      }
      const running = found.steps.find((s) => s.status === "running");
      if (running) {
        // The running handler cleans up once its aborted encoder/upload exits.
        console.info("[badger.steps] cancelled format job has a running step; handler discards outputs", {
          jobId,
          step: running.kind,
        });
        return;
      }
      // The commit step ever ran (hydration settles a stale `running` commit
      // to `cancelled` but keeps its startedAt): the format row may exist.
      // A cancel also flips never-run steps to `cancelled`, so the status
      // alone cannot tell; startedAt is only written when a step starts.
      const commitStarted = Boolean(found?.steps.find((s) => s.kind === "commit")?.startedAt);
      const mediaId = found?.job.mediaId ?? (typeof job.mediaId === "string" ? job.mediaId : null);
      await getBadgerStepDeps().discardJobOutputs?.({
        userId,
        jobId,
        reason:
          event.payload.reason === CANCELLED_BEFORE_RESTART_REASON
            ? "format-cancelled-before-restart"
            : "format-cancelled-between-steps",
        mediaId,
        commitStarted,
      });
    })().catch((err: unknown) => {
      console.warn("[badger.steps] cancelled format cleanup failed", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
};
