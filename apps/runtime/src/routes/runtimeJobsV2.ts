/**
 * `runtime.jobs.v2` channel handler — server side.
 *
 * Plan reference: video-ingestion-is-buggy-effervescent-teapot.md §5.
 *
 * The legacy `runtime.jobs` channel publishes a 2-second-throttled
 * `runtime.jobs.updated` snapshot frame. This v2 channel publishes per-job
 * lifecycle deltas (the 7-event vocabulary from spec §4.4) plus a
 * `lastEventId` replay handshake plus a one-shot bootstrap snapshot.
 *
 * Architecture:
 *   - `createRuntimeJobsV2Handler(deps)` returns:
 *       - `handleSseSubscribe(envelope)` attach a single SSE client
 *       - `handleSnapshot(filter?)` produce the bootstrap snapshot for the
 *         HTTP fallback (`runtime.jobs.list` over HTTP)
 *
 * Round-13 #4 (a): the legacy WebSocket transport (and its
 * `handleSubscribe`/`WsClientHandle`/`ServerWebSocketLike` surfaces) was
 * deleted in favour of SSE-only after the round-6 migration shipped.
 *
 * Connection lifecycle (SSE):
 *   1. Client opens an `EventSource` against
 *      `/runtime/events/jobs/v2/stream` with optional `Last-Event-ID` header
 *      (or `?lastEventId=N` query-string fallback for the first connect).
 *   2. Server emits a single `event: handshake` frame as the first SSE
 *      payload, replays past events with their `eventId` in the SSE `id:`
 *      field, then attaches a live engine subscription.
 *   3. On replay overflow: server emits `event: replay_overflow`, ends the
 *      stream; client falls back to a snapshot fetch + reconnect.
 *
 * Engine seam:
 *   - `engine` is the {@link EngineV2} instance — its `subscribe(listener)`
 *     delivers FUTURE events only.
 *   - `eventLog` is a separate dep because engineV2 does not expose its event
 *     log publicly. Both are owned by whoever wires Phase D.
 */

import type { Hono } from "hono";
import type { AppId } from "../types";
import type { EngineV2, RuntimeJobEvent } from "@space/runtime-jobs-engine/engineV2";
import type { EventLog } from "@space/runtime-jobs-engine/eventLog";
import type { ListFilter } from "@space/runtime-jobs-engine/engineV2";
import type { BadgerFailedJobs } from "../modules/badger/failedJobs";
import {
  runtimeJobsEventSchema,
  runtimeJobsSubscribeHandshakeResponseSchema,
  runtimeJobsCancelByGroupPayloadSchema,
  runtimeJobsListPayloadSchema,
  runtimeJobsCancelPayloadSchema,
  runtimeJobsAvailabilityPayloadSchema,
  runtimeJobsDismissPayloadSchema,
  runtimeJobsRetryPayloadSchema,
  type RuntimeJobsAvailabilityResult,
  type RuntimeJobsRetryPayload,
  type RuntimeJobsRetryResult,
  type RuntimeJobsSubscribeHandshakeResponse,
} from "@space/runtime-contracts/runtime/jobs";
import type { EventRow } from "@space/runtime-jobs-engine/eventLog";
import {
  isTerminalIngestJobStatus,
  type IngestJobRecord,
} from "@space/runtime-jobs";
import { resolveEngineV2UnavailableError } from "../core/jobs/engineV2BootStatus";
import { requireToken } from "../auth";
import { runtimeState } from "../runtime";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Envelope passed by the HTTP route to `handleSseSubscribe`. The route owns
 * the request/response objects; this seam keeps the handler framework-free.
 *
 * - `lastEventId`: extracted by the route from `Last-Event-ID` header (or
 *   `?lastEventId=N` query param fallback). `0` = no replay requested.
 * - `write(frame)`: writes a complete SSE frame (already terminated with
 *   `\n\n`) to the response body stream.
 * - `close()`: ends the response stream. Idempotent at the route level.
 */
export interface SseSubscribeEnvelope {
  lastEventId: number;
  /**
   * Apps the authenticated session may see (RT-SEC-03). A frame is written
   * only when its job belongs to one of these apps.
   */
  scopes: readonly string[];
  write(frame: string): void;
  close(): void;
}

/**
 * Returned by `handleSseSubscribe` — the route uses this to clean up the
 * live engine subscription when the response stream closes (client
 * disconnects or the keep-alive interval fires after the response was torn
 * down).
 */
export interface SseClientHandle {
  /** Tear down the live `engine.subscribe` and stop forwarding events. */
  unsubscribe(): void;
}

