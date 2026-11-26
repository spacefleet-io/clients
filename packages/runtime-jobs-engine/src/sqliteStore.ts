/**
 * SQLite-backed implementation of the durable runtime jobs store.
 *
 * Phase B scaffolding: this file is additive and is NOT yet wired into the
 * runtime. The legacy JSON-backed `RuntimeJobsStore` (./store.ts) remains the
 * source of truth until the cutover later in Phase B.
 *
 * Built against `bun:sqlite` (already a runtime dep) but only relies on the
 * structural surface that better-sqlite3 satisfies — see `StepStoreDb` in
 * `./stepStore.ts` for the same shape. JSON columns are decoded/encoded at
 * the boundary so callers see plain `IngestJobRecord` objects.
 */

import { createRequire } from "node:module";
import {
  abandonPreparedOffLoopWal,
  enableOffLoopWal,
  prepareOffLoopWal,
  registerOffLoopWal,
  releaseOffLoopWal,
  type SqliteDriverModule,
} from "@space/library-db-runtime/walCheckpointer";
import {
  runRuntimeJobsDbMigrations,
  type SqliteDb as MigrationDb,
} from "@space/runtime-jobs-db";
import {
  isTerminalIngestJobStatus,
  type IngestJobKind,
  type IngestJobLane,
  type IngestJobRecord,
  type IngestJobStatus,
} from "@space/runtime-jobs";
import type { SpaceAppId } from "@space/shared/appScope";
import { createStepStore, type StepStore, type StepStoreDb } from "./stepStore";
import { scrubPersistedJobSecrets } from "./secretScrub";

// Lazy driver resolution: prefer node:sqlite (Node 22+), fall back to
// bun:sqlite when running under Bun. Mirrors apps/runtime/src/modules/
// sqliteCompat.ts so test runners that resolve modules via the node algorithm
// (e.g. vitest under bunx) don't choke on the literal `bun:sqlite` import.
type SqliteStatement = {
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
};

type SqliteDatabase = {
  exec: (sql: string) => unknown;
  close: () => void;
  prepare: (sql: string) => SqliteStatement;
};

const requireNative = createRequire(import.meta.url);

type SqliteDriver = { driver: SqliteDriverModule; open: (path: string) => SqliteDatabase };

/**
 * Pick the first available SQLite driver. Preference order:
 *  1. `node:sqlite` (Node 22+, available in vitest under bun)
 *  2. `bun:sqlite` (production runtime under Bun)
 * Mirrors apps/runtime/src/modules/sqliteCompat.ts so test runners that
 * resolve via the node algorithm don't choke on `bun:sqlite`. Names the
 * driver too: the off-loop checkpointer must open the file with the same one.
 */
const resolveDriver = (): SqliteDriver => {
  try {
    const nodeSqlite = requireNative("node:sqlite") as {
      DatabaseSync?: new (p: string, opts?: Record<string, unknown>) => SqliteDatabase;
    };
    const DatabaseSync = nodeSqlite.DatabaseSync;
    if (DatabaseSync) {
      return { driver: "node:sqlite", open: (path) => new DatabaseSync(path) };
    }
  } catch {
    // fall through to bun:sqlite
  }
  const bunSqlite = requireNative("bun:sqlite") as {
    Database: new (p: string) => SqliteDatabase;
  };
  return { driver: "bun:sqlite", open: (path) => new bunSqlite.Database(path) };
};

const RUNTIME_JOBS_WAL_LABEL = "runtime-jobs";

/**
 * #25 P10: call (and await) before {@link createSqliteRuntimeJobsStore} for a
 * file-backed store: the checkpoint worker creates the file, switches it to
 * WAL and writes its first WAL frame, so those fsyncs (DB, journal,
 * runtime-data dir, WAL header) stay off the event loop. Optional: without it
 * the store still works and its checkpoints still move to the worker, but
 * opening a new file syncs on the loop.
 */
export const prepareSqliteRuntimeJobsStore = async (dbPath: string): Promise<void> => {
  await prepareOffLoopWal(dbPath, { driver: resolveDriver().driver, label: RUNTIME_JOBS_WAL_LABEL });
};

/** Call when {@link createSqliteRuntimeJobsStore} threw after a prepare: the worker lets the file go. */
export const abandonPreparedSqliteRuntimeJobsStore = (dbPath: string): void => {
  abandonPreparedOffLoopWal(dbPath);
};

