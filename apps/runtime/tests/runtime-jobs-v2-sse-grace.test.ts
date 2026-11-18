/**
 * @bugfix @regression-proof
 *
 * Round-13 #4 (c): SSE refcount→0 30-second grace window.
 *
 * Pre-fix behaviour (would FAIL these assertions):
 *   - Each `handleSseSubscribe` call did `engine.subscribe(...)` at the end
 *     and the returned `unsubscribe` ran the `engine.subscribe`-unsubscribe
 *     immediately on disconnect.
 *   - A reconnect inside an HMR/navigation flicker re-paid the
 *     engine.subscribe + per-connection setup cost.
 *
 * Post-fix behaviour (this test asserts):
 *   - The handler factory holds a SINGLE shared engineV2 subscription that
 *     fans out to every active SSE client.
 *   - When refcount drops to 0, teardown of that shared subscription is
 *     scheduled for 30s later (`sseTeardownGraceMs`, default 30 000ms).
 *   - A reconnect inside the grace window cancels the pending teardown and
 *     reuses the existing engineV2 subscription — `engine.subscribe` is NOT
 *     called a second time.
 *   - When the grace window elapses with no reconnect, the shared
 *     subscription is detached (`engine.subscribe`'s returned unsubscribe is
 *     called).
 *
 * Tests inject `sseTeardownGraceMs` so they don't have to wait real 30s
 * walls. We also inject vitest fake timers to advance through the grace
 * window deterministically.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createRuntimeJobsV2Handler,
  type RuntimeJobsV2Handler,
} from "../src/routes/runtimeJobsV2";
import {
  createEventLog,
  type EventLogDeps,
  type EventRow,
} from "../src/core/jobs/eventLog";
import type { EngineV2, RuntimeJobEvent } from "../src/core/jobs/engineV2";
import { DEFAULT_LANE_CAPS } from "../src/core/jobs/engineV2Lanes";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ALL_APPS = ["badger", "parrot"];

// ---------------------------------------------------------------------------
// In-memory rigs
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

const memDeps = (): EventLogDeps => {
  const rows: EventRow[] = [];
  let nextId = 1;
  return {
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

/**
 * Stub engine that exposes counters for `engine.subscribe` invocations and
 * for unsubscribe-disposer invocations. The grace-window contract is
 * verified primarily via these counters.
 */
const stubEngine = (
  initialJobs: IngestJobRecord[] = []
): {
  engine: EngineV2;
  emit: (event: RuntimeJobEvent) => void;
  subscribeCount: () => number;
  unsubscribeCount: () => number;
} => {
  const subscribers = new Set<(e: RuntimeJobEvent) => void>();
  const jobs = [...initialJobs];
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const engine: EngineV2 = {
    async start() {},
    async stop() {},
    async submit(job) {
      jobs.push(job);
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
      return { jobs, maxEventId: 0 };
    },
    async get() {
      return null;
    },
    async getByDedupe() {
      return null;
    },
    registerHandler() {},
    subscribe(listener) {
      subscribeCount += 1;
      subscribers.add(listener);
      return () => {
        unsubscribeCount += 1;
        subscribers.delete(listener);
      };
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
      for (const sub of subscribers) sub(event);
    },
    subscribeCount: () => subscribeCount,
    unsubscribeCount: () => unsubscribeCount,
  };
};

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

