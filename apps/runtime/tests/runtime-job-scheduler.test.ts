import { describe, expect, it } from "vitest";
import { RuntimeJobsStore } from "../src/core/jobs/store";
import { RuntimeJobEngine } from "../src/core/jobs/engine";
import { getDefaultRuntimeSchedulerPolicy, listNextRunnableRuntimeJobs } from "../src/core/jobs/scheduler";
import type { RuntimeJobRecord } from "@space/runtime-jobs";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps scheduler input/output (job list summary,
// selected dispatch ids, policy) on assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpSchedulerSnapshot = (
  label: string,
  ctx: {
    jobs?: RuntimeJobRecord[];
    selectedIds?: string[];
    policy?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [job-scheduler:${label}] snapshot ===`);
    if (ctx.jobs) {
      const dump = ctx.jobs.map((j) => ({
        jobId: j.jobId,
        lane: j.lane,
        status: j.status,
        priority: j.priority,
        resourceClaims: (j as { resourceClaims?: unknown }).resourceClaims,
        createdAt: j.createdAt,
      }));
      console.error(`jobs(${dump.length})=\n${JSON.stringify(dump, null, 2)}`);
    }
    if (ctx.selectedIds) {
      console.error(`selectedIds=${JSON.stringify(ctx.selectedIds)}`);
    }
    if (ctx.policy !== undefined) {
      console.error(`policy=\n${JSON.stringify(ctx.policy, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

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
  resourceClaims: overrides.resourceClaims,
  scheduling: overrides.scheduling,
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

describe("runtime job scheduler", () => {
  it("@bugfix @regression-proof keeps cpu-heavy jobs bounded to one runnable encode at a time", () => {
    console.info(`[job-scheduler:cpu-bounded] active cpu running; expect only queued-network runnable`);
    const items = [
      job({ jobId: "active-cpu", status: "running", lane: "cpu", stageCode: "transcoding" }),
      job({ jobId: "queued-cpu-1", lane: "cpu", priority: 10, createdAt: "2026-03-23T12:00:01.000Z" }),
      job({ jobId: "queued-cpu-2", lane: "cpu", priority: 5, createdAt: "2026-03-23T12:00:02.000Z" }),
      job({ jobId: "queued-network", lane: "network", kind: "badger.ingest.upload", priority: 1 }),
    ];

    const selectedIds = listNextRunnableRuntimeJobs({ jobs: items }).map((entry) => entry.jobId);
    console.info(`[job-scheduler:cpu-bounded] selectedIds=${JSON.stringify(selectedIds)}`);
    try {
      expect(selectedIds).toEqual(["queued-network"]);
    } catch (err) {
      dumpSchedulerSnapshot("cpu-bounded-failure", { jobs: items, selectedIds });
      throw err;
    }
  });

  it("@bugfix @regression-proof prefers lane priority first and then job priority within the lane", () => {
    console.info(`[job-scheduler:lane-then-priority] verifying io > network > background ordering`);
    const items = [
      job({ jobId: "background-1", lane: "background", priority: 100 }),
      job({ jobId: "network-1", lane: "network", priority: 1 }),
      job({ jobId: "io-1", lane: "io", priority: 2 }),
      job({ jobId: "io-2", lane: "io", priority: 5, createdAt: "2026-03-23T12:00:01.000Z" }),
    ];

    const selectedIds = listNextRunnableRuntimeJobs({ jobs: items }).map((entry) => entry.jobId);
    console.info(`[job-scheduler:lane-then-priority] selectedIds=${JSON.stringify(selectedIds)}`);
    try {
      expect(selectedIds).toEqual(["io-2", "io-1", "network-1", "background-1"]);
    } catch (err) {
      dumpSchedulerSnapshot("lane-then-priority-failure", { jobs: items, selectedIds });
      throw err;
    }
  });

  it("@bugfix @regression-proof honors explicit resource claims even when lane concurrency would otherwise allow more work", () => {
    console.info(`[job-scheduler:resource-claims] networkHeavy+memoryHeavy budgets cap to 1 extra after network-a`);
    const items = [
      job({ jobId: "network-a", lane: "network", priority: 5, payload: { note: "a" } }),
      {
        ...job({ jobId: "network-b", lane: "network", priority: 4, payload: { note: "b" } }),
        resourceClaims: ["networkHeavy", "memoryHeavy"],
      } as RuntimeJobRecord & { resourceClaims: ["networkHeavy", "memoryHeavy"] },
      {
        ...job({ jobId: "network-c", lane: "network", priority: 3, payload: { note: "c" } }),
        resourceClaims: ["networkHeavy", "memoryHeavy"],
      } as RuntimeJobRecord & { resourceClaims: ["networkHeavy", "memoryHeavy"] },
    ];

    const selectedIds = listNextRunnableRuntimeJobs({ jobs: items }).map((entry) => entry.jobId);
    console.info(`[job-scheduler:resource-claims] selectedIds=${JSON.stringify(selectedIds)}`);
    try {
      expect(selectedIds).toEqual(["network-a", "network-b"]);
    } catch (err) {
      dumpSchedulerSnapshot("resource-claims-failure", { jobs: items, selectedIds });
      throw err;
    }
  });

  it("@bugfix @regression-proof engine dispatch batch reads queued work from the canonical runtime store", () => {
    console.info(`[job-scheduler:engine-dispatch] store seeded with 2 queued + 1 succeeded`);
    const store = new RuntimeJobsStore();
    store.upsertMany([
      job({ jobId: "queued-io", lane: "io", priority: 2 }),
      job({ jobId: "queued-cpu", lane: "cpu", priority: 1 }),
      job({ jobId: "done-1", lane: "io", status: "succeeded", finishedAt: "2026-03-23T12:01:00.000Z" }),
    ]);

    const engine = new RuntimeJobEngine(store, getDefaultRuntimeSchedulerPolicy());
    const selectedIds = engine.getDispatchBatch().map((entry) => entry.jobId);
    console.info(`[job-scheduler:engine-dispatch] dispatchBatch=${JSON.stringify(selectedIds)}`);
    try {
      expect(selectedIds).toEqual(["queued-cpu", "queued-io"]);
    } catch (err) {
      dumpSchedulerSnapshot("engine-dispatch-failure", {
        jobs: store.list(),
        selectedIds,
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof keeps a large mixed batch within the shared machine budget instead of dispatching every queued job", () => {
    console.info(`[job-scheduler:mixed-budget] building 8x3=24 jobs across cpu/io/network lanes`);
    const items: RuntimeJobRecord[] = [];
    for (let index = 0; index < 8; index += 1) {
      items.push(job({ jobId: `cpu-${index}`, lane: "cpu", priority: 100 - index, createdAt: `2026-03-23T12:00:${String(index).padStart(2, "0")}.000Z` }));
      items.push(job({ jobId: `io-${index}`, lane: "io", app: "parrot", kind: "parrot.ingest.local_file", priority: 80 - index, createdAt: `2026-03-23T12:01:${String(index).padStart(2, "0")}.000Z` }));
      items.push(job({ jobId: `network-${index}`, lane: "network", app: "badger", kind: "badger.ingest.upload", priority: 60 - index, createdAt: `2026-03-23T12:02:${String(index).padStart(2, "0")}.000Z` }));
    }

    const selected = listNextRunnableRuntimeJobs({ jobs: items });
    const selectedIds = selected.map((entry) => entry.jobId);
    console.info(`[job-scheduler:mixed-budget] selected=${selected.length} ids=${JSON.stringify(selectedIds)}`);
    try {
      expect(selected).toHaveLength(4);
      expect(selected.filter((entry) => entry.lane === "cpu")).toHaveLength(1);
      expect(selected.filter((entry) => entry.lane === "io")).toHaveLength(2);
      expect(selected.filter((entry) => entry.lane === "network")).toHaveLength(1);
      expect(selectedIds).toEqual(["cpu-0", "io-0", "io-1", "network-0"]);
    } catch (err) {
      dumpSchedulerSnapshot("mixed-budget-failure", { jobs: items, selectedIds });
      throw err;
    }
  });

  it("@bugfix @regression-proof lets a runtime policy override raise the bounded cpu lane for advanced transcode settings", () => {
    console.info(`[job-scheduler:policy-override] 3 cpu jobs; policy raises cpu lane + cpuHeavy to 2`);
    const store = new RuntimeJobsStore();
    store.upsertMany([
      job({
        jobId: "cpu-1",
        lane: "cpu",
        scheduling: {
          submittedOrder: 1,
          collectionKey: "badger:tv:friends",
          mediaOrder: 10001,
          phaseOrder: 0,
          variantOrder: 0,
        },
      }),
      job({
        jobId: "cpu-2",
        lane: "cpu",
        scheduling: {
          submittedOrder: 2,
          collectionKey: "badger:tv:friends",
          mediaOrder: 10002,
          phaseOrder: 0,
          variantOrder: 0,
        },
      }),
      job({
        jobId: "cpu-3",
        lane: "cpu",
        scheduling: {
          submittedOrder: 3,
          collectionKey: "badger:tv:friends",
          mediaOrder: 10003,
          phaseOrder: 0,
          variantOrder: 0,
        },
      }),
    ]);

    const overridePolicy = {
      ...getDefaultRuntimeSchedulerPolicy(),
      laneConcurrency: {
        ...getDefaultRuntimeSchedulerPolicy().laneConcurrency,
        cpu: 2,
      },
      resourceLimits: {
        ...getDefaultRuntimeSchedulerPolicy().resourceLimits,
        cpuHeavy: 2,
      },
    };
    const engine = new RuntimeJobEngine(store, getDefaultRuntimeSchedulerPolicy());
    engine.setPolicyResolver(() => overridePolicy);

    const selectedIds = engine.getDispatchBatch().map((entry) => entry.jobId);
    console.info(`[job-scheduler:policy-override] dispatchBatch=${JSON.stringify(selectedIds)}`);
    try {
      expect(selectedIds).toEqual(["cpu-1", "cpu-2"]);
    } catch (err) {
      dumpSchedulerSnapshot("policy-override-failure", {
        jobs: store.list(),
        selectedIds,
        policy: overridePolicy,
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof derives lower default runtime budgets on weaker hosts before any app-specific override is applied", () => {
    console.info(`[job-scheduler:weak-host] deriving default policy for 2 cores / 4 GiB host`);
    const policy = getDefaultRuntimeSchedulerPolicy({
      logicalCpuCount: 2,
      totalMemoryGiB: 4,
    });
    console.info(`[job-scheduler:weak-host] maxConcurrentJobs=${policy.maxConcurrentJobs} cpu-lane=${policy.laneConcurrency.cpu}`);
    try {
      expect(policy).toMatchObject({
        maxConcurrentJobs: 2,
        laneConcurrency: {
          interactive: 1,
          cpu: 1,
          io: 1,
          network: 1,
          background: 1,
        },
        resourceLimits: {
          cpuHeavy: 1,
          diskHeavy: 1,
          networkHeavy: 1,
          memoryHeavy: 1,
        },
      });
    } catch (err) {
      dumpSchedulerSnapshot("weak-host-failure", { policy });
      throw err;
    }
  });
});
