import { z } from "zod";

// NOTE: This module is the canonical source-of-truth for the ingest job
// shapes. The TypeScript types in `packages/runtime-jobs/src/models.ts`
// (IngestJobKind, IngestJobLane, IngestJobStatus, IngestJobRecord,
// IngestJobStepRecord) are duplicates that the runtime side maintains in
// lockstep with the Zod schemas defined here. We intentionally do NOT
// import from @space/runtime-jobs to avoid a contracts→runtime-jobs cycle
// (runtime-jobs depends on contracts in §B/§D of the rollout). If the two
// drift, the runtime side is wrong.

// ---------------------------------------------------------------------------
// Status / kind / lane unions
// ---------------------------------------------------------------------------

export const ingestJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type IngestJobStatusZ = z.infer<typeof ingestJobStatusSchema>;

export const ingestJobKindSchema = z.enum(["source", "format", "download", "export"]);
export type IngestJobKindZ = z.infer<typeof ingestJobKindSchema>;

export const ingestJobLaneSchema = z.enum(["source", "format", "upload"]);
export type IngestJobLaneZ = z.infer<typeof ingestJobLaneSchema>;

// Static parity expectations (see header comment):
//   IngestJobStatusZ  ≡ IngestJobStatus
//   IngestJobKindZ    ≡ IngestJobKind
//   IngestJobLaneZ    ≡ IngestJobLane
// The runtime-jobs package's types are derived from these schemas; if they
// drift, fix runtime-jobs.

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const progressPctSchema = z.number().min(0).max(100);

const runtimeJobProgressSchema = z.object({
  mode: z.enum(["none", "indeterminate", "fraction"]),
  completed: z.number().nullable(),
  total: z.number().nullable(),
  unit: z.enum(["items", "bytes", "percent"]).nullable(),
});

export const ingestJobRecordSchema = z.object({
  jobId: z.string().min(1),
  app: z.enum(["badger", "parrot"]),
  kind: ingestJobKindSchema,
  lane: ingestJobLaneSchema,
  status: ingestJobStatusSchema,
  stageCode: z.string(),
  stageLabel: z.string(),
  progress: runtimeJobProgressSchema,
  payload: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  resourceClaims: z
    .array(z.enum(["cpuHeavy", "diskHeavy", "networkHeavy", "memoryHeavy"]))
    .optional(),
  scheduling: z
    .object({
      submittedOrder: z.number().nullable().optional(),
      collectionKey: z.string().nullable().optional(),
      mediaOrder: z.number().nullable().optional(),
      phaseOrder: z.number().nullable().optional(),
      variantOrder: z.number().nullable().optional(),
    })
    .optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  maxAttempts: z.number().int().nullable().optional(),
  nextAttemptAt: z.string().nullable().optional(),
  lastAttemptAt: z.string().nullable().optional(),
  cancelRequested: z.boolean(),
  priority: z.number(),
  dedupeKey: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),

  // Ingest-specific extensions (per plan §1).
  groupId: z.string().min(1),
  mediaId: z.string().min(1),
  variant: z.string().nullable(),
  parentJobIds: z.array(z.string()),
  dismissedAt: z.string().nullable(),
  uploadSpeedBytesPerSec: z.number().nullable(),
  progressPct: progressPctSchema,
});

export type IngestJobRecordZ = z.infer<typeof ingestJobRecordSchema>;
// Parity expectation: IngestJobRecordZ ≡ IngestJobRecord (in runtime-jobs).

export const ingestJobStepRecordSchema = z.object({
  stepId: z.string().min(1),
  jobId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  kind: z.string(),
  status: ingestJobStatusSchema,
  progressPct: progressPctSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export type IngestJobStepRecordZ = z.infer<typeof ingestJobStepRecordSchema>;
// Parity expectation: IngestJobStepRecordZ ≡ IngestJobStepRecord.

// ---------------------------------------------------------------------------
// Event payloads (§5)
// ---------------------------------------------------------------------------

const eventEnvelope = {
  eventId: z.number().int().nonnegative(),
  emittedAt: z.string(),
};

export const runtimeJobsCreatedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal("runtime.jobs.created"),
  job: ingestJobRecordSchema,
});

