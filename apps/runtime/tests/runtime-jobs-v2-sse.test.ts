/**
 * Unit tests for the SSE side of `runtime.jobs.v2`.
 *
 * Round-13 #4 (a): the legacy WebSocket transport (and its sibling
 * `runtime-jobs-v2-route.test.ts`) was removed; SSE is the sole event
 * channel for `runtime.jobs.v2`. Refcount-grace coverage lives in
 * `runtime-jobs-v2-sse-grace.test.ts`.
 *
 * Vitest workers run under Node, not Bun, so `Bun.serve` integration tests
 * silently no-op the same way `runtime-ws.integration.test.ts` does. We
 * therefore unit-test the handler directly via `handleSseSubscribe` with a
 * captured-frames envelope — handshake / replay / overflow / live forwarding /
 * cleanup / schema validation. End-to-end checks (auth, response headers,
 * heartbeat interval, real `Last-Event-ID` parsing) live in the live-
 * verification suite the verifier runs against the running runtime.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createRuntimeJobsV2Handler,
  type RuntimeJobsV2Handler,
} from "../src/routes/runtimeJobsV2";
import { createEventLog, type EventLogDeps, type EventRow } from "@space/runtime-jobs-engine/eventLog";
import type { EngineV2, RuntimeJobEvent } from "@space/runtime-jobs-engine/engineV2";
import { DEFAULT_LANE_CAPS } from "@space/runtime-jobs-engine/engineV2Lanes";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ALL_APPS = ["badger", "parrot"];

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps full SSE-handler state on assertion
// failure so we get the frame timeline + engine listener counts in CI logs
// without re-running. Wrapped in try/catch so a dump failure can never mask
// the original assertion failure.
// ---------------------------------------------------------------------------
const dumpSseHandlerSnapshot = (
  label: string,
  ctx: {
    sink?: { frames: string[]; isClosed: () => boolean };
    sinks?: Array<{ name: string; frames: string[]; isClosed: () => boolean }>;
    deps?: { rows: EventRow[] };
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-jobs-v2-sse:${label}] snapshot ===`);
    if (ctx.sink) {
      console.error(
        `sink: framesLen=${ctx.sink.frames.length} closed=${ctx.sink.isClosed()}`,
      );
      console.error(`sink.frames=\n${JSON.stringify(ctx.sink.frames, null, 2)}`);
    }
    if (ctx.sinks) {
      for (const s of ctx.sinks) {
        console.error(
          `sink[${s.name}]: framesLen=${s.frames.length} closed=${s.isClosed()}`,
        );
        console.error(
          `sink[${s.name}].frames=\n${JSON.stringify(s.frames, null, 2)}`,
        );
      }
    }
    if (ctx.deps) {
      console.error(
        `eventLog rows (count=${ctx.deps.rows.length})=\n${JSON.stringify(ctx.deps.rows, null, 2)}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

// ---------------------------------------------------------------------------
// Shared in-memory rigs.
// ---------------------------------------------------------------------------

const sampleJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "src1",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: { userId: "u1" },
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
  ...overrides,
});

// Events that carry only a jobId resolve their app through the engine before
// they are written (RT-SEC-03), so replay/live frames land a few microtasks
// after handleSseSubscribe returns.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const memDeps = (): EventLogDeps & { rows: EventRow[] } => {
  const rows: EventRow[] = [];
  let nextId = 1;
  return {
    rows,
    insert(row) {
      const stored: EventRow = { ...row, eventId: nextId++ };
      rows.push(stored);
      return stored;
    },
    selectAfter(lastEventId, limit) {
      return rows.filter((r) => r.eventId > lastEventId).slice(0, limit);
    },
    selectMaxEventId() {
      return rows.length === 0 ? 0 : rows[rows.length - 1].eventId;
    },
    trim() {
      return 0;
    },
  };
};

const stubEngine = (
  initialJobs: IngestJobRecord[] = []
): {
  engine: EngineV2;
  emit: (event: RuntimeJobEvent) => void;
  setMaxEventId: (n: number) => void;
} => {
  const subscribers = new Set<(e: RuntimeJobEvent) => void>();
  let maxEventId = 0;
  let jobs = [...initialJobs];
  const engine: EngineV2 = {
    async start() {},
    async stop() {},
    async submit(job) {
      jobs = [...jobs, job];
      return { jobId: job.jobId };
    },
    async updateJobPayload(jobId) {
      return jobs.find((j) => j.jobId === jobId) ?? null;
    },
    async cancel(jobId) {
      return { cancelledIds: [jobId] };
    },
    async dismiss() {
      return { dismissed: true };
    },
    async retry() {
      return { retried: false };
    },
    async list() {
      return { jobs, maxEventId };
    },
    async get(jobId) {
      const job = jobs.find((j) => j.jobId === jobId);
      return job ? { job, steps: [] } : null;
    },
    async getByDedupe() {
      return null;
    },
    registerHandler() {},
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    setLaneCaps: () => ({ ...DEFAULT_LANE_CAPS }),
    schedulerStats: () => ({
      tickPasses: 0,
      coalescedTicks: 0,
      ready: { source: 0, format: 0, upload: 0, exempt: 0 },
      parked: 0,
      incoming: 0,
      lanesRunning: { source: 0, format: 0, upload: 0 },
    }),
    sessionChanged() {},
  };
  return {
    engine,
    emit: (event) => {
      maxEventId = Math.max(maxEventId, event.eventId);
      for (const sub of subscribers) sub(event);
    },
    setMaxEventId: (n) => {
      maxEventId = n;
    },
  };
};

/**
 * Capture every frame written to the SSE envelope plus a `closed` flag.
 */
