/**
 * @test-id CANCEL-STATUS-001
 * @level unit
 * @why Pins the invariant that cancel_job always produces "cancelled" (UK spelling),
 *      never "failed" or "dropped", regardless of the status at the time of dispatch.
 *      This is a UI contract: the LabJobCard reads .status directly.
 * @covers apps/runtime/src/modules/badger.ts cancel_job dispatch path (lines 1311-1318)
 *         and runIngestJob AbortSignal catch branch (lines 1644-1652)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import { runtimeJobsStore } from "../src/core/jobs/store";

// ---------------------------------------------------------------------------
// Shared helpers (mirror the pattern from badger-ingest-lifecycle.test.ts)
// ---------------------------------------------------------------------------

const createModule = (processMediaJob?: (...args: any[]) => any) => {
  runtimeJobsStore.reset({ clearPersistence: true });
  return new BadgerModule({
    processMediaJob: processMediaJob ??
      vi.fn(async () => ({
        produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
        encoder: "cpu" as const,
      })),
  });
};

const openQueue = async (module: BadgerModule, userId = "cancel-user") => {
  await module.execute({
    requestId: "open-cancel",
    module: "badger",
    command: "badger.ingest.open",
    payload: {
      userId,
      config: {
        enableCodecSelection: false,
        transcodeOutputs: [{ quality: "360p", codec: "h264" }],
        uiLanguage: "en",
        token: "test-token",
        libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      },
    },
  });
};

const queueFile = async (
  module: BadgerModule,
  userId: string,
  jobId: string
) => {
  await module.execute({
    requestId: `queue-${jobId}`,
    module: "badger",
    command: "badger.ingest.apply",
    payload: {
      userId,
      actions: [
        {
          type: "queue_files",
          files: [
            {
              id: jobId,
              filename: `/tmp/${jobId}.mkv`,
              sizeMb: 100,
              includeSource: true,
              includeFallback: false,
              includeAudio: true,
              includeSubtitles: false,
              includeChapters: false,
              selectedFormats: [{ quality: "360p", codec: "h264" }],
            },
          ],
          preset: {
            media: {
              id: `media-${jobId}`,
              type: "movie",
              tmdbId: 42,
              title: "Test Film",
              year: "2024",
              posterPath: null,
              originalLanguage: "en",
            },
          },
        },
      ],
    },
  });
};

const applyAction = async (
  module: BadgerModule,
  userId: string,
  action: Record<string, unknown>
) => {
  return module.execute({
    requestId: `action-${Date.now()}`,
    module: "badger",
    command: "badger.ingest.apply",
    payload: { userId, actions: [action] },
  });
};

const listJobs = async (
  module: BadgerModule,
  userId: string
): Promise<Record<string, unknown>[]> => {
  const result = await module.execute({
    requestId: `list-${Date.now()}`,
    module: "badger",
    command: "badger.ingest.list_jobs",
    payload: { userId },
  });
  return result.response.ok
    ? (result.response.result as { jobs: Record<string, unknown>[] }).jobs
    : [];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (
  fn: () => Promise<void> | void,
  timeout = 5_000,
  label = "anonymous",
) => {
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let attempts = 0;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      attempts += 1;
      await fn();
      const elapsed = Date.now() - startedAt;
      console.info(
        `[badger-cancel-status:wait-${label}] satisfied after ${attempts} attempts (${elapsed}ms)`,
      );
      return;
    } catch (err) {
      lastError = err;
      await sleep(50);
    }
  }
  const elapsed = Date.now() - startedAt;
  console.error(
    `[badger-cancel-status:wait-${label}] TIMEOUT after ${attempts} attempts (${elapsed}ms); lastError=${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  await fn(); // final attempt — throw on real failure
};

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps the user's full job list + relevant ctx
// on assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpCancelStatusSnapshot = async (
  label: string,
  ctx: {
    module?: BadgerModule;
    userId?: string;
    processMediaJob?: ReturnType<typeof vi.fn>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-cancel-status:${label}] snapshot ===`);
    if (ctx.module && ctx.userId) {
      const jobs = await listJobs(ctx.module, ctx.userId);
      console.error(
        `jobs (${jobs.length})=\n${JSON.stringify(jobs, null, 2)}`,
      );
    }
    if (ctx.processMediaJob) {
      console.error(
        `processMediaJob.callCount=${ctx.processMediaJob.mock?.calls?.length ?? "(not-a-vi-fn)"}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("badger cancel_job status mapping invariant", () => {
  afterEach(() => {
    console.info(`[badger-cancel-status:teardown] unstubbing globals`);
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Synchronous dispatch path — cancel_job while job is in a given status
  // -------------------------------------------------------------------------

  it(
    "cancel_job while transcoding: status is cancelled, not failed or dropped @regression-proof",
    async () => {
      const userId = "cancel-user-transcoding";
      const jobId = "job-cancel-transcoding";
      console.info(
        `[badger-cancel-status:cancel-transcoding] setup; userId=${userId} jobId=${jobId}`,
      );
      // Block processMediaJob in the transcoding stage so the job is in
      // "transcoding" status when we cancel.
      let unblock!: () => void;
      const blocked = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const processMediaJob = vi.fn(async ({ signal, onProgress }: any) => {
        onProgress("transcoding", 10);
        // Stall until aborted or unblocked
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          blocked.then(() => reject(new Error("unblocked"))).catch(() => {});
        });
      });

      const module = createModule(processMediaJob);
      try {
        await openQueue(module, userId);
        await queueFile(module, userId, jobId);
        console.info(
          `[badger-cancel-status:cancel-transcoding] dispatching start_job`,
        );
        await applyAction(module, userId, {
          type: "start_job",
          jobId,
        });

        // Wait until processMediaJob has been called and the job is transcoding
        await waitFor(
          () => expect(processMediaJob).toHaveBeenCalledTimes(1),
          5_000,
          "transcoding-pmj-called",
        );
        await waitFor(
          async () => {
            const jobs = await listJobs(module, userId);
            expect(jobs[0]?.status).toBe("transcoding");
          },
          5_000,
          "transcoding-status-reached",
        );
        console.info(
          `[badger-cancel-status:cancel-transcoding] dispatching cancel_job (job is in transcoding stage)`,
        );

        // Now cancel
        await applyAction(module, userId, {
          type: "cancel_job",
          jobId,
        });

        await waitFor(
          async () => {
            const jobs = await listJobs(module, userId);
            const job = jobs[0];
            expect(
              job?.status,
              `Expected "cancelled" after cancel_job on transcoding job. Got: ${job?.status}. Full job: ${JSON.stringify(job)}`,
            ).toBe("cancelled");
          },
          5_000,
          "transcoding-status-cancelled",
        );

        const jobs = await listJobs(module, userId);
        const job = jobs[0];
        console.info(
          `[badger-cancel-status:cancel-transcoding] final status=${job?.status} error=${JSON.stringify(job?.error)} completedAt=${job?.completedAt}`,
        );
        try {
          expect(
            job?.error,
            `Expected error to be undefined after cancel. Got: ${job?.error}. Full job: ${JSON.stringify(job)}`,
          ).toBeUndefined();
          expect(
            job?.completedAt,
            `Expected completedAt to be set after cancel. Full job: ${JSON.stringify(job)}`,
          ).toBeTruthy();
        } catch (err) {
          await dumpCancelStatusSnapshot("cancel-transcoding-failure", {
            module,
            userId,
            processMediaJob,
          });
          throw err;
        }

        unblock(); // release the stalled promise (ignored by module, just for cleanup)
      } finally {
        module.shutdown();
      }
    }
  );

  it(
    "cancel_job while uploading: status is cancelled, not failed or dropped @regression-proof",
    async () => {
      const userId = "cancel-user-uploading";
      const jobId = "job-cancel-uploading";
      console.info(
        `[badger-cancel-status:cancel-uploading] setup; userId=${userId} jobId=${jobId}`,
      );
      let unblock!: () => void;
      const blocked = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const processMediaJob = vi.fn(async ({ signal, onProgress }: any) => {
        onProgress("uploading", 10);
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          blocked.then(() => reject(new Error("unblocked"))).catch(() => {});
        });
      });

      const module = createModule(processMediaJob);
      try {
        await openQueue(module, userId);
        await queueFile(module, userId, jobId);
        console.info(
          `[badger-cancel-status:cancel-uploading] dispatching start_job`,
        );
        await applyAction(module, userId, {
          type: "start_job",
          jobId,
        });

        await waitFor(
          () => expect(processMediaJob).toHaveBeenCalledTimes(1),
          5_000,
          "uploading-pmj-called",
        );
        await waitFor(
          async () => {
            const jobs = await listJobs(module, userId);
            expect(jobs[0]?.status).toBe("uploading");
          },
          5_000,
          "uploading-status-reached",
        );
        console.info(
          `[badger-cancel-status:cancel-uploading] dispatching cancel_job (job is in uploading stage)`,
        );

        await applyAction(module, userId, {
          type: "cancel_job",
          jobId,
        });

        await waitFor(
          async () => {
            const jobs = await listJobs(module, userId);
            const job = jobs[0];
            expect(
              job?.status,
              `Expected "cancelled" after cancel_job on uploading job. Got: ${job?.status}. Full job: ${JSON.stringify(job)}`,
            ).toBe("cancelled");
          },
          5_000,
          "uploading-status-cancelled",
        );

        const jobs = await listJobs(module, userId);
        const job = jobs[0];
        console.info(
          `[badger-cancel-status:cancel-uploading] final status=${job?.status} error=${JSON.stringify(job?.error)} completedAt=${job?.completedAt}`,
        );
        try {
          expect(
            job?.error,
            `Expected error to be undefined after cancel. Got: ${job?.error}. Full job: ${JSON.stringify(job)}`,
          ).toBeUndefined();
          expect(
            job?.completedAt,
            `Expected completedAt to be set after cancel. Full job: ${JSON.stringify(job)}`,
          ).toBeTruthy();
        } catch (err) {
          await dumpCancelStatusSnapshot("cancel-uploading-failure", {
            module,
            userId,
            processMediaJob,
          });
          throw err;
        }

        unblock();
      } finally {
        module.shutdown();
      }
    }
  );

  it(
    "cancel_job while queued (ready): status is cancelled, not failed or dropped @regression-proof",
    async () => {
      const userId = "cancel-user-queued";
      const jobId = "job-cancel-queued";
      console.info(
        `[badger-cancel-status:cancel-queued] setup; userId=${userId} jobId=${jobId}; processMediaJob never resolves`,
      );
      // Use a processMediaJob that never resolves — we cancel before it's called.
      // The job will be in "ready" status right after queueFile (preset is provided).
      const processMediaJob = vi.fn(
        () => new Promise<never>(() => {})
      );

      const module = createModule(processMediaJob);
      try {
        await openQueue(module, userId);
        await queueFile(module, userId, jobId);

        const jobsBefore = await listJobs(module, userId);
        console.info(
          `[badger-cancel-status:cancel-queued] pre-cancel status=${jobsBefore[0]?.status}`,
        );
        try {
          expect(
            ["ready", "queued", "waiting", "identifying"],
            `Unexpected initial status: ${jobsBefore[0]?.status}`,
          ).toContain(jobsBefore[0]?.status);
        } catch (err) {
          await dumpCancelStatusSnapshot("cancel-queued-initial-failure", {
            module,
            userId,
            processMediaJob,
            extra: { initialStatus: jobsBefore[0]?.status },
          });
          throw err;
        }

        console.info(
          `[badger-cancel-status:cancel-queued] dispatching cancel_job (no start_job; pre-execution cancel)`,
        );
        await applyAction(module, userId, {
          type: "cancel_job",
          jobId,
        });

        const jobs = await listJobs(module, userId);
        const job = jobs[0];
        console.info(
          `[badger-cancel-status:cancel-queued] final status=${job?.status} error=${JSON.stringify(job?.error)} completedAt=${job?.completedAt}`,
        );
        try {
          expect(
            job?.status,
            `Expected "cancelled" after cancel_job on queued job. Got: ${job?.status}. Full job: ${JSON.stringify(job)}`,
          ).toBe("cancelled");
          expect(
            job?.error,
            `Expected error to be undefined after cancel. Got: ${job?.error}. Full job: ${JSON.stringify(job)}`,
          ).toBeUndefined();
          expect(
            job?.completedAt,
            `Expected completedAt to be set after cancel. Full job: ${JSON.stringify(job)}`,
          ).toBeTruthy();
        } catch (err) {
          await dumpCancelStatusSnapshot("cancel-queued-failure", {
            module,
            userId,
            processMediaJob,
          });
          throw err;
        }
      } finally {
        module.shutdown();
      }
    }
  );

  // -------------------------------------------------------------------------
  // Async runIngestJob AbortSignal catch-branch path
  // The catch at badger.ts:1644 checks controller.signal.aborted — if true,
  // sets status to "cancelled"; otherwise sets status to "failed".
  // This case is exercised by the uploading/transcoding cancel tests above via
  // the real async code path: the stalled processMediaJob throws on abort,
  // the catch fires, signal.aborted is true, and status becomes "cancelled".
  //
  // A dedicated focused unit test would require injecting a seam into the
  // private runIngestJob method or exposing the AbortController. That seam
  // does not currently exist.
  // TODO(@known-gap): needs source seam — see plan W1-C
  // ---------------------------------------------------------------------------

  it.skip(
    "runIngestJob catch-branch: AbortSignal abort yields cancelled not failed (needs source seam)",
    async () => {
      // Requires direct access to the private AbortController or a public
      // injection point for the catch-branch. The transcoding/uploading tests
      // above already cover this path indirectly through the real async flow.
    }
  );
});
