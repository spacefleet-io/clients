/**
 * RT-SEC-05: the runtime holds the library key and the backend token in memory
 * only. Earlier builds put both into the offline-download job payload, which
 * the jobs engine persists in `runtime_jobs.db` (the job row, its seeded step
 * rows and the `runtime.jobs.created` event row that embeds the whole job).
 * This scrub removes those two fields from every such row at startup.
 *
 * A job that was still queued or running keeps its row: the step now takes the
 * credentials from memory and waits for the desktop's push (see
 * `awaitCredentials`), so it resumes without them.
 */

/** Payload fields that must never be persisted. */
export const PERSISTED_PAYLOAD_SECRET_FIELDS = ["libraryKeyBase64", "token"] as const;

type ScrubDb = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
};

export type SecretScrubResult = { jobs: number; steps: number; events: number };


type JobPayload = Record<string, unknown>;
/** Event rows embed the whole job: `{ job: { payload } }`. */
type JobEventBody = { job?: { payload?: JobPayload | null } | null };

/** Deletes the secret fields from `payload` in place; true when one was present. */
const stripPayload = (payload: JobPayload | null | undefined): boolean => {
  if (!payload) return false;
  let changed = false;
  for (const field of PERSISTED_PAYLOAD_SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      delete payload[field];
      changed = true;
    }
  }
  return changed;
};

/** `LIKE` prefilter: only rows that can contain a secret field are decoded. */
const LIKE_ANY = PERSISTED_PAYLOAD_SECRET_FIELDS.map((f) => `payload_json LIKE '%"${f}"%'`).join(" OR ");

const scrubTable = (
  db: ScrubDb,
  table: "runtime_jobs" | "runtime_job_steps",
  idColumn: "job_id" | "step_id"
): number => {
  const rows = db
    .prepare(`SELECT ${idColumn} AS id, payload_json FROM ${table} WHERE ${LIKE_ANY};`)
    .all() as Array<{ id: string; payload_json: string }>;
  let scrubbed = 0;
  const update = db.prepare(`UPDATE ${table} SET payload_json = ? WHERE ${idColumn} = ?;`);
  for (const row of rows) {
    let payload: JobPayload | null;
    try {
      payload = JSON.parse(row.payload_json) as JobPayload | null;
    } catch {
      // An unreadable payload cannot be resumed anyway: empty it rather than keep a key in it.
      update.run("{}", row.id);
      scrubbed += 1;
      continue;
    }
    if (!stripPayload(payload)) continue;
    update.run(JSON.stringify(payload), row.id);
    scrubbed += 1;
  }
  return scrubbed;
};

/** Event rows embed the job under `job` (created/updated events): clean `job.payload`. */
const scrubEvents = (db: ScrubDb): number => {
  const rows = db
    .prepare(`SELECT event_id AS id, payload_json FROM runtime_job_events WHERE ${LIKE_ANY};`)
    .all() as Array<{ id: number; payload_json: string }>;
  let scrubbed = 0;
  const update = db.prepare(`UPDATE runtime_job_events SET payload_json = ? WHERE event_id = ?;`);
  for (const row of rows) {
    let body: JobEventBody | null;
    try {
      body = JSON.parse(row.payload_json) as JobEventBody | null;
    } catch {
      update.run("{}", row.id);
      scrubbed += 1;
      continue;
    }
    if (!stripPayload(body?.job?.payload)) continue;
    update.run(JSON.stringify(body), row.id);
    scrubbed += 1;
  }
  return scrubbed;
};

/**
 * Removes {@link PERSISTED_PAYLOAD_SECRET_FIELDS} from every persisted job,
 * step and event row. When anything changed the freed bytes are zeroed
 * (`secure_delete`) and the WAL is folded into the main file and truncated, so
 * no copy of the old payload stays in the database file or its `-wal`.
 */
export const scrubPersistedJobSecrets = (db: ScrubDb): SecretScrubResult => {
  const result: SecretScrubResult = { jobs: 0, steps: 0, events: 0 };
  db.exec("PRAGMA secure_delete=ON;");
  try {
    db.exec("BEGIN");
    try {
      result.jobs = scrubTable(db, "runtime_jobs", "job_id");
      result.steps = scrubTable(db, "runtime_job_steps", "step_id");
      result.events = scrubEvents(db);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    if (result.jobs + result.steps + result.events > 0) {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch (err) {
        console.warn(
          "[runtime.jobs.secret_scrub] wal checkpoint failed (the scrubbed rows are committed):",
          err instanceof Error ? err.message : err
        );
      }
      console.info(JSON.stringify({ event: "runtime.jobs.secret_scrub", ...result }));
    }
  } finally {
    db.exec("PRAGMA secure_delete=OFF;");
  }
  return result;
};
