/**
 * Runtime-side library DB management for the badger module.
 *
 * Owns the SQLite database instance (via better-sqlite3/Bun) so desktop
 * Electron apps don't need the native module. Desktop connects via HTTP
 * commands for writes and receives snapshot pushes via WebSocket for reads.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { retry } from "@space/shared/retry";
import type {
  BadgerIngestSkipMarker,
  BadgerIngestShowSkipCache,
} from "@space/runtime-contracts/badger/ingest";
import type { LibraryMeta } from "@space/library-db-runtime/api";
import type { LibraryAccount } from "@space/library-db-runtime/libraryAccount";
// Lazy import to avoid pulling bun:sqlite at module load time
// (vitest can't resolve bun: protocol, but this is only called at runtime)
type LibraryDb = import("@space/library-db-runtime/libraryDb").LibraryDb;
type LibrarySnapshot = import("@space/shared/libraryTypes").LibrarySnapshot;

/**
 * `media_skip_analysis.kind` constant used for the full-show skip-marker
 * cache row. Mirrors `EXTERNAL_SKIP_MARKER_SHOW_KIND` on the renderer side
 * (`apps/badger/desktop/src/shared/skipMarkerCache.ts`). Kept as a local
 * literal so the runtime doesn't import renderer-only code. v2 invalidates
 * v1 — see the renderer-side comment for the cache-poisoning history.
 */
const EXTERNAL_SKIP_MARKER_SHOW_KIND = "external-skip-markers-show-v2";

const getLibraryDbClass = async () => {
  const mod = await import("@space/library-db-runtime/libraryDb");
  return mod.LibraryDb;
};

export type LibraryDbEventPublisher = (channel: string, event: string, payload: Record<string, unknown>) => void;

/** Why an open library closed: the user signed out, a plain close, or the runtime stopping. */
export type LibraryClosedReason = "signOut" | "close" | "shutdown";
export type LibraryClosedListener = (reason: LibraryClosedReason) => void;

/**
 * LibraryDb methods that only read SQLite, synchronously, and never write
 * (no persist, no queueOp, no network). They skip the op gate (#25 N4):
 * before, a `hasPendingSync` or `getMediaDetails` queued behind whatever
 * held the gate — a remote sync uploading over a saturated link held it for
 * minutes while the event loop sat idle. A synchronous read cannot
 * interleave with another synchronous call, so it always sees a state some
 * completed call left behind. Reads still queue while an ATOMIC op (open /
 * close / clearLocalCache, runBatch, remote-sync apply) is queued or
 * running, so they never observe a half-done commit, sync or reopen.
 * Adding a method here requires checking it stays a pure synchronous read.
 */
const READ_ONLY_METHODS: Record<string, true> = {
  getMediaDetails: true,
  listMediaFormats: true,
  getSetting: true,
  getSystemPlaylistId: true,
  getActiveProfile: true,
  hasAnyMedia: true,
  listMedia: true,
  listPlaylistItems: true,
  listPlaylists: true,
  getMediaObjectKeys: true,
  getMediaStorageBytes: true,
  getVersion: true,
  hasPendingSync: true,
  getDatasetStatus: true,
  resolveEpisodeId: true,
  listEpisodeIdsByKey: true,
  listLocalDownloads: true,
  listSkipAnalysis: true,
  listViewingProfileIds: true,
  listSubtitleOcrCandidates: true,
  listPreviewSheetCandidates: true,
  countPreviewSheetVideos: true,
  listSkipCatchUpVideos: true,
  listArtworkToCopy: true,
  listMediaWithArtworkToCopy: true,
  listMediaWithCollapsedCast: true,
  listMediaMissingCrew: true,
  getSnapshot: true,
  getTargetOpStreamVersion: true,
  isPackedPlaybackLayout: true,
};

/** Gate ops that waited or held at least this long are logged one by one. */
const GATE_SLOW_LOG_MS = 250;
/** A remote sync whose apply found its base moved re-prepares this many times before falling back to the fully gated path. */
const SYNC_PREPARE_ATTEMPTS = 3;

type GateOpKind = "call" | "batch" | "lifecycle" | "sync-apply" | "flush" | "read";

