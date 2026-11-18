/**
 * #25 P10: keep SQLite fsyncs off the runtime's event loop, without giving
 * up crash safety.
 *
 * bun:sqlite / node:sqlite run every statement on the calling thread. With
 * WAL + synchronous=NORMAL a commit does not fsync, but the event loop still
 * fsynced in three places:
 *  - every autocheckpoint (each ~1000 pages): the WAL, then the database;
 *  - the first frame of every WAL generation (a new WAL, or one restarted
 *    after a full checkpoint): the WAL header, plus the directory on that
 *    handle's first sync;
 *  - a brand-new file: the switch to WAL commits through a rollback journal
 *    (journal, directory, database).
 * On a busy or old disk one fsync takes seconds. Ultimate baseline b51ea3c4:
 * the runtime sat in D state in `fsync runtime-data`, `fsync
 * user-data/library`, `fsync library.core.sqlite-wal` and `fsync
 * runtime_jobs.db-wal`, /runtime/health stopped answering and the guardian
 * killed it.
 *
 * Every connection stays WAL + synchronous=NORMAL — the documented
 * crash-safe setting (a power loss may roll back the newest commits, never
 * corrupts the file). Only WHO does the syncing work moves:
 *  1. {@link prepareOffLoopWal} (before the event-loop connection opens): a
 *     worker thread opens the file, switches it to WAL and writes the first
 *     frame of the WAL generation (a same-value `PRAGMA user_version`), so
 *     the journal, header and directory syncs happen on the worker. Those
 *     syncs are what a loaded disk makes slow (0.5-1.8 s per file), so files
 *     prepared together run on separate workers (up to {@link MAX_WORKERS};
 *     a file stays on its worker): one worker ran a library's five files
 *     back to back and a cold open took > 5 s in CI. Releases are batched the
 *     same way ({@link releaseOffLoopWals}).
 *  2. The event-loop connections run with wal_autocheckpoint=0; every
 *     {@link CHECKPOINT_INTERVAL_MS} the worker runs a PASSIVE checkpoint
 *     (the WAL and database fsyncs).
 *  3. A read transaction on a third, event-loop connection (the "pin") keeps
 *     SQLite from restarting the WAL on an event-loop commit after a full
 *     checkpoint: a restart needs every reader slot but 0 free. A read
 *     transaction only takes a slot other than 0 while the WAL holds frames
 *     the database does not. So the pin is (re-)taken, at the WAL's end and
 *     right before a checkpoint, only when an event-loop connection's
 *     `total_changes()` grew since the last pin: such a commit landed past the
 *     old pin's mark, which no checkpoint can pass, so frames remain. Blind
 *     spots: a commit that changes no rows is missed (the re-pin waits a
 *     cycle); changes of a rolled-back transaction still count (a re-pin on a
 *     fully backfilled WAL then lands in slot 0 and allows one WAL restart,
 *     with its header fsync, on the event loop).
 *  4. The WAL is not allowed to grow without bound: past
 *     {@link WAL_RESTART_FRAMES} frames the pin is released, the next
 *     checkpoint backfills everything and the next commit restarts the WAL
 *     from its start (one header fsync on the event loop per ~64 MiB
 *     written, logged). If a checkpoint has been outstanding for
 *     {@link WORKER_STALL_MS} and a WAL passes {@link STALLED_WAL_CAP_BYTES},
 *     that file goes back to SQLite's own autocheckpoint on the event loop
 *     (logged) until the worker answers again.
 *  5. {@link releaseOffLoopWal} (before the last event-loop connection to a
 *     file closes) drops the pin, and waits for the worker to run a final
 *     checkpoint and close its connection, so the event-loop close is the
 *     last one: it finds nothing to backfill and deletes the -wal and -shm.
 *
 * Only under Bun (the runtime). Elsewhere (Electron/Node with better-sqlite3)
 * a worker would load a second SQLite copy into the process, whose POSIX
 * locks break each other's; those connections stay on plain WAL + NORMAL.
 * If the worker dies or cannot open a file, the affected connections go
 * back to SQLite's default autocheckpoint (still NORMAL).
 */
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { scopeLogger } from "./logger";

const log = scopeLogger("wal-checkpointer");
const requireNative = createRequire(import.meta.url);

