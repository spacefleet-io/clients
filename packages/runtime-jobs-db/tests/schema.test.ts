import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runRuntimeJobsDbMigrations, type SqliteDb } from "../src/migrations";

const openDb = (): { raw: Database; db: SqliteDb } => {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA foreign_keys=ON;");
  const db: SqliteDb = {
    exec: (sql: string) => {
      raw.exec(sql);
    },
    prepare: (sql: string) => {
      const stmt = raw.prepare(sql);
      return {
        all: () => stmt.all() as unknown[],
        run: (...params: unknown[]) =>
          // bun:sqlite's run() accepts variadic positional params just like better-sqlite3.
          (stmt.run as (...args: unknown[]) => unknown)(...params),
      };
    },
  };
  return { raw, db };
};

const tableInfo = (raw: Database, table: string) =>
  raw.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string; type: string }>;

const indexList = (raw: Database, table: string) =>
  raw.prepare(`PRAGMA index_list(${table});`).all() as Array<{ name: string; unique: number }>;

// On assertion failure, dump the live schema state for the table(s) this test
// cares about so a CI failure is diagnosable offline (per "Tests log generously").
// Body is wrapped in try/catch so a dump failure can never mask the real assertion.
const dumpSchemaSnapshot = (raw: Database, label: string, tables: string[]) => {
  try {
    console.error(`=== [runtime-jobs-db-schema:${label}] snapshot ===`);
    let allTables: unknown[] = [];
    try {
      allTables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
        .all() as unknown[];
    } catch (err) {
      allTables = [`(sqlite_master read failed: ${err instanceof Error ? err.message : String(err)})`];
    }
    console.error(`tables present: ${JSON.stringify(allTables)}`);
    for (const table of tables) {
      let cols: unknown[] = [];
      let indices: unknown[] = [];
      try {
        cols = tableInfo(raw, table);
      } catch (err) {
        cols = [`(table_info(${table}) failed: ${err instanceof Error ? err.message : String(err)})`];
      }
      try {
        indices = indexList(raw, table);
      } catch (err) {
        indices = [`(index_list(${table}) failed: ${err instanceof Error ? err.message : String(err)})`];
      }
      console.error(`${table} columns (${Array.isArray(cols) ? cols.length : "?"}):\n${JSON.stringify(cols, null, 2)}`);
      console.error(`${table} indices:\n${JSON.stringify(indices, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runRuntimeJobsDbMigrations", () => {
  it("creates runtime_jobs with all required columns", () => {
    console.info("[runtime-jobs-db-schema:cols] opening in-memory db + running migrations");
    const { raw, db } = openDb();
    runRuntimeJobsDbMigrations(db);
    const cols = new Set(tableInfo(raw, "runtime_jobs").map((c) => c.name));
    console.info(
      `[runtime-jobs-db-schema:cols] runtime_jobs has ${cols.size} columns: ${JSON.stringify([...cols])}`
    );
    for (const expected of [
      "job_id",
      "app",
      "owner_id",
      "group_id",
      "media_id",
      "kind",
      "variant",
      "status",
      "lane",
      "priority",
      "parent_job_ids",
      "stage_code",
      "stage_label",
      "progress_pct",
      "upload_speed_bytes_per_sec",
      "error_code",
      "error_message",
      "attempts",
      "cancel_requested",
      "dedupe_key",
      "payload_json",
      "outputs_json",
      "started_at",
      "finished_at",
      "dismissed_at",
      "created_at",
      "updated_at",
    ]) {
      if (!cols.has(expected)) {
        console.error(`[runtime-jobs-db-schema:cols] FAIL — runtime_jobs missing column ${expected}`);
        dumpSchemaSnapshot(raw, "cols-missing-column", ["runtime_jobs"]);
      }
      expect(cols.has(expected), `runtime_jobs missing column ${expected}`).toBe(true);
    }
    console.info("[runtime-jobs-db-schema:cols] all required runtime_jobs columns present");
    raw.close();
  });

  it("creates runtime_jobs indices including the partial unique on (app, dedupe_key)", () => {
    console.info("[runtime-jobs-db-schema:indices] opening db + running migrations");
    const { raw, db } = openDb();
    runRuntimeJobsDbMigrations(db);
    const indices = indexList(raw, "runtime_jobs");
    const byName = new Map(indices.map((i) => [i.name, i]));
    console.info(
      `[runtime-jobs-db-schema:indices] runtime_jobs indices: ${JSON.stringify([...byName.keys()])}`
    );
    try {
      expect(byName.has("runtime_jobs_app_group_idx")).toBe(true);
      expect(byName.has("runtime_jobs_status_idx")).toBe(true);
      expect(byName.has("runtime_jobs_lane_status_idx")).toBe(true);
      const dedupeIdx = byName.get("runtime_jobs_app_dedupe_unique_idx");
      expect(dedupeIdx?.unique).toBe(1);
    } catch (err) {
      console.error(
        `[runtime-jobs-db-schema:indices] FAIL — dedupe idx=${JSON.stringify(byName.get("runtime_jobs_app_dedupe_unique_idx"))}`
      );
      dumpSchemaSnapshot(raw, "indices-mismatch", ["runtime_jobs"]);
      raw.close();
      throw err;
    }
    console.info("[runtime-jobs-db-schema:indices] all expected runtime_jobs indices present");
    raw.close();
  });

  it("partial unique index allows multiple null dedupe_key rows", () => {
    console.info("[runtime-jobs-db-schema:dedupe] opening db + running migrations");
    const { raw, db } = openDb();
    runRuntimeJobsDbMigrations(db);
    const insert = (jobId: string, dedupeKey: string | null) =>
      raw
        .prepare(
          `INSERT INTO runtime_jobs (job_id, app, owner_id, group_id, media_id, kind, status, lane, priority, dedupe_key, created_at, updated_at)
           VALUES (?, 'badger', 'u1', 'g1', 'm1', 'source', 'queued', 'source', 0, ?, '2026-01-01', '2026-01-01');`
        )
        .run(jobId, dedupeKey);
    console.info("[runtime-jobs-db-schema:dedupe] inserting two null-dedupe rows (j1,j2) then j3 key-a");
    insert("j1", null);
    insert("j2", null);
    insert("j3", "key-a");
    try {
      console.info("[runtime-jobs-db-schema:dedupe] expecting duplicate key-a insert (j4) to throw");
      expect(() => insert("j4", "key-a")).toThrow();
    } catch (err) {
      const rows = raw
        .prepare("SELECT job_id, dedupe_key FROM runtime_jobs ORDER BY job_id;")
        .all() as unknown[];
      console.error(`[runtime-jobs-db-schema:dedupe] FAIL — current rows: ${JSON.stringify(rows)}`);
      dumpSchemaSnapshot(raw, "dedupe-uniqueness", ["runtime_jobs"]);
      raw.close();
      throw err;
    }
    console.info("[runtime-jobs-db-schema:dedupe] partial-unique behavior verified");
    raw.close();
  });

  it("creates runtime_job_steps with parent_job_id FK and indices", () => {
    console.info("[runtime-jobs-db-schema:steps] opening db + running migrations");
    const { raw, db } = openDb();
    runRuntimeJobsDbMigrations(db);
    const cols = new Set(tableInfo(raw, "runtime_job_steps").map((c) => c.name));
    console.info(
      `[runtime-jobs-db-schema:steps] runtime_job_steps has ${cols.size} columns: ${JSON.stringify([...cols])}`
    );
    for (const expected of [
      "step_id",
      "parent_job_id",
      "app",
      "kind",
      "ordinal",
      "status",
      "lane",
      "progress_pct",
      "depends_on_json",
      "payload_json",
      "outputs_json",
      "error_code",
      "error_message",
      "started_at",
      "finished_at",
      "created_at",
      "updated_at",
    ]) {
      if (!cols.has(expected)) {
        console.error(`[runtime-jobs-db-schema:steps] FAIL — runtime_job_steps missing column ${expected}`);
        dumpSchemaSnapshot(raw, "steps-missing-column", ["runtime_job_steps"]);
      }
      expect(cols.has(expected), `runtime_job_steps missing column ${expected}`).toBe(true);
    }
    const indices = indexList(raw, "runtime_job_steps").map((i) => i.name);
    console.info(`[runtime-jobs-db-schema:steps] runtime_job_steps indices: ${JSON.stringify(indices)}`);
    try {
      expect(indices).toContain("runtime_job_steps_parent_ordinal_idx");
      expect(indices).toContain("runtime_job_steps_status_idx");
    } catch (err) {
      console.error("[runtime-jobs-db-schema:steps] FAIL — expected step indices missing");
      dumpSchemaSnapshot(raw, "steps-index-mismatch", ["runtime_job_steps"]);
      raw.close();
      throw err;
    }
    console.info("[runtime-jobs-db-schema:steps] runtime_job_steps schema verified");
    raw.close();
  });

  it("creates runtime_job_events with autoincrement event_id and indices", () => {
    console.info("[runtime-jobs-db-schema:events] opening db + running migrations");
    const { raw, db } = openDb();
    runRuntimeJobsDbMigrations(db);
    const cols = new Set(tableInfo(raw, "runtime_job_events").map((c) => c.name));
    console.info(
      `[runtime-jobs-db-schema:events] runtime_job_events has ${cols.size} columns: ${JSON.stringify([...cols])}`
    );
    for (const expected of [
      "event_id",
      "job_id",
      "step_id",
      "channel",
      "event",
      "payload_json",
      "created_at",
    ]) {
      if (!cols.has(expected)) {
        console.error(`[runtime-jobs-db-schema:events] FAIL — runtime_job_events missing column ${expected}`);
        dumpSchemaSnapshot(raw, "events-missing-column", ["runtime_job_events"]);
      }
      expect(cols.has(expected), `runtime_job_events missing column ${expected}`).toBe(true);
    }
    const indices = indexList(raw, "runtime_job_events").map((i) => i.name);
    console.info(`[runtime-jobs-db-schema:events] runtime_job_events indices: ${JSON.stringify(indices)}`);
    try {
      expect(indices).toContain("runtime_job_events_job_event_idx");
      expect(indices).toContain("runtime_job_events_created_at_idx");
    } catch (err) {
      console.error("[runtime-jobs-db-schema:events] FAIL — expected event indices missing");
      dumpSchemaSnapshot(raw, "events-index-mismatch", ["runtime_job_events"]);
      raw.close();
      throw err;
    }
    // Autoincrement: two inserts should produce distinct ascending event_ids.
    console.info("[runtime-jobs-db-schema:events] inserting two events to verify autoincrement event_id");
    raw
      .prepare(
        `INSERT INTO runtime_job_events (job_id, event, created_at) VALUES ('j1', 'created', '2026-01-01');`
      )
      .run();
    raw
      .prepare(
        `INSERT INTO runtime_job_events (job_id, event, created_at) VALUES ('j1', 'started', '2026-01-01');`
      )
      .run();
    const ids = (raw.prepare("SELECT event_id FROM runtime_job_events ORDER BY event_id;").all() as Array<{
      event_id: number;
    }>).map((r) => r.event_id);
    console.info(`[runtime-jobs-db-schema:events] observed event_ids=${JSON.stringify(ids)}`);
    try {
      expect(ids.length).toBe(2);
      expect(ids[1]).toBeGreaterThan(ids[0]);
    } catch (err) {
      console.error(`[runtime-jobs-db-schema:events] FAIL — autoincrement ids=${JSON.stringify(ids)}`);
      dumpSchemaSnapshot(raw, "events-autoincrement", ["runtime_job_events"]);
      raw.close();
      throw err;
    }
    console.info("[runtime-jobs-db-schema:events] event_id autoincrement verified");
    raw.close();
  });

  it("is idempotent — running twice does not throw", () => {
    console.info("[runtime-jobs-db-schema:idempotent] running migrations the first time");
    const { raw, db } = openDb();
    runRuntimeJobsDbMigrations(db);
    try {
      console.info("[runtime-jobs-db-schema:idempotent] running migrations the second time");
      expect(() => runRuntimeJobsDbMigrations(db)).not.toThrow();
    } catch (err) {
      console.error(
        `[runtime-jobs-db-schema:idempotent] FAIL — second migration run threw: ${err instanceof Error ? err.message : String(err)}`
      );
      dumpSchemaSnapshot(raw, "idempotent-second-run", [
        "runtime_jobs",
        "runtime_job_steps",
        "runtime_job_events",
      ]);
      raw.close();
      throw err;
    }
    console.info("[runtime-jobs-db-schema:idempotent] second migration run was a no-op (no throw)");
    raw.close();
  });
});
