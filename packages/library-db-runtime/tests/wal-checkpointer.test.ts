/**
 * #25 P10 — SQLite commits must not fsync on the runtime's event loop.
 *
 * Contract of walCheckpointer.ts (WAL + synchronous=NORMAL everywhere, never
 * OFF): `prepareOffLoopWal` lets a worker thread create the file, switch it to
 * WAL and write the first WAL frame; `enableOffLoopWal` puts the event-loop
 * connection in WAL + NORMAL (autocheckpoint off once the worker owns the
 * file); `registerOffLoopWal` (after migrations) hands checkpoints to the
 * worker and pins the WAL so event-loop commits never restart it; release
 * lets the worker checkpoint and close first, so the last close removes the
 * sidecars. This test checks that contract without a fsync shim, so it runs
 * in CI; apps/runtime/tests/sqlite-fsync-off-event-loop.test.ts proves the
 * effect on health latency where a C compiler is available.
 *
 * @bugfix @regression-proof
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointOffLoopWalNow,
  enableOffLoopWal,
  prepareOffLoopWal,
  registerOffLoopWal,
  releaseOffLoopWal,
  WAL_RESTART_FRAMES,
  type WalCheckpointResult,
} from "../src/walCheckpointer";

const SUITE = "wal-checkpointer";
const log = (phase: string, data: Record<string, unknown> = {}) =>
  console.info(`[${SUITE}:${phase}] ${JSON.stringify(data)}`);

// Finalized at once: bun's close() is deferred while a statement lives, and
// a deferred close would keep the -wal/-shm this test checks are removed.
const queryOne = (db: Database, sql: string): unknown => {
  const stmt = db.prepare(sql);
  try {
    return stmt.get();
  } finally {
    stmt.finalize();
  }
};

const pragma = (db: Database, name: string): unknown => {
  const row = queryOne(db, `PRAGMA ${name}`);
  return row === null || typeof row !== "object" ? null : Object.values(row)[0];
};

const settingsOf = (db: Database) => ({
  journalMode: pragma(db, "journal_mode"),
  synchronous: pragma(db, "synchronous"),
  autocheckpoint: pragma(db, "wal_autocheckpoint"),
});

const sidecars = (path: string) => ({
  wal: existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : null,
  shm: existsSync(`${path}-shm`),
});

const dirs: string[] = [];
const tempDbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-wal-checkpointer-"));
  dirs.push(dir);
  return join(dir, "test.db");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const opts = (path: string) => ({ path, driver: "bun:sqlite" as const, label: "test" });

const mineOf = (results: WalCheckpointResult[], path: string) => results.filter((r) => r.path === path);

/** One checkpoint pass (it waits for an unprepared file's attach); returns this file's result. */
const checkpointUntilReported = async (path: string): Promise<WalCheckpointResult> => {
  const results = await checkpointOffLoopWalNow();
  const mine = mineOf(results, path);
  log("checkpoint-pass", { mine, files: results.map((r) => r.path) });
  const result = mine[0];
  if (!result) throw new Error(`worker did not report on ${path}`);
  return result;
};

const writeRows = (db: Database, rows: number) => {
  const insert = db.prepare("INSERT INTO t (body) VALUES (?)");
  db.exec("BEGIN");
  for (let i = 0; i < rows; i += 1) insert.run("x".repeat(4_000));
  db.exec("COMMIT");
  insert.finalize();
};

