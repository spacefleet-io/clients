/**
 * @bugfix
 * @regression-proof
 *
 * Regression test for finding F2 (cancellation cleanup is openly stubbed) of
 * the storage-tracker-refactor.
 *
 * Behavior pinned (Layer 2 of the plan):
 *   When an ingest job is cancelled mid-flight AFTER some chunks have already
 *   been uploaded to the storage gateway and persisted to disk in `job_state.json`, those
 *   already-uploaded chunk keys MUST be forwarded to the API's /storage/delete
 *   endpoint so the gateway removes them and quota is reclaimed.
 *
 * Why this fails today (HEAD):
 *   - libraryDb.removeUploadedChunks exists but its JSDoc explicitly states
 *     the cancellation pipeline is not yet wired
 *     (packages/library-db-runtime/src/libraryDb.ts:2804-2831).
 *   - The badger cancel branch at apps/runtime/src/modules/badger.ts:1789-1797
 *     just marks the job cancelled — it never gathers the partially-uploaded
 *     chunks from the persisted job_state.json or calls /storage/delete.
 *
 * Test approach:
 *   1. Set SF_TRANSCODE_DIR to a tmp dir.
 *   2. Pre-write `job_state.json` describing some already-uploaded chunks so
 *      the runtime "knows" what was committed before the abort.
 *   3. Start the job with a processMediaJob that hangs forever.
 *   4. Stub global fetch to record /storage/delete calls.
 *   5. Cancel the job.
 *   6. Assert: /storage/delete was POSTed with the pre-uploaded chunk keys.
 *
 * @test-id STORAGE-CANCEL-LEAK-001
 * @level integration
 * @covers apps/runtime/src/modules/badger.ts cancel_job + runIngestJob
 *         abort branch
 * @covers packages/library-db-runtime/src/libraryDb.ts removeUploadedChunks
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import { runtimeJobsStore } from "../src/core/jobs/store";

type CapturedFetch = {
  url: string;
  method: string;
  body: unknown;
};

let capturedFetches: CapturedFetch[] = [];
let originalFetch: typeof globalThis.fetch | null = null;
let transcodeDirRoot = "";

const installFetchRecorder = () => {
  capturedFetches = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    capturedFetches.push({ url, method, body });
    // For /storage/delete and any sibling calls, return a normal success.
    return new Response(JSON.stringify({ deleted: 0, reclaimedBytes: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
};

const restoreFetch = () => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
};

const fetchesMatchingStorageDelete = () =>
  capturedFetches.filter(
    (entry) =>
      entry.method === "POST" && /\/storage\/delete(\?|$)/.test(entry.url)
  );

const collectKeysFromStorageDeleteCalls = () => {
  const keys: string[] = [];
  for (const entry of fetchesMatchingStorageDelete()) {
    const body = entry.body as { keys?: unknown } | null;
    const arr = Array.isArray(body?.keys) ? (body!.keys as unknown[]) : [];
    for (const key of arr) {
      if (typeof key === "string" && key.length > 0) keys.push(key);
    }
  }
  return keys;
};

const writePartiallyUploadedJobState = (
  userId: string,
  jobId: string,
  uploadedKeys: { videoInit: string; videoChunks: string[]; audioInit: string; audioChunks: string[] }
) => {
  const dir = join(transcodeDirRoot, userId, jobId);
  mkdirSync(dir, { recursive: true });
  const state = {
    outputs: [
      {
        kind: "video",
        quality: "1080p",
        codec: "h264",
        codecString: null,
        encodingComplete: false,
        durationSeconds: 90,
        totalSize: 3_004_000,
        init: {
          uploaded: true,
          key: uploadedKeys.videoInit,
          sizeBytes: 4000,
        },
        segments: uploadedKeys.videoChunks.map((key, idx) => ({
          uploaded: true,
          key,
          sizeBytes: 1_000_000,
          startSeconds: idx * 6,
        })),
        chapters: [],
      },
      {
        kind: "audio",
        language: "en",
        label: "English",
        codec: "aac",
        codecString: null,
        encodingComplete: false,
        durationSeconds: 90,
        totalSize: 200_000,
        init: {
          uploaded: true,
          key: uploadedKeys.audioInit,
          sizeBytes: 1000,
        },
        segments: uploadedKeys.audioChunks.map((key, idx) => ({
          uploaded: true,
          key,
          sizeBytes: 100_000,
          startSeconds: idx * 6,
        })),
      },
    ],
    subtitles: [],
    skipAnalysis: null,
    encoder: "cpu" as const,
  };
  writeFileSync(join(dir, "job_state.json"), JSON.stringify(state));
};

const createModule = (processMediaJob: (...args: any[]) => any) => {
  runtimeJobsStore.reset({ clearPersistence: true });
  return new BadgerModule({ processMediaJob });
};

const openQueue = async (module: BadgerModule, userId: string) => {
  await module.execute({
    requestId: "open-cancel-leak",
    module: "badger",
    command: "badger.ingest.open",
    payload: {
      userId,
      config: {
        enableCodecSelection: false,
        transcodeOutputs: [{ quality: "1080p", codec: "h264" }],
        uiLanguage: "en",
        token: "test-token",
        libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      },
    },
  });
};

const queueFile = async (module: BadgerModule, userId: string, jobId: string) => {
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
              sizeMb: 4096,
              includeSource: true,
              includeFallback: false,
              includeAudio: true,
              includeSubtitles: false,
              includeChapters: false,
              selectedFormats: [{ quality: "1080p", codec: "h264" }],
            },
          ],
          preset: {
            media: {
              id: `media-${jobId}`,
              type: "movie",
              tmdbId: 9001,
              title: "Cancel Leak Movie",
              year: "2026",
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
  label = "(unlabelled)",
) => {
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      await fn();
      console.info(
        `[badger-cancel-storage-leak:wait-${label}] satisfied after ${attempts} attempt(s) (elapsed=${Date.now() - startedAt}ms)`,
      );
      return;
    } catch (err) {
      if (attempts % 10 === 1) {
        console.info(
          `[badger-cancel-storage-leak:wait-${label}] attempt ${attempts} not yet (elapsed=${Date.now() - startedAt}ms): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await sleep(50);
    }
  }
  console.error(
    `[badger-cancel-storage-leak:wait-${label}] TIMEOUT after ${attempts} attempts in ${Date.now() - startedAt}ms; running final assertion`,
  );
  await fn();
};

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps observed fetches + storage-delete keys
// + current job list on assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpCancelLeakSnapshot = (
  label: string,
  ctx: {
    module?: BadgerModule;
    userId?: string;
    expectedKeys?: string[];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-cancel-storage-leak:${label}] snapshot ===`);
    console.error(`capturedFetches.count=${capturedFetches.length}`);
    console.error(
      `capturedFetches=\n${JSON.stringify(capturedFetches, null, 2)}`,
    );
    const deletes = fetchesMatchingStorageDelete();
    console.error(`storage-delete POSTs count=${deletes.length}`);
    console.error(
      `storage-delete keys observed=\n${JSON.stringify(collectKeysFromStorageDeleteCalls(), null, 2)}`,
    );
    if (ctx.expectedKeys) {
      console.error(
        `expected uploaded keys=\n${JSON.stringify(ctx.expectedKeys, null, 2)}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
    if (ctx.module && ctx.userId) {
      // Fire-and-forget list to surface job state at failure time.
      listJobs(ctx.module, ctx.userId)
        .then((jobs) =>
          console.error(
            `jobs at failure=\n${JSON.stringify(jobs, null, 2)}`,
          ),
        )
        .catch((err) =>
          console.error(
            `(failed to list jobs: ${err instanceof Error ? err.message : String(err)})`,
          ),
        );
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

beforeEach(() => {
  transcodeDirRoot = mkdtempSync(join(tmpdir(), "sf-cancel-leak-"));
  process.env.SF_TRANSCODE_DIR = transcodeDirRoot;
  installFetchRecorder();
  console.info(
    `[badger-cancel-storage-leak:setup] transcodeDirRoot=${transcodeDirRoot}; fetch recorder installed`,
  );
});

afterEach(() => {
  console.info(
    `[badger-cancel-storage-leak:teardown] restoring fetch, removing transcodeDirRoot=${transcodeDirRoot}`,
  );
  restoreFetch();
  vi.unstubAllGlobals();
  rmSync(transcodeDirRoot, { recursive: true, force: true });
  delete process.env.SF_TRANSCODE_DIR;
});

describe("cancel_job mid-upload forwards already-uploaded chunks to /storage/delete (F2)", () => {
  it(
    "@bugfix @regression-proof cancel_job after partial upload POSTs the persisted chunk keys to /storage/delete",
    async () => {
      const userId = "cancel-leak-user";
      const jobId = "job-partial-upload";
      const uploadedKeys = {
        videoInit: "shards/gw/library/movies/leak2/v/init",
        videoChunks: [
          "shards/gw/library/movies/leak2/v/chunk-1",
          "shards/gw/library/movies/leak2/v/chunk-2",
          "shards/gw/library/movies/leak2/v/chunk-3",
        ],
        audioInit: "shards/gw/library/movies/leak2/a/init",
        audioChunks: [
          "shards/gw/library/movies/leak2/a/chunk-1",
          "shards/gw/library/movies/leak2/a/chunk-2",
        ],
      };
      const allUploaded = [
        uploadedKeys.videoInit,
        ...uploadedKeys.videoChunks,
        uploadedKeys.audioInit,
        ...uploadedKeys.audioChunks,
      ];
      console.info(
        `[badger-cancel-storage-leak:test] userId=${userId} jobId=${jobId} expectedUploadedKeys.count=${allUploaded.length}`,
      );

      // Pre-place job_state.json BEFORE start_job so the runtime's view of
      // "what was already committed at cancel time" is deterministic.
      writePartiallyUploadedJobState(userId, jobId, uploadedKeys);
      console.info(
        `[badger-cancel-storage-leak:test] pre-placed job_state.json under ${transcodeDirRoot}/${userId}/${jobId}/`,
      );

      // processMediaJob hangs forever waiting for the abort signal. By the
      // time we cancel, the persisted state file already shows the chunks
      // above as uploaded — exactly the shape that produces a leak today.
      const processMediaJob = vi.fn(async ({ signal, onProgress }: any) => {
        console.info(
          `[badger-cancel-storage-leak:processMediaJob] entered; reporting uploading 60% then hanging for abort`,
        );
        onProgress("uploading", 60);
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => {
            console.info(
              `[badger-cancel-storage-leak:processMediaJob] abort signal received; rejecting with AbortError`,
            );
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, {
            once: true,
          });
        });
      });

      const module = createModule(processMediaJob);
      console.info(`[badger-cancel-storage-leak:test] module created`);
      await openQueue(module, userId);
      console.info(`[badger-cancel-storage-leak:test] queue opened`);
      await queueFile(module, userId, jobId);
      console.info(`[badger-cancel-storage-leak:test] file queued`);
      await applyAction(module, userId, { type: "start_job", jobId });
      console.info(`[badger-cancel-storage-leak:test] start_job dispatched`);

      try {
        // Wait for the job to enter the running/uploading state before cancel.
        await waitFor(
          () => expect(processMediaJob).toHaveBeenCalledTimes(1),
          5_000,
          "processMediaJob-called-once",
        );
        await waitFor(
          async () => {
            const jobs = await listJobs(module, userId);
            const job = jobs[0];
            expect(["transcoding", "uploading"]).toContain(job?.status);
          },
          5_000,
          "job-in-active-state",
        );

        // Discard fetches captured during setup so we only see post-cancel
        // cleanup traffic.
        const preCancelFetchCount = capturedFetches.length;
        console.info(
          `[badger-cancel-storage-leak:test] clearing ${preCancelFetchCount} setup fetches before cancel`,
        );
        capturedFetches = [];

        await applyAction(module, userId, { type: "cancel_job", jobId });
        console.info(
          `[badger-cancel-storage-leak:test] cancel_job dispatched; waiting for cancelled state`,
        );

        // Wait until the job has settled into "cancelled".
        await waitFor(
          async () => {
            const jobs = await listJobs(module, userId);
            const job = jobs[0];
            expect(job?.status).toBe("cancelled");
          },
          5_000,
          "job-cancelled",
        );
        // Allow async cleanup to fire (whatever the wired-up handler ends up
        // calling — runtime jobs engine terminal hook, finally callback, etc.)
        await sleep(150);

        const observedKeys = collectKeysFromStorageDeleteCalls();
        const observed = new Set(observedKeys);
        const missing = allUploaded.filter((key) => !observed.has(key));
        console.info(
          `[badger-cancel-storage-leak:test] post-cancel storage-delete observedKeys.count=${observedKeys.length} missing.count=${missing.length} fetchCount=${capturedFetches.length}`,
        );
        expect(
          missing,
          `cancel cleanup did not forward these uploaded chunk keys to /storage/delete: ${JSON.stringify(missing)} (forwarded set: ${JSON.stringify(observedKeys)})`
        ).toEqual([]);
        expect(fetchesMatchingStorageDelete().length).toBeGreaterThan(0);
      } catch (err) {
        dumpCancelLeakSnapshot("cancel-forwards-keys-failure", {
          module,
          userId,
          expectedKeys: allUploaded,
          extra: {
            processMediaJobCallCount: (
              processMediaJob as ReturnType<typeof vi.fn>
            ).mock.calls.length,
          },
        });
        throw err;
      } finally {
        module.shutdown();
      }
    }
  );
});
