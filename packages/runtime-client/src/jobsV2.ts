/**
 * Typed client for the new `runtime.jobs.v2` Server-Sent Events channel.
 *
 * Plan reference: video-ingestion-is-buggy-effervescent-teapot.md (round 6,
 * Part B). Migrated from WebSocket to SSE because:
 *   - Server push only — no client→server channel beyond the cursor handshake.
 *   - Native `Last-Event-ID` reconnect via `EventSource` auto-reconnect.
 *   - HTTP semantics: no upgrade dance, debug with `curl -N`.
 *
 * Runs in renderer / Node / Bun. Does not import from
 * `@space/runtime-jobs-db` or any native module.
 *
 * Wire-format expectations (matched to the runtime-side
 * `formatSseEventFrame` at `apps/runtime/src/routes/runtimeJobsV2.ts:275`):
 *
 *   id: <eventId>
 *   event: <eventName>          // e.g. "handshake", "runtime.jobs.progress",
 *                                  "replay_overflow"
 *   data: <jsonPayload>
 *   <blank line>
 *
 *   Live event payload is the flat envelope shape produced by `eventToFrame`:
 *   `{eventId, emittedAt, event, ...per-event-fields}`. `runtimeJobsEventSchema`
 *   parses it directly.
 *
 *   Handshake payload matches `runtimeJobsSubscribeHandshakeResponseSchema`.
 *   Replay-overflow payload is empty `{}` — the eventName carries the signal.
 */

import {
  runtimeJobsEventSchema,
  runtimeJobsSubscribeHandshakeResponseSchema,
  type RuntimeJobsEvent,
  type RuntimeJobsSubscribeHandshakeResponse,
} from "@space/runtime-contracts/runtime/jobs";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { RuntimeFetch } from "./fetch";

// ---------------------------------------------------------------------------
// EventSource abstraction (mirrors the legacy WebSocket abstraction so tests
// can inject a fake implementation).
// ---------------------------------------------------------------------------

type EventSourceLike = {
  addEventListener: (
    type: string,
    listener: (event: { data?: unknown; lastEventId?: string } | undefined) => void,
  ) => void;
  close: () => void;
  readonly readyState?: number;
};

type EventSourceCtor = new (
  url: string,
  init?: { withCredentials?: boolean },
) => EventSourceLike;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RuntimeJobsV2ConnectionState = "connecting" | "open" | "closed";

export interface RuntimeJobsV2StreamConfig {
  /**
   * SSE URL for the v2 channel
   * (e.g. `http://host:3020/runtime/events/jobs/v2/stream?token=...`).
   * `EventSource` cannot set custom headers, so the token is passed via query
   * string to match the existing endpoint pattern.
   */
  url: string;
  /**
   * HTTP base URL for the snapshot bootstrap. If omitted, snapshot fallback
   * derives from `url` by stripping the SSE path.
   */
  snapshotUrl?: string;
  /** `fetch` override for the snapshot bootstrap. Defaults to global fetch. */
  fetch?: RuntimeFetch;
  /** Optional bearer token for the snapshot HTTP call. */
  token?: string;
  /**
   * `EventSource` constructor override (test injection). Falls back to
   * `globalThis.EventSource` when omitted.
   */
  EventSourceImpl?: EventSourceCtor;
  /**
   * `WebSocket` constructor override — kept solely as a no-op compatibility
   * field so existing call sites passing `WebSocketImpl` don't break during
   * the cutover. Ignored at runtime.
   */
  WebSocketImpl?: unknown;
  /**
   * Resume from this `eventId` on initial connect. Defaults to 0 (no replay).
   * Subsequent auto-reconnects are governed by EventSource's native
   * `Last-Event-ID` header — set automatically from the most recent received
   * `id:` line.
   */
  initialLastEventId?: number;
  /** Per-event callback. Each event is Zod-validated. */
  onEvent: (event: RuntimeJobsEvent) => void;
  /** Optional connection-state callback. */
  onConnectionStateChange?: (state: RuntimeJobsV2ConnectionState) => void;
  /**
   * Optional error callback. Fires for: malformed handshake response,
   * malformed event payloads, snapshot fetch errors, EventSource error events
   * (which include 401s on initial connect).
   */
  onError?: (err: Error) => void;
  /**
   * Hook fired after the handshake is parsed but before any replay events
   * fire. Useful for tests; not load-bearing for the consumer.
   */
  onHandshake?: (response: RuntimeJobsSubscribeHandshakeResponse) => void;
  /**
   * Optional re-auth callback for token-baked stream URLs.
   *
   * The SSE endpoint at `/runtime/events/jobs/v2/stream` carries the session
   * token as a query parameter (EventSource can't set custom headers), so
   * a token that expires mid-flight or arrives stale on the first connect
   * burns the URL itself — the same URL re-opened gets the same 401
   * forever. When provided, this callback is invoked on the first
   * pre-handshake `error` event in a given start() lifecycle to obtain a
   * fresh URL with a newly-issued token; the dead EventSource is closed and
   * a new one is opened against the returned URL. Limited to one re-auth
   * attempt per start() to avoid a tight loop if the new token is also
   * rejected — a second 401 propagates as the usual error path.
   *
   * Omit this callback to preserve the legacy behaviour (let the browser
   * EventSource auto-reconnect with the original URL).
   *
   * Pairs with the runtime auth gate landed in commit 754993df and the
   * desktop main-process `httpFetch` invalidate-and-retry — together they
   * close the runtime-session-expiry recovery loop without requiring a
   * desktop app restart.
   */
  onReauthNeeded?: () => Promise<string>;
}

