/**
 * Library DB proxy that delegates to the runtime service instead of opening
 * SQLite directly. This eliminates the need for better-sqlite3 in Electron.
 *
 * The proxy maintains a local snapshot cache for zero-latency reads and
 * forwards writes to the runtime via HTTP.
 *
 * Activated by setting SF_LIBRARY_DB_RUNTIME_PROXY=1 in the environment.
 */
import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { scopeLogger } from "./logger";
import { isAppWindowMarkedHidden, onAppWindowVisibilityChange } from "./appWindowVisibility";
import { setLibraryDbAccessorToken } from "./libraryDbAccessor";
import {
  badgerDbOpen,
  badgerDbOpenLocal,
  badgerDbClose,
  badgerDbClearLocalCache,
  badgerDbSnapshot,
  badgerDbCall,
  badgerDbStatus,
} from "@space/runtime-contracts/badger/db";
import { createRuntimeSession, type RuntimeSessionHandle } from "@space/runtime-client/session";
import { createRuntimeCommandClient } from "@space/runtime-client/command";
import { runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";
import {
  createRuntimeEventStream,
  type RuntimeEventStreamHandle,
} from "@space/runtime-client/events";
import type { RuntimeEventFrame } from "@space/runtime-contracts/envelope";
import { mergeSnapshotDelta, readLibraryFrame, type LibrarySnapshotDelta } from "./librarySnapshotDelta";
import type { LibrarySnapshot } from "../shared/libraryTypes";
import { setActivePlaybackProfileId } from "./activePlaybackProfile";
import { parseActiveProfileArg, type ActiveProfileArg } from "./activeProfileArg";

const logger = scopeLogger("library-db-proxy");

const RUNTIME_BASE_URL = String(process.env.SF_RUNTIME_BASE_URL ?? "http://127.0.0.1:3020")
  .trim()
  .replace(/\/+$/, "");

type LibraryDbHandle = "default";
/** `userId`: the signed-in account, whose own library dir the runtime opens (LIB-STORE-06). */
type OpenPayload = { token: string; keyBase64: string; userId?: string };
const openPayloadOf = (payload: OpenPayload): OpenPayload => ({
  token: payload.token,
  keyBase64: payload.keyBase64,
  userId: payload.userId,
});
type CallPayload = { handle?: LibraryDbHandle; method: string; args?: unknown[] };

let getWindow: (() => BrowserWindow | null) | null = null;
let session: RuntimeSessionHandle | null = null;
let client: ReturnType<typeof createRuntimeCommandClient> | null = null;
let dbOpen = false;
// ACCT-SQUAD-02: the profile the renderer last made active (`setActiveProfile`). The runtime holds it in memory only,
// so a respawned runtime gets it again before the library serves calls (`reopenAfterRuntimeRespawn`).
let lastActiveProfile: ActiveProfileArg | null = null;
let cachedSnapshot: Record<string, unknown> | null = null;
// Phase 6: latest library snapshot version observed from either the runtime's
// `badger.library.updated` SSE event or a snapshot fetch. Forwarded to the
// renderer alongside the snapshot payload so the play-button gate can
// compare against the per-job `libraryVersionAtDone` stamp. `undefined` until
// the first version becomes known.
let lastEmittedVersion: number | undefined = undefined;
let libraryEventStream: RuntimeEventStreamHandle | null = null;
// Round-12 #4: cache the last successful open payload so `reopenAfterRuntimeRespawn`
// can re-fire `badger.db.open` against a freshly-respawned runtime without
// requiring a user re-login. Cleared on logout (sf-library-db-clear-local-cache).
type OpenMode = "open" | "open-local";
let lastOpen: { payload: OpenPayload; mode: OpenMode } | null = null;

// #25: library version of `cachedSnapshot`'s CONTENT (as opposed to
// `lastEmittedVersion`, the newest version the play-button gate has heard
// of). Snapshots only replace the cache when they are newer than this, so a
// late frame or fetch can never regress the renderer. `undefined` = unknown
// (fresh open / re-open / an older runtime that doesn't stamp versions):
// the next snapshot is accepted unconditionally.
let cachedSnapshotVersion: number | undefined = undefined;
// Bumped whenever the library identity can change (open, logout, re-open
// after a runtime respawn, test reset) so a snapshot fetch that started
// before the change is dropped instead of landing in the new library.
let snapshotEpoch = 0;
// Writers waiting for the `badger.library.updated` frame that carries their
// write's snapshot (see `refreshAndEmitProxySnapshot`).
type SnapshotWaiter = { version: number; settle: (delivered: boolean) => void };
let snapshotWaiters: SnapshotWaiter[] = [];
// Single-flight snapshot fetching. Callers arriving while a fetch runs
// register what they need (`pendingFullReason` / `pendingDeltaIds`) and the
// running loop serves it in one follow-up fetch.
let snapshotFetchInFlight: Promise<void> | null = null;
// A full `badger.db.snapshot` is wanted (reason of the first asker).
let pendingFullReason: string | null = null;
// #671 R3: media whose details the frames since the last fetch changed, the
// newest such frame version, and the `source` label the apply will carry.
const pendingDeltaIds = new Set<string>();
let pendingDeltaTip: number | undefined = undefined;
let pendingDeltaSource: string | null = null;
// Newest frame version the cache will cover once the queued/in-flight delta
// fetches land. A new frame whose `previousVersion` is at or below
// max(cache version, this) continues the chain and can be applied as a delta.
let deltaChainTip: number | undefined = undefined;
let snapshotFetchCount = 0;
// How long a write waits for its `badger.library.updated` frame before
// falling back to fetching the snapshot. The runtime publishes the frame
// before it writes the command's HTTP response, so on a healthy stream the
// frame is normally already applied when the write returns.
export const SNAPSHOT_FRAME_WAIT_MS = 750;

// Throttle/dedupe state for snapshot pushes to the renderer.
// During ingest finalization, dozens of writes per second each fetch a fresh
// snapshot; without coalescing, every push triggers a synchronous renderer
// state update and busts React memo. 200ms trailing-edge throttle + JSON
// dedupe keeps the window steady. Mirrors labQueueRuntimeEmitter.ts.
const SNAPSHOT_EMIT_THROTTLE_MS = 200;
let lastEmittedJson: string | null = null;
let lastEmittedVersionForDedup: number | undefined = undefined;
let lastEmitAt = 0;
let pendingEmitTimer: ReturnType<typeof setTimeout> | null = null;
let trackedWindow: BrowserWindow | null = null;

// Issue #25 P1: the engine persists playback progress every second while the
// app window is hidden behind external mpv. Each save's
// `badger.library.updated` frame (reason "setProgress") used to be pushed to
// the hidden renderer, which rebuilt media / mediaDetailsMap / settingsMap
// and re-rendered every library consumer: 12–15 % renderer CPU for a window
// nobody sees. While the window is marked hidden, progress-only frames update
// the cache (reads and waiters stay current) but are not pushed; the latest
// snapshot is pushed once on show. Any other emit (commit, ingest, settings,
// a forced write) still goes out and carries the held progress with it.
const PROGRESS_ONLY_FRAME_SOURCE = "frame:setProgress";
let heldWhileHidden = 0;
let unsubscribeVisibility: (() => void) | null = null;

const performSnapshotEmit = () => {
  pendingEmitTimer = null;
  const window = getWindow?.() ?? null;
  if (!window || window.isDestroyed() || !cachedSnapshot) return;
  // This push carries the newest cache, held progress frames included.
  heldWhileHidden = 0;
  const json = JSON.stringify(cachedSnapshot);
  // Dedup on (snapshot bytes + version) — a version-only change with the
  // same snapshot must still emit so the renderer's gate observes the bump.
  if (json === lastEmittedJson && lastEmittedVersion === lastEmittedVersionForDedup) return;
  lastEmittedJson = json;
  lastEmittedVersionForDedup = lastEmittedVersion;
  lastEmitAt = Date.now();
  try {
    // Phase 6: send the new shape `{ snapshot, version }`. The renderer's
    // listener accepts both this shape and the legacy bare-snapshot shape
    // for back-compat (older preloads in the field).
    window.webContents.send("sf-library-db-snapshot", {
      snapshot: cachedSnapshot,
      version: lastEmittedVersion,
    });
  } catch {
    // Ignore errors to avoid breaking other flows
  }
};

const scheduleSnapshotEmit = (options: { force?: boolean; progressOnly?: boolean } = {}) => {
  const window = getWindow?.() ?? null;
  if (!window || window.isDestroyed() || !cachedSnapshot) return;
  if (options.progressOnly && !options.force && isAppWindowMarkedHidden(window)) {
    heldWhileHidden += 1;
    // Logged once per hidden span; the count is logged at the show flush.
    if (heldWhileHidden === 1) {
      logger.info({ event: "snapshot_emit_held_hidden", version: cachedSnapshotVersion ?? null });
    }
    return;
  }
  // Hook the active window once for flush-on-close.
  if (trackedWindow !== window) {
    trackedWindow = window;
    const flushAndCleanup = () => {
      if (pendingEmitTimer) {
        clearTimeout(pendingEmitTimer);
        pendingEmitTimer = null;
        performSnapshotEmit();
      }
      trackedWindow = null;
    };
    window.once("close", flushAndCleanup);
    window.webContents.once("destroyed", () => {
      if (pendingEmitTimer) {
        clearTimeout(pendingEmitTimer);
        pendingEmitTimer = null;
      }
      trackedWindow = null;
    });
  }
  // Force-flush bypasses the throttle window for commit-step events: the
  // play-button gate is the load-bearing consumer and must see the new
  // version within ms of commit, not after the next 200ms tick.
  if (options.force) {
    if (pendingEmitTimer) {
      clearTimeout(pendingEmitTimer);
      pendingEmitTimer = null;
    }
    performSnapshotEmit();
    return;
  }
  const now = Date.now();
  const sinceLast = now - lastEmitAt;
  if (sinceLast >= SNAPSHOT_EMIT_THROTTLE_MS && !pendingEmitTimer) {
    // Idle: emit immediately (leading edge of an idle period).
    performSnapshotEmit();
    return;
  }
  // Within throttle window: schedule a single trailing-edge flush.
  if (pendingEmitTimer) return;
  const wait = Math.max(0, SNAPSHOT_EMIT_THROTTLE_MS - sinceLast);
  pendingEmitTimer = setTimeout(performSnapshotEmit, wait);
};

const ensureClient = (backendToken: string) => {
  if (session) {
    session.setBackendToken(backendToken);
  } else {
    session = createRuntimeSession({
      runtimeBaseUrl: RUNTIME_BASE_URL,
      backendToken,
      apps: ["badger"],
      ownerSecret: runtimeOwnerSecretProvider,
      onTokenChange: (token) => {
        if (token) setLibraryDbAccessorToken(token);
      },
    });
    client = createRuntimeCommandClient({
      session,
      runtimeBaseUrl: RUNTIME_BASE_URL,
      requestIdPrefix: "proxy",
    });
  }
  return client!;
};

let reopenGeneration = 0;

/**
 * True for failures that mean "the runtime was not reachable" (refused / reset /
 * fetch failed) as opposed to a real library error (decrypt, format-too-new).
 * Only the former keep the open payload for the post-restart re-open.
 */
const errorChainText = (err: unknown): string => {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    if ("code" in current) parts.push(String(current.code));
    current = current.cause;
  }
  return parts.join(" ");
};