export type LibraryDbGateStats = {
  /** Ops queued or running on the gate right now. */
  depth: number;
  /** Atomic ops (lifecycle, batch, sync apply) queued or running — reads queue while > 0. */
  atomicDepth: number;
  holder: { label: string; kind: GateOpKind; heldMs: number } | null;
  gatedOps: number;
  bypassedReads: number;
  maxWaitMs: number;
  maxHoldMs: number;
  coalescedSyncs: number;
  staleSyncApplies: number;
};

type SyncRequest = { meta: LibraryMeta | null; joined: number; promise: Promise<boolean> | null };

export class BadgerLibraryDbService {
  private db: LibraryDb | null = null;
  private publishEvent: LibraryDbEventPublisher | null = null;
  private closedListener: LibraryClosedListener | null = null;
  private lastSnapshotVersion = 0;
  /** The account whose library was opened last: sign-out removes its files even after the library closed. */
  private openedAccount: LibraryAccount | null = null;
  /**
   * #25: how long a `deferPublish` write (playback progress saved while the app
   * window is hidden behind external mpv) may hold back its `library.updated`
   * frame. Each frame costs the runtime a whole-library `getSnapshot` plus a
   * ~1 MB serialization, and the desktop a ~1 MB parse, for a window nobody
   * sees. Measured on the lowend profile (c023, episode, playing): `getSnapshot`
   * was ~28 % and `setProgress` ~13 % of the runtime's busy time.
   */
  static deferredPublishMs = 5_000;
  private deferredPublishTimer: NodeJS.Timeout | null = null;
  /**
   * Serializes lifecycle + per-call async operations. Hono dispatches commands
   * concurrently, so without this gate a teardown command (close,
   * clearLocalCache) can run `db.close()` while a still-executing `call()` /
   * `flush()` is mid-await — the next SQLite prepare() then throws
   * "Cannot use a closed database". Every db-touching public method chains
   * off of `opGate` to guarantee a single in-flight operation at a time.
   */
  private opGate: Promise<unknown> = Promise.resolve();
  /**
   * Gate bookkeeping (#25 N4). Every op logs `[badger-library-db] gate`
   * when it waited or held >= GATE_SLOW_LOG_MS, with the queue depth it
   * found and what was holding the gate — the ultimate run had 13-336 s
   * command latencies and no way to say which op caused them.
   */
  private gateSeq = 0;
  private gateDepth = 0;
  private atomicDepth = 0;
  /** Lifecycle ops (open / openLocal / close / clearLocalCache) queued or running. */
  private lifecycleDepth = 0;
  private gateHolder: { label: string; kind: GateOpKind; startedAt: number } | null = null;
  private gateLastEnqueued: string | null = null;
  private gateCounters = { gatedOps: 0, bypassedReads: 0, maxWaitMs: 0, maxHoldMs: 0, coalescedSyncs: 0, staleSyncApplies: 0 };
  /** Remote syncs run one at a time; a request arriving while one waits joins it (latest meta wins). */
  private syncTail: Promise<unknown> = Promise.resolve();
  private queuedSync: SyncRequest | null = null;
  /**
   * Per-batch context tracked via AsyncLocalStorage so that ONLY callers
   * running inside `runBatch`'s fn() take the inline (deadlock-avoiding,
   * publish-suspending) path. Concurrent `call()`s issued from outside
   * the batch must still queue on `opGate` — same serialization
   * guarantees as the pre-fix code, just with publishes coalesced.
   *
   * `depth` is a counter (not boolean) so nested `runBatch`s inside the
   * same async context compose cleanly: only the outermost batch frame
   * emits the terminal publish.
   *
   * Pre-fix the commit step's 6-15 sequential writes each republished the
   * full snapshot. The renderer chewed through that burst of stale
   * snapshots before the final markMediaPlayable landed, which delayed
   * the play-button enable on the user's "done" event by 3-5 s.
   */
  private batchContext = new AsyncLocalStorage<{ depth: number }>();

