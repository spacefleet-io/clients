/**
 * Phase D handler: `badger.ingest.submit_sources`.
 *
 * Translates a typed `submit_sources` payload (see
 * `@space/runtime-contracts/badger/ingest`) into engineV2 job submissions:
 * one source job + N format jobs per submitted source, with the dependency
 * edge `format.parentJobIds = [sourceJob.jobId]`.
 *
 * All wiring respects the plan §3 priority table:
 *   source=0, 1080p=10, 720p=20, 480p=30, 360p=40, 240p=50, 144p=60.
 *
 * Step handlers themselves are stubbed (NotImplementedError) until live ffmpeg
 * observation lands — submitted jobs will reach the dispatch boundary and then
 * fail with `errorCode: "step-not-implemented"`. This is by design.
 *
 * Companion stubs `attach_metadata` and `plan_outputs` return informative
 * errors; their implementations need engine extensions out of scope here.
 */

import {
  badgerIngestSubmitSources,
  badgerIngestAttachMetadata,
  badgerIngestPlanOutputs,
} from "@space/runtime-contracts/badger/ingest";
import type { EngineV2 } from "../../core/jobs/engineV2";
import { readJobPlacementId } from "./steps/placement";
import type {
  IngestJobRecord,
  IngestJobStatus,
} from "@space/runtime-jobs";

type Quality = "1080p" | "720p" | "480p" | "360p" | "240p" | "144p";

const PRIORITY_BY_VARIANT: Record<Quality, number> = {
  "1080p": 10,
  "720p": 20,
  "480p": 30,
  "360p": 40,
  "240p": 50,
  "144p": 60,
};

const SOURCE_PRIORITY = 0;

type SubmitPayload = ReturnType<
  typeof badgerIngestSubmitSources.payloadSchema.parse
>;
type SubmitResult = ReturnType<
  typeof badgerIngestSubmitSources.resultSchema.parse
>;
type AttachPayload = ReturnType<
  typeof badgerIngestAttachMetadata.payloadSchema.parse
>;
type AttachResult = ReturnType<
  typeof badgerIngestAttachMetadata.resultSchema.parse
>;
type PlanPayload = ReturnType<
  typeof badgerIngestPlanOutputs.payloadSchema.parse
>;
type PlanResult = ReturnType<
  typeof badgerIngestPlanOutputs.resultSchema.parse
>;

export type SubmitSourcesHandler = (
  payload: SubmitPayload
) => Promise<SubmitResult>;
export type AttachMetadataHandler = (
  payload: AttachPayload
) => Promise<AttachResult & { errorCode?: string }>;
export type PlanOutputsHandler = (
  payload: PlanPayload
) => Promise<PlanResult & { errorCode?: string }>;

const newId = (): string => {
  // crypto.randomUUID is available on Node 18+ and Bun. No new deps.
  return crypto.randomUUID();
};

const baseRecord = (now: string): Pick<
  IngestJobRecord,
  | "status"
  | "stageCode"
  | "stageLabel"
  | "progress"
  | "progressPct"
  | "outputs"
  | "errorCode"
  | "errorMessage"
  | "retryable"
  | "cancelRequested"
  | "dedupeKey"
  | "createdAt"
  | "updatedAt"
  | "startedAt"
  | "finishedAt"
  | "dismissedAt"
  | "uploadSpeedBytesPerSec"
  | "app"
> => ({
  app: "badger",
  status: "queued" satisfies IngestJobStatus,
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  dedupeKey: null,
  createdAt: now,
  updatedAt: now,
  startedAt: null,
  finishedAt: null,
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
});

export interface IngestSubmitDeps {
  engine: EngineV2;
}