const isRuntimeUnreachableError = (err: unknown): boolean =>
  /ECONNREFUSED|ECONNRESET|EPIPE|fetch failed|unable to connect|UND_ERR_|socket hang up|runtime_login_http_5\d\d/i.test(errorChainText(err));

// ---------------------------------------------------------------------------
// #25 P2: library calls survive a runtime restart.
//
// The guardian kills/respawns the runtime on the same port. Every call in
// flight (or sent before the re-open lands) failed with `fetch failed`
// (ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT / "other side closed") or with
// `LIBRARY_DB_NOT_OPEN` from the fresh runtime, and the renderer showed an
// error instead of waiting a second. Calls now wait for the restart to finish
// (guardian `ready` + the library re-open) and retry ONCE when that is safe:
//   - reads always;
//   - any method the runtime provably did not execute (connection never
//     established, or `LIBRARY_DB_NOT_OPEN`);
//   - absolute-value setters, whose replay is a no-op, when the connection
//     dropped mid-request (the runtime may or may not have applied it).
// Every other write that died mid-request is NOT replayed: it may already have
// been applied and inserts are not idempotent. It fails as before.
// ---------------------------------------------------------------------------

/**
 * Upper bound a call waits for the runtime to come back before its single
 * retry, while only a failed call (not the guardian) has reported the outage.
 */
export const RUNTIME_RESTART_WAIT_MS = 20_000;

/**
 * Upper bound once the guardian owns the gate ("starting" or "restarting"):
 * its own outcome — "ready" + re-open, or "lost" — normally ends the wait
 * first. A respawn on a loaded host takes up to ~70 s (#25 P20); this only
 * bounds a guardian that never reports. Matches the guardian's healthGraceMaxMs.
 */
export const RUNTIME_GUARDIAN_RESTART_WAIT_MS = 120_000;

/**
 * How a library method may be replayed after a connection drop mid-request:
 * `read` has no side effect; `idempotent-write` sets an absolute value
 * (upsert / update by id), so applying it twice equals applying it once.
 * Methods absent here are never replayed after a mid-request drop.
 */
export const LIBRARY_REPLAYABLE_METHODS: Record<string, "read" | "idempotent-write"> = {
  getCountSummary: "read",
  getDatasetStatus: "read",
  getActiveProfile: "read",
  getDebugSnapshot: "read",
  getMediaDetails: "read",
  getMediaObjectKeys: "read",
  getMediaStorageBytes: "read",
  getSetting: "read",
  getSnapshot: "read",
  getSystemPlaylistId: "read",
  getVersion: "read",
  hasAnyMedia: "read",
  hasPendingSync: "read",
  isClosed: "read",
  listArtworkToCopy: "read",
  listMediaWithArtworkToCopy: "read",
  listMediaWithCollapsedCast: "read",
  listMediaMissingCrew: "read",
  listEpisodeIdsByKey: "read",
  listIngestJobEvents: "read",
  listIngestJobs: "read",
  listLocalDownloads: "read",
  listMedia: "read",
  listMediaFormats: "read",
  listPlaylistItems: "read",
  listPlaylists: "read",
  listSkipAnalysis: "read",
  listViewingProfileIds: "read",
  mediaHasVideoFiles: "read",
  resolveEpisodeId: "read",
  applyArtworkCopies: "idempotent-write",
  replaceMediaTitleArt: "idempotent-write",
  setActiveProfile: "idempotent-write",
  setProgress: "idempotent-write",
  setSetting: "idempotent-write",
  setDefaultAudioTrack: "idempotent-write",
  setDefaultSubtitleTrack: "idempotent-write",
  setTrackPrefs: "idempotent-write",
  updateAudioTrack: "idempotent-write",
  updateSubtitleTrack: "idempotent-write",
  wipeProfileViewing: "idempotent-write",
};