  private runExclusive<T>(label: string, kind: GateOpKind, task: () => Promise<T>): Promise<T> {
    const seq = ++this.gateSeq;
    const atomic = kind === "lifecycle" || kind === "batch" || kind === "sync-apply";
    const enqueuedAt = performance.now();
    // The op this one queued directly behind (null = gate was idle).
    const behind = this.gateDepth > 0 ? this.gateLastEnqueued : null;
    this.gateLastEnqueued = label;
    this.gateDepth += 1;
    if (atomic) this.atomicDepth += 1;
    if (kind === "lifecycle") this.lifecycleDepth += 1;
    const depthAtEnqueue = this.gateDepth;
    const run = async () => {
      const startedAt = performance.now();
      this.gateHolder = { label, kind, startedAt };
      let ok = false;
      try {
        const result = await task();
        ok = true;
        return result;
      } finally {
        const finishedAt = performance.now();
        this.gateHolder = null;
        this.gateDepth -= 1;
        if (atomic) this.atomicDepth -= 1;
        if (kind === "lifecycle") this.lifecycleDepth -= 1;
        this.recordGateOp({
          seq,
          label,
          kind,
          ok,
          waitMs: startedAt - enqueuedAt,
          holdMs: finishedAt - startedAt,
          depthAtEnqueue,
          behind,
        });
      }
    };
    const next = this.opGate.then(run, run);
    // Keep the gate healthy even if the task rejects — otherwise every
    // subsequent call would inherit the rejection via .then chaining.
    this.opGate = next.catch(() => undefined);
    return next;
  }

  private recordGateOp(op: {
    seq: number;
    label: string;
    kind: GateOpKind;
    ok: boolean;
    waitMs: number;
    holdMs: number;
    depthAtEnqueue: number;
    behind: string | null;
  }) {
    const counters = this.gateCounters;
    if (op.kind === "read") {
      counters.bypassedReads += 1;
    } else {
      counters.gatedOps += 1;
    }
    counters.maxWaitMs = Math.max(counters.maxWaitMs, op.waitMs);
    counters.maxHoldMs = Math.max(counters.maxHoldMs, op.holdMs);
    if (op.waitMs < GATE_SLOW_LOG_MS && op.holdMs < GATE_SLOW_LOG_MS) return;
    console.warn(
      `[badger-library-db] gate ${JSON.stringify({
        seq: op.seq,
        op: op.label,
        kind: op.kind,
        ok: op.ok,
        waitMs: Math.round(op.waitMs),
        holdMs: Math.round(op.holdMs),
        depthAtEnqueue: op.depthAtEnqueue,
        depthNow: this.gateDepth,
        atomicDepth: this.atomicDepth,
        behind: op.behind,
        holderNow: this.gateHolder?.label ?? null,
      })}`
    );
  }

  getGateStats(): LibraryDbGateStats {
    const holder = this.gateHolder;
    return {
      depth: this.gateDepth,
      atomicDepth: this.atomicDepth,
      holder: holder
        ? { label: holder.label, kind: holder.kind, heldMs: Math.round(performance.now() - holder.startedAt) }
        : null,
      ...this.gateCounters,
    };
  }