type JobRow = {
  job_id: string;
  app: string;
  owner_id: string;
  group_id: string;
  media_id: string;
  kind: string;
  variant: string | null;
  status: string;
  lane: string;
  priority: number;
  parent_job_ids: string;
  stage_code: string;
  stage_label: string;
  progress_pct: number;
  upload_speed_bytes_per_sec: number | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  cancel_requested: number;
  dedupe_key: string | null;
  payload_json: string;
  outputs_json: string;
  started_at: string | null;
  finished_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SqliteJobFilter = {
  app?: SpaceAppId;
  ownerId?: string;
  groupId?: string;
  mediaId?: string;
  status?: IngestJobStatus[];
  kind?: IngestJobKind[];
  lane?: IngestJobLane[];
  /** When false (default), rows with `dismissed_at IS NOT NULL` are excluded. */
  includeDismissed?: boolean;
  limit?: number;
};

export type UpdateStatusOpts = {
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  progressPct?: number;
  stageCode?: string;
  stageLabel?: string;
  outputs?: Record<string, unknown>;
};

export type SqliteRuntimeJobsStore = {
  /** Underlying DB; exposed so callers can wire the step store / event log. */
  readonly db: SqliteDatabase;
  readonly steps: StepStore;
  upsertJob(record: IngestJobRecord): IngestJobRecord;
  getJob(jobId: string): IngestJobRecord | null;
  /**
   * Look up an existing row by `(app, dedupe_key)`. Returns null when no
   * dedupe key matches, or when `dedupeKey` is null (the unique index
   * intentionally ignores null keys, so callers must not look up null).
   *
   * Filters out stale rows: dismissed, failed, and cancelled jobs are not
   * returned here. A succeeded-but-not-dismissed job still returns (this
   * preserves the accidental-double-click idempotency from Symptom A). The
   * delete-media flow's `cancel_by_group` cascade marks old jobs cancelled
   * and dismissed, which in turn lets a re-add ingest produce a fresh job.
   * (effervescent-teapot Round 3 — "delete + re-add same file".)
   */
  getJobByDedupe(app: string, dedupeKey: string): IngestJobRecord | null;
  listJobs(filter?: SqliteJobFilter): IngestJobRecord[];
  updateJobStatus(
    jobId: string,
    status: IngestJobStatus,
    opts?: UpdateStatusOpts
  ): IngestJobRecord | null;
  setCancelRequested(jobId: string, value: boolean): IngestJobRecord | null;
  /**
   * Transactional read-modify-write of `payload_json`. Shallow merges the
   * `patch` over the existing payload object. Used by `attach_metadata` so
   * the identify/commit steps can pick up updated catalog hints without losing
   * fields placed there at submit time.
   */
  updateJobPayload(
    jobId: string,
    patch: Record<string, unknown>
  ): IngestJobRecord | null;
  /** Jobs whose `parent_job_ids` JSON includes `jobId`. */
  findChildren(jobId: string): IngestJobRecord[];
  dismissJob(jobId: string, dismissedAt: string): IngestJobRecord | null;
  /**
   * Delete finished jobs (succeeded / failed / cancelled) whose `finished_at`
   * (else `updated_at`) is older than the cutoff, at most `limit` rows. Their
   * steps go with them (FK cascade). A finished job that a live job still
   * lists as parent is kept. Returns the deletion count.
   */
  purgeFinishedBefore(beforeIso: string, limit: number): number;
  close(): void;
};

const rowToRecord = (row: JobRow): IngestJobRecord => {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const outputs = JSON.parse(row.outputs_json) as Record<string, unknown>;
  const parentJobIds = JSON.parse(row.parent_job_ids) as string[];
  return {
    jobId: row.job_id,
    app: row.app as SpaceAppId,
    kind: row.kind as IngestJobKind,
    lane: row.lane as IngestJobLane,
    status: row.status as IngestJobStatus,
    stageCode: row.stage_code,
    stageLabel: row.stage_label,
    progress: {
      mode: "fraction",
      completed: row.progress_pct,
      total: 100,
      unit: "percent",
    },
    progressPct: row.progress_pct,
    payload,
    outputs,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: false,
    cancelRequested: row.cancel_requested === 1,
    priority: row.priority,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    groupId: row.group_id,
    mediaId: row.media_id,
    variant: row.variant,
    parentJobIds,
    dismissedAt: row.dismissed_at,
    uploadSpeedBytesPerSec: row.upload_speed_bytes_per_sec,
    attemptCount: row.attempts,
  };
};

const wrap = (raw: SqliteDatabase): StepStoreDb & MigrationDb => ({
  exec: (sql: string) => {
    raw.exec(sql);
  },
  prepare: (sql: string) => {
    const stmt = raw.prepare(sql);
    return {
      all: (...params: unknown[]) =>
        (stmt.all as (...args: unknown[]) => unknown[])(...params),
      run: (...params: unknown[]) =>
        (stmt.run as (...args: unknown[]) => unknown)(...params),
      get: (...params: unknown[]) =>
        (stmt.get as (...args: unknown[]) => unknown)(...params),
    };
  },
});

/**
 * Create (and migrate) a SQLite-backed runtime jobs store at `dbPath`.
 * Pass `:memory:` for tests. The factory pattern keeps callers in charge of
 * lifecycle (no module-load instantiation).
 */
export function createSqliteRuntimeJobsStore(dbPath: string): SqliteRuntimeJobsStore {
  const { driver, open } = resolveDriver();
  const raw = open(dbPath);
  // #25 P1: bun:sqlite commits on the event loop. With the default
  // synchronous=FULL every job/progress commit fsynced the WAL, and on a busy
  // disk one fsync takes seconds — the runtime stopped answering health and
  // the guardian killed it. #25 P10: WAL + NORMAL still fsynced on the event
  // loop (WAL header + runtime-data dir on each new WAL generation,
  // autocheckpoints), so the file is set up by a worker thread
  // ({@link prepareSqliteRuntimeJobsStore}) and, once migrated, its
  // checkpoints run there too (walCheckpointer.ts). NORMAL stays: consistent
  // after a crash or power loss (only the newest commits may roll back).
  enableOffLoopWal(raw, { path: dbPath, driver, label: RUNTIME_JOBS_WAL_LABEL });
  raw.exec("PRAGMA foreign_keys=ON;");
  const wrapped = wrap(raw);
  runRuntimeJobsDbMigrations(wrapped);
  // RT-SEC-05: rows written by older builds carry the library key / backend token in their payload.
  scrubPersistedJobSecrets(raw);
  registerOffLoopWal(raw, { path: dbPath, driver, label: RUNTIME_JOBS_WAL_LABEL });
  const steps = createStepStore(wrapped);

  const upsertSql = `
    INSERT INTO runtime_jobs (
      job_id, app, owner_id, group_id, media_id, kind, variant, status, lane,
      priority, parent_job_ids, stage_code, stage_label, progress_pct,
      upload_speed_bytes_per_sec, error_code, error_message, attempts,
      cancel_requested, dedupe_key, payload_json, outputs_json,
      started_at, finished_at, dismissed_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET
      app=excluded.app,
      owner_id=excluded.owner_id,
      group_id=excluded.group_id,
      media_id=excluded.media_id,
      kind=excluded.kind,
      variant=excluded.variant,
      status=excluded.status,
      lane=excluded.lane,
      priority=excluded.priority,
      parent_job_ids=excluded.parent_job_ids,
      stage_code=excluded.stage_code,
      stage_label=excluded.stage_label,
      progress_pct=excluded.progress_pct,
      upload_speed_bytes_per_sec=excluded.upload_speed_bytes_per_sec,
      error_code=excluded.error_code,
      error_message=excluded.error_message,
      attempts=excluded.attempts,
      cancel_requested=excluded.cancel_requested,
      dedupe_key=excluded.dedupe_key,
      payload_json=excluded.payload_json,
      outputs_json=excluded.outputs_json,
      started_at=excluded.started_at,
      finished_at=excluded.finished_at,
      dismissed_at=excluded.dismissed_at,
      updated_at=excluded.updated_at;
  `;

  const getJobByDedupe = (
    app: string,
    dedupeKey: string
  ): IngestJobRecord | null => {
    // Dedupe blocks ONLY active duplicates (queued / running). Once a job
    // reaches any terminal state (succeeded / failed / cancelled /
    // interrupted), the slot is freed for a fresh submit because the user
    // has expressed clear new intent by re-submitting. The Day 0 commit
    // 1b434fa6 mistakenly kept `succeeded`-without-`dismissed_at` as a
    // dedupe blocker; that caused re-drag of a previously-completed source
    // to silently return the stale jobId without creating any new row. The
    // fix narrows the predicate to active statuses only.
    const row = raw
      .prepare(
        `SELECT * FROM runtime_jobs
         WHERE app = ?
           AND dedupe_key = ?
           AND dismissed_at IS NULL
           AND status IN ('queued', 'running')
         LIMIT 1;`
      )
      .get(app, dedupeKey) as JobRow | undefined;
    return row ? rowToRecord(row) : null;
  };

  const upsertJob = (record: IngestJobRecord): IngestJobRecord => {
    // Dedupe short-circuit: if a row already exists with the same
    // (app, dedupe_key) and a different job_id, treat the upsert as a no-op
    // and return the existing record. The schema's
    // `runtime_jobs_app_dedupe_unique_idx` enforces this at the DB level —
    // we check first to give callers the existing row instead of a thrown
    // SQLITE_CONSTRAINT. Defense-in-depth for ingest dedupe (effervescent-teapot).
    if (record.dedupeKey) {
      const existing = getJobByDedupe(record.app, record.dedupeKey);
      if (existing && existing.jobId !== record.jobId) {
        return existing;
      }
      // No live dedupe row, but a stale one (dismissed / failed / cancelled)
      // may still hold the (app, dedupe_key) unique slot. Free it by nulling
      // the stale row's dedupe_key so the insert below doesn't trip
      // `runtime_jobs_app_dedupe_unique_idx`. (effervescent-teapot Round 3.)
      if (!existing) {
        raw
          .prepare(
            `UPDATE runtime_jobs
             SET dedupe_key = NULL
             WHERE app = ? AND dedupe_key = ? AND job_id != ?;`
          )
          .run(record.app, record.dedupeKey, record.jobId);
      }
    }
    // Owner id is not on the IngestJobRecord type; fall back to a stable
    // sentinel. Real consumers (Phase D) will wire owner via payload.userId.
    const ownerId =
      (record.payload?.userId as string | undefined) ??
      (record.payload?.ownerId as string | undefined) ??
      "unknown";
    // Use explicit BEGIN/COMMIT to stay portable across bun:sqlite (which
    // exposes `transaction(...)`) and node:sqlite (which does not).
    raw.exec("BEGIN");
    try {
      raw.prepare(upsertSql).run(
        record.jobId,
        record.app,
        ownerId,
        record.groupId,
        record.mediaId,
        record.kind,
        record.variant,
        record.status,
        record.lane,
        record.priority,
        JSON.stringify(record.parentJobIds ?? []),
        record.stageCode,
        record.stageLabel,
        record.progressPct,
        record.uploadSpeedBytesPerSec,
        record.errorCode,
        record.errorMessage,
        record.attemptCount ?? 0,
        record.cancelRequested ? 1 : 0,
        record.dedupeKey,
        JSON.stringify(record.payload ?? {}),
        JSON.stringify(record.outputs ?? {}),
        record.startedAt,
        record.finishedAt,
        record.dismissedAt,
        record.createdAt,
        record.updatedAt
      );
      raw.exec("COMMIT");
    } catch (err) {
      raw.exec("ROLLBACK");
      throw err;
    }
    return record;
  };

  const getJob = (jobId: string): IngestJobRecord | null => {
    const row = raw
      .prepare(`SELECT * FROM runtime_jobs WHERE job_id = ? LIMIT 1;`)
      .get(jobId) as JobRow | undefined;
    return row ? rowToRecord(row) : null;
  };

  const listJobs = (filter: SqliteJobFilter = {}): IngestJobRecord[] => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.app) {
      where.push("app = ?");
      params.push(filter.app);
    }
    if (filter.ownerId) {
      where.push("owner_id = ?");
      params.push(filter.ownerId);
    }
    if (filter.groupId) {
      where.push("group_id = ?");
      params.push(filter.groupId);
    }
    if (filter.mediaId) {
      where.push("media_id = ?");
      params.push(filter.mediaId);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      params.push(...filter.status);
    }
    if (filter.kind?.length) {
      where.push(`kind IN (${filter.kind.map(() => "?").join(",")})`);
      params.push(...filter.kind);
    }
    if (filter.lane?.length) {
      where.push(`lane IN (${filter.lane.map(() => "?").join(",")})`);
      params.push(...filter.lane);
    }
    if (!filter.includeDismissed) {
      where.push("dismissed_at IS NULL");
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limitSql = filter.limit ? `LIMIT ${Math.max(0, filter.limit | 0)}` : "";
    const sql = `SELECT * FROM runtime_jobs ${whereSql} ORDER BY priority ASC, created_at ASC ${limitSql};`;
    const rows = raw.prepare(sql).all(...params) as JobRow[];
    return rows.map(rowToRecord);
  };

  const updateJobStatus = (
    jobId: string,
    status: IngestJobStatus,
    opts: UpdateStatusOpts = {}
  ): IngestJobRecord | null => {
    const existing = getJob(jobId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const finishedAt =
      opts.finishedAt !== undefined
        ? opts.finishedAt
        : isTerminalIngestJobStatus(status)
          ? now
          : existing.finishedAt;
    const startedAt =
      opts.startedAt !== undefined
        ? opts.startedAt
        : status === "running" && !existing.startedAt
          ? now
          : existing.startedAt;
    const next: IngestJobRecord = {
      ...existing,
      status,
      stageCode: opts.stageCode ?? existing.stageCode,
      stageLabel: opts.stageLabel ?? existing.stageLabel,
      progressPct: opts.progressPct ?? existing.progressPct,
      progress: {
        mode: "fraction",
        completed: opts.progressPct ?? existing.progressPct,
        total: 100,
        unit: "percent",
      },
      errorCode: opts.errorCode !== undefined ? opts.errorCode : existing.errorCode,
      errorMessage:
        opts.errorMessage !== undefined ? opts.errorMessage : existing.errorMessage,
      outputs: opts.outputs ?? existing.outputs,
      startedAt,
      finishedAt,
      updatedAt: now,
    };
    upsertJob(next);
    return next;
  };

  const setCancelRequested = (jobId: string, value: boolean): IngestJobRecord | null => {
    const existing = getJob(jobId);
    if (!existing) return null;
    const next: IngestJobRecord = {
      ...existing,
      cancelRequested: value,
      updatedAt: new Date().toISOString(),
    };
    upsertJob(next);
    return next;
  };

  /**
   * SQLite has no native JSON-array containment operator that works portably
   * across drivers; we read candidate rows (any non-empty parentJobIds) and
   * filter in-process. Volume is bounded by group size (typically 2..6 jobs
   * per media-item) so this is fine for Phase B.
   */
  const findChildren = (jobId: string): IngestJobRecord[] => {
    const rows = raw
      .prepare(
        `SELECT * FROM runtime_jobs WHERE parent_job_ids IS NOT NULL AND parent_job_ids != '[]';`
      )
      .all() as JobRow[];
    return rows
      .map(rowToRecord)
      .filter((job) => job.parentJobIds.includes(jobId));
  };

  const updateJobPayload = (
    jobId: string,
    patch: Record<string, unknown>
  ): IngestJobRecord | null => {
    raw.exec("BEGIN");
    try {
      const row = raw
        .prepare(`SELECT payload_json FROM runtime_jobs WHERE job_id = ? LIMIT 1;`)
        .get(jobId) as { payload_json: string } | undefined;
      if (!row) {
        raw.exec("COMMIT");
        return null;
      }
      const current = JSON.parse(row.payload_json) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(patch)) {
        const existingV = current[k];
        if (
          existingV &&
          typeof existingV === "object" &&
          !Array.isArray(existingV) &&
          v &&
          typeof v === "object" &&
          !Array.isArray(v)
        ) {
          merged[k] = {
            ...(existingV as Record<string, unknown>),
            ...(v as Record<string, unknown>),
          };
        } else {
          merged[k] = v;
        }
      }
      const now = new Date().toISOString();
      raw
        .prepare(
          `UPDATE runtime_jobs SET payload_json = ?, updated_at = ? WHERE job_id = ?;`
        )
        .run(JSON.stringify(merged), now, jobId);
      raw.exec("COMMIT");
    } catch (err) {
      raw.exec("ROLLBACK");
      throw err;
    }
    return getJob(jobId);
  };

  const dismissJob = (jobId: string, dismissedAt: string): IngestJobRecord | null => {
    const existing = getJob(jobId);
    if (!existing) return null;
    const next: IngestJobRecord = {
      ...existing,
      dismissedAt,
      updatedAt: new Date().toISOString(),
    };
    upsertJob(next);
    return next;
  };

  const purgeFinishedBefore = (beforeIso: string, limit: number): number => {
    // The live parents are collected once (json_each over the few live rows) and
    // matched exactly; a per-candidate substring scan of the table was ~1 s per batch.
    const result = raw
      .prepare(
        `DELETE FROM runtime_jobs WHERE job_id IN (
           SELECT j.job_id FROM runtime_jobs j
           WHERE j.status IN ('succeeded', 'failed', 'cancelled')
             AND COALESCE(j.finished_at, j.updated_at) < ?
             AND j.job_id NOT IN (
               SELECT p.value FROM runtime_jobs c, json_each(c.parent_job_ids) p
               WHERE c.status NOT IN ('succeeded', 'failed', 'cancelled')
             )
           LIMIT ?
         );`
      )
      .run(beforeIso, limit) as { changes?: number };
    return result?.changes ?? 0;
  };

  return {
    db: raw,
    steps,
    upsertJob,
    getJob,
    getJobByDedupe,
    listJobs,
    updateJobStatus,
    setCancelRequested,
    updateJobPayload,
    findChildren,
    dismissJob,
    purgeFinishedBefore,
    close: () => {
      releaseOffLoopWal(raw);
      raw.close();
    },
  };
}
