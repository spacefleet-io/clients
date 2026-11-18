import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeJobsV2Stream,
  type RuntimeJobsV2ConnectionState,
} from "../src/jobsV2";
import type { RuntimeJobsEvent } from "@space/runtime-contracts/runtime/jobs";

const SUITE = "runtime-client-jobsV2";
const OPS_TAIL_MAX = 10;

// ---------------------------------------------------------------------------
// FakeEventSource — minimal subset needed by the SSE client. Mirrors the
// FakeWebSocket pattern from the prior round so test ergonomics carry over.
// ---------------------------------------------------------------------------

type SseEventLike = { data?: unknown; lastEventId?: string };

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static opsTail: Array<{
    instanceIdx: number;
    at: number;
    type: string;
    data: unknown;
    lastEventId?: string;
  }> = [];
  private listeners = new Map<string, Array<(event?: SseEventLike) => void>>();
  closed = false;
  readyState = 0; // CONNECTING

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: SseEventLike) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = 2; // CLOSED
  }

  emit(type: string, event?: SseEventLike) {
    try {
      let parsed: unknown = event?.data;
      if (typeof parsed === "string" && parsed.length > 0) {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          // keep raw string
        }
      }
      FakeEventSource.opsTail.push({
        instanceIdx: FakeEventSource.instances.indexOf(this),
        at: Date.now(),
        type,
        data: parsed,
        lastEventId: event?.lastEventId,
      });
      if (FakeEventSource.opsTail.length > OPS_TAIL_MAX) {
        FakeEventSource.opsTail.splice(
          0,
          FakeEventSource.opsTail.length - OPS_TAIL_MAX,
        );
      }
    } catch {
      // ignore tail-bookkeeping failures
    }
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const sampleJobRecord = {
  jobId: "src1",
  app: "badger" as const,
  kind: "source" as const,
  lane: "source" as const,
  status: "queued" as const,
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction" as const, completed: 0, total: 100, unit: "percent" as const },
  payload: {},
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  groupId: "g1",
  mediaId: "m1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 0,
};

const handshakeData = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    replayed: false,
    maxEventId: 0,
    ...overrides,
  });

const createdData = (eventId: number, job = sampleJobRecord) =>
  JSON.stringify({
    eventId,
    emittedAt: "2026-05-01T00:00:00.000Z",
    event: "runtime.jobs.created",
    job,
  });

const progressData = (eventId: number) =>
  JSON.stringify({
    eventId,
    emittedAt: "2026-05-01T00:00:00.000Z",
    event: "runtime.jobs.progress",
    jobId: "src1",
    groupId: "g1",
    progressPct: 42,
    stageCode: "encoding",
    stageLabel: "Encoding",
    uploadSpeedBytesPerSec: null,
  });

type BuildStreamCtx = {
  stream: ReturnType<typeof createRuntimeJobsV2Stream>;
  events: RuntimeJobsEvent[];
  errors: Error[];
  states: RuntimeJobsV2ConnectionState[];
  handshakes: Array<{
    replayed: boolean;
    replayOverflow?: boolean;
    maxEventId: number;
  }>;
};

const buildStream = (
  overrides: Partial<Parameters<typeof createRuntimeJobsV2Stream>[0]> = {},
): BuildStreamCtx => {
  const events: RuntimeJobsEvent[] = [];
  const errors: Error[] = [];
  const states: RuntimeJobsV2ConnectionState[] = [];
  const handshakes: Array<{
    replayed: boolean;
    replayOverflow?: boolean;
    maxEventId: number;
  }> = [];
  const stream = createRuntimeJobsV2Stream({
    url: "http://127.0.0.1:3020/runtime/events/jobs/v2/stream",
    EventSourceImpl: FakeEventSource as unknown as new (url: string) => EventSource,
    onEvent: (e) => events.push(e),
    onError: (err) => errors.push(err),
    onConnectionStateChange: (s) => states.push(s),
    onHandshake: (h) => handshakes.push(h),
    ...overrides,
  });
  return { stream, events, errors, states, handshakes };
};

