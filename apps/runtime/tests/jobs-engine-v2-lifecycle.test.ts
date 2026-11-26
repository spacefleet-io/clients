import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineV2, type EngineV2, type RuntimeJobEvent } from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
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
  createdAt: ts,
  updatedAt: ts,
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

const allStepKinds = ["probe", "identify", "extract", "upload", "commit"];

const dumpLifecycleSnapshot = (label: string, ctx: {
  events?: RuntimeJobEvent[] | null;
  got?: Awaited<ReturnType<EngineV2["get"]>> | null;
  listed?: Awaited<ReturnType<EngineV2["list"]>> | null;
}) => {
  try {
    console.error(`=== [jobs-engine-v2-lifecycle:${label}] snapshot ===`);
    if (ctx.events) {
      console.error(`events.length=${ctx.events.length}`);
      console.error(
        `event types=${JSON.stringify(ctx.events.map((e) => `${e.jobId}:${e.event}`))}`,
      );
    }
    if (ctx.got) {
      console.error(`get() job status=${ctx.got.job.status} steps=${JSON.stringify(ctx.got.steps.map((s) => `${s.kind}:${s.status}`))}`);
    }
    if (ctx.listed) {
      console.error(`list() jobs=${JSON.stringify(ctx.listed.jobs.map((j) => j.jobId))} maxEventId=${ctx.listed.maxEventId}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("engineV2 lifecycle [jobs-engine-v2-lifecycle]", () => {
  let engine: EngineV2;
  let events: RuntimeJobEvent[];
  let unsub: () => void;

  beforeEach(async () => {
    console.info(`[jobs-engine-v2-lifecycle:before-each] creating engine + subscribing + registering ${allStepKinds.length} step handlers`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));
    // Register a trivial succeeding handler for every step kind.
    for (const kind of allStepKinds) {
      engine.registerHandler(kind, async ({ reportProgress }) => {
        reportProgress(50);
        reportProgress(100);
      });
    }
  });

  afterEach(async () => {
    console.info(`[jobs-engine-v2-lifecycle:after-each] unsubscribing + stopping engine`);
    unsub();
    await engine.stop();
  });

  it("emits created → started → progress → succeeded events for a single source job", async () => {
    console.info(`[jobs-engine-v2-lifecycle:event-sequence] submitting src1 — waiting for runtime.jobs.succeeded`);
    await engine.submit(makeJob());
    const startedAt = Date.now();

    try {
      // Wait for the job to settle (queued → running across 5 steps → succeeded).
      await vi.waitFor(
        () => {
          const succeeded = events.find(
            (e) => e.event === "runtime.jobs.succeeded" && e.jobId === "src1"
          );
          console.info(
            `[jobs-engine-v2-lifecycle:event-sequence] waiting elapsed=${Date.now() - startedAt}ms events.length=${events.length} succeeded=${succeeded ? "yes" : "no"}`,
          );
          expect(succeeded).toBeDefined();
        },
        { timeout: 3000 }
      );

      const types = events.filter((e) => e.jobId === "src1").map((e) => e.event);
      console.info(`[jobs-engine-v2-lifecycle:event-sequence] final types=${JSON.stringify(types)}`);
      expect(types[0]).toBe("runtime.jobs.created");
      expect(types).toContain("runtime.jobs.started");
      expect(types).toContain("runtime.jobs.progress");
      expect(types[types.length - 1]).toBe("runtime.jobs.succeeded");
    } catch (err) {
      dumpLifecycleSnapshot("event-sequence-failure", { events });
      throw err;
    }
  });

  it("get(jobId) returns the job and all 5 source steps with terminal status after run", async () => {
    console.info(`[jobs-engine-v2-lifecycle:get-steps] submitting src1, then awaiting succeeded`);
    await engine.submit(makeJob());
    const startedAt = Date.now();
    let got: Awaited<ReturnType<EngineV2["get"]>> | null = null;
    try {
      await vi.waitFor(
        () => {
          const succ = events.find((e) => e.event === "runtime.jobs.succeeded");
          console.info(
            `[jobs-engine-v2-lifecycle:get-steps] waiting elapsed=${Date.now() - startedAt}ms events.length=${events.length} succeeded=${succ ? "yes" : "no"}`,
          );
          expect(succ).toBeDefined();
        },
        { timeout: 3000 }
      );

      got = await engine.get("src1");
      console.info(
        `[jobs-engine-v2-lifecycle:get-steps] status=${got?.job.status} stepCount=${got?.steps.length} stepStatuses=${JSON.stringify(got?.steps.map((s) => s.status))}`,
      );
      expect(got).not.toBeNull();
      expect(got!.job.status).toBe("succeeded");
      expect(got!.steps).toHaveLength(5);
      expect(got!.steps.every((s) => s.status === "succeeded")).toBe(true);
      expect(got!.steps.map((s) => s.kind)).toEqual(allStepKinds);
    } catch (err) {
      dumpLifecycleSnapshot("get-steps-failure", { events, got });
      throw err;
    }
  });

  it("list() returns submitted jobs and reflects maxEventId", async () => {
    console.info(`[jobs-engine-v2-lifecycle:list] submitting a + b, then listing`);
    await engine.submit(makeJob({ jobId: "a" }));
    await engine.submit(makeJob({ jobId: "b" }));

    const listed = await engine.list();
    console.info(
      `[jobs-engine-v2-lifecycle:list] listed=${JSON.stringify(listed.jobs.map((j) => j.jobId))} maxEventId=${listed.maxEventId}`,
    );
    try {
      expect(listed.jobs.map((j) => j.jobId).sort()).toEqual(["a", "b"]);
      expect(listed.maxEventId).toBeGreaterThan(0);
    } catch (err) {
      dumpLifecycleSnapshot("list-failure", { events, listed });
      throw err;
    }
  });
});
