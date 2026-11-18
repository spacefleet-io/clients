import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { BadgerModule } from "../src/modules/badger";
import {
  driveRuntimeJobsOnce,
  reconcileActiveRuntimeJobsFromModules,
  resetModulesForTests,
  setBadgerModuleForTests,
  setModuleEventPublisher,
  retryRuntimeJob,
} from "../src/modules";
import { runtimeJobsStore } from "../src/core/jobs/store";
import { syncRuntimeJobsFromModuleCommand, syncRuntimeJobsFromModuleEvent } from "../src/core/jobs/adapters";
import { publishAndDriveRuntimeJobsUpdate } from "../src/core/jobs/events";
import { runtimeJobWorker } from "../src/core/jobs/worker";
import { bootstrapRuntimeJobs } from "../src/runtime";
import type { RuntimeCommandRequest } from "../src/types";
import type * as SchedulerModule from "../src/core/jobs/scheduler";

// Pin the host capacity the shared engine sizes its cpu lane from. The real
// getHostRuntimeSchedulerPolicy reads os.availableParallelism(), which honours
// cgroup CPU quotas: on a <=4-CPU CI container it clamps the cpu lane to 1 and
// the maxParallelTranscodes=2 assertion below fails for reasons unrelated to
// the badger setting under test. 16 CPUs / 32 GiB lets the setting decide.
vi.mock("../src/core/jobs/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof SchedulerModule>();
  return {
    ...actual,
    getHostRuntimeSchedulerPolicy: () =>
      actual.getDefaultRuntimeSchedulerPolicy({ logicalCpuCount: 16, totalMemoryGiB: 32 }),
  };
});

