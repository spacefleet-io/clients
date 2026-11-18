/**
 * Bench: per-flush cost of the publish guard (`ensurePublishableState`, #25).
 *
 * The guard runs before every ops flush — about once a second while
 * playback progress is being saved — on the runtime main thread. This script
 * measures what one call costs against real group-DB files.
 *
 * Usage:
 *   bun packages/library-db-runtime/scripts/bench-publish-guard.ts <library-dir> [multiplier] [iterations]
 *
 * <library-dir> is a desktop `user-data/library` directory holding the five
 * group files (library.{core,metadata,playback,ingest,templates}.sqlite), for
 * example an e2e-ultimate shard's user-data. The files are COPIED to a temp
 * dir; the source is never touched. `multiplier` (default 1) inflates every
 * table by inserting that many suffixed copies of its rows, to approximate a
 * large real library. `iterations` (default 50) is the number of guard calls
 * timed per stage.
 */
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../src/db";
import type * as LibraryDbModule from "../src/libraryDb";

// The implementation module is runtime-selected, hence the dynamic import:
// BENCH_LIBRARY_DB_MODULE points at an alternative copy of libraryDb.ts (for
// example `git show <base>:…/libraryDb.ts` saved next to it) to measure a
// before/after pair in one checkout.
const libraryDbModule = process.env.BENCH_LIBRARY_DB_MODULE ?? "../src/libraryDb";
const { LibraryDb } = (await import(libraryDbModule)) as typeof LibraryDbModule;
console.info(`[bench-publish-guard] implementation=${libraryDbModule}`);

const GROUPS = ["core", "metadata", "playback", "ingest", "templates"] as const;

const [sourceDir, multiplierArg, iterationsArg] = process.argv.slice(2);
if (!sourceDir) {
  console.error("usage: bench-publish-guard.ts <library-dir> [multiplier] [iterations]");
  process.exit(2);
}
const multiplier = Number(multiplierArg ?? 1);
const iterations = Number(iterationsArg ?? 50);

const inflate = (db: SqliteDatabase, copies: number) => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 2) <> '__';")
    .all() as Array<{ name: string }>;
  db.exec("BEGIN");
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info("${name}");`).all() as Array<{
      name: string;
      type: string;
      pk: number;
    }>;
    // Copy from a TEMP snapshot of the original rows so each pass adds one
    // copy (not a doubling); the temp table never lands in the file.
    db.exec(`DROP TABLE IF EXISTS temp.bench_orig; CREATE TEMP TABLE bench_orig AS SELECT * FROM "${name}";`);
    for (let k = 1; k <= copies; k++) {
      const exprs = cols.map((col) => {
        const type = col.type.toUpperCase();
        if (type.includes("INT") && col.pk > 0) return `"${col.name}" + ${k * 1_000_000_000}`;
        if (type.includes("TEXT") || type === "") return `CASE WHEN "${col.name}" IS NULL THEN NULL ELSE "${col.name}" || '|${k}' END`;
        return `"${col.name}"`;
      });
      db.exec(
        `INSERT OR IGNORE INTO main."${name}" (${cols.map((c) => `"${c.name}"`).join(", ")}) ` +
          `SELECT ${exprs.join(", ")} FROM temp.bench_orig;`,
      );
    }
    db.exec("DROP TABLE temp.bench_orig;");
  }
  db.exec("COMMIT");
};

const root = mkdtempSync(join(tmpdir(), "sf-bench-publish-guard-"));
process.env.SF_USER_DATA_PATH = root;
const handles: Record<string, SqliteDatabase> = {};
let totalBytes = 0;
try {
  for (const group of GROUPS) {
    const file = `library.${group}.sqlite`;
    const dest = join(root, file);
    copyFileSync(join(sourceDir, file), dest);
    const db = openDatabase(dest);
    if (multiplier > 1) inflate(db, multiplier - 1);
    handles[group] = db;
    const size = statSync(dest).size;
    totalBytes += size;
    console.info(`[bench-publish-guard] ${group}: ${(size / 1024).toFixed(0)} KiB`);
  }
  console.info(`[bench-publish-guard] total ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, multiplier=${multiplier}`);

  // Bare runtime: the guard only reads the five group handles. Its fields are
  // private, so the bench addresses them through a structural view.
  type GuardRuntime = {
    syncEnabled: boolean;
    db: SqliteDatabase;
    coreDb: SqliteDatabase;
    metadataDb: SqliteDatabase;
    playbackDb: SqliteDatabase;
    ingestDb: SqliteDatabase;
    templatesDb: SqliteDatabase;
    ensurePublishableState(stage: "ops" | "snapshot"): Promise<boolean>;
  };
  const runtime = Object.create(LibraryDb.prototype) as unknown as GuardRuntime;
  runtime.syncEnabled = true;
  runtime.db = handles.core;
  runtime.coreDb = handles.core;
  runtime.metadataDb = handles.metadata;
  runtime.playbackDb = handles.playback;
  runtime.ingestDb = handles.ingest;
  runtime.templatesDb = handles.templates;

  for (const stage of ["ops", "snapshot"] as const) {
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      // Write between calls the way progress saves do between flushes.
      handles.core.exec(
        "CREATE TABLE IF NOT EXISTS bench_progress (k INTEGER PRIMARY KEY, v INTEGER);" +
          `INSERT OR REPLACE INTO bench_progress (k, v) VALUES (1, ${i});`,
      );
      const start = performance.now();
      const ok = await runtime.ensurePublishableState(stage);
      samples.push(performance.now() - start);
      if (!ok) throw new Error(`guard rejected publish at iteration ${i} (stage=${stage})`);
    }
    const first = samples[0]!;
    samples.sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    console.info(
      `[bench-publish-guard] stage=${stage} n=${iterations} first=${first.toFixed(2)}ms ` +
        `mean=${(sum / samples.length).toFixed(2)}ms p50=${samples[Math.floor(samples.length / 2)]!.toFixed(2)}ms ` +
        `p95=${samples[Math.floor(samples.length * 0.95)]!.toFixed(2)}ms max=${samples[samples.length - 1]!.toFixed(2)}ms`,
    );
  }
} finally {
  for (const db of Object.values(handles)) db.close();
  rmSync(root, { recursive: true, force: true });
}
