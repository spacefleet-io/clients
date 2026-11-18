import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { runtimeJobsStore } from "../src/core/jobs/store";
import { RuntimeJobsStore } from "../src/core/jobs/store";
import { syncRuntimeJobsFromModuleCommand, syncRuntimeJobsFromModuleEvent } from "../src/core/jobs/adapters";
import type { RuntimeCommandRequest, RuntimeCommandResponse } from "../src/types";

const ok = (requestId: string, result: Record<string, unknown>): RuntimeCommandResponse => ({
  requestId,
  ok: true,
  result,
  error: null,
});

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps observed store entries + recent adapter input
// on assertion failure. Wrapped in try/catch so a dump-failure cannot mask
// the original.
// ---------------------------------------------------------------------------
const dumpJobsStoreSnapshot = (
  label: string,
  ctx: {
    store?: RuntimeJobsStore | typeof runtimeJobsStore;
    jobId?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-jobs-store:${label}] snapshot ===`);
    const store = ctx.store ?? runtimeJobsStore;
    const all = store.list({ includeCompleted: true });
    console.error(
      `store.list (${all.length})=\n${JSON.stringify(
        all.map((j) => ({
          jobId: j.jobId,
          status: j.status,
          stageCode: j.stageCode,
          progressPct: (j as unknown as { progressPct?: number }).progressPct,
        })),
        null,
        2,
      )}`,
    );
    if (ctx.jobId) {
      const entry = store.get(ctx.jobId);
      console.error(`store.get(${ctx.jobId})=\n${JSON.stringify(entry, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime jobs store adapters", () => {
  beforeEach(() => {
    console.info(`[runtime-jobs-store:setup] resetting in-memory store`);
    runtimeJobsStore.reset({ clearPersistence: true });
  });

  it("@bugfix @regression-proof seeds canonical badger jobs from ingest apply responses and async ingest events", () => {
    console.info(`[runtime-jobs-store:badger-apply] firing ingest.apply command`);
    const request: RuntimeCommandRequest = {
      requestId: "req-badger-apply",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {},
    };

    try {
      syncRuntimeJobsFromModuleCommand(
        request,
        ok("req-badger-apply", {
          userId: "user-a",
          jobs: [
            {
              id: "job-1",
              filename: "/tmp/movie.mkv",
              status: "transcoding",
              progress: 5,
              createdAt: "2026-03-23T10:00:00.000Z",
            },
          ],
        })
      );

      const running = runtimeJobsStore.get("badger:ingest:user-a:job-1");
      console.info(`[runtime-jobs-store:badger-apply] after apply: status=${running?.status} stageCode=${running?.stageCode}`);
      expect(running?.status).toBe("running");
      expect(running?.stageCode).toBe("transcoding");

      console.info(`[runtime-jobs-store:badger-apply] firing ingest.jobs_updated event`);
      syncRuntimeJobsFromModuleEvent("badger", "ingest", "ingest.jobs_updated", {
        userId: "user-a",
        jobs: [
          {
            id: "job-1",
            filename: "/tmp/movie.mkv",
            status: "done",
            progress: 100,
            createdAt: "2026-03-23T10:00:00.000Z",
            completedAt: "2026-03-23T10:01:00.000Z",
          },
        ],
      });

      const finished = runtimeJobsStore.get("badger:ingest:user-a:job-1");
      console.info(`[runtime-jobs-store:badger-apply] after event: status=${finished?.status} stageCode=${finished?.stageCode}`);
      expect(finished?.status).toBe("succeeded");
      expect(finished?.stageCode).toBe("done");
    } catch (err) {
      dumpJobsStoreSnapshot("badger-apply-failure", { jobId: "badger:ingest:user-a:job-1" });
      throw err;
    }
  });

  it("@bugfix @regression-proof reloads queued and running canonical jobs from disk after restart", () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "runtime-jobs-store-"));
    const filePath = joinPath(dir, "runtime_jobs.json");
    console.info(`[runtime-jobs-store:restart] persistence file=${filePath}`);
    const storeA = new RuntimeJobsStore(filePath);
    storeA.upsert({
      jobId: "badger:ingest:user-a:recover-1",
      app: "badger",
      kind: "badger.ingest.media_file",
      lane: "cpu",
      status: "running",
      stageCode: "transcoding",
      stageLabel: "Processing",
      progress: { mode: "fraction", completed: 12, total: 100, unit: "percent" },
      payload: { filename: "/tmp/recover.mkv" },
      outputs: {},
      errorCode: null,
      errorMessage: null,
      retryable: true,
      cancelRequested: false,
      priority: 0,
      dedupeKey: null,
      createdAt: "2026-03-23T10:00:00.000Z",
      updatedAt: "2026-03-23T10:00:05.000Z",
      startedAt: "2026-03-23T10:00:01.000Z",
      finishedAt: null,
    });

    console.info(`[runtime-jobs-store:restart] re-opening store from same file`);
    const storeB = new RuntimeJobsStore(filePath);
    const recovered = storeB.get("badger:ingest:user-a:recover-1");
    console.info(
      `[runtime-jobs-store:restart] recovered=${JSON.stringify({ status: recovered?.status, stageCode: recovered?.stageCode, completed: recovered?.progress.completed })}`,
    );
    try {
      expect(recovered?.status).toBe("running");
      expect(recovered?.stageCode).toBe("transcoding");
      expect(recovered?.progress.completed).toBe(12);
    } catch (err) {
      dumpJobsStoreSnapshot("restart-failure", { store: storeB, jobId: "badger:ingest:user-a:recover-1" });
      throw err;
    }
  });
});
