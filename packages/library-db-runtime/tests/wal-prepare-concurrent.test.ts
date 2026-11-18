/**
 * @test-id LIB-WAL-PREPARE-CONCURRENT-001
 * @level integration (real bun:sqlite, real worker threads)
 * @bugfix @regression-proof
 *
 * CI flake (run 15165 job 55506, #326): under a loaded host every prepare is
 * fsync-bound (journal_mode=WAL switch + the first WAL frame, measured 0.5-1.8 s
 * each on a busy disk) and `LibraryDb.openLocal` prepares its five group files.
 * With ONE checkpoint worker the five prepares ran back to back (ms 1135, 1934,
 * 3608, 4803 ... in the CI log), so a cold open took > 5 s and the test timed
 * out; its teardown then removed the directory under the still-running open
 * ("disk I/O error", then an unhandled SQLITE_BUSY between tests). Run in
 * parallel the same five prepares share the disk's journal commits and finish
 * in about one prepare's time (measured 0.25-0.37 s vs 0.8-5.7 s serial).
 *
 * This test removes the load from the equation: it makes one file's prepare
 * block (another connection holds an EXCLUSIVE lock on it, so the worker sits
 * in SQLite's busy handler) and requires an unrelated file's prepare to finish
 * meanwhile. Pre-fix the single worker was stuck in the first file's prepare,
 * so the second one only completed after the lock timed out.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonPreparedOffLoopWal, prepareOffLoopWal } from "../src/walCheckpointer";

const SUITE = "wal-prepare-concurrent";
const log = (phase: string, data: Record<string, unknown> = {}) =>
  console.info(`[${SUITE}:${phase}] ${JSON.stringify(data)}`);

const dirs: string[] = [];
const tempDbPath = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), "sf-wal-prepare-concurrent-"));
  dirs.push(dir);
  return join(dir, name);
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const opts = { driver: "bun:sqlite" as const, label: "test" };

describe("@bugfix @regression-proof off-loop WAL prepare runs files concurrently (#326)", () => {
  it("a prepare stuck on one file does not hold up the prepare of another file", async () => {
    const stuckPath = tempDbPath("stuck.db");
    const freePaths = [tempDbPath("free-a.db"), tempDbPath("free-b.db"), tempDbPath("free-c.db")];

    // Rollback-journal file with a writer in flight: the worker's journal_mode=WAL
    // switch cannot get the lock and waits in SQLite's busy handler (5 s).
    const holder = new Database(stuckPath);
    holder.exec("CREATE TABLE t (x)");
    holder.exec("BEGIN EXCLUSIVE");

    let stuckSettled = false;
    const stuck = prepareOffLoopWal(stuckPath, opts).then(() => {
      stuckSettled = true;
      return "stuck-gave-up" as const;
    });

    const startedAt = performance.now();
    // Pre-fix the free prepares queue behind the stuck one on the single
    // worker, so the stuck prepare's own busy timeout settles first.
    const outcome = await Promise.race([
      Promise.all(freePaths.map((path) => prepareOffLoopWal(path, opts))).then(() => "free-prepared" as const),
      stuck,
    ]);
    const freeMs = Math.round(performance.now() - startedAt);
    log("free-prepares", { outcome, freeMs, stuckSettled });

    holder.exec("ROLLBACK");
    holder.close();
    await stuck;
    log("stuck-released", { stuckSettled, exists: existsSync(stuckPath) });
    for (const path of [stuckPath, ...freePaths]) abandonPreparedOffLoopWal(path);

    expect(outcome).toBe("free-prepared");
  }, 20_000); // the failing (pre-fix) run waits out the stuck prepare's 5 s busy timeout
});
