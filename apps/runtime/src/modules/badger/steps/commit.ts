/**
 * Step: commit — projects the completed source/format job into the library DB.
 *
 *  - Source-job commit: writes the file row, registers the source video format
 *    and any audio/subtitle tracks, then flips the media to playable via
 *    `markMediaPlayable(mediaId)` (when wired). Until that helper lands the
 *    deps adapter falls back to the existing `linkFileToMedia` path with a
 *    TODO; this matches the plan §6 instruction for the in-progress wiring.
 *  - Format-job commit: registers an additional `mediaFormats` row (alternate
 *    quality) without touching playability.
 *
 * Output shape (`step.outputs.commitResult`): { fileId, formatIds }.
 *
 * Reads the upstream `produced` object from sibling-step outputs when
 * available; otherwise lets the deps adapter recover it from
 * MediaJobStateStore. Honors abort, but commit work is short — most aborts
 * race past it.
 */

import type { StepHandler } from "@space/runtime-jobs-engine/engineV2";
import { getBadgerStepDeps, type BadgerStepDeps, type CommitInput } from "./deps";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";
import type {
  BadgerIngestSkipMarker,
  BadgerIngestShowSkipCache,
} from "@space/runtime-contracts/badger/ingest";

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

const readProducedFromStepOutputs = (
  outputs: Record<string, unknown>
): ProducedMedia | undefined => {
  const upload = outputs.uploadResult;
  if (!upload || typeof upload !== "object") return undefined;
  const produced = (upload as Record<string, unknown>).produced;
  if (!produced || typeof produced !== "object") return undefined;
  return produced as ProducedMedia;
};