export function createBadgerIngestSubmitHandler(
  deps: IngestSubmitDeps
): SubmitSourcesHandler {
  const { engine } = deps;
  return async (payload) => {
    const validated = badgerIngestSubmitSources.payloadSchema.parse(payload);
    console.info("[ingestSubmit] entry", {
      userId: validated.userId,
      sourceCount: validated.sources.length,
      filenames: validated.sources.map((s) => s.filename),
      desiredFormats: validated.sources[0]?.desiredFormats,
    });
    const submitted: SubmitResult["submitted"] = [];
    const now = new Date().toISOString();

    // Dedupe key format (effervescent-teapot Symptom A defense in depth):
    //   source: ${userId}|${filename}|source
    //   format: ${userId}|${filename}|format|${variant}
    // The schema's `runtime_jobs_app_dedupe_unique_idx` enforces uniqueness on
    // `(app, dedupe_key)`, and `sqliteStore.upsertJob` short-circuits when a
    // matching row exists. The handler additionally looks up by dedupe before
    // generating a fresh job id so the response reflects the existing job.
    const sourceDedupeKey = (filename: string) =>
      `${validated.userId}|${filename}|source`;
    const formatDedupeKey = (filename: string, variant: Quality) =>
      `${validated.userId}|${filename}|format|${variant}`;

    for (const source of validated.sources) {
      const sourceKey =
        source.dedupeKey ?? sourceDedupeKey(source.filename);

      // Reuse existing source job if a duplicate has already been submitted.
      const existingSource = await engine.getByDedupe("badger", sourceKey);
      let sourceJobId: string;
      let groupId: string;
      // Per-media silo placement (#145): one source = one placementId, shared
      // by every format job of it. Null only for a legacy deduped source whose
      // id is not a valid placement id — its format jobs then resolve the id
      // from the parent at step time.
      let placementId: string | null;
      if (existingSource) {
        console.info("[ingestSubmit] dedupe-hit", {
          kind: "source",
          dedupeKey: sourceKey,
          existingJobId: existingSource.jobId,
          existingStatus: existingSource.status,
          existingGroupId: existingSource.groupId,
          existingDismissedAt: existingSource.dismissedAt,
        });
        sourceJobId = existingSource.jobId;
        groupId = existingSource.groupId;
        placementId = readJobPlacementId(existingSource);
      } else {
        groupId = source.hints?.mediaId ?? newId();
        sourceJobId = newId();
        placementId = sourceJobId;
        const sourceJob: IngestJobRecord = {
          ...baseRecord(now),
          jobId: sourceJobId,
          kind: "source",
          lane: "source",
          variant: null,
          priority: SOURCE_PRIORITY,
          parentJobIds: [],
          groupId,
          mediaId: groupId,
          dedupeKey: sourceKey,
          payload: {
            userId: validated.userId,
            filename: source.filename,
            sizeMb: source.sizeMb ?? null,
            sourceQuality: source.sourceQuality ?? null,
            hints: source.hints ?? {},
            // Bug #4: thread user-typed track overrides onto the source-job
            // payload so the extract step can forward them to mediaProcessor's
            // audioTrackOverrides / subtitleTrackOverrides — those merge at
            // encode time so the produced.audioTracks ship with the user's
            // chosen language/label baked in.
            audioOverrides: source.audioOverrides ?? [],
            subtitleOverrides: source.subtitleOverrides ?? [],
            // service markers fetched at identify time in the import modal.
            // `skipMarkers` is per-episode (for this file's episode);
            // `showSkipCache` carries the full-show payload so commit can
            // refresh the local show-cache row idempotently. Both are
            // forwarded to the commit step's payload; format-jobs do not
            // need either (only the source-job persists markers).
            skipMarkers: source.skipMarkers ?? [],
            showSkipCache: source.showSkipCache ?? null,
            placementId,
          },
        };
        await engine.submit(sourceJob);
      }

      const formatJobIds: SubmitResult["submitted"][number]["formatJobIds"] = [];
      for (const variant of source.desiredFormats) {
        const fmtKey = formatDedupeKey(source.filename, variant);
        const existingFormat = await engine.getByDedupe("badger", fmtKey);
        if (existingFormat) {
          console.info("[ingestSubmit] dedupe-hit", {
            kind: "format",
            variant,
            dedupeKey: fmtKey,
            existingJobId: existingFormat.jobId,
            existingStatus: existingFormat.status,
            existingDismissedAt: existingFormat.dismissedAt,
          });
          formatJobIds.push({ variant, jobId: existingFormat.jobId });
          continue;
        }
        const formatJobId = newId();
        const formatJob: IngestJobRecord = {
          ...baseRecord(now),
          jobId: formatJobId,
          kind: "format",
          lane: "format",
          variant,
          priority: PRIORITY_BY_VARIANT[variant],
          parentJobIds: [sourceJobId],
          groupId,
          mediaId: groupId,
          dedupeKey: fmtKey,
          payload: {
            userId: validated.userId,
            filename: source.filename,
            variant,
            parentSourceJobId: sourceJobId,
            ...(placementId ? { placementId } : {}),
          },
        };
        await engine.submit(formatJob);
        formatJobIds.push({ variant, jobId: formatJobId });
      }

      submitted.push({ groupId, sourceJobId, placementId, formatJobIds });
    }

    console.info("[ingestSubmit] result", {
      userId: validated.userId,
      submittedCount: submitted.length,
      sourceJobIds: submitted.map((s) => s.sourceJobId),
      placementIds: submitted.map((s) => s.placementId),
      formatCounts: submitted.map((s) => s.formatJobIds.length),
    });
    return { submitted };
  };
}

