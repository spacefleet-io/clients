import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEngineV2, type EngineV2 } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ts = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps engine state (tmp, jobs) on assertion failure.
// Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpRestartRecoverySnapshot = (
  label: string,
  ctx: {
    tmp?: string;
    dbPath?: string;
    jobBefore?: unknown;
    jobAfter?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [restart-recovery:${label}] snapshot ===`);
    if (ctx.tmp) console.error(`tmp=${ctx.tmp}`);
    if (ctx.dbPath) console.error(`dbPath=${ctx.dbPath}`);
    if (ctx.jobBefore !== undefined) {
      console.error(`jobBefore=\n${JSON.stringify(ctx.jobBefore, null, 2)}`);
    }
    if (ctx.jobAfter !== undefined) {
      console.error(`jobAfter=\n${JSON.stringify(ctx.jobAfter, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

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

describe("engineV2 restart recovery", () => {
  let tmp: string;
  let engineA: EngineV2 | null = null;
  let engineB: EngineV2 | null = null;

  afterEach(async () => {
    console.info(`[restart-recovery:teardown] stopping engines + cleaning tmp=${tmp}`);
    if (engineA) await engineA.stop().catch(() => {});
    if (engineB) await engineB.stop().catch(() => {});
    engineA = null;
    engineB = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("requeues interrupted-by-restart rows on boot so they auto-resume (was: marked interrupted)", async () => {
    // Contract update 2026-05-05: hydration now performs a two-step
    // transition for rows left running by a crashed prior process —
    // first stamp `interrupted` (audit + emit cancelled-style event),
    // then immediately requeue to `queued` with errorCode cleared so
    // tick() picks them up. This keeps format children that depend on
    // the source from getting cascade-cancelled by the transient
    // interrupted state. See engine-v2-interrupted-resume.test.ts for
    // the cascade invariant; this test pins the requeue side.
    tmp = mkdtempSync(path.join(tmpdir(), "engineV2-recovery-"));
    const dbPath = path.join(tmp, "jobs.db");
    console.info(`[restart-recovery:requeue-on-boot] tmp=${tmp} dbPath=${dbPath}`);

    engineA = createEngineV2({ dbPath, progressThrottleMs: 0 });
    await engineA.start();

    // Hanging handler: keeps the job in `running` indefinitely.
    engineA.registerHandler("probe", async ({ signal }) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    });
    for (const k of ["identify", "extract", "upload", "commit"]) {
      engineA.registerHandler(k, async () => {});
    }

    console.info(`[restart-recovery:requeue-on-boot] submitting job 'src' to engineA, waiting for running`);
    await engineA.submit(makeJob({ jobId: "src" }));
    await vi.waitFor(
      async () => {
        const got = await engineA!.get("src");
        expect(got!.job.status).toBe("running");
      },
      { timeout: 3000 }
    );

    const jobBefore = (await engineA.get("src"))?.job;
    console.info(`[restart-recovery:requeue-on-boot] before-stop status=${jobBefore?.status} errorCode=${jobBefore?.errorCode}`);
    await engineA.stop();
    engineA = null;

    const { createSqliteRuntimeJobsStore } = await import(
      "../src/core/jobs/sqliteStore"
    );
    const directStore = createSqliteRuntimeJobsStore(dbPath);
    directStore.updateJobStatus("src", "running", { startedAt: ts });
    directStore.close();
    console.info(`[restart-recovery:requeue-on-boot] directly stamped running via sqliteStore; starting engineB`);

    engineB = createEngineV2({ dbPath, progressThrottleMs: 0 });
    // engineB has no registered handlers — tick() will fail dispatch on
    // its first re-pickup, but we only care about the post-hydration
    // state before a new tick can run a handler. Register a hanging
    // handler so the row doesn't transition to `failed` on no-handler.
    engineB.registerHandler("probe", async ({ signal }) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    });
    for (const k of ["identify", "extract", "upload", "commit"]) {
      engineB.registerHandler(k, async () => {});
    }
    await engineB.start();

    const got = await engineB.get("src");
    console.info(`[restart-recovery:requeue-on-boot] after engineB.start status=${got?.job.status} errorCode=${got?.job.errorCode}`);
    try {
      expect(got!.job).toBeDefined();
      // Post-fix: the row is no longer left in `interrupted`. It's either
      // requeued back to `queued` (then tick promotes it to `running`) or
      // already `running` if the tick fired between hydration and our
      // read. Both are acceptable; what's NOT acceptable is `interrupted`.
      expect(got!.job.status).not.toBe("interrupted");
      expect(["queued", "running"]).toContain(got!.job.status);
      // errorCode must be cleared so tick's cascade predicate (which used
      // to match `interrupted`) cannot kill children of this job.
      expect(got!.job.errorCode).toBeNull();
    } catch (err) {
      dumpRestartRecoverySnapshot("requeue-on-boot-failure", {
        tmp,
        dbPath,
        jobBefore,
        jobAfter: got?.job,
      });
      throw err;
    }
  });

  it("does not touch already-terminal jobs on restart", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "engineV2-recovery2-"));
    const dbPath = path.join(tmp, "jobs.db");
    console.info(`[restart-recovery:terminal-preserved] tmp=${tmp} dbPath=${dbPath}`);

    engineA = createEngineV2({ dbPath, progressThrottleMs: 0 });
    await engineA.start();
    for (const k of ["probe", "identify", "extract", "upload", "commit"]) {
      engineA.registerHandler(k, async () => {});
    }
    console.info(`[restart-recovery:terminal-preserved] submitting 'done' job, expecting succeeded`);
    await engineA.submit(makeJob({ jobId: "done" }));
    await vi.waitFor(
      async () => {
        const got = await engineA!.get("done");
        expect(got!.job.status).toBe("succeeded");
      },
      { timeout: 3000 }
    );
    const jobBefore = (await engineA.get("done"))?.job;
    console.info(`[restart-recovery:terminal-preserved] before-stop status=${jobBefore?.status}`);
    await engineA.stop();
    engineA = null;

    engineB = createEngineV2({ dbPath, progressThrottleMs: 0 });
    await engineB.start();
    const got = await engineB.get("done");
    console.info(`[restart-recovery:terminal-preserved] after engineB.start status=${got?.job.status}`);
    try {
      expect(got!.job.status).toBe("succeeded");
    } catch (err) {
      dumpRestartRecoverySnapshot("terminal-preserved-failure", {
        tmp,
        dbPath,
        jobBefore,
        jobAfter: got?.job,
      });
      throw err;
    }
  });
});
