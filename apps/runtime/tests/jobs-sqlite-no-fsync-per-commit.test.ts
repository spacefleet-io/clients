/**
 * @bugfix @regression-proof — #25 ultimate stress P1 (runtime guardian kill loop).
 *
 * Live evidence (stress run on a loaded host, /proc/<runtime>/syscall sampled
 * every ~20 ms for 2 min): the runtime's MAIN thread sat in
 * `fsync(runtime_jobs.db-wal)` in 502 samples — about a sixth of its wall time —
 * in state D (wchan wait_dev_flush), at ~0 % CPU. bun:sqlite is synchronous, so
 * every job progress commit blocked the event loop for the whole fsync, and on
 * a busy disk one fsync takes seconds: /runtime/health stopped answering and
 * the guardian killed the runtime.
 *
 * In WAL mode `synchronous=NORMAL` fsyncs only at checkpoints, never per
 * commit, and the DB stays consistent after a crash or power loss (only the
 * newest commits can roll back). The jobs DB must use it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteRuntimeJobsStore, type SqliteRuntimeJobsStore } from "../src/core/jobs/sqliteStore";

const SUITE = "jobs-sqlite-no-fsync-per-commit";

describe("@bugfix @regression-proof runtime jobs DB does not fsync on every commit (#25 P1)", () => {
  let dir: string | null = null;
  let store: SqliteRuntimeJobsStore | null = null;
  afterEach(() => {
    try {
      store?.db.close();
    } catch {
      // already closed
    }
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("opens the file-backed jobs DB in WAL mode with synchronous=NORMAL", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-jobs-sync-"));
    const dbPath = join(dir, "runtime_jobs.db");
    store = createSqliteRuntimeJobsStore(dbPath);
    const journal = store.db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string };
    const sync = store.db.prepare("PRAGMA synchronous;").get() as { synchronous?: number };
    console.info(`[${SUITE}] dbPath=${dbPath} journal_mode=${JSON.stringify(journal)} synchronous=${JSON.stringify(sync)} (0=OFF 1=NORMAL 2=FULL 3=EXTRA)`);
    expect(String(journal.journal_mode).toLowerCase()).toBe("wal");
    expect(sync.synchronous).toBe(1);
  });
});