/** The driver module the event-loop connection was opened with; the worker and the pin use the same one. */
export type SqliteDriverModule = "bun:sqlite" | "node:sqlite";

type ExecDb = {
  exec(sql: string): unknown;
  prepare(sql: string): { get(): unknown; finalize?: () => void };
  /** bun:sqlite only (sqlite3_file_control). */
  fileControl?(op: number, value: number): unknown;
};
type PinDb = { exec(sql: string): unknown; prepare(sql: string): { get(): unknown }; close(): void };

export const CHECKPOINT_INTERVAL_MS = 2_000;
/** Frames (~64 MiB at 4 KiB pages) after which the WAL is let restart. */
export const WAL_RESTART_FRAMES = 16_384;
/** A checkpoint outstanding this long means the worker is stalled. */
export const WORKER_STALL_MS = 30_000;
/** With the worker stalled, a WAL this big moves its checkpoints back onto the event loop. */
export const STALLED_WAL_CAP_BYTES = 64 * 1024 * 1024;
/** A checkpoint at least this slow is logged (the disk is struggling). */
const SLOW_CHECKPOINT_MS = 500;
/** How long a release waits for the worker's final checkpoint and close. */
const RELEASE_WAIT_MS = 10_000;
/** SQLite's default, restored when the worker cannot checkpoint a file. */
const DEFAULT_AUTOCHECKPOINT_PAGES = 1000;
/**
 * Upper bound on checkpoint workers. A prepare is fsync-bound (the journal-mode
 * switch and the first WAL frame): on a loaded disk each one takes 0.5-1.8 s, and
 * `LibraryDb` prepares its five group files at once. One worker ran them back to
 * back (0.8-5.7 s for five, measured); one thread per file in flight lets the
 * disk share its journal commits (0.25-0.37 s for the same five). Six covers the
 * library group plus the runtime jobs file; an idle worker costs ~3 MiB.
 */
const MAX_WORKERS = 6;

export type WalCheckpointResult = {
  path: string;
  ms: number;
  busy?: number;
  log?: number;
  checkpointed?: number;
  error?: string;
};

