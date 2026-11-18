/**
 * @bugfix @regression-proof #25
 *
 * `ensurePublishableState` gates every ops flush (about once a second while
 * playback progress is saved) and used to run a full `PRAGMA integrity_check`
 * on all five group DBs each time, synchronously on the runtime main thread.
 * The check exists so a corrupt local file is never published (commit
 * 7b1a4520 "publish guard": quarantine instead of uploading). These tests pin
 * both halves of the fix:
 *   - N flushes on an unchanged handle run the full check once per group, not
 *     N times;
 *   - corruption is still caught where it can actually appear: a reopened
 *     handle (cold boot / crash recovery / snapshot-apply reopen), a file
 *     changed under the handle, and every snapshot publish.
 *
 * Real file-backed SQLite handles, wrapped only to count the SQL issued.
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openDatabase, type SqliteDatabase } from "../src/db";
import { LibraryDb } from "../src/libraryDb";

const GROUPS = ["core", "metadata", "playback", "ingest", "templates"] as const;
type Group = (typeof GROUPS)[number];

type GuardRuntime = {
  syncEnabled: boolean;
  closed: boolean;
  db: SqliteDatabase;
  coreDb: SqliteDatabase | null;
  metadataDb: SqliteDatabase | null;
  playbackDb: SqliteDatabase | null;
  ingestDb: SqliteDatabase | null;
  templatesDb: SqliteDatabase | null;
  ensurePublishableState(stage: "ops" | "snapshot" | "pending-snapshot"): Promise<boolean>;
};

type CountingHandle = {
  handle: SqliteDatabase;
  raw: SqliteDatabase;
  path: string;
  sql: string[];
  integrityChecks: () => number;
};

let root = "";
const opened: SqliteDatabase[] = [];

const log = (label: string, message: string) => console.info(`[publish-guard-integrity-cache:${label}] ${message}`);

/** Wrap a real handle so every prepare() is recorded; everything else delegates. */
const countingHandle = (path: string): CountingHandle => {
  const raw = openDatabase(path);
  // No fsync per commit: keeps the 25-flush loop fast on a loaded CI box;
  // data_version and integrity_check behave the same.
  raw.exec("PRAGMA synchronous = OFF");
  opened.push(raw);
  const sql: string[] = [];
  const handle = {
    prepare: (statement: string) => {
      sql.push(statement.replace(/\s+/g, " ").trim());
      return raw.prepare(statement);
    },
    exec: (statement: string) => raw.exec(statement),
    close: () => raw.close(),
    serialize: () => raw.serialize(),
  } satisfies SqliteDatabase;
  return {
    handle,
    raw,
    path,
    sql,
    integrityChecks: () => sql.filter((s) => /PRAGMA integrity_check/i.test(s)).length,
  };
};

const seedGroup = (group: Group, path: string) => {
  const db = openDatabase(path);
  db.exec("PRAGMA synchronous = OFF");
  db.exec("CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY, label TEXT NOT NULL);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_filler_label ON filler(label);");
  db.exec("BEGIN");
  for (let i = 1; i <= 50; i++) {
    db.exec(`INSERT INTO filler (id, label) VALUES (${i}, 'label-${String(i).padStart(4, "0")}');`);
  }
  db.exec("COMMIT");
  if (group === "core") {
    db.exec("CREATE TABLE media_items (id TEXT PRIMARY KEY, title TEXT);");
    db.exec("INSERT INTO media_items (id, title) VALUES ('m1', 'Movie');");
  }
  if (group === "playback") {
    db.exec("CREATE TABLE media_formats (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, label TEXT);");
    db.exec("CREATE INDEX idx_formats_media ON media_formats(media_id);");
    db.exec("CREATE TABLE media_audio_tracks (id TEXT PRIMARY KEY, media_id TEXT NOT NULL);");
    db.exec("INSERT INTO media_formats (id, media_id, label) VALUES ('f0', 'm1', 'format-0'), ('f1', 'm1', 'format-1');");
  }
  db.close();
};

