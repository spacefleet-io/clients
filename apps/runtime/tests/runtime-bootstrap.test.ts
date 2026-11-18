import { mkdtempSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeJobRecord } from "@space/runtime-jobs";
import { runtimeJobsStore } from "../src/core/jobs/store";
import { resetModulesForTests } from "../src/modules";
import { bootstrapRuntimeJobs, runtimeState } from "../src/runtime";

const createJob = (overrides: Partial<RuntimeJobRecord> = {}): RuntimeJobRecord => ({
  jobId: overrides.jobId ?? "badger:ingest:user-1:job-1",
  app: overrides.app ?? "badger",
  kind: overrides.kind ?? "badger.ingest.media_file",
  lane: overrides.lane ?? "cpu",
  status: overrides.status ?? "running",
  stageCode: overrides.stageCode ?? "transcoding",
  stageLabel: overrides.stageLabel ?? "Processing",
  progress: overrides.progress ?? { mode: "indeterminate", completed: null, total: null, unit: null },
  payload: overrides.payload ?? {
    userId: "user-1",
    id: "job-1",
    filename: "/tmp/input.mkv",
    matchedMediaId: "media-1",
    status: "transcoding",
  },
  outputs: overrides.outputs ?? {},
  errorCode: overrides.errorCode ?? null,
  errorMessage: overrides.errorMessage ?? null,
  retryable: overrides.retryable ?? false,
  attemptCount: overrides.attemptCount ?? 0,
  maxAttempts: overrides.maxAttempts,
  nextAttemptAt: overrides.nextAttemptAt ?? null,
  lastAttemptAt: overrides.lastAttemptAt ?? null,
  cancelRequested: overrides.cancelRequested ?? false,
  priority: overrides.priority ?? 0,
  dedupeKey: overrides.dedupeKey ?? null,
  createdAt: overrides.createdAt ?? "2026-03-24T10:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-03-24T10:01:00.000Z",
  startedAt: overrides.startedAt ?? "2026-03-24T10:00:30.000Z",
  finishedAt: overrides.finishedAt ?? null,
});

const dumpBootstrapSnapshot = (label: string, ctx: {
  filePath?: string | null;
  result?: unknown;
  kickWorker?: ReturnType<typeof vi.fn> | null;
  storeJob?: unknown;
}) => {
  try {
    console.error(`=== [runtime-bootstrap:${label}] snapshot ===`);
    console.error(`filePath=${ctx.filePath ?? "<none>"}`);
    if (ctx.result !== undefined) console.error(`result=${JSON.stringify(ctx.result, null, 2)}`);
    if (ctx.kickWorker) console.error(`kickWorker.calls=${ctx.kickWorker.mock.calls.length}`);
    if (ctx.storeJob !== undefined) console.error(`store.get(jobId)=${JSON.stringify(ctx.storeJob, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime bootstrap [runtime-bootstrap]", () => {
  beforeEach(() => {
    console.info(`[runtime-bootstrap:before-each] resetting runtimeState + modules`);
    runtimeState.resetForTests();
    resetModulesForTests();
  });

  it("@bugfix @regression-proof recovers persisted running jobs after the store is loaded, then kicks the worker", () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "runtime-bootstrap-"));
    const filePath = joinPath(dir, "runtime_jobs.json");
    const persisted = createJob();
    console.info(
      `[runtime-bootstrap:recover-running] filePath=${filePath} persistedStatus=${persisted.status} jobId=${persisted.jobId}`,
    );
    writeFileSync(filePath, JSON.stringify({ jobs: [persisted] }, null, 2));

    runtimeJobsStore.configurePersistence(filePath);
    const kickWorker = vi.fn();

    const result = bootstrapRuntimeJobs({
      startWorker: false,
      kickWorkerFn: kickWorker,
    });
    console.info(
      `[runtime-bootstrap:recover-running] kicked=${result.kicked} recovered.length=${result.recovered.length} kickWorker.calls=${kickWorker.mock.calls.length}`,
    );

    try {
      expect(result.kicked).toBe(true);
      expect(result.recovered).toHaveLength(1);
      expect(result.recovered[0]).toMatchObject({
        jobId: persisted.jobId,
        status: "queued",
        stageCode: "queued",
        stageLabel: "Queued",
      });
      expect(runtimeJobsStore.get(persisted.jobId)).toMatchObject({
        status: "queued",
        stageCode: "queued",
      });
      expect(kickWorker).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpBootstrapSnapshot("recover-running-failure", {
        filePath,
        result,
        kickWorker,
        storeJob: runtimeJobsStore.get(persisted.jobId),
      });
      throw err;
    }
  });

  it("kicks startup execution when queued jobs already exist even if nothing needed recovery", () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "runtime-bootstrap-queued-"));
    const filePath = joinPath(dir, "runtime_jobs.json");
    const queued = createJob({
      status: "queued",
      stageCode: "queued",
      stageLabel: "Queued",
      startedAt: null,
    });
    console.info(`[runtime-bootstrap:kick-queued] filePath=${filePath} queued jobId=${queued.jobId}`);
    writeFileSync(filePath, JSON.stringify({ jobs: [queued] }, null, 2));

    runtimeJobsStore.configurePersistence(filePath);
    const kickWorker = vi.fn();

    const result = bootstrapRuntimeJobs({
      startWorker: false,
      kickWorkerFn: kickWorker,
    });
    console.info(
      `[runtime-bootstrap:kick-queued] kicked=${result.kicked} recovered.length=${result.recovered.length} kickWorker.calls=${kickWorker.mock.calls.length}`,
    );

    try {
      expect(result.recovered).toHaveLength(0);
      expect(result.kicked).toBe(true);
      expect(kickWorker).toHaveBeenCalledTimes(1);
      expect(runtimeJobsStore.get(queued.jobId)).toMatchObject({
        status: "queued",
        stageCode: "queued",
      });
    } catch (err) {
      dumpBootstrapSnapshot("kick-queued-failure", {
        filePath,
        result,
        kickWorker,
        storeJob: runtimeJobsStore.get(queued.jobId),
      });
      throw err;
    }
  });
});
