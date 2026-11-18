/**
 * @test-id LIB-RUNPERSIST-SPLIT-DETACHED-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 * @bugfix runpersist-split-file-detached
 * @regression-proof
 *
 * Desktop e2e run 8068 (PR #86): the runtime process died with exit code 1
 * and an uncaught `SQLiteError: no such table: split_0.media_items` thrown
 * from `buildCombinedSnapshotBytes` ← `runPersist` (a `setTimeout(0)`
 * callback). The per-group `library.*.sqlite` files backing the OPEN handles
 * had been unlinked (the library directory was wiped while a background
 * encode job still wrote into the open LibraryDb). `ATTACH` re-resolves the
 * bound path, finds nothing, silently creates an empty file, and the
 * `INSERT … SELECT FROM split_0.media_items` throws — outside any catch, so
 * the whole runtime crashed and every later desktop request failed.
 *
 * Contract after the fix:
 *   - `runPersist` never throws: a snapshot that cannot be built is logged
 *     and skipped; the runtime keeps serving.
 *   - The combined export refuses to ATTACH a path whose file is no longer
 *     the one the open handle is backed by (deleted OR replaced by another
 *     LibraryDb's file). It never recreates the wiped directory and never
 *     stitches another library's rows into this instance's snapshot.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";
let previousEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-runpersist-detached-"));
  previousEnv = process.env.SF_USER_DATA_PATH;
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[runpersist-split-detached:setup] root=${root} previousEnv=${JSON.stringify(previousEnv)}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousEnv === undefined) delete process.env.SF_USER_DATA_PATH;
  else process.env.SF_USER_DATA_PATH = previousEnv;
});

const libraryDir = () => join(root, "library");

const listLibraryDir = () => (existsSync(libraryDir()) ? readdirSync(libraryDir()).sort() : null);

type PersistInternals = { runPersist(): void; persistState: unknown; persistInFlight: boolean };

// Both cases keep writing to and reading from a LibraryDb whose files were unlinked under it:
// SQLite serving an unlinked WAL file through its open handle. Apple's system SQLite (what
// bun:sqlite uses on macOS) refuses that by design with SQLITE_IOERR_VNODE, so the cases need a
// SQLite that serves it. Probed at collection time: skipIf needs the answer before the hooks run.
// Apple's refusal is racy (the vnode-deleted check can lose against the unlink under load), so
// one lucky probe is not enough: every attempt must succeed.
const probeOnce = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-unlinked-probe-"));
  const db = new Database(join(dir, "probe.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (a);");
    rmSync(dir, { recursive: true, force: true });
    db.exec("INSERT INTO t VALUES (1);");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO t VALUES (2);");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};
const sqliteServesUnlinkedFile = Array.from({ length: 5 }, probeOnce).every(Boolean);

describe.skipIf(!sqliteServesUnlinkedFile)("runPersist — per-group SQLite files unlinked/replaced under the open handles", () => {
  it("@bugfix @regression-proof runPersist does not throw (no runtime crash) when the library directory was wiped under the open LibraryDb", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    try {
      await db.setSetting("e2e.detached.before-wipe", "kept-in-open-handle");
      console.info(`[runpersist-split-detached:pre-wipe] libraryDir=${JSON.stringify(listLibraryDir())}`);

      // What the e2e harness's resetRuntimeLibrary did while a background
      // encode job of the previous test file still held this LibraryDb open.
      rmSync(libraryDir(), { recursive: true, force: true });
      console.info(`[runpersist-split-detached:wiped] libraryDir-exists=${existsSync(libraryDir())}`);

      // A late write from the still-running job: schedules a persist.
      await db.setSetting("e2e.detached.after-wipe", "late-job-write");
      const internals = db as unknown as PersistInternals;
      console.info(
        `[runpersist-split-detached:pending] persistState=${JSON.stringify(internals.persistState)} ` +
          `persistInFlight=${internals.persistInFlight}`,
      );

      // Drive the scheduled persist synchronously (it consumes persistState,
      // so the queued setTimeout(0) becomes a no-op). Pre-fix this throws the
      // exact SQLiteError that killed the runtime in run 8068.
      let thrown: unknown = null;
      try {
        internals.runPersist();
      } catch (err) {
        thrown = err;
      }
      console.info(
        `[runpersist-split-detached:run-persist] thrown=${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)} ` +
          `persistInFlight=${internals.persistInFlight} libraryDir=${JSON.stringify(listLibraryDir())}`,
      );
      expect(thrown).toBeNull();
      expect(internals.persistInFlight).toBe(false);

      // The failed persist must not resurrect the wiped directory with stray
      // empty per-group files (ATTACH side effect) or a stale snapshot.
      expect(existsSync(libraryDir())).toBe(false);

      // The open handle keeps serving reads — the instance is still usable.
      const after = db.getSetting("e2e.detached.after-wipe");
      console.info(`[runpersist-split-detached:read-back] after-wipe=${JSON.stringify(after)}`);
      expect(after?.value).toBe("late-job-write");
    } finally {
      db.close();
    }
  });

  it("@bugfix @regression-proof export refuses to stitch a DIFFERENT library's per-group files that replaced the bound paths", async () => {
    const stale = await LibraryDb.openLocal("token", "key");
    stale.setSyncEnabled(false);
    await stale.setSetting("e2e.detached.owner", "stale-user");

    rmSync(libraryDir(), { recursive: true, force: true });
    // The next test's user opens a fresh library at the same paths.
    const fresh = await LibraryDb.openLocal("token", "key");
    fresh.setSyncEnabled(false);
    await fresh.setSetting("e2e.detached.owner", "fresh-user");
    console.info(`[runpersist-split-detached:replaced] libraryDir=${JSON.stringify(listLibraryDir())}`);

    try {
      let thrown: unknown = null;
      let leakedOwner: string | null = null;
      try {
        const bytes = stale.exportBytes();
        const snapPath = join(root, "stale-export.sqlite");
        writeFileSync(snapPath, bytes);
        const snap = new Database(snapPath);
        try {
          const row = snap.prepare("SELECT value FROM app_settings WHERE key = ?;").get("e2e.detached.owner") as
            | { value?: string }
            | undefined;
          leakedOwner = row?.value ?? null;
        } finally {
          snap.close();
        }
      } catch (err) {
        thrown = err;
      }
      console.info(
        `[runpersist-split-detached:stale-export] thrown=${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)} ` +
          `ownerInStaleSnapshot=${JSON.stringify(leakedOwner)} staleOpenHandleOwner=${JSON.stringify(stale.getSetting("e2e.detached.owner"))}`,
      );
      // Pre-fix the stale instance ATTACHes the fresh user's files and
      // exports "fresh-user" as its own state. Post-fix it refuses.
      expect(leakedOwner).not.toBe("fresh-user");
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("no longer backs the open handle");
      // The stale instance's own rows are intact in its handle.
      expect(stale.getSetting("e2e.detached.owner")?.value).toBe("stale-user");
    } finally {
      stale.close();
      fresh.close();
    }
  });
});
