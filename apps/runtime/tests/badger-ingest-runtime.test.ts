import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import { runtimeJobsStore } from "../src/core/jobs/store";

const SUITE = "badger-ingest-runtime";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerIngestRuntimeSnapshot = (
  label: string,
  ctx: {
    userId?: string;
    jobId?: string;
    requestId?: string;
    command?: string;
    module?: string;
    payload?: unknown;
    request?: Record<string, unknown>;
    response?: unknown;
    responseOk?: boolean;
    jobs?: unknown;
    job?: unknown;
    jobStatus?: string;
    jobProgress?: number;
    matchedMediaId?: string;
    manualSelectedId?: string;
    pendingKey?: string;
    detectedSeason?: number;
    detectedEpisode?: number;
    selectedFormats?: unknown;
    produced?: unknown;
    publishedEvents?: unknown;
    publishedCount?: number;
    processMediaJobCalls?: number;
    processMediaJobArgs?: unknown;
    abortObserved?: boolean;
    expected?: unknown;
    actual?: unknown;
    tempRoot?: string;
    jobStateJson?: unknown;
    transcodeDirEnv?: string | null;
    runtimeJobs?: unknown;
    runtimeJobsCount?: number;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-ingest-runtime snapshot ===`);
    if (ctx.userId !== undefined) console.error(`userId: ${ctx.userId}`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
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
    if (ctx.jobs !== undefined) {
      console.error(`jobs:\n${JSON.stringify(ctx.jobs, jsonReplacer, 2)}`);
    }
    if (ctx.job !== undefined) {
      console.error(`job:\n${JSON.stringify(ctx.job, jsonReplacer, 2)}`);
    }
    if (ctx.jobStatus !== undefined) console.error(`jobStatus: ${ctx.jobStatus}`);
    if (ctx.jobProgress !== undefined) console.error(`jobProgress: ${ctx.jobProgress}`);
    if (ctx.matchedMediaId !== undefined) console.error(`matchedMediaId: ${ctx.matchedMediaId}`);
    if (ctx.manualSelectedId !== undefined) console.error(`manualSelectedId: ${ctx.manualSelectedId}`);
    if (ctx.pendingKey !== undefined) console.error(`pendingKey: ${ctx.pendingKey}`);
    if (ctx.detectedSeason !== undefined) console.error(`detectedSeason: ${ctx.detectedSeason}`);
    if (ctx.detectedEpisode !== undefined) console.error(`detectedEpisode: ${ctx.detectedEpisode}`);
    if (ctx.selectedFormats !== undefined) {
      console.error(`selectedFormats:\n${JSON.stringify(ctx.selectedFormats, jsonReplacer, 2)}`);
    }
    if (ctx.produced !== undefined) {
      console.error(`produced:\n${JSON.stringify(ctx.produced, jsonReplacer, 2)}`);
    }
    if (ctx.publishedEvents !== undefined) {
      console.error(`publishedEvents:\n${JSON.stringify(ctx.publishedEvents, jsonReplacer, 2)}`);
    }
    if (ctx.publishedCount !== undefined) console.error(`publishedCount: ${ctx.publishedCount}`);
    if (ctx.processMediaJobCalls !== undefined) {
      console.error(`processMediaJobCalls: ${ctx.processMediaJobCalls}`);
    }
    if (ctx.processMediaJobArgs !== undefined) {
      console.error(`processMediaJobArgs:\n${JSON.stringify(ctx.processMediaJobArgs, jsonReplacer, 2)}`);
    }
    if (ctx.abortObserved !== undefined) console.error(`abortObserved: ${ctx.abortObserved}`);
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.tempRoot !== undefined) console.error(`tempRoot: ${ctx.tempRoot}`);
    if (ctx.jobStateJson !== undefined) {
      console.error(`jobStateJson:\n${JSON.stringify(ctx.jobStateJson, jsonReplacer, 2)}`);
    }
    if (ctx.transcodeDirEnv !== undefined) {
      console.error(`transcodeDirEnv: ${ctx.transcodeDirEnv ?? "(unset)"}`);
    }
    if (ctx.runtimeJobs !== undefined) {
      console.error(`runtimeJobs:\n${JSON.stringify(ctx.runtimeJobs, jsonReplacer, 2)}`);
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
  } catch (err) {
    console.error(
      `=== [${SUITE}:${label}] (snapshot failed: ${err instanceof Error ? err.message : String(err)}) ===`
    );
  }
};

const startQueuedBadgerJob = async (module: BadgerModule, userId: string, jobId: string) => {
  console.info(`[${SUITE}:start-queued-job] userId=${userId} jobId=${jobId}`);
  await module.execute({
    requestId: `start-${jobId}`,
    module: "badger",
    command: "badger.ingest.apply",
    payload: {
      userId,
      actions: [{ type: "start_job", jobId }],
    },
  });
};

describe("badger ingest runtime", () => {
  console.info(`[${SUITE}:describe] entering "badger ingest runtime"`);
  it("@bugfix @regression-proof reports cancelled jobs as cancelled instead of failed and does not preserve live ingest logs by default", async () => {
    const label = "cancelled-job-reports-cancelled";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async ({ signal, onLog }: any) => {
      onLog?.("ffmpeg line 1");
      onLog?.("ffmpeg line 2");
      signal?.throwIfAborted?.();
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const module = new BadgerModule({ processMediaJob: processMediaJob as any });

    await module.execute({
      requestId: "open-cancelled",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-cancelled",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    await module.execute({
      requestId: "queue-cancelled",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-cancelled",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-cancelled",
                filename: "/tmp/Lodgers S01E01.mkv",
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
                id: "media-tv-cancelled",
                type: "tv",
                tmdbId: 123,
                title: "Lodgers",
                year: "1994",
                posterPath: "/lodgers.jpg",
                originalLanguage: "en",
              },
            },
          },
        ],
      },
    });

    await startQueuedBadgerJob(module, "user-cancelled", "job-cancelled");

    console.info(`[${SUITE}:${label}] waiting for processMediaJob to be invoked`);
    try {
      await vi.waitFor(() => {
        expect(processMediaJob).toHaveBeenCalledTimes(1);
      });
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-cancelled",
        jobId: "job-cancelled",
        processMediaJobCalls: processMediaJob.mock.calls.length,
        expected: "processMediaJob called once",
        actual: `called ${processMediaJob.mock.calls.length} times`,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] dispatching cancel_job action`);
    await module.execute({
      requestId: "cancel-cancelled",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-cancelled",
        actions: [{ type: "cancel_job", jobId: "job-cancelled" }],
      },
    });

    const listed = await module.execute({
      requestId: "list-cancelled",
      module: "badger",
      command: "badger.ingest.list_jobs",
      payload: { userId: "user-cancelled" },
    });

    try {
      expect(listed.response.ok).toBe(true);
      const jobs = listed.response.ok ? (listed.response.result.jobs as Array<Record<string, unknown>>) : [];
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: "job-cancelled",
        status: "cancelled",
      });
      expect(Array.isArray(jobs[0]?.logs) ? jobs[0].logs : []).toEqual([]);
    } catch (err) {
      const jobs = listed.response.ok ? (listed.response.result.jobs as Array<Record<string, unknown>>) : [];
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-cancelled",
        jobId: "job-cancelled",
        response: listed.response,
        responseOk: listed.response.ok,
        jobs,
        jobStatus: jobs[0]?.status as string,
        expected: { id: "job-cancelled", status: "cancelled", logs: [] },
        actual: jobs[0],
        error: err,
      });
      throw err;
    }

    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof rehydrates queued canonical jobs when reopening the badger ingest queue after a runtime restart", async () => {
    const label = "rehydrate-queued-on-reopen";
    console.info(`[${SUITE}:${label}] start — resetting runtimeJobsStore`);
    runtimeJobsStore.reset();
    const processMediaJob = vi.fn(async () => ({
      produced: {
        videoFormats: [
          {
            quality: "1080p",
            codec: "hevc",
            codecString: "hev1.2.4.L123.B0",
            initKey: "video-init",
            initSize: 128,
            durationSeconds: 42,
            totalSize: 1_000_000,
            chunks: [{ key: "seg-1", sizeBytes: 512_000, startSeconds: 0 }],
          },
        ],
        audioTracks: [],
        subtitleTracks: [],
      },
      encoder: "cpu" as const,
    }));
    runtimeJobsStore.upsert({
      jobId: "badger:ingest:user-1:job-1",
      app: "badger",
      kind: "badger.ingest.media_file",
      lane: "cpu",
      status: "queued",
      stageCode: "ready",
      stageLabel: "Ready to start",
      progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
      payload: {
        userId: "user-1",
        id: "job-1",
        filename: "/tmp/Lodgers - S03E01.mkv",
        queueSequence: 1,
        status: "ready",
        progress: 0,
        createdAt: "2026-03-25T18:54:38.547Z",
        matchedMediaId: "media-1",
        matchedTo: {
          title: "Lodgers",
          year: "1994",
          posterPath: "/lodgers.jpg",
          type: "tv",
        },
        detectedSeason: 3,
        detectedEpisode: 1,
        includeSource: true,
        includeFallback: false,
        includeAudio: true,
        includeSubtitles: true,
        includeChapters: true,
        selectedFormats: [{ quality: "1080p", codec: "hevc" }],
      },
      outputs: {},
      errorCode: null,
      errorMessage: null,
      retryable: false,
      resourceClaims: ["cpuHeavy", "diskHeavy"],
      scheduling: {
        submittedOrder: 1,
        collectionKey: "badger:tv:media-1",
        mediaOrder: 30001,
        phaseOrder: 0,
        variantOrder: 0,
      },
      attemptCount: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      cancelRequested: false,
      priority: 0,
      dedupeKey: null,
      createdAt: "2026-03-25T18:54:38.547Z",
      updatedAt: "2026-03-25T18:54:38.547Z",
      startedAt: null,
      finishedAt: null,
    });
    const module = new BadgerModule({ processMediaJob });

    console.info(`[${SUITE}:${label}] reopening ingest after upsert into runtimeJobsStore`);
    const opened = await module.execute({
      requestId: "open-rehydrate",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-1",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "1080p", codec: "hevc" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    try {
      expect(opened.response.ok).toBe(true);
      expect(opened.response.ok ? opened.response.result.totalJobs : 0).toBe(1);
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-1",
        jobId: "badger:ingest:user-1:job-1",
        response: opened.response,
        responseOk: opened.response.ok,
        expected: { totalJobs: 1 },
        actual: opened.response.ok ? opened.response.result.totalJobs : null,
        error: err,
      });
      throw err;
    }

    const listed = await module.execute({
      requestId: "list-rehydrate",
      module: "badger",
      command: "badger.ingest.list_jobs",
      payload: { userId: "user-1" },
    });

    try {
      expect(listed.response.ok).toBe(true);
      const jobs = listed.response.ok ? (listed.response.result.jobs as Array<Record<string, unknown>>) : [];
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: "job-1",
        status: "ready",
        matchedMediaId: "media-1",
      });
    } catch (err) {
      const jobs = listed.response.ok ? (listed.response.result.jobs as Array<Record<string, unknown>>) : [];
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-1",
        jobId: "job-1",
        response: listed.response,
        responseOk: listed.response.ok,
        jobs,
        expected: { id: "job-1", status: "ready", matchedMediaId: "media-1" },
        actual: jobs[0],
        error: err,
      });
      throw err;
    }

    runtimeJobsStore.reset();
    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof processes matched queue jobs instead of leaving them queued forever", async () => {
    const label = "processes-matched-queue-jobs";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async () => ({
      produced: {
        videoFormats: [
          {
            quality: "1080p",
            codec: "h264",
            codecString: "avc1.640028",
            initKey: "init-key",
            initSize: 128,
            durationSeconds: 42,
            totalSize: 1_000_000,
            chunks: [{ key: "seg-1", sizeBytes: 512_000, startSeconds: 0 }],
          },
        ],
        audioTracks: [],
        subtitleTracks: [],
      },
      encoder: "cpu" as const,
    }));
    const module = new BadgerModule({ processMediaJob });

    await module.execute({
      requestId: "open",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-1",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "1080p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    await module.execute({
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
                id: "job-1",
                filename: "/tmp/Orchard.mkv",
                sizeMb: 100,
                includeSource: true,
                includeFallback: false,
                includeAudio: true,
                includeSubtitles: true,
                includeChapters: true,
                selectedFormats: [{ quality: "1080p", codec: "h264" }],
              },
            ],
            preset: {
              media: {
                id: "media-1",
                type: "movie",
                tmdbId: 123,
                title: "Orchard",
                year: "2017",
                posterPath: "/orchard.jpg",
                originalLanguage: "en",
              },
            },
          },
        ],
      },
    });

    await startQueuedBadgerJob(module, "user-1", "job-1");

    console.info(`[${SUITE}:${label}] waiting for job-1 to reach status=done`);
    try {
      await vi.waitFor(async () => {
        const result = await module.execute({
          requestId: "list",
          module: "badger",
          command: "badger.ingest.list_jobs",
          payload: {
            userId: "user-1",
          },
        });
        expect(result.response.ok).toBe(true);
        const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          id: "job-1",
          status: "done",
          matchedMediaId: "media-1",
        });
        expect(jobs[0].produced).toBeTruthy();
      });

      expect(processMediaJob).toHaveBeenCalledTimes(1);
    } catch (err) {
      const result = await module.execute({
        requestId: "list-fail-snapshot",
        module: "badger",
        command: "badger.ingest.list_jobs",
        payload: { userId: "user-1" },
      });
      const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-1",
        jobId: "job-1",
        response: result.response,
        responseOk: result.response.ok,
        jobs,
        jobStatus: jobs[0]?.status as string,
        processMediaJobCalls: processMediaJob.mock.calls.length,
        expected: { id: "job-1", status: "done", matchedMediaId: "media-1" },
        actual: jobs[0],
        error: err,
      });
      throw err;
    }

    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  // #145: a legacy `queue_format_jobs` job adds a format to an existing file,
  // so it uploads under the placement that file's objects already live on.
  it("queue_format_jobs reuses the existing file's placementId (#145)", async () => {
    const label = "format-job-reuses-file-placement";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async (_input: { placementId: string }) => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu" as const,
    }));
    const module = new BadgerModule({ processMediaJob });
    const originalCall = module.libraryDbService.call.bind(module.libraryDbService);
    const libraryCall = vi.spyOn(module.libraryDbService, "call").mockImplementation(async (method, args) => {
      if (method !== "listMediaFormats") return originalCall(method, args);
      console.info(`[${SUITE}:${label}] listMediaFormats args=${JSON.stringify(args)}`);
      return [
        // A sibling file of the same media (other episode) on another silo.
        { fileId: "file-other", initKey: "media/placement-sibling/init", chunks: [] },
        { fileId: "file-1", initKey: null, chunks: [{ key: "media/placement-file-1/seg-1" }] },
      ];
    });

    await module.execute({
      requestId: "open",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-1",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "720p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });
    await module.execute({
      requestId: "apply",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-1",
        actions: [
          {
            type: "queue_format_jobs",
            jobs: [
              {
                id: "format-job-0001",
                mediaId: "media-1",
                fileId: "file-1",
                filename: "/tmp/Orchard.mkv",
                formats: [{ quality: "720p", codec: "h264" }],
              },
            ],
          },
        ],
      },
    });
    await startQueuedBadgerJob(module, "user-1", "format-job-0001");

    try {
      await vi.waitFor(() => expect(processMediaJob).toHaveBeenCalledTimes(1));
      const placementId = processMediaJob.mock.calls[0]?.[0].placementId;
      console.info(`[${SUITE}:${label}] processMediaJob placementId=${placementId}`);
      expect(placementId).toBe("placement-file-1");
      expect(libraryCall).toHaveBeenCalledWith("listMediaFormats", ["media-1"]);
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-1",
        jobId: "format-job-0001",
        processMediaJobCalls: processMediaJob.mock.calls.length,
        processMediaJobArgs: processMediaJob.mock.calls[0]?.[0],
        error: err,
      });
      throw err;
    }

    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof recovers a stale source job from completed persisted state", async () => {
    const label = "recovers-stale-source-from-persisted-state";
    console.info(`[${SUITE}:${label}] start`);
    const tempRoot = mkdtempSync(joinPath(tmpdir(), "spacefleet-badger-runtime-"));
    const previousDir = process.env.SF_TRANSCODE_DIR;
    process.env.SF_TRANSCODE_DIR = tempRoot;
    console.info(`[${SUITE}:${label}] tempRoot=${tempRoot} SF_TRANSCODE_DIR override applied`);
    try {
      const processMediaJob = vi.fn(
        async () =>
          await new Promise<never>(() => {
            // Simulate a stuck in-memory task. Recovery should come from job_state.json instead.
          })
      );
      const module = new BadgerModule({ processMediaJob });

      const userId = "user-1";
      const jobId = "job-1";
      const jobDir = joinPath(tempRoot, userId, jobId);
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(
        joinPath(jobDir, "job_state.json"),
        JSON.stringify({
          version: 1,
          inputPath: "/tmp/Glass Circuit.mkv",
          userId,
          createdAt: "2026-03-13T10:00:00.000Z",
          outputs: [
            {
              id: "video-source",
              kind: "video",
              quality: "1080p",
              codec: "hevc",
              codecString: "hev1.2.4.L123.B0",
              encodingComplete: true,
              durationSeconds: 42,
              totalSize: 1000,
              init: { key: "video-init", uploaded: true, sizeBytes: 10 },
              segments: [{ key: "video-seg", uploaded: true, sizeBytes: 100, startSeconds: 0 }],
            },
            {
              id: "audio-0",
              kind: "audio",
              language: "ja",
              label: "JPN",
              codec: "aac",
              codecString: "mp4a.40.2",
              encodingComplete: true,
              durationSeconds: 42,
              totalSize: 500,
              init: { key: "audio-init", uploaded: true, sizeBytes: 5 },
              segments: [{ key: "audio-seg", uploaded: true, sizeBytes: 50, startSeconds: 0 }],
            },
          ],
          subtitles: [
            {
              id: "sub-0",
              language: "en",
              label: "ENG",
              format: "srt",
              key: "subtitle-key",
              uploaded: true,
            },
          ],
        }),
        "utf8"
      );

      await module.execute({
        requestId: "open",
        module: "badger",
        command: "badger.ingest.open",
        payload: {
          userId,
          config: {
            enableCodecSelection: false,
            transcodeOutputs: [{ quality: "1080p", codec: "hevc" }],
            uiLanguage: "en",
            token: "backend-token",
            libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
          },
        },
      });

      await module.execute({
        requestId: "apply",
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
                  filename: "/tmp/Glass Circuit.mkv",
                  sizeMb: 100,
                  includeSource: true,
                  includeFallback: false,
                  includeAudio: true,
                  includeSubtitles: true,
                  includeChapters: true,
                  selectedFormats: [{ quality: "1080p", codec: "hevc" }],
                },
              ],
              preset: {
                media: {
                  id: "media-1",
                  type: "movie",
                  tmdbId: 123,
                  title: "Glass Circuit",
                  year: "1995",
                  posterPath: "/glass-circuit.jpg",
                  originalLanguage: "ja",
                },
              },
            },
          ],
        },
      });

      await startQueuedBadgerJob(module, userId, jobId);

      const result = await module.execute({
        requestId: "list",
        module: "badger",
        command: "badger.ingest.list_jobs",
        payload: { userId },
      });
      try {
        expect(result.response.ok).toBe(true);
        const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
        expect(jobs[0]).toMatchObject({
          id: jobId,
          status: "done",
          matchedMediaId: "media-1",
        });
        expect(jobs[0]?.produced).toMatchObject({
          videoFormats: [{ quality: "1080p", codec: "hevc" }],
          audioTracks: [{ language: "ja", label: "JPN" }],
          subtitleTracks: [{ language: "en", label: "ENG", objectKey: "subtitle-key" }],
        });
      } catch (err) {
        const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
        dumpBadgerIngestRuntimeSnapshot(label, {
          userId,
          jobId,
          tempRoot,
          transcodeDirEnv: process.env.SF_TRANSCODE_DIR ?? null,
          response: result.response,
          responseOk: result.response.ok,
          jobs,
          produced: jobs[0]?.produced,
          expected: {
            status: "done",
            videoFormats: [{ quality: "1080p", codec: "hevc" }],
            audioTracks: [{ language: "ja", label: "JPN" }],
            subtitleTracks: [{ language: "en", label: "ENG", objectKey: "subtitle-key" }],
          },
          actual: jobs[0],
          processMediaJobCalls: processMediaJob.mock.calls.length,
          error: err,
        });
        throw err;
      }
      module.shutdown();
    } finally {
      if (previousDir === undefined) delete process.env.SF_TRANSCODE_DIR;
      else process.env.SF_TRANSCODE_DIR = previousDir;
      rmSync(tempRoot, { recursive: true, force: true });
      console.info(`[${SUITE}:${label}] cleaned up tempRoot=${tempRoot}, restored SF_TRANSCODE_DIR`);
    }
  });

  it("@bugfix @regression-proof auto-runs matched ingest with zero selected outputs and keeps the job source-only", async () => {
    const label = "auto-runs-zero-outputs-source-only";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async () => ({
      produced: {
        videoFormats: [],
        audioTracks: [],
        subtitleTracks: [],
      },
      encoder: "cpu" as const,
    }));
    const module = new BadgerModule({ processMediaJob });

    await module.execute({
      requestId: "open",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-1",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    await module.execute({
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
                id: "job-source-only",
                filename: "/tmp/Only Source.mkv",
                sizeMb: 100,
                includeSource: true,
                includeFallback: false,
                includeAudio: true,
                includeSubtitles: true,
                includeChapters: true,
                selectedFormats: [],
              },
            ],
            preset: {
              media: {
                id: "media-source-only",
                type: "movie",
                tmdbId: 321,
                title: "Only Source",
                year: "2024",
                posterPath: "/source.jpg",
                originalLanguage: "en",
              },
            },
          },
        ],
      },
    });

    await startQueuedBadgerJob(module, "user-1", "job-source-only");

    console.info(`[${SUITE}:${label}] waiting for source-only job to reach done`);
    try {
      await vi.waitFor(async () => {
        const result = await module.execute({
          requestId: "list",
          module: "badger",
          command: "badger.ingest.list_jobs",
          payload: { userId: "user-1" },
        });
        expect(result.response.ok).toBe(true);
        const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          id: "job-source-only",
          status: "done",
          matchedMediaId: "media-source-only",
          selectedFormats: [],
          produced: {
            videoFormats: [],
          },
        });
      });

      expect(processMediaJob).toHaveBeenCalledTimes(1);
      expect((processMediaJob.mock.calls[0] as any)?.[0]).toMatchObject({
        includeSource: true,
        includeFallback: false,
        includeAudio: true,
        includeSubtitles: true,
        includeChapters: true,
      });
    } catch (err) {
      const result = await module.execute({
        requestId: "list-fail-snapshot",
        module: "badger",
        command: "badger.ingest.list_jobs",
        payload: { userId: "user-1" },
      });
      const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-1",
        jobId: "job-source-only",
        response: result.response,
        responseOk: result.response.ok,
        jobs,
        processMediaJobCalls: processMediaJob.mock.calls.length,
        processMediaJobArgs: (processMediaJob.mock.calls[0] as any)?.[0],
        expected: {
          status: "done",
          matchedMediaId: "media-source-only",
          selectedFormats: [],
          includeFlags: { includeSource: true, includeFallback: false, includeAudio: true, includeSubtitles: true, includeChapters: true },
        },
        actual: jobs[0],
        error: err,
      });
      throw err;
    }
    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof parses tv episode identity for pending media and starts processing as soon as the library media is attached", async () => {
    const label = "parses-tv-identity-on-attach";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async () => ({
      produced: {
        videoFormats: [
          {
            quality: "360p",
            codec: "h264",
            codecString: "avc1.64001e",
            initKey: "video-init",
            initSize: 128,
            durationSeconds: 42,
            totalSize: 1_000_000,
            chunks: [{ key: "seg-1", sizeBytes: 512_000, startSeconds: 0 }],
          },
        ],
        audioTracks: [
          {
            language: "en",
            label: "ENG",
            codec: "aac",
            codecString: "mp4a.40.2",
            initKey: "audio-init",
            initSize: 64,
            durationSeconds: 42,
            totalSize: 250_000,
            chunks: [{ key: "audio-1", sizeBytes: 128_000, startSeconds: 0 }],
          },
        ],
        subtitleTracks: [],
      },
      encoder: "cpu" as const,
    }));
    const module = new BadgerModule({ processMediaJob });

    await module.execute({
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
    });

    await module.execute({
      requestId: "queue-pending-tv",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-1",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-tv-1",
                filename: "/tmp/Lodgers - S01E04 - The Lodger with the Paper Crown.mkv",
                sizeMb: 948,
                includeSource: true,
                includeFallback: true,
                includeAudio: true,
                includeSubtitles: true,
                includeChapters: true,
                selectedFormats: [{ quality: "360p", codec: "h264" }],
              },
            ],
            preset: {
              pendingKey: "pending-tv-1",
              pendingMedia: {
                id: "pending-tv-1",
                type: "tv",
                tmdbId: 901668,
                title: "Lodgers",
                year: "1994",
                posterPath: "/lodgers.jpg",
                originalLanguage: "en",
              },
              pendingDetails: {
                seasons: [{ id: "season-1", seasonNumber: 1, name: "Season 1" }],
                episodes: [{ id: "ep-4", seasonNumber: 1, episodeNumber: 4, name: "The Lodger with the Paper Crown" }],
              },
            },
          },
        ],
      },
    });

    console.info(`[${SUITE}:${label}] dispatching attach_pending_media for pendingKey=pending-tv-1 -> media-lodgers`);
    const attached = await module.execute({
      requestId: "attach-pending-tv",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-1",
        actions: [{ type: "attach_pending_media", pendingKey: "pending-tv-1", mediaId: "media-lodgers" }],
      },
    });
    try {
      expect(attached.response.ok).toBe(true);
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-1",
        pendingKey: "pending-tv-1",
        response: attached.response,
        responseOk: attached.response.ok,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] waiting for matched job to reach status=done with detected S1E4`);
    try {
      await vi.waitFor(async () => {
        const result = await module.execute({
          requestId: "list-pending-tv",
          module: "badger",
          command: "badger.ingest.list_jobs",
          payload: { userId: "user-1" },
        });
        expect(result.response.ok).toBe(true);
        const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          id: "job-tv-1",
          status: "done",
          matchedMediaId: "media-lodgers",
          detectedSeason: 1,
          detectedEpisode: 4,
        });
      });

      expect(processMediaJob).toHaveBeenCalledTimes(1);
      expect((processMediaJob.mock.calls[0] as any)?.[0]).toMatchObject({
        includeFallback: true,
        includeSource: true,
      });
    } catch (err) {
      const result = await module.execute({
        requestId: "list-fail-snapshot",
        module: "badger",
        command: "badger.ingest.list_jobs",
        payload: { userId: "user-1" },
      });
      const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-1",
        jobId: "job-tv-1",
        pendingKey: "pending-tv-1",
        response: result.response,
        responseOk: result.response.ok,
        jobs,
        matchedMediaId: jobs[0]?.matchedMediaId as string,
        detectedSeason: jobs[0]?.detectedSeason as number,
        detectedEpisode: jobs[0]?.detectedEpisode as number,
        processMediaJobCalls: processMediaJob.mock.calls.length,
        processMediaJobArgs: (processMediaJob.mock.calls[0] as any)?.[0],
        expected: { status: "done", matchedMediaId: "media-lodgers", detectedSeason: 1, detectedEpisode: 4 },
        actual: jobs[0],
        error: err,
      });
      throw err;
    }
    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });
  it("@bugfix @regression-proof preserves tv episode identity for queued transcode jobs", async () => {
    const label = "preserves-tv-identity-on-queue";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(async () => ({
      produced: {
        videoFormats: [],
        audioTracks: [],
        subtitleTracks: [],
      },
      encoder: "cpu" as const,
    }));
    const module = new BadgerModule({ processMediaJob });

    await module.execute({
      requestId: "open-tv",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-tv",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    await module.execute({
      requestId: "apply-tv",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-tv",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-tv-transcode",
                filename: "/tmp/Lodgers - S01E02.mkv",
                sizeMb: 100,
                jobType: "transcode",
                includeSource: false,
                includeFallback: true,
                includeAudio: false,
                includeSubtitles: false,
                includeChapters: false,
                selectedFormats: [{ quality: "360p", codec: "h264" }],
              },
            ],
            preset: {
              media: {
                id: "lodgers-media",
                type: "tv",
                tmdbId: 901668,
                title: "Lodgers",
                year: "1994",
                posterPath: "/lodgers.jpg",
                originalLanguage: "en",
              },
              season: 1,
              episode: 2,
            },
          },
        ],
      },
    });

    const result = await module.execute({
      requestId: "list-tv",
      module: "badger",
      command: "badger.ingest.list_jobs",
      payload: { userId: "user-tv" },
    });
    try {
      expect(result.response.ok).toBe(true);
      const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
      expect(jobs[0]).toMatchObject({
        id: "job-tv-transcode",
        matchedMediaId: "lodgers-media",
        detectedSeason: 1,
        detectedEpisode: 2,
      });
    } catch (err) {
      const jobs = result.response.ok ? (result.response.result.jobs as Array<Record<string, unknown>>) : [];
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-tv",
        jobId: "job-tv-transcode",
        response: result.response,
        responseOk: result.response.ok,
        jobs,
        matchedMediaId: jobs[0]?.matchedMediaId as string,
        detectedSeason: jobs[0]?.detectedSeason as number,
        detectedEpisode: jobs[0]?.detectedEpisode as number,
        expected: { matchedMediaId: "lodgers-media", detectedSeason: 1, detectedEpisode: 2 },
        actual: jobs[0],
        error: err,
      });
      throw err;
    }
    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof publishes ingest job updates while background progress advances", async () => {
    const label = "publishes-progress-updates";
    console.info(`[${SUITE}:${label}] start`);
    const processMediaJob = vi.fn(
      async (input: { onProgress?: (stage: "transcoding" | "uploading", progress: number) => void }) => {
        input.onProgress?.("transcoding", 12);
        input.onProgress?.("uploading", 48);
        return {
          produced: {
            videoFormats: [],
            audioTracks: [],
            subtitleTracks: [],
          },
          encoder: "cpu" as const,
        };
      }
    );
    const module = new BadgerModule({ processMediaJob });
    const publishedEvents: Array<{ channel: string; event: string; payload: Record<string, unknown> }> = [];
    module.setEventPublisher((channel, event, payload) => {
      publishedEvents.push({ channel, event, payload });
    });

    await module.execute({
      requestId: "open-progress",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-progress",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    await module.execute({
      requestId: "apply-progress",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-progress",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-progress",
                filename: "/tmp/Lodgers - S01E01.mkv",
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
                id: "lodgers-progress",
                type: "tv",
                tmdbId: 901668,
                title: "Lodgers",
                year: "1994",
                posterPath: "/lodgers.jpg",
                originalLanguage: "en",
              },
              season: 1,
              episode: 1,
            },
          },
        ],
      },
    });

    await startQueuedBadgerJob(module, "user-progress", "job-progress");

    console.info(`[${SUITE}:${label}] waiting for ingest.jobs_updated event with progress=12 or 48`);
    try {
      await vi.waitFor(() => {
        expect(
          publishedEvents.some(
            (entry) =>
              entry.channel === "ingest" &&
              entry.event === "ingest.jobs_updated" &&
              entry.payload.userId === "user-progress" &&
              Array.isArray(entry.payload.jobs) &&
              entry.payload.jobs.some(
                (job) =>
                  job &&
                  typeof job === "object" &&
                  (job as { id?: unknown }).id === "job-progress" &&
                  (((job as { progress?: unknown }).progress === 12 &&
                    (job as { status?: unknown }).status === "transcoding") ||
                    ((job as { progress?: unknown }).progress === 48 &&
                      (job as { status?: unknown }).status === "uploading"))
              )
          )
        ).toBe(true);
      });
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-progress",
        jobId: "job-progress",
        publishedEvents,
        publishedCount: publishedEvents.length,
        expected: "ingest.jobs_updated event with job-progress at progress=12/transcoding OR progress=48/uploading",
        actual: publishedEvents.filter(
          (e) => e.channel === "ingest" && e.event === "ingest.jobs_updated"
        ),
        error: err,
      });
      throw err;
    }

    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof aborts and removes matching media jobs when the media is deleted", async () => {
    const label = "aborts-and-removes-on-media-delete";
    console.info(`[${SUITE}:${label}] start`);
    let abortObserved = false;
    const processMediaJob = vi.fn(
      async (input: { signal?: AbortSignal }) =>
        await new Promise<never>((_, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              reject(new Error("aborted"));
            },
            { once: true }
          );
        })
    );
    const module = new BadgerModule({ processMediaJob });

    await module.execute({
      requestId: "open-delete",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-delete",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    await module.execute({
      requestId: "apply-delete",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-delete",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-delete",
                filename: "/tmp/Counsel Street - S01E01.mkv",
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
                id: "media-delete",
                type: "tv",
                tmdbId: 906059,
                title: "Counsel Street",
                year: "2015",
                posterPath: "/counsel-street.jpg",
                originalLanguage: "en",
              },
              season: 1,
              episode: 1,
            },
          },
        ],
      },
    });

    await startQueuedBadgerJob(module, "user-delete", "job-delete");

    console.info(`[${SUITE}:${label}] waiting for processMediaJob to be invoked`);
    try {
      await vi.waitFor(() => {
        expect(processMediaJob).toHaveBeenCalledTimes(1);
      });
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-delete",
        jobId: "job-delete",
        processMediaJobCalls: processMediaJob.mock.calls.length,
        expected: "processMediaJob called once",
        actual: `called ${processMediaJob.mock.calls.length} times`,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] dispatching remove_media_jobs for mediaId=media-delete`);
    const removed = await module.execute({
      requestId: "remove-delete",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-delete",
        actions: [{ type: "remove_media_jobs", mediaId: "media-delete" }],
      },
    });
    try {
      expect(removed.response.ok).toBe(true);
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-delete",
        jobId: "job-delete",
        response: removed.response,
        responseOk: removed.response.ok,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] waiting for abortObserved=true and empty jobs list`);
    try {
      await vi.waitFor(async () => {
        expect(abortObserved).toBe(true);
        const listed = await module.execute({
          requestId: "list-delete",
          module: "badger",
          command: "badger.ingest.list_jobs",
          payload: { userId: "user-delete" },
        });
        expect(listed.response.ok).toBe(true);
        const jobs = listed.response.ok ? (listed.response.result.jobs as Array<Record<string, unknown>>) : [];
        expect(jobs).toEqual([]);
      });
    } catch (err) {
      const listed = await module.execute({
        requestId: "list-fail-snapshot",
        module: "badger",
        command: "badger.ingest.list_jobs",
        payload: { userId: "user-delete" },
      });
      const jobs = listed.response.ok ? (listed.response.result.jobs as Array<Record<string, unknown>>) : [];
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-delete",
        jobId: "job-delete",
        abortObserved,
        response: listed.response,
        responseOk: listed.response.ok,
        jobs,
        expected: { abortObserved: true, jobs: [] },
        actual: { abortObserved, jobs },
        error: err,
      });
      throw err;
    }

    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof remove_media_jobs also removes jobs matched via manualSelectedId", async () => {
    const label = "remove-media-jobs-via-manualSelectedId";
    console.info(`[${SUITE}:${label}] start`);
    const module = new BadgerModule();

    await module.execute({
      requestId: "open-manual",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-manual",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    // Queue a file without a preset (no matchedMediaId)
    await module.execute({
      requestId: "apply-manual-queue",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-manual",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-manual",
                filename: "/tmp/SomeShow.mkv",
                sizeMb: 50,
              },
            ],
          },
        ],
      },
    });

    // Manually select a media for this job (sets manualSelectedId, NOT matchedMediaId)
    await module.execute({
      requestId: "apply-manual-select",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-manual",
        actions: [
          { type: "set_manual_selection", jobId: "job-manual", mediaId: "target-media" },
        ],
      },
    });

    // Verify job exists and has manualSelectedId
    const listed = await module.execute({
      requestId: "list-manual-before",
      module: "badger",
      command: "badger.ingest.list_jobs",
      payload: { userId: "user-manual" },
    });
    const jobsBefore = listed.response.ok ? (listed.response.result.jobs as Array<Record<string, unknown>>) : [];
    try {
      expect(jobsBefore).toHaveLength(1);
      expect(jobsBefore[0].manualSelectedId).toBe("target-media");
      expect(jobsBefore[0].matchedMediaId).toBeUndefined();
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-manual",
        jobId: "job-manual",
        response: listed.response,
        responseOk: listed.response.ok,
        jobs: jobsBefore,
        manualSelectedId: jobsBefore[0]?.manualSelectedId as string,
        matchedMediaId: jobsBefore[0]?.matchedMediaId as string,
        expected: { manualSelectedId: "target-media", matchedMediaId: undefined },
        actual: jobsBefore[0],
        error: err,
      });
      throw err;
    }

    // remove_media_jobs should remove the job via manualSelectedId
    console.info(`[${SUITE}:${label}] dispatching remove_media_jobs for mediaId=target-media`);
    const removed = await module.execute({
      requestId: "remove-manual",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-manual",
        actions: [{ type: "remove_media_jobs", mediaId: "target-media" }],
      },
    });
    try {
      expect(removed.response.ok).toBe(true);
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-manual",
        response: removed.response,
        responseOk: removed.response.ok,
        error: err,
      });
      throw err;
    }

    const listedAfter = await module.execute({
      requestId: "list-manual-after",
      module: "badger",
      command: "badger.ingest.list_jobs",
      payload: { userId: "user-manual" },
    });
    const jobsAfter = listedAfter.response.ok ? (listedAfter.response.result.jobs as Array<Record<string, unknown>>) : [];
    try {
      expect(jobsAfter).toEqual([]);
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-manual",
        response: listedAfter.response,
        responseOk: listedAfter.response.ok,
        jobs: jobsAfter,
        expected: [],
        actual: jobsAfter,
        error: err,
      });
      throw err;
    }

    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });

  it("@bugfix @regression-proof remove_media_jobs also removes jobs matched via pendingKey", async () => {
    const label = "remove-media-jobs-via-pendingKey";
    console.info(`[${SUITE}:${label}] start`);
    const module = new BadgerModule();

    await module.execute({
      requestId: "open-pending",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-pending",
        config: {
          enableCodecSelection: false,
          transcodeOutputs: [{ quality: "360p", codec: "h264" }],
          uiLanguage: "en",
          token: "backend-token",
          libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    });

    // Queue a file with a pendingKey preset (media not yet created)
    await module.execute({
      requestId: "apply-pending-queue",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-pending",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: "job-pending",
                filename: "/tmp/PendingShow.mkv",
                sizeMb: 50,
                groupId: "group-pending",
              },
            ],
            preset: {
              pendingKey: "pending-media-key",
              match: {
                title: "Pending Show",
                year: "2024",
                posterPath: "/pending.jpg",
                type: "tv",
              },
            },
          },
        ],
      },
    });

    // Verify job exists with pendingKey
    const listed = await module.execute({
      requestId: "list-pending-before",
      module: "badger",
      command: "badger.ingest.list_jobs",
      payload: { userId: "user-pending" },
    });
    const jobsBefore = listed.response.ok ? (listed.response.result.jobs as Array<Record<string, unknown>>) : [];
    try {
      expect(jobsBefore).toHaveLength(1);
      expect(jobsBefore[0].pendingKey).toBe("pending-media-key");
      expect(jobsBefore[0].matchedMediaId).toBeUndefined();
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-pending",
        jobId: "job-pending",
        response: listed.response,
        responseOk: listed.response.ok,
        jobs: jobsBefore,
        pendingKey: jobsBefore[0]?.pendingKey as string,
        matchedMediaId: jobsBefore[0]?.matchedMediaId as string,
        expected: { pendingKey: "pending-media-key", matchedMediaId: undefined },
        actual: jobsBefore[0],
        error: err,
      });
      throw err;
    }

    // remove_media_jobs should remove the job via pendingKey
    console.info(`[${SUITE}:${label}] dispatching remove_media_jobs for mediaId=pending-media-key`);
    const removed = await module.execute({
      requestId: "remove-pending",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-pending",
        actions: [{ type: "remove_media_jobs", mediaId: "pending-media-key" }],
      },
    });
    try {
      expect(removed.response.ok).toBe(true);
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-pending",
        response: removed.response,
        responseOk: removed.response.ok,
        error: err,
      });
      throw err;
    }

    const listedAfter = await module.execute({
      requestId: "list-pending-after",
      module: "badger",
      command: "badger.ingest.list_jobs",
      payload: { userId: "user-pending" },
    });
    const jobsAfter = listedAfter.response.ok ? (listedAfter.response.result.jobs as Array<Record<string, unknown>>) : [];
    try {
      expect(jobsAfter).toEqual([]);
    } catch (err) {
      dumpBadgerIngestRuntimeSnapshot(label, {
        userId: "user-pending",
        response: listedAfter.response,
        responseOk: listedAfter.response.ok,
        jobs: jobsAfter,
        expected: [],
        actual: jobsAfter,
        error: err,
      });
      throw err;
    }

    module.shutdown();
    console.info(`[${SUITE}:${label}] done`);
  });
});
