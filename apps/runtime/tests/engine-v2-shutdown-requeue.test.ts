/**
 * @bugfix @regression-proof jobs-stranded-after-graceful-stop (issue #25 P4,
 * ultimate stress run 1791294602218864000: c041 job-stuck ×9, same 9 jobs
 * still queued ~50 min later in the c059/c062/c078 dumps).
 *
 * Symptom: quitting the app (or a guardian SIGTERM) mid-transcode/upload
 * left those jobs "queued" forever. engineV2.stop() aborted the in-flight
 * handlers and the catch path wrote the step `cancelled` — the same record a
 * user cancel produces — while the job itself stayed live. Hydration on the
 * next boot only requeued `running` steps, so findRunnableSteps never
 * surfaced the cancelled step again and tick() skipped the job forever.
 *
 * Fix: stop() aborts with a dedicated shutdown reason; the catch path puts a
 * shutdown-aborted step (and its job) back to `queued`. Hydration also
 * repairs rows stranded by the pre-fix build. A user cancel stays terminal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEngineV2, type EngineV2 } from "../src/core/jobs/engineV2";
import { createSqliteRuntimeJobsStore } from "../src/core/jobs/sqliteStore";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "engine-v2-shutdown-requeue";
const ts = "2026-01-01T00:00:00.000Z";
const STEP_KINDS = ["probe", "identify", "extract", "upload", "commit"] as const;

const makeJob = (jobId: string): IngestJobRecord => ({
  jobId,
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
});

/** Registers instant handlers for every step, except `hangOn` which blocks until aborted. */
const registerHandlers = (engine: EngineV2, hangOn: string | null, calls: string[]) => {
  for (const kind of STEP_KINDS) {
    engine.registerHandler(kind, async ({ signal, job, reportProgress }) => {
      calls.push(`${job.jobId}:${kind}`);
      if (kind !== hangOn) return;
      reportProgress(40, "Transcoding", "transcoding");
      const hung = Promise.withResolvers<void>();
      signal.addEventListener("abort", () =>
        hung.reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      );
      await hung.promise;
    });
  }
};

