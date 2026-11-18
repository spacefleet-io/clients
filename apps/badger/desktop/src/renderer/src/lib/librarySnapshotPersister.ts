import type { LibrarySnapshot } from "@/lib/libraryDb";

/**
 * Schedules the cold-start library snapshot cache write (issue #25).
 *
 * The cache is a full `JSON.stringify` of the library (~1 MB on a real
 * library) plus a synchronous `localStorage.setItem`, both on the renderer
 * main thread. Library state changes every ~500 ms during playback (progress
 * writes) and during ingest (job progress), so the write must be:
 *
 *   - coalesced: a change only records a lazy getter; nothing is serialized
 *     until a write is actually due, and only the latest state is written;
 *   - bounded: a quiet window (`quietMs`) after the last change, capped by
 *     `maxStaleMs` after the first unsaved change so continuous churn cannot
 *     starve the write forever (the previous trailing debounce never fired
 *     while playback kept resetting it);
 *   - off the critical path: the due write runs in `requestIdleCallback`
 *     (bounded by `idleTimeoutMs`) instead of a raw timer;
 *   - flushable: `flush()` writes synchronously, for pagehide and for the
 *     main process's close-to-tray / quit handshake (`win.destroy()` skips
 *     pagehide entirely);
 *   - cancellable: `cancel()` drops a pending write so logout / cache reset
 *     cannot resurrect a cache they just cleared.
 */

export type SnapshotPersistReason = "idle" | "flush";

export type SnapshotPersistEvent =
  | { event: "scheduled"; dueInMs: number; dirtyForMs: number; changes: number }
  | { event: "persisted"; reason: SnapshotPersistReason | string; durationMs: number; changes: number; dirtyForMs: number }
  | { event: "skipped"; reason: string }
  | { event: "cancelled"; changes: number }
  | { event: "error"; reason: string; error: string };

// Renderer (DOM) timer and idle-callback ids are both plain numbers.
type TimerHandle = number;
type IdleHandle = number;

export type LibrarySnapshotPersisterOptions = {
  /** The expensive write. Called with the latest snapshot only. */
  save: (snapshot: LibrarySnapshot) => void;
  /** Quiet window after the most recent change before a write is due. */
  quietMs?: number;
  /** Upper bound on how long an unsaved change may wait under continuous churn. */
  maxStaleMs?: number;
  /** Deadline handed to requestIdleCallback once the write is due. */
  idleTimeoutMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  requestIdle?: (fn: () => void, options: { timeout: number }) => IdleHandle;
  cancelIdle?: (handle: IdleHandle) => void;
  log?: (entry: SnapshotPersistEvent) => void;
};

export type LibrarySnapshotPersister = {
  /** Record that library state changed; `getSnapshot` is only called when a write is due. */
  markDirty: (getSnapshot: () => LibrarySnapshot) => void;
  /** Write the pending snapshot now (synchronously). Returns true when something was written. */
  flush: (reason?: string) => boolean;
  /** Drop the pending snapshot without writing it. */
  cancel: () => void;
  hasPending: () => boolean;
};

export const SNAPSHOT_PERSIST_QUIET_MS = 10_000;
export const SNAPSHOT_PERSIST_MAX_STALE_MS = 60_000;
export const SNAPSHOT_PERSIST_IDLE_TIMEOUT_MS = 5_000;

const defaultRequestIdle = (fn: () => void, options: { timeout: number }): IdleHandle =>
  typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback(() => fn(), options)
    : window.setTimeout(fn, 0);

const defaultCancelIdle = (handle: IdleHandle) => {
  if (typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle);
    return;
  }
  window.clearTimeout(handle);
};

export const createLibrarySnapshotPersister = (
  options: LibrarySnapshotPersisterOptions
): LibrarySnapshotPersister => {
  const quietMs = options.quietMs ?? SNAPSHOT_PERSIST_QUIET_MS;
  const maxStaleMs = Math.max(quietMs, options.maxStaleMs ?? SNAPSHOT_PERSIST_MAX_STALE_MS);
  const idleTimeoutMs = options.idleTimeoutMs ?? SNAPSHOT_PERSIST_IDLE_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
  const requestIdle = options.requestIdle ?? defaultRequestIdle;
  const cancelIdle = options.cancelIdle ?? defaultCancelIdle;
  const log = options.log ?? (() => undefined);

  let getPending: (() => LibrarySnapshot) | null = null;
  let firstDirtyAt = 0;
  let lastChangeAt = 0;
  let changes = 0;
  let timer: TimerHandle | null = null;
  let idle: IdleHandle | null = null;

  const clearScheduled = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (idle !== null) {
      cancelIdle(idle);
      idle = null;
    }
  };

  const persist = (reason: string): boolean => {
    clearScheduled();
    const get = getPending;
    if (!get) return false;
    const pendingChanges = changes;
    const dirtyForMs = Math.round(now() - firstDirtyAt);
    getPending = null;
    changes = 0;
    const startedAt = now();
    try {
      options.save(get());
    } catch (error) {
      log({ event: "error", reason, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    log({
      event: "persisted",
      reason,
      durationMs: Math.round((now() - startedAt) * 100) / 100,
      changes: pendingChanges,
      dirtyForMs,
    });
    return true;
  };

  const onDue = () => {
    timer = null;
    if (!getPending || idle !== null) return;
    idle = requestIdle(
      () => {
        idle = null;
        persist("idle");
      },
      { timeout: idleTimeoutMs }
    );
  };

  const schedule = () => {
    // Already waiting for an idle slot: that callback writes the latest getter.
    if (idle !== null) return;
    clearScheduled();
    const dueAt = Math.min(lastChangeAt + quietMs, firstDirtyAt + maxStaleMs);
    const dueInMs = Math.max(0, dueAt - now());
    timer = setTimer(onDue, dueInMs);
    // Log the first change of a burst and every 20th after, so a playback
    // minute does not flood the log with 120 identical lines.
    if (changes === 1 || changes % 20 === 0) {
      log({ event: "scheduled", dueInMs: Math.round(dueInMs), dirtyForMs: Math.round(now() - firstDirtyAt), changes });
    }
  };

  return {
    markDirty: (getSnapshot) => {
      const at = now();
      if (!getPending) firstDirtyAt = at;
      lastChangeAt = at;
      getPending = getSnapshot;
      changes += 1;
      schedule();
    },
    flush: (reason = "flush") => {
      if (!getPending) {
        clearScheduled();
        log({ event: "skipped", reason: `${reason}:clean` });
        return false;
      }
      return persist(reason);
    },
    cancel: () => {
      const dropped = changes;
      clearScheduled();
      getPending = null;
      changes = 0;
      if (dropped) log({ event: "cancelled", changes: dropped });
    },
    hasPending: () => getPending !== null,
  };
};