export interface SnapshotResponse {
  jobs: IngestJobRecord[];
  maxEventId: number;
}

export interface RuntimeJobsV2HandlerDeps {
  /** EngineV2 instance — required when the handler is enabled. */
  engine: EngineV2;
  /**
   * Event log seam used for replay. EngineV2 keeps its event log private and
   * its `subscribe()` only delivers future events; the route reads past
   * events from this seam. Phase D wires both `engine` and `eventLog`
   * pointing at the same SQLite-backed store.
   */
  eventLog: EventLog;
  /** Cap for replay queries; defaults to the `EventLog`'s built-in default. */
  eventReplayLimit?: number;
  /**
   * Round-13 #4 (c): override the SSE refcount→0 grace window before the
   * shared engineV2 subscription is torn down. Defaults to
   * `SSE_REFCOUNT_TEARDOWN_GRACE_MS_DEFAULT` (30 000ms). Tests inject a
   * shorter value (or `0` to disable the grace) so they can assert the
   * teardown side-effect without real-clock waits.
   */
  sseTeardownGraceMs?: number;
  /**
   * Failed Badger imports' actions (UX-JOBS-03). Absent (tests, other apps):
   * availability answers nothing and retry re-runs every unfinished step.
   */
  failedJobs?: BadgerFailedJobs;
  /** Optional logger; mirrors the legacy route's console-based logging. */
  logger?: {
    warn?(message: string, data?: Record<string, unknown>): void;
    info?(message: string, data?: Record<string, unknown>): void;
  };
}

export interface RuntimeJobsV2Handler {
  /**
   * Attach an SSE client. Emits the handshake as the first
   * `event: handshake` SSE frame, replays past events with their `eventId`
   * as the SSE `id:` field, then attaches a live engine subscription.
   *
   * On replay overflow: emits `event: replay_overflow`, calls `close()`, and
   * returns a no-op handle (no live subscription).
   */
  handleSseSubscribe(envelope: SseSubscribeEnvelope): SseClientHandle;
  /**
   * Bootstrap snapshot, restricted to jobs of the apps in `scopes` (RT-SEC-03).
   */
  handleSnapshot(
    filter: ListFilter | undefined,
    scopes: readonly string[]
  ): Promise<SnapshotResponse>;
  /** App that owns `jobId`, or `null` when no such job exists. */
  getJobApp(jobId: string): Promise<string | null>;
  /** Distinct apps of the jobs in `groupId` (empty when none exist). */
  getGroupApps(groupId: string): Promise<string[]>;
  /**
   * Cancel + dismiss every job matching `groupId`. Non-terminal rows are
   * cancelled (engine cascades to their children), terminal rows are
   * dismissed so they no longer block dedupe or appear in default lists.
   * Idempotent. (effervescent-teapot Round 3 — "delete + re-add same file".)
   */
  handleCancelByGroup(input: {
    groupId: string;
    reason?: string;
  }): Promise<{ cancelled: number; dismissed: number }>;
  /**
   * Per-job cancel — does NOT dismiss. Cascades to children via
   * `engine.cancel`. Returns `cancelled: true` when at least one row was
   * transitioned (the requested job or any of its descendants), `false` when
   * the job was already terminal or unknown.
   */
  handleCancel(input: {
    jobId: string;
    reason?: string;
  }): Promise<{ cancelled: boolean }>;
  /**
   * Per-job dismiss — terminal-only. Marks a finished/failed/cancelled job as
   * dismissed so it falls out of the default UI list. `errorCode` is set to
   * `"not-terminal"` when the job is still live.
   */
  handleDismiss(input: {
    jobId: string;
  }): Promise<
    | { dismissed: true }
    | { dismissed: false; errorCode: "not-terminal" | "not-found" }
  >;
  /** Re-queue a failed job in place (same jobId); refusals name the action that fits now. */
  handleRetry(input: RuntimeJobsRetryPayload): Promise<RuntimeJobsRetryResult>;
  /** The one action each failed job offers, and the kept processed copies' size. */
  handleAvailability(input: { jobIds: string[] }): Promise<RuntimeJobsAvailabilityResult>;
}

// ---------------------------------------------------------------------------
// Wire frame helpers
// ---------------------------------------------------------------------------

const stringify = (payload: unknown): string => JSON.stringify(payload);

