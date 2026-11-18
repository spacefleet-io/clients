/**
 * Renderer-level shared store for runtime ingest jobs.
 *
 * Plan reference: video-ingestion-is-buggy-effervescent-teapot.md (round 6,
 * Part A). Replaces the per-hook-instance bootstrap + WS subscription that
 * `useRuntimeIngestJobs` used to own. One stream connection per renderer,
 * one `byId` map, all consumers fan out via `useSyncExternalStore`.
 *
 * Public API: `subscribe(listener)`, `getSnapshot()`, `acquire()`,
 * `release()`, `forceRefreshSnapshot()`, `__resetForTests()`.
 *
 * Refcounted lifecycle:
 *   0 → 1: HTTP snapshot fetch via `window.sf.runtimeJobs.list()` →
 *          open EventSource via `createRuntimeJobsV2Stream(...)` →
 *          live deltas update `byId`.
 *   1 → 0: `stream.stop()` + clear state + drop listeners.
 *
 * Reconcile mechanisms:
 *   - `visibilitychange` hidden→visible → `forceRefreshSnapshot()` (catches
 *     OS-suspended-stream cases).
 *   - 30s heartbeat — if connection is "open" AND no events in >60s AND at
 *     least one **running** job exists, fetch fresh snapshot. The "running"
 *     predicate is intentional vs. "non-terminal": a queued job waiting on
 *     a parent emits no events by design, so a non-terminal predicate would
 *     fire every 30s during a long source ingest with queued format children.
 *   - 5s engine-down health probe while in error state — bumps an internal
 *     epoch which re-bootstraps via `acquire()`'s normal path.
 */

import {
  createRuntimeJobsV2Stream,
  type RuntimeJobsV2ConnectionState,
  type RuntimeJobsV2Stream,
} from "@space/runtime-client/jobsV2";
import { isAppWindowHidden, subscribeAppWindowVisibility } from "./appWindowVisibility";
import { applyIngestJobEvent, type IngestJobRecord, type RuntimeIngestError } from "./runtimeIngestJobs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StoreSnapshot = {
  byId: Map<string, IngestJobRecord>;
  loading: boolean;
  error: Error | null;
  runtimeError: RuntimeIngestError | null;
  /**
   * Bumped on every mutation. `useSyncExternalStore` uses snapshot identity
   * to decide whether to re-render; we return the same `state` object only
   * when nothing has changed, otherwise we shallow-clone with a fresh
   * `version`.
   */
  version: number;
};

// ---------------------------------------------------------------------------
// Constants — exported for tests so timing is configurable without imports
// drifting.
// ---------------------------------------------------------------------------

export const HEALTH_PROBE_INTERVAL_MS = 5000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const STALE_EVENT_THRESHOLD_MS = 60_000;

const RUNTIME_UNAVAILABLE_FALLBACK_MESSAGE =
  "Ingest unavailable — runtime engine v2 not ready. Restart the desktop, or run 'bun run dev:core:full' to bring up a fresh stack.";

const isRuntimeJobsErrorEnvelope = (
  v: unknown,
): v is { __runtimeJobsError: true; status: number; errorCode: string | null; message: string | null } =>
  !!v &&
  typeof v === "object" &&
  (v as { __runtimeJobsError?: unknown }).__runtimeJobsError === true;

const toRuntimeIngestError = (err: unknown): RuntimeIngestError => {
  if (isRuntimeJobsErrorEnvelope(err)) {
    return {
      errorCode: err.errorCode ?? "runtime_jobs_unreachable",
      message: err.message ?? RUNTIME_UNAVAILABLE_FALLBACK_MESSAGE,
      status: err.status,
    };
  }
  if (err instanceof Error) {
    const match = /^runtime_jobs_http_(\d+):\s*([a-z0-9_]+)/i.exec(err.message);
    if (match) {
      return {
        errorCode: match[2]!,
        message: err.message,
        status: Number(match[1]!),
      };
    }
    return {
      errorCode: err.message,
      message: err.message,
      status: 0,
    };
  }
  return {
    errorCode: "runtime_jobs_unreachable",
    message: String(err),
    status: 0,
  };
};

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

type Listener = () => void;

let state: StoreSnapshot = {
  byId: new Map(),
  loading: false,
  error: null,
  runtimeError: null,
  version: 0,
};