export const commitStepHandler: StepHandler = async (ctx) => {
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const deps = getBadgerStepDeps();
  const userId = requireString(
    ctx.job.payload,
    "userId",
    "STEP_COMMIT_MISSING_USER_ID"
  );
  const isFormatJob = ctx.job.kind === "format";
  const isRetranscodeJob = isFormatJob && ctx.job.payload.retranscode === true;
  // `filename` names the file row of a source commit and is part of every
  // ingest-time job payload. A post-ingest replan (retranscode) format job
  // attaches a row to an already-committed file: it carries `fileId`, not a
  // filename, and nothing downstream reads one for format scope.
  const filename = isRetranscodeJob
    ? ""
    : requireString(ctx.job.payload, "filename", "STEP_COMMIT_MISSING_FILENAME");
  const mediaId = ctx.job.mediaId;
  if (!mediaId) {
    throw new Error("STEP_COMMIT_MISSING_MEDIA_ID");
  }
  const variant = isFormatJob
    ? requireString(ctx.job.payload, "variant", "STEP_COMMIT_MISSING_VARIANT")
    : undefined;

  ctx.reportProgress(10, "Committing", "committing");

  // Format-job commits need the committed file_id to satisfy the
  // media_formats FK. Ingest-time format jobs resolve it from the parent
  // source job (via the deps seam, so the adapter or a test mock can read
  // engine state). A replan (retranscode) job has no parent source job — it
  // runs sessions after the ingest — and names the file row directly.
  let sourceFileId: string | null | undefined = undefined;
  if (isRetranscodeJob) {
    sourceFileId = requireString(ctx.job.payload, "fileId", "STEP_COMMIT_MISSING_FILE_ID");
  } else if (isFormatJob) {
    const parentSourceJobId = (() => {
      const fromPayload = ctx.job.payload.parentSourceJobId;
      if (typeof fromPayload === "string" && fromPayload.length > 0) {
        return fromPayload;
      }
      return ctx.job.parentJobIds[0] ?? null;
    })();
    if (!parentSourceJobId) {
      throw new Error("STEP_COMMIT_MISSING_PARENT_SOURCE_JOB_ID");
    }
    if (!deps.lookupParentSourceFileId) {
      throw new Error(
        "STEP_COMMIT_PARENT_LOOKUP_NOT_WIRED — deps.lookupParentSourceFileId is required for format-job commits"
      );
    }
    sourceFileId = await deps.lookupParentSourceFileId(parentSourceJobId);
    if (!sourceFileId) {
      throw new Error(
        `STEP_COMMIT_PARENT_FILE_ID_NOT_FOUND:${parentSourceJobId} — parent source job has no committed file_id`
      );
    }
  }

  // TV ingest: hand the episode coordinates down to the deps so the row
  // writes (`linkFileToMedia`, `addAudioTrackWithChunks`,
  // `addSubtitleTrackWithObject`) get stamped with `(season, episode)`
  // instead of `(null, null)`. Hints are populated by `submit_sources`
  // and/or `attach_metadata` and live on `ctx.job.payload.hints`. We
  // only thread positive integers — anything else is treated as "movie"
  // (season/episode = null) by the downstream library helpers.
  const hints =
    (ctx.job.payload.hints as Record<string, unknown> | undefined) ?? {};
  const hintSeason =
    typeof hints.season === "number" && Number.isFinite(hints.season) && hints.season > 0
      ? hints.season
      : null;
  const hintEpisode =
    typeof hints.episode === "number" && Number.isFinite(hints.episode) && hints.episode > 0
      ? hints.episode
      : null;

  // Source-job payloads carry `sourceQuality` from the probe step (set on
  // the payload by `ingestSubmit.ts`). Format-job payloads do not — they
  // never write the source row. We forward whatever is on the payload as-is:
  // a non-empty string for source jobs, undefined for format jobs, null for
  // source-job payloads that pre-date Phase 2 (legacy ingest paths). The
  // deps adapter only flips `is_source = 1` when this is a non-empty string
  // and a matching format row exists; everything else stays at the column
  // DEFAULT 0.
  const sourceQualityFromPayload = isFormatJob
    ? undefined
    : (() => {
        const raw = ctx.job.payload.sourceQuality;
        if (typeof raw === "string" && raw.length > 0) return raw;
        return null;
      })();

  const input: CommitInput = {
    userId,
    jobId: ctx.job.jobId,
    mediaId,
    filename,
    scope: isFormatJob ? "format" : "source",
    variant,
    season: hintSeason,
    episode: hintEpisode,
    produced: readProducedFromStepOutputs(ctx.step.outputs),
    sourceFileId,
    sourceQuality: sourceQualityFromPayload,
    signal: ctx.signal,
  };
  // Coalesce all library-DB writes (deps.commit's 6-15 inner calls AND
  // the trailing markMediaPlayable) into a single library.updated event
  // when runLibraryBatch is wired. Pre-fix the renderer received a burst
  // of intermediate snapshots with hasFiles=false before the final
  // markMediaPlayable landed, delaying play-button enable by 3-5 s.
  // Tests that omit runLibraryBatch (e.g. step-stub mocks) fall back to
  // the un-batched path which is functionally identical from the
  // outside — just emits more snapshots.
  // Source-job-only: skip-marker payloads fetched by the renderer at
  // import-modal identify time. Format-jobs do not carry these (the source
  // job persists everything for the show). Movies omit them entirely by the
  // renderer contract; the commit step gates on non-empty / present values.
  const skipMarkers = isFormatJob
    ? undefined
    : (ctx.job.payload.skipMarkers as
        | BadgerIngestSkipMarker[]
        | undefined);
  const showSkipCache = isFormatJob
    ? undefined
    : (ctx.job.payload.showSkipCache as
        | BadgerIngestShowSkipCache
        | undefined);

  const runBatch: NonNullable<BadgerStepDeps["runLibraryBatch"]> =
    deps.runLibraryBatch ??
    (async <T,>(_label: string, fn: () => Promise<T>): Promise<T> => fn());
  // `readyWait`: a job resumed right after a runtime respawn reaches here
  // before the desktop re-opens the library DB; the batch waits for it
  // instead of failing the job on LIBRARY_DB_NOT_OPEN (#25 P3).
  const readyWait = { stage: "commit", userId, jobId: ctx.job.jobId, signal: ctx.signal };
  const result = await runBatch(`commit:${ctx.job.jobId}`, async () => {
    const r = await deps.commit(input);
    if (ctx.signal.aborted) throw new Error("CANCELLED");
    // Source jobs flip playability. Format jobs add an alternate quality only.
    if (!isFormatJob && deps.markMediaPlayable) {
      await deps.markMediaPlayable(mediaId);
    }

    // Persist skip-marker data fetched at import-modal identify time. Runs
    // inside the same library batch so the post-commit `library.updated`
    // event sees the skip rows alongside the file/format/track writes — no
    // extra renderer round-trip needed before playback gates on markers.
    if (!isFormatJob) {
      const episodeId = r.episodeId ?? null;
      if (
        Array.isArray(skipMarkers) &&
        skipMarkers.length > 0 &&
        deps.mergeSkipMarkers
      ) {
        await deps.mergeSkipMarkers(mediaId, episodeId, skipMarkers);
      }
      if (showSkipCache && deps.upsertShowSkipCache) {
        await deps.upsertShowSkipCache(mediaId, showSkipCache);
        if (deps.listExistingEpisodeIds && deps.mergeSkipMarkers) {
          const episodeIdByKey = await deps.listExistingEpisodeIds(mediaId);
          for (const [seasonEpisodeKey, markers] of Object.entries(
            showSkipCache.markersByEpisode
          )) {
            const targetEpisodeId = episodeIdByKey.get(seasonEpisodeKey);
            if (!targetEpisodeId) continue;
            // Skip the just-written episode — already persisted above via
            // `skipMarkers`. Avoids a redundant delete-then-insert pass.
            if (
              episodeId !== null &&
              targetEpisodeId === episodeId &&
              Array.isArray(skipMarkers) &&
              skipMarkers.length > 0
            ) {
              continue;
            }
            await deps.mergeSkipMarkers(mediaId, targetEpisodeId, markers);
          }
        }
      }
    }

    return r;
  }, readyWait);

  // Capture the library DB version AFTER the coalesced batch's terminal
  // publish. The engine attaches this on `runtime.jobs.succeeded` as
  // `libraryVersionAtDone` so the renderer can close the cross-stream
  // race between the jobs SSE (this event) and the library SSE (the
  // matching `library.updated` snapshot). Reads via the optional deps
  // hook — when undefined, the field is simply omitted from the event
  // and renderers fall back to gating on `hasFiles` alone.
  const libraryVersionAtDone = deps.getLibraryVersion?.();

  ctx.emitOutputs({
    commitResult: {
      fileId: result.fileId,
      formatIds: result.formatIds,
      ...(typeof libraryVersionAtDone === "number"
        ? { libraryVersionAtDone }
        : {}),
    },
  });
  ctx.reportProgress(100, "Committed", "committing");
};