export const runtimeJobsStartedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal("runtime.jobs.started"),
  jobId: z.string().min(1),
  groupId: z.string().min(1),
  kind: ingestJobKindSchema,
  variant: z.string().nullable(),
  startedAt: z.string(),
});

export const runtimeJobsProgressEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal("runtime.jobs.progress"),
  jobId: z.string().min(1),
  groupId: z.string().min(1),
  progressPct: progressPctSchema,
  stageCode: z.string(),
  stageLabel: z.string(),
  uploadSpeedBytesPerSec: z.number().nullable(),
  // Optional: present on emits from runtime ≥ round 7. Historical events
  // replayed from the SSE event log on a low Last-Event-ID reconnect may
  // omit it, so renderer reducers must preserve `cur.status` when absent.
  status: ingestJobStatusSchema.optional(),
});

export const runtimeJobsSucceededEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal("runtime.jobs.succeeded"),
  job: ingestJobRecordSchema,
  /**
   * The badger library DB's `version` AT THE MOMENT the commit step's
   * coalesced snapshot publish landed. Used by the desktop renderer to
   * close the cross-stream race between this `runtime.jobs.succeeded`
   * event (jobs SSE) and the matching `library.updated` event (library
   * SSE): the play button stays disabled until the renderer's last-seen
   * library snapshot version is `>= libraryVersionAtDone`. Optional —
   * absent for non-badger jobs and for jobs whose commit step did not
   * mutate the library (e.g. cancellations that races past commit).
   * Renderers MUST default to "ready" when the field is missing for
   * back-compat with pre-Phase 3 events replayed from the SSE log.
   */
  libraryVersionAtDone: z.number().int().nonnegative().optional(),
});

export const runtimeJobsFailedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal("runtime.jobs.failed"),
  job: ingestJobRecordSchema,
  errorCode: z.string(),
  errorMessage: z.string(),
});

export const runtimeJobsCancelledEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal("runtime.jobs.cancelled"),
  job: ingestJobRecordSchema,
  reason: z.string(),
});

export const runtimeJobsDismissedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal("runtime.jobs.dismissed"),
  jobId: z.string().min(1),
  groupId: z.string().min(1),
  dismissedAt: z.string(),
});

export const runtimeJobsEventSchema = z.discriminatedUnion("event", [
  runtimeJobsCreatedEventSchema,
  runtimeJobsStartedEventSchema,
  runtimeJobsProgressEventSchema,
  runtimeJobsSucceededEventSchema,
  runtimeJobsFailedEventSchema,
  runtimeJobsCancelledEventSchema,
  runtimeJobsDismissedEventSchema,
]);

export type RuntimeJobsEvent = z.infer<typeof runtimeJobsEventSchema>;

// ---------------------------------------------------------------------------
// Commands
//
// These are runtime-level commands (not app-scoped under one app), so we
// use plain Zod schemas rather than the `defineCommand` helper which couples
// to a specific AppId. Consumers parse with the payload/result schemas
// directly.
// ---------------------------------------------------------------------------

export const runtimeJobsListPayloadSchema = z.object({
  filter: z
    .object({
      app: z.enum(["badger", "parrot"]).optional(),
      mediaId: z.string().min(1).optional(),
      status: z.array(ingestJobStatusSchema).optional(),
      kind: ingestJobKindSchema.optional(),
      lane: ingestJobLaneSchema.optional(),
      includeDismissed: z.boolean().optional(),
    })
    .optional(),
});

export const runtimeJobsListResultSchema = z.object({
  jobs: z.array(ingestJobRecordSchema),
  maxEventId: z.number().int().nonnegative(),
});

export const runtimeJobsListCommand = {
  name: "runtime.jobs.list" as const,
  payloadSchema: runtimeJobsListPayloadSchema,
  resultSchema: runtimeJobsListResultSchema,
} as const;