/** How often a gate opened by a failed call (not by the guardian) probes the runtime. */
export const RESTART_PROBE_INTERVAL_MS = 1_000;

type RestartGate = {
  /** Resolves with the release outcome ("probe-library-open", "probe-timeout", "guardian-lost", ...). */
  promise: Promise<string>;
  resolve: (outcome: string) => void;
  /** "guardian-starting", "guardian-restarting" or "call-failed:<kind>"; a guardian report takes over a call-opened gate. */
  reason: string;
  openedAt: number;
};

/**
 * Gate outcomes that prove the runtime did NOT come back. A call that waited
 * behind such a gate sends once and fails fast: opening a fresh gate and
 * waiting RUNTIME_RESTART_WAIT_MS again would cost ~2 x RUNTIME_RESTART_WAIT_MS
 * for one call (run 7950 runtime-crash-recovery).
 */
const RUNTIME_NOT_RECOVERED_OUTCOMES: Record<string, true> = {
  "probe-timeout": true,
  "guardian-lost": true,
  "reopen-retries-exhausted": true,
  timeout: true,
};

let restartGate: RestartGate | null = null;
// Guardian gave up ("lost"): failed calls fail immediately instead of waiting
// for a restart that will not come. Cleared by the next "restarting" or re-open.
let runtimeLost = false;

/**
 * A gate opened by a failed call may never see a guardian "ready": the drop was
 * transient, or the call failed late, after the re-open had already landed.
 * One prober per gate (never one per waiting call, so a burst of failures
 * costs one `badger.db.status` per second) releases it as soon as the runtime
 * answers with the library open. It stops once the guardian owns the gate:
 * a runtime being restarted may still answer from its old instance.
 */
const probeWhileGated = async (gate: RestartGate): Promise<void> => {
  let probes = 0;
  while (restartGate === gate && gate.reason.startsWith("call-failed") && Date.now() - gate.openedAt < RUNTIME_RESTART_WAIT_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, RESTART_PROBE_INTERVAL_MS));
    if (restartGate !== gate || !gate.reason.startsWith("call-failed") || !client) return;
    probes += 1;
    try {
      const status = await client.sendCommand(badgerDbStatus, {});
      if (status.open) {
        logger.info({ event: "runtime_restart_probe_ok", probes }, "runtime answers with the library open");
        if (restartGate === gate) releaseRestartGate("probe-library-open");
        return;
      }
      logger.info({ event: "runtime_restart_probe_waiting", probes, open: status.open }, "runtime up, library not re-opened yet");
    } catch (error) {
      logger.info(
        { event: "runtime_restart_probe_failed", probes, error: error instanceof Error ? error.message : String(error) },
        "runtime still unreachable",
      );
    }
  }
  // Probe window over and nobody recovered the runtime. Without a guardian
  // (external runtime: SF_RUNTIME_BASE_URL) nothing else would ever release this
  // gate, and every later call would pay RUNTIME_RESTART_WAIT_MS before sending
  // plus RUNTIME_RESTART_WAIT_MS before its retry. Release it so the next call
  // tries the runtime directly and opens a fresh gate if it is still down.
  if (restartGate === gate && gate.reason.startsWith("call-failed")) {
    logger.warn(
      { event: "runtime_restart_probe_timeout", probes, reason: gate.reason, heldMs: Date.now() - gate.openedAt },
      "runtime did not come back within the probe window; releasing the restart gate",
    );
    releaseRestartGate("probe-timeout");
  }
};

/** The guardian owns the gate: only its "ready" (re-open) or "lost" ends it, not a probe. */
const isGuardianGate = (reason: string): boolean => reason.startsWith("guardian-");

