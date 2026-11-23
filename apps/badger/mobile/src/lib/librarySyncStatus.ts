/**
 * What the library sync is doing, for the tab bar's sign (LIB-SYNC-13).
 *
 * Every caller of `LibraryDb.syncFromRemoteIfNewer` (cold start, back to the front, the live stream, pull-to-refresh)
 * runs through `track`; the db reports what the run does through `progress` (`LibraryDb.onSyncProgress`). The db's own
 * single-flight already merges overlapping runs, so the tracker only counts its callers: one "updating" state from the
 * first run that finds the server newer until the last caller settles, then one result.
 * - Asking the server for its version is quiet: most checks find nothing new, and a sign on every return to the front
 *   would be noise. The sign appears once the server is newer (`start`) and the sync is still running after
 *   `LIBRARY_SYNC_SHOW_DELAY_MS`, or at once for a snapshot restore.
 * - The result passes on its own after `LIBRARY_SYNC_RESULT_MS`: the number of new titles / episodes, "updated" after a
 *   sync long enough to have shown its sign, "up to date" after a pull-to-refresh (the user asked), nothing otherwise.
 * - A failure stays until a sync works: the saved library is still usable, the sign says it may be behind.
 */

export type LibrarySyncSource = "start" | "foreground" | "stream" | "pull";

/** What `LibraryDb.runSyncFromRemoteIfNewer` reports while it works. */
export type LibrarySyncProgressEvent =
  | { kind: "start"; fromVersion: number; toVersion: number }
  | { kind: "page"; version: number }
  | { kind: "snapshot" };

export type LibrarySyncState =
  | { kind: "idle" }
  | {
      kind: "syncing";
      source: LibrarySyncSource;
      fromVersion: number;
      toVersion: number;
      doneVersion: number;
      phase: "ops" | "snapshot";
    }
  | {
      kind: "done";
      source: LibrarySyncSource;
      changed: boolean;
      /** Null when the counts could not be read (the result then just says the library was updated). */
      newTitles: number | null;
      newEpisodes: number | null;
    }
  | { kind: "failed"; source: LibrarySyncSource; error: string };

export type LibrarySyncCounts = { titles: number; episodes: number };

/**
 * The sign waits this long after the server was found newer: a quick sync (another device's play position, one new
 * title) is done before it and passes unseen, a long one (a night of uploads) shows well within a second.
 */
export const LIBRARY_SYNC_SHOW_DELAY_MS = 400;
export const LIBRARY_SYNC_RESULT_MS = 4_000;

/** 0..1 while ops pages arrive; null when unknown (a snapshot restore, or not syncing). */
export const librarySyncProgress = (state: LibrarySyncState): number | null => {
  if (state.kind !== "syncing" || state.phase === "snapshot") return null;
  const span = state.toVersion - state.fromVersion;
  if (span <= 0) return null;
  return Math.min(1, Math.max(0, (state.doneVersion - state.fromVersion) / span));
};

type TrackerOptions = {
  onState: (state: LibrarySyncState) => void;
  /** Titles and episodes in the open library, read before and after a sync for the result. */
  counts: () => Promise<LibrarySyncCounts>;
  log?: (event: string, details: Record<string, unknown>) => void;
};

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type LibrarySyncTracker = {
  /**
   * Runs one caller's sync; its result and error pass through unchanged. `true` from `work` means the library changed;
   * anything else (false, or null for "stopped early") means it did not.
   */
  track: <T>(caller: LibrarySyncSource, work: () => Promise<T>) => Promise<T>;
  /** Fed by `LibraryDb.onSyncProgress`. */
  progress: (event: LibrarySyncProgressEvent) => void;
  getState: () => LibrarySyncState;
  /** Drops a pending result timer (the provider unmounts). */
  dispose: () => void;
};