  setEventPublisher(publisher: LibraryDbEventPublisher | null) {
    this.publishEvent = publisher;
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  /** Open `account`'s library (LIB-STORE-06: its own dir per API server; never another account's files). */
  async open(token: string, keyBase64: string, account: LibraryAccount): Promise<{ version: number; mediaCount: number }> {
    return this.runExclusive("open", "lifecycle", async () => {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      const LibraryDbClass = await getLibraryDbClass();
      this.openedAccount = account;
      const db = await LibraryDbClass.open(token, keyBase64, account);
      db.setSyncEnabled(true);
      this.db = db;
      const snapshot = db.getSnapshot();
      const version = db.getVersion();
      this.lastSnapshotVersion = version;
      // Changes noted while opening (remote pull, migrations) are inside the
      // snapshot published below.
      db.takeChangedMedia();
      this.publishSnapshotUpdate(snapshot, version, "opened");
      return { version, mediaCount: snapshot.media.length };
    });
  }

  /**
   * Offline open: opens the on-disk library (per-group SQLite + cache) with NO
   * remote pull and sync left DISABLED. Used when the backend is unreachable so
   * the desktop can still show downloaded titles. Mirrors `open` but calls the
   * local-only primitive and never enables sync (which would race a doomed
   * remote round-trip the moment connectivity is assumed back).
   */
  async openLocal(token: string, keyBase64: string, account: LibraryAccount): Promise<{ version: number; mediaCount: number }> {
    return this.runExclusive("openLocal", "lifecycle", async () => {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      const LibraryDbClass = await getLibraryDbClass();
      this.openedAccount = account;
      const db = await LibraryDbClass.openLocal(token, keyBase64, account);
      db.setSyncEnabled(false);
      this.db = db;
      const snapshot = db.getSnapshot();
      const version = db.getVersion();
      this.lastSnapshotVersion = version;
      db.takeChangedMedia();
      this.publishSnapshotUpdate(snapshot, version, "opened");
      return { version, mediaCount: snapshot.media.length };
    });
  }

  /** Called after an open library was closed (close, clear cache): what was granted against it ends. */
  setClosedListener(listener: LibraryClosedListener | null) {
    this.closedListener = listener;
  }

  /** `reason` "shutdown": the runtime is stopping, not the user signing out (PLAT-WEB-06 web grants outlive it). */
  async close(reason: LibraryClosedReason = "close") {
    await this.runExclusive("close", "lifecycle", async () => {
      if (this.db) {
        this.db.close();
        this.db = null;
        this.lastSnapshotVersion = 0;
        this.closedListener?.(reason);
      }
    });
  }

  /**
   * The desktop app's sign-out. It ends the grants even when no library was open (right after a restart), and
   * removes the library files of `account`, else of the account last opened (LIB-STORE-06).
   */
  async clearLocalCache(account?: LibraryAccount) {
    await this.runExclusive("clearLocalCache", "lifecycle", async () => {
      if (this.db) {
        this.db.close();
        this.db = null;
        this.lastSnapshotVersion = 0;
      }
      this.closedListener?.("signOut");
      const LibraryDbClass = await getLibraryDbClass();
      const cleared = account ?? this.openedAccount ?? undefined;
      this.openedAccount = null;
      await LibraryDbClass.clearLocalCache(cleared);
    });
  }

  getSnapshot(): LibrarySnapshot | null {
    return this.db?.getSnapshot() ?? null;
  }

  /**
   * The snapshot for a consumer that already holds the previous one: media
   * rows, playlists, playlist items, ingest jobs and settings complete,
   * `mediaDetails` only for `mediaIds`.
   */
  getSnapshotDelta(mediaIds: string[]): LibrarySnapshot | null {
    return this.db?.getSnapshotDelta(mediaIds) ?? null;
  }

  getVersion(): number {
    return this.db?.getVersion() ?? 0;
  }

  getDatasetStatus(): { core: boolean; metadata: boolean; playback: boolean } | null {
    if (!this.db) return null;
    return this.db.getDatasetStatus();
  }

  /**
   * Generic method dispatch — mirrors the desktop's `sf-library-db-call` IPC handler.
   * Calls the named method on the LibraryDb instance and returns the result.
   * When the call moved the library version, publishes a snapshot update via WebSocket — UNLESS
   * the call is nested inside `runBatch`, in which case the publish is
   * deferred to the batch's terminal coalesced publish.
   */
  async call(method: string, args: unknown[] = [], options: { deferPublish?: boolean } = {}): Promise<unknown> {
    // Inside a `runBatch`'s fn() (i.e. when our async context carries a
    // batch frame), the outer batch already holds opGate exclusively;
    // re-entering runExclusive here would deadlock on the same gate. Run
    // the body inline AND skip the per-write snapshot publish — the
    // batch emits one terminal publish if the version changed.
    //
    // Outside the batch's async context (e.g. a concurrent call() fired
    // by another caller while a batch is in flight) we MUST go through
    // opGate normally so the gate serializes us behind the batch and our
    // own write publishes per-call, as the pre-fix path did.
    const inBatch = this.batchContext.getStore();
    if (inBatch && inBatch.depth > 0) {
      return this.executeCallBody(method, args, { publish: false });
    }
    if (method === "syncFromRemoteIfNewer") {
      return this.syncFromRemote((args[0] as LibraryMeta | null | undefined) ?? null);
    }
    if (Object.hasOwn(READ_ONLY_METHODS, method) && this.atomicDepth === 0) {
      return this.executeRead(method, args);
    }
    return this.runExclusive(method, "call", () =>
      this.executeCallBody(method, args, { publish: true, deferPublish: options.deferPublish })
    );
  }

  private executeRead(method: string, args: unknown[]): unknown {
    const startedAt = performance.now();
    let ok = false;
    try {
      const result = this.invoke(method, args);
      ok = true;
      return result;
    } finally {
      this.recordGateOp({
        seq: ++this.gateSeq,
        label: method,
        kind: "read",
        ok,
        waitMs: 0,
        holdMs: performance.now() - startedAt,
        depthAtEnqueue: this.gateDepth,
        behind: this.gateHolder?.label ?? null,
      });
    }
  }

  private invoke(method: string, args: unknown[]): unknown {
    if (!this.db) throw new Error("LIBRARY_DB_NOT_OPEN");
    const fn = (this.db as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`LIBRARY_DB_UNKNOWN_METHOD:${method}`);
    }
    return (fn as Function).apply(this.db, args);
  }

