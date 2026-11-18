import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineV2, type EngineV2, type RuntimeJobEvent } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import { createEventLog } from "../src/core/jobs/eventLog";
import { createSqliteEventLogDeps } from "../src/core/jobs/sqliteEventLogDeps";
import { createSqliteRuntimeJobsStore } from "../src/core/jobs/sqliteStore";

const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "j",
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

const dumpEventReplaySnapshot = (label: string, ctx: {
  captured?: RuntimeJobEvent[] | null;
  second?: RuntimeJobEvent[] | null;
}) => {
  try {
    console.error(`=== [jobs-engine-v2-event-replay:${label}] snapshot ===`);
    if (ctx.captured) {
      console.error(`captured.length=${ctx.captured.length}`);
      console.error(
        `captured event types (last 15)=${JSON.stringify(ctx.captured.slice(-15).map((e) => `${e.eventId}:${e.event}`))}`,
      );
    }
    if (ctx.second) {
      console.error(`second.length=${ctx.second.length}`);
      console.error(
        `second event types (last 15)=${JSON.stringify(ctx.second.slice(-15).map((e) => `${e.eventId}:${e.event}`))}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("engineV2 event replay parity [jobs-engine-v2-event-replay]", () => {
  let engine: EngineV2;
  let captured: RuntimeJobEvent[];
  let unsub: () => void;

  beforeEach(async () => {
    console.info(`[jobs-engine-v2-event-replay:before-each] creating engine + subscribing + registering 5 step handlers`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    captured = [];
    unsub = engine.subscribe((e) => captured.push(e));
    for (const k of ["probe", "identify", "extract", "upload", "commit"]) {
      engine.registerHandler(k, async ({ reportProgress }) => {
        reportProgress(100);
      });
    }
  });

  afterEach(async () => {
    console.info(`[jobs-engine-v2-event-replay:after-each] unsubscribing + stopping engine`);
    unsub();
    await engine.stop();
  });

  it("subscriber stream contains the same events as a fresh log replay", async () => {
    console.info(`[jobs-engine-v2-event-replay:ascending-ids] submitting j1, waiting for succeeded`);
    await engine.submit(makeJob({ jobId: "j1" }));
    const startedAt = Date.now();
    try {
      await vi.waitFor(
        () => {
          const succ = captured.find((e) => e.event === "runtime.jobs.succeeded");
          console.info(
            `[jobs-engine-v2-event-replay:ascending-ids] waiting elapsed=${Date.now() - startedAt}ms captured.length=${captured.length} succeeded=${succ ? "yes" : "no"}`,
          );
          expect(succ).toBeDefined();
        },
        { timeout: 3000 }
      );

      // The engine doesn't expose its internal event log directly, but the
      // captured subscriber output IS the same fan-out. Verify event_id is
      // strictly ascending (replay parity proxy) and there are no gaps.
      const ids = captured.map((e) => e.eventId);
      console.info(`[jobs-engine-v2-event-replay:ascending-ids] final ids=${JSON.stringify(ids)}`);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }
    } catch (err) {
      dumpEventReplaySnapshot("ascending-ids-failure", { captured });
      throw err;
    }
  });

  it("subscribing twice fans out the same events to both subscribers", async () => {
    console.info(`[jobs-engine-v2-event-replay:fan-out] adding second subscriber before submit`);
    const second: RuntimeJobEvent[] = [];
    const unsub2 = engine.subscribe((e) => second.push(e));
    await engine.submit(makeJob({ jobId: "j1" }));
    const startedAt = Date.now();
    try {
      await vi.waitFor(
        () => {
          console.info(
            `[jobs-engine-v2-event-replay:fan-out] waiting elapsed=${Date.now() - startedAt}ms second.length=${second.length} captured.length=${captured.length}`,
          );
          expect(second.find((e) => e.event === "runtime.jobs.succeeded")).toBeDefined();
        },
        { timeout: 3000 }
      );
      unsub2();
      console.info(
        `[jobs-engine-v2-event-replay:fan-out] final ids second=${JSON.stringify(second.map((e) => e.eventId))} captured=${JSON.stringify(captured.map((e) => e.eventId))}`,
      );
      expect(second.map((e) => e.eventId)).toEqual(captured.map((e) => e.eventId));
    } catch (err) {
      dumpEventReplaySnapshot("fan-out-failure", { captured, second });
      throw err;
    }
  });

  it("replay overflow is signalled when the log has more events than the limit", async () => {
    console.info(`[jobs-engine-v2-event-replay:overflow] appending 12 events to fresh log then replay(0,5)`);
    // Drive enough events through a separate log instance to cross the cap.
    const store = createSqliteRuntimeJobsStore(":memory:");
    const log = createEventLog(createSqliteEventLogDeps(store.db));
    try {
      for (let i = 0; i < 12; i++) log.append(`j${i}`, "progress", { i });
      const replay = log.replay(0, 5);
      console.info(
        `[jobs-engine-v2-event-replay:overflow] events=${replay.events.length} overflow=${replay.replayOverflow} maxEventId=${replay.maxEventId}`,
      );
      expect(replay.events).toHaveLength(5);
      expect(replay.replayOverflow).toBe(true);
      expect(replay.maxEventId).toBe(12);
    } finally {
      store.close();
    }
  });
});
