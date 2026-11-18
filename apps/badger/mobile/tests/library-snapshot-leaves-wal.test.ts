/**
 * @test-id MOBILE-LIB-SNAPSHOT-LEAVES-WAL-001
 * @level unit
 * @bugfix
 * @regression-proof
 * @req LIB-FMT-10[badger-mobile]
 *
 * @why The phone builds the combined snapshot DB (`library.snapshot.sqlite`) in WAL mode (`applyPerfPragmas`) and
 *   read its main file for the published snapshot while the connection was still open: the header said WAL (bytes
 *   18/19 = 2), which in-memory SQLite refuses ("unable to open database file", seen when Parrot desktop opened a
 *   phone's snapshot), and the rows still in `-wal` were not in the main file at all. `leaveWalForExport` runs
 *   before every export (`buildCombinedSnapshotDb`): leaving WAL folds the log into the main file, removes `-wal`
 *   and writes the rollback-journal header, so the file read, and hashed for the manifest, is the whole library.
 *   Real SQLite on a real file; auto-checkpoint is off so the rows stay in `-wal` like a phone's last writes.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLiteDatabase } from "react-native-sqlite-storage";
import { afterEach, describe, expect, it } from "vitest";
import { leaveWalForExport } from "../src/lib/library/leaveWal";

const TAG = "[MOBILE-LIB-SNAPSHOT-LEAVES-WAL-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The plugin's `executeSql` over a real node:sqlite connection. */
const pluginHandle = (db: DatabaseSync) =>
  ({
    executeSql: async (sql: string) => {
      const rows = db.prepare(sql).all();
      return [{ rows: { length: rows.length, item: (index: number) => rows[index] }, rowsAffected: 0 }];
    },
  }) as unknown as SQLiteDatabase;

/** What a reader gets from the exported main file alone: its header and the rows it holds. */
const readExported = (path: string) => {
  const bytes = new Uint8Array(readFileSync(path));
  const copy = join(mkdtempSync(join(tmpdir(), "snapshot-export-")), "export.sqlite");
  dirs.push(copy.slice(0, copy.lastIndexOf("/")));
  writeFileSync(copy, bytes);
  const reader = new DatabaseSync(copy, { readOnly: true });
  const tables = Number(reader.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'media'").get()?.n);
  const rows = tables ? Number(reader.prepare("SELECT count(*) AS n FROM media").get()?.n) : 0;
  reader.close();
  return { header: [bytes[18], bytes[19]], rows };
};

describe("leaveWalForExport", () => {
  it("makes the snapshot DB file the whole library with a rollback-journal header @req LIB-FMT-10[badger-mobile]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-wal-"));
    dirs.push(dir);
    const path = join(dir, "library.snapshot.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA wal_autocheckpoint=0");
    db.exec("CREATE TABLE media (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO media (id, title) VALUES (?, ?)");
    for (let index = 0; index < 40; index += 1) insert.run(`m${index}`, `Title ${index}`);

    const before = readExported(path);
    log("phase:before", { ...before, walBytes: statSync(`${path}-wal`).size });
    expect(before.header, "the file the old export read says WAL").toEqual([2, 2]);
    expect(before.rows, "and misses the rows still in -wal").toBe(0);

    const mode = await leaveWalForExport(pluginHandle(db));
    const after = readExported(path);
    const walLeft = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : null;
    log("phase:after", { mode, ...after, walLeft });
    expect(mode).toBe("delete");
    expect(after).toEqual({ header: [1, 1], rows: 40 });
    expect(walLeft, "no -wal file is left beside it").toBeNull();
    db.close();
  });

  it("refuses to export a file that is still in WAL mode @req LIB-FMT-10[badger-mobile]", async () => {
    const stuck = {
      executeSql: async () => [{ rows: { length: 1, item: () => ({ journal_mode: "wal" }) }, rowsAffected: 0 }],
    } as unknown as SQLiteDatabase;
    const outcome = await leaveWalForExport(stuck).then(
      (mode) => ({ mode }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
    );
    log("phase:stuck", outcome);
    expect(outcome).toEqual({ error: "SNAPSHOT_STILL_WAL" });
  });
});