export const runtimeJobsGetPayloadSchema = z.object({
  jobId: z.string().min(1),
});

export const runtimeJobsGetResultSchema = z.object({
  job: ingestJobRecordSchema,
  steps: z.array(ingestJobStepRecordSchema),
});

export const runtimeJobsGetCommand = {
  name: "runtime.jobs.get" as const,
  payloadSchema: runtimeJobsGetPayloadSchema,
  resultSchema: runtimeJobsGetResultSchema,
} as const;

export const runtimeJobsCancelPayloadSchema = z.object({
  jobId: z.string().min(1),
  reason: z.string().optional(),
});

export const runtimeJobsCancelResultSchema = z.object({
  cancelled: z.boolean(),
});

export const runtimeJobsCancelCommand = {
  name: "runtime.jobs.cancel" as const,
  payloadSchema: runtimeJobsCancelPayloadSchema,
  resultSchema: runtimeJobsCancelResultSchema,
} as const;

export const runtimeJobsDismissPayloadSchema = z.object({
  jobId: z.string().min(1),
});

export const runtimeJobsDismissResultSchema = z.union([
  z.object({ dismissed: z.literal(true) }),
  z.object({
    dismissed: z.literal(false),
    errorCode: z.literal("not-terminal"),
  }),
]);

export const runtimeJobsDismissCommand = {
  name: "runtime.jobs.dismiss" as const,
  payloadSchema: runtimeJobsDismissPayloadSchema,
  resultSchema: runtimeJobsDismissResultSchema,
} as const;

export const runtimeJobsRetryPayloadSchema = z.object({
  jobId: z.string().min(1),
});

export const runtimeJobsRetryResultSchema = z.object({
  retried: z.boolean(),
  newJobId: z.string().min(1).optional(),
});

export const runtimeJobsRetryCommand = {
  name: "runtime.jobs.retry" as const,
  payloadSchema: runtimeJobsRetryPayloadSchema,
  resultSchema: runtimeJobsRetryResultSchema,
} as const;

/**
 * `runtime.jobs.cancel_by_group` — cancel + dismiss every job whose
 * `groupId` matches. Used by the desktop "delete media" flow to release
 * the runtime side of a media item: non-terminal jobs are cancelled (with
 * cascade), terminal jobs are dismissed so they don't block dedupe and
 * don't appear in subsequent UI lists. (effervescent-teapot Round 3.)
 */
export const runtimeJobsCancelByGroupPayloadSchema = z.object({
  groupId: z.string().min(1),
  reason: z.string().optional(),
});

export const runtimeJobsCancelByGroupResultSchema = z.object({
  cancelled: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
});

export const runtimeJobsCancelByGroupCommand = {
  name: "runtime.jobs.cancel_by_group" as const,
  payloadSchema: runtimeJobsCancelByGroupPayloadSchema,
  resultSchema: runtimeJobsCancelByGroupResultSchema,
} as const;

// ---------------------------------------------------------------------------
// WebSocket subscription handshake (§5 replay buffer)
// ---------------------------------------------------------------------------

export const runtimeJobsSubscribeHandshakeRequestSchema = z.object({
  lastEventId: z.number().int().nonnegative().optional(),
});

export const runtimeJobsSubscribeHandshakeResponseSchema = z.object({
  replayed: z.boolean(),
  replayOverflow: z.boolean().optional(),
  maxEventId: z.number().int().nonnegative(),
});

export const runtimeJobsSubscribeHandshakeSchema = {
  requestSchema: runtimeJobsSubscribeHandshakeRequestSchema,
  responseSchema: runtimeJobsSubscribeHandshakeResponseSchema,
} as const;

export type RuntimeJobsSubscribeHandshakeRequest = z.infer<
  typeof runtimeJobsSubscribeHandshakeRequestSchema
>;
export type RuntimeJobsSubscribeHandshakeResponse = z.infer<
  typeof runtimeJobsSubscribeHandshakeResponseSchema
>;