export interface RuntimeJobsV2Stream {
  start(): Promise<void>;
  stop(): void;
  /**
   * Fetch a fresh snapshot via HTTP. Used internally for replay-overflow
   * recovery and exposed for callers that want to refresh manually.
   */
  subscribeFreshSnapshot(): Promise<{
    jobs: IngestJobRecord[];
    maxEventId: number;
  }>;
}

// All event-name slots we explicitly listen for on the EventSource. Keep in
// sync with `runtimeJobsEventSchema` discriminator literals + the two
// out-of-band names used by the SSE protocol layer.
const RUNTIME_JOBS_EVENT_NAMES = [
  "runtime.jobs.created",
  "runtime.jobs.started",
  "runtime.jobs.progress",
  "runtime.jobs.succeeded",
  "runtime.jobs.failed",
  "runtime.jobs.cancelled",
  "runtime.jobs.dismissed",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const deriveSnapshotUrl = (sseUrl: string): string => {
  // http://host:port/runtime/events/jobs/v2/stream → http://host:port/runtime/jobs/v2/list
  const url = new URL(sseUrl);
  url.pathname = "/runtime/jobs/v2/list";
  url.search = "";
  return url.toString();
};

const synthCreatedEvent = (
  job: IngestJobRecord,
  eventId: number,
  emittedAt: string,
): RuntimeJobsEvent => ({
  eventId,
  emittedAt,
  event: "runtime.jobs.created",
  job: job as RuntimeJobsEvent extends { job: infer J } ? J : never,
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createRuntimeJobsV2Stream = (
  config: RuntimeJobsV2StreamConfig,
): RuntimeJobsV2Stream => {
  const fetchImpl =
    config.fetch ?? (typeof fetch !== "undefined" ? (fetch as RuntimeFetch) : null);
  const EventSourceImpl =
    config.EventSourceImpl ??
    (typeof EventSource !== "undefined"
      ? (EventSource as unknown as EventSourceCtor)
      : null);

  let es: EventSourceLike | null = null;
  let stopped = false;
  let lastEventId = config.initialLastEventId ?? 0;
  let handshakeReceived = false;
  let connState: RuntimeJobsV2ConnectionState = "closed";
  // Reauth budget — single-shot per start(). Reset to 0 only by start()
  // itself, NOT by the reauth path, so a stream that 401s, reauths, and
  // 401s again cannot loop. A successful handshake on the reauthed stream
  // is the implicit "OK we recovered" signal; from there, transient
  // mid-stream drops fall back to the browser EventSource auto-reconnect.
  const MAX_REAUTH_ATTEMPTS = 1;
  let reauthAttempts = 0;
  // Coalesce the reauth fetch — a single EventSource error can fire the
  // listener multiple times in quick succession (browser may emit an `error`
  // for the transport drop AND the readyState→2 transition on the same
  // tick). Without a guard we'd kick off N parallel reauth requests.
  let reauthInFlight: Promise<void> | null = null;

  const setState = (next: RuntimeJobsV2ConnectionState) => {
    if (connState === next) return;
    connState = next;
    config.onConnectionStateChange?.(next);
  };

  const emitError = (err: Error) => {
    if (config.onError) {
      try {
        config.onError(err);
      } catch {
        // swallow consumer errors
      }
    }
  };

  const subscribeFreshSnapshot = async (): Promise<{
    jobs: IngestJobRecord[];
    maxEventId: number;
  }> => {
    if (!fetchImpl) {
      throw new Error("runtime_jobs_v2: no fetch implementation available");
    }
    const url = config.snapshotUrl ?? deriveSnapshotUrl(config.url);
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const res = await fetchImpl(url, { method: "GET", headers });
    if (!res.ok) {
      throw new Error(`runtime_jobs_v2_snapshot_http_${res.status}`);
    }
    const body = (await res.json()) as {
      jobs?: IngestJobRecord[];
      maxEventId?: number;
    };
    return {
      jobs: Array.isArray(body.jobs) ? body.jobs : [],
      maxEventId: typeof body.maxEventId === "number" ? body.maxEventId : 0,
    };
  };

  const replaySnapshot = async () => {
    try {
      const snapshot = await subscribeFreshSnapshot();
      const emittedAt = new Date().toISOString();
      for (const job of snapshot.jobs) {
        const synth = synthCreatedEvent(job, snapshot.maxEventId, emittedAt);
        const validated = runtimeJobsEventSchema.safeParse(synth);
        if (validated.success) {
          try {
            config.onEvent(validated.data);
          } catch {
            // swallow consumer errors
          }
        }
      }
      lastEventId = snapshot.maxEventId;
    } catch (err) {
      emitError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const handleHandshake = (raw: string, eventId?: string) => {
    if (handshakeReceived) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      emitError(new Error("runtime_jobs_v2: invalid JSON handshake frame"));
      return;
    }
    const validated =
      runtimeJobsSubscribeHandshakeResponseSchema.safeParse(parsed);
    if (!validated.success) {
      emitError(new Error("runtime_jobs_v2: invalid handshake response"));
      return;
    }
    handshakeReceived = true;
    lastEventId = validated.data.maxEventId;
    if (eventId) {
      const parsedId = Number(eventId);
      if (Number.isFinite(parsedId)) lastEventId = Math.max(lastEventId, parsedId);
    }
    config.onHandshake?.(validated.data);
  };

  const handleEventFrame = (raw: string, eventId?: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      emitError(new Error("runtime_jobs_v2: invalid JSON frame"));
      return;
    }
    const validated = runtimeJobsEventSchema.safeParse(parsed);
    if (!validated.success) {
      emitError(
        new Error(
          `runtime_jobs_v2: invalid event frame (${validated.error.issues
            .map((i) => i.path.join(".") || "<root>")
            .join(", ")})`,
        ),
      );
      return;
    }
    if (typeof validated.data.eventId === "number") {
      lastEventId = Math.max(lastEventId, validated.data.eventId);
    } else if (eventId) {
      const parsedId = Number(eventId);
      if (Number.isFinite(parsedId)) lastEventId = Math.max(lastEventId, parsedId);
    }
    try {
      config.onEvent(validated.data);
    } catch {
      // swallow consumer errors
    }
  };

  const handleReplayOverflow = () => {
    // Server signalled the durable replay buffer can't reach our cursor.
    // Re-bootstrap via snapshot to converge state. The store layer can also
    // surface this signal to its caller via onError if it wants explicit
    // recovery — wire that hook here.
    void replaySnapshot();
    emitError(new Error("runtime_jobs_v2_replay_overflow"));
  };

  // Attempt a single re-auth: ask the caller for a fresh URL, tear down the
  // dead EventSource (so the browser stops auto-reconnecting to the stale
  // URL), and open a new one. Gated on (1) caller provided the callback,
  // (2) reauth budget not exhausted, (3) handshake never received on the
  // current connection — a post-handshake error is a transient drop, NOT
  // an auth failure, and the browser's auto-reconnect is the right tool.
  const maybeReauth = () => {
    if (!config.onReauthNeeded) return;
    if (reauthAttempts >= MAX_REAUTH_ATTEMPTS) return;
    if (handshakeReceived) return;
    if (stopped) return;
    if (reauthInFlight) return;
    reauthAttempts += 1;
    console.info(
      "[runtime-jobs-v2] reauth: pre-handshake EventSource error; fetching fresh URL",
    );
    reauthInFlight = (async () => {
      try {
        // Close the dead ES first so the browser stops retrying the stale URL.
        if (es) {
          try {
            es.close();
          } catch {
            // best-effort
          }
          es = null;
        }
        const freshUrl = await config.onReauthNeeded!();
        // Don't reset handshakeReceived to true; the new stream will set it
        // when its own handshake arrives.
        console.info(
          `[runtime-jobs-v2] reauth: opening new EventSource at ${freshUrl.replace(/token=[^&]+/, "token=***")}`,
        );
        openStream(freshUrl);
      } catch (err) {
        emitError(
          new Error(
            `runtime_jobs_v2_reauth_failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      } finally {
        reauthInFlight = null;
      }
    })();
  };

  const openStream = (baseUrl: string) => {
    if (!EventSourceImpl) {
      throw new Error(
        "runtime_jobs_v2: no EventSource implementation available",
      );
    }
    setState("connecting");

    // Append initialLastEventId as a query-string fallback so a server that
    // honours the `?lastEventId=N` parameter can replay from there on the
    // FIRST connect (EventSource itself only sets `Last-Event-ID` on
    // auto-reconnects, not on the initial open). Don't double-add if caller
    // already encoded it.
    let urlToOpen = baseUrl;
    if (lastEventId > 0) {
      const u = new URL(baseUrl);
      if (!u.searchParams.has("lastEventId")) {
        u.searchParams.set("lastEventId", String(lastEventId));
        urlToOpen = u.toString();
      }
    }

    es = new EventSourceImpl(urlToOpen);

    es.addEventListener("open", () => {
      setState("open");
    });

    es.addEventListener("error", (ev) => {
      // The EventSource API uses the same `error` listener for two distinct
      // things: (a) transport-level errors (initial-connect 401s, network
      // drops, reconnect failures) — these fire with no `data` field; and
      // (b) server-emitted `event: error\ndata: {error, message}\n\n` frames
      // (runtime-eng confirmed: rare internal-handshake-validation failures
      // — see runtimeJobsV2.ts:517–527). Disambiguate via the presence of
      // `data` and surface meaningfully.
      const data = (ev as { data?: unknown } | undefined)?.data;
      if (typeof data === "string" && data.length > 0) {
        let parsed: { error?: unknown; message?: unknown } | null = null;
        try {
          parsed = JSON.parse(data) as { error?: unknown; message?: unknown };
        } catch {
          parsed = null;
        }
        const code =
          parsed && typeof parsed.error === "string" ? parsed.error : "unknown_error";
        const message =
          parsed && typeof parsed.message === "string" ? parsed.message : code;
        emitError(new Error(`runtime_jobs_v2_server_error_${code}: ${message}`));
        // Server closes the stream after this frame per the route contract.
        // The transport `error` event will follow when readyState flips to
        // CLOSED — we'll set state then.
        return;
      }
      emitError(new Error("runtime_jobs_v2: eventsource error"));
      // EventSource readyState 2 === CLOSED. When it auto-reconnects we'll
      // observe readyState 0 (CONNECTING) and emit "connecting" again the
      // next time "open" fires. We do NOT close on error so the browser can
      // honour its own retry cadence.
      if (es?.readyState === 2) {
        setState("closed");
        // Pre-handshake CLOSED on a token-baked URL is almost always a 401
        // on a stale session token. The reauth path replaces the URL with a
        // freshly-issued token; without it the browser would auto-reconnect
        // to the SAME stale URL and loop forever. Caller-opt-in via
        // config.onReauthNeeded.
        maybeReauth();
      }
    });

    es.addEventListener("handshake", (ev) => {
      const data = (ev as { data?: unknown } | undefined)?.data;
      const eid = (ev as { lastEventId?: string } | undefined)?.lastEventId;
      if (typeof data !== "string") return;
      handleHandshake(data, eid);
    });

    es.addEventListener("replay_overflow", () => {
      handleReplayOverflow();
    });

    for (const eventName of RUNTIME_JOBS_EVENT_NAMES) {
      es.addEventListener(eventName, (ev) => {
        const data = (ev as { data?: unknown } | undefined)?.data;
        const eid = (ev as { lastEventId?: string } | undefined)?.lastEventId;
        if (typeof data !== "string") return;
        handleEventFrame(data, eid);
      });
    }
  };

  const start = async () => {
    if (stopped) stopped = false;
    // Reset reauth budget for each top-level start() — this is the only
    // place that should clear it. The reauth path itself must NOT reset it
    // (that would allow ping-pong loops).
    reauthAttempts = 0;
    openStream(config.url);
  };

  const stop = () => {
    stopped = true;
    if (es) {
      try {
        es.close();
      } catch {
        // best-effort
      }
      es = null;
    }
    setState("closed");
  };

  return { start, stop, subscribeFreshSnapshot };
};
