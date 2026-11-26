/**
 * @bugfix @regression-proof
 *
 * Pre-fix bug, observed in the 2026-05-04 hands-on round:
 *   - User dragged Orchard. Source job `95209ca6` started, format job
 *     `6bdfa337` queued behind it.
 *   - Runtime hot-restarted mid-source. Hydration marked source as
 *     `interrupted`. Tick saw an "interrupted" parent and cascaded a
 *     parent-cancelled cancel to the format job.
 *   - Source's still-in-flight runner eventually wrote `succeeded` (CAS
 *     race vs the cancellation), but the format job stayed cancelled —
 *     visible to the user as "360p job never starts, shows as
 *     cancelled" even though the source ingest completed.
 *
 * Post-fix:
 *   - tick()'s parent-cancel cascade only triggers on `failed` /
 *     `cancelled` parents, NOT on `interrupted`. Children of an
 *     interrupted parent stay queued.
 *   - Hydration on boot transitions both `running → interrupted` AND
 *     pre-existing `interrupted` rows back to `queued` (with `running`
 *     step rows reset to `queued`), so the engine actually re-dispatches
 *     them rather than leaving them stuck.
 *
 * This test pins both invariants. It is deliberately UNIT-LEVEL
 * (no live runtime) because the live race is non-deterministic; the
 * unit assertions are the durable regression contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRuntimeJobsStore } from "@space/runtime-jobs-engine/sqliteStore";
import { createEngineV2 } from "@space/runtime-jobs-engine/engineV2";
import type {
  IngestJobRecord,
  IngestJobStatus,
} from "@space/runtime-jobs";

let tmpDir: string;
let dbPath: string;

const baseRecord = (now: string) =>
  ({
    app: "badger" as const,
    status: "queued" as IngestJobStatus,
    stageCode: "queued",
    stageLabel: "Queued",
    progress: { mode: "fraction" as const, completed: 0, total: 100, unit: "percent" as const },
    progressPct: 0,
    outputs: {},
    errorCode: null,
    errorMessage: null,
    retryable: false,
    cancelRequested: false,
    dedupeKey: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    dismissedAt: null,
    uploadSpeedBytesPerSec: null,
  });

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps post-hydration job state + step rows on
// assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpInterruptedSnapshot = async (
  label: string,
  ctx: {
    engine?: Awaited<ReturnType<typeof createEngineV2>>;
    jobIds?: string[];
    dbPath?: string;
    stepsForJobId?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [engine-v2-interrupted-resume:${label}] snapshot ===`);
    if (ctx.dbPath) console.error(`dbPath=${ctx.dbPath}`);
    if (ctx.engine && ctx.jobIds) {
      for (const id of ctx.jobIds) {
        const snap = await ctx.engine.get(id).catch((err) => `(get-failed: ${err instanceof Error ? err.message : String(err)})`);
        console.error(`engine.get(${id})=\n${JSON.stringify(snap, null, 2)}`);
      }
    }
    if (ctx.stepsForJobId && ctx.dbPath) {
      try {
        const inspectStore = createSqliteRuntimeJobsStore(ctx.dbPath);
        const steps = inspectStore.steps.getSteps(ctx.stepsForJobId);
        console.error(
          `steps(${ctx.stepsForJobId}) (${steps.length})=\n${JSON.stringify(steps.map((s) => ({ stepId: s.stepId, status: s.status, kind: (s as unknown as { kind?: string }).kind })), null, 2)}`,
        );
        inspectStore.close();
      } catch (stepErr) {
        console.error(`(steps-dump failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)})`);
      }
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engine-v2-interrupted-"));
  dbPath = join(tmpDir, "runtime_jobs.db");
  console.info(`[engine-v2-interrupted-resume:setup] dbPath=${dbPath}`);
});

afterEach(() => {
  console.info(`[engine-v2-interrupted-resume:teardown] rm-rf ${tmpDir}`);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("[@bugfix][@regression-proof] interrupted parent does NOT cascade-cancel children", () => {
  it("queued format child stays queued when its source parent is `interrupted` (not failed)", async () => {
    console.info(`[engine-v2-interrupted-resume:no-cascade] seeding src-1 + fmt-1 with src-1=interrupted`);
    // Seed the DB directly so we can put a parent into `interrupted` without
    // running the full engine lifecycle.
    const seedStore = createSqliteRuntimeJobsStore(dbPath);
    const now = new Date().toISOString();
    const sourceJob: IngestJobRecord = {
      ...baseRecord(now),
      jobId: "src-1",
      kind: "source",
      lane: "source",
      variant: null,
      priority: 0,
      parentJobIds: [],
      groupId: "grp-1",
      mediaId: "grp-1",
      payload: { userId: "u", filename: "/tmp/x.mp4" },
    };
    const formatJob: IngestJobRecord = {
      ...baseRecord(now),
      jobId: "fmt-1",
      kind: "format",
      lane: "format",
      variant: "360p",
      priority: 40,
      parentJobIds: ["src-1"],
      groupId: "grp-1",
      mediaId: "grp-1",
      payload: { userId: "u", filename: "/tmp/x.mp4", variant: "360p", parentSourceJobId: "src-1" },
    };
    seedStore.upsertJob(sourceJob);
    seedStore.upsertJob(formatJob);
    // Force source into `interrupted` (transient state, NOT a permanent
    // failure) — simulating a mid-flight runtime restart.
    seedStore.updateJobStatus("src-1", "interrupted", {
      errorCode: "interrupted-by-restart",
    });
    seedStore.close();

    // Boot the engine against the seeded DB.
    console.info(`[engine-v2-interrupted-resume:no-cascade] booting engine for hydration`);
    const engine = createEngineV2({ dbPath });
    await engine.start();

    try {
      // Critical invariant: format must NOT be cancelled by the cascade.
      // Post-fix, hydration will requeue source (interrupted → queued),
      // and tick() will pick up source. Format's parent is now `queued`
      // (not interrupted), so format stays queued waiting on source.
      const fmt = await engine.get("fmt-1");
      const src = await engine.get("src-1");
      console.info(
        `[engine-v2-interrupted-resume:no-cascade] post-hydration: src.status=${src?.job.status} src.errorCode=${src?.job.errorCode} fmt.status=${fmt?.job.status} fmt.errorCode=${fmt?.job.errorCode}`,
      );
      expect(fmt).not.toBeNull();
      expect(fmt!.job.status).toBe("queued");
      expect(fmt!.job.errorCode).toBeNull();
      expect(fmt!.job.errorMessage).toBeNull();

      // Source itself was requeued by hydration (no longer interrupted).
      expect(src).not.toBeNull();
      expect(["queued", "running"]).toContain(src!.job.status);
    } catch (err) {
      await dumpInterruptedSnapshot("no-cascade-failure", {
        engine,
        jobIds: ["src-1", "fmt-1"],
        dbPath,
      });
      throw err;
    } finally {
      await engine.stop();
    }
  });
});

describe("[@bugfix][@regression-proof] hydration requeues interrupted rows on boot", () => {
  it("a row left in `interrupted` from a prior boot transitions back to `queued`", async () => {
    console.info(`[engine-v2-interrupted-resume:requeue] seeding src-2 in interrupted state`);
    // Seed an interrupted row.
    const seedStore = createSqliteRuntimeJobsStore(dbPath);
    const now = new Date().toISOString();
    const job: IngestJobRecord = {
      ...baseRecord(now),
      jobId: "src-2",
      kind: "source",
      lane: "source",
      variant: null,
      priority: 0,
      parentJobIds: [],
      groupId: "grp-2",
      mediaId: "grp-2",
      payload: { userId: "u", filename: "/tmp/y.mp4" },
    };
    seedStore.upsertJob(job);
    seedStore.updateJobStatus("src-2", "interrupted", {
      errorCode: "interrupted-by-restart",
    });
    seedStore.close();

    // Boot.
    console.info(`[engine-v2-interrupted-resume:requeue] booting engine for hydration`);
    const engine = createEngineV2({ dbPath });
    await engine.start();

    try {
      const after = await engine.get("src-2");
      console.info(
        `[engine-v2-interrupted-resume:requeue] post-hydration: status=${after?.job.status} errorCode=${after?.job.errorCode}`,
      );
      expect(after).not.toBeNull();
      // Hydration cleared errorCode (so the cascade predicate doesn't
      // match) and requeued.
      expect(after!.job.errorCode).toBeNull();
      expect(["queued", "running"]).toContain(after!.job.status);
    } catch (err) {
      await dumpInterruptedSnapshot("requeue-failure", { engine, jobIds: ["src-2"], dbPath });
      throw err;
    } finally {
      await engine.stop();
    }
  });

  it("a `running` step inside an interrupted job is reset to `queued` so findRunnableSteps surfaces it", async () => {
    console.info(`[engine-v2-interrupted-resume:step-reset] booting engine1 to seed src-3 steps via submit`);
    // Use the engine's submit path to seed step rows (steps are seeded
    // by engineV2 when a job is submitted, not by raw store.upsertJob).
    const engine1 = createEngineV2({ dbPath });
    await engine1.start();
    const now = new Date().toISOString();
    const job: IngestJobRecord = {
      ...baseRecord(now),
      jobId: "src-3",
      kind: "source",
      lane: "source",
      variant: null,
      priority: 0,
      parentJobIds: [],
      groupId: "grp-3",
      mediaId: "grp-3",
      payload: { userId: "u", filename: "/tmp/z.mp4" },
    };
    await engine1.submit(job);
    await engine1.stop();

    // Now poke the seeded DB: put one step into `running` and the job
    // into `interrupted` to mimic a mid-flight restart.
    console.info(`[engine-v2-interrupted-resume:step-reset] poking step into running + job into interrupted`);
    const seedStore = createSqliteRuntimeJobsStore(dbPath);
    const stepsBefore = seedStore.steps.getSteps("src-3");
    expect(stepsBefore.length).toBeGreaterThan(0);
    const firstStep = stepsBefore[0]!;
    console.info(`[engine-v2-interrupted-resume:step-reset] stepsBefore.count=${stepsBefore.length} firstStep.stepId=${firstStep.stepId}`);
    seedStore.steps.updateStepStatus(firstStep.stepId, "running", {});
    seedStore.updateJobStatus("src-3", "interrupted", {
      errorCode: "interrupted-by-restart",
    });
    seedStore.close();

    // Boot a second engine instance — hydration runs.
    console.info(`[engine-v2-interrupted-resume:step-reset] booting engine2 for hydration`);
    const engine2 = createEngineV2({ dbPath });
    await engine2.start();

    try {
      const verifyStore = createSqliteRuntimeJobsStore(dbPath);
      const stepsAfter = verifyStore.steps.getSteps("src-3");
      const resetStep = stepsAfter.find((s) => s.stepId === firstStep.stepId);
      console.info(
        `[engine-v2-interrupted-resume:step-reset] stepsAfter.count=${stepsAfter.length} resetStep.status=${resetStep?.status}`,
      );
      expect(resetStep).toBeDefined();
      // Step must NOT still be `running` — hydration should have moved it
      // back to `queued` (or the engine moved it forward; both acceptable).
      expect(resetStep!.status).not.toBe("running");
      verifyStore.close();
    } catch (err) {
      await dumpInterruptedSnapshot("step-reset-failure", {
        engine: engine2,
        jobIds: ["src-3"],
        dbPath,
        stepsForJobId: "src-3",
      });
      throw err;
    } finally {
      await engine2.stop();
    }
  });
});