export const createLibrarySyncTracker = ({
  onState,
  counts,
  log = (event, details) => console.warn(event, JSON.stringify(details)),
}: TrackerOptions): LibrarySyncTracker => {
  let state: LibrarySyncState = { kind: "idle" };
  let active = 0;
  /** The source of the latest caller: the one named in the logs and the state. */
  let source: LibrarySyncSource = "stream";
  let anyPull = false;
  let anyChanged = false;
  let error: unknown = null;
  /** The running sync's progress once the server was found newer; on screen only once `shown`. */
  let run: Extract<LibrarySyncState, { kind: "syncing" }> | null = null;
  let shown = false;
  let startedAt = 0;
  let before: Promise<LibrarySyncCounts | null> | null = null;
  let resultTimer: ReturnType<typeof setTimeout> | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: LibrarySyncState) => {
    state = next;
    onState(next);
  };
  const clearTimers = () => {
    clearTimeout(resultTimer ?? undefined);
    clearTimeout(showTimer ?? undefined);
    resultTimer = null;
    showTimer = null;
  };
  const show = () => {
    clearTimeout(showTimer ?? undefined);
    showTimer = null;
    if (!run) return;
    if (!shown) log("library.sync.status.shown", { source: run.source, afterMs: Date.now() - startedAt });
    shown = true;
    set(run);
  };
  const readCounts = () =>
    counts().catch((countError: unknown) => {
      log("library.sync.status.counts_failed", { error: describe(countError) });
      return null;
    });
  const begin = () => {
    startedAt = Date.now();
    before = readCounts();
  };

  const settle = async () => {
    const synced = run;
    const wasShown = shown;
    const changed = anyChanged || synced !== null;
    const pull = anyPull;
    const failure = error;
    const settledSource = source;
    const baseline = before;
    clearTimers();
    run = null;
    shown = false;
    anyChanged = false;
    anyPull = false;
    error = null;
    before = null;
    if (failure) {
      log("library.sync.status.failed", { source: settledSource, error: describe(failure), ms: Date.now() - startedAt });
      set({ kind: "failed", source: settledSource, error: describe(failure) });
      return;
    }
    let newTitles: number | null = 0;
    let newEpisodes: number | null = 0;
    if (changed) {
      const [from, to] = await Promise.all([baseline ?? Promise.resolve(null), readCounts()]);
      newTitles = from && to ? Math.max(0, to.titles - from.titles) : null;
      newEpisodes = from && to ? Math.max(0, to.episodes - from.episodes) : null;
    }
    // A new run started while the counts were read: it owns the sign now.
    if (active > 0 || run) return;
    const result: LibrarySyncState = { kind: "done", source: settledSource, changed, newTitles, newEpisodes };
    log("library.sync.status.done", { ...result, shown: wasShown, ms: Date.now() - startedAt });
    // Something to say: new titles or episodes, a sync long enough to have shown its sign, or a pull (the user asked).
    // A quick sync of other changes (another device's play position) passes unseen.
    const news = (newTitles ?? 0) > 0 || (newEpisodes ?? 0) > 0;
    if (!news && !pull && !(wasShown && changed)) {
      if (state.kind !== "idle") set({ kind: "idle" });
      return;
    }
    set(result);
    resultTimer = setTimeout(() => {
      resultTimer = null;
      if (state.kind === "done") set({ kind: "idle" });
    }, LIBRARY_SYNC_RESULT_MS);
  };

  return {
    track: async <T,>(caller: LibrarySyncSource, work: () => Promise<T>): Promise<T> => {
      if (active === 0 && !run) begin();
      active += 1;
      source = caller;
      if (caller === "pull") anyPull = true;
      log("library.sync.status.track", { source: caller, active });
      try {
        const result = await work();
        if (result === true) anyChanged = true;
        return result;
      } catch (runError) {
        error = runError;
        throw runError;
      } finally {
        active -= 1;
        if (active === 0) void settle();
      }
    },

    progress: (event) => {
      if (event.kind === "start") {
        log("library.sync.status.start", { source, fromVersion: event.fromVersion, toVersion: event.toVersion });
        if (run) {
          run = { ...run, source, toVersion: Math.max(run.toVersion, event.toVersion) };
          if (shown) set(run);
          return;
        }
        // A run no caller tracks (the db's own re-sync after a rejected publish) has no end to wait for: not shown.
        if (active === 0) return;
        clearTimeout(resultTimer ?? undefined);
        resultTimer = null;
        run = {
          kind: "syncing",
          source,
          fromVersion: event.fromVersion,
          toVersion: event.toVersion,
          doneVersion: event.fromVersion,
          phase: "ops",
        };
        showTimer = setTimeout(show, LIBRARY_SYNC_SHOW_DELAY_MS);
        return;
      }
      if (!run) return;
      if (event.kind === "page") {
        run = { ...run, doneVersion: Math.max(run.doneVersion, event.version) };
        if (shown) set(run);
        return;
      }
      // A snapshot restore is never quick: the sign shows at once.
      run = { ...run, phase: "snapshot" };
      show();
    },

    getState: () => state,
    dispose: clearTimers,
  };
};