  private async executeCallBody(
    method: string,
    args: unknown[],
    options: { publish: boolean; deferPublish?: boolean }
  ): Promise<unknown> {
    const result = await this.invoke(method, args);
    if (options.publish) this.publishIfVersionMoved(method, { defer: options.deferPublish });
    return result;
  }

  // Publish whenever the call moved the library version — every persisted
  // write bumps it (LibraryDb.persist), including remote-op application
  // (`syncFromRemoteIfNewer`) and ingest-job writes. This used to be gated
  // on a hand-kept WRITE_METHODS list; a version-bumping method missing
  // from it published nothing, which the desktop only papered over by
  // re-fetching the full snapshot after every call (#25). Local-only
  // bookkeeping (offline downloads) doesn't persist, so it stays silent.
  private publishIfVersionMoved(reason: string, options: { defer?: boolean } = {}) {
    if (!this.db) return;
    const version = this.db.getVersion();
    if (version === this.lastSnapshotVersion) return;
    if (options.defer) {
      this.scheduleDeferredPublish(reason);
      return;
    }
    this.clearDeferredPublish();
    const previousVersion = this.lastSnapshotVersion;
    this.lastSnapshotVersion = version;
    this.publishLibraryDelta(version, previousVersion, reason);
  }

  /**
   * #25: hold back the frame of a `deferPublish` write. One timer per burst:
   * the first deferred write arms it, later ones ride it, and when it fires the
   * newest version is published once. Any immediate publish in between
   * (`publishIfVersionMoved`, a batch's terminal publish) already carries the
   * deferred write, so the timer then finds nothing to do. A fire that lands
   * inside a batch re-arms instead of publishing the batch's half-written
   * state.
   */
  private scheduleDeferredPublish(reason: string) {
    if (this.deferredPublishTimer) return;
    const timer = setTimeout(() => {
      this.deferredPublishTimer = null;
      if (this.atomicDepth > 0) {
        this.scheduleDeferredPublish(reason);
        return;
      }
      // Same reason as the write: main holds a `frame:setProgress` frame while the
      // window is hidden, a suffixed reason would push a full snapshot to the renderer.
      this.publishIfVersionMoved(reason);
    }, BadgerLibraryDbService.deferredPublishMs);
    timer.unref?.();
    this.deferredPublishTimer = timer;
  }

  private clearDeferredPublish() {
    if (!this.deferredPublishTimer) return;
    clearTimeout(this.deferredPublishTimer);
    this.deferredPublishTimer = null;
  }

  /**
   * `syncFromRemoteIfNewer`, split around the gate (#25 N4). The network
   * half (`prepareRemoteSync`: drain local ops/snapshot to the API, read
   * meta, download + decrypt remote ops) runs OUTSIDE the gate; only the
   * local apply takes it. Pre-fix the whole sync held the gate, and on a
   * saturated uplink one sync held it for minutes while every read, write
   * and ingest commit queued behind it.
   *
   * Syncs run one at a time. A request arriving while another one is still
   * waiting to start joins it instead of queueing its own round trip; the
   * joined request syncs against the newest meta it was given (`null` =
   * fetch fresh, which subsumes any override).
   */
  private syncFromRemote(meta: LibraryMeta | null): Promise<boolean> {
    const queued = this.queuedSync;
    if (queued?.promise) {
      queued.meta = queued.meta === null || meta === null ? null : meta;
      queued.joined += 1;
      this.gateCounters.coalescedSyncs += 1;
      return queued.promise;
    }
    const request: SyncRequest = { meta, joined: 0, promise: null };
    this.queuedSync = request;
    const promise = this.syncTail.then(() => {
      if (this.queuedSync === request) this.queuedSync = null;
      return this.runRemoteSync(request);
    });
    request.promise = promise;
    this.syncTail = promise.catch(() => undefined);
    return promise;
  }

