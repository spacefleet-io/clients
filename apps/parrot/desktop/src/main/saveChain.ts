// PAR-PL-05: the writes Parrot queues (library saves, `parrot.json`) and the quit that waits for them. Before this,
// `before-quit` let the process exit with saves still queued, and the edits the window already showed were lost.

/** Writes run one at a time in call order; each builds on what the previous one left. */
export type SaveChain = {
  /** Queues `save` after every earlier one, whether they worked or not. `edits` is what it carries, for the quit log. */
  run<T>(save: () => Promise<T>, edits?: number): Promise<T>;
  /** Edits queued or running, not settled yet. */
  pending(): number;
  /** Resolves once nothing is queued, including saves queued while it waits. Never rejects. */
  idle(): Promise<void>;
};

export const createSaveChain = (): SaveChain => {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    run(save, edits = 1) {
      pending += edits;
      const next = tail.then(save, save);
      const settled = () => {
        pending -= edits;
      };
      tail = next.then(settled, settled);
      return next;
    },
    pending: () => pending,
    async idle() {
      while (pending > 0) await tail;
    },
  };
};

export type PendingWrites = { name: string; chain: Pick<SaveChain, "pending" | "idle"> };

/**
 * How long a quit waits for queued saves. Each library save publishes the whole encrypted library (a few hundred
 * milliseconds on a normal connection, several seconds for a big library on a slow upload), and a few edits made just
 * before quitting queue a few saves. 30 s covers that with room to spare; past it the connection is effectively dead
 * and the save would fail anyway, so Parrot quits rather than hang. The window is hidden and muted meanwhile.
 */
export const QUIT_SAVE_TIMEOUT_MS = 30_000;

const describe = (writes: PendingWrites[]) =>
  writes
    .filter((write) => write.chain.pending() > 0)
    .map((write) => `${write.name}: ${write.chain.pending()}`)
    .join(", ");

const total = (writes: PendingWrites[]) => writes.reduce((sum, write) => sum + write.chain.pending(), 0);

/** Waits up to `timeoutMs` for every queued write; true when all of them settled. */
export const flushPendingWrites = async (input: {
  writes: PendingWrites[];
  timeoutMs: number;
  reason: string;
  log: (line: string) => void;
  fail: (line: string) => void;
}): Promise<boolean> => {
  const { writes, timeoutMs, reason, log, fail } = input;
  const queued = total(writes);
  if (queued === 0) {
    log(`[quit] ${reason}: no unsaved edits`);
    return true;
  }
  const started = Date.now();
  log(`[quit] ${reason}: waiting for ${queued} unsaved edit(s) (${describe(writes)}), up to ${timeoutMs / 1000} s`);
  const { promise: timedOut, resolve: timeUp } = Promise.withResolvers<false>();
  const timer = setTimeout(() => timeUp(false), timeoutMs);
  const done = await Promise.race([Promise.all(writes.map((write) => write.chain.idle())).then(() => true as const), timedOut]);
  clearTimeout(timer);
  if (done) log(`[quit] ${reason}: every edit saved in ${Date.now() - started} ms`);
  else fail(`[quit] ${reason}: gave up after ${timeoutMs / 1000} s, ${total(writes)} edit(s) not saved (${describe(writes)})`);
  return done;
};

type QuitEvent = { preventDefault(): void };

export type QuitGuard = {
  /** The `before-quit` handler: holds the quit while edits are queued, then quits again once they are saved. */
  beforeQuit(event: QuitEvent): void;
  /** A session ending (Windows `query-session-end`, `powerMonitor` `shutdown`): holds it the same way. */
  sessionEnding(event: QuitEvent, reason: string): void;
  /**
   * Saves what is queued before a quit someone else starts (the update restart), and nothing more: the app stays as it
   * is (window, tray, lookups, the guard itself), so an install that fails without quitting leaves Parrot usable and a
   * later quit still waits for its saves. True when every queued edit was saved.
   */
  saveNow(reason: string): Promise<boolean>;
};

/**
 * PAR-PL-05: the Electron pattern for an async cleanup on quit. The first `before-quit` with edits queued calls
 * `preventDefault`, hides the app (`onWait`), waits for the saves (bounded by `timeoutMs`), then calls `app.quit()`
 * again; that second `before-quit` goes through and runs `onQuit`, the usual cleanup. A wait that timed out is not
 * repeated.
 */
export const createQuitGuard = (input: {
  app: { quit(): void };
  writes: PendingWrites[];
  timeoutMs: number;
  /** Runs once, when the wait starts: hide and mute the window, stop background work. */
  onWait: () => void;
  /** The usual quit cleanup, run by the `before-quit` that goes through. */
  onQuit: () => void;
  log: (line: string) => void;
  fail: (line: string) => void;
}): QuitGuard => {
  let state: "open" | "waiting" | "flushed" = "open";
  const flush = (reason: string) =>
    flushPendingWrites({ writes: input.writes, timeoutMs: input.timeoutMs, reason, log: input.log, fail: input.fail });
  const holdThenQuit = (event: QuitEvent, reason: string) => {
    event.preventDefault();
    if (state === "waiting") return;
    state = "waiting";
    input.onWait();
    void flush(reason).then(() => {
      state = "flushed";
      input.app.quit();
    });
  };
  return {
    beforeQuit(event) {
      if (state === "flushed" || (state === "open" && total(input.writes) === 0)) {
        input.onQuit();
        return;
      }
      holdThenQuit(event, "quit");
    },
    sessionEnding(event, reason) {
      if (state === "flushed" || (state === "open" && total(input.writes) === 0)) return;
      holdThenQuit(event, reason);
    },
    saveNow: flush,
  };
};