/**
 * Round-13 #4 (c): grace window before tearing down the shared engineV2
 * subscription after the last SSE client disconnects. A reconnect inside
 * this window (HMR flicker, navigation, brief network blip) re-attaches
 * to the existing subscription instead of redoing the engine.subscribe
 * dance from scratch. Tests can override via the helper factory option
 * `sseTeardownGraceMs` so tick advances stay deterministic.
 */
const SSE_REFCOUNT_TEARDOWN_GRACE_MS_DEFAULT = 30_000;

/**
 * Reconstruct the flat wire shape the SSE transport emits per event.
 *
 * The engineV2 emit boundary stores per-event canonical fields under
 * `payload` (see `engineV2.ts::emit`), so the wire frame is reconstructed
 * by spreading the payload at top level alongside the envelope fields. The
 * resulting shape is what the strict client's `runtimeJobsEventSchema`
 * expects: `{ eventId, emittedAt, event, ...per-event-fields }` — flat,
 * no nested `payload` key.
 */
const buildEventFrame = (
  source:
    | RuntimeJobEvent
    | { eventId: number; createdAt: string; event: string; payload: Record<string, unknown> }
): Record<string, unknown> => ({
  eventId: source.eventId,
  emittedAt: source.createdAt,
  event: source.event,
  ...source.payload,
});

/**
 * Replay-row flavour of `buildEventFrame`. Rows arrive as `EventRow` (with
 * `payloadJson` to parse) — convert to the flat shape and wrap in `id:` /
 * `event:` / `data:` lines, terminated with the required blank line.
 */
const buildEventFrameFromRow = (
  row: EventRow
): Record<string, unknown> => {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    eventId: row.eventId,
    emittedAt: row.createdAt,
    event: row.event,
    ...payload,
  };
};

/**
 * Format a flat event record as a complete SSE frame (already terminated
 * with `\n\n`). The `id` field is set to the eventId so an EventSource
 * client's `lastEventId` advances automatically on each frame.
 */
