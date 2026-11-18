import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSqliteRuntimeJobsStore,
  type SqliteRuntimeJobsStore,
} from "../src/core/jobs/sqliteStore";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ts = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps step rows + runnable result on assertion failure.
// Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpStepStoreSnapshot = (
  label: string,
  ctx: {
    steps?: StoredStepRecord[];
    runnable?: StoredStepRecord[];
    updated?: StoredStepRecord | null;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [jobs-step-store:${label}] snapshot ===`);
    if (ctx.steps) {
      const compact = ctx.steps.map((s) => ({
        stepId: s.stepId,
        ordinal: s.ordinal,
        status: s.status,
        progressPct: s.progressPct,
        dependsOn: s.dependsOn,
      }));
      console.error(`steps(${compact.length})=\n${JSON.stringify(compact, null, 2)}`);
    }
    if (ctx.runnable) {
      console.error(`runnableIds=${JSON.stringify(ctx.runnable.map((s) => s.stepId))}`);
    }
    if (ctx.updated !== undefined) {
      console.error(`updated=\n${JSON.stringify(ctx.updated, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const baseJob = (jobId: string): IngestJobRecord => ({
  jobId,
  app: "badger",
  kind: "source",
  lane: "source",
  status: "running",
  stageCode: "",
  stageLabel: "",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: {},
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
});

const baseStep = (
  stepId: string,
  ordinal: number,
  dependsOn: string[] = [],
  status: StoredStepRecord["status"] = "queued"
): StoredStepRecord => ({
  stepId,
  jobId: "job1",
  ordinal,
  kind: stepId,
  status,
  progressPct: 0,
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
  app: "badger",
  lane: "source",
  dependsOn,
  payload: {},
  outputs: {},
  createdAt: ts,
  updatedAt: ts,
});

describe("createStepStore (via sqliteStore)", () => {
  let store: SqliteRuntimeJobsStore;

  beforeEach(() => {
    console.info(`[jobs-step-store:setup] creating :memory: store + seeding parent job1`);
    store = createSqliteRuntimeJobsStore(":memory:");
    // FK requires the parent job to exist
    store.upsertJob(baseJob("job1"));
  });

  afterEach(() => {
    console.info(`[jobs-step-store:teardown] closing store`);
    store.close();
  });

  it("upserts steps and retrieves them ordered by ordinal", () => {
    console.info(`[jobs-step-store:order-by-ordinal] inserting c,a,b in non-monotonic order`);
    store.steps.upsertStep(baseStep("c", 3));
    store.steps.upsertStep(baseStep("a", 1));
    store.steps.upsertStep(baseStep("b", 2));

    const out = store.steps.getSteps("job1");
    console.info(`[jobs-step-store:order-by-ordinal] returnedIds=${JSON.stringify(out.map((s) => s.stepId))}`);
    try {
      expect(out.map((s) => s.stepId)).toEqual(["a", "b", "c"]);
    } catch (err) {
      dumpStepStoreSnapshot("order-by-ordinal-failure", { steps: out });
      throw err;
    }
  });

  it("upsertStep is idempotent — second upsert updates the row", () => {
    console.info(`[jobs-step-store:idempotent-upsert] first then second upsert with progressPct=75`);
    store.steps.upsertStep(baseStep("a", 1));
    store.steps.upsertStep({ ...baseStep("a", 1), progressPct: 75 });

    const all = store.steps.getSteps("job1");
    console.info(`[jobs-step-store:idempotent-upsert] rowCount=${all.length} firstProgressPct=${all[0]?.progressPct}`);
    try {
      expect(all).toHaveLength(1);
      expect(all[0].progressPct).toBe(75);
    } catch (err) {
      dumpStepStoreSnapshot("idempotent-upsert-failure", { steps: all });
      throw err;
    }
  });

  it("updateStepStatus updates progress and timestamps", () => {
    console.info(`[jobs-step-store:update-status] upserting a then marking succeeded`);
    store.steps.upsertStep(baseStep("a", 1));
    const updated = store.steps.updateStepStatus("a", "succeeded", {
      progressPct: 100,
      finishedAt: "2026-01-02T00:00:00.000Z",
    });
    console.info(`[jobs-step-store:update-status] updated.status=${updated?.status} progressPct=${updated?.progressPct} finishedAt=${updated?.finishedAt}`);
    try {
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("succeeded");
      expect(updated!.progressPct).toBe(100);
      expect(updated!.finishedAt).toBe("2026-01-02T00:00:00.000Z");
    } catch (err) {
      dumpStepStoreSnapshot("update-status-failure", {
        steps: store.steps.getSteps("job1"),
        updated,
      });
      throw err;
    }
  });

  it("updateStepStatus returns null for missing step", () => {
    console.info(`[jobs-step-store:update-missing] updating non-existent step 'ghost'`);
    const result = store.steps.updateStepStatus("ghost", "running");
    try {
      expect(result).toBeNull();
    } catch (err) {
      dumpStepStoreSnapshot("update-missing-failure", { updated: result });
      throw err;
    }
  });

  it("findRunnableSteps returns steps with no deps when queued", () => {
    console.info(`[jobs-step-store:runnable-no-deps] a(no deps), b(deps a) → only a runnable`);
    store.steps.upsertStep(baseStep("a", 1, []));
    store.steps.upsertStep(baseStep("b", 2, ["a"]));

    const runnable = store.steps.findRunnableSteps("job1");
    console.info(`[jobs-step-store:runnable-no-deps] runnableIds=${JSON.stringify(runnable.map((s) => s.stepId))}`);
    try {
      expect(runnable.map((s) => s.stepId)).toEqual(["a"]);
    } catch (err) {
      dumpStepStoreSnapshot("runnable-no-deps-failure", {
        steps: store.steps.getSteps("job1"),
        runnable,
      });
      throw err;
    }
  });

  it("findRunnableSteps gates on dependency satisfaction", () => {
    console.info(`[jobs-step-store:gates-on-deps] a, b(deps a), c(deps a); marking a succeeded should unblock b+c`);
    // a queued, b depends on a (queued), c depends on a (queued)
    store.steps.upsertStep(baseStep("a", 1, []));
    store.steps.upsertStep(baseStep("b", 2, ["a"]));
    store.steps.upsertStep(baseStep("c", 3, ["a"]));

    const before = store.steps.findRunnableSteps("job1").map((s) => s.stepId);
    console.info(`[jobs-step-store:gates-on-deps] before runnable=${JSON.stringify(before)}`);

    // Mark a succeeded → b and c become runnable
    store.steps.updateStepStatus("a", "succeeded");
    const after = store.steps.findRunnableSteps("job1").map((s) => s.stepId).sort();
    console.info(`[jobs-step-store:gates-on-deps] after runnable=${JSON.stringify(after)}`);
    try {
      expect(before).toEqual(["a"]);
      expect(after).toEqual(["b", "c"]);
    } catch (err) {
      dumpStepStoreSnapshot("gates-on-deps-failure", {
        steps: store.steps.getSteps("job1"),
        runnable: store.steps.findRunnableSteps("job1"),
      });
      throw err;
    }
  });

  it("requires ALL dependencies to be succeeded (not just some)", () => {
    console.info(`[jobs-step-store:all-deps-required] a(succeeded), b(running), c(deps a,b) → c not runnable until b succeeds`);
    store.steps.upsertStep(baseStep("a", 1, [], "succeeded"));
    store.steps.upsertStep(baseStep("b", 2, [], "running"));
    store.steps.upsertStep(baseStep("c", 3, ["a", "b"]));

    const beforeBSucceeds = store.steps.findRunnableSteps("job1").map((s) => s.stepId);
    console.info(`[jobs-step-store:all-deps-required] before runnable=${JSON.stringify(beforeBSucceeds)}`);

    store.steps.updateStepStatus("b", "succeeded");
    const afterBSucceeds = store.steps.findRunnableSteps("job1").map((s) => s.stepId);
    console.info(`[jobs-step-store:all-deps-required] after runnable=${JSON.stringify(afterBSucceeds)}`);
    try {
      expect(beforeBSucceeds).toEqual([]);
      expect(afterBSucceeds).toEqual(["c"]);
    } catch (err) {
      dumpStepStoreSnapshot("all-deps-required-failure", {
        steps: store.steps.getSteps("job1"),
        runnable: store.steps.findRunnableSteps("job1"),
      });
      throw err;
    }
  });

  it("excludes already-running and terminal steps from the runnable set", () => {
    console.info(`[jobs-step-store:exclude-running-terminal] a(running), b(succeeded), c(queued) → only c`);
    store.steps.upsertStep(baseStep("a", 1, [], "running"));
    store.steps.upsertStep(baseStep("b", 2, [], "succeeded"));
    store.steps.upsertStep(baseStep("c", 3, [], "queued"));
    const runnable = store.steps.findRunnableSteps("job1");
    console.info(`[jobs-step-store:exclude-running-terminal] runnableIds=${JSON.stringify(runnable.map((s) => s.stepId))}`);
    try {
      expect(runnable.map((s) => s.stepId)).toEqual(["c"]);
    } catch (err) {
      dumpStepStoreSnapshot("exclude-running-terminal-failure", {
        steps: store.steps.getSteps("job1"),
        runnable,
      });
      throw err;
    }
  });
});
