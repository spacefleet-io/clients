import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Per-job durable record. One row per IngestJob (source or format).
 * `parent_job_ids` is a JSON-encoded TEXT array of job_ids this job depends on.
 * `payload_json` and `outputs_json` are opaque JSON blobs owned by the
 * kind-specific handler.
 */
export const runtimeJobs = sqliteTable(
  "runtime_jobs",
  {
    jobId: text("job_id").primaryKey(),
    app: text("app").notNull(),
    ownerId: text("owner_id").notNull(),
    groupId: text("group_id").notNull(),
    mediaId: text("media_id").notNull(),
    kind: text("kind").notNull(),
    variant: text("variant"),
    status: text("status").notNull(),
    lane: text("lane").notNull(),
    priority: integer("priority").notNull(),
    parentJobIds: text("parent_job_ids").notNull().default("[]"),
    stageCode: text("stage_code").notNull().default(""),
    stageLabel: text("stage_label").notNull().default(""),
    progressPct: integer("progress_pct").notNull().default(0),
    uploadSpeedBytesPerSec: integer("upload_speed_bytes_per_sec"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    attempts: integer("attempts").notNull().default(0),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    dedupeKey: text("dedupe_key"),
    payloadJson: text("payload_json").notNull().default("{}"),
    outputsJson: text("outputs_json").notNull().default("{}"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    dismissedAt: text("dismissed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    appGroupIdx: index("runtime_jobs_app_group_idx").on(table.app, table.groupId),
    statusIdx: index("runtime_jobs_status_idx").on(table.status),
    laneStatusIdx: index("runtime_jobs_lane_status_idx").on(table.lane, table.status),
    appDedupeUnique: uniqueIndex("runtime_jobs_app_dedupe_unique_idx")
      .on(table.app, table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
  })
);

/**
 * Sub-step records owned by a parent job. Steps are the unit of resumable work
 * inside one job (probe, extract, encode, upload, commit, ...).
 * `depends_on_json` is a JSON-encoded TEXT array of step_ids inside the same job.
 */
export const runtimeJobSteps = sqliteTable(
  "runtime_job_steps",
  {
    stepId: text("step_id").primaryKey(),
    parentJobId: text("parent_job_id").notNull(),
    app: text("app").notNull(),
    kind: text("kind").notNull(),
    ordinal: integer("ordinal").notNull(),
    status: text("status").notNull(),
    lane: text("lane").notNull(),
    progressPct: integer("progress_pct").notNull().default(0),
    dependsOnJson: text("depends_on_json").notNull().default("[]"),
    payloadJson: text("payload_json").notNull().default("{}"),
    outputsJson: text("outputs_json").notNull().default("{}"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    parentOrdinalIdx: index("runtime_job_steps_parent_ordinal_idx").on(
      table.parentJobId,
      table.ordinal
    ),
    statusIdx: index("runtime_job_steps_status_idx").on(table.status),
  })
);

/**
 * Append-only event log used as the WebSocket replay buffer. `event_id` is an
 * autoincrementing integer that the runtime exposes monotonically; the client
 * acks the highest seen id and the server replays everything strictly after it.
 */
export const runtimeJobEvents = sqliteTable(
  "runtime_job_events",
  {
    eventId: integer("event_id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id").notNull(),
    stepId: text("step_id"),
    channel: text("channel").notNull().default("runtime.jobs"),
    event: text("event").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    jobEventIdx: index("runtime_job_events_job_event_idx").on(table.jobId, table.eventId),
    createdAtIdx: index("runtime_job_events_created_at_idx").on(table.createdAt),
  })
);

export type RuntimeJobRow = typeof runtimeJobs.$inferSelect;
export type RuntimeJobInsert = typeof runtimeJobs.$inferInsert;
export type RuntimeJobStepRow = typeof runtimeJobSteps.$inferSelect;
export type RuntimeJobStepInsert = typeof runtimeJobSteps.$inferInsert;
export type RuntimeJobEventRow = typeof runtimeJobEvents.$inferSelect;
export type RuntimeJobEventInsert = typeof runtimeJobEvents.$inferInsert;