/**
 * `badger.ingest.attach_metadata`
 *
 * Threads the catalog match info (mediaId / season / episode) onto an in-flight
 * source job's payload, under `payload.hints`. The next `identify` step run
 * picks up the new hints; if `identify` already ran, the metadata is still
 * stored on the job for the `commit` step's library write.
 *
 * "Too late" cutoff: any of the post-identify steps (extract, upload, commit)
 * has reached `running`/`succeeded`/`failed`. Up to and including a queued
 * `extract` step is still attachable — commit reads the merged payload at
 * library-write time, so a late attach is safely propagated.
 */
const TOO_LATE_STEP_KINDS = new Set(["extract", "upload", "commit"]);

export function createBadgerIngestAttachMetadataHandler(
  deps: IngestSubmitDeps
): AttachMetadataHandler {
  const { engine } = deps;
  return async (payload) => {
    const validated =
      badgerIngestAttachMetadata.payloadSchema.parse(payload);
    console.info("[ingestSubmit] attachMetadata entry", {
      jobId: validated.jobId,
      mediaId: validated.mediaId,
      season: validated.season,
      episode: validated.episode,
      hasPendingMediaPayload: validated.pendingMediaPayload !== undefined,
    });
    const found = await engine.get(validated.jobId);
    if (!found) {
      console.info("[ingestSubmit] attachMetadata result", {
        jobId: validated.jobId,
        attached: false,
        errorCode: "not-found",
      });
      return {
        attached: false,
        jobId: validated.jobId,
        errorCode: "not-found",
      };
    }
    const { job, steps } = found;
    if (job.kind !== "source") {
      console.info("[ingestSubmit] attachMetadata result", {
        jobId: validated.jobId,
        attached: false,
        errorCode: "not-a-source-job",
      });
      return {
        attached: false,
        jobId: validated.jobId,
        errorCode: "not-a-source-job",
      };
    }
    // Past identify? Any post-identify step has progressed beyond queued.
    const tooLate = steps.some(
      (s) => TOO_LATE_STEP_KINDS.has(s.kind) && s.status !== "queued"
    );
    if (tooLate) {
      console.info("[ingestSubmit] attachMetadata result", {
        jobId: validated.jobId,
        attached: false,
        errorCode: "too-late",
      });
      return {
        attached: false,
        jobId: validated.jobId,
        errorCode: "too-late",
      };
    }

    const existingHints =
      (job.payload?.hints as Record<string, unknown> | undefined) ?? {};
    const hintsPatch: Record<string, unknown> = { ...existingHints };
    if (validated.mediaId !== undefined) hintsPatch.mediaId = validated.mediaId;
    if (validated.season !== undefined) hintsPatch.season = validated.season;
    if (validated.episode !== undefined) hintsPatch.episode = validated.episode;
    if (validated.pendingMediaPayload !== undefined) {
      hintsPatch.pendingMediaPayload = validated.pendingMediaPayload;
    }

    await engine.updateJobPayload(validated.jobId, { hints: hintsPatch });
    console.info("[ingestSubmit] attachMetadata result", {
      jobId: validated.jobId,
      attached: true,
      hintKeysApplied: Object.keys(hintsPatch),
    });
    return { attached: true, jobId: validated.jobId };
  };
}