  // tla: LibrarySync/SyncStart
  // tla: LibrarySync/SyncApply
  private async runRemoteSync(request: SyncRequest): Promise<boolean> {
    let meta = request.meta;
    const outcome = await retry(
      async (attempt) => {
        // An open/close queued ahead of this sync decides which instance it
        // talks to; wait for it as the pre-split (fully gated) sync did,
        // instead of failing LIBRARY_DB_NOT_OPEN mid-reopen.
        if (this.lifecycleDepth > 0) {
          await this.runExclusive("syncFromRemoteIfNewer:await-lifecycle", "call", async () => undefined);
        }
        const db = this.db;
        if (!db) throw new Error("LIBRARY_DB_NOT_OPEN");
        const prepareStartedAt = performance.now();
        const prepared = await db.prepareRemoteSync(meta);
        const prepareMs = performance.now() - prepareStartedAt;
        if (prepareMs >= GATE_SLOW_LOG_MS) {
          console.warn(
            `[badger-library-db] sync prepare (outside gate) ${JSON.stringify({
              attempt,
              kind: prepared.kind,
              prepareMs: Math.round(prepareMs),
              joined: request.joined,
              gateDepth: this.gateDepth,
            })}`
          );
        }
        if (prepared.kind === "none") return false;
        const applied = await this.runExclusive("syncFromRemoteIfNewer:apply", "sync-apply", async () => {
          // Re-opened (or closed) while preparing: the fetch belongs to the
          // old instance. Run the full sync on whatever is open now, as a
          // queued pre-split sync would have.
          if (this.db !== db) {
            return (await this.executeCallBody("syncFromRemoteIfNewer", [meta], { publish: true })) as boolean;
          }
          const result = await db.applyPreparedRemoteSync(prepared);
          if (result !== "stale") this.publishIfVersionMoved("syncFromRemoteIfNewer");
          return result;
        });
        if (applied === "stale") {
          this.gateCounters.staleSyncApplies += 1;
          // Our own ops flush moved the base mid-prepare; the override meta is
          // now older than what we know, so re-read meta fresh.
          meta = null;
        }
        return applied;
      },
      // A failure is thrown as it came; only a stale apply prepares again, at once.
      { attempts: SYNC_PREPARE_ATTEMPTS, retryable: () => false, retryValue: (applied) => applied === "stale" }
    );
    if (outcome !== "stale") return outcome;
    // Base kept moving under every prepare (heavy local write traffic):
    // fall back to the original fully gated sync so it still converges.
    return this.runExclusive("syncFromRemoteIfNewer:fallback", "sync-apply", async () =>
      (await this.executeCallBody("syncFromRemoteIfNewer", [meta], { publish: true })) as boolean
    );
  }