const listeners = new Set<Listener>();
let refcount = 0;
let stream: RuntimeJobsV2Stream | null = null;
let lastEventAt = 0;
let heartbeatId: ReturnType<typeof setInterval> | null = null;
let healthProbeId: ReturnType<typeof setInterval> | null = null;
let visibilityHandlerAttached = false;
let bootstrapToken = 0; // Cancellation token for the in-flight bootstrap.

// @bugfix @regression-proof issue #25 P19: while main reports the app window
// hidden (external mpv playing), `runtime.jobs.progress` events still update
// `state` but do not notify listeners — every listener is a React
// `useSyncExternalStore` render of a window nobody can see (~6 % of the
// hidden renderer's long-frame time). The next non-progress event, or the
// window showing again, notifies once with the coalesced state (the flip is
// logged by appWindowVisibility).
let deferredNotify = false;
let unsubscribeAppWindowVisibility: (() => void) | null = null;

const notifyListeners = () => {
  deferredNotify = false;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // swallow consumer errors — one bad listener should not poison the rest
    }
  }
};

const setState = (patch: Partial<StoreSnapshot>, options?: { deferWhileHidden?: boolean }) => {
  state = {
    ...state,
    ...patch,
    version: state.version + 1,
  };
  if (options?.deferWhileHidden && isAppWindowHidden()) {
    deferredNotify = true;
    return;
  }
  notifyListeners();
};

const handleAppWindowVisibility = (change: { hidden: boolean }) => {
  if (!change.hidden && deferredNotify) notifyListeners();
};

const handleVisibilityChange = () => {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible" && refcount > 0) {
    void forceRefreshSnapshot();
  }
};

const attachVisibilityHandler = () => {
  if (visibilityHandlerAttached) return;
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  visibilityHandlerAttached = true;
};

const detachVisibilityHandler = () => {
  if (!visibilityHandlerAttached) return;
  if (typeof document === "undefined") return;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  visibilityHandlerAttached = false;
};

const startHeartbeat = () => {
  if (heartbeatId !== null) return;
  if (typeof setInterval === "undefined") return;
  heartbeatId = setInterval(() => {
    if (refcount === 0) return;
    if (state.error || state.runtimeError) return;
    const now = Date.now();
    if (now - lastEventAt <= STALE_EVENT_THRESHOLD_MS) return;
    // The "running" predicate (vs. "non-terminal") is intentional. Queued
    // jobs waiting on a parent emit no events by design — a non-terminal
    // predicate would cause false-positive reconciles every 30s during a
    // long source ingest with queued format children.
    let hasRunning = false;
    for (const job of state.byId.values()) {
      if (job.status === "running") {
        hasRunning = true;
        break;
      }
    }
    if (!hasRunning) return;
    void forceRefreshSnapshot();
  }, HEARTBEAT_INTERVAL_MS);
};

const stopHeartbeat = () => {
  if (heartbeatId === null) return;
  clearInterval(heartbeatId);
  heartbeatId = null;
};

const startHealthProbe = () => {
  if (healthProbeId !== null) return;
  if (typeof setInterval === "undefined") return;
  healthProbeId = setInterval(() => {
    if (refcount === 0) return;
    if (!state.runtimeError && !state.error) return;
    void probeRuntimeHealth();
  }, HEALTH_PROBE_INTERVAL_MS);
};

const stopHealthProbe = () => {
  if (healthProbeId === null) return;
  clearInterval(healthProbeId);
  healthProbeId = null;
};

const probeRuntimeHealth = async () => {
  const api = (globalThis as { window?: Window }).window?.sf?.runtimeJobs;
  if (!api?.list) return;
  try {
    const snap = await api.list({});
    if (isRuntimeJobsErrorEnvelope(snap)) return;
    // Healthy again — re-bootstrap. teardownStream first so we don't leak the
    // dead EventSource.
    teardownStream();
    void bootstrap();
  } catch {
    // Stay in error state until next probe.
  }
};

// ---------------------------------------------------------------------------
// Offline-mode cross-store nudge
// ---------------------------------------------------------------------------