// CommonJS source run with `eval: true`: no extra bundle entry point, so the
// compiled runtime and `bun build` outputs need no worker file next to them.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { existsSync } = require("node:fs");
const conns = new Map();
const errText = (err) => String((err && err.message) || err);
const openDb = (driver, path, create) => {
  if (driver === "bun:sqlite") {
    const { Database } = require("bun:sqlite");
    return new Database(path, { readwrite: true, create });
  }
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path);
};
const attach = (msg, create) => {
  if (!create && !existsSync(msg.path)) throw new Error("database file missing");
  const db = openDb(msg.driver, msg.path, create);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA synchronous=NORMAL");
    // See persistWalOff below: whichever connection closes last must delete the -wal/-shm.
    if (msg.driver === "bun:sqlite") db.fileControl(require("bun:sqlite").constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    conns.set(msg.path, { db, stmt: db.prepare("PRAGMA wal_checkpoint(PASSIVE)") });
  } catch (err) {
    try { db.close(); } catch {}
    throw err;
  }
  return db;
};
// bun:sqlite's close() is deferred (sqlite3_close_v2) while a prepared
// statement lives: finalize them so the worker's close really closes.
const finalize = (stmt) => { if (stmt && typeof stmt.finalize === "function") stmt.finalize(); };
const getOnce = (db, sql) => {
  const stmt = db.prepare(sql);
  try { return stmt.get(); } finally { finalize(stmt); }
};
const detach = (path) => {
  const c = conns.get(path);
  conns.delete(path);
  if (!c) return;
  finalize(c.stmt);
  c.db.close();
};
const checkpoint = (path) => {
  const startedAt = performance.now();
  const ms = () => Math.round(performance.now() - startedAt);
  const c = conns.get(path);
  if (!c) return { path, ms: 0, error: "not attached" };
  try {
    const row = c.stmt.get();
    return { path, ms: ms(), busy: row.busy, log: row.log, checkpointed: row.checkpointed };
  } catch (err) {
    return { path, ms: ms(), error: errText(err) };
  }
};
parentPort.on("message", (msg) => {
  const startedAt = performance.now();
  const ms = () => Math.round(performance.now() - startedAt);
  if (msg.type === "prepare") {
    try {
      const db = attach(msg, true);
      const mode = getOnce(db, "PRAGMA journal_mode=WAL");
      if (!mode || mode.journal_mode !== "wal") throw new Error("journal_mode is " + JSON.stringify(mode));
      // The first frame of this WAL generation: whoever writes it syncs the
      // WAL header (and the directory). Same value, so nothing changes.
      db.exec("BEGIN IMMEDIATE");
      try {
        const version = Number(getOnce(db, "PRAGMA user_version").user_version);
        db.exec("PRAGMA user_version=" + version);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      parentPort.postMessage({ type: "reply", requestId: msg.requestId, ms: ms() });
    } catch (err) {
      try { detach(msg.path); } catch {}
      parentPort.postMessage({ type: "reply", requestId: msg.requestId, ms: ms(), error: errText(err) });
    }
  } else if (msg.type === "add") {
    try {
      attach(msg, false);
      parentPort.postMessage({ type: "reply", requestId: msg.requestId, ms: ms() });
    } catch (err) {
      parentPort.postMessage({ type: "reply", requestId: msg.requestId, ms: ms(), error: errText(err) });
    }
  } else if (msg.type === "checkpoint") {
    parentPort.postMessage({ type: "reply", requestId: msg.requestId, result: checkpoint(msg.path) });
  } else if (msg.type === "drop") {
    // Nothing attached (its add failed): nothing to checkpoint or close.
    const result = conns.has(msg.path) ? checkpoint(msg.path) : { path: msg.path, ms: 0 };
    let closeError;
    try { detach(msg.path); } catch (err) { closeError = errText(err); }
    Atomics.store(msg.flag, 0, 1);
    Atomics.notify(msg.flag, 0);
    parentPort.postMessage({ type: "dropped", path: msg.path, result, closeError, ms: ms() });
  }
});
`;

type Reply = { type: "reply"; requestId: number; ms?: number; error?: string; result?: WalCheckpointResult };
type WorkerMessage =
  | Reply
  | { type: "dropped"; path: string; result: WalCheckpointResult; closeError?: string; ms: number };

type FileEntry = {
  path: string;
  label: string;
  driver: SqliteDriverModule;
  /** Event-loop connections to this file. */
  conns: Set<ExecDb>;
  /** The worker holds a connection to this file. */
  workerReady: boolean;
  /** The worker that holds this file's connection (a file stays on one worker for life). */
  slot: WorkerSlot | null;
  /** The worker wrote this WAL generation's first frame before the event loop opened the file. */
  prepared: boolean;
  pin: PinDb | null;
  pinHeld: boolean;
  last: WalCheckpointResult | null;
  /** Each event-loop connection's total_changes() when the pin was last taken. */
  changesAtPin: Map<ExecDb, number>;
  /** The pin was released past {@link WAL_RESTART_FRAMES} so the WAL can restart. */
  unpinnedForRestart: boolean;
  /** Unpinned for a restart, a checkpoint backfilled the whole WAL. */
  drained: boolean;
  /** Checkpoints are on the event loop (SQLite's autocheckpoint). */
  onLoop: boolean;
  /** onLoop only until the worker answers again (it was stalled, not dead). */
  onLoopUntilWorkerAnswers: boolean;
  /** Its migrations have run ({@link registerOffLoopWal}); checkpoints start only then. */
  registered: boolean;
};

/** One checkpoint worker thread and the files whose connections it owns. */
type WorkerSlot = { worker: Worker; inflight: Set<number>; failed: boolean };

/** Set by the first worker failure: no new worker starts and no new file goes off the event loop. */
let workerFailed = false;
const slots: WorkerSlot[] = [];
let nextRequestId = 1;
const pending = new Map<number, { slot: WorkerSlot; resolve: (reply: Reply) => void }>();
const entries = new Map<string, FileEntry>();
const entryByDb = new WeakMap<object, FileEntry>();
let cycleTimerStarted = false;
let cycle: Promise<WalCheckpointResult[]> | null = null;
/** Attaches of unprepared files still waiting on the worker's answer. */
const attaching = new Set<Promise<void>>();
let checkpointSentAt: number | null = null;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isOffLoopPath = (path: string) => process.versions.bun !== undefined && path !== ":memory:" && path !== "";

const setAutocheckpoint = (entry: FileEntry, pages: number) => {
  for (const db of entry.conns) {
    try {
      db.exec(`PRAGMA wal_autocheckpoint=${pages}`);
    } catch (error) {
      // Already closed by its owner: nothing left to protect.
      log.warn({ path: entry.path, label: entry.label, pages, error: errorText(error) }, "sqlite autocheckpoint switch skipped");
    }
  }
};

/** Each event-loop connection's `total_changes()`: grows with every commit that changed rows. */
const changesOf = (entry: FileEntry): Map<ExecDb, number> => {
  const changes = new Map<ExecDb, number>();
  for (const db of entry.conns) {
    const stmt = db.prepare("SELECT total_changes() AS n");
    const row = stmt.get() as { n?: number | bigint } | null | undefined;
    stmt.finalize?.();
    changes.set(db, Number(row?.n ?? 0));
  }
  return changes;
};

/**
 * Whether an event-loop connection committed row changes since the pin was
 * taken (a connection added since counts from 0: it opened after the pin).
 * Commits that change no rows (DDL, pragmas) are not seen; missing one only
 * delays a re-pin by a cycle.
 */
const committedSincePin = (entry: FileEntry): boolean => {
  for (const [db, n] of changesOf(entry)) {
    if (n > (entry.changesAtPin.get(db) ?? 0)) return true;
  }
  return false;
};

const releasePin = (entry: FileEntry) => {
  if (!entry.pin || !entry.pinHeld) return;
  entry.pinHeld = false;
  try {
    entry.pin.exec("COMMIT");
  } catch (error) {
    log.warn({ path: entry.path, label: entry.label, error: errorText(error) }, "sqlite wal pin release failed");
  }
};

const closePin = (entry: FileEntry) => {
  releasePin(entry);
  try {
    entry.pin?.close();
  } catch (error) {
    log.warn({ path: entry.path, label: entry.label, error: errorText(error) }, "sqlite wal pin close failed");
  }
  entry.pin = null;
};

/** Begin (or re-begin) the pin's read transaction at the WAL's current end. */
const takePin = (entry: FileEntry) => {
  releasePin(entry);
  try {
    if (!entry.pin) {
      // Same driver module as the event-loop connection: a second SQLite copy
      // in the process would break the file's POSIX locks.
      let pin: PinDb;
      if (entry.driver === "bun:sqlite") {
        const bunSqlite = requireNative("bun:sqlite") as { Database: new (p: string, o: object) => PinDb };
        pin = new bunSqlite.Database(entry.path, { readwrite: true, create: false });
      } else {
        const nodeSqlite = requireNative("node:sqlite") as { DatabaseSync: new (p: string) => PinDb };
        pin = new nodeSqlite.DatabaseSync(entry.path);
      }
      pin.exec("PRAGMA busy_timeout=1000");
      entry.pin = pin;
    }
    // The read starts the transaction's snapshot (BEGIN alone is deferred).
    // exec, not prepare: no statement outlives the pin's close.
    entry.pin.exec("BEGIN");
    entry.pin.exec("SELECT count(*) FROM sqlite_schema");
    entry.pinHeld = true;
    entry.changesAtPin = changesOf(entry);
  } catch (error) {
    log.warn({ path: entry.path, label: entry.label, error: errorText(error) }, "sqlite wal pin failed (the next commit may restart the WAL on the event loop)");
    closePin(entry);
  }
};

const moveOnLoop = (entry: FileEntry, reason: string, untilWorkerAnswers: boolean) => {
  if (entry.onLoop) return;
  entry.onLoop = true;
  entry.onLoopUntilWorkerAnswers = untilWorkerAnswers;
  closePin(entry);
  entry.unpinnedForRestart = false;
  entry.drained = false;
  setAutocheckpoint(entry, DEFAULT_AUTOCHECKPOINT_PAGES);
  log.warn({ path: entry.path, label: entry.label, reason, untilWorkerAnswers }, "sqlite checkpoints back on the event loop");
};

const moveOffLoop = (entry: FileEntry) => {
  entry.onLoop = false;
  entry.onLoopUntilWorkerAnswers = false;
  setAutocheckpoint(entry, 0);
  log.info({ path: entry.path, label: entry.label }, "sqlite checkpoints back on the worker");
};

const failWorker = (reason: string, slot?: WorkerSlot) => {
  if (slot) {
    if (slot.failed) return;
    slot.failed = true;
    slots.splice(slots.indexOf(slot), 1);
  }
  workerFailed = true;
  const owned = [...entries.values()].filter((entry) => entry.slot === slot);
  log.error({ reason, files: owned.length }, "sqlite checkpoint worker failed");
  for (const entry of owned) {
    entry.workerReady = false;
    moveOnLoop(entry, reason, false);
  }
  for (const [requestId, waiter] of pending) {
    if (waiter.slot !== slot) continue;
    pending.delete(requestId);
    waiter.resolve({ type: "reply", requestId: -1, error: reason });
  }
};

const startWorker = (): WorkerSlot | null => {
  try {
    const created = new Worker(WORKER_SOURCE, { eval: true });
    const slot: WorkerSlot = { worker: created, inflight: new Set(), failed: false };
    created.on("message", (msg: WorkerMessage) => {
      if (msg.type === "reply") {
        const waiter = pending.get(msg.requestId);
        pending.delete(msg.requestId);
        slot.inflight.delete(msg.requestId);
        // Idle, the checkpointer must never keep the runtime alive.
        if (slot.inflight.size === 0) created.unref();
        waiter?.resolve(msg);
      } else if (msg.type === "dropped") {
        const data = { ...msg.result, closeError: msg.closeError, totalMs: msg.ms };
        if (msg.result.error || msg.closeError) log.warn(data, "sqlite final checkpoint on the worker failed");
        else log.info(data, "sqlite file released by the checkpoint worker");
      }
    });
    created.on("error", (error) => failWorker(errorText(error), slot));
    created.on("exit", (code) => failWorker(`worker exited with code ${code}`, slot));
    created.unref();
    slots.push(slot);
    log.info({ workers: slots.length, intervalMs: CHECKPOINT_INTERVAL_MS, restartFrames: WAL_RESTART_FRAMES }, "sqlite checkpoint worker started");
    return slot;
  } catch (error) {
    failWorker(errorText(error));
    return null;
  }
};

/**
 * The worker for a file that is about to be set up: an idle one, else a new
 * one (up to {@link MAX_WORKERS}), else the least busy. Setups are fsync-bound
 * and must not queue behind each other, see {@link MAX_WORKERS}.
 */
const pickWorker = (): WorkerSlot | null => {
  if (workerFailed) return null;
  const idle = slots.find((slot) => slot.inflight.size === 0);
  if (idle) return idle;
  if (slots.length < MAX_WORKERS) return startWorker();
  return slots.reduce<WorkerSlot | null>((least, slot) => (least === null || slot.inflight.size < least.inflight.size ? slot : least), null);
};

const request = (slot: WorkerSlot, msg: Record<string, unknown>): Promise<Reply> => {
  if (slot.failed) return Promise.resolve({ type: "reply", requestId: -1, error: "no checkpoint worker" });
  const requestId = nextRequestId++;
  // Not Promise.withResolvers: the desktop tsconfig's lib predates ES2024.
  const promise = new Promise<Reply>((resolve) => {
    pending.set(requestId, { slot, resolve });
  });
  slot.inflight.add(requestId);
  // Awaited by the caller: keep the process alive until the worker answers.
  slot.worker.ref();
  slot.worker.postMessage({ ...msg, requestId });
  return promise;
};

const watchForStall = () => {
  if (checkpointSentAt === null || performance.now() - checkpointSentAt < WORKER_STALL_MS) return;
  for (const entry of entries.values()) {
    if (entry.onLoop) continue;
    const walBytes = statSync(`${entry.path}-wal`, { throwIfNoEntry: false })?.size ?? 0;
    if (walBytes >= STALLED_WAL_CAP_BYTES) {
      moveOnLoop(entry, `checkpoint worker stalled for ${Math.round(performance.now() - checkpointSentAt)} ms, WAL at ${walBytes} bytes`, true);
    }
  }
};

const checkpointEntry = async (entry: FileEntry): Promise<WalCheckpointResult | null> => {
  const slot = entry.slot;
  if (!slot || !entry.registered || !entry.workerReady || entry.onLoop) return null;
  // Pin first (no checkpoint runs between here and the request below). A
  // commit counted since the last pin landed past that pin's read-mark, which
  // the checkpoint cannot pass, so frames remain and a new pin takes a slot
  // other than 0. No counted commit: keep the pin (re-taking it on a fully
  // backfilled WAL would land in slot 0 and stop blocking restarts).
  const committed = committedSincePin(entry);
  if (entry.unpinnedForRestart) {
    // Unpinned past the cap: once a full checkpoint drained the WAL, the next
    // commit restarted it from frame 1; pin that new generation.
    if (committed && entry.drained) {
      log.info({ path: entry.path, label: entry.label, framesBefore: entry.last?.log }, "sqlite wal restarted; pinned again");
      entry.unpinnedForRestart = false;
      entry.drained = false;
      takePin(entry);
    } else if (!entry.drained) {
      // Count commits from this (draining) checkpoint on.
      entry.changesAtPin = changesOf(entry);
    }
  } else if (committed || !entry.pinHeld) {
    takePin(entry);
  }
  checkpointSentAt = performance.now();
  const reply = await request(slot, { type: "checkpoint", path: entry.path });
  checkpointSentAt = null;
  const result = reply.result ?? { path: entry.path, ms: 0, error: reply.error ?? "no result" };
  if (entries.get(entry.path) !== entry) return result;
  entry.last = result;
  if (result.error || result.ms >= SLOW_CHECKPOINT_MS) {
    log.warn({ ...result, label: entry.label }, result.error ? "sqlite checkpoint failed" : "sqlite checkpoint slow (off the event loop)");
  }
  const complete = !result.error && !result.busy && result.checkpointed === result.log;
  if (entry.unpinnedForRestart) {
    // Unpinned, a complete checkpoint leaves nothing to backfill: the next commit restarts the WAL.
    if (complete) entry.drained = true;
  } else if ((result.log ?? 0) >= WAL_RESTART_FRAMES) {
    entry.unpinnedForRestart = true;
    // Complete: the commits counted from this pass's pin on restart the WAL.
    entry.drained = complete;
    releasePin(entry);
    log.info(
      { path: entry.path, label: entry.label, frames: result.log, restartFrames: WAL_RESTART_FRAMES },
      "sqlite wal at its size cap; unpinned so it can restart (one WAL-header fsync on the event loop)"
    );
  }
  return result;
};

const runCycle = (): Promise<WalCheckpointResult[]> => {
  if (cycle) {
    watchForStall();
    return cycle;
  }
  const run = async () => {
    const results: WalCheckpointResult[] = [];
    try {
      for (const entry of [...entries.values()]) {
        const result = await checkpointEntry(entry);
        if (result) results.push(result);
      }
      // The worker answers again: files moved on-loop by a stall come back.
      for (const entry of entries.values()) {
        if (entry.onLoop && entry.onLoopUntilWorkerAnswers && entry.workerReady) moveOffLoop(entry);
      }
    } catch (error) {
      log.error({ error: errorText(error) }, "sqlite checkpoint cycle failed");
    }
    return results;
  };
  // Reset in a `finally` callback, which always runs after `cycle` is set
  // (an in-body reset ran first when no file needed a checkpoint, leaving a
  // settled pass in `cycle` that every later pass returned).
  const pass: Promise<WalCheckpointResult[]> = run().finally(() => {
    if (cycle === pass) cycle = null;
  });
  cycle = pass;
  return pass;
};

const ensureCycleTimer = () => {
  if (cycleTimerStarted) return;
  cycleTimerStarted = true;
  setInterval(() => void runCycle(), CHECKPOINT_INTERVAL_MS).unref?.();
};

const newEntry = (path: string, driver: SqliteDriverModule, label: string, slot: WorkerSlot): FileEntry => ({
  path,
  label,
  driver,
  conns: new Set(),
  workerReady: false,
  slot,
  prepared: false,
  pin: null,
  pinHeld: false,
  last: null,
  changesAtPin: new Map(),
  unpinnedForRestart: false,
  drained: false,
  onLoop: false,
  onLoopUntilWorkerAnswers: false,
  registered: false,
});

/**
 * Call BEFORE opening the event-loop connection to `path` (it may not exist
 * yet): the worker opens or creates the file, switches it to WAL and writes
 * the first frame of the WAL generation, so those syncs happen off the
 * event loop. No-op outside Bun, when another event-loop connection already
 * has the file open, or when the worker is unavailable (the file then gets
 * set up on the event loop, see {@link registerOffLoopWal}).
 */
export const prepareOffLoopWal = async (
  path: string,
  opts: { driver: SqliteDriverModule; label: string }
): Promise<void> => {
  const slot = isOffLoopPath(path) && !entries.has(path) ? pickWorker() : null;
  if (!slot) return;
  const startedAt = performance.now();
  // Claim the path now: a second prepare for it must not write behind us.
  const entry = newEntry(path, opts.driver, opts.label, slot);
  entries.set(path, entry);
  const reply = await request(slot, { type: "prepare", path, driver: opts.driver });
  if (reply.error) {
    entries.delete(path);
    log.warn({ path, label: opts.label, error: reply.error }, "sqlite file not prepared off the event loop (first commit syncs on it)");
    return;
  }
  entry.workerReady = true;
  entry.prepared = true;
  ensureCycleTimer();
  log.info({ path, label: opts.label, ms: Math.round(performance.now() - startedAt), workerMs: reply.ms }, "sqlite file prepared off the event loop");
};

/**
 * The last close of a WAL file deletes its -wal and -shm (step 5 above) only
 * while SQLITE_FCNTL_PERSIST_WAL is off. That is SQLite's default, but a
 * system SQLite may be built with it on: Apple's is, and bun:sqlite uses the
 * system SQLite on macOS. node:sqlite bundles its own SQLite.
 *
 * Keyed on the connection, not only the declared driver: callers name the
 * driver the off-loop worker would use (`bun:sqlite` for the library files),
 * but outside Bun (Electron's direct-SQLite mode) the connection is
 * better-sqlite3, which bundles its own SQLite, has no `fileControl`, and
 * `bun:sqlite` cannot be loaded.
 */
const persistWalOff = (db: ExecDb, driver: SqliteDriverModule): void => {
  if (driver !== "bun:sqlite" || typeof db.fileControl !== "function") return;
  const { constants } = requireNative("bun:sqlite") as { constants: { SQLITE_FCNTL_PERSIST_WAL: number } };
  db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
};

/**
 * Put a freshly opened file-backed connection in WAL + synchronous=NORMAL.
 * Call right after opening, before any other statement. If the file was
 * prepared ({@link prepareOffLoopWal}) the connection also stops
 * autocheckpointing (the worker checkpoints). Call
 * {@link registerOffLoopWal} once its migrations have run.
 */
export const enableOffLoopWal = (db: ExecDb, opts: { path: string; driver: SqliteDriverModule; label: string }): void => {
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA journal_mode=WAL");
  persistWalOff(db, opts.driver);
  const entry = isOffLoopPath(opts.path) ? entries.get(opts.path) : undefined;
  if (!entry || !entry.workerReady || entry.onLoop) return;
  db.exec("PRAGMA wal_autocheckpoint=0");
  entry.conns.add(db);
  entryByDb.set(db, entry);
};

/**
 * Call once the connection's migrations have run: hands its checkpoints to
 * the worker. A file that was not prepared is attached to the worker only
 * now, so the worker never opens it while it is still being migrated.
 */
export const registerOffLoopWal = (db: ExecDb, opts: { path: string; driver: SqliteDriverModule; label: string }): void => {
  if (!isOffLoopPath(opts.path)) return;
  let entry = entryByDb.get(db) ?? entries.get(opts.path);
  if (!entry) {
    const slot = pickWorker();
    if (!slot) return;
    const attached = newEntry(opts.path, opts.driver, opts.label, slot);
    entry = attached;
    entries.set(opts.path, attached);
    const attach = request(slot, { type: "add", path: opts.path, driver: opts.driver }).then((reply) => {
      attaching.delete(attach);
      if (entries.get(attached.path) !== attached) return;
      if (reply.error) {
        moveOnLoop(attached, `worker could not open the file: ${reply.error}`, false);
        return;
      }
      attached.workerReady = true;
      log.info({ path: attached.path, label: attached.label, workerMs: reply.ms }, "sqlite file attached to the checkpoint worker");
    });
    attaching.add(attach);
  }
  if (!entry.conns.has(db)) {
    entry.conns.add(db);
    entryByDb.set(db, entry);
  }
  entry.registered = true;
  if (entry.onLoop) {
    db.exec(`PRAGMA wal_autocheckpoint=${DEFAULT_AUTOCHECKPOINT_PAGES}`);
    return;
  }
  db.exec("PRAGMA wal_autocheckpoint=0");
  if (!entry.pinHeld && !entry.unpinnedForRestart) takePin(entry);
  ensureCycleTimer();
  log.info(
    { path: entry.path, label: entry.label, prepared: entry.prepared, conns: entry.conns.size, pinned: entry.pinHeld },
    "sqlite checkpoints off the event loop"
  );
};

/**
 * Call before closing a connection set up by {@link enableOffLoopWal}. For
 * the file's last event-loop connection: drops the pin, then waits (up to
 * {@link RELEASE_WAIT_MS}) for the worker to checkpoint and close its own
 * connection, so the caller's close is the last one and removes the -wal and
 * -shm. No-op for a connection that is not registered.
 */
export const releaseOffLoopWal = (db: ExecDb): void => {
  releaseOffLoopWals([db]);
};

/**
 * {@link releaseOffLoopWal} for a group of connections: every file's final
 * checkpoint starts before the first wait, so they run in parallel on their
 * workers (each is fsync-bound; serial waits summed to seconds on a busy disk).
 */
export const releaseOffLoopWals = (dbs: readonly ExecDb[]): void => {
  const waits: Array<() => void> = [];
  for (const db of dbs) {
    const entry = entryByDb.get(db);
    if (!entry) continue;
    entryByDb.delete(db);
    entry.conns.delete(db);
    if (entry.conns.size > 0) continue;
    const wait = startDrop(entry);
    if (wait) waits.push(wait);
  }
  for (const wait of waits) wait();
};

/**
 * Call when an open that ran {@link prepareOffLoopWal} for `path` failed
 * before any event-loop connection used it: the worker checkpoints and closes
 * its connection (no-op once a connection uses the file).
 */
export const abandonPreparedOffLoopWal = (path: string): void => {
  abandonPreparedOffLoopWals([path]);
};

/** {@link abandonPreparedOffLoopWal} for several files, released in parallel. */
export const abandonPreparedOffLoopWals = (paths: readonly string[]): void => {
  const waits: Array<() => void> = [];
  for (const path of paths) {
    const entry = entries.get(path);
    if (!entry || entry.conns.size > 0) continue;
    log.info({ path, label: entry.label }, "sqlite file prepared but never opened; worker lets it go");
    const wait = startDrop(entry);
    if (wait) waits.push(wait);
  }
  for (const wait of waits) wait();
};

/**
 * Drops the entry and asks its worker for the final checkpoint and close.
 * Returns the wait for the worker's answer (null: no worker to wait for).
 */
const startDrop = (entry: FileEntry): (() => void) | null => {
  if (entries.get(entry.path) === entry) entries.delete(entry.path);
  closePin(entry);
  const slot = entry.slot;
  if (!slot || slot.failed) return null;
  const startedAt = performance.now();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  slot.worker.postMessage({ type: "drop", path: entry.path, flag });
  return () => {
    const outcome = Atomics.wait(flag, 0, 0, RELEASE_WAIT_MS);
    const waitedMs = Math.round(performance.now() - startedAt);
    if (outcome === "timed-out") {
      log.warn({ path: entry.path, label: entry.label, waitedMs }, "sqlite checkpoint worker did not release the file in time; closing anyway");
    } else if (waitedMs >= SLOW_CHECKPOINT_MS) {
      log.warn({ path: entry.path, label: entry.label, waitedMs }, "sqlite release waited on a slow final checkpoint");
    }
  };
};

/**
 * Run one checkpoint pass over every registered file now (after pending
 * attaches and the pass in flight, if any) and return the per-file results
 * ([] without a worker). For tests and diagnostics; production relies on the
 * interval.
 */
export const checkpointOffLoopWalNow = async (): Promise<WalCheckpointResult[]> => {
  await Promise.all([...attaching]);
  if (cycle) await cycle;
  return runCycle();
};
