/**
 * SQLite-backed implementation of the {@link EventLogDeps} seam from
 * `eventLog.ts`. Phase B scaffolding: additive, not yet wired into the live
 * runtime — engineV2 composes this with `createEventLog` to get a durable
 * event ring buffer over the `runtime_job_events` table.
 *
 * Driver portability mirrors `sqliteStore.ts`: lazy-resolve `node:sqlite`
 * (Node 22+, what vitest-under-bunx uses), fall back to `bun:sqlite` for the
 * production runtime under Bun. The structural `SqliteDb` type from
 * `@space/runtime-jobs-db` is the lowest common denominator.
 */

import type { EventLogDeps, EventRow } from "./eventLog";

/**
 * Structural SQLite handle this module needs. Compatible with the `db`
 * property surfaced by `createSqliteRuntimeJobsStore` and with the abstract
 * `SqliteDb` type from `@space/runtime-jobs-db`. Kept local because the
 * migration package's `prepare(sql).all()` is parameterless, while we need
 * to bind parameters at execution time — node:sqlite and bun:sqlite both
 * accept that, but the narrow public type does not advertise it.
 */
export type EventLogSqliteDb = {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
    get?: (...params: unknown[]) => unknown;
  };
};

type EventDbRow = {
  event_id: number;
  job_id: string;
  channel: string;
  event: string;
  payload_json: string;
  created_at: string;
};

const rowToEvent = (row: EventDbRow): EventRow => ({
  eventId: row.event_id,
  jobId: row.job_id,
  channel: row.channel,
  event: row.event,
  payloadJson: row.payload_json,
  createdAt: row.created_at,
});

/**
 * Build {@link EventLogDeps} backed by the supplied SQLite handle. The DB is
 * expected to have the `runtime_job_events` schema already applied via
 * `runRuntimeJobsDbMigrations(db)`. The caller (e.g. engineV2) owns the
 * connection lifecycle; this factory does not open or close anything.
 */
export function createSqliteEventLogDeps(db: EventLogSqliteDb): EventLogDeps {
  return {
    insert(row) {
      // INSERT then read-back via last_insert_rowid() to capture the
      // autoincrement event_id. Both node:sqlite and bun:sqlite expose
      // `last_insert_rowid()` as a SQL function; we use it rather than the
      // driver-specific `lastInsertRowid` so this stays portable.
      db.prepare(
        `INSERT INTO runtime_job_events
           (job_id, channel, event, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?);`
      ).run(row.jobId, row.channel, row.event, row.payloadJson, row.createdAt);
      const rows = db
        .prepare(
          `SELECT * FROM runtime_job_events WHERE event_id = last_insert_rowid() LIMIT 1;`
        )
        .all() as EventDbRow[];
      if (rows.length === 0) {
        throw new Error("sqliteEventLogDeps.insert: row not found after insert");
      }
      return rowToEvent(rows[0]);
    },

    selectAfter(lastEventId, limit) {
      const rows = db
        .prepare(
          `SELECT * FROM runtime_job_events
           WHERE event_id > ?
           ORDER BY event_id ASC
           LIMIT ?;`
        )
        .all(lastEventId, limit) as EventDbRow[];
      return rows.map(rowToEvent);
    },

    selectMaxEventId() {
      const rows = db
        .prepare(`SELECT COALESCE(MAX(event_id), 0) AS max FROM runtime_job_events;`)
        .all() as Array<{ max: number | null }>;
      return rows[0]?.max ?? 0;
    },

    trim(beforeIso, limit) {
      // `created_at` is indexed; a bounded subselect keeps one call short.
      const result = (
        limit === undefined
          ? db.prepare(`DELETE FROM runtime_job_events WHERE created_at < ?;`).run(beforeIso)
          : db
              .prepare(
                `DELETE FROM runtime_job_events WHERE event_id IN (
                   SELECT event_id FROM runtime_job_events WHERE created_at < ? LIMIT ?
                 );`
              )
              .run(beforeIso, limit)
      ) as { changes?: number };
      return result?.changes ?? 0;
    },
  };
}