/**
 * Offline-mode (Phase 2): when a `download`-kind job finishes, the runtime has
 * just written a `media_local_downloads` row server-side. The renderer's
 * offline-state store (`offlineState.ts`) hydrates exactly once per app session
 * (a module-level `bootstrapped` flag in `acquireOfflineState`), which runs at
 * app startup — BEFORE the download existed — and has no other completion
 * signal: the submit-time refresh fires before the row is written, and the
 * modal-open reconcile only refreshes when a file was *dropped*. Without this
 * nudge the "saved offline" badge + per-episode button state never light up
 * until the next app restart.
 *
 * This store is the single seam every runtime job event flows through, so it's
 * the right place to re-hydrate the offline store on download completion.
 * Targeted by `mediaId` when present (cheap merge); full refresh otherwise.
 *
 * `offlineState` is loaded via a DYNAMIC import on purpose: this store lives in
 * the eager AuthenticatedApp shell chunk (the always-mounted jobs UI imports
 * it), whereas `offlineState` + its dependency graph (offlineEstimator quality
 * tables, offlineIpc) otherwise live in lazy route chunks. A static import here
 * would hoist all of that into the eager bundle (~13 KiB over the renderer
 * budget). The download-complete event is rare, so deferring the import to the
 * moment it fires keeps the initial load lean with no user-visible delay.
 *
 * @bugfix offline-download-completion-no-badge
 */