const buildRuntime = (label: string) => {
  const handles = {} as Record<Group, CountingHandle>;
  for (const group of GROUPS) {
    const path = join(root, "library", `library.${group}.sqlite`);
    seedGroup(group, path);
    handles[group] = countingHandle(path);
  }
  const runtime = Object.create(LibraryDb.prototype) as unknown as GuardRuntime;
  runtime.syncEnabled = true;
  runtime.closed = false;
  runtime.db = handles.core.handle;
  runtime.coreDb = handles.core.handle;
  runtime.metadataDb = handles.metadata.handle;
  runtime.playbackDb = handles.playback.handle;
  runtime.ingestDb = handles.ingest.handle;
  runtime.templatesDb = handles.templates.handle;
  log(label, `runtime built over ${GROUPS.length} real group files under ${join(root, "library")}`);
  return { runtime, handles };
};

const integrityCounts = (handles: Record<Group, CountingHandle>) =>
  Object.fromEntries(GROUPS.map((group) => [group, handles[group].integrityChecks()])) as Record<Group, number>;

const quarantineLogPath = () => join(root, "library", "quarantine-log.jsonl");

const dump = (label: string, runtime: GuardRuntime, handles: Record<Group, CountingHandle>) => {
  console.error(`=== [publish-guard-integrity-cache:${label}] snapshot ===`);
  console.error(`syncEnabled=${runtime.syncEnabled}`);
  console.error(`integrity_check counts=${JSON.stringify(integrityCounts(handles))}`);
  for (const group of GROUPS) {
    const sql = handles[group].sql;
    console.error(`  ${group}: ${sql.length} statements, last 6: ${JSON.stringify(sql.slice(-6))}`);
  }
  const quarantineLog = quarantineLogPath();
  if (existsSync(quarantineLog)) console.error(`${quarantineLog}:\n${readFileSync(quarantineLog, "utf8")}`);
};

/**
 * Rewrite one key inside the (single, leaf) root page of
 * `idx_filler_label` — `label-0025` becomes `label-0024` — and bump the
 * header's file change counter, the way a damaged sector or torn write looks
 * to SQLite. The b-tree stays readable, so ordinary queries keep working;
 * only a structural check notices that row 25 is missing from the index.
 * A live handle sees the file changed (data_version moves).
 */