const dumpDb = (label: string, dbPath: string, jobId: string) => {
  try {
    const s = createSqliteRuntimeJobsStore(dbPath);
    const job = s.getJob(jobId);
    const steps = s.steps.getSteps(jobId).map((st) => `${st.kind}=${st.status}@${st.progressPct}`);
    s.close();
    console.info(
      `[${SUITE}:${label}] db job=${jobId} status=${job?.status} errorCode=${job?.errorCode} cancelRequested=${job?.cancelRequested} steps=[${steps.join(", ")}]`
    );
    return { job, steps };
  } catch (err) {
    console.error(`[${SUITE}:${label}] (db dump failed: ${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
};

describe(`[${SUITE}] graceful stop requeues in-flight work`, () => {
  let tmp = "";
  let engineA: EngineV2 | null = null;
  let engineB: EngineV2 | null = null;

  afterEach(async () => {
    console.info(`[${SUITE}:teardown] stopping engines, tmp=${tmp}`);
    if (engineA) await engineA.stop().catch(() => {});
    if (engineB) await engineB.stop().catch(() => {});
    engineA = null;
    engineB = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const bootA = async (hangOn: string, jobId: string, callsA: string[]) => {
    tmp = mkdtempSync(path.join(tmpdir(), "engineV2-shutdown-"));
    const dbPath = path.join(tmp, "jobs.db");
    console.info(`[${SUITE}] tmp=${tmp} dbPath=${dbPath} hangOn=${hangOn}`);
    engineA = createEngineV2({ dbPath, progressThrottleMs: 0 });
    await engineA.start();
    registerHandlers(engineA, hangOn, callsA);
    await engineA.submit(makeJob(jobId));
    await vi.waitFor(
      () => {
        expect(callsA).toContain(`${jobId}:${hangOn}`);
      },
      { timeout: 3000 }
    );
    console.info(`[${SUITE}] engineA reached '${hangOn}', calls=${JSON.stringify(callsA)}`);
    return dbPath;
  };

  it("stop() mid-step → step + job back to queued, next boot resumes and succeeds", async () => {
    const callsA: string[] = [];
    const dbPath = await bootA("extract", "j-quit", callsA);

    console.info(`[${SUITE}:quit] graceful stop of engineA (app quit / SIGTERM)`);
    await engineA!.stop();
    engineA = null;
    const afterStop = dumpDb("quit:after-stop", dbPath, "j-quit");
    const extractAfterStop = afterStop?.steps.find((s) => s.startsWith("extract="));
    expect(extractAfterStop).toMatch(/^extract=queued/);
    expect(afterStop?.job?.status).toBe("queued");

    const callsB: string[] = [];
    engineB = createEngineV2({ dbPath, progressThrottleMs: 0 });
    registerHandlers(engineB, null, callsB);
    await engineB.start();
    try {
      await vi.waitFor(
        async () => {
          const got = await engineB!.get("j-quit");
          expect(got!.job.status).toBe("succeeded");
        },
        { timeout: 3000 }
      );
    } catch (err) {
      dumpDb("quit:resume-failure", dbPath, "j-quit");
      console.error(`[${SUITE}:quit] engineB calls=${JSON.stringify(callsB)}`);
      throw err;
    }
    console.info(`[${SUITE}:quit] engineB calls=${JSON.stringify(callsB)}`);
    // Resume picks up at the interrupted step — completed steps are not re-run.
    expect(callsB).toEqual(["j-quit:extract", "j-quit:upload", "j-quit:commit"]);
  });

  it("boot repairs a job stranded by the pre-fix build (queued job, cancelled step)", async () => {
    const callsA: string[] = [];
    const dbPath = await bootA("upload", "j-stranded", callsA);
    await engineA!.stop();
    engineA = null;

    // Reproduce the exact on-disk shape from the stress run's runtime_jobs.db:
    // job `queued` (already through one pre-fix hydration), in-flight step
    // `cancelled` with its progress kept.
    const direct = createSqliteRuntimeJobsStore(dbPath);
    const upload = direct.steps.getSteps("j-stranded").find((s) => s.kind === "upload")!;
    direct.steps.updateStepStatus(upload.stepId, "cancelled", {
      progressPct: 1,
      finishedAt: ts,
    });
    direct.updateJobStatus("j-stranded", "queued", { errorCode: null });
    direct.close();
    dumpDb("stranded:seeded", dbPath, "j-stranded");

    const callsB: string[] = [];
    engineB = createEngineV2({ dbPath, progressThrottleMs: 0 });
    registerHandlers(engineB, null, callsB);
    await engineB.start();
    try {
      await vi.waitFor(
        async () => {
          const got = await engineB!.get("j-stranded");
          expect(got!.job.status).toBe("succeeded");
        },
        { timeout: 3000 }
      );
    } catch (err) {
      dumpDb("stranded:resume-failure", dbPath, "j-stranded");
      console.error(`[${SUITE}:stranded] engineB calls=${JSON.stringify(callsB)}`);
      throw err;
    }
    console.info(`[${SUITE}:stranded] engineB calls=${JSON.stringify(callsB)}`);
    expect(callsB).toEqual(["j-stranded:upload", "j-stranded:commit"]);
  });

  it("a user cancel stays terminal across stop + restart (not requeued)", async () => {
    const callsA: string[] = [];
    const dbPath = await bootA("extract", "j-user-cancel", callsA);

    await engineA!.cancel("j-user-cancel", "user");
    await vi.waitFor(
      async () => {
        const got = await engineA!.get("j-user-cancel");
        expect(got!.steps.find((s) => s.kind === "extract")!.status).toBe("cancelled");
      },
      { timeout: 3000 }
    );
    await engineA!.stop();
    engineA = null;
    dumpDb("user-cancel:after-stop", dbPath, "j-user-cancel");

    const callsB: string[] = [];
    engineB = createEngineV2({ dbPath, progressThrottleMs: 0 });
    registerHandlers(engineB, null, callsB);
    // tick() runs synchronously inside start() and handlers record their call
    // before their first await, so a wrongful pickup is already visible here.
    await engineB.start();
    const got = await engineB.get("j-user-cancel");
    dumpDb("user-cancel:after-restart", dbPath, "j-user-cancel");
    console.info(`[${SUITE}:user-cancel] engineB calls=${JSON.stringify(callsB)}`);
    expect(got!.job.status).toBe("cancelled");
    expect(got!.steps.find((s) => s.kind === "extract")!.status).toBe("cancelled");
    expect(callsB).toEqual([]);
  });
});