  /**
   * Run a sequence of writes as a coalesced batch: per-call snapshot
   * publishes are suspended for the duration of `fn`, and exactly ONE
   * `library.updated` event is emitted at the end if the library version
   * changed. The terminal event uses `reason = label` so subscribers can
   * attribute the burst to a logical operation (e.g. `"commit:<jobId>"`).
   *
   * Holds the opGate exclusively for the entire batch — concurrent
   * lifecycle commands (close, clearLocalCache) and other `call`s queue
   * behind it, matching the semantics of a single long-running write.
   *
   * If `fn` throws, the exception propagates and NO terminal publish
   * fires (the renderer's view stays anchored on the prior version, which
   * is the correct semantics since the writes were partial — the next
   * successful write or `runBatch` will re-publish).
   *
   * Bug context: the commit step issues 6-15 sequential write calls
   * (linkFileToMedia → addMediaFormat × N → addMediaFormatChunks → audio
   * tracks × N → subtitle tracks × N → markMediaPlayable). Pre-fix the
   * renderer received that whole stack of full-snapshot republishes in a
   * burst, most carrying intermediate state with hasFiles=false. By the
   * time markMediaPlayable's snapshot landed (the only one that flips
   * hasFiles=true), the renderer had already paid the parse cost on
   * every prior intermediate. End-to-end this delayed the play-button
   * enable on the user's "done" event by 3-5 s.
   */
  async runBatch<T>(label: string, fn: () => Promise<T>): Promise<T> {
    // Nested case: we are already running inside an outer `runBatch`'s
    // async context. The outer holds opGate and re-entering runExclusive
    // here would deadlock (the outer is awaiting fn(), which contains
    // us). Run inline within the same batch frame; the outer's terminal
    // emit fires the single publish for the whole burst, and the outer's
    // `label` wins — that's the operation the renderer attributes the
    // event to.
    const outer = this.batchContext.getStore();
    if (outer && outer.depth > 0) {
      outer.depth += 1;
      try {
        return await fn();
      } finally {
        outer.depth -= 1;
      }
    }
    return this.runExclusive(`batch:${label}`, "batch", async () => {
      if (!this.db) throw new Error("LIBRARY_DB_NOT_OPEN");
      const versionBefore = this.db.getVersion();
      // Run fn() inside an AsyncLocalStorage frame so any nested call()
      // / runBatch() sees `depth > 0` and takes the inline path. Outside
      // callers concurrent with this batch see no frame and queue on
      // opGate normally.
      const result = await this.batchContext.run({ depth: 1 }, fn);
      // Re-check db existence — fn() could in principle drop the db
      // (it shouldn't, but be defensive on lifecycle ordering).
      if (this.db) {
        const versionAfter = this.db.getVersion();
        if (versionAfter !== versionBefore && versionAfter !== this.lastSnapshotVersion) {
          const previousVersion = this.lastSnapshotVersion;
          this.lastSnapshotVersion = versionAfter;
          this.publishLibraryDelta(versionAfter, previousVersion, label);
        }
      }
      return result;
    });
  }

  /**
   * Flush any pending sync operations to the remote API.
   */
  async flush(): Promise<void> {
    await this.runExclusive("flush", "flush", async () => {
      if (!this.db) return;
      await this.db.flushPending().catch(() => undefined);
    });
  }

  /**
   * Write per-episode skip markers in `media_skip_markers` kind by kind, keeping a higher-ranked marker already
   * there (the user's times, then detection or chapters, then the metadata service; PLAY-SKIP-08).
   *
   * Used by the badger commit step for the service-fetched markers and by the shared-audio detection after commit
   * (META-SKIP-04). Callers must NOT invoke this for movies (markers omitted by design).
   */
  async mergeSkipMarkers(
    mediaId: string,
    episodeId: string | null,
    markers: BadgerIngestSkipMarker[]
  ): Promise<void> {
    await this.call("mergeSkipMarkers", [mediaId, episodeId, markers]);
  }

  /** Store one analysis row (`media_skip_analysis`, local to this device). */
  async upsertSkipAnalysis(
    mediaId: string,
    episodeId: string | null,
    kind: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.call("upsertSkipAnalysis", [mediaId, episodeId, kind, payload]);
  }

  /**
   * Persist the full-show skip-marker cache to `media_skip_analysis` with
   * `kind = "external-skip-markers-show-v1"`. Idempotent overwrite — same
   * payload across multiple files of the same show just refreshes the
   * timestamp on the existing row.
   *
   * The renderer reads back from this row via `listSkipAnalysis` so
   * subsequent modal opens of any episode from the same show hit local
   * cache instead of round-tripping to the metadata-api.
   */
  async upsertShowSkipCache(
    showMediaId: string,
    payload: BadgerIngestShowSkipCache
  ): Promise<void> {
    await this.call("upsertSkipAnalysis", [
      showMediaId,
      null,
      EXTERNAL_SKIP_MARKER_SHOW_KIND,
      payload,
    ]);
  }