const openRestartGate = (reason: string): void => {
  if (restartGate) {
    if (isGuardianGate(reason) && restartGate.reason !== reason) {
      logger.info({ event: "runtime_restart_gate_taken_over", from: restartGate.reason, to: reason }, "guardian reports " + reason.slice("guardian-".length));
      restartGate.reason = reason;
    }
    return;
  }
  let resolve!: (outcome: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  const gate: RestartGate = { promise, resolve, reason, openedAt: Date.now() };
  restartGate = gate;
  logger.warn({ event: "runtime_restart_gate_opened", reason }, "library calls will wait for the runtime to come back");
  if (reason.startsWith("call-failed")) void probeWhileGated(gate);
};

const releaseRestartGate = (outcome: string): void => {
  const gate = restartGate;
  if (!gate) return;
  restartGate = null;
  logger.info(
    { event: "runtime_restart_gate_released", reason: gate.reason, outcome, heldMs: Date.now() - gate.openedAt },
    "library calls released after runtime restart",
  );
  gate.resolve(outcome);
};

/**
 * #928: the window opens while the guardian is still spawning the runtime (a
 * cold spawn takes ~17 s on a 2-core Celeron). Library calls made before its
 * first "ready" wait for it exactly like calls during a restart.
 */
export const noteRuntimeStarting = (): void => {
  runtimeLost = false;
  openRestartGate("guardian-starting");
};

/** Guardian "restarting": hold library calls until the runtime is back and the library re-opened. */
export const noteRuntimeRestarting = (): void => {
  runtimeLost = false;
  openRestartGate("guardian-restarting");
};

/** Guardian "lost": the runtime will not come back; let waiters fail now instead of at the timeout. */
export const noteRuntimeLost = (): void => {
  runtimeLost = true;
  releaseRestartGate("guardian-lost");
};

export type LibraryCallFailureKind = "not-delivered" | "library-not-open" | "connection-dropped" | "other";

export const classifyLibraryCallFailure = (err: unknown): LibraryCallFailureKind => {
  const text = errorChainText(err);
  if (/LIBRARY_DB_NOT_OPEN/.test(text)) return "library-not-open";
  // The TCP connection was never established: the runtime never saw the request.
  if (/ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|EHOSTUNREACH|ENETUNREACH/.test(text)) return "not-delivered";
  if (isRuntimeUnreachableError(err)) return "connection-dropped";
  return "other";
};

/**
 * Wait behind the current restart gate, if any. Returns "no-gate", "timeout"
 * (this call's own RUNTIME_RESTART_WAIT_MS ran out) or the gate's release outcome.
 */
const waitForRuntimeRecovery = async (method: string, phase: "before-send" | "before-retry"): Promise<string> => {
  const gate = restartGate;
  if (!gate) return "no-gate";
  const startedAt = Date.now();
  const released = gate.promise;
  let waitedMs = 0;
  let outcome = "timeout";
  // #25 P20: a call-opened gate gives up after RUNTIME_RESTART_WAIT_MS; one the
  // guardian owns (possibly taken over mid-wait) waits for the guardian's outcome.
  for (;;) {
    const limitMs = isGuardianGate(gate.reason) ? RUNTIME_GUARDIAN_RESTART_WAIT_MS : RUNTIME_RESTART_WAIT_MS;
    if (waitedMs >= limitMs) break;
    const sliceMs = limitMs - waitedMs;
    let timer: NodeJS.Timeout | undefined;
    outcome = await Promise.race([
      released,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), sliceMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome !== "timeout") break;
    waitedMs += sliceMs;
  }
  logger.info(
    {
      event: "library_call_waited_for_runtime",
      method,
      phase,
      outcome: outcome === "timeout" ? "timeout" : "released",
      releaseOutcome: outcome,
      waitedMs: Date.now() - startedAt,
      gateReason: gate.reason,
    },
    "library call waited for runtime restart",
  );
  return outcome;
};

/**
 * For runtime calls outside the library proxy (runtime jobs, key forwarding):
 * wait while the guardian is starting or restarting the runtime, bounded like
 * a library call. Resolves at once when no guardian gate is open; never rejects.
 */
export const waitForGuardianRuntime = async (label: string): Promise<void> => {
  if (restartGate && isGuardianGate(restartGate.reason)) await waitForRuntimeRecovery(label, "before-send");
};

/**
 * Run one library command so it survives a runtime restart (see block comment above).
 * `send` must issue the command against the current client each time it is called.
 */
const sendSurvivingRestart = async <T>(method: string, send: () => Promise<T>): Promise<T> => {
  const beforeSend = await waitForRuntimeRecovery(method, "before-send");
  try {
    return await send();
  } catch (error) {
    const kind = classifyLibraryCallFailure(error);
    const message = error instanceof Error ? error.message : String(error);
    const retrySafe =
      kind === "not-delivered" ||
      kind === "library-not-open" ||
      (kind === "connection-dropped" && Object.hasOwn(LIBRARY_REPLAYABLE_METHODS, method));
    // The gate this call already waited behind proved the runtime did not come
    // back: fail now instead of opening a fresh gate and waiting a second
    // RUNTIME_RESTART_WAIT_MS (one bounded wait per call).
    const alreadyWaitedInVain = Object.hasOwn(RUNTIME_NOT_RECOVERED_OUTCOMES, beforeSend);
    if (!retrySafe || runtimeLost || alreadyWaitedInVain) {
      logger.warn(
        { event: "library_call_failed_no_retry", method, kind, runtimeLost, beforeSend, error: message },
        "library call failed; not retried",
      );
      throw error;
    }
    // A connection failure means the runtime is (re)starting even if the
    // guardian has not said so yet; the guardian's "ready" + the library
    // re-open release the gate; RUNTIME_RESTART_WAIT_MS bounds the wait until
    // the guardian takes it over, RUNTIME_GUARDIAN_RESTART_WAIT_MS after.
    openRestartGate(`call-failed:${kind}`);
    logger.warn(
      { event: "library_call_retrying_after_restart", method, kind, error: message },
      "library call failed across a runtime restart; waiting for the runtime, then retrying once",
    );
    await waitForRuntimeRecovery(method, "before-retry");
    try {
      const result = await send();
      logger.info({ event: "library_call_retry_succeeded", method, kind }, "library call succeeded on retry");
      return result;
    } catch (retryError) {
      logger.warn(
        {
          event: "library_call_retry_failed",
          method,
          kind,
          error: retryError instanceof Error ? retryError.message : String(retryError),
        },
        "library call failed again after the runtime restart",
      );
      throw retryError;
    }
  }
};

/**
 * Send badger.db.open / badger.db.open-local. A failure because the runtime is
 * down (F5: app relaunched while the previous runtime was dying) keeps the payload
 * in `lastOpen`, so the guardian's next "ready" re-opens the library without the
 * renderer having to retry.
 */
const sendOpenCommand = async (
  c: NonNullable<typeof client>,
  mode: OpenMode,
  payload: OpenPayload,
): Promise<void> => {
  try {
    await c.sendCommand(mode === "open-local" ? badgerDbOpenLocal : badgerDbOpen, openPayloadOf(payload));
  } catch (error) {
    if (isRuntimeUnreachableError(error)) {
      // The renderer tries the remote `open` first and only falls back to
      // `open_local` when that fails. Keep the remote intent for the same
      // credentials so a failed fallback does not downgrade the re-open to a
      // sync-disabled local open that could land after the renderer's own
      // remote re-open.
      const keepRemoteIntent =
        mode === "open-local" &&
        lastOpen?.mode === "open" &&
        lastOpen.payload.token === payload.token &&
        lastOpen.payload.keyBase64 === payload.keyBase64 &&
        lastOpen.payload.userId === payload.userId;
      if (!keepRemoteIntent) {
        lastOpen = { payload: openPayloadOf(payload), mode };
      }
      logger.warn(
        { mode, error: error instanceof Error ? error.message : String(error) },
        "library open failed: runtime unreachable; will re-open when the runtime is ready",
      );
    }
    throw error;
  }
};

const emitSnapshotToRenderer = (options: { force?: boolean; progressOnly?: boolean } = {}) => {
  scheduleSnapshotEmit(options);
};

/**
 * #25: replace the cached snapshot if `snapshot` is newer than what the cache
 * holds, settle writers waiting for that version, and push it to the
 * renderer. Returns false (and leaves the cache alone) for a stale snapshot —
 * an out-of-order frame or a fetch that started before a newer frame landed.
 */
const applySnapshot = (
  snapshot: Record<string, unknown>,
  version: number | undefined,
  options: { force?: boolean; source: string }
): boolean => {
  if (
    cachedSnapshot &&
    typeof version === "number" &&
    typeof cachedSnapshotVersion === "number" &&
    version <= cachedSnapshotVersion
  ) {
    logger.info({ event: "snapshot_apply_skipped_stale", source: options.source, version, cachedSnapshotVersion });
    return false;
  }
  // Stamp the content version on the cached copy (frame payloads carry it
  // beside the snapshot, not inside) so `getVersion` and the renderer's
  // `snapshot.version` fallback read the version this content is at.
  cachedSnapshot = typeof version === "number" ? { ...snapshot, version } : snapshot;
  cachedSnapshotVersion = version;
  if (typeof version === "number" && (lastEmittedVersion === undefined || version > lastEmittedVersion)) {
    lastEmittedVersion = version;
  }
  if (typeof version === "number" && snapshotWaiters.length > 0) {
    const remaining: SnapshotWaiter[] = [];
    for (const waiter of snapshotWaiters) {
      if (waiter.version <= version) waiter.settle(true);
      else remaining.push(waiter);
    }
    snapshotWaiters = remaining;
  }
  logger.info({ event: "snapshot_applied", source: options.source, version: version ?? null, force: Boolean(options.force) });
  emitSnapshotToRenderer({ force: options.force, progressOnly: options.source === PROGRESS_ONLY_FRAME_SOURCE });
  return true;
};

/** Wake every waiter (logout / reset / re-open): nothing they wait for will arrive. */
const releaseSnapshotWaiters = () => {
  const waiters = snapshotWaiters;
  snapshotWaiters = [];
  for (const waiter of waiters) waiter.settle(false);
};

/**
 * The library behind the cache may change identity (open, logout, re-open
 * after a runtime respawn): forget the content version so the next snapshot
 * is accepted unconditionally, drop in-flight fetches from before, and wake
 * writers whose frame will never arrive.
 */
const invalidateCachedSnapshotVersion = (reason: string) => {
  logger.info({ event: "snapshot_version_invalidated", reason, cachedSnapshotVersion: cachedSnapshotVersion ?? null });
  snapshotEpoch += 1;
  cachedSnapshotVersion = undefined;
  // Queued deltas belong to the previous library; the next frame is not a continuation.
  pendingDeltaIds.clear();
  pendingDeltaTip = undefined;
  pendingDeltaSource = null;
  deltaChainTip = undefined;
  releaseSnapshotWaiters();
};

/**
 * Resolve true once the cache holds `version` (or newer), false after
 * `SNAPSHOT_FRAME_WAIT_MS` without it.
 */
const waitForSnapshotVersion = (version: number): Promise<boolean> => {
  if (typeof cachedSnapshotVersion === "number" && cachedSnapshotVersion >= version) {
    return Promise.resolve(true);
  }
  // Executor form: the desktop tsconfig targets a lib without
  // Promise.withResolvers (es2024).
  return new Promise<boolean>((resolve) => {
    const waiter: SnapshotWaiter = {
      version,
      settle: (delivered) => {
        clearTimeout(timer);
        resolve(delivered);
      },
    };
    const timer = setTimeout(() => {
      snapshotWaiters = snapshotWaiters.filter((w) => w !== waiter);
      resolve(false);
    }, SNAPSHOT_FRAME_WAIT_MS);
    snapshotWaiters.push(waiter);
  });
};

const runSnapshotFetch = async (reason: string): Promise<void> => {
  const c = client;
  if (!c || !dbOpen) {
    logger.warn({ event: "snapshot_fetch_skipped", reason, hasClient: !!c, dbOpen });
    return;
  }
  const epoch = snapshotEpoch;
  snapshotFetchCount += 1;
  const startedAt = Date.now();
  logger.info({ event: "snapshot_fetch_start", reason, fetchCount: snapshotFetchCount });
  try {
    const snapshot = (await c.sendCommand(badgerDbSnapshot, {})) as Record<string, unknown>;
    if (epoch !== snapshotEpoch) {
      logger.info({ event: "snapshot_fetch_dropped_epoch_changed", reason });
      return;
    }
    const version = typeof snapshot.version === "number" ? snapshot.version : undefined;
    applySnapshot(snapshot, version, { source: `fetch:${reason}` });
    logger.info({ event: "snapshot_fetch_done", reason, version: version ?? null, ms: Date.now() - startedAt });
  } catch (error) {
    logger.warn({
      event: "snapshot_fetch_failed",
      reason,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * #671 R3: fetch the delta snapshot for `mediaIds` and merge it into the cache.
 * The merged snapshot is stamped `tip`, the newest frame version whose media
 * are all in `mediaIds` — NOT the runtime's version at response time: a frame
 * newer than `tip` may have changed other media, and the delta carries no
 * details for those. Returns false when the caller must fetch the full
 * snapshot instead (no cache to merge into, a media without details, failure).
 */
const runDeltaFetch = async (mediaIds: string[], tip: number | undefined, source: string): Promise<boolean> => {
  const c = client;
  if (!c || !dbOpen) {
    logger.warn({ event: "snapshot_delta_skipped", source, hasClient: !!c, dbOpen });
    return true;
  }
  const epoch = snapshotEpoch;
  snapshotFetchCount += 1;
  const startedAt = Date.now();
  logger.info({ event: "snapshot_delta_start", source, mediaCount: mediaIds.length, fetchCount: snapshotFetchCount });
  try {
    // The runtime's response is a LibrarySnapshot plus `version` and `partial`.
    const delta = (await c.sendCommand(badgerDbSnapshot, { mediaIds })) as LibrarySnapshotDelta;
    if (epoch !== snapshotEpoch) {
      logger.info({ event: "snapshot_delta_dropped_epoch_changed", source });
      return true;
    }
    const base = cachedSnapshot as LibrarySnapshot | null;
    if (!delta.partial) {
      // A runtime that ignores `mediaIds` answered with the full snapshot.
      applySnapshot(delta, delta.version, { source });
      return true;
    }
    const merged = base ? mergeSnapshotDelta(base, delta) : null;
    if (!merged) {
      logger.warn({ event: "snapshot_delta_unmergeable", source, hasBase: !!base });
      return false;
    }
    const applied = applySnapshot(merged, tip ?? delta.version, { source });
    logger.info({
      event: "snapshot_delta_done",
      source,
      applied,
      version: tip ?? delta.version ?? null,
      mediaCount: mediaIds.length,
      ms: Date.now() - startedAt,
    });
    return true;
  } catch (error) {
    logger.warn({
      event: "snapshot_delta_failed",
      source,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

/**
 * Serve the queued fetches one at a time: a full fetch if anyone asked for it
 * (it covers every queued delta), else one delta for all queued media. Frames
 * arriving mid-fetch queue more work for the same loop, so a burst costs one
 * in-flight fetch plus one follow-up. Callers must queue work before calling.
 * Never rejects: failures are logged and the cache keeps its last good
 * snapshot.
 */
const drainSnapshotFetches = (): Promise<void> => {
  if (snapshotFetchInFlight) return snapshotFetchInFlight;
  snapshotFetchInFlight = (async () => {
    try {
      // A delta is queued once its frame set `pendingDeltaTip`, even with no media ids: a media-free write
      // (a setting, a playlist, an ingest job) still changes the lists the delta snapshot carries.
      while (pendingFullReason !== null || pendingDeltaTip !== undefined) {
        if (pendingFullReason !== null) {
          const reason = pendingFullReason;
          pendingFullReason = null;
          pendingDeltaIds.clear();
          pendingDeltaTip = undefined;
          pendingDeltaSource = null;
          await runSnapshotFetch(reason);
          continue;
        }
        const mediaIds = [...pendingDeltaIds];
        const tip = pendingDeltaTip;
        const source = pendingDeltaSource ?? "frame:";
        pendingDeltaIds.clear();
        pendingDeltaTip = undefined;
        pendingDeltaSource = null;
        if (!(await runDeltaFetch(mediaIds, tip, source))) pendingFullReason = `delta-fallback:${source}`;
      }
    } finally {
      // Same synchronous turn as the loop's last check: nothing can queue
      // work between "queue empty" and "no fetch in flight".
      snapshotFetchInFlight = null;
      deltaChainTip = undefined;
    }
  })();
  return snapshotFetchInFlight;
};

const fetchSnapshotCoalesced = (reason: string): Promise<void> => {
  if (snapshotFetchInFlight) logger.info({ event: "snapshot_fetch_coalesced", reason });
  pendingFullReason ??= reason;
  return drainSnapshotFetches();
};

/**
 * Phase 6: handle a `badger.library.updated` SSE frame from the runtime.
 *
 * The runtime publishes this event via `BadgerLibraryDbService.publishLibraryDelta`
 * after every call that changed the library version (or once per coalesced
 * commit-step batch via `runBatch`). Pre-Phase-6, the desktop main only
 * learned of these writes by re-fetching the snapshot after a write IPC call
 * — so out-of-band writes inside the runtime (commit step) only reached the
 * renderer via the API server's `/library/db/stream` (an 8-10 s round-trip).
 * Subscribing the desktop main directly closes that gap.
 *
 * #671 R3: the frame no longer carries the library. It carries
 * `{ version, previousVersion, changedMediaIds }` (the `opened` frame is the
 * one exception and embeds the snapshot). When the cache is at or past
 * `previousVersion` (so the frame continues what we hold) and the runtime
 * attributed the change to specific media, we fetch a delta snapshot for those
 * media and merge it. Anything else — unknown media (`null`), a version gap
 * (a missed frame), no cache — falls back to one coalesced full fetch, unless
 * the cache is already at that version. For a delta frame the version the
 * play-button gate hears only advances once the merged content is in the cache.
 *
 * `commit:<jobId>` reasons force-bypass the throttle window so the play
 * button enables as soon as commit lands; other reasons go through the
 * normal 200ms throttle to keep React memo stable during ingest bursts.
 */
const handleLibraryEvent = (frame: RuntimeEventFrame): void => {
  if (frame.event !== "badger.library.updated") return;
  const { version, previousVersion, reason, changedMediaIds, snapshot } = readLibraryFrame(frame.payload);
  const force = reason.startsWith("commit:");
  const noteFrameVersion = () => {
    // Only advance forward — out-of-order frames must not regress the
    // renderer's last-seen version.
    if (typeof version === "number" && (lastEmittedVersion === undefined || version > lastEmittedVersion)) {
      lastEmittedVersion = version;
    }
  };
  if (snapshot) {
    noteFrameVersion();
    // A stale frame still has to surface a version bump to the gate.
    if (!applySnapshot(snapshot, version, { force, source: `frame:${reason}` }) && force) {
      emitSnapshotToRenderer({ force: true });
    }
    return;
  }
  const coverTip = Math.max(cachedSnapshotVersion ?? -Infinity, deltaChainTip ?? -Infinity);
  if (typeof version === "number" && coverTip >= version) {
    // The cache is at this version, or a delta that covers it is in flight
    // (and bumps `lastEmittedVersion` itself once merged).
    logger.info({ event: "snapshot_frame_already_current", reason, version });
    if (force) emitSnapshotToRenderer({ force: true });
    return;
  }
  if (
    typeof version === "number" &&
    typeof previousVersion === "number" &&
    typeof cachedSnapshotVersion === "number" &&
    cachedSnapshot &&
    changedMediaIds &&
    previousVersion <= coverTip
  ) {
    // `lastEmittedVersion` is deliberately NOT advanced here: the delta
    // content is still in flight, and an emit before it merges (throttle
    // timer, window show, forced emit) would label the old cache with the
    // new version. `applySnapshot` advances it with the merged content.
    for (const id of changedMediaIds) pendingDeltaIds.add(id);
    pendingDeltaTip = version;
    deltaChainTip = version;
    // A progress-only batch stays progress-only; any other reason wins.
    const source = `frame:${reason}`;
    if (pendingDeltaSource === null || pendingDeltaSource === PROGRESS_ONLY_FRAME_SOURCE) pendingDeltaSource = source;
    void drainSnapshotFetches().then(() => {
      if (force) emitSnapshotToRenderer({ force: true });
    });
    return;
  }
  // Full-fetch fallback: the gate hears the frame's version right away, as it
  // did before delta frames.
  noteFrameVersion();
  // Fire-and-forget: this runs on the stream's message handler.
  void fetchSnapshotCoalesced(`frame:${reason}`).then(() => {
    if (force) emitSnapshotToRenderer({ force: true });
  });
};

const ensureLibraryEventStream = (): void => {
  if (libraryEventStream || !session) return;
  libraryEventStream = createRuntimeEventStream({
    session,
    runtimeBaseUrl: RUNTIME_BASE_URL,
    apps: ["badger"],
    channels: ["badger.library"],
  });
  const unsubscribe = libraryEventStream.subscribe(handleLibraryEvent);
  // The unsubscribe handle is intentionally unused here — `stop()` on the
  // stream tears down the underlying WS and frees listeners as a unit.
  void unsubscribe;
  void libraryEventStream.start().catch((err) => {
    logger.warn({
      event: "library_event_stream_start_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  });
};

const teardownLibraryEventStream = (): void => {
  if (!libraryEventStream) return;
  try {
    libraryEventStream.stop();
  } catch {
    // best-effort
  }
  libraryEventStream = null;
};

/**
 * Bring the cached snapshot up to the runtime's current library version and
 * emit it to the renderer. Resolves once the cache reflects every write that
 * completed before the call — the `sf-library-db-call` handler awaits it so a
 * write's IPC response still implies read-your-writes for the renderer.
 * Also used by emitLibrarySnapshotSafe() / callViaRuntime() for main-process
 * writes that bypass the IPC handler.
 *
 * #25: this used to fetch the full (~1 MB) snapshot unconditionally, and the
 * write's own `badger.library.updated` frame then fetched it again. Now it
 * asks for the version only (`badger.db.status`, a few bytes) and:
 *   - cache already at that version (the frame landed first) → nothing;
 *   - cache behind and the library stream is up → wait for the frame that
 *     delivers the change (applied as a delta merge), fetching only if it
 *     misses SNAPSHOT_FRAME_WAIT_MS;
 *   - version unknown / no stream → one coalesced fetch.
 *
 * `options.force` bypasses the 200ms emit throttle (setProgress from the mpv
 * exit path; the user navigates straight back to the title).
 */
export const refreshAndEmitProxySnapshot = async (options: { force?: boolean; reason?: string } = {}) => {
  const c = client;
  if (!c || !dbOpen) {
    logger.warn({ event: "refresh_snapshot_skipped", hasClient: !!c, dbOpen });
    return;
  }
  const reason = options.reason ?? "refresh";
  let targetVersion: number | undefined;
  try {
    const status = await c.sendCommand(badgerDbStatus, {});
    if (typeof status.version === "number") targetVersion = status.version;
  } catch (error) {
    logger.warn({
      event: "refresh_snapshot_status_failed",
      reason,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    typeof targetVersion === "number" &&
    typeof cachedSnapshotVersion === "number" &&
    cachedSnapshotVersion >= targetVersion
  ) {
    logger.info({ event: "refresh_snapshot_already_current", reason, version: targetVersion });
  } else if (typeof targetVersion === "number" && libraryEventStream) {
    const startedAt = Date.now();
    const delivered = await waitForSnapshotVersion(targetVersion);
    if (delivered) {
      logger.info({ event: "refresh_snapshot_frame_delivered", reason, version: targetVersion, waitedMs: Date.now() - startedAt });
    } else if (dbOpen) {
      logger.warn({
        event: "refresh_snapshot_frame_wait_timeout",
        reason,
        version: targetVersion,
        cachedSnapshotVersion: cachedSnapshotVersion ?? null,
        waitedMs: Date.now() - startedAt,
      });
      await fetchSnapshotCoalesced(reason);
    }
  } else {
    await fetchSnapshotCoalesced(reason);
  }
  if (options.force) emitSnapshotToRenderer({ force: true });
};

/** Keeps a valid choice (`parseActiveProfileArg`) and makes it main's playback profile; false when refused. */
const rememberActiveProfile = (arg: unknown): boolean => {
  const profile = parseActiveProfileArg(arg);
  if (profile === undefined) {
    logger.warn({ event: "active_profile_refused", arg: typeof arg === "object" ? arg : typeof arg });
    return false;
  }
  lastActiveProfile = profile;
  setActivePlaybackProfileId(lastActiveProfile?.id ?? null);
  return true;
};

/** A freshly opened library starts on the main profile: give it the chosen one before it serves a snapshot. */
const applyRememberedProfile = async (c: NonNullable<typeof client>, reason: string) => {
  if (!lastActiveProfile) return;
  await c.sendCommand(badgerDbCall, { method: "setActiveProfile", args: [lastActiveProfile] });
  logger.info({ event: "active_profile_applied", reason, profileId: lastActiveProfile.id, isMain: lastActiveProfile.isMain });
};

export const registerLibraryDbRuntimeProxy = (
  ipc: typeof ipcMain,
  windowProvider?: () => BrowserWindow | null
) => {
  getWindow = windowProvider ?? null;
  unsubscribeVisibility?.();
  unsubscribeVisibility = onAppWindowVisibilityChange((_win, next) => {
    if (next.hidden || heldWhileHidden === 0) return;
    logger.info({ event: "snapshot_emit_held_flush", held: heldWhileHidden, reason: next.reason, version: cachedSnapshotVersion ?? null });
    scheduleSnapshotEmit({ force: true });
  });

  ipc.handle("sf-library-db-open", async (_event, payload: OpenPayload) => {
    logger.info(
      { backendTokenPrefix: payload.token?.slice(0, 8), hasKey: Boolean(payload.keyBase64), hasUserId: Boolean(payload.userId) },
      "sf-library-db-open: start",
    );
    const c = ensureClient(payload.token);
    // #928: an open right after login can beat the runtime's first spawn.
    await waitForRuntimeRecovery("open", "before-send");
    await sendOpenCommand(c, "open", payload);
    await applyRememberedProfile(c, "open");
    dbOpen = true;
    lastOpen = { payload: openPayloadOf(payload), mode: "open" };
    // Capture the current library version at open time so the renderer's
    // play-button gate has a non-undefined baseline before the first SSE
    // frame arrives. Best-effort — falls back to undefined which the gate
    // treats as a back-compat fallthrough.
    try {
      const status = await c.sendCommand(badgerDbStatus, {});
      const v = (status as { version?: unknown })?.version;
      if (typeof v === "number") {
        lastEmittedVersion = v;
      }
    } catch (e) {
      logger.warn({ error: e instanceof Error ? e.message : String(e) }, "initial status fetch failed");
    }
    // Fetch initial snapshot for local cache. A (re-)open may land on a
    // different library or a lower version, so the next snapshot is
    // accepted unconditionally.
    invalidateCachedSnapshotVersion("open");
    await fetchSnapshotCoalesced("open");
    // Phase 6: subscribe to the runtime's library SSE channel so commit-step
    // writes (which bypass the desktop IPC path) reach the renderer within
    // ms instead of after the 8-10 s API-server fallback round-trip.
    ensureLibraryEventStream();
    return { handle: "default" as LibraryDbHandle };
  });

  ipc.handle("sf-library-db-open-local", async (_event, payload: OpenPayload) => {
    logger.info(
      { backendTokenPrefix: payload.token?.slice(0, 8), hasKey: Boolean(payload.keyBase64), hasUserId: Boolean(payload.userId) },
      "sf-library-db-open-local: start (offline, no remote pull)",
    );
    // Offline open: send the dedicated local-only command. Unlike `badgerDbOpen`
    // this opens the on-disk per-group SQLite + cache WITHOUT any backend round
    // trip, so it succeeds when the API/storage is unreachable. This is what
    // makes offline mode show downloaded titles instead of "Library unavailable".
    const c = ensureClient(payload.token);
    await waitForRuntimeRecovery("open-local", "before-send");
    await sendOpenCommand(c, "open-local", payload);
    await applyRememberedProfile(c, "open-local");
    dbOpen = true;
    lastOpen = { payload: openPayloadOf(payload), mode: "open-local" };
    // Hydrate the renderer-facing cache from the now-open local DB so the
    // offline library populates (otherwise the renderer holds a stale/empty
    // snapshot). Best-effort — the open itself already succeeded.
    try {
      const status = await c.sendCommand(badgerDbStatus, {});
      const v = (status as { version?: unknown })?.version;
      if (typeof v === "number") {
        lastEmittedVersion = v;
      }
    } catch (e) {
      logger.warn({ error: e instanceof Error ? e.message : String(e) }, "open-local: status fetch failed");
    }
    invalidateCachedSnapshotVersion("open-local");
    await fetchSnapshotCoalesced("open-local");
    return { handle: "default" as LibraryDbHandle };
  });

  // ACCT-SQUAD-02 / UX-PROF-01: the renderer's profile choice. It may arrive before the library opens (the picker
  // answers first); it is kept and given to every library this process opens until sign-out.
  ipc.handle("sf-library-db-set-active-profile", async (_event, profile: unknown) => {
    if (!rememberActiveProfile(profile)) return { applied: false };
    if (!dbOpen || !client) {
      logger.info({ event: "active_profile_deferred", profileId: lastActiveProfile?.id ?? null });
      return { applied: false };
    }
    const target = lastActiveProfile;
    await sendSurvivingRestart("setActiveProfile", () =>
      client!.sendCommand(badgerDbCall, { method: "setActiveProfile", args: [target] }),
    );
    logger.info({ event: "active_profile_applied", reason: "switch", profileId: target?.id ?? null });
    await refreshAndEmitProxySnapshot({ reason: "setActiveProfile", force: true });
    return { applied: true };
  });

  ipc.handle("sf-library-db-get-local-cache-bytes", async () => {
    // Not available via runtime proxy — return empty
    return new Uint8Array(0);
  });

  ipc.handle("sf-library-db-has-local-cache", async () => {
    return cachedSnapshot !== null;
  });

  ipc.handle("sf-library-db-clear-local-cache", async () => {
    // Sign-out removes the library files of the account that was open (LIB-STORE-06).
    const signedOutUserId = lastOpen?.payload.userId;
    cachedSnapshot = null;
    lastEmittedVersion = undefined;
    invalidateCachedSnapshotVersion("clear-local-cache");
    teardownLibraryEventStream();
    if (client) {
      try { await client.sendCommand(badgerDbClearLocalCache, signedOutUserId ? { userId: signedOutUserId } : {}); } catch { /* expected */ }
    }
    dbOpen = false;
    lastOpen = null;
    lastActiveProfile = null;
    setActivePlaybackProfileId(null);
    reopenGeneration += 1;
    releaseRestartGate("logout");
  });

  ipc.handle("sf-library-db-call", async (_event, payload: CallPayload) => {
    if (!dbOpen || !client) {
      return { __sfIpcError: "LIBRARY_DB_NOT_READY" };
    }

    // Ignore close via the call path. OnboardingKey.tsx opens a temporary DB instance
    // to test the key and immediately closes it — but the proxy has a single global
    // DB handle managed by sf-library-db-open / sf-library-db-clear-local-cache.
    // Propagating close here would leave the proxy in a broken state where dbOpen=false
    // but the library context expects the DB to be open.
    if (payload.method === "close") {
      return;
    }

    // Read methods can be served from local snapshot cache
    if (payload.method === "getSnapshot" && cachedSnapshot) {
      return cachedSnapshot;
    }
    // getMediaDetails is NOT served from cache — the finalization flow calls
    // getMediaDetails after writes (linkFileToMedia, addMediaFormat) and needs
    // fresh data that reflects those writes. The cache is only refreshed after
    // the full sf-library-db-call handler completes, which is too late for
    // sequential reads within the same finalization run.
    if (payload.method === "listMedia" && cachedSnapshot) {
      return cachedSnapshot.media ?? [];
    }
    if (payload.method === "listPlaylists" && cachedSnapshot) {
      return cachedSnapshot.playlists ?? [];
    }
    if (payload.method === "hasAnyMedia" && cachedSnapshot) {
      return Array.isArray(cachedSnapshot.media) && cachedSnapshot.media.length > 0;
    }
    if (payload.method === "getVersion" && cachedSnapshot) {
      return (cachedSnapshot as { version?: number }).version ?? 0;
    }
    if (payload.method === "getDatasetStatus") {
      const status = await sendSurvivingRestart("getDatasetStatus", () => client!.sendCommand(badgerDbStatus, {}));
      return (status as { datasetStatus?: unknown })?.datasetStatus ?? { core: false, metadata: false, playback: false };
    }

    // All other methods (writes + uncommon reads) go through the runtime.
    // #25 P2: waits out a runtime restart and retries once when safe.
    //
    // #25 playback overhead: a progress save while the window is hidden behind
    // external mpv has no reader (the renderer holds progress-only snapshots
    // until show), yet every save cost the runtime a whole-library
    // `getSnapshot` + ~1 MB frame, this process a ~1 MB parse and a
    // `badger.db.status` round trip. Such a save asks the runtime to coalesce
    // its frame and skips the read-your-writes refresh; the next immediate
    // publish (a visible save, the mpv-exit save, any other write) carries it.
    const window = getWindow?.() ?? null;
    const deferPublish = payload.method === "setProgress" && window !== null && !window.isDestroyed() && isAppWindowMarkedHidden(window);
    const result = await sendSurvivingRestart(payload.method, () =>
      client!.sendCommand(badgerDbCall, {
        method: payload.method,
        args: payload.args ?? [],
        ...(deferPublish ? { deferPublish: true } : {}),
      }),
    );

    if (deferPublish) {
      logger.debug({ event: "progress_publish_deferred", method: payload.method });
      return result;
    }

    // #25: bring the cache up to this call's version before answering, so
    // the response still implies read-your-writes. Usually the write's own
    // `badger.library.updated` frame has already delivered the change (delta
    // fetch + merge, #671) and
    // this costs one `badger.db.status`; reads cost the same and fetch
    // nothing. Never throws — a failure leaves the cache stale until the
    // next frame.
    await refreshAndEmitProxySnapshot({ reason: payload.method });

    return result;
  });

  logger.info("library DB runtime proxy registered");
};

export const resetLibraryDbRuntimeProxyForTests = async () => {
  if (client) {
    try { await client.sendCommand(badgerDbClose, {}); } catch { /* expected */ }
  }
  if (pendingEmitTimer) {
    clearTimeout(pendingEmitTimer);
    pendingEmitTimer = null;
  }
  teardownLibraryEventStream();
  session = null;
  client = null;
  dbOpen = false;
  cachedSnapshot = null;
  lastEmittedVersion = undefined;
  invalidateCachedSnapshotVersion("test-reset");
  snapshotFetchInFlight = null;
  pendingFullReason = null;
  pendingDeltaIds.clear();
  pendingDeltaTip = undefined;
  pendingDeltaSource = null;
  deltaChainTip = undefined;
  snapshotFetchCount = 0;
  lastOpen = null;
  lastActiveProfile = null;
  setActivePlaybackProfileId(null);
  reopenGeneration += 1;
  runtimeLost = false;
  releaseRestartGate("test-reset");
  getWindow = null;
  unsubscribeVisibility?.();
  unsubscribeVisibility = null;
  heldWhileHidden = 0;
  lastEmittedJson = null;
  lastEmittedVersionForDedup = undefined;
  lastEmitAt = 0;
  trackedWindow = null;
};

/**
 * Round-12 #4: re-fire `badger.db.open` after RuntimeGuardian respawns the
 * runtime mid-session. Called from `runtimeGuardian.on("ready", ...)`. Idempotent
 * and safe to call repeatedly. Returns `{ reopened: false, reason: "no_cached_payload" }`
 * when no user has logged in yet OR after logout — the cache is the source of truth.
 */
export const reopenAfterRuntimeRespawn = async (): Promise<{ reopened: boolean; reason?: string }> => {
  if (!lastOpen) {
    releaseRestartGate("no-cached-payload");
    return { reopened: false, reason: "no_cached_payload" };
  }
  const { payload, mode } = lastOpen;
  const c = ensureClient(payload.token);
  logger.info({ mode, backendTokenPrefix: payload.token?.slice(0, 8) }, "reopen after runtime respawn: re-firing library open");
  await c.sendCommand(mode === "open-local" ? badgerDbOpenLocal : badgerDbOpen, openPayloadOf(payload));
  dbOpen = true;
  // Before the gate releases: no call may read or write another profile's viewing state on the new runtime.
  await applyRememberedProfile(c, "reopen-after-respawn");
  // The respawned runtime's frames (and their versions) are a fresh series:
  // accept the next snapshot unconditionally.
  invalidateCachedSnapshotVersion("reopen-after-respawn");
  // Re-attach the library SSE subscription against the freshly-respawned
  // runtime. The previous stream's WS is dead — tear it down before the
  // new one opens to avoid a leaked listener.
  teardownLibraryEventStream();
  ensureLibraryEventStream();
  runtimeLost = false;
  releaseRestartGate("reopened");
  return { reopened: true };
};

/** Backoff schedule (ms) for `reopenAfterRuntimeReady`: the runtime's `/runtime/health` can
 *  answer before its modules accept `badger.db.open`, and a first attempt can race a
 *  second respawn, so one failed re-open must not strand the library for the session. */
export const REOPEN_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * F5 (ultimate stress, issue #25): called on every guardian "ready". Re-fires the
 * library open (see `reopenAfterRuntimeRespawn`) and, if that fails, retries on
 * `REOPEN_RETRY_DELAYS_MS` with a log line per attempt instead of giving up after
 * one warning. A newer call (next respawn) or logout supersedes a running loop.
 */
export const reopenAfterRuntimeReady = async (): Promise<{ reopened: boolean; reason?: string }> => {
  const generation = ++reopenGeneration;
  const maxAttempts = REOPEN_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (generation !== reopenGeneration) {
      logger.info({ attempt, generation }, "reopen after runtime ready: superseded");
      return { reopened: false, reason: "superseded" };
    }
    try {
      const result = await reopenAfterRuntimeRespawn();
      logger.info({ attempt, maxAttempts, ...result }, "reopen after runtime ready: done");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delayMs = REOPEN_RETRY_DELAYS_MS[attempt - 1];
      logger.warn({ attempt, maxAttempts, error: message, retryInMs: delayMs ?? null }, "reopen after runtime ready: attempt failed");
      if (delayMs === undefined) break;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  logger.error({ maxAttempts }, "reopen after runtime ready: retries exhausted");
  releaseRestartGate("reopen-retries-exhausted");
  return { reopened: false, reason: "retries_exhausted" };
};