const captureSse = () => {
  const frames: string[] = [];
  let closed = false;
  return {
    frames,
    isClosed: () => closed,
    envelope: {
      write(frame: string) {
        frames.push(frame);
      },
      close() {
        closed = true;
      },
    },
  };
};

/**
 * Parse the `data:` line of a single SSE frame back into JSON. Used by tests
 * to assert on payload shape without asserting on the raw wire bytes.
 */
const parseSseDataLine = (frame: string): Record<string, unknown> | null => {
  const dataLine = frame
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice("data: ".length)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
};

const extractEventName = (frame: string): string | null => {
  const eventLine = frame
    .split("\n")
    .find((line) => line.startsWith("event: "));
  return eventLine ? eventLine.slice("event: ".length) : null;
};

const extractIdField = (frame: string): string | null => {
  const idLine = frame.split("\n").find((line) => line.startsWith("id: "));
  return idLine ? idLine.slice("id: ".length) : null;
};

// ---------------------------------------------------------------------------
// Unit-level: drive `handleSseSubscribe` directly.
// ---------------------------------------------------------------------------

describe("runtime.jobs.v2 SSE handler — unit", () => {
  let deps: ReturnType<typeof memDeps>;
  let engineStub: ReturnType<typeof stubEngine>;
  let handler: RuntimeJobsV2Handler;

  beforeEach(() => {
    console.info(`[runtime-jobs-v2-sse:setup] resetting in-memory rigs`);
    deps = memDeps();
    engineStub = stubEngine([sampleJob(), sampleJob({ jobId: "j1" })]);
    handler = createRuntimeJobsV2Handler({
      engine: engineStub.engine,
      eventLog: createEventLog(deps),
      eventReplayLimit: 5,
    });
    console.info(
      `[runtime-jobs-v2-sse:setup] handler ready (eventReplayLimit=5, initialJobs=1)`,
    );
  });

  it("first frame is a handshake when the log is empty and no lastEventId is provided", () => {
    console.info(
      `[runtime-jobs-v2-sse:handshake-empty-log] subscribing with lastEventId=0 on empty log`,
    );
    const sink = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    console.info(
      `[runtime-jobs-v2-sse:handshake-empty-log] subscribe returned, framesLen=${sink.frames.length} closed=${sink.isClosed()}`,
    );

    try {
      expect(sink.frames.length).toBeGreaterThanOrEqual(1);
      const first = sink.frames[0];
      expect(extractEventName(first)).toBe("handshake");
      const data = parseSseDataLine(first);
      expect(data).toMatchObject({ replayed: false, maxEventId: 0 });
      expect(data?.replayOverflow).toBeUndefined();
      expect(sink.isClosed()).toBe(false);
    } catch (err) {
      dumpSseHandlerSnapshot("handshake-empty-log-failure", { sink, deps });
      throw err;
    }
  });

  it("@bugfix @regression-proof emits a priming `:\\n\\n` SSE comment after the handshake when there are no replay events to send", () => {
    // Before the fix, with `lastEventId == maxEventId` the only frame written
    // before `start()` returned was the handshake, and Bun's HTTP body
    // collector terminated the chunked stream before the 20s heartbeat fired
    // — surfacing as `net::ERR_INCOMPLETE_CHUNKED_ENCODING` in Chromium.
    // The fix adds a single `:\n\n` SSE comment immediately after the
    // handshake (and any replay events) so the body always carries at least
    // one byte beyond the handshake. This test fails pre-fix (only 1 frame)
    // and passes post-fix (2 frames: handshake + priming comment).
    console.info(
      `[runtime-jobs-v2-sse:priming-comment] subscribing with empty log, expecting handshake + priming comment`,
    );
    const sink = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    console.info(
      `[runtime-jobs-v2-sse:priming-comment] framesLen=${sink.frames.length}`,
    );

    try {
      expect(sink.frames).toHaveLength(2);
      expect(extractEventName(sink.frames[0])).toBe("handshake");
      expect(sink.frames[1]).toBe(":\n\n");
      expect(sink.isClosed()).toBe(false);
    } catch (err) {
      dumpSseHandlerSnapshot("priming-comment-failure", { sink, deps });
      throw err;
    }
  });

  it("replays only events with eventId > lastEventId, in order, with the correct id field", async () => {
    console.info(
      `[runtime-jobs-v2-sse:replay-after-cursor] appending 3 events (started + 2 progress) to event log`,
    );
    const log = createEventLog(deps);
    log.append("j1", "runtime.jobs.started", {
      jobId: "j1",
      groupId: "g1",
      kind: "source",
      variant: null,
      startedAt: "2026-05-01T00:00:00.000Z",
    });
    log.append("j1", "runtime.jobs.progress", {
      jobId: "j1",
      groupId: "g1",
      progressPct: 25,
      stageCode: "uploading",
      stageLabel: "Uploading",
      uploadSpeedBytesPerSec: 1000,
    });
    log.append("j1", "runtime.jobs.progress", {
      jobId: "j1",
      groupId: "g1",
      progressPct: 50,
      stageCode: "uploading",
      stageLabel: "Uploading",
      uploadSpeedBytesPerSec: 1500,
    });
    console.info(
      `[runtime-jobs-v2-sse:replay-after-cursor] subscribing with lastEventId=1 (should replay events 2 and 3)`,
    );

    const sink = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 1,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    await flush();
    console.info(
      `[runtime-jobs-v2-sse:replay-after-cursor] framesLen=${sink.frames.length}`,
    );

    try {
      // [0]=handshake, [1]=replay event 2, [2]=replay event 3, [3]=priming `:\n\n`.
      expect(sink.frames).toHaveLength(4);
      expect(extractEventName(sink.frames[0])).toBe("handshake");
      expect(parseSseDataLine(sink.frames[0])).toMatchObject({
        replayed: true,
        maxEventId: 3,
      });
      expect(extractIdField(sink.frames[1])).toBe("2");
      expect(extractIdField(sink.frames[2])).toBe("3");
      expect(extractEventName(sink.frames[1])).toBe("runtime.jobs.progress");
      expect(extractEventName(sink.frames[2])).toBe("runtime.jobs.progress");
      expect(parseSseDataLine(sink.frames[1])).toMatchObject({
        eventId: 2,
        progressPct: 25,
      });
      expect(sink.frames[3]).toBe(":\n\n");
    } catch (err) {
      dumpSseHandlerSnapshot("replay-after-cursor-failure", { sink, deps });
      throw err;
    }
  });

  it("emits `event: replay_overflow` and closes the stream when the cap is exceeded", async () => {
    console.info(
      `[runtime-jobs-v2-sse:replay-overflow] appending 10 events (replay cap is 5)`,
    );
    const log = createEventLog(deps);
    for (let i = 0; i < 10; i++) {
      log.append("j1", "runtime.jobs.progress", {
        jobId: "j1",
        groupId: "g1",
        progressPct: 10 * i,
        stageCode: "uploading",
        stageLabel: "Uploading",
        uploadSpeedBytesPerSec: 100,
      });
    }
    console.info(
      `[runtime-jobs-v2-sse:replay-overflow] subscribing with lastEventId=0; expect overflow frame and stream close`,
    );
    const sink = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    await flush();
    console.info(
      `[runtime-jobs-v2-sse:replay-overflow] framesLen=${sink.frames.length} closed=${sink.isClosed()}`,
    );

    try {
      // 1 handshake + 5 replay events (capped) + 1 replay_overflow frame.
      expect(sink.frames).toHaveLength(7);
      expect(extractEventName(sink.frames[0])).toBe("handshake");
      expect(parseSseDataLine(sink.frames[0])).toMatchObject({
        replayed: true,
        replayOverflow: true,
        maxEventId: 10,
      });
      expect(extractEventName(sink.frames[6])).toBe("replay_overflow");
      expect(sink.isClosed()).toBe(true);
    } catch (err) {
      dumpSseHandlerSnapshot("replay-overflow-failure", { sink, deps });
      throw err;
    }
  });

  it("forwards live engine events as SSE frames after the handshake", () => {
    console.info(
      `[runtime-jobs-v2-sse:live-forward] subscribing then emitting a single live engine event`,
    );
    const sink = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    console.info(
      `[runtime-jobs-v2-sse:live-forward] handshake+priming framesLen=${sink.frames.length}`,
    );

    try {
      // Handshake + priming `:\n\n` at this point.
      expect(sink.frames).toHaveLength(2);

      engineStub.emit({
        eventId: 100,
        jobId: "live1",
        event: "runtime.jobs.created",
        payload: { jobId: "live1", job: sampleJob({ jobId: "live1" }) },
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      console.info(
        `[runtime-jobs-v2-sse:live-forward] after emit framesLen=${sink.frames.length}`,
      );
      expect(sink.frames).toHaveLength(3);
      const live = sink.frames[2];
      expect(extractIdField(live)).toBe("100");
      expect(extractEventName(live)).toBe("runtime.jobs.created");
      expect(parseSseDataLine(live)).toMatchObject({
        eventId: 100,
        event: "runtime.jobs.created",
      });
    } catch (err) {
      dumpSseHandlerSnapshot("live-forward-failure", { sink, deps });
      throw err;
    }
  });

  it("stops forwarding live events after the route calls `unsubscribe`", () => {
    console.info(
      `[runtime-jobs-v2-sse:unsubscribe-stops-forwarding] subscribing then immediately unsubscribing`,
    );
    const sink = captureSse();
    const handle = handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    handle.unsubscribe();
    const framesAtUnsubscribe = sink.frames.length; // handshake + priming
    console.info(
      `[runtime-jobs-v2-sse:unsubscribe-stops-forwarding] framesAtUnsubscribe=${framesAtUnsubscribe}; emitting live event (should be ignored)`,
    );
    engineStub.emit({
      eventId: 200,
      jobId: "x",
      event: "runtime.jobs.progress",
      payload: {
        jobId: "x",
        groupId: "g1",
        progressPct: 50,
        stageCode: "uploading",
        stageLabel: "Uploading",
        uploadSpeedBytesPerSec: 100,
      },
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    console.info(
      `[runtime-jobs-v2-sse:unsubscribe-stops-forwarding] framesAfterEmit=${sink.frames.length}`,
    );

    try {
      // No new frame after unsubscribe.
      expect(sink.frames).toHaveLength(framesAtUnsubscribe);
    } catch (err) {
      dumpSseHandlerSnapshot("unsubscribe-stops-forwarding-failure", {
        sink,
        deps,
        extra: { framesAtUnsubscribe },
      });
      throw err;
    }
  });

  it("drops live events whose payload fails `runtimeJobsEventSchema` rather than corrupting the stream", () => {
    console.info(
      `[runtime-jobs-v2-sse:schema-rejection] subscribing then emitting malformed live event`,
    );
    const sink = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    const baselineFrames = sink.frames.length; // handshake + priming
    console.info(
      `[runtime-jobs-v2-sse:schema-rejection] baselineFrames=${baselineFrames}; emitting bad payload (missing job)`,
    );
    // Malformed: `runtime.jobs.created` requires a full `job` object; we
    // emit only `{ jobId }`. Validator should reject and the stream should
    // skip it rather than write garbage.
    engineStub.emit({
      eventId: 99,
      jobId: "broken",
      event: "runtime.jobs.created",
      payload: { jobId: "broken" },
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    console.info(
      `[runtime-jobs-v2-sse:schema-rejection] framesAfterBadEmit=${sink.frames.length}`,
    );

    try {
      // No new frames beyond the baseline (handshake + priming).
      expect(sink.frames).toHaveLength(baselineFrames);
    } catch (err) {
      dumpSseHandlerSnapshot("schema-rejection-failure", {
        sink,
        deps,
        extra: { baselineFrames },
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Auth / header parsing / heartbeat / response-stream framing live in the
// route layer (`apps/runtime/src/index.ts`). Vitest workers run under Node, so
// they can't `Bun.serve(...)` to exercise that code. The verifier covers
// those paths against the running runtime stack — see the F3 walks.
// ---------------------------------------------------------------------------