const buildHandler = (
  engineStub: ReturnType<typeof stubEngine>,
  sseTeardownGraceMs: number
): RuntimeJobsV2Handler =>
  createRuntimeJobsV2Handler({
    engine: engineStub.engine,
    eventLog: createEventLog(memDeps()),
    eventReplayLimit: 5,
    sseTeardownGraceMs,
  });

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps refcount-grace state on assertion
// failure so CI logs surface subscribe/unsubscribe counters and per-sink
// frame queues without re-running. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpGraceSnapshot = (
  label: string,
  ctx: {
    engineStub?: ReturnType<typeof stubEngine>;
    sinks?: Array<{ name: string; frames: string[]; isClosed: () => boolean }>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-jobs-v2-sse-grace:${label}] snapshot ===`);
    if (ctx.engineStub) {
      console.error(
        `engineStub: subscribeCount=${ctx.engineStub.subscribeCount()} unsubscribeCount=${ctx.engineStub.unsubscribeCount()}`,
      );
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
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("@bugfix @regression-proof Round-13 #4 (c) — SSE refcount→0 30s grace", () => {
  beforeEach(() => {
    console.info(`[runtime-jobs-v2-sse-grace:setup] enabling fake timers`);
    vi.useFakeTimers();
  });

  afterEach(() => {
    console.info(`[runtime-jobs-v2-sse-grace:teardown] restoring real timers`);
    vi.useRealTimers();
  });

  it("first SSE subscribe attaches a SHARED engineV2 listener — second subscribe reuses it (no new engine.subscribe)", () => {
    console.info(
      `[runtime-jobs-v2-sse-grace:shared-listener] sub A then sub B; engine.subscribe should be called once total`,
    );
    const engineStub = stubEngine([sampleJob()]);
    const handler = buildHandler(engineStub, 30_000);

    const sinkA = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sinkA.envelope.write,
      close: sinkA.envelope.close,
    });
    console.info(
      `[runtime-jobs-v2-sse-grace:shared-listener] after subA subscribeCount=${engineStub.subscribeCount()}`,
    );

    try {
      expect(engineStub.subscribeCount()).toBe(1);

      const sinkB = captureSse();
      handler.handleSseSubscribe({
        lastEventId: 0,
        scopes: ALL_APPS,
        write: sinkB.envelope.write,
        close: sinkB.envelope.close,
      });
      console.info(
        `[runtime-jobs-v2-sse-grace:shared-listener] after subB subscribeCount=${engineStub.subscribeCount()}`,
      );
      // Refcount went 1 → 2; the shared fanout was already attached, so
      // engine.subscribe must NOT be called again.
      expect(engineStub.subscribeCount()).toBe(1);
    } catch (err) {
      dumpGraceSnapshot("shared-listener-failure", {
        engineStub,
        sinks: [{ name: "A", ...sinkA }],
      });
      throw err;
    }
  });

  it("a single live engineV2 event fans out to every active SSE client", () => {
    console.info(
      `[runtime-jobs-v2-sse-grace:fanout] subscribing A and B, then emitting a single live event`,
    );
    const engineStub = stubEngine([sampleJob()]);
    const handler = buildHandler(engineStub, 30_000);

    const sinkA = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sinkA.envelope.write,
      close: sinkA.envelope.close,
    });
    const sinkB = captureSse();
    handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sinkB.envelope.write,
      close: sinkB.envelope.close,
    });

    const baselineA = sinkA.frames.length; // handshake + priming
    const baselineB = sinkB.frames.length;
    console.info(
      `[runtime-jobs-v2-sse-grace:fanout] baselineA=${baselineA} baselineB=${baselineB}; emitting event`,
    );

    engineStub.emit({
      eventId: 100,
      jobId: "live1",
      event: "runtime.jobs.created",
      payload: { jobId: "live1", job: sampleJob({ jobId: "live1" }) },
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    console.info(
      `[runtime-jobs-v2-sse-grace:fanout] after emit A.framesLen=${sinkA.frames.length} B.framesLen=${sinkB.frames.length}`,
    );

    try {
      expect(sinkA.frames.length).toBe(baselineA + 1);
      expect(sinkB.frames.length).toBe(baselineB + 1);
    } catch (err) {
      dumpGraceSnapshot("fanout-failure", {
        engineStub,
        sinks: [
          { name: "A", ...sinkA },
          { name: "B", ...sinkB },
        ],
        extra: { baselineA, baselineB },
      });
      throw err;
    }
  });

  it("when refcount drops to 0, the shared engineV2 subscription is NOT torn down immediately", () => {
    console.info(
      `[runtime-jobs-v2-sse-grace:no-immediate-teardown] subscribe then unsubscribe; grace=30000ms`,
    );
    const engineStub = stubEngine([sampleJob()]);
    const handler = buildHandler(engineStub, 30_000);

    const sink = captureSse();
    const handle = handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    console.info(
      `[runtime-jobs-v2-sse-grace:no-immediate-teardown] after sub subscribeCount=${engineStub.subscribeCount()} unsubscribeCount=${engineStub.unsubscribeCount()}`,
    );

    try {
      expect(engineStub.subscribeCount()).toBe(1);
      expect(engineStub.unsubscribeCount()).toBe(0);

      handle.unsubscribe();
      console.info(
        `[runtime-jobs-v2-sse-grace:no-immediate-teardown] post-unsubscribe unsubscribeCount=${engineStub.unsubscribeCount()} (expect 0 — deferred by grace)`,
      );

      // Pre-fix this would have been 1 — engine.subscribe-unsubscribe ran
      // synchronously on disconnect. Post-fix the unsubscribe is deferred
      // by the grace window, so the disposer hasn't fired yet.
      expect(engineStub.unsubscribeCount()).toBe(0);
    } catch (err) {
      dumpGraceSnapshot("no-immediate-teardown-failure", {
        engineStub,
        sinks: [{ name: "main", ...sink }],
      });
      throw err;
    }
  });

  it("a reconnect inside the grace window CANCELS the pending teardown and reuses the existing engineV2 subscription", () => {
    console.info(
      `[runtime-jobs-v2-sse-grace:reconnect-cancels-teardown] sub A → unsub → advance 15s → sub B (reconnect)`,
    );
    const engineStub = stubEngine([sampleJob()]);
    const handler = buildHandler(engineStub, 30_000);

    const sinkA = captureSse();
    const handleA = handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sinkA.envelope.write,
      close: sinkA.envelope.close,
    });
    console.info(
      `[runtime-jobs-v2-sse-grace:reconnect-cancels-teardown] after subA subscribeCount=${engineStub.subscribeCount()}`,
    );

    const sinkB = captureSse();
    try {
      expect(engineStub.subscribeCount()).toBe(1);

      // Disconnect → schedules teardown 30s out.
      handleA.unsubscribe();
      console.info(
        `[runtime-jobs-v2-sse-grace:reconnect-cancels-teardown] post-unsubA unsubscribeCount=${engineStub.unsubscribeCount()}`,
      );
      expect(engineStub.unsubscribeCount()).toBe(0);

      // Advance partway through the grace window.
      vi.advanceTimersByTime(15_000);
      console.info(
        `[runtime-jobs-v2-sse-grace:reconnect-cancels-teardown] after +15000ms unsubscribeCount=${engineStub.unsubscribeCount()}`,
      );
      expect(engineStub.unsubscribeCount()).toBe(0);

      // Reconnect — should cancel the pending teardown AND reuse the existing
      // engine.subscribe (count must still be 1).
      handler.handleSseSubscribe({
        lastEventId: 0,
        scopes: ALL_APPS,
        write: sinkB.envelope.write,
        close: sinkB.envelope.close,
      });
      console.info(
        `[runtime-jobs-v2-sse-grace:reconnect-cancels-teardown] after subB (reconnect) subscribeCount=${engineStub.subscribeCount()}`,
      );
      expect(engineStub.subscribeCount()).toBe(1);

      // Run out the entire would-be grace window from the first disconnect —
      // the cancelled timer should not fire.
      vi.advanceTimersByTime(60_000);
      console.info(
        `[runtime-jobs-v2-sse-grace:reconnect-cancels-teardown] after +60000ms unsubscribeCount=${engineStub.unsubscribeCount()} (expect 0)`,
      );
      expect(engineStub.unsubscribeCount()).toBe(0);

      // And the new connection still receives live events through the shared
      // fanout (proves the timer didn't accidentally detach mid-flight).
      const baselineB = sinkB.frames.length;
      engineStub.emit({
        eventId: 200,
        jobId: "post-reconnect",
        event: "runtime.jobs.created",
        payload: {
          jobId: "post-reconnect",
          job: sampleJob({ jobId: "post-reconnect" }),
        },
        createdAt: "2026-05-01T00:00:01.000Z",
      });
      console.info(
        `[runtime-jobs-v2-sse-grace:reconnect-cancels-teardown] after post-reconnect emit B.framesLen=${sinkB.frames.length} (baseline ${baselineB})`,
      );
      expect(sinkB.frames.length).toBe(baselineB + 1);
    } catch (err) {
      dumpGraceSnapshot("reconnect-cancels-teardown-failure", {
        engineStub,
        sinks: [
          { name: "A", ...sinkA },
          { name: "B", ...sinkB },
        ],
      });
      throw err;
    }
  });

  it("when the grace window elapses with no reconnect, the shared engineV2 subscription IS torn down", () => {
    console.info(
      `[runtime-jobs-v2-sse-grace:grace-elapses-tears-down] sub → unsub → advance 29999ms (just before) then +2ms (cross boundary)`,
    );
    const engineStub = stubEngine([sampleJob()]);
    const handler = buildHandler(engineStub, 30_000);

    const sink = captureSse();
    const handle = handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    handle.unsubscribe();
    console.info(
      `[runtime-jobs-v2-sse-grace:grace-elapses-tears-down] post-unsub unsubscribeCount=${engineStub.unsubscribeCount()}`,
    );

    try {
      // Just before the timer fires — still attached.
      vi.advanceTimersByTime(29_999);
      console.info(
        `[runtime-jobs-v2-sse-grace:grace-elapses-tears-down] after +29999ms unsubscribeCount=${engineStub.unsubscribeCount()} (expect 0)`,
      );
      expect(engineStub.unsubscribeCount()).toBe(0);

      // Cross the boundary — engine.subscribe's disposer must fire exactly once.
      vi.advanceTimersByTime(2);
      console.info(
        `[runtime-jobs-v2-sse-grace:grace-elapses-tears-down] after +2ms (total 30001ms) unsubscribeCount=${engineStub.unsubscribeCount()} (expect 1)`,
      );
      expect(engineStub.unsubscribeCount()).toBe(1);
    } catch (err) {
      dumpGraceSnapshot("grace-elapses-tears-down-failure", {
        engineStub,
        sinks: [{ name: "main", ...sink }],
      });
      throw err;
    }
  });

  it("a fresh subscribe AFTER the grace-window teardown re-attaches a new shared engineV2 subscription", () => {
    console.info(
      `[runtime-jobs-v2-sse-grace:fresh-subscribe-after-teardown] sub A → unsub → advance 31s → sub B (expects subscribeCount=2)`,
    );
    const engineStub = stubEngine([sampleJob()]);
    const handler = buildHandler(engineStub, 30_000);

    const sinkA = captureSse();
    const handleA = handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sinkA.envelope.write,
      close: sinkA.envelope.close,
    });
    handleA.unsubscribe();
    vi.advanceTimersByTime(31_000);
    console.info(
      `[runtime-jobs-v2-sse-grace:fresh-subscribe-after-teardown] after +31000ms unsubscribeCount=${engineStub.unsubscribeCount()}`,
    );

    const sinkB = captureSse();
    try {
      expect(engineStub.unsubscribeCount()).toBe(1);

      // New SSE client arrives long after the teardown — fresh engine.subscribe.
      handler.handleSseSubscribe({
        lastEventId: 0,
        scopes: ALL_APPS,
        write: sinkB.envelope.write,
        close: sinkB.envelope.close,
      });
      console.info(
        `[runtime-jobs-v2-sse-grace:fresh-subscribe-after-teardown] after subB subscribeCount=${engineStub.subscribeCount()}`,
      );
      expect(engineStub.subscribeCount()).toBe(2);
    } catch (err) {
      dumpGraceSnapshot("fresh-subscribe-after-teardown-failure", {
        engineStub,
        sinks: [
          { name: "A", ...sinkA },
          { name: "B", ...sinkB },
        ],
      });
      throw err;
    }
  });

  it("with `sseTeardownGraceMs: 0`, refcount→0 tears down immediately (opt-in tests / suites that want the legacy timing)", () => {
    console.info(
      `[runtime-jobs-v2-sse-grace:zero-grace-immediate-teardown] sub → unsub; grace=0 → expect immediate teardown`,
    );
    const engineStub = stubEngine([sampleJob()]);
    const handler = buildHandler(engineStub, 0);

    const sink = captureSse();
    const handle = handler.handleSseSubscribe({
      lastEventId: 0,
      scopes: ALL_APPS,
      write: sink.envelope.write,
      close: sink.envelope.close,
    });
    console.info(
      `[runtime-jobs-v2-sse-grace:zero-grace-immediate-teardown] after sub subscribeCount=${engineStub.subscribeCount()}`,
    );

    try {
      expect(engineStub.subscribeCount()).toBe(1);

      handle.unsubscribe();
      console.info(
        `[runtime-jobs-v2-sse-grace:zero-grace-immediate-teardown] post-unsubscribe unsubscribeCount=${engineStub.unsubscribeCount()} (expect 1)`,
      );
      // No grace — teardown is synchronous.
      expect(engineStub.unsubscribeCount()).toBe(1);
    } catch (err) {
      dumpGraceSnapshot("zero-grace-immediate-teardown-failure", {
        engineStub,
        sinks: [{ name: "main", ...sink }],
      });
      throw err;
    }
  });
});