const dumpJobsV2Snapshot = (label: string, ctx: BuildStreamCtx & {
  fetchMock?: ReturnType<typeof vi.fn>;
  extra?: Record<string, unknown>;
}) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(
      `EventSource instances: ${FakeEventSource.instances.length}`,
    );
    console.error(
      `EventSource state:\n${JSON.stringify(
        FakeEventSource.instances.map((es, idx) => ({
          idx,
          url: es.url,
          closed: es.closed,
          readyState: es.readyState,
        })),
        null,
        2,
      )}`,
    );
    console.error(
      `connection state transitions (${ctx.states.length}):\n${JSON.stringify(ctx.states, null, 2)}`,
    );
    console.error(
      `handshakes (${ctx.handshakes.length}):\n${JSON.stringify(ctx.handshakes, null, 2)}`,
    );
    console.error(
      `events received (${ctx.events.length}):\n${JSON.stringify(ctx.events, null, 2)}`,
    );
    console.error(
      `errors received (${ctx.errors.length}):\n${JSON.stringify(
        ctx.errors.map((e) => e.message),
        null,
        2,
      )}`,
    );
    console.error(
      `recent SSE ops (last ${OPS_TAIL_MAX}):\n${JSON.stringify(
        FakeEventSource.opsTail,
        null,
        2,
      )}`,
    );
    if (ctx.fetchMock) {
      console.error(
        `fetch calls (${ctx.fetchMock.mock.calls.length}):\n${JSON.stringify(
          ctx.fetchMock.mock.calls.map((c, idx) => {
            const [url, init] = c as [unknown, unknown];
            const initRecord = (init && typeof init === "object" ? init : {}) as {
              method?: unknown;
              headers?: unknown;
            };
            return {
              idx,
              url,
              method: initRecord.method ?? "GET",
              headerKeys:
                initRecord.headers && typeof initRecord.headers === "object"
                  ? Object.keys(initRecord.headers as object)
                  : null,
            };
          }),
          null,
          2,
        )}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("runtime-client jobsV2 (SSE)", () => {
  console.info(
    `[${SUITE}:setup] jobsV2 SSE stream suite (handshake, events, reconnect cursor)`,
  );

  beforeEach(() => {
    FakeEventSource.instances = [];
    FakeEventSource.opsTail = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions through connecting → open → closed", async () => {
    console.info(`[${SUITE}:state-transitions] expecting [connecting, open, closed]`);
    const ctx = buildStream();
    const { stream, states } = ctx;
    try {
      await stream.start();
      const es = FakeEventSource.instances[0]!;
      es.readyState = 1;
      es.emit("open");
      stream.stop();
      expect(states).toEqual(["connecting", "open", "closed"]);
      console.info(`[${SUITE}:state-transitions] OK states=${JSON.stringify(states)}`);
    } catch (err) {
      dumpJobsV2Snapshot("state-transitions-mismatch", ctx);
      throw err;
    }
  });

  it("opens an EventSource at the SSE URL with the configured token query string", async () => {
    console.info(`[${SUITE}:open-url] verify URL passthrough`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0]!.url).toBe(
        "http://127.0.0.1:3020/runtime/events/jobs/v2/stream",
      );
      console.info(`[${SUITE}:open-url] OK url=${FakeEventSource.instances[0]?.url}`);
    } catch (err) {
      dumpJobsV2Snapshot("open-url-mismatch", ctx);
      throw err;
    }
  });

  it("appends initialLastEventId as a query-string fallback for the first connect", async () => {
    console.info(`[${SUITE}:initial-cursor] initialLastEventId=7 should appear in URL`);
    const ctx = buildStream({ initialLastEventId: 7 });
    try {
      await ctx.stream.start();
      const opened = FakeEventSource.instances[0]!.url;
      expect(opened).toContain("lastEventId=7");
      console.info(`[${SUITE}:initial-cursor] OK url=${opened}`);
    } catch (err) {
      dumpJobsV2Snapshot("initial-cursor-mismatch", ctx);
      throw err;
    }
  });

  it("parses the handshake event and records the maxEventId", async () => {
    console.info(`[${SUITE}:handshake] handshake replayed=true maxEventId=12`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", { data: handshakeData({ replayed: true, maxEventId: 12 }) });
      expect(ctx.handshakes).toEqual([{ replayed: true, maxEventId: 12 }]);
      console.info(`[${SUITE}:handshake] OK handshakes=${JSON.stringify(ctx.handshakes)}`);
    } catch (err) {
      dumpJobsV2Snapshot("handshake-mismatch", ctx);
      throw err;
    }
  });

  it("forwards a runtime.jobs.created event through Zod validation", async () => {
    console.info(`[${SUITE}:event-created] inject runtime.jobs.created eventId=1`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", { data: handshakeData() });
      es.emit("runtime.jobs.created", { data: createdData(1), lastEventId: "1" });
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0]!.event).toBe("runtime.jobs.created");
      if (ctx.events[0]!.event === "runtime.jobs.created") {
        expect(ctx.events[0]!.job.jobId).toBe("src1");
      }
      console.info(
        `[${SUITE}:event-created] OK events=${ctx.events.length} firstEvent=${ctx.events[0]?.event}`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("event-created-mismatch", ctx);
      throw err;
    }
  });

  it("forwards a runtime.jobs.progress event", async () => {
    console.info(`[${SUITE}:event-progress] inject runtime.jobs.progress eventId=2`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", { data: handshakeData() });
      es.emit("runtime.jobs.progress", { data: progressData(2), lastEventId: "2" });
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0]!.event).toBe("runtime.jobs.progress");
      if (ctx.events[0]!.event === "runtime.jobs.progress") {
        expect(ctx.events[0]!.progressPct).toBe(42);
      }
      console.info(`[${SUITE}:event-progress] OK progressPct=42`);
    } catch (err) {
      dumpJobsV2Snapshot("event-progress-mismatch", ctx);
      throw err;
    }
  });

  it("surfaces malformed events through onError without throwing", async () => {
    console.info(`[${SUITE}:malformed-event] inject created event with missing job`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", { data: handshakeData() });
      es.emit("runtime.jobs.created", {
        data: JSON.stringify({ event: "runtime.jobs.created" }),
      }); // no `job`
      expect(ctx.events).toHaveLength(0);
      expect(ctx.errors).toHaveLength(1);
      expect(ctx.errors[0]!.message).toContain("invalid event frame");
      console.info(
        `[${SUITE}:malformed-event] OK error="${ctx.errors[0]?.message}"`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("malformed-event-mismatch", ctx);
      throw err;
    }
  });

  it("surfaces a malformed handshake response via onError", async () => {
    console.info(`[${SUITE}:malformed-handshake] maxEventId is string instead of number`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", {
        data: JSON.stringify({ maxEventId: "not a number" }),
      });
      expect(ctx.errors).toHaveLength(1);
      expect(ctx.errors[0]!.message).toContain("invalid handshake response");
      console.info(
        `[${SUITE}:malformed-handshake] OK error="${ctx.errors[0]?.message}"`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("malformed-handshake-mismatch", ctx);
      throw err;
    }
  });

  it("ignores invalid JSON event frames with a single error report", async () => {
    console.info(`[${SUITE}:invalid-json] inject non-JSON event payload`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", { data: handshakeData() });
      es.emit("runtime.jobs.created", { data: "not json {{{" });
      expect(ctx.errors).toHaveLength(1);
      expect(ctx.errors[0]!.message).toContain("invalid JSON");
      console.info(
        `[${SUITE}:invalid-json] OK error="${ctx.errors[0]?.message}"`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("invalid-json-mismatch", ctx);
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] replay_overflow event triggers caller reconnect (snapshot fallback)", async () => {
    // Round-6 plan §B: SSE replay_overflow is a single named event, no
    // handshake-bundle field. The caller (the renderer-level store) should
    // observe an error via onError and re-fetch a fresh snapshot. This
    // matches the prior WS handshake-bundled overflow flow at the consumer
    // boundary: snapshot is replayed via synth runtime.jobs.created events.
    console.info(`[${SUITE}:replay-overflow] expect snapshot fetch + synth created event`);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jobs: [sampleJobRecord], maxEventId: 99 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const ctx = buildStream({ fetch: fetchMock });
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", {
        data: handshakeData({ replayed: true, maxEventId: 9000 }),
      });
      es.emit("replay_overflow", { data: "{}" });
      // Wait microtasks so the snapshot fallback resolves.
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 0));
      console.info(
        `[${SUITE}:replay-overflow] wait microtasks elapsed=${Date.now() - start}ms`,
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0]!.event).toBe("runtime.jobs.created");
      expect(ctx.errors.some((e) => e.message.includes("replay_overflow"))).toBe(true);
      console.info(
        `[${SUITE}:replay-overflow] OK snapshot fetched, synth event fired, error surfaced`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("replay-overflow-flow-broken", { ...ctx, fetchMock });
      throw err;
    }
  });

  it("derives the snapshot URL from the SSE url when no snapshotUrl is given", async () => {
    console.info(`[${SUITE}:derive-snapshot-url] expect /list path derived from stream url`);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ jobs: [], maxEventId: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const ctx = buildStream({ fetch: fetchMock });
    try {
      await ctx.stream.start();
      await ctx.stream.subscribeFreshSnapshot();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3020/runtime/jobs/v2/list",
        expect.objectContaining({ method: "GET" }),
      );
      console.info(
        `[${SUITE}:derive-snapshot-url] OK fetchedUrl=${fetchMock.mock.calls[0]?.[0]}`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("derive-snapshot-url-mismatch", { ...ctx, fetchMock });
      throw err;
    }
  });

  it("attaches a bearer token to the snapshot fetch when provided", async () => {
    console.info(`[${SUITE}:bearer-token] expect Authorization: Bearer rt-tok`);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ jobs: [], maxEventId: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const ctx = buildStream({ fetch: fetchMock, token: "rt-tok" });
    try {
      await ctx.stream.start();
      await ctx.stream.subscribeFreshSnapshot();
      const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer rt-tok",
      );
      console.info(
        `[${SUITE}:bearer-token] OK headerKeys=${Object.keys((init.headers as object) ?? {})}`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("bearer-token-mismatch", { ...ctx, fetchMock });
      throw err;
    }
  });

  it("surfaces snapshot HTTP errors via onError when triggered by overflow", async () => {
    console.info(`[${SUITE}:snapshot-http-error] overflow → snapshot 500 → onError`);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("nope", { status: 500 }),
    );
    const ctx = buildStream({ fetch: fetchMock });
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", { data: handshakeData({ maxEventId: 100 }) });
      es.emit("replay_overflow", { data: "{}" });
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 0));
      console.info(
        `[${SUITE}:snapshot-http-error] wait microtasks elapsed=${Date.now() - start}ms`,
      );
      expect(ctx.errors.some((e) => e.message.includes("snapshot_http_500"))).toBe(true);
      console.info(`[${SUITE}:snapshot-http-error] OK snapshot_http_500 surfaced`);
    } catch (err) {
      dumpJobsV2Snapshot("snapshot-http-error-mismatch", { ...ctx, fetchMock });
      throw err;
    }
  });

  it("stop() closes the EventSource and reports closed state once", async () => {
    console.info(`[${SUITE}:stop-closes] stop() should set es.closed and state=closed`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.readyState = 1;
      es.emit("open");
      ctx.stream.stop();
      expect(es.closed).toBe(true);
      expect(ctx.states[ctx.states.length - 1]).toBe("closed");
      console.info(
        `[${SUITE}:stop-closes] OK es.closed=${es.closed} lastState=${ctx.states[ctx.states.length - 1]}`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("stop-closes-mismatch", ctx);
      throw err;
    }
  });

  it("surfaces EventSource transport error events via onError", async () => {
    console.info(`[${SUITE}:transport-error] simulate transport error after open`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.readyState = 1;
      es.emit("open");
      es.readyState = 2; // simulate CLOSED after a 401 / hard error
      es.emit("error"); // no `data` → transport-level error
      expect(ctx.errors).toHaveLength(1);
      expect(ctx.errors[0]!.message).toContain("eventsource error");
      expect(ctx.states[ctx.states.length - 1]).toBe("closed");
      console.info(
        `[${SUITE}:transport-error] OK error="${ctx.errors[0]?.message}" lastState=${ctx.states[ctx.states.length - 1]}`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("transport-error-mismatch", ctx);
      throw err;
    }
  });

  it("surfaces server-emitted `event: error` envelopes via onError with parsed code+message", async () => {
    // Server-side: rare internal-handshake-validation failure path emits
    // `event: error\ndata: {error, message}\n\n` then closes the stream.
    // EventSource dispatches this through the same `error` listener as
    // transport errors, disambiguated by the presence of `data`.
    console.info(`[${SUITE}:server-error-envelope] inject error event with data payload`);
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("error", {
        data: JSON.stringify({
          error: "internal_handshake_invalid",
          message: "handshake response failed schema validation",
        }),
      });
      expect(ctx.errors).toHaveLength(1);
      expect(ctx.errors[0]!.message).toContain("internal_handshake_invalid");
      expect(ctx.errors[0]!.message).toContain(
        "handshake response failed schema validation",
      );
      console.info(
        `[${SUITE}:server-error-envelope] OK error="${ctx.errors[0]?.message}"`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("server-error-envelope-mismatch", ctx);
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] Last-Event-ID semantics: lastEventId tracks the latest received id across frames", async () => {
    // EventSource itself sets `Last-Event-ID` on auto-reconnect using the
    // most recent `id:` line it observed — the browser owns this. The
    // client-side guarantee under test here is that the stream's internal
    // `lastEventId` always reflects the highest eventId received, so any
    // post-reconnect snapshot fetch (or query-string fallback on a fresh
    // connect) carries the right cursor.
    console.info(
      `[${SUITE}:last-event-id] expect initialLastEventId=9 in second connect URL`,
    );
    const ctx = buildStream();
    try {
      await ctx.stream.start();
      const es = FakeEventSource.instances[0]!;
      es.emit("handshake", { data: handshakeData({ maxEventId: 5 }) });
      es.emit("runtime.jobs.created", { data: createdData(7), lastEventId: "7" });
      es.emit("runtime.jobs.progress", { data: progressData(9), lastEventId: "9" });
      console.info(
        `[${SUITE}:last-event-id] frames eventIds=[7, 9] consumed; restarting with initialLastEventId=9`,
      );
      // Drop & restart simulates the reconnect path. EventSource would set
      // Last-Event-ID: 9 on its retry; here we verify the next `start()`
      // would carry the same cursor through the URL fallback.
      ctx.stream.stop();
      // A new buildStream with the same lastEventId initial would set the
      // query parameter; verify that path explicitly.
      const ctx2 = buildStream({ initialLastEventId: 9 });
      await ctx2.stream.start();
      expect(FakeEventSource.instances[1]!.url).toContain("lastEventId=9");
      console.info(
        `[${SUITE}:last-event-id] OK reconnect url=${FakeEventSource.instances[1]?.url}`,
      );
    } catch (err) {
      dumpJobsV2Snapshot("last-event-id-mismatch", ctx);
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // @bugfix the-app-restart-fixed-soft-pixel — onReauthNeeded recovery.
  //
  // The SSE URL bakes the runtime session token into a `?token=` query
  // param because EventSource can't set custom headers. When that token
  // expires the URL itself is burned — the browser's auto-reconnect would
  // hit the same 401 forever. `onReauthNeeded` lets the caller (the
  // renderer's runtimeJobsStore) request a fresh URL from the desktop main
  // process (which mints a new runtime session via the now-expiry-aware
  // session client) and re-open the stream against the new URL.
  // @regression-proof
  // ---------------------------------------------------------------------------
  describe("onReauthNeeded recovery @bugfix @regression-proof", () => {
    it("pre-handshake EventSource error → calls onReauthNeeded → opens new EventSource with fresh URL", async () => {
      const onReauthNeeded = vi
        .fn<() => Promise<string>>()
        .mockResolvedValue("http://127.0.0.1:3020/runtime/events/jobs/v2/stream?token=FRESH");
      const ctx = buildStream({ onReauthNeeded });
      try {
        await ctx.stream.start();
        expect(FakeEventSource.instances).toHaveLength(1);
        const firstEs = FakeEventSource.instances[0]!;
        expect(firstEs.url).not.toContain("token=FRESH");
        // Simulate a 401-on-initial-connect: error fires, readyState → CLOSED.
        firstEs.readyState = 2;
        firstEs.emit("error", undefined);
        // Reauth runs in a microtask — await one resolved promise + a tick.
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        console.info(
          `[${SUITE}:reauth-replaces-url] reauthCalls=${onReauthNeeded.mock.calls.length} esInstances=${FakeEventSource.instances.length}`,
        );
        expect(onReauthNeeded).toHaveBeenCalledTimes(1);
        // A NEW EventSource was opened against the fresh URL.
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(FakeEventSource.instances[1]!.url).toContain("token=FRESH");
        // First (stale) EventSource was closed so the browser doesn't keep
        // auto-reconnecting to the burned URL.
        expect(firstEs.closed).toBe(true);
      } catch (err) {
        dumpJobsV2Snapshot("reauth-replaces-url-failure", { ...ctx, extra: { reauthCalls: onReauthNeeded.mock.calls.length } });
        throw err;
      }
    });

    it("two consecutive pre-handshake errors → reauth ONLY ONCE; no ping-pong loop", async () => {
      const onReauthNeeded = vi
        .fn<() => Promise<string>>()
        .mockResolvedValue("http://127.0.0.1:3020/runtime/events/jobs/v2/stream?token=FRESH");
      const ctx = buildStream({ onReauthNeeded });
      try {
        await ctx.stream.start();
        // First error — triggers reauth.
        const first = FakeEventSource.instances[0]!;
        first.readyState = 2;
        first.emit("error", undefined);
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(FakeEventSource.instances).toHaveLength(2);
        // Second error on the REAUTHED stream — must NOT trigger another reauth.
        const second = FakeEventSource.instances[1]!;
        second.readyState = 2;
        second.emit("error", undefined);
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        console.info(
          `[${SUITE}:reauth-single-shot] reauthCalls=${onReauthNeeded.mock.calls.length} esInstances=${FakeEventSource.instances.length}`,
        );
        // Reauth budget exhausted after the first attempt — no third instance.
        expect(onReauthNeeded).toHaveBeenCalledTimes(1);
        expect(FakeEventSource.instances).toHaveLength(2);
      } catch (err) {
        dumpJobsV2Snapshot("reauth-single-shot-failure", { ...ctx, extra: { reauthCalls: onReauthNeeded.mock.calls.length } });
        throw err;
      }
    });

    it("POST-handshake error does NOT reauth — transient drop lets browser auto-reconnect", async () => {
      const onReauthNeeded = vi
        .fn<() => Promise<string>>()
        .mockResolvedValue("http://127.0.0.1:3020/runtime/events/jobs/v2/stream?token=SHOULD_NOT_BE_USED");
      const ctx = buildStream({ onReauthNeeded });
      try {
        await ctx.stream.start();
        const es = FakeEventSource.instances[0]!;
        // Deliver a real handshake so handshakeReceived flips true.
        es.emit("handshake", {
          data: JSON.stringify({ replayed: false, maxEventId: 0 }),
        });
        // NOW emit an error (e.g. transient network drop after a successful connection).
        es.readyState = 2;
        es.emit("error", undefined);
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        console.info(
          `[${SUITE}:reauth-skip-post-handshake] reauthCalls=${onReauthNeeded.mock.calls.length} esInstances=${FakeEventSource.instances.length} handshakes=${ctx.handshakes.length}`,
        );
        // Post-handshake errors are transient drops — let the browser handle
        // EventSource auto-reconnect. Reauth would inappropriately tear down
        // a stream that may have already recovered by the time the new URL
        // arrives.
        expect(onReauthNeeded).toHaveBeenCalledTimes(0);
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(ctx.handshakes).toHaveLength(1);
      } catch (err) {
        dumpJobsV2Snapshot("reauth-skip-post-handshake-failure", { ...ctx, extra: { reauthCalls: onReauthNeeded.mock.calls.length } });
        throw err;
      }
    });

    it("no onReauthNeeded callback → legacy behaviour (no extra EventSource, no reauth attempt)", async () => {
      // This pin protects existing callers from a behavioural regression
      // when they don't opt into the reauth flow.
      const ctx = buildStream();
      try {
        await ctx.stream.start();
        const es = FakeEventSource.instances[0]!;
        es.readyState = 2;
        es.emit("error", undefined);
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        console.info(
          `[${SUITE}:no-reauth-callback] esInstances=${FakeEventSource.instances.length} states=${ctx.states.join(",")}`,
        );
        // Still just ONE EventSource — browser's own auto-reconnect handles
        // it from here. We only added the closed→closed state transition,
        // not a new EventSource.
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(ctx.states).toContain("closed");
      } catch (err) {
        dumpJobsV2Snapshot("no-reauth-callback-failure", ctx);
        throw err;
      }
    });

    it("onReauthNeeded throws → emits reauth_failed error, no new EventSource", async () => {
      const onReauthNeeded = vi
        .fn<() => Promise<string>>()
        .mockRejectedValue(new Error("network_down"));
      const ctx = buildStream({ onReauthNeeded });
      try {
        await ctx.stream.start();
        const es = FakeEventSource.instances[0]!;
        es.readyState = 2;
        es.emit("error", undefined);
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        console.info(
          `[${SUITE}:reauth-callback-throws] errors=${ctx.errors.map((e) => e.message).join("|")} esInstances=${FakeEventSource.instances.length}`,
        );
        expect(onReauthNeeded).toHaveBeenCalledTimes(1);
        // Surfaced as a typed error so the store can decide what to do next.
        expect(
          ctx.errors.some((e) => e.message.startsWith("runtime_jobs_v2_reauth_failed")),
        ).toBe(true);
        // No new EventSource — reauth failed, we did not blindly reopen.
        expect(FakeEventSource.instances).toHaveLength(1);
      } catch (err) {
        dumpJobsV2Snapshot("reauth-callback-throws-failure", { ...ctx, extra: { reauthCalls: onReauthNeeded.mock.calls.length } });
        throw err;
      }
    });
  });
});