const corruptIndexOnDisk = (path: string) => {
  const probe = openDatabase(path);
  const { rootpage } = probe
    .prepare("SELECT rootpage FROM sqlite_master WHERE name = 'idx_filler_label';")
    .get() as { rootpage: number };
  const { page_size: pageSize } = probe.prepare("PRAGMA page_size;").get() as { page_size: number };
  probe.close();
  const file = readFileSync(path);
  const changeCounter = file.readUInt32BE(24);
  const pageStart = (rootpage - 1) * pageSize;
  const page = file.subarray(pageStart, pageStart + pageSize);
  const keyOffset = page.indexOf("label-0025");
  if (keyOffset < 0) throw new Error(`label-0025 not found in idx_filler_label root page ${rootpage}`);
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.from("label-0024"), 0, 10, pageStart + keyOffset);
    const bumped = Buffer.alloc(4);
    bumped.writeUInt32BE(changeCounter + 1, 0);
    writeSync(fd, bumped, 0, 4, 24);
  } finally {
    closeSync(fd);
  }
  return { rootpage, pageSize, keyOffset, changeCounter };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-guard-integrity-cache-"));
  process.env.SF_USER_DATA_PATH = root;
  mkdirSync(join(root, "library"), { recursive: true });
  log("setup", `root=${root}`);
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  log("teardown", `removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

describe("publish guard integrity_check cost (#25)", () => {
  it("N ops flushes on unchanged handles run integrity_check once per group, not N times", async () => {
    const { runtime, handles } = buildRuntime("n-flushes");
    const flushes = 25;
    try {
      for (let i = 0; i < flushes; i++) {
        // Progress saves write through the runtime's own handle between flushes.
        handles.playback.raw.exec(`UPDATE media_formats SET label = 'progress-${i}' WHERE id = 'f0';`);
        handles.core.raw.exec(`UPDATE media_items SET title = 'Movie ${i}' WHERE id = 'm1';`);
        const ok = await runtime.ensurePublishableState("ops");
        if (!ok) throw new Error(`guard rejected flush ${i}`);
      }
      const counts = integrityCounts(handles);
      log("n-flushes", `after ${flushes} flushes integrity_check counts=${JSON.stringify(counts)}`);
      for (const group of GROUPS) expect(counts[group]).toBe(1);
      expect(runtime.syncEnabled).toBe(true);
    } catch (err) {
      dump("n-flushes", runtime, handles);
      throw err;
    }
  });

  it("every snapshot publish re-runs the full check even when ops verdicts are cached", async () => {
    const { runtime, handles } = buildRuntime("snapshot-forced");
    try {
      expect(await runtime.ensurePublishableState("ops")).toBe(true);
      expect(await runtime.ensurePublishableState("ops")).toBe(true);
      expect(await runtime.ensurePublishableState("snapshot")).toBe(true);
      expect(await runtime.ensurePublishableState("pending-snapshot")).toBe(true);
      const counts = integrityCounts(handles);
      log("snapshot-forced", `counts=${JSON.stringify(counts)}`);
      for (const group of GROUPS) expect(counts[group]).toBe(3);
    } catch (err) {
      dump("snapshot-forced", runtime, handles);
      throw err;
    }
  });

  it("a file changed by another connection is re-checked on the next ops flush (that group only)", async () => {
    const { runtime, handles } = buildRuntime("foreign-writer");
    try {
      expect(await runtime.ensurePublishableState("ops")).toBe(true);
      const before = integrityCounts(handles);
      const foreign = openDatabase(handles.playback.path);
      foreign.exec("PRAGMA synchronous = OFF");
      foreign.exec("INSERT INTO media_audio_tracks (id, media_id) VALUES ('a1', 'm1');");
      foreign.close();
      log("foreign-writer", "second connection committed a row to library.playback.sqlite");
      expect(await runtime.ensurePublishableState("ops")).toBe(true);
      const after = integrityCounts(handles);
      log("foreign-writer", `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
      for (const group of GROUPS) {
        expect(after[group]).toBe(before[group] + (group === "playback" ? 1 : 0));
      }
    } catch (err) {
      dump("foreign-writer", runtime, handles);
      throw err;
    }
  });

  it("on-disk corruption under a verified handle still blocks the next ops publish", async () => {
    const { runtime, handles } = buildRuntime("corrupt-live");
    try {
      expect(await runtime.ensurePublishableState("ops")).toBe(true);
      const info = corruptIndexOnDisk(handles.playback.path);
      log("corrupt-live", `corrupted playback index root page ${JSON.stringify(info)}`);
      const ok = await runtime.ensurePublishableState("ops");
      log("corrupt-live", `result=${ok} syncEnabled=${runtime.syncEnabled}`);
      expect(ok).toBe(false);
      expect(runtime.syncEnabled).toBe(false);
      expect(readFileSync(quarantineLogPath(), "utf8")).toContain("integrity_check_failed:playback");
    } catch (err) {
      dump("corrupt-live", runtime, handles);
      throw err;
    }
  });

  it("a reopened handle over a corrupt file is checked before its first ops publish", async () => {
    const { runtime, handles } = buildRuntime("corrupt-reopen");
    try {
      expect(await runtime.ensurePublishableState("ops")).toBe(true);
      // Crash recovery / snapshot apply: the handle is closed and reopened
      // over whatever is on disk now.
      handles.playback.raw.close();
      const info = corruptIndexOnDisk(handles.playback.path);
      log("corrupt-reopen", `corrupted closed playback file ${JSON.stringify(info)}; reopening`);
      const reopened = countingHandle(handles.playback.path);
      handles.playback = reopened;
      runtime.playbackDb = reopened.handle;
      const ok = await runtime.ensurePublishableState("ops");
      log("corrupt-reopen", `result=${ok} syncEnabled=${runtime.syncEnabled} reopened checks=${reopened.integrityChecks()}`);
      expect(reopened.integrityChecks()).toBe(1);
      expect(ok).toBe(false);
      expect(runtime.syncEnabled).toBe(false);
      expect(readFileSync(quarantineLogPath(), "utf8")).toContain("integrity_check_failed:playback");
    } catch (err) {
      dump("corrupt-reopen", runtime, handles);
      throw err;
    }
  });
});
