/**
 * @bugfix @regression-proof replan-duplicate-quality (issue #25, Opus review
 * of #47).
 *
 * Symptom: queue 720p on a file, then queue 720p again before the first job
 * commits (minutes on a 4-core CPU with no GPU). The only duplicate guard was
 * mediaReplan's `presentQualities`, built from COMMITTED media_formats rows,
 * so the second request passed and created a second retranscode job. Both
 * reached deps.commit's format branch and both INSERTed: duplicate quality
 * rows, two full chunk copies in storage + quota, and every later replan of
 * that quality refused as `quality-exists`.
 *
 * Fix (three layers):
 *   1. mediaReplan stamps `dedupeKey = replan:<mediaId>:<fileId>:<variant>`
 *      on the job and returns the in-flight job id on a repeat.
 *   2. engine.submit honours the store's dedupe short-circuit: the store's
 *      check+insert is one synchronous SQLite step, so two concurrent
 *      submits cannot both create a job. Pre-fix, submit ignored the
 *      returned row, seeded steps for a job id that was never inserted and
 *      reported that phantom id back.
 *   3. deps.commit's format branch skips the INSERT when a (file_id,
 *      quality) row already exists and returns the existing format id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineV2, type EngineV2 } from "../src/core/jobs/engineV2";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { createBadgerMediaReplanQualitiesHandler } from "../src/modules/badger/mediaReplan";
import { buildBadgerStepDeps } from "../src/modules/badger/steps/deps-adapter";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";

const SUITE = "badger-replan-dedupe";

const row = (id: string, quality: string, isSource: boolean, fileId = "f-1") => ({
  id,
  mediaId: "m-1",
  fileId,
  quality,
  codec: "h264",
  isSource,
  initKey: `${id}.init`,
  chunks: [{ key: `${id}.1`, sizeBytes: 10 }],
});

const COMMITTED = [row("fmt-1080", "1080p", true), row("fmt-360", "360p", false)];

const replanLibraryDb = () =>
  ({
    call: vi.fn(async (method: string) => {
      if (method === "listMediaFormats") return COMMITTED;
      throw new Error(`unexpected libraryDb.call: ${method}`);
    }),
  }) as unknown as BadgerLibraryDbService;

const dumpEngine = async (label: string, engine: EngineV2) => {
  try {
    const { jobs } = await engine.list();
    console.info(
      `[${SUITE}:${label}] engine jobs=${JSON.stringify(
        jobs.map((j) => ({ jobId: j.jobId, status: j.status, variant: j.variant, dedupeKey: j.dedupeKey }))
      )}`
    );
  } catch (err) {
    console.error(`[${SUITE}:${label}] (dump failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe(`[${SUITE}] a quality already in flight is never queued or committed twice`, () => {
  let engine: EngineV2;
  const releases: Array<() => void> = [];

  beforeEach(async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    // Every retranscode step blocks until released (or aborted): the first
    // job stays in flight exactly like a slow CPU-only encode.
    for (const kind of ["retranscode", "upload", "commit"]) {
      engine.registerHandler(kind, ({ signal }) => {
        console.info(`[${SUITE}:handler] step ${kind} started — blocking`);
        return new Promise<void>((resolve) => {
          releases.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
    }
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await engine.stop();
  });

  it("replan: re-adding 720p while the first 720p job is in flight returns the SAME job, no second job", async () => {
    const label = "replan-sequential";
    const handler = createBadgerMediaReplanQualitiesHandler({
      engine,
      libraryDb: replanLibraryDb(),
      resolveActiveUserId: () => "user-1",
    });
    const payload = { mediaId: "m-1", fileId: "f-1", addQualities: ["720p" as const], removeFormatIds: [] };

    const first = await handler(payload);
    console.info(`[${SUITE}:${label}] first=${JSON.stringify(first)}`);
    await vi.waitFor(async () => {
      const got = await engine.get(first.addedJobIds[0].jobId);
      expect(got?.job.status).toBe("running");
    });
    const second = await handler(payload);
    console.info(`[${SUITE}:${label}] second=${JSON.stringify(second)}`);
    await dumpEngine(label, engine);

    expect(second.errorCode ?? null).toBeNull();
    expect(second.addedJobIds).toEqual(first.addedJobIds);
    const { jobs } = await engine.list();
    expect(jobs.filter((j) => j.variant === "720p")).toHaveLength(1);
  });

  it("replan: two concurrent 720p requests create exactly one job", async () => {
    const label = "replan-concurrent";
    const handler = createBadgerMediaReplanQualitiesHandler({
      engine,
      libraryDb: replanLibraryDb(),
      resolveActiveUserId: () => "user-1",
    });
    const payload = { mediaId: "m-1", fileId: "f-1", addQualities: ["720p" as const], removeFormatIds: [] };
    const [a, b] = await Promise.all([handler(payload), handler(payload)]);
    console.info(`[${SUITE}:${label}] a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    await dumpEngine(label, engine);

    expect(a.addedJobIds[0].jobId).toBe(b.addedJobIds[0].jobId);
    const { jobs } = await engine.list();
    expect(jobs.filter((j) => j.variant === "720p")).toHaveLength(1);
  });

  it("engine.submit: a dedupe hit returns the live job id and seeds no phantom steps", async () => {
    const label = "engine-submit-dedupe";
    const ts = new Date().toISOString();
    const job = (jobId: string): IngestJobRecord => ({
      jobId,
      app: "badger",
      kind: "format",
      lane: "format",
      variant: "720p",
      status: "queued",
      stageCode: "queued",
      stageLabel: "Queued",
      progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
      progressPct: 0,
      priority: 20,
      parentJobIds: [],
      groupId: "replan:m-1:f-1:720p",
      mediaId: "m-1",
      dedupeKey: "replan:m-1:f-1:720p",
      payload: { userId: "user-1", retranscode: true, fileId: "f-1", variant: "720p" },
      outputs: {},
      errorCode: null,
      errorMessage: null,
      retryable: false,
      cancelRequested: false,
      createdAt: ts,
      updatedAt: ts,
      startedAt: null,
      finishedAt: null,
      dismissedAt: null,
      uploadSpeedBytesPerSec: null,
    });
    const first = await engine.submit(job("job-a"));
    const second = await engine.submit(job("job-b"));
    console.info(`[${SUITE}:${label}] first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
    await dumpEngine(label, engine);

    expect(second.jobId).toBe("job-a");
    expect(await engine.get("job-b")).toBeNull();
  });
});

describe(`[${SUITE}] format commit is idempotent per (file_id, quality)`, () => {
  const produced720 = (): ProducedMedia =>
    ({
      videoFormats: [
        {
          quality: "720p",
          codec: "h264",
          codecString: "avc1.64001f",
          totalSize: 4 * 1024 * 1024,
          durationSeconds: 60,
          initKey: "dup.init",
          initSize: 100,
          chunks: [{ key: "dup.1", size: 10, index: 0 }],
        },
      ],
      audioTracks: [],
      subtitleTracks: [],
    }) as unknown as ProducedMedia;

  it("commit: a 720p row already exists on the file → no second INSERT, existing format id returned", async () => {
    const label = "commit-existing-quality";
    const calls: string[] = [];
    const libraryDb = {
      isOpen: () => true,
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        calls.push(method);
        console.info(`[${SUITE}:${label}] libraryDb.call(${method}) args=${JSON.stringify(args).slice(0, 200)}`);
        if (method === "listMediaFormats") {
          return [...COMMITTED, row("fmt-720-first", "720p", false), row("fmt-720-other-file", "480p", false, "f-2")];
        }
        if (method === "addMediaFormat") return "fmt-720-dup";
        throw new Error(`unexpected libraryDb.call: ${method}`);
      }),
    } as unknown as BadgerLibraryDbService;
    const deps = buildBadgerStepDeps({
      libraryDb,
      resolveToken: () => "tok",
      resolveLibraryKey: () => "k",
      // Commit never encodes; the legacy hook only satisfies the constructor.
      processMediaJob: vi.fn() as never,
      authWaitMs: 0,
      warmStorageCacheImpl: vi.fn(async () => ({ warmed: 0 }) as never),
    });
    const result = await deps.commit({
      userId: "user-1",
      jobId: "job-b",
      mediaId: "m-1",
      filename: "",
      scope: "format",
      variant: "720p",
      season: null,
      episode: null,
      produced: produced720(),
      sourceFileId: "f-1",
      signal: new AbortController().signal,
    });
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} calls=${JSON.stringify(calls)}`);
    expect(calls).not.toContain("addMediaFormat");
    expect(result.formatIds).toEqual(["fmt-720-first"]);
    expect(result.fileId).toBe("f-1");
  });

  it("commit: no 720p row yet on this file (only on another file) → INSERTs normally", async () => {
    const label = "commit-new-quality";
    const calls: string[] = [];
    const libraryDb = {
      isOpen: () => true,
      call: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === "listMediaFormats") return [...COMMITTED, row("fmt-720-f2", "720p", false, "f-2")];
        if (method === "addMediaFormat") return "fmt-720-new";
        throw new Error(`unexpected libraryDb.call: ${method}`);
      }),
    } as unknown as BadgerLibraryDbService;
    const deps = buildBadgerStepDeps({
      libraryDb,
      resolveToken: () => "tok",
      resolveLibraryKey: () => "k",
      processMediaJob: vi.fn() as never,
      authWaitMs: 0,
      warmStorageCacheImpl: vi.fn(async () => ({ warmed: 0 }) as never),
    });
    const result = await deps.commit({
      userId: "user-1",
      jobId: "job-a",
      mediaId: "m-1",
      filename: "",
      scope: "format",
      variant: "720p",
      season: null,
      episode: null,
      produced: produced720(),
      sourceFileId: "f-1",
      signal: new AbortController().signal,
    });
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} calls=${JSON.stringify(calls)}`);
    expect(calls).toContain("addMediaFormat");
    expect(result.formatIds).toEqual(["fmt-720-new"]);
  });
});
