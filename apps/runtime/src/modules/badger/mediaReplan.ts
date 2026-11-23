/**
 * Phase 4 handler: `badger.media.replan_qualities`.
 *
 * Post-ingest counterpart to `badger.ingest.plan_outputs`. The legacy
 * plan_outputs requires a live (non-terminal) source job, which only exists
 * during the initial ingest. This handler operates on `mediaId` + `fileId` —
 * the committed file row — so users can add or remove qualities at any time
 * after the source job has succeeded.
 *
 * Validation (atomic refusal — handler returns one errorCode and applies
 * nothing on any violation):
 *   - "source-protected"     — any removeFormatId targets an `is_source = 1` row
 *   - "media-not-found"      — any referenced id is missing for this fileId
 *   - "quality-exists"       — any add quality is already present on the file
 *   - "cannot-transcode-up"  — any add quality is higher resolution than
 *                              everything currently available (no up-scaling)
 *
 * Side effects on success:
 *   - For each `removeFormatIds[i]`: forwards the format's initKey + every
 *     chunk key to `/storage/delete` via the runtime's storage gateway, then
 *     removes the SQLite row via `removeMediaFormat` (media_format_chunks
 *     rows cascade via the existing FK). Fail-loud on storage error: the
 *     SQLite row is NOT removed, so the user can retry. A missing token
 *     defers cleanup to the storage GC (same policy as `deleteMedia`).
 *   - For each `addQualities[i]`: picks a source variant via
 *     `pickReTranscodeSource`, then submits a new `kind: "format"` job with
 *     a `retranscode: true` payload hint. The Phase 7 step handler picks
 *     up the hint and runs the streaming source → ffmpeg → DASH pipeline.
 *     Until Phase 7 ships, the job will reach step dispatch and fail with
 *     a clear error code — that is the documented intermediate state.
 *
 * No partial application of VALIDATION: validation runs to completion BEFORE
 * any mutation. Within the mutation pass, removals run before adds; if a
 * storage-delete fails mid-pass, earlier successful removes are kept and the
 * handler throws — the renderer surfaces the error and retries.
 */

import {
  badgerMediaReplanQualities,
  type BadgerMediaReplanQualitiesErrorCode,
  type BadgerMediaReplanQualitiesPayload,
  type BadgerMediaReplanQualitiesResult,
} from "@space/runtime-contracts/badger/ingest";
import { pickReTranscodeSource, QUALITY_ORDER, type QualityPreset } from "@space/ingest-core/quality";
import { parseMediaPlacementIdFromObjectKey } from "@space/shared/storagePlacement";
import type { EngineV2 } from "../../core/jobs/engineV2";
import type { BadgerLibraryDbService } from "../badgerLibraryDb";
import type { IngestJobRecord, IngestJobStatus } from "@space/runtime-jobs";

// Mirrors the priority table in ingestSubmit.ts. Higher = lower priority.
// Source jobs are priority 0; format jobs interleave behind them.
const PRIORITY_BY_VARIANT: Record<QualityPreset, number> = {
  "2160p": 5,
  "1080p": 10,
  "720p": 20,
  "480p": 30,
  "360p": 40,
  "240p": 50,
  "144p": 60,
};

/**
 * A replan add is a quality the user explicitly asked for and is waiting on.
 * It must not queue behind the ingest ladder's background format jobs
 * ("backfill": every episode's 360p/480p/… derivative, priority 5..60) or
 * offline downloads (70). Engine pickup sorts by `priority ASC`, so the
 * offset puts every user-requested variant (always < 0) ahead of all of
 * them while keeping the variant order among user requests. Running encodes
 * are not preempted: the requested job takes the next free format slot.
 *
 * @bugfix P23 (ultimate confirm run 2026-10-07): a requested 720p waited up
 * to 52 min on the low-end budget.
 */
export const USER_REQUESTED_FORMAT_PRIORITY_OFFSET = -100;

export const userRequestedFormatPriority = (variant: QualityPreset): number =>
  (PRIORITY_BY_VARIANT[variant] ?? 50) + USER_REQUESTED_FORMAT_PRIORITY_OFFSET;

/**
 * Shape returned by `listMediaFormats` (the only fields we depend on are the
 * subset below). Declared inline rather than re-imported from
 * `library-db-definition` to keep the runtime handler free of the SQLite
 * schema package.
 */
