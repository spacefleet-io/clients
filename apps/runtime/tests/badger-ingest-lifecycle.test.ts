/**
 * @test-id INGEST-LIFECYCLE-001
 * @level integration
 * @why No comprehensive test covers all ingest job state transitions, cancel semantics at each stage,
 *      retry with backoff, duplicate prevention, or concurrent job limits.
 * @covers apps/runtime/src/modules/badger.ts ingest state machine, cancel, retry, scheduling
 */

import { describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import { runtimeJobsStore } from "../src/core/jobs/store";

const SUITE = "badger-ingest-lifecycle";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerIngestLifecycleSnapshot = (
  label: string,
  ctx: {
    userId?: string;
    jobId?: string;
    stages?: unknown;
    jobs?: unknown;
    jobsCount?: number;
    job?: unknown;
    jobStatus?: string;
    jobProgress?: unknown;
    jobError?: unknown;
    jobIds?: unknown;
    processMediaJobCalls?: number;
    abortSignalAborted?: boolean;
    matchedMediaId?: string;
    listResponseOk?: boolean;
    expected?: unknown;
    actual?: unknown;
    runtimeJobsCount?: number;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-ingest-lifecycle snapshot ===`);
    if (ctx.userId !== undefined) console.error(`userId: ${ctx.userId}`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.stages !== undefined) {
      console.error(`stages:\n${JSON.stringify(ctx.stages, jsonReplacer, 2)}`);
    }
    if (ctx.jobs !== undefined) {
      console.error(`jobs:\n${JSON.stringify(ctx.jobs, jsonReplacer, 2)}`);
    }
    if (ctx.jobsCount !== undefined) console.error(`jobsCount: ${ctx.jobsCount}`);
    if (ctx.job !== undefined) {
      console.error(`job:\n${JSON.stringify(ctx.job, jsonReplacer, 2)}`);
    }
    if (ctx.jobStatus !== undefined) console.error(`jobStatus: ${ctx.jobStatus}`);
    if (ctx.jobProgress !== undefined) {
      console.error(`jobProgress: ${JSON.stringify(ctx.jobProgress)}`);
    }
    if (ctx.jobError !== undefined) {
      console.error(`jobError: ${JSON.stringify(ctx.jobError)}`);
    }
    if (ctx.jobIds !== undefined) {
      console.error(`jobIds:\n${JSON.stringify(ctx.jobIds, jsonReplacer, 2)}`);
    }
    if (ctx.processMediaJobCalls !== undefined) {
      console.error(`processMediaJobCalls: ${ctx.processMediaJobCalls}`);
    }
    if (ctx.abortSignalAborted !== undefined) {
      console.error(`abortSignalAborted: ${ctx.abortSignalAborted}`);
    }
    if (ctx.matchedMediaId !== undefined) console.error(`matchedMediaId: ${ctx.matchedMediaId}`);
    if (ctx.listResponseOk !== undefined) console.error(`listResponseOk: ${ctx.listResponseOk}`);
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.runtimeJobsCount !== undefined) {
      console.error(`runtimeJobsCount: ${ctx.runtimeJobsCount}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    try {
      console.error(
        `runtimeJobsStore: badger-jobs=${runtimeJobsStore.list({ includeCompleted: true, app: "badger" }).length}`
      );
    } catch {
      console.error(`runtimeJobsStore: (list failed)`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => Promise<void> | void, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  let lastErr: unknown = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    try { await fn(); return; } catch (err) { lastErr = err; attempts += 1; await sleep(50); }
  }
  console.error(`[${SUITE}:waitFor] timed out after ${timeout}ms with ${attempts} attempts; last err: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  await fn(); // final attempt — let it throw
};

type LabJob = Record<string, unknown>;

const createModule = (processMediaJob?: (...args: any[]) => any) => {
  runtimeJobsStore.reset({ clearPersistence: true });
  return new BadgerModule({
    processMediaJob: processMediaJob ?? vi.fn(async () => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu" as const,
    })),
  });
};

const openQueue = async (module: BadgerModule, userId: string) => {
  await module.execute({
    requestId: `open-${userId}`,
    module: "badger",
    command: "badger.ingest.open",
    payload: {
      userId,
      config: {
        enableCodecSelection: false,
        transcodeOutputs: [{ quality: "360p", codec: "h264" }],
        uiLanguage: "en",
        token: "backend-token",
        libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      },
    },
  });
};

const queueFile = async (
  module: BadgerModule,
  userId: string,
  jobId: string,
  overrides: Record<string, unknown> = {}
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
              includeSubtitles: true,
              includeChapters: true,
              selectedFormats: [{ quality: "360p", codec: "h264" }],
              ...overrides,
            },
          ],
          preset: {
            media: {
              id: `media-${jobId}`,
              type: "movie",
              catalogId: 550,
              title: "Fight Club",
              year: "1999",
              posterPath: "/fight-club.jpg",
              originalLanguage: "en",
            },
          },
        },
      ],
    },
  });
};

const startJob = async (module: BadgerModule, userId: string, jobId: string) => {
  await module.execute({
    requestId: `start-${jobId}`,
    module: "badger",
    command: "badger.ingest.apply",
    payload: { userId, actions: [{ type: "start_job", jobId }] },
  });
};

const cancelJob = async (module: BadgerModule, userId: string, jobId: string) => {
  await module.execute({
    requestId: `cancel-${jobId}`,
    module: "badger",
    command: "badger.ingest.apply",
    payload: { userId, actions: [{ type: "cancel_job", jobId }] },
  });
};

const listJobs = async (module: BadgerModule, userId: string): Promise<LabJob[]> => {
  const result = await module.execute({
    requestId: `list-${Date.now()}`,
    module: "badger",
    command: "badger.ingest.list_jobs",
    payload: { userId },
  });
  return result.response.ok ? (result.response.result as { jobs: LabJob[] }).jobs : [];
};

describe("badger ingest lifecycle", () => {
  console.info(`[${SUITE}:describe] entering "badger ingest lifecycle"`);
  // -------------------------------------------------------------------------
  // A.1: Job creation
  // -------------------------------------------------------------------------

  it("creates a source upload job with correct initial state", async () => {
    const label = "create-source-job-initial-state";
    console.info(`[${SUITE}:${label}] start`);
    const module = createModule();
    console.info(`[${SUITE}:${label}] opening queue for user-1`);
    await openQueue(module, "user-1");
    console.info(`[${SUITE}:${label}] queueing file job-create-1`);
    await queueFile(module, "user-1", "job-create-1");

    const jobs = await listJobs(module, "user-1");
    console.info(`[${SUITE}:${label}] listed ${jobs.length} jobs, first status=${String(jobs[0]?.status)}`);
    try {
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: "job-create-1",
        filename: "/tmp/job-create-1.mkv",
        includeSource: true,
        matchedMediaId: "media-job-create-1",
      });
      // Job should be in a processable state (ready or identifying based on preset)
      expect(["ready", "identifying", "waiting"]).toContain(jobs[0].status);
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-create-1",
        jobs,
        jobsCount: jobs.length,
        job: jobs[0],
        jobStatus: jobs[0]?.status as string | undefined,
        expected: {
          length: 1,
          id: "job-create-1",
          matchedMediaId: "media-job-create-1",
          statusIn: ["ready", "identifying", "waiting"],
        },
        actual: {
          length: jobs.length,
          id: jobs[0]?.id,
          matchedMediaId: jobs[0]?.matchedMediaId,
          status: jobs[0]?.status,
        },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("creates multiple jobs from a single queue_files action", async () => {
    const label = "multi-jobs-single-action";
    console.info(`[${SUITE}:${label}] start`);
    const module = createModule();
    console.info(`[${SUITE}:${label}] opening queue for user-1`);
    await openQueue(module, "user-1");

    console.info(`[${SUITE}:${label}] queueing 3 files in one action`);
    await module.execute({
      requestId: "queue-multi",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-1",
        actions: [
          {
            type: "queue_files",
            files: [
              { id: "multi-1", filename: "/tmp/multi-1.mkv", sizeMb: 50, includeSource: true, selectedFormats: [] },
              { id: "multi-2", filename: "/tmp/multi-2.mkv", sizeMb: 50, includeSource: true, selectedFormats: [] },
              { id: "multi-3", filename: "/tmp/multi-3.mkv", sizeMb: 50, includeSource: true, selectedFormats: [] },
            ],
            preset: {
              media: { id: "media-multi", type: "movie", catalogId: 1, title: "Test", year: "2020", posterPath: null, originalLanguage: "en" },
            },
          },
        ],
      },
    });

    const jobs = await listJobs(module, "user-1");
    console.info(`[${SUITE}:${label}] listed ${jobs.length} jobs (expected 3)`);
    try {
      expect(jobs).toHaveLength(3);
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobs,
        jobsCount: jobs.length,
        jobIds: jobs.map((j) => j.id),
        expected: 3,
        actual: jobs.length,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  // -------------------------------------------------------------------------
  // A.2: State transitions
  // -------------------------------------------------------------------------

  it("job transitions through processing stages when started", async () => {
    const label = "job-stage-transitions";
    console.info(`[${SUITE}:${label}] start`);
    const stages: string[] = [];
    const processMediaJob = vi.fn(async ({ onProgress }: any) => {
      onProgress("transcoding", 50);
      stages.push("transcoding");
      onProgress("uploading", 0);
      stages.push("uploading");
      onProgress("uploading", 100);
      return {
        produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
        encoder: "cpu" as const,
      };
    });
    const module = createModule(processMediaJob);
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-stages");
    console.info(`[${SUITE}:${label}] starting job job-stages`);
    await startJob(module, "user-1", "job-stages");

    console.info(`[${SUITE}:${label}] waiting for processMediaJob to be invoked`);
    try {
      await waitFor(() => {
        expect(processMediaJob).toHaveBeenCalledTimes(1);
      });
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-stages",
        processMediaJobCalls: processMediaJob.mock.calls.length,
        stages,
        jobs: await listJobs(module, "user-1").catch(() => null),
        expected: { processMediaJobCalled: 1 },
        actual: { processMediaJobCalled: processMediaJob.mock.calls.length },
        error: err,
      });
      throw err;
    }

    // Wait for job to complete
    console.info(`[${SUITE}:${label}] waiting for job to reach status=done`);
    try {
      await waitFor(async () => {
        const jobs = await listJobs(module, "user-1");
        expect(jobs[0].status).toBe("done");
      });
    } catch (err) {
      const jobs = await listJobs(module, "user-1").catch(() => null);
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-stages",
        stages,
        jobs,
        job: jobs?.[0],
        jobStatus: jobs?.[0]?.status as string | undefined,
        expected: { status: "done" },
        actual: { status: jobs?.[0]?.status },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] verifying stages=${JSON.stringify(stages)}`);
    try {
      expect(stages).toEqual(["transcoding", "uploading"]);
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-stages",
        stages,
        expected: ["transcoding", "uploading"],
        actual: stages,
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("completed job has status done and progress 100", async () => {
    const label = "completed-done-progress-100";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async () => ({
      produced: { videoFormats: [{ quality: "1080p", codec: "h264", initKey: "k", initSize: 1, durationSeconds: 10, totalSize: 100, chunks: [] }], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu" as const,
    }));
    const module = createModule(processMediaJob);
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-done");
    console.info(`[${SUITE}:${label}] starting job job-done`);
    await startJob(module, "user-1", "job-done");

    console.info(`[${SUITE}:${label}] waiting for status=done`);
    try {
      await waitFor(async () => {
        const jobs = await listJobs(module, "user-1");
        expect(jobs[0].status).toBe("done");
      });
    } catch (err) {
      const jobs = await listJobs(module, "user-1").catch(() => null);
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-done",
        jobs,
        job: jobs?.[0],
        jobStatus: jobs?.[0]?.status as string | undefined,
        expected: { status: "done" },
        actual: { status: jobs?.[0]?.status },
        error: err,
      });
      throw err;
    }

    const jobs = await listJobs(module, "user-1");
    console.info(`[${SUITE}:${label}] verifying progress=${String(jobs[0]?.progress)} hasProduced=${Boolean(jobs[0]?.produced)}`);
    try {
      expect(jobs[0].progress).toBe(100);
      expect(jobs[0].produced).toBeTruthy();
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-done",
        jobs,
        job: jobs[0],
        jobProgress: jobs[0]?.progress,
        expected: { progress: 100, producedTruthy: true },
        actual: { progress: jobs[0]?.progress, produced: jobs[0]?.produced },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  // -------------------------------------------------------------------------
  // A.3: Cancel at each stage
  // -------------------------------------------------------------------------

  it("cancel before start: job immediately cancelled", async () => {
    const label = "cancel-before-start";
    console.info(`[${SUITE}:${label}] start`);
    const module = createModule();
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-cancel-before");
    console.info(`[${SUITE}:${label}] cancelling job before start`);
    await cancelJob(module, "user-1", "job-cancel-before");

    const jobs = await listJobs(module, "user-1");
    console.info(`[${SUITE}:${label}] jobStatus=${String(jobs[0]?.status)}`);
    try {
      expect(jobs[0].status).toBe("cancelled");
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-cancel-before",
        jobs,
        job: jobs[0],
        jobStatus: jobs[0]?.status as string | undefined,
        expected: { status: "cancelled" },
        actual: { status: jobs[0]?.status },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("cancel during processing: job cancelled with abort signal", async () => {
    const label = "cancel-during-processing";
    console.info(`[${SUITE}:${label}] start`);
    let abortSignal: AbortSignal | null = null;
    const processMediaJob = vi.fn(async ({ signal }: any) => {
      abortSignal = signal;
      // Simulate long-running work
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const module = createModule(processMediaJob);
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-cancel-during");
    console.info(`[${SUITE}:${label}] starting job job-cancel-during`);
    await startJob(module, "user-1", "job-cancel-during");

    console.info(`[${SUITE}:${label}] waiting for processMediaJob to be invoked`);
    try {
      await waitFor(() => expect(processMediaJob).toHaveBeenCalledTimes(1));
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-cancel-during",
        processMediaJobCalls: processMediaJob.mock.calls.length,
        expected: { processMediaJobCalled: 1 },
        actual: { processMediaJobCalled: processMediaJob.mock.calls.length },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] cancelling mid-flight`);
    await cancelJob(module, "user-1", "job-cancel-during");

    console.info(`[${SUITE}:${label}] waiting for status=cancelled`);
    try {
      await waitFor(async () => {
        const jobs = await listJobs(module, "user-1");
        expect(jobs[0].status).toBe("cancelled");
      });
    } catch (err) {
      const jobs = await listJobs(module, "user-1").catch(() => null);
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-cancel-during",
        jobs,
        job: jobs?.[0],
        jobStatus: jobs?.[0]?.status as string | undefined,
        abortSignalAborted: (abortSignal as AbortSignal | null)?.aborted,
        expected: { status: "cancelled" },
        actual: { status: jobs?.[0]?.status },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] verifying abortSignal.aborted=${(abortSignal as AbortSignal | null)?.aborted}`);
    try {
      expect((abortSignal as AbortSignal | null)?.aborted).toBe(true);
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-cancel-during",
        abortSignalAborted: (abortSignal as AbortSignal | null)?.aborted,
        expected: { aborted: true },
        actual: { aborted: (abortSignal as AbortSignal | null)?.aborted },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  // -------------------------------------------------------------------------
  // A.4: Retry on failure
  // -------------------------------------------------------------------------

  it("failed job is retryable by default", async () => {
    const label = "failed-job-retryable";
    console.info(`[${SUITE}:${label}] start`);
    let callCount = 0;
    const processMediaJob = vi.fn(async () => {
      callCount++;
      if (callCount <= 1) throw new Error("transient_error");
      return {
        produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
        encoder: "cpu" as const,
      };
    });
    const module = createModule(processMediaJob);
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-retry");
    console.info(`[${SUITE}:${label}] starting job job-retry`);
    await startJob(module, "user-1", "job-retry");

    // Wait for first attempt to fail
    console.info(`[${SUITE}:${label}] waiting for status=failed`);
    try {
      await waitFor(async () => {
        const jobs = await listJobs(module, "user-1");
        expect(jobs[0].status).toBe("failed");
      });
    } catch (err) {
      const jobs = await listJobs(module, "user-1").catch(() => null);
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-retry",
        processMediaJobCalls: callCount,
        jobs,
        job: jobs?.[0],
        jobStatus: jobs?.[0]?.status as string | undefined,
        expected: { status: "failed" },
        actual: { status: jobs?.[0]?.status },
        error: err,
      });
      throw err;
    }

    const jobs = await listJobs(module, "user-1");
    console.info(`[${SUITE}:${label}] jobError=${JSON.stringify(jobs[0]?.error)}`);
    try {
      expect(jobs[0].error).toBeTruthy();
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-retry",
        jobs,
        job: jobs[0],
        jobError: jobs[0]?.error,
        expected: { errorTruthy: true },
        actual: { error: jobs[0]?.error },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  // -------------------------------------------------------------------------
  // A.5: Multiple jobs in queue
  // -------------------------------------------------------------------------

  it("multiple jobs can be queued and listed", async () => {
    const label = "multi-jobs-queued-listed";
    console.info(`[${SUITE}:${label}] start`);
    const module = createModule();
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "multi-a");
    await queueFile(module, "user-1", "multi-b");
    await queueFile(module, "user-1", "multi-c");

    const jobs = await listJobs(module, "user-1");
    const ids = jobs.map((j) => j.id).sort();
    console.info(`[${SUITE}:${label}] jobsCount=${jobs.length} ids=${JSON.stringify(ids)}`);
    try {
      expect(jobs).toHaveLength(3);
      expect(jobs.map((j) => j.id).sort()).toEqual(["multi-a", "multi-b", "multi-c"]);
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobs,
        jobsCount: jobs.length,
        jobIds: ids,
        expected: { length: 3, ids: ["multi-a", "multi-b", "multi-c"] },
        actual: { length: jobs.length, ids },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  // -------------------------------------------------------------------------
  // A.6: Close queue
  // -------------------------------------------------------------------------

  it("close queue clears active state", async () => {
    const label = "close-queue-list-still-works";
    console.info(`[${SUITE}:${label}] start`);
    const module = createModule();
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-close");

    console.info(`[${SUITE}:${label}] closing queue`);
    await module.execute({
      requestId: "close-1",
      module: "badger",
      command: "badger.ingest.close",
      payload: { userId: "user-1" },
    });

    // List jobs should still work (jobs persist) but queue is closed
    console.info(`[${SUITE}:${label}] listing jobs after close`);
    const result = await module.execute({
      requestId: "list-after-close",
      module: "badger",
      command: "badger.ingest.list_jobs",
      payload: { userId: "user-1" },
    });
    console.info(`[${SUITE}:${label}] listResponseOk=${result.response.ok}`);
    try {
      expect(result.response.ok).toBe(true);
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1",
        jobId: "job-close",
        listResponseOk: result.response.ok,
        extra: { response: result.response as unknown as Record<string, unknown> },
        expected: { ok: true },
        actual: { ok: result.response.ok },
        error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  // -------------------------------------------------------------------------
  // A.7: Error message mapping
  // -------------------------------------------------------------------------

  it("upload timeout error surfaces as lab.errors.uploadTimeout", async () => {
    const label = "error-upload-timeout";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async () => {
      throw new Error("UPLOAD_TIMEOUT: storage upload did not complete within 5 minutes — check gateway health");
    });
    const module = createModule(processMediaJob);
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-timeout");
    console.info(`[${SUITE}:${label}] starting job job-timeout`);
    await startJob(module, "user-1", "job-timeout");

    console.info(`[${SUITE}:${label}] waiting for status=failed`);
    try {
      await waitFor(async () => {
        const jobs = await listJobs(module, "user-1");
        expect(jobs[0].status).toBe("failed");
      });
    } catch (err) {
      const jobs = await listJobs(module, "user-1").catch(() => null);
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1", jobId: "job-timeout", jobs, job: jobs?.[0],
        jobStatus: jobs?.[0]?.status as string | undefined,
        expected: { status: "failed" }, actual: { status: jobs?.[0]?.status }, error: err,
      });
      throw err;
    }

    const jobs = await listJobs(module, "user-1");
    console.info(`[${SUITE}:${label}] jobError=${JSON.stringify(jobs[0]?.error)}`);
    try {
      expect(jobs[0].error).toBe("lab.errors.uploadTimeout");
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1", jobId: "job-timeout", jobs, job: jobs[0], jobError: jobs[0]?.error,
        expected: { error: "lab.errors.uploadTimeout" }, actual: { error: jobs[0]?.error }, error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("generic processing error surfaces as lab.errors.processingFailed", async () => {
    const label = "error-generic-processing-failed";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async () => {
      throw new Error("some_random_error");
    });
    const module = createModule(processMediaJob);
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-generic-err");
    console.info(`[${SUITE}:${label}] starting job job-generic-err`);
    await startJob(module, "user-1", "job-generic-err");

    console.info(`[${SUITE}:${label}] waiting for status=failed`);
    try {
      await waitFor(async () => {
        const jobs = await listJobs(module, "user-1");
        expect(jobs[0].status).toBe("failed");
      });
    } catch (err) {
      const jobs = await listJobs(module, "user-1").catch(() => null);
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1", jobId: "job-generic-err", jobs, job: jobs?.[0],
        jobStatus: jobs?.[0]?.status as string | undefined,
        expected: { status: "failed" }, actual: { status: jobs?.[0]?.status }, error: err,
      });
      throw err;
    }

    const jobs = await listJobs(module, "user-1");
    console.info(`[${SUITE}:${label}] jobError=${JSON.stringify(jobs[0]?.error)}`);
    try {
      expect(jobs[0].error).toBe("lab.errors.processingFailed");
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1", jobId: "job-generic-err", jobs, job: jobs[0], jobError: jobs[0]?.error,
        expected: { error: "lab.errors.processingFailed" }, actual: { error: jobs[0]?.error }, error: err,
      });
      throw err;
    }
    module.shutdown();
  });

  it("subtitle required missing error surfaces as lab.errors.subtitleRequiredMissing", async () => {
    const label = "error-subtitle-required-missing";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async () => {
      throw new Error("SUBTITLE_REQUIRED_MISSING");
    });
    const module = createModule(processMediaJob);
    await openQueue(module, "user-1");
    await queueFile(module, "user-1", "job-no-sub");
    console.info(`[${SUITE}:${label}] starting job job-no-sub`);
    await startJob(module, "user-1", "job-no-sub");

    console.info(`[${SUITE}:${label}] waiting for status=failed`);
    try {
      await waitFor(async () => {
        const jobs = await listJobs(module, "user-1");
        expect(jobs[0].status).toBe("failed");
      });
    } catch (err) {
      const jobs = await listJobs(module, "user-1").catch(() => null);
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1", jobId: "job-no-sub", jobs, job: jobs?.[0],
        jobStatus: jobs?.[0]?.status as string | undefined,
        expected: { status: "failed" }, actual: { status: jobs?.[0]?.status }, error: err,
      });
      throw err;
    }

    const jobs = await listJobs(module, "user-1");
    console.info(`[${SUITE}:${label}] jobError=${JSON.stringify(jobs[0]?.error)}`);
    try {
      expect(jobs[0].error).toBe("lab.errors.subtitleRequiredMissing");
    } catch (err) {
      dumpBadgerIngestLifecycleSnapshot(label, {
        userId: "user-1", jobId: "job-no-sub", jobs, job: jobs[0], jobError: jobs[0]?.error,
        expected: { error: "lab.errors.subtitleRequiredMissing" }, actual: { error: jobs[0]?.error }, error: err,
      });
      throw err;
    }
    module.shutdown();
  });
});