describe("@bugfix @regression-proof off-loop WAL checkpointer (#25 P10)", () => {
  it("a prepared file: NORMAL (never OFF), worker checkpoints, release + close leaves no -wal/-shm", async () => {
    const path = tempDbPath();
    log("prepare:start", { path });
    await prepareOffLoopWal(path, { driver: "bun:sqlite", label: "test" });
    log("prepare:done", { exists: existsSync(path), ...sidecars(path) });
    expect(existsSync(path)).toBe(true);

    const db = new Database(path);
    enableOffLoopWal(db, opts(path));
    const enabled = settingsOf(db);
    log("enabled", enabled);
    expect(enabled).toEqual({ journalMode: "wal", synchronous: 1, autocheckpoint: 0 });

    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
    registerOffLoopWal(db, opts(path));
    const registered = settingsOf(db);
    log("registered", registered);
    expect(registered).toEqual({ journalMode: "wal", synchronous: 1, autocheckpoint: 0 });

    const insert = db.prepare("INSERT INTO t (body) VALUES (?)");
    for (let i = 0; i < 200; i += 1) insert.run("x".repeat(4_000));
    insert.finalize();
    const walBefore = statSync(`${path}-wal`).size;
    log("written", { walBytes: walBefore });
    expect(walBefore).toBeGreaterThan(0);

    const result = await checkpointUntilReported(path);
    log("checkpoint", { result });
    expect(result.error).toBeUndefined();
    expect(result.checkpointed ?? 0).toBeGreaterThan(0);
    expect(result.checkpointed).toBe(result.log);

    // The worker's checkpoint is visible to this connection's readers.
    expect(queryOne(db, "SELECT COUNT(*) AS n FROM t")).toEqual({ n: 200 });

    releaseOffLoopWal(db);
    const after = await checkpointOffLoopWalNow();
    log("released", { after: mineOf(after, path) });
    expect(mineOf(after, path)).toEqual([]);
    db.close();
    const left = sidecars(path);
    log("closed", left);
    expect(left).toEqual({ wal: null, shm: false });

    const reopened = new Database(path);
    expect(queryOne(reopened, "SELECT COUNT(*) AS n FROM t")).toEqual({ n: 200 });
    reopened.close();
  });

  it("an unprepared file reaches the worker only after registration (never mid-migration)", async () => {
    const path = tempDbPath();
    const db = new Database(path);
    enableOffLoopWal(db, opts(path));
    const enabled = settingsOf(db);
    log("enabled", enabled);
    // Not the worker's yet: SQLite's own autocheckpoint stays on.
    expect(enabled).toEqual({ journalMode: "wal", synchronous: 1, autocheckpoint: 1000 });

    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
    const beforeRegister = mineOf(await checkpointOffLoopWalNow(), path);
    log("before-register", { beforeRegister });
    expect(beforeRegister).toEqual([]);

    registerOffLoopWal(db, opts(path));
    const registered = settingsOf(db);
    log("registered", registered);
    expect(registered).toEqual({ journalMode: "wal", synchronous: 1, autocheckpoint: 0 });

    writeRows(db, 50);
    const result = await checkpointUntilReported(path);
    log("checkpoint", { result });
    expect(result.error).toBeUndefined();
    expect(result.checkpointed ?? 0).toBeGreaterThan(0);

    releaseOffLoopWal(db);
    db.close();
    const left = sidecars(path);
    log("closed", left);
    expect(left).toEqual({ wal: null, shm: false });
  });

  it("the WAL is bounded: past the frame cap it is let restart, then pinned again", async () => {
    const path = tempDbPath();
    await prepareOffLoopWal(path, { driver: "bun:sqlite", label: "test" });
    const db = new Database(path);
    enableOffLoopWal(db, opts(path));
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
    registerOffLoopWal(db, opts(path));

    // One page per row: one commit of this many rows writes more frames than the cap.
    writeRows(db, WAL_RESTART_FRAMES + 500);
    const big = await checkpointUntilReported(path);
    log("big", { big, walBytes: sidecars(path).wal, cap: WAL_RESTART_FRAMES });
    expect(big.error).toBeUndefined();
    expect(big.log ?? 0).toBeGreaterThanOrEqual(WAL_RESTART_FRAMES);
    expect(big.checkpointed).toBe(big.log);

    // Unpinned and fully backfilled: this commit restarts the WAL from frame 1.
    writeRows(db, 10);
    const restarted = await checkpointUntilReported(path);
    log("restarted", { restarted, walBytes: sidecars(path).wal });
    expect(restarted.error).toBeUndefined();
    expect(restarted.log ?? 0).toBeGreaterThan(0);
    expect(restarted.log ?? 0).toBeLessThan(WAL_RESTART_FRAMES);
    expect(restarted.checkpointed).toBe(restarted.log);

    // Pinned again: later commits append instead of restarting on the event loop.
    writeRows(db, 10);
    const appended = await checkpointUntilReported(path);
    log("appended", { appended });
    expect(appended.log ?? 0).toBeGreaterThan(restarted.log ?? 0);

    expect(queryOne(db, "SELECT COUNT(*) AS n FROM t")).toEqual({ n: WAL_RESTART_FRAMES + 520 });
    releaseOffLoopWal(db);
    db.close();
    expect(sidecars(path)).toEqual({ wal: null, shm: false });
  }, 60_000);

  it("an in-memory database stays on plain NORMAL semantics and is not registered", async () => {
    const db = new Database(":memory:");
    await prepareOffLoopWal(":memory:", { driver: "bun:sqlite", label: "memory" });
    enableOffLoopWal(db, opts(":memory:"));
    registerOffLoopWal(db, opts(":memory:"));
    const settings = { synchronous: pragma(db, "synchronous") };
    log("memory", settings);
    expect(settings).toEqual({ synchronous: 1 });
    const results = await checkpointOffLoopWalNow();
    expect(mineOf(results, ":memory:")).toEqual([]);
    db.close();
  });
});
