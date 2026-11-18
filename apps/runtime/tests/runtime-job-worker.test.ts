import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeJobsStore } from "../src/core/jobs/store";
import { RuntimeJobEngine } from "../src/core/jobs/engine";
import { RuntimeJobWorker } from "../src/core/jobs/worker";
import type { RuntimeJobRecord } from "@space/runtime-jobs";

const job = (overrides: Partial<RuntimeJobRecord>): RuntimeJobRecord => ({
  jobId: overrides.jobId ?? "job-1",
  app: overrides.app ?? "badger",
  kind: overrides.kind ?? "badger.ingest.media_file",
  lane: overrides.lane ?? "cpu",
  status: overrides.status ?? "queued",
  stageCode: overrides.stageCode ?? "queued",
  stageLabel: overrides.stageLabel ?? "Queued",
  progress: overrides.progress ?? { mode: "none", completed: null, total: null, unit: null },
  payload: overrides.payload ?? {},
  outputs: overrides.outputs ?? {},
  errorCode: overrides.errorCode ?? null,
  errorMessage: overrides.errorMessage ?? null,
  retryable: overrides.retryable ?? true,
  attemptCount: overrides.attemptCount ?? 0,
  maxAttempts: overrides.maxAttempts,
  nextAttemptAt: overrides.nextAttemptAt ?? null,
  lastAttemptAt: overrides.lastAttemptAt ?? null,
  cancelRequested: overrides.cancelRequested ?? false,
  priority: overrides.priority ?? 0,
  dedupeKey: overrides.dedupeKey ?? null,
  createdAt: overrides.createdAt ?? "2026-03-23T12:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-03-23T12:00:00.000Z",
  startedAt: overrides.startedAt ?? null,
  finishedAt: overrides.finishedAt ?? null,
});

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps store state + worker progression on assertion
// failure. Wrapped in try/catch so a dump-failure cannot mask the original.
// ---------------------------------------------------------------------------
const dumpWorkerSnapshot = (
  label: string,
  ctx: {
    store?: RuntimeJobsStore;
    expectedJobIds?: string[];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-job-worker:${label}] snapshot ===`);
    if (ctx.store) {
      const all = ctx.store.list({ includeCompleted: true });
      const summarized = all.map((j) => ({
        jobId: j.jobId,
        status: j.status,
        stageCode: j.stageCode,
        lane: j.lane,
        priority: j.priority,
      }));
      console.error(`store.list (${all.length})=\n${JSON.stringify(summarized, null, 2)}`);
      const byStatus: Record<string, number> = {};
      for (const j of all) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
      console.error(`status-counts=${JSON.stringify(byStatus)}`);
      const byLane: Record<string, number> = {};
      for (const j of all) {
        if (j.status === "running") byLane[j.lane] = (byLane[j.lane] ?? 0) + 1;
      }
      console.error(`running-by-lane=${JSON.stringify(byLane)}`);
    }
    if (ctx.expectedJobIds) {
      console.error(`expectedJobIds=${JSON.stringify(ctx.expectedJobIds)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime job worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("@bugfix @regression-proof drains queued jobs after a manual kick", async () => {
    console.info(`[runtime-job-worker:manual-kick] seeding 2 queued jobs + registering handlers`);
    const store = new RuntimeJobsStore();
    store.upsertMany([
      job({ jobId: "queued-1", lane: "io", kind: "parrot.ingest.local_file", app: "parrot" }),
      job({ jobId: "queued-2", lane: "network", kind: "badger.ingest.media_file" }),
    ]);
    const engine = new RuntimeJobEngine(store, undefined, null, () => "2026-03-23T12:01:00.000Z");
    engine.registerHandler("parrot.ingest.local_file", async () => ({
      status: "succeeded",
      stageCode: "done",
      stageLabel: "Done",
    }));
    engine.registerHandler("badger.ingest.media_file", async () => ({
      status: "succeeded",
      stageCode: "done",
      stageLabel: "Done",
    }));
    const worker = new RuntimeJobWorker(engine, { intervalMs: 10_000 });

    try {
      console.info(`[runtime-job-worker:manual-kick] kick() + runAllTimersAsync()`);
      const kicked = worker.kick();
      await vi.runAllTimersAsync();
      const kickResult = await kicked;
      console.info(
        `[runtime-job-worker:manual-kick] kicked=${kickResult} queued-1.status=${store.get("queued-1")?.status} queued-2.status=${store.get("queued-2")?.status}`,
      );
      expect(kickResult).toBe(true);
      expect(store.get("queued-1")?.status).toBe("succeeded");
      expect(store.get("queued-2")?.status).toBe("succeeded");
    } catch (err) {
      dumpWorkerSnapshot("manual-kick-failure", { store, expectedJobIds: ["queued-1", "queued-2"] });
      throw err;
    } finally {
      worker.stop();
    }
  });

  it("@bugfix @regression-proof coalesces overlapping kicks into one active drain", async () => {
    console.info(`[runtime-job-worker:coalesce] seeding 1 job + handler that holds`);
    const store = new RuntimeJobsStore();
    store.upsert(job({ jobId: "queued-1" }));

    let releases = 0;
    let resolveHandler: (() => void) | null = null;
    const engine = new RuntimeJobEngine(store, undefined, null, () => "2026-03-23T12:02:00.000Z");
    engine.registerHandler(
      "badger.ingest.media_file",
      async () =>
        await new Promise((resolve) => {
          releases += 1;
          resolveHandler = () => resolve({ status: "succeeded", stageCode: "done", stageLabel: "Done" });
        })
    );
    const worker = new RuntimeJobWorker(engine, { intervalMs: 10_000 });

    try {
      console.info(`[runtime-job-worker:coalesce] firing two overlapping kicks`);
      const firstKick = worker.kick();
      const secondKick = worker.kick();
      await vi.runAllTimersAsync();
      console.info(`[runtime-job-worker:coalesce] handler releases=${releases} (expect 1)`);
      expect(releases).toBe(1);
      (resolveHandler as (() => void) | null)?.();
      const firstResolved = await firstKick;
      const secondResolved = await secondKick;
      console.info(`[runtime-job-worker:coalesce] firstKick=${firstResolved} secondKick=${secondResolved}`);
      expect(firstResolved).toBe(false);
      expect(secondResolved).toBe(true);
    } catch (err) {
      dumpWorkerSnapshot("coalesce-failure", { store, expectedJobIds: ["queued-1"], extra: { releases } });
      throw err;
    } finally {
      worker.stop();
    }
  });

  it("@bugfix @regression-proof replaces a stale pending drain so later kicks still dispatch queued jobs", async () => {
    console.info(`[runtime-job-worker:stale-drain] seeding queued-stale-1 + custom scheduleDrain`);
    const store = new RuntimeJobsStore();
    store.upsert(job({ jobId: "queued-stale-1" }));

    const pendingRuns = new Map<
      symbol,
      () => void
    >();
    let pendingOrder = 0;
    const clearedHandles: symbol[] = [];
    const engine = new RuntimeJobEngine(store, undefined, null, () => "2026-03-23T12:02:30.000Z");
    engine.registerHandler("badger.ingest.media_file", async () => ({
      status: "succeeded",
      stageCode: "done",
      stageLabel: "Done",
    }));
    const worker = new RuntimeJobWorker(engine, {
      intervalMs: 10_000,
      scheduleDrain: (run) => {
        const handle = Symbol(`pending-${pendingOrder++}`);
        pendingRuns.set(handle, run);
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clearScheduledDrain: (timer) => {
        clearedHandles.push(timer as unknown as symbol);
        pendingRuns.delete(timer as unknown as symbol);
      },
    });

    try {
      console.info(`[runtime-job-worker:stale-drain] firing first + second kicks`);
      const firstKick = worker.kick();
      const secondKickPromise = worker.kick();

      console.info(
        `[runtime-job-worker:stale-drain] clearedHandles.length=${clearedHandles.length} pendingRuns.size=${pendingRuns.size}`,
      );
      expect(clearedHandles).toHaveLength(1);
      expect(pendingRuns.size).toBe(1);

      const [replacementHandle, replacementRun] = [...pendingRuns.entries()][0]!;
      console.info(`[runtime-job-worker:stale-drain] replacementHandle=${String(replacementHandle)}`);
      expect(String(replacementHandle)).toContain("pending-1");
      replacementRun();

      const secondResult = await secondKickPromise;
      console.info(`[runtime-job-worker:stale-drain] secondKick=${secondResult} queued-stale-1.status=${store.get("queued-stale-1")?.status}`);
      expect(secondResult).toBe(true);
      await expect(firstKick).resolves.toBe(false);
      expect(store.get("queued-stale-1")?.status).toBe("succeeded");
    } catch (err) {
      dumpWorkerSnapshot("stale-drain-failure", {
        store,
        expectedJobIds: ["queued-stale-1"],
        extra: { clearedHandles: clearedHandles.length, pendingRuns: pendingRuns.size },
      });
      throw err;
    } finally {
      worker.stop();
    }
  });

  it("@bugfix @regression-proof interval safety-net drains eligible jobs without an explicit kick", async () => {
    console.info(`[runtime-job-worker:interval-safety-net] seeding queued-interval-1 + start()`);
    const store = new RuntimeJobsStore();
    store.upsert(job({ jobId: "queued-interval-1" }));
    const engine = new RuntimeJobEngine(store, undefined, null, () => "2026-03-23T12:03:00.000Z");
    engine.registerHandler("badger.ingest.media_file", async () => ({
      status: "succeeded",
      stageCode: "done",
      stageLabel: "Done",
    }));
    const worker = new RuntimeJobWorker(engine, {
      intervalMs: 250,
      scheduleDrain: (run) => {
        run();
        return setTimeout(() => undefined, 0);
      },
      clearScheduledDrain: (timer) => clearTimeout(timer),
    });
    worker.start();

    try {
      console.info(`[runtime-job-worker:interval-safety-net] advancing timers by 250ms`);
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      console.info(`[runtime-job-worker:interval-safety-net] post-interval: status=${store.get("queued-interval-1")?.status}`);
      expect(store.get("queued-interval-1")?.status).toBe("succeeded");
    } catch (err) {
      dumpWorkerSnapshot("interval-safety-net-failure", { store, expectedJobIds: ["queued-interval-1"] });
      throw err;
    } finally {
      worker.stop();
    }
  });

  it("@bugfix @regression-proof runs the before-drain reconciliation hook before dispatching queued jobs", async () => {
    console.info(`[runtime-job-worker:before-drain] seeding 1 job + beforeDrain spy`);
    const store = new RuntimeJobsStore();
    store.upsert(job({ jobId: "queued-before-drain-1" }));
    const engine = new RuntimeJobEngine(store, undefined, null, () => "2026-03-23T12:03:30.000Z");
    engine.registerHandler("badger.ingest.media_file", async () => ({
      status: "succeeded",
      stageCode: "done",
      stageLabel: "Done",
    }));
    const beforeDrain = vi.fn();
    const worker = new RuntimeJobWorker(engine, {
      intervalMs: 10_000,
      beforeDrain,
    });

    try {
      const kicked = worker.kick();
      await vi.runAllTimersAsync();
      const result = await kicked;
      console.info(
        `[runtime-job-worker:before-drain] kicked=${result} beforeDrain.calls=${beforeDrain.mock.calls.length} status=${store.get("queued-before-drain-1")?.status}`,
      );
      expect(result).toBe(true);
      expect(beforeDrain).toHaveBeenCalledTimes(1);
      expect(store.get("queued-before-drain-1")?.status).toBe("succeeded");
    } catch (err) {
      dumpWorkerSnapshot("before-drain-failure", {
        store,
        expectedJobIds: ["queued-before-drain-1"],
        extra: { beforeDrainCalls: beforeDrain.mock.calls.length },
      });
      throw err;
    } finally {
      worker.stop();
    }
  });

  it("@bugfix @regression-proof leaves excess large-batch work queued once the shared concurrency budget is filled", async () => {
    console.info(`[runtime-job-worker:concurrency-budget] seeding 7 jobs across 3 lanes`);
    const store = new RuntimeJobsStore();
    store.upsertMany([
      job({ jobId: "cpu-1", lane: "cpu", priority: 50, kind: "badger.ingest.media_file" }),
      job({ jobId: "cpu-2", lane: "cpu", priority: 49, kind: "badger.ingest.media_file" }),
      job({ jobId: "io-1", lane: "io", priority: 40, app: "parrot", kind: "parrot.ingest.local_file" }),
      job({ jobId: "io-2", lane: "io", priority: 39, app: "parrot", kind: "parrot.ingest.local_file" }),
      job({ jobId: "io-3", lane: "io", priority: 38, app: "parrot", kind: "parrot.ingest.local_file" }),
      job({ jobId: "network-1", lane: "network", priority: 30, app: "badger", kind: "badger.ingest.upload" }),
      job({ jobId: "network-2", lane: "network", priority: 29, app: "badger", kind: "badger.ingest.upload" }),
    ]);

    const engine = new RuntimeJobEngine(store, undefined, null, () => "2026-03-23T12:05:00.000Z");
    engine.registerHandler("badger.ingest.media_file", async () => ({
      status: "running",
      stageCode: "transcoding",
      stageLabel: "Transcoding",
    }));
    engine.registerHandler("parrot.ingest.local_file", async () => ({
      status: "running",
      stageCode: "uploading",
      stageLabel: "Uploading",
    }));
    engine.registerHandler("badger.ingest.upload", async () => ({
      status: "running",
      stageCode: "uploading",
      stageLabel: "Uploading",
    }));

    const worker = new RuntimeJobWorker(engine, {
      intervalMs: 10_000,
      maxPassesPerDrain: 25,
      scheduleDrain: (run) => {
        run();
        return setTimeout(() => undefined, 0);
      },
      clearScheduledDrain: (timer) => clearTimeout(timer),
    });

    try {
      console.info(`[runtime-job-worker:concurrency-budget] kick() + waiting for budget cap`);
      await worker.kick();

      const running = store.list({ includeCompleted: true }).filter((entry) => entry.status === "running");
      const queued = store.list({ includeCompleted: true }).filter((entry) => entry.status === "queued");
      console.info(
        `[runtime-job-worker:concurrency-budget] running.count=${running.length} cpu=${running.filter((e) => e.lane === "cpu").length} io=${running.filter((e) => e.lane === "io").length} network=${running.filter((e) => e.lane === "network").length} queued=${JSON.stringify(queued.map((e) => e.jobId).sort())}`,
      );
      expect(running).toHaveLength(4);
      expect(running.filter((entry) => entry.lane === "cpu")).toHaveLength(1);
      expect(running.filter((entry) => entry.lane === "io")).toHaveLength(2);
      expect(running.filter((entry) => entry.lane === "network")).toHaveLength(1);
      expect(queued.map((entry) => entry.jobId).sort()).toEqual(["cpu-2", "io-3", "network-2"]);
    } catch (err) {
      dumpWorkerSnapshot("concurrency-budget-failure", {
        store,
        expectedJobIds: ["cpu-1", "cpu-2", "io-1", "io-2", "io-3", "network-1", "network-2"],
      });
      throw err;
    } finally {
      worker.stop();
    }
  });
});
