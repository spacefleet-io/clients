import type { SpaceAppId } from "@space/shared/appScope";

export type RuntimeJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RuntimeJobLane = "interactive" | "background" | "cpu" | "io" | "network";
export type RuntimeJobResourceClaim = "cpuHeavy" | "diskHeavy" | "networkHeavy" | "memoryHeavy";

export type RuntimeJobProgress = {
  mode: "none" | "indeterminate" | "fraction";
  completed: number | null;
  total: number | null;
  unit: "items" | "bytes" | "percent" | null;
};

export type RuntimeJobSchedulingMetadata = {
  submittedOrder?: number | null;
  collectionKey?: string | null;
  mediaOrder?: number | null;
  phaseOrder?: number | null;
  variantOrder?: number | null;
};

export type RuntimeJobRecord = {
  jobId: string;
  app: SpaceAppId;
  kind: string;
  lane: RuntimeJobLane;
  status: RuntimeJobStatus;
  stageCode: string;
  stageLabel: string;
  progress: RuntimeJobProgress;
  payload: Record<string, unknown>;
  outputs: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  resourceClaims?: RuntimeJobResourceClaim[];
  scheduling?: RuntimeJobSchedulingMetadata;
  attemptCount?: number;
  maxAttempts?: number | null;
  nextAttemptAt?: string | null;
  lastAttemptAt?: string | null;
  cancelRequested: boolean;
  priority: number;
  dedupeKey: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RuntimeJobFilter = {
  app?: SpaceAppId;
  status?: RuntimeJobStatus[];
  kind?: string[];
  includeCompleted?: boolean;
  limit?: number;
};

export type RuntimeJobEventPayload = {
  jobId: string;
  app: SpaceAppId;
  kind: string;
  status: RuntimeJobStatus;
  stageCode: string;
  stageLabel: string;
  progress: RuntimeJobProgress;
  payload?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryable?: boolean;
};

export type RuntimeJobSchedulerPolicy = {
  maxConcurrentJobs: number;
  laneConcurrency: Record<RuntimeJobLane, number>;
  resourceLimits: Record<RuntimeJobResourceClaim, number>;
  lanePriority: RuntimeJobLane[];
};

export type RuntimeJobHostCapacity = {
  logicalCpuCount?: number | null;
  totalMemoryGiB?: number | null;
};

export type RuntimeJobSchedulingCandidate = RuntimeJobRecord & {
  resourceClaims?: RuntimeJobResourceClaim[];
};

// ---------------------------------------------------------------------------
// Ingest job model (Phase B/D — runtime-owned durable ingest jobs)
//
// These types describe the new "one source job + N format jobs per media-item"
// shape that replaces the legacy monolithic processMediaJob. They live next to
// the existing RuntimeJob* types and are intentionally additive — the legacy
// Badger compat layer continues to use RuntimeJobRecord unchanged.
// ---------------------------------------------------------------------------

export type IngestJobKind = "source" | "format" | "download" | "export";

/**
 * Lane assignment for ingest scheduling. Distinct from RuntimeJobLane because
 * the ingest scheduler reasons about phases (source extract vs format
 * transcode vs upload) rather than the generic interactive/background split.
 */
export type IngestJobLane = "source" | "format" | "upload";

/**
 * Status union for ingest jobs. Reuses every value of RuntimeJobStatus and
 * adds `interrupted` for crash-recovery (a row that was `running` when the
 * runtime exited and has not yet been re-evaluated by hydrateOnBoot).
 *
 * NOTE: this is a distinct type from RuntimeJobStatus on purpose — widening
 * RuntimeJobStatus would force every existing Badger compat consumer
 * (badgerCompat.ts, filter.ts, scheduler.ts) to handle a new
 * variant they have no opinion on. The plan instructs us not to modify those
 * files, so we keep the unions independent.
 */
export type IngestJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * Durable ingest job record. Wraps a RuntimeJobRecord (so it remains
 * compatible with the generic event/scheduler surface) and layers the
 * ingest-specific fields the plan section 1 calls for.
 *
 * `status` here is intentionally narrower-than-RuntimeJobRecord but wider
 * (allows `interrupted`). The base record's `status` is kept in sync by the
 * runtime store; consumers that only care about the ingest view should read
 * the top-level fields.
 */
export interface IngestJobRecord
  extends Omit<RuntimeJobRecord, "status" | "lane" | "kind"> {
  kind: IngestJobKind;
  lane: IngestJobLane;
  status: IngestJobStatus;
  /** Ties all jobs of one media-item ingest together. Equal to mediaId. */
  groupId: string;
  mediaId: string;
  /** e.g., "360p" for format jobs; null for source jobs. */
  variant: string | null;
  /** Dependency edges (downstream-only cascade). Empty for source jobs. */
  parentJobIds: string[];
  /** Timestamp when the user dismissed a terminal record from history. */
  dismissedAt: string | null;
  /** Bytes-per-second observed on the active upload, if any. */
  uploadSpeedBytesPerSec: number | null;
  /** 0..100 convenience mirror of progress.completed/total. */
  progressPct: number;
}

/**
 * One step in an ingest job's internal sequence (e.g., probe → identify →
 * extract → upload → commit for source; transcode → chunk+encrypt → upload
 * for format).
 */
export interface IngestJobStepRecord {
  stepId: string;
  jobId: string;
  ordinal: number;
  /** Free-form step kind, e.g., "probe", "extract", "encode", "upload". */
  kind: string;
  status: IngestJobStatus;
  progressPct: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export const isTerminalIngestJobStatus = (status: IngestJobStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";
