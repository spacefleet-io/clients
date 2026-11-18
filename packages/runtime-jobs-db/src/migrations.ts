/**
 * Idempotent in-code migrations for the runtime jobs SQLite database.
 *
 * Mirrors the pattern used by `@space/library-db-definition`: a tiny structural
 * `SqliteDb` interface so this package stays free of native dependencies.
 * Callers (e.g. `apps/runtime`) supply their own better-sqlite3 / bun:sqlite
 * connection — this package only emits SQL.
 */

export type SqliteDb = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    all: () => unknown[];
    run: (...params: unknown[]) => unknown;
  };
};

const createRuntimeJobsTable = (db: SqliteDb) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_jobs (
      job_id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      variant TEXT,
      status TEXT NOT NULL,
      lane TEXT NOT NULL,
      priority INTEGER NOT NULL,
      parent_job_ids TEXT NOT NULL DEFAULT '[]',
      stage_code TEXT NOT NULL DEFAULT '',
      stage_label TEXT NOT NULL DEFAULT '',
      progress_pct INTEGER NOT NULL DEFAULT 0,
      upload_speed_bytes_per_sec INTEGER,
      error_code TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      outputs_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      finished_at TEXT,
      dismissed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS runtime_jobs_app_group_idx ON runtime_jobs(app, group_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS runtime_jobs_status_idx ON runtime_jobs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS runtime_jobs_lane_status_idx ON runtime_jobs(lane, status);`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS runtime_jobs_app_dedupe_unique_idx ON runtime_jobs(app, dedupe_key) WHERE dedupe_key IS NOT NULL;`
  );
};

const createRuntimeJobStepsTable = (db: SqliteDb) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_job_steps (
      step_id TEXT PRIMARY KEY,
      parent_job_id TEXT NOT NULL,
      app TEXT NOT NULL,
      kind TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      lane TEXT NOT NULL,
      progress_pct INTEGER NOT NULL DEFAULT 0,
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      outputs_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(parent_job_id) REFERENCES runtime_jobs(job_id) ON DELETE CASCADE
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS runtime_job_steps_parent_ordinal_idx ON runtime_job_steps(parent_job_id, ordinal);`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS runtime_job_steps_status_idx ON runtime_job_steps(status);`);
};

const createRuntimeJobEventsTable = (db: SqliteDb) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      step_id TEXT,
      channel TEXT NOT NULL DEFAULT 'runtime.jobs',
      event TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS runtime_job_events_job_event_idx ON runtime_job_events(job_id, event_id);`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS runtime_job_events_created_at_idx ON runtime_job_events(created_at);`
  );
};

/**
 * Runs all idempotent migrations for the runtime jobs database.
 * Safe to call on every runtime boot.
 */
export const runRuntimeJobsDbMigrations = (db: SqliteDb): void => {
  // Foreign keys must be enabled per-connection by the caller; we still emit
  // FK declarations so that consumers who turn them on get cascade behaviour.
  createRuntimeJobsTable(db);
  createRuntimeJobStepsTable(db);
  createRuntimeJobEventsTable(db);
};
