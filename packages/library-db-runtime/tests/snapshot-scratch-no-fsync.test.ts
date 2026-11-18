/**
 * @bugfix @regression-proof — #25 ultimate stress P1 (runtime guardian kill loop).
 *
 * Live evidence (stress run on a loaded host, /proc/<runtime>/syscall sampled
 * every ~20 ms for 2 min): after the jobs WAL, the runtime main thread spent
 * the most time in fsync/pwrite of `library-export-<ts>.sqlite-journal` and
 * `library-export-<ts>.sqlite` (~25 % of samples). That file is the scratch
 * image `buildCombinedSnapshotBytes` assembles, reads back into memory and
 * deletes; every DDL/INSERT ran as its own autocommit with a rollback journal
 * and synchronous=FULL, i.e. several fsyncs per statement on the event loop.
 *
 * A scratch file that is deleted right after it is read needs no on-disk
 * journal (journal_mode=MEMORY; bun:sqlite's defensive mode refuses OFF) and
 * no fsync.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "bun:test";
import { openSnapshotScratchDb } from "../src/libraryDb";

const SUITE = "snapshot-scratch-no-fsync";

describe("@bugfix @regression-proof library export scratch DB skips journal and fsync (#25 P1)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("opens the scratch snapshot with an in-memory journal and synchronous=OFF", () => {
    dir = mkdtempSync(join(tmpdir(), "lib-scratch-"));
    const path = join(dir, "library-export-test.sqlite");
    const db = openSnapshotScratchDb(path);
    try {
      const journal = db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string };
      const sync = db.prepare("PRAGMA synchronous;").get() as { synchronous?: number };
      const fk = db.prepare("PRAGMA foreign_keys;").get() as { foreign_keys?: number };
      console.info(`[${SUITE}] path=${path} journal=${JSON.stringify(journal)} synchronous=${JSON.stringify(sync)} fk=${JSON.stringify(fk)}`);
      expect(String(journal.journal_mode).toLowerCase()).toBe("memory");
      expect(sync.synchronous).toBe(0);
      expect(fk.foreign_keys).toBe(0);
    } finally {
      db.close();
    }
  });
});