  /**
   * Returns `Map<"<season>:<episode>", episodeId>` for every episode row of
   * the given show. Used by the commit step to back-fill skip-marker rows on
   * episodes that were already imported when a new file for the show lands.
   */
  async listExistingEpisodeIds(
    showMediaId: string
  ): Promise<Map<string, string>> {
    return (await this.call("listEpisodeIdsByKey", [showMediaId])) as Map<
      string,
      string
    >;
  }

  // -------------------------------------------------------------------------
  // Offline-download bookkeeping (Phase 2 of let-s-talk-about-offline).
  //
  // Thin wrappers around `LibraryDb`'s `media_local_downloads` methods. Each
  // routes through `this.call()` so the `opGate` serialization, error
  // surfacing, and async batch context are all consistent with the rest of
  // the service. These don't persist (no version bump), so they publish no
  // snapshot update — none is needed (renderer hydrates via
  // `badger.offline.list_local`, not via getSnapshot()).
  // -------------------------------------------------------------------------

  async registerLocalDownload(input: {
    id: string;
    fileId: string;
    mediaId: string;
    quality: string;
    formatId: string;
    container: string;
    localPath: string;
    totalBytes: number;
    downloadedAt: string;
    runtimeJobId: string | null;
    schemaVersion?: number;
  }): Promise<{ inserted: number }> {
    return (await this.call("registerLocalDownload", [input])) as {
      inserted: number;
    };
  }

  async dropLocalDownloads(
    scope:
      | { type: "media"; mediaId: string }
      | { type: "file"; fileId: string }
      | { type: "files"; fileIds: string[] }
  ): Promise<{ deleted: number }> {
    return (await this.call("dropLocalDownloads", [scope])) as {
      deleted: number;
    };
  }

  async listLocalDownloads(mediaIds?: string[]): Promise<
    Array<{
      id: string;
      fileId: string;
      mediaId: string;
      quality: string;
      formatId: string;
      container: string;
      localPath: string;
      totalBytes: number;
      downloadedAt: string;
      lastVerifiedAt: string | null;
      runtimeJobId: string | null;
      schemaVersion: number;
    }>
  > {
    const args = mediaIds && mediaIds.length > 0 ? [mediaIds] : [];
    return (await this.call("listLocalDownloads", args)) as Array<{
      id: string;
      fileId: string;
      mediaId: string;
      quality: string;
      formatId: string;
      container: string;
      localPath: string;
      totalBytes: number;
      downloadedAt: string;
      lastVerifiedAt: string | null;
      runtimeJobId: string | null;
      schemaVersion: number;
    }>;
  }

  async touchLocalDownloadsVerified(
    fileIds: string[],
    verifiedAt: string
  ): Promise<{ touched: number }> {
    return (await this.call("touchLocalDownloadsVerified", [
      fileIds,
      verifiedAt,
    ])) as { touched: number };
  }

  /**
   * #671 R3: a write moved the library version. Publish what changed, not the
   * library: the previous version, the counts and the media whose details
   * changed (`null` = unknown, the consumer refetches the whole snapshot).
   * Building the full snapshot here ran ~13 queries per media on the runtime's
   * event loop for every write (1 s at 1000 media) and re-serialised it per
   * subscriber. A consumer applies the delta only when its cache is at
   * `previousVersion`; otherwise it fetches (`badger.db.snapshot`).
   */
  private publishLibraryDelta(version: number, previousVersion: number, reason: string) {
    if (!this.db) return;
    const changes = this.db.takeChangedMedia();
    const counts = this.db.getCountSummary();
    this.publishEvent?.("library", "library.updated", {
      version,
      previousVersion,
      reason,
      mediaCount: counts.mediaCount,
      playlistCount: counts.playlistCount,
      changedMediaIds: changes.all ? null : changes.mediaIds,
    });
  }

  /**
   * The one publish that still carries the whole snapshot: the library was just
   * opened and no subscriber holds a previous version to apply a delta to. It
   * runs once per open and reuses the snapshot `open` built for its count.
   */
  private publishSnapshotUpdate(snapshot: LibrarySnapshot, version: number, reason: string) {
    this.publishEvent?.("library", "library.updated", {
      version,
      reason,
      mediaCount: snapshot.media.length,
      playlistCount: snapshot.playlists.length,
      snapshot,
    });
  }
}