const maybeRefreshOfflineOnDownloadComplete = (
  event: import("@space/runtime-contracts/runtime/jobs").RuntimeJobsEvent,
): void => {
  if (event.event !== "runtime.jobs.succeeded") return;
  const job = event.job as unknown as IngestJobRecord | undefined;
  if (!job || job.kind !== "download") return;
  // Loud-by-design diagnostic — offline completion bugs are otherwise invisible
  // from logs (add logs when missing context).
  // eslint-disable-next-line no-console
  console.info(
    "[offline-refresh] download job succeeded → re-hydrating offline state",
    { jobId: job.jobId, mediaId: job.mediaId ?? null },
  );
  void import("./offlineState").then((offline) => {
    if (job.mediaId) {
      offline.refreshOfflineStateForMedia(job.mediaId);
    } else {
      offline.refreshOfflineState();
    }
  });
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const teardownStream = () => {
  if (stream) {
    try {
      stream.stop();
    } catch {
      // best-effort
    }
    stream = null;
  }
};

const bootstrap = async () => {
  const myToken = ++bootstrapToken;
  setState({ loading: true });

  const api = (globalThis as { window?: Window }).window?.sf?.runtimeJobs;
  if (!api?.list || !api?.getStreamUrl) {
    if (myToken !== bootstrapToken) return;
    setState({
      loading: false,
      error: new Error("runtime_jobs_ipc_unavailable"),
      runtimeError: {
        errorCode: "runtime_jobs_ipc_unavailable",
        message: RUNTIME_UNAVAILABLE_FALLBACK_MESSAGE,
        status: 0,
      },
    });
    return;
  }

  const fail = (raw: unknown) => {
    if (myToken !== bootstrapToken) return;
    const re = toRuntimeIngestError(raw);
    setState({
      loading: false,
      error: raw instanceof Error ? raw : new Error(re.message),
      runtimeError: re,
    });
  };

  // Capture into a non-nullable binding so the SSE `onReauthNeeded` closure
  // below can call it without re-checking `api?.getStreamUrl` (the bootstrap
  // guard above already validated it). The IPC bridge mints a fresh URL via
  // the session client's now-expiry-aware `getToken()` each time it's
  // called, so this is the single seam the reauth path uses to obtain a
  // freshly-tokened URL.
  const getStreamUrl = api.getStreamUrl;

  try {
    const snap = await api.list({});
    if (myToken !== bootstrapToken) return;
    if (isRuntimeJobsErrorEnvelope(snap)) {
      fail(snap);
      return;
    }
    const seed = new Map<string, IngestJobRecord>();
    for (const job of (snap?.jobs ?? []) as IngestJobRecord[]) {
      seed.set(job.jobId, job);
    }
    setState({
      byId: seed,
      loading: false,
      error: null,
      runtimeError: null,
    });

    const handle = await getStreamUrl();
    if (myToken !== bootstrapToken) return;

    const initialLastEventId =
      typeof snap?.maxEventId === "number" ? snap.maxEventId : 0;
    lastEventAt = Date.now();

    stream = createRuntimeJobsV2Stream({
      url: handle.url,
      snapshotUrl: `${handle.httpBaseUrl}/runtime/jobs/v2/list`,
      token: handle.token,
      initialLastEventId,
      onEvent: (event) => {
        lastEventAt = Date.now();
        setState(
          { byId: applyIngestJobEvent(state.byId, event) },
          { deferWhileHidden: event.event === "runtime.jobs.progress" },
        );
        maybeRefreshOfflineOnDownloadComplete(event);
      },
      onConnectionStateChange: (connState: RuntimeJobsV2ConnectionState) => {
        if (connState === "closed") {
          setState({
            error: new Error("runtime_jobs_ws_closed"),
            runtimeError: {
              errorCode: "runtime_jobs_ws_closed",
              message: RUNTIME_UNAVAILABLE_FALLBACK_MESSAGE,
              status: 0,
            },
          });
        } else if (connState === "open") {
          setState({ error: null, runtimeError: null });
        }
      },
      onError: (err) => {
        setState({ error: err, runtimeError: toRuntimeIngestError(err) });
      },
      // Pre-handshake 401 recovery — the SSE URL bakes the session token in
      // a query param, so a stale token can't be patched by reconnecting to
      // the same URL. The IPC handler `sf-runtime-jobs-stream-url` calls
      // session.getToken(), which (after the runtime-client expiry-aware
      // refactor) automatically re-logs in if within 30s of the runtime's
      // TTL window — so a fresh URL carries a freshly-minted token. Limit
      // is single-shot per stream.start() per the jobsV2 contract; if the
      // new token also 401s we fall through to the normal error path and
      // the 5s health probe (now meaningful, since /v2/list is auth-gated)
      // picks up the recovery from there.
      onReauthNeeded: async () => {
        const freshHandle = await getStreamUrl();
        return freshHandle.url;
      },
    });
    await stream.start();
  } catch (err) {
    fail(err);
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getSnapshot = (): StoreSnapshot => state;

export const acquire = (): void => {
  refcount += 1;
  if (refcount !== 1) return;
  // 0 → 1 transition: full bootstrap.
  attachVisibilityHandler();
  unsubscribeAppWindowVisibility = subscribeAppWindowVisibility(handleAppWindowVisibility);
  startHeartbeat();
  startHealthProbe();
  void bootstrap();
};

export const release = (): void => {
  if (refcount === 0) return;
  refcount -= 1;
  if (refcount !== 0) return;
  // 1 → 0 transition: tear everything down.
  bootstrapToken += 1; // Invalidate any in-flight bootstrap.
  teardownStream();
  detachVisibilityHandler();
  unsubscribeAppWindowVisibility?.();
  unsubscribeAppWindowVisibility = null;
  stopHeartbeat();
  stopHealthProbe();
  state = {
    byId: new Map(),
    loading: false,
    error: null,
    runtimeError: null,
    version: state.version + 1,
  };
  notifyListeners();
};

/**
 * Fetch a fresh `/v2/list` snapshot and merge it into `byId`. The snapshot is
 * authoritative — overwrite by `jobId`. New jobs added; existing entries
 * replaced; removed-from-snapshot rows are NOT pruned (a job present in
 * `byId` from a recent live event but missing from the just-fetched snapshot
 * could be a race; pruning would drop it before the next event arrives).
 *
 * Used by visibility/heartbeat reconcile and exposed for callers that want
 * to refresh manually.
 */
export const forceRefreshSnapshot = async (): Promise<void> => {
  const api = (globalThis as { window?: Window }).window?.sf?.runtimeJobs;
  if (!api?.list) return;
  try {
    const snap = await api.list({});
    if (isRuntimeJobsErrorEnvelope(snap)) return;
    const next = new Map(state.byId);
    for (const job of (snap?.jobs ?? []) as IngestJobRecord[]) {
      next.set(job.jobId, job);
    }
    setState({ byId: next, error: null, runtimeError: null });
    lastEventAt = Date.now();
  } catch {
    // Silent — heartbeat will retry; a hard error path goes through the
    // stream's onConnectionStateChange/onError instead.
  }
};

/**
 * Test seam — fully resets module state so each test gets a clean slate.
 * Call from `beforeEach`.
 */
export const __resetRuntimeJobsStoreForTests = (): void => {
  bootstrapToken += 1;
  teardownStream();
  detachVisibilityHandler();
  unsubscribeAppWindowVisibility?.();
  unsubscribeAppWindowVisibility = null;
  deferredNotify = false;
  stopHeartbeat();
  stopHealthProbe();
  listeners.clear();
  refcount = 0;
  lastEventAt = 0;
  state = {
    byId: new Map(),
    loading: false,
    error: null,
    runtimeError: null,
    version: 0,
  };
};