const SUITE = "runtime-job-executors";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpRuntimeJobExecutorsSnapshot = (
  label: string,
  ctx: {
    userId?: string;
    jobId?: string;
    jobIds?: string[];
    requestId?: string;
    command?: string;
    module?: string;
    payload?: unknown;
    request?: Record<string, unknown>;
    response?: unknown;
    responseOk?: boolean;
    job?: unknown;
    jobs?: unknown;
    jobStatus?: string;
    jobStageCode?: string;
    startedJobIds?: string[];
    runningJobIds?: string[];
    queuedJobIds?: string[];
    expected?: unknown;
    actual?: unknown;
    processMediaJobCalls?: number;
    processMediaJobArgs?: unknown;
    drivenRan?: boolean;
    reconciled?: unknown;
    bootstrap?: unknown;
    kickWorkerCalls?: number;
    uploadAttempts?: number;
    retried?: unknown;
    dataDir?: string;
    runtimeJobs?: unknown;
    runtimeJobsCount?: number;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] runtime-job-executors snapshot ===`);
    if (ctx.userId !== undefined) console.error(`userId: ${ctx.userId}`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.jobIds !== undefined) {
      console.error(`jobIds:\n${JSON.stringify(ctx.jobIds, jsonReplacer, 2)}`);
    }
    if (ctx.requestId !== undefined) console.error(`requestId: ${ctx.requestId}`);
    if (ctx.command !== undefined) console.error(`command: ${ctx.command}`);
    if (ctx.module !== undefined) console.error(`module: ${ctx.module}`);
    if (ctx.payload !== undefined) {
      console.error(`payload:\n${JSON.stringify(ctx.payload, jsonReplacer, 2)}`);
    }
    if (ctx.request !== undefined) {
      console.error(`request:\n${JSON.stringify(ctx.request, jsonReplacer, 2)}`);
    }
    if (ctx.response !== undefined) {
      console.error(`response:\n${JSON.stringify(ctx.response, jsonReplacer, 2)}`);
    }
    if (ctx.responseOk !== undefined) console.error(`responseOk: ${ctx.responseOk}`);
    if (ctx.job !== undefined) {
      console.error(`job:\n${JSON.stringify(ctx.job, jsonReplacer, 2)}`);
    }
    if (ctx.jobs !== undefined) {
      console.error(`jobs:\n${JSON.stringify(ctx.jobs, jsonReplacer, 2)}`);
    }
    if (ctx.jobStatus !== undefined) console.error(`jobStatus: ${ctx.jobStatus}`);
    if (ctx.jobStageCode !== undefined) console.error(`jobStageCode: ${ctx.jobStageCode}`);
    if (ctx.startedJobIds !== undefined) {
      console.error(`startedJobIds:\n${JSON.stringify(ctx.startedJobIds, jsonReplacer, 2)}`);
    }
    if (ctx.runningJobIds !== undefined) {
      console.error(`runningJobIds:\n${JSON.stringify(ctx.runningJobIds, jsonReplacer, 2)}`);
    }
    if (ctx.queuedJobIds !== undefined) {
      console.error(`queuedJobIds:\n${JSON.stringify(ctx.queuedJobIds, jsonReplacer, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.processMediaJobCalls !== undefined) {
      console.error(`processMediaJobCalls: ${ctx.processMediaJobCalls}`);
    }
    if (ctx.processMediaJobArgs !== undefined) {
      console.error(`processMediaJobArgs:\n${JSON.stringify(ctx.processMediaJobArgs, jsonReplacer, 2)}`);
    }
    if (ctx.drivenRan !== undefined) console.error(`drivenRan: ${ctx.drivenRan}`);
    if (ctx.reconciled !== undefined) {
      console.error(`reconciled:\n${JSON.stringify(ctx.reconciled, jsonReplacer, 2)}`);
    }
    if (ctx.bootstrap !== undefined) {
      console.error(`bootstrap:\n${JSON.stringify(ctx.bootstrap, jsonReplacer, 2)}`);
    }
    if (ctx.kickWorkerCalls !== undefined) {
      console.error(`kickWorkerCalls: ${ctx.kickWorkerCalls}`);
    }
    if (ctx.uploadAttempts !== undefined) {
      console.error(`uploadAttempts: ${ctx.uploadAttempts}`);
    }
    if (ctx.retried !== undefined) {
      console.error(`retried:\n${JSON.stringify(ctx.retried, jsonReplacer, 2)}`);
    }
    if (ctx.dataDir !== undefined) console.error(`dataDir: ${ctx.dataDir}`);
    if (ctx.runtimeJobs !== undefined) {
      console.error(`runtimeJobs:\n${JSON.stringify(ctx.runtimeJobs, jsonReplacer, 2)}`);
    }
    if (ctx.runtimeJobsCount !== undefined) {
      console.error(`runtimeJobsCount: ${ctx.runtimeJobsCount}`);
    } else {
      try {
        const allJobs = runtimeJobsStore.list({ includeCompleted: true }, ["badger"]);
        console.error(`runtimeJobsStore.count: ${allJobs.length}`);
      } catch {
        // Snapshot must never throw.
      }
    }
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime job executors", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ usageRatio: 0 }) })));
  });

  afterEach(() => {
    runtimeJobWorker.stop();
    runtimeJobsStore.reset({ clearPersistence: true });
    const resetStartedAt = performance.now();
    resetModulesForTests();
    console.info(`[${SUITE}:afterEach] resetModulesForTests took ${(performance.now() - resetStartedAt).toFixed(1)}ms`);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("@bugfix @regression-proof advances matched badger ready jobs through the shared runtime engine instead of leaving them idle", async () => {
    const label = "advance-matched-badger-ready-jobs";
    console.info(`[${SUITE}:${label}] setting up BadgerModule with blocking processMediaJob`);
    const processMediaJob = vi.fn(
      async () =>
        await new Promise<never>(() => {
          // Keep the module-owned ingest task active so the engine only proves start/executor wiring here.
        })
    );
    const badgerModule = new BadgerModule({ processMediaJob });
    setBadgerModuleForTests(badgerModule);

    const openRequest: RuntimeCommandRequest = {
      requestId: "open",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-1",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    };
    console.info(`[${SUITE}:${label}] executing badger.ingest.open for user-1`);
    const openResult = await badgerModule.execute(openRequest);
    syncRuntimeJobsFromModuleCommand(openRequest, openResult.response);
    if (openResult.event) {
      syncRuntimeJobsFromModuleEvent(openRequest.module, openResult.event.channel, openResult.event.event, openResult.event.payload);
    }

    const applyRequest: RuntimeCommandRequest = {
      requestId: "apply",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-1",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-ready-1",
                filename: "/tmp/Friends episode.mkv",
                sizeMb: 100,
                includeSource: true,
                includeFallback: false,
                includeAudio: true,
                includeSubtitles: true,
                includeChapters: true,
                selectedFormats: [{ quality: "360p", codec: "h264" }],
              },
            ],
            preset: {
              media: {
                id: "media-tv-1",
                type: "tv",
                catalogId: 123,
                title: "Friends",
                year: "1994",
                posterPath: "/friends.jpg",
                originalLanguage: "en",
              },
            },
          },
        ],
      },
    };
    console.info(`[${SUITE}:${label}] executing badger.ingest.apply to queue job-ready-1`);
    const applyResult = await badgerModule.execute(applyRequest);
    syncRuntimeJobsFromModuleCommand(applyRequest, applyResult.response);
    if (applyResult.event) {
      syncRuntimeJobsFromModuleEvent(
        applyRequest.module,
        applyResult.event.channel,
        applyResult.event.event,
        applyResult.event.payload
      );
    }

    const seeded = runtimeJobsStore.get("badger:ingest:user-1:job-ready-1");
    console.info(`[${SUITE}:${label}] seeded job status=${seeded?.status} stageCode=${seeded?.stageCode}`);
    try {
      expect(seeded?.status).toBe("queued");
      expect(seeded?.stageCode).toBe("ready");
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-1",
        jobId: "badger:ingest:user-1:job-ready-1",
        job: seeded,
        expected: { status: "queued", stageCode: "ready" },
        actual: { status: seeded?.status, stageCode: seeded?.stageCode },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] driving runtime jobs once`);
    const ran = await driveRuntimeJobsOnce();
    console.info(`[${SUITE}:${label}] driveRuntimeJobsOnce returned ran=${ran}`);
    try {
      expect(ran).toBe(true);
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-1",
        drivenRan: ran,
        expected: true,
        actual: ran,
        error: err,
      });
      throw err;
    }

    const started = runtimeJobsStore.get("badger:ingest:user-1:job-ready-1");
    console.info(`[${SUITE}:${label}] post-drive job status=${started?.status} stageCode=${started?.stageCode} processMediaJobCalls=${processMediaJob.mock.calls.length}`);
    try {
      expect(started?.status).toBe("running");
      expect(started?.stageCode).toBe("transcoding");
      expect(processMediaJob).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-1",
        jobId: "badger:ingest:user-1:job-ready-1",
        job: started,
        jobStatus: started?.status,
        jobStageCode: started?.stageCode,
        processMediaJobCalls: processMediaJob.mock.calls.length,
        expected: { status: "running", stageCode: "transcoding", processMediaJobCalls: 1 },
        actual: { status: started?.status, stageCode: started?.stageCode, processMediaJobCalls: processMediaJob.mock.calls.length },
        error: err,
      });
      throw err;
    }

    badgerModule.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof honors the badger advanced transcode concurrency setting when dispatching cpu jobs", async () => {
    const label = "advanced-transcode-concurrency";
    console.info(`[${SUITE}:${label}] setting up BadgerModule with maxParallelTranscodes=2`);
    const processMediaJob = vi.fn(
      async () =>
        await new Promise<never>(() => {
          // Keep jobs running so the shared engine can prove parallel dispatch bounds.
        })
    );
    const badgerModule = new BadgerModule({ processMediaJob });
    setBadgerModuleForTests(badgerModule);

    const openRequest: RuntimeCommandRequest = {
      requestId: "open-two",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-2",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          maxParallelTranscodes: 2,
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    };
    console.info(`[${SUITE}:${label}] executing badger.ingest.open for user-2 with maxParallelTranscodes=2`);
    const openResult = await badgerModule.execute(openRequest);
    syncRuntimeJobsFromModuleCommand(openRequest, openResult.response);
    if (openResult.event) {
      syncRuntimeJobsFromModuleEvent(openRequest.module, openResult.event.channel, openResult.event.event, openResult.event.payload);
    }

    const applyRequest: RuntimeCommandRequest = {
      requestId: "apply-two",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-2",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-ready-a",
                filename: "/tmp/Friends S01E01.mkv",
                sizeMb: 100,
                includeSource: true,
                includeFallback: false,
                includeAudio: true,
                includeSubtitles: true,
                includeChapters: true,
                selectedFormats: [{ quality: "360p", codec: "h264" }],
              },
              {
                id: "job-ready-b",
                filename: "/tmp/Friends S01E02.mkv",
                sizeMb: 100,
                includeSource: true,
                includeFallback: false,
                includeAudio: true,
                includeSubtitles: true,
                includeChapters: true,
                selectedFormats: [{ quality: "360p", codec: "h264" }],
              },
              {
                id: "job-ready-c",
                filename: "/tmp/Friends S01E03.mkv",
                sizeMb: 100,
                includeSource: true,
                includeFallback: false,
                includeAudio: true,
                includeSubtitles: true,
                includeChapters: true,
                selectedFormats: [{ quality: "360p", codec: "h264" }],
              },
            ],
            preset: {
              media: {
                id: "media-tv-2",
                type: "tv",
                catalogId: 123,
                title: "Friends",
                year: "1994",
                posterPath: "/friends.jpg",
                originalLanguage: "en",
              },
            },
          },
        ],
      },
    };
    console.info(`[${SUITE}:${label}] executing apply with 3 queue_files entries`);
    const applyResult = await badgerModule.execute(applyRequest);
    syncRuntimeJobsFromModuleCommand(applyRequest, applyResult.response);
    if (applyResult.event) {
      syncRuntimeJobsFromModuleEvent(
        applyRequest.module,
        applyResult.event.channel,
        applyResult.event.event,
        applyResult.event.payload
      );
    }

    console.info(`[${SUITE}:${label}] driving runtime jobs once`);
    const ran = await driveRuntimeJobsOnce();
    try {
      expect(ran).toBe(true);
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-2",
        drivenRan: ran,
        expected: true,
        actual: ran,
        error: err,
      });
      throw err;
    }

    const running = runtimeJobsStore
      .list({ includeCompleted: true, app: "badger" }, ["badger"])
      .filter((entry) => entry.status === "running")
      .map((entry) => entry.jobId)
      .sort();
    const queued = runtimeJobsStore
      .list({ includeCompleted: true, app: "badger" }, ["badger"])
      .filter((entry) => entry.status === "queued")
      .map((entry) => entry.jobId);

    console.info(`[${SUITE}:${label}] post-drive running=${JSON.stringify(running)} queued=${JSON.stringify(queued)} processMediaJobCalls=${processMediaJob.mock.calls.length}`);
    try {
      expect(running).toEqual([
        "badger:ingest:user-2:job-ready-a",
        "badger:ingest:user-2:job-ready-b",
      ]);
      expect(queued).toContain("badger:ingest:user-2:job-ready-c");
      expect(processMediaJob).toHaveBeenCalledTimes(2);
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-2",
        runningJobIds: running,
        queuedJobIds: queued,
        processMediaJobCalls: processMediaJob.mock.calls.length,
        expected: {
          running: ["badger:ingest:user-2:job-ready-a", "badger:ingest:user-2:job-ready-b"],
          queuedIncludes: "badger:ingest:user-2:job-ready-c",
          processMediaJobCalls: 2,
        },
        actual: { running, queued, processMediaJobCalls: processMediaJob.mock.calls.length },
        runtimeJobs: runtimeJobsStore.list({ includeCompleted: true, app: "badger" }, ["badger"]),
        error: err,
      });
      throw err;
    }

    badgerModule.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof starts the next queued badger cpu job after an async ingest completion event without a second manual kick", async () => {
    const label = "async-completion-chains-next-job";
    console.info(`[${SUITE}:${label}] using fake timers + custom mocked badger module`);
    vi.useFakeTimers();

    let asyncEventPublisher: ((channel: string, event: string, payload: Record<string, unknown>) => void) | null = null;
    const startedJobIds: string[] = [];
    const badgerModule = {
      execute: vi.fn(async (request: RuntimeCommandRequest) => {
        const actions = Array.isArray(request.payload.actions) ? request.payload.actions : [];
        const startAction = actions.find(
          (entry): entry is { type: "start_job"; jobId: string } =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { type?: unknown }).type === "start_job" &&
            typeof (entry as { jobId?: unknown }).jobId === "string"
        );
        if (!startAction) {
          return {
            response: {
              requestId: request.requestId,
              ok: false,
              result: null,
              error: {
                code: "invalid_payload",
                message: "missing_start_job",
                retryable: false,
                details: {},
              },
            },
          };
        }
        startedJobIds.push(startAction.jobId);
        return {
          response: {
            requestId: request.requestId,
            ok: true,
            result: {
              userId: "user-chain",
              jobs: [
                {
                  id: startAction.jobId,
                  filename: `/tmp/${startAction.jobId}.mkv`,
                  status: "transcoding",
                  progress: 0,
                  createdAt: "2026-03-23T12:00:00.000Z",
                  matchedMediaId: `media-${startAction.jobId}`,
                },
              ],
            },
            error: null,
          },
        };
      }),
      shutdown: vi.fn(),
      setEventPublisher: vi.fn((publisher: ((channel: string, event: string, payload: Record<string, unknown>) => void) | null) => {
        asyncEventPublisher = publisher;
      }),
      getStateSummary: vi.fn(() => null),
      getSchedulingHints: vi.fn(() => ({ maxParallelTranscodes: 1 })),
    } as unknown as BadgerModule;
    setBadgerModuleForTests(badgerModule);
    setModuleEventPublisher((module, channel, event, payload) => {
      const syncedJobs = syncRuntimeJobsFromModuleEvent(module, channel, event, payload);
      const isBadgerJobsEvent = module === "badger" && channel === "ingest" && event.startsWith("ingest.jobs");
      if (isBadgerJobsEvent && syncedJobs.length > 0) {
        publishAndDriveRuntimeJobsUpdate(
          () => undefined,
          () => runtimeJobWorker.kick(),
          {
            app: module,
            sourceChannel: `${module}.${channel}`,
            sourceEvent: `${module}.${event}`,
            jobs: syncedJobs,
          }
        );
      }
    });
    runtimeJobsStore.upsertMany([
      {
        jobId: "badger:ingest:user-chain:job-ready-1",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "queued",
        stageCode: "ready",
        stageLabel: "Ready to start",
        progress: { mode: "none", completed: null, total: null, unit: null },
        payload: {
          userId: "user-chain",
          matchedMediaId: "media-job-ready-1",
          filename: "/tmp/job-ready-1.mkv",
        },
        outputs: {},
        errorCode: null,
        errorMessage: null,
        retryable: false,
        cancelRequested: false,
        priority: 0,
        dedupeKey: null,
        createdAt: "2026-03-23T12:00:00.000Z",
        updatedAt: "2026-03-23T12:00:00.000Z",
        startedAt: null,
        finishedAt: null,
      },
      {
        jobId: "badger:ingest:user-chain:job-ready-2",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "queued",
        stageCode: "ready",
        stageLabel: "Ready to start",
        progress: { mode: "none", completed: null, total: null, unit: null },
        payload: {
          userId: "user-chain",
          matchedMediaId: "media-job-ready-2",
          filename: "/tmp/job-ready-2.mkv",
        },
        outputs: {},
        errorCode: null,
        errorMessage: null,
        retryable: false,
        cancelRequested: false,
        priority: 0,
        dedupeKey: null,
        createdAt: "2026-03-23T12:00:01.000Z",
        updatedAt: "2026-03-23T12:00:01.000Z",
        startedAt: null,
        finishedAt: null,
      },
    ]);

    console.info(`[${SUITE}:${label}] initial driveRuntimeJobsOnce — expecting job-ready-1 to start`);
    await driveRuntimeJobsOnce();
    const job1AfterDrive = runtimeJobsStore.get("badger:ingest:user-chain:job-ready-1");
    const job2AfterDrive = runtimeJobsStore.get("badger:ingest:user-chain:job-ready-2");
    console.info(`[${SUITE}:${label}] post-initial-drive startedJobIds=${JSON.stringify(startedJobIds)} job1=${job1AfterDrive?.status} job2=${job2AfterDrive?.status}`);
    try {
      expect(startedJobIds).toEqual(["job-ready-1"]);
      expect(job1AfterDrive?.status).toBe("running");
      expect(job2AfterDrive?.status).toBe("queued");
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-chain",
        startedJobIds: [...startedJobIds],
        jobs: { job1: job1AfterDrive, job2: job2AfterDrive },
        expected: {
          startedJobIds: ["job-ready-1"],
          job1Status: "running",
          job2Status: "queued",
        },
        actual: {
          startedJobIds: [...startedJobIds],
          job1Status: job1AfterDrive?.status,
          job2Status: job2AfterDrive?.status,
        },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] publishing async ingest.jobs_updated event marking job-ready-1 done, job-ready-2 ready`);
    (asyncEventPublisher as ((channel: string, event: string, payload: Record<string, unknown>) => void) | null)?.("ingest", "ingest.jobs_updated", {
      userId: "user-chain",
      jobs: [
        {
          id: "job-ready-1",
          filename: "/tmp/job-ready-1.mkv",
          status: "done",
          progress: 100,
          createdAt: "2026-03-23T12:00:00.000Z",
          completedAt: "2026-03-23T12:05:00.000Z",
          matchedMediaId: "media-job-ready-1",
        },
        {
          id: "job-ready-2",
          filename: "/tmp/job-ready-2.mkv",
          status: "ready",
          progress: 0,
          createdAt: "2026-03-23T12:00:01.000Z",
          matchedMediaId: "media-job-ready-2",
        },
      ],
    });
    await vi.runAllTimersAsync();
    console.info(`[${SUITE}:${label}] waiting for job-ready-2 to be started as a side effect of the async event`);
    try {
      await vi.waitFor(() => {
        expect(startedJobIds).toEqual(["job-ready-1", "job-ready-2"]);
      });
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-chain",
        startedJobIds: [...startedJobIds],
        expected: ["job-ready-1", "job-ready-2"],
        actual: [...startedJobIds],
        jobs: {
          job1: runtimeJobsStore.get("badger:ingest:user-chain:job-ready-1"),
          job2: runtimeJobsStore.get("badger:ingest:user-chain:job-ready-2"),
        },
        error: err,
      });
      throw err;
    }

    const job1Final = runtimeJobsStore.get("badger:ingest:user-chain:job-ready-1");
    const job2Final = runtimeJobsStore.get("badger:ingest:user-chain:job-ready-2");
    console.info(`[${SUITE}:${label}] final job1=${job1Final?.status} job2=${job2Final?.status}`);
    try {
      expect(job1Final?.status).toBe("succeeded");
      expect(job2Final?.status).toBe("running");
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-chain",
        startedJobIds: [...startedJobIds],
        jobs: { job1: job1Final, job2: job2Final },
        expected: { job1Status: "succeeded", job2Status: "running" },
        actual: { job1Status: job1Final?.status, job2Status: job2Final?.status },
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof reconciles active badger jobs from the module snapshot when an async completion event is missed", async () => {
    const label = "reconcile-from-module-snapshot";
    console.info(`[${SUITE}:${label}] setting up custom mocked badger module with list_jobs handler`);
    const startedJobIds: string[] = [];
    let completedFirstJob = false;
    const badgerModule = {
      execute: vi.fn(async (request: RuntimeCommandRequest) => {
        if (request.command === "badger.ingest.list_jobs") {
          return {
            response: {
              requestId: request.requestId,
              ok: true,
              result: {
                userId: "user-reconcile",
                jobs: [
                  {
                    id: "job-ready-1",
                    filename: "/tmp/job-ready-1.mkv",
                    status: completedFirstJob ? "done" : "transcoding",
                    progress: completedFirstJob ? 100 : 25,
                    createdAt: "2026-03-23T12:00:00.000Z",
                    ...(completedFirstJob ? { completedAt: "2026-03-23T12:05:00.000Z" } : {}),
                    matchedMediaId: "media-job-ready-1",
                  },
                  {
                    id: "job-ready-2",
                    filename: "/tmp/job-ready-2.mkv",
                    status: "ready",
                    progress: 0,
                    createdAt: "2026-03-23T12:00:01.000Z",
                    matchedMediaId: "media-job-ready-2",
                  },
                ],
              },
              error: null,
            },
          };
        }
        const actions = Array.isArray(request.payload.actions) ? request.payload.actions : [];
        const startAction = actions.find(
          (entry): entry is { type: "start_job"; jobId: string } =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { type?: unknown }).type === "start_job" &&
            typeof (entry as { jobId?: unknown }).jobId === "string"
        );
        if (!startAction) {
          return {
            response: {
              requestId: request.requestId,
              ok: false,
              result: null,
              error: {
                code: "invalid_payload",
                message: "missing_start_job",
                retryable: false,
                details: {},
              },
            },
          };
        }
        startedJobIds.push(startAction.jobId);
        return {
          response: {
            requestId: request.requestId,
            ok: true,
            result: {
              userId: "user-reconcile",
              jobs: [
                {
                  id: startAction.jobId,
                  filename: `/tmp/${startAction.jobId}.mkv`,
                  status: "transcoding",
                  progress: 0,
                  createdAt: startAction.jobId === "job-ready-1" ? "2026-03-23T12:00:00.000Z" : "2026-03-23T12:00:01.000Z",
                  matchedMediaId: `media-${startAction.jobId}`,
                },
              ],
            },
            error: null,
          },
        };
      }),
      shutdown: vi.fn(),
      setEventPublisher: vi.fn(),
      getStateSummary: vi.fn(() => null),
      getSchedulingHints: vi.fn(() => ({ maxParallelTranscodes: 1 })),
    } as unknown as BadgerModule;
    setBadgerModuleForTests(badgerModule);

    runtimeJobsStore.upsertMany([
      {
        jobId: "badger:ingest:user-reconcile:job-ready-1",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "queued",
        stageCode: "ready",
        stageLabel: "Ready to start",
        progress: { mode: "none", completed: null, total: null, unit: null },
        payload: {
          userId: "user-reconcile",
          matchedMediaId: "media-job-ready-1",
          filename: "/tmp/job-ready-1.mkv",
        },
        outputs: {},
        errorCode: null,
        errorMessage: null,
        retryable: false,
        cancelRequested: false,
        priority: 0,
        dedupeKey: null,
        createdAt: "2026-03-23T12:00:00.000Z",
        updatedAt: "2026-03-23T12:00:00.000Z",
        startedAt: null,
        finishedAt: null,
      },
      {
        jobId: "badger:ingest:user-reconcile:job-ready-2",
        app: "badger",
        kind: "badger.ingest.media_file",
        lane: "cpu",
        status: "queued",
        stageCode: "ready",
        stageLabel: "Ready to start",
        progress: { mode: "none", completed: null, total: null, unit: null },
        payload: {
          userId: "user-reconcile",
          matchedMediaId: "media-job-ready-2",
          filename: "/tmp/job-ready-2.mkv",
        },
        outputs: {},
        errorCode: null,
        errorMessage: null,
        retryable: false,
        cancelRequested: false,
        priority: 0,
        dedupeKey: null,
        createdAt: "2026-03-23T12:00:01.000Z",
        updatedAt: "2026-03-23T12:00:01.000Z",
        startedAt: null,
        finishedAt: null,
      },
    ]);

    console.info(`[${SUITE}:${label}] initial driveRuntimeJobsOnce`);
    await driveRuntimeJobsOnce();
    console.info(`[${SUITE}:${label}] post-initial-drive startedJobIds=${JSON.stringify(startedJobIds)}`);
    try {
      expect(startedJobIds).toEqual(["job-ready-1"]);
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-reconcile",
        startedJobIds: [...startedJobIds],
        expected: ["job-ready-1"],
        actual: [...startedJobIds],
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] flipping module-side completion flag to mark job-ready-1 done`);
    completedFirstJob = true;

    console.info(`[${SUITE}:${label}] calling reconcileActiveRuntimeJobsFromModules to sync missed completion`);
    const reconciled = await reconcileActiveRuntimeJobsFromModules();
    const job1AfterReconcile = runtimeJobsStore.get("badger:ingest:user-reconcile:job-ready-1");
    const job2AfterReconcile = runtimeJobsStore.get("badger:ingest:user-reconcile:job-ready-2");
    console.info(`[${SUITE}:${label}] post-reconcile job1=${job1AfterReconcile?.status} job2=${job2AfterReconcile?.status} reconciledCount=${reconciled.length}`);
    try {
      expect(reconciled.map((job) => job.jobId).sort()).toEqual([
        "badger:ingest:user-reconcile:job-ready-1",
        "badger:ingest:user-reconcile:job-ready-2",
      ]);
      expect(job1AfterReconcile?.status).toBe("succeeded");
      expect(job2AfterReconcile?.status).toBe("queued");
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-reconcile",
        reconciled,
        jobs: { job1: job1AfterReconcile, job2: job2AfterReconcile },
        expected: {
          reconciledIds: ["badger:ingest:user-reconcile:job-ready-1", "badger:ingest:user-reconcile:job-ready-2"],
          job1Status: "succeeded",
          job2Status: "queued",
        },
        actual: {
          reconciledIds: reconciled.map((j) => j.jobId).sort(),
          job1Status: job1AfterReconcile?.status,
          job2Status: job2AfterReconcile?.status,
        },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] second driveRuntimeJobsOnce to start job-ready-2`);
    await driveRuntimeJobsOnce();
    const job2Final = runtimeJobsStore.get("badger:ingest:user-reconcile:job-ready-2");
    console.info(`[${SUITE}:${label}] post-second-drive startedJobIds=${JSON.stringify(startedJobIds)} job2=${job2Final?.status}`);
    try {
      expect(startedJobIds).toEqual(["job-ready-1", "job-ready-2"]);
      expect(job2Final?.status).toBe("running");
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-reconcile",
        startedJobIds: [...startedJobIds],
        job: job2Final,
        expected: { startedJobIds: ["job-ready-1", "job-ready-2"], job2Status: "running" },
        actual: { startedJobIds: [...startedJobIds], job2Status: job2Final?.status },
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof requeues persisted running badger jobs when executors install so restart recovery does not strand them forever", async () => {
    const label = "requeue-persisted-running-on-restart";
    console.info(`[${SUITE}:${label}] simulating restart with a persisted running badger job already in the store`);
    const startedJobIds: string[] = [];
    const badgerModule = {
      execute: vi.fn(async (request: RuntimeCommandRequest) => {
        const actions = Array.isArray(request.payload.actions) ? request.payload.actions : [];
        const startAction = actions.find(
          (entry): entry is { type: "start_job"; jobId: string } =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { type?: unknown }).type === "start_job" &&
            typeof (entry as { jobId?: unknown }).jobId === "string"
        );
        if (!startAction) {
          return {
            response: {
              requestId: request.requestId,
              ok: false,
              result: null,
              error: {
                code: "invalid_payload",
                message: "missing_start_job",
                retryable: false,
                details: {},
              },
            },
          };
        }
        startedJobIds.push(startAction.jobId);
        return {
          response: {
            requestId: request.requestId,
            ok: true,
            result: {
              userId: "user-recover",
              jobs: [
                {
                  id: startAction.jobId,
                  filename: `/tmp/${startAction.jobId}.mkv`,
                  status: "transcoding",
                  progress: 0,
                  createdAt: "2026-03-23T12:00:00.000Z",
                  matchedMediaId: `media-${startAction.jobId}`,
                },
              ],
            },
            error: null,
          },
        };
      }),
      shutdown: vi.fn(),
      setEventPublisher: vi.fn(),
      getStateSummary: vi.fn(() => null),
      getSchedulingHints: vi.fn(() => ({ maxParallelTranscodes: 1 })),
    } as unknown as BadgerModule;

    runtimeJobsStore.upsert({
      jobId: "badger:ingest:user-recover:job-running-1",
      app: "badger",
      kind: "badger.ingest.media_file",
      lane: "cpu",
      status: "running",
      stageCode: "transcoding",
      stageLabel: "Processing",
      progress: { mode: "fraction", completed: 41, total: 100, unit: "percent" },
      payload: {
        userId: "user-recover",
        matchedMediaId: "media-job-running-1",
        filename: "/tmp/job-running-1.mkv",
      },
      outputs: {},
      errorCode: null,
      errorMessage: null,
      retryable: true,
      cancelRequested: false,
      priority: 0,
      dedupeKey: null,
      createdAt: "2026-03-23T12:00:00.000Z",
      updatedAt: "2026-03-23T12:00:30.000Z",
      startedAt: "2026-03-23T12:00:05.000Z",
      finishedAt: null,
    });

    setBadgerModuleForTests(badgerModule);
    const kickWorker = vi.fn();
    console.info(`[${SUITE}:${label}] calling bootstrapRuntimeJobs to install executors and trigger restart recovery`);
    const bootstrap = bootstrapRuntimeJobs({
      startWorker: false,
      kickWorkerFn: kickWorker,
    });

    const requeued = runtimeJobsStore.get("badger:ingest:user-recover:job-running-1");
    console.info(`[${SUITE}:${label}] post-bootstrap kicked=${bootstrap.kicked} kickWorkerCalls=${kickWorker.mock.calls.length} status=${requeued?.status} stageCode=${requeued?.stageCode}`);
    try {
      expect(bootstrap.kicked).toBe(true);
      expect(requeued).toEqual(
        expect.objectContaining({
          status: "queued",
          stageCode: "queued",
          stageLabel: "Queued",
          startedAt: null,
          finishedAt: null,
        })
      );
      expect(kickWorker).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-recover",
        jobId: "badger:ingest:user-recover:job-running-1",
        job: requeued,
        bootstrap,
        kickWorkerCalls: kickWorker.mock.calls.length,
        expected: {
          bootstrapKicked: true,
          status: "queued",
          stageCode: "queued",
          stageLabel: "Queued",
          startedAt: null,
          finishedAt: null,
          kickWorkerCalls: 1,
        },
        actual: {
          bootstrapKicked: bootstrap.kicked,
          status: requeued?.status,
          stageCode: requeued?.stageCode,
          stageLabel: requeued?.stageLabel,
          startedAt: requeued?.startedAt,
          finishedAt: requeued?.finishedAt,
          kickWorkerCalls: kickWorker.mock.calls.length,
        },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] driving runtime jobs to actually start the recovered job`);
    const ran = await driveRuntimeJobsOnce();
    const recovered = runtimeJobsStore.get("badger:ingest:user-recover:job-running-1");
    console.info(`[${SUITE}:${label}] post-drive ran=${ran} startedJobIds=${JSON.stringify(startedJobIds)} status=${recovered?.status} stageCode=${recovered?.stageCode}`);
    try {
      expect(ran).toBe(true);
      expect(startedJobIds).toEqual(["job-running-1"]);
      expect(recovered).toEqual(
        expect.objectContaining({
          status: "running",
          stageCode: "transcoding",
        })
      );
    } catch (err) {
      dumpRuntimeJobExecutorsSnapshot(label, {
        userId: "user-recover",
        jobId: "badger:ingest:user-recover:job-running-1",
        job: recovered,
        drivenRan: ran,
        startedJobIds: [...startedJobIds],
        expected: { ran: true, startedJobIds: ["job-running-1"], status: "running", stageCode: "transcoding" },
        actual: {
          ran,
          startedJobIds: [...startedJobIds],
          status: recovered?.status,
          stageCode: recovered?.stageCode,
        },
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });
});
