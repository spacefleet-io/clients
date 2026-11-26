/**
 * Step-level CRUD against the `runtime_job_steps` table introduced in
 * `@space/runtime-jobs-db`. Steps are the unit of resumable work inside one
 * job (e.g. probe → identify → extract → upload → commit for source).
 *
 * `dependsOnJson` is a JSON array of step ids inside the same parent job. A
 * step is runnable when every parent in that array is `'succeeded'`.
 *
 * This module is bun:sqlite-flavoured but only relies on the structural
 * surface that better-sqlite3 also satisfies (`prepare(...).all/run`), so it
 * remains portable across the two drivers.
 */

import type { IngestJobStatus, IngestJobStepRecord } from "@space/runtime-jobs";

type Statement = {
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => unknown;
  get?: (...params: unknown[]) => unknown;
};

export type StepStoreDb = {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => unknown;
  transaction?: <T>(fn: () => T) => () => T;
};

type StepRow = {
  step_id: string;
  parent_job_id: string;
  app: string;
  kind: string;
  ordinal: number;
  status: string;
  lane: string;
  progress_pct: number;
  depends_on_json: string;
  payload_json: string;
  outputs_json: string;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Step record used at the storage boundary. Carries the raw `dependsOn`
 * array (decoded JSON) and the `lane` + `app` + `payload`/`outputs` fields
 * the schema requires but the runtime-jobs `IngestJobStepRecord` does not
 * yet expose.
 */
export type StoredStepRecord = IngestJobStepRecord & {
  app: string;
  lane: string;
  dependsOn: string[];
  payload: Record<string, unknown>;
  outputs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type StepStore = {
  upsertStep(step: StoredStepRecord): StoredStepRecord;
  getSteps(jobId: string): StoredStepRecord[];
  updateStepStatus(
    stepId: string,
    status: IngestJobStatus,
    opts?: {
      progressPct?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      outputs?: Record<string, unknown>;
    }
  ): StoredStepRecord | null;
  /**
   * Steps that are still `queued` and whose every dependency is `succeeded`.
   * Pure dependency-satisfaction logic; does not consult lane caps.
   */
  findRunnableSteps(jobId: string): StoredStepRecord[];
};

const rowToRecord = (row: StepRow): StoredStepRecord => ({
  stepId: row.step_id,
  jobId: row.parent_job_id,
  ordinal: row.ordinal,
  kind: row.kind,
  status: row.status as IngestJobStatus,
  progressPct: row.progress_pct,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  app: row.app,
  lane: row.lane,
  dependsOn: JSON.parse(row.depends_on_json) as string[],
  payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  outputs: JSON.parse(row.outputs_json) as Record<string, unknown>,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createStepStore(db: StepStoreDb): StepStore {
  const upsertSql = `
    INSERT INTO runtime_job_steps (
      step_id, parent_job_id, app, kind, ordinal, status, lane,
      progress_pct, depends_on_json, payload_json, outputs_json,
      error_code, error_message, started_at, finished_at,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(step_id) DO UPDATE SET
      parent_job_id=excluded.parent_job_id,
      app=excluded.app,
      kind=excluded.kind,
      ordinal=excluded.ordinal,
      status=excluded.status,
      lane=excluded.lane,
      progress_pct=excluded.progress_pct,
      depends_on_json=excluded.depends_on_json,
      payload_json=excluded.payload_json,
      outputs_json=excluded.outputs_json,
      error_code=excluded.error_code,
      error_message=excluded.error_message,
      started_at=excluded.started_at,
      finished_at=excluded.finished_at,
      updated_at=excluded.updated_at;
  `;

  return {
    upsertStep(step) {
      db.prepare(upsertSql).run(
        step.stepId,
        step.jobId,
        step.app,
        step.kind,
        step.ordinal,
        step.status,
        step.lane,
        step.progressPct,
        JSON.stringify(step.dependsOn ?? []),
        JSON.stringify(step.payload ?? {}),
        JSON.stringify(step.outputs ?? {}),
        step.errorCode,
        step.errorMessage,
        step.startedAt,
        step.finishedAt,
        step.createdAt,
        step.updatedAt
      );
      return step;
    },

    getSteps(jobId) {
      const rows = db
        .prepare(
          `SELECT * FROM runtime_job_steps WHERE parent_job_id = ? ORDER BY ordinal ASC, step_id ASC;`
        )
        .all(jobId) as StepRow[];
      return rows.map(rowToRecord);
    },

    updateStepStatus(stepId, status, opts) {
      const existing = db
        .prepare(`SELECT * FROM runtime_job_steps WHERE step_id = ? LIMIT 1;`)
        .all(stepId) as StepRow[];
      if (existing.length === 0) return null;
      const row = existing[0];
      const now = new Date().toISOString();
      const next: StoredStepRecord = {
        ...rowToRecord(row),
        status,
        progressPct: opts?.progressPct ?? row.progress_pct,
        errorCode: opts?.errorCode ?? row.error_code,
        errorMessage: opts?.errorMessage ?? row.error_message,
        startedAt: opts?.startedAt ?? row.started_at,
        finishedAt: opts?.finishedAt ?? row.finished_at,
        outputs: opts?.outputs ?? (JSON.parse(row.outputs_json) as Record<string, unknown>),
        updatedAt: now,
      };
      db.prepare(
        `UPDATE runtime_job_steps
         SET status = ?, progress_pct = ?, error_code = ?, error_message = ?,
             started_at = ?, finished_at = ?, outputs_json = ?, updated_at = ?
         WHERE step_id = ?;`
      ).run(
        next.status,
        next.progressPct,
        next.errorCode,
        next.errorMessage,
        next.startedAt,
        next.finishedAt,
        JSON.stringify(next.outputs ?? {}),
        next.updatedAt,
        stepId
      );
      return next;
    },

    /**
     * A step is runnable iff:
     *   - status === 'queued'
     *   - every id in dependsOn maps to a sibling step whose status === 'succeeded'
     * Steps with empty dependsOn are runnable as soon as they are queued.
     */
    findRunnableSteps(jobId) {
      const all = this.getSteps(jobId);
      const byId = new Map(all.map((s) => [s.stepId, s]));
      return all.filter((step) => {
        if (step.status !== "queued") return false;
        for (const dep of step.dependsOn) {
          const parent = byId.get(dep);
          if (!parent || parent.status !== "succeeded") return false;
        }
        return true;
      });
    },
  };
}