type MediaFormatRow = {
  id: string;
  mediaId: string;
  fileId: string;
  quality: string;
  codec: string;
  isSource: boolean;
  /** Storage object key for the DASH init segment. Null when the format predates
   *  the init/segment split or is template-projected. */
  initKey: string | null;
  /** Per-chunk object keys, ordered by `order_index`. */
  chunks: Array<{ key: string; sizeBytes: number | null }>;
};

/**
 * Storage-delete primitive. Forwards every object key to the API's
 * `/storage/delete` endpoint (the API soft-deletes storageObjects rows and
 * reclaims quota). Returns the actual deleted count + reclaimed bytes so
 * callers can surface them.
 *
 * Implementations must FAIL LOUD on transport errors so the handler can
 * leave the library row in place — a silent swallow would orphan SQLite
 * state pointing at chunks the user can no longer fetch.
 */
export type DeleteStorageKeysFn = (
  keys: string[]
) => Promise<{ deleted: number; reclaimedBytes: number }>;

export interface MediaReplanDeps {
  engine: EngineV2;
  libraryDb: BadgerLibraryDbService;
  /** Resolves to the active userId for the runtime. Defaults to ""—the handler
   *  threads whatever the engine carries on existing source-job records. */
  resolveActiveUserId?: () => string | null;
  /**
   * Storage-delete delegate. Production wires `deleteStorageObjects` from
   * `@space/library-db-runtime/api` with the active backend token. Tests
   * inject a mock that records the calls so storage delete + library delete
   * ordering can be asserted.
   *
   * Optional: when omitted, the handler skips storage-side delete and only
   * removes library rows — chunks are reclaimed by the storage GC (same
   * fallback policy as `LibraryDb.deleteMedia` when no token is available).
   */
  deleteStorageKeys?: DeleteStorageKeysFn;
}

export type MediaReplanHandler = (
  payload: BadgerMediaReplanQualitiesPayload
) => Promise<BadgerMediaReplanQualitiesResult>;

const newId = (): string => crypto.randomUUID();

