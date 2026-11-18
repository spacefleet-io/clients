/**
 * @bugfix direct-sqlite-wal-requires-bun-sqlite
 * @regression-proof
 *
 * The library group files open through `enableOffLoopWal(db, { driver: "bun:sqlite" })`,
 * the driver the runtime's off-loop worker uses. In Electron's direct-SQLite mode
 * (SF_LIBRARY_DB_DIRECT_SQLITE=1) the connection is better-sqlite3 and `bun:sqlite`
 * does not exist. Clearing SQLITE_FCNTL_PERSIST_WAL required `bun:sqlite` unconditionally,
 * so `sf-library-db-open` threw "Cannot find module 'bun:sqlite'" and onboarding never
 * left /onboarding/key. This suite runs under Node, like the Electron main process.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableOffLoopWal } from "@space/library-db-runtime/walCheckpointer";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

describe("enableOffLoopWal on a better-sqlite3 connection (Electron direct-SQLite)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("puts the file in WAL without loading bun:sqlite", () => {
    dir = mkdtempSync(join(tmpdir(), "sf-wal-better-sqlite-"));
    const path = join(dir, "core.sqlite");
    const db = new Database(path);
    try {
      console.info(`[library-wal-better-sqlite] runtime bun=${process.versions.bun ?? "<none>"} path=${path}`);
      expect(() => enableOffLoopWal(db, { path, driver: "bun:sqlite", label: "library" })).not.toThrow();
      const mode = db.pragma("journal_mode", { simple: true });
      const synchronous = db.pragma("synchronous", { simple: true });
      console.info(`[library-wal-better-sqlite] journal_mode=${String(mode)} synchronous=${String(synchronous)}`);
      expect(mode).toBe("wal");
      // 1 = NORMAL
      expect(synchronous).toBe(1);
    } finally {
      db.close();
    }
  });
});
