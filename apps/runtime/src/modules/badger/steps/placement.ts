/**
 * Per-media silo placement (#145): which `placementId` a badger job uploads
 * under. One playable media = one source job = one placementId, so every
 * object it produces (and every later format job of it) lands on one silo.
 *
 * Normally the id is already on the payload: the submit handler stamps
 * `payload.placementId` on the source job and its format jobs, and the
 * replan handler stamps the id parsed from the media's existing keys on a
 * retranscode job. The fallbacks cover jobs queued before placement ids
 * existed:
 * - source job → its job id when it is a valid placement id, else a fresh
 *   UUID persisted on the payload so a retry/resume reuses it;
 * - format job → the parent source job's persisted id, else the parent's job
 *   id (what that parent itself falls back to);
 * - retranscode job → a fresh UUID, persisted.
 */
import { randomUUID } from "node:crypto";
import { isValidPlacementId } from "@space/shared/storagePlacement";
import type { IngestJobRecord } from "../../../core/jobs/engineV2";
import type { BadgerStepDeps } from "./deps";

type PlacementDeps = Pick<BadgerStepDeps, "lookupJobPlacementId" | "persistJobPlacementId">;

/**
 * The placementId a job already owns without minting: its persisted
 * `payload.placementId`, else (source jobs only) its job id when valid.
 */
export const readJobPlacementId = (job: Pick<IngestJobRecord, "jobId" | "kind" | "payload">): string | null => {
  const value = job.payload.placementId;
  if (typeof value === "string" && isValidPlacementId(value)) return value;
  return job.kind === "source" && isValidPlacementId(job.jobId) ? job.jobId : null;
};

export const resolveJobPlacementId = async (
  job: Pick<IngestJobRecord, "jobId" | "kind" | "payload" | "parentJobIds">,
  deps: PlacementDeps
): Promise<string> => {
  const owned = readJobPlacementId(job);
  if (owned) return owned;

  const isRetranscode = job.kind === "format" && job.payload.retranscode === true;
  if (job.kind === "format" && !isRetranscode) {
    const fromPayload = job.payload.parentSourceJobId;
    const parentSourceJobId =
      typeof fromPayload === "string" && fromPayload.length > 0 ? fromPayload : (job.parentJobIds[0] ?? null);
    if (!parentSourceJobId) throw new Error("STEP_PLACEMENT_MISSING_PARENT_SOURCE_JOB_ID");
    const parentPlacementId = (await deps.lookupJobPlacementId?.(parentSourceJobId)) ?? null;
    if (parentPlacementId && isValidPlacementId(parentPlacementId)) return parentPlacementId;
    if (isValidPlacementId(parentSourceJobId)) return parentSourceJobId;
    throw new Error(
      `STEP_PLACEMENT_PARENT_UNKNOWN:${parentSourceJobId} — parent source job has no placementId and its job id is not a valid one`
    );
  }

  if (!deps.persistJobPlacementId) {
    throw new Error("STEP_PLACEMENT_PERSIST_NOT_WIRED — deps.persistJobPlacementId is required to mint a placementId");
  }
  const minted = randomUUID();
  await deps.persistJobPlacementId(job.jobId, minted);
  console.info("[badger.steps.placement] minted placementId", {
    jobId: job.jobId,
    kind: job.kind,
    placementId: minted,
  });
  return minted;
};