const emptyRefusal = (
  errorCode: BadgerMediaReplanQualitiesErrorCode
): BadgerMediaReplanQualitiesResult => {
  // Capture every refusal + its call site so runtime.log pins exactly which
  // guard fired and why (the runtime logs console.* to that file). Kept as
  // permanent instrumentation — this flow is validation-heavy and the next
  // regression should be one grep away.
  console.warn(
    `[replan] refused errorCode=${errorCode}`,
    new Error("refusal-call-site").stack,
  );
  return {
    addedJobIds: [],
    removedFormatIds: [],
    errorCode,
  };
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
  // These four are NOT NULL on runtime_jobs (stage_code, stage_label,
  // progress_pct) AND non-null on IngestJobRecord. Mirror ingestSubmit's
  // queued-record defaults — passing null here crashes engine.submit with
  // `NOT NULL constraint failed: runtime_jobs.stage_code` (the post-ingest
  // add-quality path is the only caller, so this never fired until a user
  // re-added a quality on a sync-populated library). @bugfix
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

export const createBadgerMediaReplanQualitiesHandler = (
  deps: MediaReplanDeps
): MediaReplanHandler => {
  const { engine, libraryDb } = deps;
  return async (payload) => {
    const validated = badgerMediaReplanQualities.payloadSchema.parse(payload);
    const { mediaId, fileId, addQualities, removeFormatIds } = validated;

    // Read the full set of formats for this file. We use `listMediaFormats(mediaId)`
    // and filter by fileId here — the library-db API exposes the
    // media-keyed list, and there can be multiple files per media (e.g. one
    // per TV episode). This keeps the lookup atomic.
    const allMediaFormats = (await libraryDb.call(
      "listMediaFormats",
      [mediaId]
    )) as MediaFormatRow[] | null;
    const fileFormats = (allMediaFormats ?? []).filter(
      (row) => row.fileId === fileId
    );

    if (fileFormats.length === 0 && (removeFormatIds.length > 0 || addQualities.length > 0)) {
      // No formats means the file row itself is missing (or has no formats
      // committed yet). Either way, we cannot evaluate validation rules
      // against an empty set — refuse with "media-not-found".
      return emptyRefusal("media-not-found");
    }

    const formatById = new Map(fileFormats.map((f) => [f.id, f]));
    const presentQualities = new Set<string>(fileFormats.map((f) => f.quality));
    // Highest resolution = lowest rank index. `Infinity` falls back when the
    // file has no formats at all (we already refused above, but defensive).
    const highestPresentRank = fileFormats.reduce((best, f) => {
      const r = QUALITY_ORDER.indexOf(f.quality as QualityPreset);
      return r >= 0 && r < best ? r : best;
    }, Number.POSITIVE_INFINITY);

    // Entry context — everything the validation + submit depend on. Lands in
    // runtime.log; kept permanently so a future replan failure is diagnosable
    // from the log alone (no re-instrumentation needed).
    console.info(
      "[replan] entry",
      JSON.stringify({
        mediaId,
        fileId,
        addQualities,
        removeFormatIds,
        allMediaFormatsCount: allMediaFormats?.length ?? null,
        fileFormats: fileFormats.map((f) => ({
          id: f.id,
          quality: f.quality,
          isSource: f.isSource,
          rank: QUALITY_ORDER.indexOf(f.quality as QualityPreset),
        })),
        presentQualities: Array.from(presentQualities),
        highestPresentRank,
        addRanks: addQualities.map((q) => ({
          q,
          rank: QUALITY_ORDER.indexOf(q as QualityPreset),
        })),
      }),
    );

    // Defensive implicit-source protection. Legacy / pre-Phase-2 media — and
    // any formats re-applied from v1 op-stream entries — can have NO
    // `is_source = 1` row at all. The schema-level self-healing backfill
    // (library-db-definition: backfillMissingIsSourceFlags) flags the highest
    // quality on the next library-DB open, but until that runs the explicit
    // `row.isSource` guard below is inert and the only/highest copy would be
    // deletable. Since we never up-scale, the highest available resolution IS
    // the de-facto source: when nothing is flagged, treat the highest-rank row
    // (lowest id on a tie, matching the backfill's tie-break) as
    // source-protected so a delete can never orphan the media.
    const anyExplicitSource = fileFormats.some((f) => f.isSource);
    const implicitSourceId = anyExplicitSource
      ? null
      : (fileFormats
          .filter((f) => {
            const r = QUALITY_ORDER.indexOf(f.quality as QualityPreset);
            return (r >= 0 ? r : Number.POSITIVE_INFINITY) === highestPresentRank;
          })
          .map((f) => f.id)
          .sort()[0] ?? null);

    // --- Validation pass — atomic refusal on first violation ---

    // Remove guards
    for (const formatId of removeFormatIds) {
      const row = formatById.get(formatId);
      if (!row) return emptyRefusal("media-not-found");
      if (row.isSource) return emptyRefusal("source-protected");
      // No explicit source flagged anywhere on this file → the de-facto source
      // (highest resolution) is protected too. See implicitSourceId above.
      if (implicitSourceId !== null && formatId === implicitSourceId) {
        return emptyRefusal("source-protected");
      }
    }

    // Add guards
    for (const variant of addQualities) {
      if (presentQualities.has(variant)) {
        return emptyRefusal("quality-exists");
      }
      const rank = QUALITY_ORDER.indexOf(variant);
      if (rank < 0) {
        // Schema already validates via badgerIngestQualitySchema, but be
        // explicit — `cannot-transcode-up` is the catch-all for "we can't
        // produce this quality from what we have".
        return emptyRefusal("cannot-transcode-up");
      }
      if (rank < highestPresentRank) {
        // The requested variant has higher resolution than anything
        // available — we never up-scale.
        return emptyRefusal("cannot-transcode-up");
      }
    }

    // --- Mutation pass ---

    const now = new Date().toISOString();
    const userId = deps.resolveActiveUserId?.() ?? "";

    // 1. Removals. For each format being removed: collect every object key
    //    (initKey + chunks[].key), forward them to /storage/delete via the
    //    injected storage delegate, then drop the library row. Fail-loud on
    //    transport error — the SQLite row stays in place so the user can
    //    retry. The optional dep means tests can stub the delete; when
    //    omitted entirely the chunks are deferred to the storage GC (same
    //    policy as `LibraryDb.deleteMedia`).
    const removedFormatIds: string[] = [];
    for (const formatId of removeFormatIds) {
      const row = formatById.get(formatId)!;
      const keys: string[] = [];
      if (row.initKey) keys.push(row.initKey);
      for (const chunk of row.chunks ?? []) {
        if (chunk.key) keys.push(chunk.key);
      }
      if (keys.length > 0 && deps.deleteStorageKeys) {
        // No try/catch: a storage-delete failure propagates so the library
        // row stays put. The renderer surfaces the error and the user can
        // retry; the orphaned chunks (if any partial-success happened
        // server-side) are caught by the periodic GC.
        await deps.deleteStorageKeys(keys);
      }
      await libraryDb.call("removeMediaFormat", [formatId]);
      removedFormatIds.push(formatId);
    }

    // 2. Adds. One format job per add quality, with `retranscode: true` on
    //    the payload + the source variant + source format id so the Phase 7
    //    step handler can resolve the chunks to stream.
    const addedJobIds: BadgerMediaReplanQualitiesResult["addedJobIds"] = [];
    const presentForPick = (fileFormats
      .map((f) => f.quality)
      .filter((q): q is QualityPreset =>
        QUALITY_ORDER.includes(q as QualityPreset)
      ));
    // Per-media silo placement (#145): a retranscoded quality joins the silo
    // the media's existing objects live on. Legacy (pre-placement) keys carry
    // no id, so the new quality starts a fresh placement.
    const existingKeys = fileFormats.flatMap((f) => [f.initKey ?? "", ...(f.chunks ?? []).map((c) => c.key ?? "")]);
    const placementId =
      existingKeys.map(parseMediaPlacementIdFromObjectKey).find((id): id is string => id !== null) ?? newId();
    console.info("[replan] placement", JSON.stringify({ mediaId, fileId, placementId }));
    for (const variant of addQualities) {
      const sourceVariant = pickReTranscodeSource(variant, presentForPick);
      if (!sourceVariant) {
        // Should have been caught by the cannot-transcode-up guard above,
        // but defend against a tie at the validation boundary.
        return emptyRefusal("cannot-transcode-up");
      }
      const sourceFormat = fileFormats.find((f) => f.quality === sourceVariant);
      // Defensive: sourceVariant came from `presentForPick` which was derived
      // from `fileFormats`, so this lookup cannot miss in practice.
      if (!sourceFormat) {
        return emptyRefusal("cannot-transcode-up");
      }

      const formatJobId = newId();
      // One live job per (media, file, quality). `presentQualities` only sees
      // COMMITTED rows, so a quality re-added while its first job is still
      // encoding (minutes on a CPU-only machine) used to pass validation and
      // commit twice. The engine's store arbitrates the dedupe slot
      // atomically; a repeat request gets the in-flight job id back.
      const replanKey = `replan:${mediaId}:${fileId}:${variant}`;
      const formatJob: IngestJobRecord = {
        ...baseRecord(now),
        jobId: formatJobId,
        kind: "format",
        lane: "format",
        variant,
        priority: userRequestedFormatPriority(variant),
        parentJobIds: [],
        groupId: replanKey,
        mediaId,
        dedupeKey: replanKey,
        payload: {
          userId,
          mediaId,
          fileId,
          variant,
          targetVariant: variant,
          sourceFormatId: sourceFormat.id,
          sourceVariant,
          // Phase 7 step handler routes on this hint: when true, run the
          // streaming source → ffmpeg → DASH pipeline instead of the normal
          // file-input transcode.
          retranscode: true,
          placementId,
        },
      };
      // engine.submit is the historical failure point (a null stage_code in
      // the queued record once crashed here with a NOT NULL constraint).
      // Capture the exact throw + the job shape, then re-throw unchanged.
      let submittedJobId: string;
      try {
        submittedJobId = (await engine.submit(formatJob)).jobId;
      } catch (submitErr) {
        console.error(
          "[replan] engine.submit threw",
          submitErr instanceof Error ? (submitErr.stack ?? submitErr.message) : String(submitErr),
          "formatJob=",
          JSON.stringify(formatJob),
        );
        throw submitErr;
      }
      if (submittedJobId !== formatJobId) {
        console.info(
          "[replan] dedupe-hit — quality already in flight, reusing job",
          JSON.stringify({ mediaId, fileId, variant, dedupeKey: replanKey, existingJobId: submittedJobId }),
        );
      }
      addedJobIds.push({ variant, jobId: submittedJobId });
    }

    console.info(
      "[replan] success",
      JSON.stringify({ addedJobIds, removedFormatIds }),
    );
    return { addedJobIds, removedFormatIds };
  };
};