const formatSseEventFrame = (frame: Record<string, unknown>): string => {
  const eventId = frame.eventId;
  const eventName = frame.event;
  return `id: ${eventId}\nevent: ${eventName}\ndata: ${stringify(frame)}\n\n`;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRuntimeJobsV2Handler(
  deps: RuntimeJobsV2HandlerDeps
): RuntimeJobsV2Handler {
  const { engine, eventLog } = deps;
  const sseTeardownGraceMs =
    deps.sseTeardownGraceMs ?? SSE_REFCOUNT_TEARDOWN_GRACE_MS_DEFAULT;

  // jobId -> app, so SSE frames that carry only a jobId can be scoped without
  // a store read per frame. Bounded; an evicted id is re-read on demand.
  const JOB_APP_CACHE_MAX = 5000;
  const jobApps = new Map<string, string>();
  const rememberJobApp = (jobId: string, app: string) => {
    if (!jobApps.has(jobId) && jobApps.size >= JOB_APP_CACHE_MAX) {
      const oldest = jobApps.keys().next().value;
      if (oldest !== undefined) jobApps.delete(oldest);
    }
    jobApps.set(jobId, app);
  };

  const getJobApp: RuntimeJobsV2Handler["getJobApp"] = async (jobId) => {
    const cached = jobApps.get(jobId);
    if (cached) return cached;
    const found = await engine.get(jobId);
    if (!found) return null;
    rememberJobApp(jobId, found.job.app);
    return found.job.app;
  };

  const getGroupApps: RuntimeJobsV2Handler["getGroupApps"] = async (groupId) => {
    const all = await engine.list({ groupId, includeDismissed: true });
    return [...new Set(all.jobs.map((job) => job.app))];
  };

  const handleSnapshot: RuntimeJobsV2Handler["handleSnapshot"] = async (filter, scopes) => {
    const result = await engine.list(filter);
    const allowed = new Set(scopes);
    for (const job of result.jobs) rememberJobApp(job.jobId, job.app);
    return { jobs: result.jobs.filter((job) => allowed.has(job.app)), maxEventId: result.maxEventId };
  };

  const handleCancelByGroup: RuntimeJobsV2Handler["handleCancelByGroup"] =
    async ({ groupId, reason }) => {
      // Include dismissed rows so we don't leak them across repeat calls,
      // and so terminal-but-not-dismissed rows still get dismissed below.
      const all = await engine.list({ groupId, includeDismissed: true });
      let cancelled = 0;
      let dismissed = 0;
      const cancelReason = reason ?? "media-deleted";
      // Track ids we've already acted on so cascade-cancelled children don't
      // get cancelled again (idempotency).
      const handled = new Set<string>();
      for (const job of all.jobs) {
        if (handled.has(job.jobId)) continue;
        if (job.dismissedAt) {
          // Already dismissed — nothing to do.
          handled.add(job.jobId);
          continue;
        }
        if (isTerminalIngestJobStatus(job.status)) {
          const result = await engine.dismiss(job.jobId);
          if (result.dismissed) dismissed += 1;
          handled.add(job.jobId);
          continue;
        }
        // Non-terminal: cancel cascades through children.
        const result = await engine.cancel(job.jobId, cancelReason);
        for (const id of result.cancelledIds) {
          handled.add(id);
        }
        cancelled += result.cancelledIds.length;
        // Each cascade-cancelled row is now terminal but NOT dismissed; the
        // partial unique index on (app, dedupe_key) still holds the slot.
        // Dismiss them so a re-add ingest with the same dedupe key sees no
        // live row, and `upsertJob` frees the unique slot. Idempotent: a
        // second cancel_by_group on the same group becomes a no-op because
        // every row is dismissed (filtered out of the list pass).
        for (const id of result.cancelledIds) {
          await engine.dismiss(id);
        }
      }
      return { cancelled, dismissed };
    };

  // -----------------------------------------------------------------------
  // Round-13 #4 (c): refcount + 30s grace window for the shared engineV2
  // subscription and SQLite event-log handle.
  //
  // Background: each `handleSseSubscribe` call previously created its own
  // `engine.subscribe(...)` listener. When the desktop disconnects (HMR
  // flicker, navigation, brief network blip) the listener is torn down
  // immediately; on reconnect within the same UX gesture, fresh subscription
  // work has to be redone. The grace window keeps the live subscription
  // attached for a short period after the LAST SSE client disconnects so a
  // quick reconnect just re-attaches without rebuilding state.
  //
  // Implementation:
  //   - `liveFanout` is the shared engine listener that fans events out to
  //     every active SSE client. Created on the first subscribe; reused for
  //     subsequent ones.
  //   - `clientCount` is the simple refcount of attached SSE clients.
  //   - On unsubscribe, when count drops to 0 we schedule `liveFanout` for
  //     teardown 30s later (`SSE_REFCOUNT_TEARDOWN_GRACE_MS`).
  //   - If a new subscriber attaches during the grace window we cancel the
  //     pending timer and reuse the live subscription as-is.
  // -----------------------------------------------------------------------
  const sseClients = new Set<(event: RuntimeJobEvent) => void>();
  let unsubscribeLiveFanout: (() => void) | null = null;
  let teardownTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelPendingTeardown = () => {
    if (teardownTimer !== null) {
      clearTimeout(teardownTimer);
      teardownTimer = null;
    }
  };

  const ensureLiveFanoutAttached = () => {
    if (unsubscribeLiveFanout) return;
    unsubscribeLiveFanout = engine.subscribe((event) => {
      // Snapshot the listener set so a listener that itself unsubscribes
      // mid-iteration doesn't skip a peer.
      const snapshot = [...sseClients];
      for (const listener of snapshot) {
        try {
          listener(event);
        } catch (err) {
          deps.logger?.warn?.("runtime.jobs.v2.sse: client listener threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  };

  const detachLiveFanout = () => {
    if (!unsubscribeLiveFanout) return;
    try {
      unsubscribeLiveFanout();
    } catch {
      // best-effort
    }
    unsubscribeLiveFanout = null;
  };

  /**
   * SSE handler. The route owns the HTTP response
   * stream and provides `write` / `close` callbacks plus the parsed
   * `lastEventId` from the request. The handshake goes out as the FIRST SSE
   * frame as `event: handshake\ndata: <json>\n\n`.
   *
   * Each replay event AND each live event is validated against
   * `runtimeJobsEventSchema` before being written. Validation failures are
   * skipped (logged) so a single malformed payload cannot break the stream.
   */
  const handleSseSubscribe: RuntimeJobsV2Handler["handleSseSubscribe"] = (
    envelope
  ) => {
    let closed = false;
    let clientListener: ((event: RuntimeJobEvent) => void) | null = null;

    const safeWrite = (frame: string) => {
      if (closed) return;
      try {
        envelope.write(frame);
      } catch (err) {
        deps.logger?.warn?.("runtime.jobs.v2.sse: write failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const safeClose = () => {
      if (closed) return;
      closed = true;
      if (clientListener) {
        sseClients.delete(clientListener);
        clientListener = null;
      }
      // Round-13 #4 (c): when the last SSE client leaves, defer teardown of
      // the shared engineV2 subscription by `sseTeardownGraceMs` (defaults
      // to 30 000ms). A reconnect inside the grace window cancels the
      // pending timer via `cancelPendingTeardown` in the next subscribe.
      // When `sseTeardownGraceMs === 0`, tear down immediately so opt-in
      // tests can keep their assertion model simple.
      if (sseClients.size === 0 && unsubscribeLiveFanout) {
        cancelPendingTeardown();
        if (sseTeardownGraceMs <= 0) {
          detachLiveFanout();
        } else {
          teardownTimer = setTimeout(() => {
            teardownTimer = null;
            // Re-check refcount: a subscriber may have arrived in the gap
            // between scheduling and firing.
            if (sseClients.size === 0) {
              detachLiveFanout();
            }
          }, sseTeardownGraceMs);
          // Keep the timer from blocking process exit. The `unref` call is
          // safe to skip if the platform doesn't expose it (jsdom etc.).
          const maybeUnref = (teardownTimer as unknown as { unref?: () => void }).unref;
          if (typeof maybeUnref === "function") maybeUnref.call(teardownTimer);
        }
      }
      try {
        envelope.close();
      } catch {
        // best-effort
      }
    };

    const writeValidatedEventFrame = (frame: Record<string, unknown>) => {
      const validated = runtimeJobsEventSchema.safeParse(frame);
      if (!validated.success) {
        deps.logger?.warn?.("runtime.jobs.v2.sse: dropped invalid event", {
          eventId: frame.eventId,
          event: frame.event,
        });
        return;
      }
      safeWrite(formatSseEventFrame(frame));
    };

    // RT-SEC-03: write a frame only when its job belongs to one of the
    // session's apps. Events that embed the job (created / succeeded / failed
    // / cancelled) name the app directly; the others carry only a jobId and
    // resolve it through the cache or the store. Once one frame has to wait for
    // a lookup, every later frame queues behind it so the stream stays in order.
    const allowedApps = new Set(envelope.scopes);
    const pending: { frames: Promise<void> | null } = { frames: null };
    const deliverEventFrame = (jobId: string, frame: Record<string, unknown>) => {
      const embeddedApp = (frame.job as { app?: unknown } | undefined)?.app;
      if (typeof embeddedApp === "string") rememberJobApp(jobId, embeddedApp);
      const known = typeof embeddedApp === "string" ? embeddedApp : jobApps.get(jobId);
      if (known !== undefined && pending.frames === null) {
        if (allowedApps.has(known)) writeValidatedEventFrame(frame);
        return;
      }
      const step = async () => {
        let app = known;
        if (app === undefined) {
          try {
            app = (await getJobApp(jobId)) ?? undefined;
          } catch {
            app = undefined;
          }
        }
        if (app !== undefined && allowedApps.has(app)) writeValidatedEventFrame(frame);
      };
      const queued = (pending.frames ?? Promise.resolve()).then(step);
      pending.frames = queued;
      void queued.finally(() => {
        if (pending.frames === queued) pending.frames = null;
      });
    };

    const replayResult = eventLog.replay(
      envelope.lastEventId,
      deps.eventReplayLimit
    );

    // 1) Handshake frame. SSE has no top-level `type` field — the event name
    // travels in the `event:` line.
    const handshakeBody: RuntimeJobsSubscribeHandshakeResponse = {
      replayed: replayResult.events.length > 0,
      ...(replayResult.replayOverflow ? { replayOverflow: true } : {}),
      maxEventId: replayResult.maxEventId,
    };
    const handshakeValidated =
      runtimeJobsSubscribeHandshakeResponseSchema.safeParse(handshakeBody);
    if (!handshakeValidated.success) {
      // Emit a single `event: error` frame and close. EventSource clients
      // see this through the `error` listener with `data` populated.
      safeWrite(
        `event: error\ndata: ${stringify({
          error: "internal_handshake_invalid",
          message: "handshake response failed schema validation",
        })}\n\n`
      );
      safeClose();
      return { unsubscribe: safeClose };
    }
    safeWrite(
      `event: handshake\ndata: ${stringify(handshakeValidated.data)}\n\n`
    );

    // 2) Replay events. Each row → flat frame → validated → SSE-wrapped.
    for (const row of replayResult.events) {
      deliverEventFrame(row.jobId, buildEventFrameFromRow(row));
    }

    // 3) Replay overflow short-circuits the live attach. Client falls back to
    // a snapshot fetch + reconnect with the new lastEventId.
    if (replayResult.replayOverflow) {
      const finishOverflow = () => {
        safeWrite(`event: replay_overflow\ndata: {}\n\n`);
        safeClose();
      };
      if (pending.frames) void pending.frames.then(finishOverflow);
      else finishOverflow();
      return { unsubscribe: safeClose };
    }

    // 4) Priming flush. When `lastEventId == maxEventId` (no replay events
    // pending), the only frame written so far is the handshake. Some HTTP
    // pipelines (Bun's chunked-transfer body collector pre-1.3.x, proxies
    // with their own queue-drain heuristics) treat the response as "done"
    // once that single frame has been consumed by the client and end the
    // chunked body before the 20s heartbeat fires. A trivial `:\n\n` SSE
    // comment after the handshake keeps the body "live" through the gap to
    // the first heartbeat. EventSource clients ignore comment frames so
    // this has no semantic effect.
    if (pending.frames) void pending.frames.then(() => safeWrite(":\n\n"));
    else safeWrite(":\n\n");

    // 5) Live subscription via the shared fanout. Round-13 #4 (c): cancel
    // any pending teardown so a reconnect inside the grace window reuses
    // the existing engineV2 subscription instead of detaching + reattaching.
    cancelPendingTeardown();
    ensureLiveFanoutAttached();
    clientListener = (event: RuntimeJobEvent) => {
      deliverEventFrame(event.jobId, buildEventFrame(event));
    };
    sseClients.add(clientListener);

    return { unsubscribe: safeClose };
  };

  const handleCancel: RuntimeJobsV2Handler["handleCancel"] = async ({
    jobId,
    reason,
  }) => {
    const result = await engine.cancel(jobId, reason ?? "user-requested");
    return { cancelled: result.cancelledIds.length > 0 };
  };

  const handleDismiss: RuntimeJobsV2Handler["handleDismiss"] = async ({
    jobId,
  }) => {
    const result = await engine.dismiss(jobId);
    if (result.dismissed) return { dismissed: true };
    const code = result.errorCode === "not-found" ? "not-found" : "not-terminal";
    return { dismissed: false, errorCode: code };
  };

  const handleRetry: RuntimeJobsV2Handler["handleRetry"] = async (input) => {
    const job = (await engine.get(input.jobId))?.job;
    if (deps.failedJobs && job?.app === "badger" && (job.kind === "source" || job.kind === "format")) {
      return deps.failedJobs.retry(input);
    }
    const result = await engine.retry(input.jobId);
    if (result.retried && result.newJobId) {
      return { retried: true, newJobId: result.newJobId };
    }
    return { retried: false };
  };

  const handleAvailability: RuntimeJobsV2Handler["handleAvailability"] = async ({ jobIds }) =>
    deps.failedJobs ? deps.failedJobs.availability(jobIds) : { jobs: [], keptBytesTotal: 0 };

  return {
    handleSseSubscribe,
    handleSnapshot,
    handleCancelByGroup,
    handleCancel,
    handleDismiss,
    handleRetry,
    handleAvailability,
    getJobApp,
    getGroupApps,
  };
}

// ---------------------------------------------------------------------------
// Hono route registration (HTTP snapshot routes only — the v2 stream is
// served by the SSE branch in `apps/runtime/src/index.ts`).
//
// Routes self-gate on whether an `EngineV2` instance has been supplied via
// `setRuntimeJobsV2Handler`. EngineV2 is the default path now; the route is
// inert only when v2 boot was disabled (`RUNTIME_ENGINE_V2=0`) or failed.
// Set `RUNTIME_JOBS_V2_ENABLED=0` to force-disable the snapshot route even
// when a handler is present (used by tests and emergency overrides).
// ---------------------------------------------------------------------------

export const RUNTIME_JOBS_V2_FLAG_ENV = "RUNTIME_JOBS_V2_ENABLED";

export const isRuntimeJobsV2Enabled = (): boolean => {
  const raw = process.env[RUNTIME_JOBS_V2_FLAG_ENV]?.trim().toLowerCase();
  // Default ON; explicit "0" / "false" / "off" / "no" disables.
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
};

/** True when `jobId` exists and belongs to an app outside `scopes` (RT-SEC-03). */
const isForeignJob = async (
  handler: RuntimeJobsV2Handler,
  jobId: string,
  scopes: ReadonlySet<string>
): Promise<boolean> => {
  const app = await handler.getJobApp(jobId);
  return app !== null && !scopes.has(app);
};

/**
 * Register the v2 HTTP routes on the Hono app. Safe to call regardless of
 * the env flag — the routes self-gate.
 *
 * @param app the Hono app
 * @param getHandler a lazy accessor so the bootstrap can register routes
 *   before EngineV2 is constructed. Returns `null` when the handler is not
 *   yet available; the route then responds `503` (after the token check).
 */
export const registerRuntimeJobsV2Routes = (
  app: Hono,
  getHandler: () => RuntimeJobsV2Handler | null
) => {
  const v2RouteFlagOff = () => ({
    error: "not_enabled" as const,
    message: `Set ${RUNTIME_JOBS_V2_FLAG_ENV}=1 to enable runtime.jobs.v2`,
  });

  // Returns the unavailability envelope when V2 isn't ready, or null when
  // a live handler is reachable (caller proceeds).
  const v2UnavailableEnvelope = ():
    | { error: string; message: string }
    | null => {
    if (!isRuntimeJobsV2Enabled()) return v2RouteFlagOff();
    if (!getHandler()) {
      return (
        resolveEngineV2UnavailableError() ?? {
          error: "engine_v2_not_ready",
          message: "EngineV2 handler missing",
        }
      );
    }
    return null;
  };

  // Every route answers 401 to a caller without a live session BEFORE it says
  // anything about v2 availability (RT-SEC-02), and 403 `forbidden_scope` for a
  // job of an app the session is not scoped to (RT-SEC-03).
  const sessionOf = (authorization: string | undefined) => {
    const token = requireToken(authorization ?? null);
    return token ? runtimeState.requireSession(token) : null;
  };

  // POST /runtime/jobs/v2/list — body: { filter?: ListFilter }. The desktop
  // IPC layer canonically passes filter via JSON body (typed by
  // `runtimeJobsListPayloadSchema`); GET-with-querystring is not supported.
  app.post("/runtime/jobs/v2/list", async (c) => {
    const session = sessionOf(c.req.header("authorization"));
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const unavail = v2UnavailableEnvelope();
    if (unavail) return c.json(unavail, 503);
    const handler = getHandler()!;
    const raw = await c.req.json().catch(() => ({}));
    const parsed = runtimeJobsListPayloadSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_payload",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        },
        400
      );
    }
    // The wire-level filter schema accepts scalar `kind`/`lane`/`status` for
    // ergonomic IPC use; engineV2's `ListFilter` (= SqliteJobFilter) takes
    // arrays. Adapt scalar→singleton-array here so callers don't need to
    // know the engine's plurality.
    const wire = parsed.data.filter;
    const adaptedFilter: ListFilter | undefined = wire
      ? {
          ...(wire.app !== undefined ? { app: wire.app } : {}),
          ...(wire.mediaId !== undefined ? { mediaId: wire.mediaId } : {}),
          ...(wire.status !== undefined ? { status: wire.status } : {}),
          ...(wire.kind !== undefined ? { kind: [wire.kind] } : {}),
          ...(wire.lane !== undefined ? { lane: [wire.lane] } : {}),
          ...(wire.includeDismissed !== undefined
            ? { includeDismissed: wire.includeDismissed }
            : {}),
        }
      : undefined;
    const snapshot = await handler.handleSnapshot(adaptedFilter, [...session.scopes]);
    return c.json(snapshot);
  });

  app.post("/runtime/jobs/v2/cancel-by-group", async (c) => {
    const session = sessionOf(c.req.header("authorization"));
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const unavail = v2UnavailableEnvelope();
    if (unavail) return c.json(unavail, 503);
    const handler = getHandler()!;
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeJobsCancelByGroupPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const groupApps = await handler.getGroupApps(parsed.data.groupId);
    if (groupApps.some((groupApp) => !session.scopes.has(groupApp as AppId))) {
      return c.json({ error: "forbidden_scope" }, 403);
    }
    const result = await handler.handleCancelByGroup(parsed.data);
    return c.json(result);
  });

  // POST /runtime/jobs/v2/cancel — single-job cancel. Cascades to children.
  app.post("/runtime/jobs/v2/cancel", async (c) => {
    const session = sessionOf(c.req.header("authorization"));
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const unavail = v2UnavailableEnvelope();
    if (unavail) return c.json(unavail, 503);
    const handler = getHandler()!;
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeJobsCancelPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    if (await isForeignJob(handler, parsed.data.jobId, session.scopes)) {
      return c.json({ error: "forbidden_scope" }, 403);
    }
    const result = await handler.handleCancel(parsed.data);
    return c.json(result);
  });

  // POST /runtime/jobs/v2/dismiss — terminal-job-only.
  app.post("/runtime/jobs/v2/dismiss", async (c) => {
    const session = sessionOf(c.req.header("authorization"));
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const unavail = v2UnavailableEnvelope();
    if (unavail) return c.json(unavail, 503);
    const handler = getHandler()!;
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeJobsDismissPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    if (await isForeignJob(handler, parsed.data.jobId, session.scopes)) {
      return c.json({ error: "forbidden_scope" }, 403);
    }
    const result = await handler.handleDismiss(parsed.data);
    return c.json(result);
  });

  // POST /runtime/jobs/v2/retry — re-queue a failed/cancelled job.
  app.post("/runtime/jobs/v2/retry", async (c) => {
    const session = sessionOf(c.req.header("authorization"));
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const unavail = v2UnavailableEnvelope();
    if (unavail) return c.json(unavail, 503);
    const handler = getHandler()!;
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeJobsRetryPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    if (await isForeignJob(handler, parsed.data.jobId, session.scopes)) {
      return c.json({ error: "forbidden_scope" }, 403);
    }
    const result = await handler.handleRetry(parsed.data);
    return c.json(result);
  });

  // POST /runtime/jobs/v2/availability — the one action each failed job offers
  // (UX-JOBS-03). Jobs of apps outside the session's scopes are left out.
  app.post("/runtime/jobs/v2/availability", async (c) => {
    const session = sessionOf(c.req.header("authorization"));
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const unavail = v2UnavailableEnvelope();
    if (unavail) return c.json(unavail, 503);
    const handler = getHandler()!;
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeJobsAvailabilityPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const jobIds: string[] = [];
    for (const jobId of parsed.data.jobIds) {
      if (!(await isForeignJob(handler, jobId, session.scopes))) jobIds.push(jobId);
    }
    return c.json(await handler.handleAvailability({ jobIds }));
  });

  // Round-13 #4 (a): the legacy WebSocket stub at `GET /runtime/events/jobs/v2`
  // (formerly returning 426 Upgrade Required) was removed alongside the WS
  // endpoint itself. The SSE transport at `/runtime/events/jobs/v2/stream` is
  // the only v2 event channel; the route is owned by the Bun server in
  // `apps/runtime/src/index.ts` outside the Hono app, so no Hono entry exists
  // here.

  // Catch-all for any other `/runtime/jobs/v2/*` path or wrong method on the
  // explicit routes above. Without this Hono returns 404 — the renderer can't
  // distinguish "engine not ready" from "endpoint missing entirely". Per the
  // task #7 loud-fail rule, every v2 surface must respond with the same 503
  // envelope so the UI can show a single "Ingest unavailable" banner.
  app.all("/runtime/jobs/v2/*", (c) => {
    if (!sessionOf(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const unavail = v2UnavailableEnvelope();
    if (unavail) return c.json(unavail, 503);
    return c.json(
      {
        error: "unknown_v2_endpoint",
        message: `No runtime.jobs.v2 handler for ${c.req.method} ${c.req.path}`,
      },
      404
    );
  });

  console.info(
    "[runtime] runtime.jobs.v2 routes registered (always-on; runtime self-gates per request)"
  );
};

// ---------------------------------------------------------------------------
// Wire-up notes (current shape)
//
// To activate `runtime.jobs.v2` end-to-end:
//
//   1. Construct EngineV2 + a SqliteEventLogDeps-backed EventLog pointing at
//      the same DB:
//        const engine = createEngineV2({ dbPath: "<runtimeDataDir>/runtime_jobs.db" });
//        await engine.start();
//        const eventLogForRoute = createEventLog(createSqliteEventLogDeps(engine._dbHandle));
//
//   2. Build the handler:
//        const v2Handler = createRuntimeJobsV2Handler({
//          engine,
//          eventLog: eventLogForRoute,
//        });
//
//   3. Hand the handler to the SSE branch in apps/runtime/src/index.ts via
//      `setRuntimeJobsV2Handler(v2Handler)`. The branch matches GET requests
//      on `/runtime/events/jobs/v2/stream` and calls
//      `v2Handler.handleSseSubscribe(envelope)` with the response stream.
//
//   4. Pass `getHandler` to `registerRuntimeJobsV2Routes(app, () => v2Handler)`
//      so the HTTP snapshot/cancel/dismiss/retry endpoints can reach the
//      same instance.
//
// Round-13 #4 (a): the legacy WebSocket transport at `/runtime/events/jobs/v2`
// was removed; SSE is now the sole event channel for runtime.jobs.v2.
// ---------------------------------------------------------------------------