/**
 * `badger.ingest.plan_outputs`
 *
 * Reconciles the set of format jobs in a source group against a freshly
 * desired list:
 *  - variants in the desired list but absent from existing: submit new
 *    format jobs with `parentJobIds = [sourceJobId]` and the spec §3 priority.
 *  - variants present but no longer desired: cancel them. Cancellation is the
 *    correct action (not deletion) — even queued cancels persist as history,
 *    matching the spec's "preserve history" rule.
 *
 * No-op when the desired list matches the existing set.
 *
 * Edge case: an empty `formats` array cancels ALL formats. The source job is
 * untouched, so the ingest still produces a playable source — formats are
 * additive content. Documented intentionally rather than rejected: a user
 * downgrading their quality settings to "source-only" is a legitimate flow.
 */
export function createBadgerIngestPlanOutputsHandler(
  deps: IngestSubmitDeps
): PlanOutputsHandler {
  const { engine } = deps;
  return async (payload) => {
    const validated = badgerIngestPlanOutputs.payloadSchema.parse(payload);
    console.info("[ingestSubmit] planOutputs entry", {
      sourceJobId: validated.sourceJobId,
      desiredFormats: validated.formats,
    });
    const found = await engine.get(validated.sourceJobId);
    if (!found) {
      console.info("[ingestSubmit] planOutputs result", {
        sourceJobId: validated.sourceJobId,
        errorCode: "not-found",
      });
      return {
        addedJobIds: [],
        removedJobIds: [],
        errorCode: "not-found",
      };
    }
    const sourceJob = found.job;
    if (sourceJob.kind !== "source") {
      console.info("[ingestSubmit] planOutputs result", {
        sourceJobId: validated.sourceJobId,
        errorCode: "not-a-source-job",
      });
      return {
        addedJobIds: [],
        removedJobIds: [],
        errorCode: "not-a-source-job",
      };
    }
    const TERMINAL = new Set([
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]);
    if (TERMINAL.has(sourceJob.status)) {
      console.info("[ingestSubmit] planOutputs result", {
        sourceJobId: validated.sourceJobId,
        sourceStatus: sourceJob.status,
        errorCode: "source-terminal",
      });
      return {
        addedJobIds: [],
        removedJobIds: [],
        errorCode: "source-terminal",
      };
    }

    const existing = (
      await engine.list({ groupId: sourceJob.groupId, kind: ["format"] })
    ).jobs;
    // Only consider non-terminal existing formats — cancelled/failed siblings
    // are already history; we don't want to "remove" them again.
    const liveExisting = existing.filter((j) => !TERMINAL.has(j.status));
    const existingByVariant = new Map<string, IngestJobRecord>();
    for (const j of liveExisting) {
      if (j.variant) existingByVariant.set(j.variant, j);
    }

    const desired = new Set(validated.formats);

    const now = new Date().toISOString();
    const userId =
      (sourceJob.payload?.userId as string | undefined) ?? "unknown";
    const filename =
      (sourceJob.payload?.filename as string | undefined) ?? null;

    const addedJobIds: PlanResult["addedJobIds"] = [];
    const sourcePlacementId = readJobPlacementId(sourceJob);
    for (const variant of validated.formats) {
      if (existingByVariant.has(variant)) continue;
      const formatJobId = newId();
      const formatJob: IngestJobRecord = {
        ...baseRecord(now),
        jobId: formatJobId,
        kind: "format",
        lane: "format",
        variant,
        priority: PRIORITY_BY_VARIANT[variant],
        parentJobIds: [sourceJob.jobId],
        groupId: sourceJob.groupId,
        mediaId: sourceJob.mediaId,
        payload: {
          userId,
          filename,
          variant,
          parentSourceJobId: sourceJob.jobId,
          ...(sourcePlacementId ? { placementId: sourcePlacementId } : {}),
        },
      };
      await engine.submit(formatJob);
      addedJobIds.push({ variant, jobId: formatJobId });
    }

    const removedJobIds: string[] = [];
    for (const [variant, job] of existingByVariant) {
      if (desired.has(variant as Quality)) continue;
      await engine.cancel(job.jobId, "plan-outputs-removed");
      removedJobIds.push(job.jobId);
    }

    console.info("[ingestSubmit] planOutputs result", {
      sourceJobId: validated.sourceJobId,
      groupId: sourceJob.groupId,
      addedCount: addedJobIds.length,
      removedCount: removedJobIds.length,
      addedVariants: addedJobIds.map((a) => a.variant),
    });
    return { addedJobIds, removedJobIds };
  };
}
