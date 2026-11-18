/**
 * @test-id RUNTIME-BADGER-CANCEL-RELEASES-UPLOADED-OBJECTS
 * @bugfix @regression-proof cancelled-format-leaks-uploaded-objects (issue #25).
 *
 * A format job cancelled mid-upload has already pushed some chunks (and maybe
 * its init segment, audio and subtitles) to storage. No library row will
 * ever reference them: the job never commits and a retry gets a fresh jobId.
 * Before this fix the cancel cleanup (`discardJobOutputs`) only removed the
 * local transcode directory, which held `job_state.json`, the only record of
 * those keys, so the objects sat in storage until the storage GC's 7-day
 * grace expired. The cleanup now forwards every `uploaded: true` key in
 * `job_state.json` to the storage delete path before removing the directory.
 *
 * Two layers:
 *  - the real deps adapter's `discardJobOutputs` against a real job dir
 *  - the real badger step handlers on a real engineV2: cancelling a format job
 *    while its upload is in flight releases exactly the keys it uploaded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEngineV2, type EngineV2 } from "../src/core/jobs/engineV2";
import { createSqliteRuntimeJobsStore } from "../src/core/jobs/sqliteStore";
import { registerFormatCancelCleanup } from "../src/modules/badger/steps/discardOnCancel";
import { registerBadgerStepHandlers } from "../src/modules/badger/steps";
import { buildBadgerStepDeps } from "../src/modules/badger/steps/deps-adapter";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
} from "../src/modules/badger/steps/deps";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "badger-cancel-releases-uploaded-objects";
const ts = "2026-01-01T00:00:00.000Z";
const USER = "u1";

/** A job_state.json as mediaProcessor persists it mid-upload. */
const jobStateMidUpload = () => ({
  version: 1,
  inputPath: "/media/movie.mkv",
  userId: USER,
  createdAt: ts,
  outputs: [
    {
      id: "v-480p",
      kind: "video",
      quality: "480p",
      init: { key: "obj-v-init", uploaded: true, sizeBytes: 900 },
      segments: [
        { key: "obj-v-0", uploaded: true, sizeBytes: 1000 },
        { key: "obj-v-1", uploaded: true, sizeBytes: 1000 },
        { key: "", uploaded: false },
        { uploaded: false },
      ],
      encodingComplete: true,
    },
    {
      id: "a-en",
      kind: "audio",
      init: { key: "obj-a-init", uploaded: true, sizeBytes: 100 },
      segments: [
        { key: "obj-a-0", uploaded: true, sizeBytes: 200 },
        { key: "obj-a-pending", uploaded: false },
      ],
      encodingComplete: true,
    },
  ],
  subtitles: [
    { key: "obj-sub-en", uploaded: true, language: "en", label: "English", format: "vtt" },
    { key: "obj-sub-fr", uploaded: false, language: "fr", label: "French", format: "vtt" },
  ],
});
const UPLOADED_KEYS = ["obj-a-0", "obj-a-init", "obj-sub-en", "obj-v-0", "obj-v-1", "obj-v-init"];

/**
 * Library double: `getMediaObjectKeys(mediaId)` answers the keys committed
 * rows reference (none by default: the cancelled job never committed).
 */
const libraryWith = (committedKeys: string[] = []) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const db = {
    isOpen: () => true,
    call: async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      if (method === "getMediaObjectKeys") return [...committedKeys];
      throw new Error(`unexpected library call ${method}`);
    },
  } as unknown as BadgerLibraryDbService;
  return { db, calls };
};
const libraryDbStub = libraryWith().db;
/** The adapter insists on an ingest hook; discardJobOutputs never calls it. */
const unusedIngestHook = async (): Promise<never> => {
  throw new Error("processMediaJob must not run in this suite");
};

const writeJobState = (base: string, jobId: string): string => {
  const dir = path.join(base, USER, jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "job_state.json"), JSON.stringify(jobStateMidUpload()));
  return dir;
};

describe(`[${SUITE}] discardJobOutputs releases the job's uploaded objects`, () => {
  let tmp = "";
  const prevTranscodeDir = process.env.SF_TRANSCODE_DIR;

  afterEach(() => {
    console.info(`[${SUITE}:teardown] tmp=${tmp}`);
    if (prevTranscodeDir === undefined) delete process.env.SF_TRANSCODE_DIR;
    else process.env.SF_TRANSCODE_DIR = prevTranscodeDir;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const setup = (label: string) => {
    tmp = mkdtempSync(path.join(tmpdir(), "badger-cancel-release-"));
    process.env.SF_TRANSCODE_DIR = tmp;
    const dir = writeJobState(tmp, `fmt-${label}`);
    console.info(`[${SUITE}:${label}] job dir=${dir}`);
    return { dir, jobId: `fmt-${label}` };
  };

  it("deletes every uploaded key (video init+chunks, audio, subtitles) and only those, then removes the dir", async () => {
    const { dir, jobId } = setup("uploaded");
    const calls: Array<{ token: string; keys: string[] }> = [];
    const deps = buildBadgerStepDeps({
      libraryDb: libraryDbStub,
      processMediaJob: unusedIngestHook,
      resolveToken: () => "tok-1",
      authWaitMs: 0,
      deleteStorageKeys: async (token, keys) => {
        calls.push({ token, keys: [...keys] });
        return { deleted: keys.length, reclaimedBytes: 0 };
      },
    });
    await deps.discardJobOutputs!({ userId: USER, jobId, reason: "format-upload-cancelled", mediaId: "m1" });
    console.info(`[${SUITE}:uploaded] delete calls=${JSON.stringify(calls)} dirExists=${existsSync(dir)}`);
    expect(calls.length, "uploaded keys must reach the storage delete path").toBeGreaterThan(0);
    expect(calls.every((c) => c.token === "tok-1")).toBe(true);
    expect(calls.flatMap((c) => c.keys).sort()).toEqual(UPLOADED_KEYS);
    expect(existsSync(dir)).toBe(false);
  });

  it("still removes the dir and logs loudly when the storage delete fails", async () => {
    const { dir, jobId } = setup("delete-fails");
    const warn = vi.spyOn(console, "warn");
    const deps = buildBadgerStepDeps({
      libraryDb: libraryDbStub,
      processMediaJob: unusedIngestHook,
      resolveToken: () => "tok-1",
      authWaitMs: 0,
      deleteStorageKeys: async () => {
        throw new Error("STORAGE_GATEWAY_UNREACHABLE");
      },
    });
    await deps.discardJobOutputs!({ userId: USER, jobId, reason: "format-upload-cancelled", mediaId: "m1" });
    const warned = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    console.info(`[${SUITE}:delete-fails] warn calls:\n${warned}`);
    expect(warned).toContain("STORAGE_GATEWAY_UNREACHABLE");
    expect(warned).toContain(jobId);
    expect(existsSync(dir)).toBe(false);
  });

  it("logs the leaked keys when no backend token arrives (storage GC reclaims them)", async () => {
    const { dir, jobId } = setup("no-token");
    const warn = vi.spyOn(console, "warn");
    const deleteStorageKeys = vi.fn(async () => ({ deleted: 0, reclaimedBytes: 0 }));
    const deps = buildBadgerStepDeps({
      libraryDb: libraryDbStub,
      processMediaJob: unusedIngestHook,
      resolveToken: () => null,
      authWaitMs: 0,
      deleteStorageKeys,
    });
    await deps.discardJobOutputs!({ userId: USER, jobId, reason: "format-cancelled-before-restart", mediaId: "m1" });
    const warned = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    console.info(`[${SUITE}:no-token] warn calls:\n${warned}`);
    expect(deleteStorageKeys).not.toHaveBeenCalled();
    expect(warned).toContain("no_token");
    expect(warned).toContain(jobId);
    expect(existsSync(dir)).toBe(false);
  });

  // @bugfix @regression-proof PR #143 review P2: the commit landed (format row
  // references these keys) before the process died; the boot re-announce must
  // not delete objects a committed media_formats row still serves.
  it("releases nothing when a committed format row already references the uploaded keys", async () => {
    const { dir, jobId } = setup("committed");
    const library = libraryWith(["poster.jpg", "obj-v-init", "obj-v-0", "obj-v-1"]);
    const info = vi.spyOn(console, "info");
    const deleteStorageKeys = vi.fn(async (_token: string, keys: string[]) => ({ deleted: keys.length, reclaimedBytes: 0 }));
    const deps = buildBadgerStepDeps({
      libraryDb: library.db,
      processMediaJob: unusedIngestHook,
      resolveToken: () => "tok-1",
      authWaitMs: 0,
      deleteStorageKeys,
    });
    await deps.discardJobOutputs!({ userId: USER, jobId, reason: "format-cancelled-before-restart", mediaId: "m1" });
    const logged = info.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    console.info(
      `[${SUITE}:committed] library calls=${JSON.stringify(library.calls)} delete calls=${JSON.stringify(deleteStorageKeys.mock.calls)} dirExists=${existsSync(dir)}`
    );
    expect(deleteStorageKeys, "a committed format's objects must never be released").not.toHaveBeenCalled();
    expect(library.calls).toEqual([{ method: "getMediaObjectKeys", args: ["m1"] }]);
    expect(logged).toContain("committed_format");
    expect(existsSync(dir)).toBe(false);
  });

  it("releases nothing when the commit step had started (commit may have landed)", async () => {
    const { dir, jobId } = setup("commit-started");
    const deleteStorageKeys = vi.fn(async (_token: string, keys: string[]) => ({ deleted: keys.length, reclaimedBytes: 0 }));
    const deps = buildBadgerStepDeps({
      libraryDb: libraryDbStub,
      processMediaJob: unusedIngestHook,
      resolveToken: () => "tok-1",
      authWaitMs: 0,
      deleteStorageKeys,
    });
    await deps.discardJobOutputs!({
      userId: USER,
      jobId,
      reason: "format-cancelled-before-restart",
      mediaId: "m1",
      commitStarted: true,
    });
    console.info(`[${SUITE}:commit-started] delete calls=${JSON.stringify(deleteStorageKeys.mock.calls)} dirExists=${existsSync(dir)}`);
    expect(deleteStorageKeys).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
  });
});

// Submit stamps the media's placementId on its source and format jobs (#145).
const PLACEMENT_ID = "placement-src-1";

const baseJob = (over: Partial<IngestJobRecord>): IngestJobRecord => ({
  jobId: "x",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: { userId: USER, filename: "/media/movie.mkv", hints: {}, placementId: PLACEMENT_ID },
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
  ...over,
});

describe(`[${SUITE}] cancelling a format job mid-upload releases what it uploaded`, () => {
  let tmp = "";
  let engine: EngineV2 | null = null;
  const prevTranscodeDir = process.env.SF_TRANSCODE_DIR;

  afterEach(async () => {
    console.info(`[${SUITE}:engine:teardown] tmp=${tmp}`);
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    __resetBadgerStepDeps();
    if (prevTranscodeDir === undefined) delete process.env.SF_TRANSCODE_DIR;
    else process.env.SF_TRANSCODE_DIR = prevTranscodeDir;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("deletes the uploaded keys once the aborted upload returns", async () => {
    const label = "mid-upload";
    const SOURCE = "src-1";
    const FORMAT = "fmt-480p";
    tmp = mkdtempSync(path.join(tmpdir(), "badger-cancel-release-engine-"));
    process.env.SF_TRANSCODE_DIR = tmp;
    const log: string[] = [];
    const deleted: string[] = [];
    const real = buildBadgerStepDeps({
      libraryDb: libraryDbStub,
      processMediaJob: unusedIngestHook,
      resolveToken: () => "tok-1",
      authWaitMs: 0,
      deleteStorageKeys: async (_token, keys) => {
        log.push(`delete:${keys.length}`);
        deleted.push(...keys);
        return { deleted: keys.length, reclaimedBytes: 0 };
      },
    });
    const emptyState = { version: 1, inputPath: "/media/movie.mkv", userId: USER, createdAt: ts, outputs: [], subtitles: [] };
    const deps: BadgerStepDeps = {
      probe: vi.fn(async () => ({
        durationSeconds: 60,
        videoCodec: "h264",
        videoWidth: 1920,
        videoHeight: 1080,
        sourceQuality: "1080p",
        audioStreamCount: 1,
        subtitleStreamCount: 0,
        streams: [],
        chapters: [],
      })),
      identify: vi.fn(async () => ({
        mediaId: "m1",
        parsedTitle: "Movie",
        season: null,
        episode: null,
        year: null,
        preexistingHint: true,
      })),
      extractSource: vi.fn(async () => ({ jobDir: tmp, state: emptyState, segmentCount: 1 })),
      transcodeFormat: vi.fn(async (input) => ({ jobDir: tmp, state: emptyState, segmentCount: 1, variant: input.variant })),
      uploadOutputs: vi.fn(async (input) => {
        log.push(`start:upload:${input.jobId}`);
        if (input.scope !== "format") return { produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] }, uploadedKeys: [] };
        // Mid-upload: some chunks are flagged uploaded on disk, then the
        // upload blocks until the cancel aborts it.
        writeJobState(tmp, input.jobId);
        const { promise, reject } = Promise.withResolvers<never>();
        const onAbort = () => {
          log.push(`abort:upload:${input.jobId}`);
          reject(Object.assign(new Error("CANCELLED"), { name: "AbortError" }));
        };
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
        return promise;
      }),
      commit: vi.fn(async () => ({ fileId: "file-1", formatIds: ["fmt-row-1"] })),
      markMediaPlayable: vi.fn(async () => undefined),
      discardJobOutputs: real.discardJobOutputs,
    };
    configureBadgerStepDeps(deps);
    const e = createEngineV2({ dbPath: path.join(tmp, "jobs.db"), progressThrottleMs: 0, encodeCap: 1 });
    engine = e;
    await e.start();
    registerBadgerStepHandlers(e);
    const dump = async (why: string) => {
      const fmt = await e.get(FORMAT);
      console.info(
        `[${SUITE}:${label}] DUMP(${why}) log=${JSON.stringify(log)} deleted=${JSON.stringify(deleted)}\n` +
          `  format status=${fmt?.job.status} code=${fmt?.job.errorCode} steps=${JSON.stringify(fmt?.steps.map((s) => `${s.kind}=${s.status}`))}`
      );
    };
    await e.submit(baseJob({ jobId: SOURCE }));
    await e.submit(
      baseJob({
        jobId: FORMAT,
        kind: "format",
        lane: "format",
        variant: "480p",
        priority: 30,
        parentJobIds: [SOURCE],
        payload: {
          userId: USER,
          filename: "/media/movie.mkv",
          variant: "480p",
          parentSourceJobId: SOURCE,
          placementId: PLACEMENT_ID,
        },
      })
    );
    const jobDir = path.join(tmp, USER, FORMAT);
    try {
      await vi.waitFor(() => expect(log).toContain(`start:upload:${FORMAT}`), { timeout: 3000 });
      await dump("format-uploading");
      expect(existsSync(path.join(jobDir, "job_state.json"))).toBe(true);
      await e.cancel(FORMAT, "user");
      await vi.waitFor(() => expect(deleted.length).toBeGreaterThan(0), { timeout: 3000 });
      await vi.waitFor(() => expect(existsSync(jobDir)).toBe(false), { timeout: 3000 });
    } catch (err) {
      await dump("failure");
      throw err;
    }
    await dump("after-cancel");
    expect(log.indexOf(`abort:upload:${FORMAT}`)).toBeGreaterThanOrEqual(0);
    expect([...deleted].sort()).toEqual(UPLOADED_KEYS);
    expect((await e.get(FORMAT))?.job.status).toBe("cancelled");
  });
});

/**
 * @bugfix @regression-proof PR #143 review P2 (boot re-announce).
 *
 * A format job is cancelled while its `commit` step runs. The library batch
 * can land the media_formats row before the process dies with the step still
 * `running`. On the next boot hydration settles the step and re-announces the
 * cancel; the cleanup must then drop the local dir only, never the objects
 * the (possibly) committed row serves.
 */
describe(`[${SUITE}] boot re-announce of a job cancelled mid-commit`, () => {
  const FORMAT = "fmt-480p-mid-commit";
  let tmp = "";
  let engine: EngineV2 | null = null;
  const prevTranscodeDir = process.env.SF_TRANSCODE_DIR;

  afterEach(async () => {
    console.info(`[${SUITE}:mid-commit:teardown] tmp=${tmp}`);
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    __resetBadgerStepDeps();
    if (prevTranscodeDir === undefined) delete process.env.SF_TRANSCODE_DIR;
    else process.env.SF_TRANSCODE_DIR = prevTranscodeDir;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the dir but releases no storage key", async () => {
    const label = "mid-commit";
    tmp = mkdtempSync(path.join(tmpdir(), "badger-cancel-mid-commit-"));
    process.env.SF_TRANSCODE_DIR = tmp;
    const dbPath = path.join(tmp, "jobs.db");
    const jobDir = path.join(tmp, USER, FORMAT);

    // Process 1: transcode + upload finish; commit hangs (the library batch is
    // committing) when the cancel arrives and the runtime dies.
    const crashed = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 1 });
    await crashed.start();
    const started: string[] = [];
    crashed.registerHandler("transcode", async (ctx) => {
      started.push(`transcode:${ctx.job.jobId}`);
      writeJobState(tmp, ctx.job.jobId);
    });
    crashed.registerHandler("upload", async (ctx) => {
      started.push(`upload:${ctx.job.jobId}`);
    });
    crashed.registerHandler("commit", async (ctx) => {
      started.push(`commit:${ctx.job.jobId}`);
      await new Promise<never>(() => {});
    });
    await crashed.submit(
      baseJob({
        jobId: FORMAT,
        kind: "format",
        lane: "format",
        variant: "480p",
        priority: 30,
        payload: { userId: USER, filename: "/media/movie.mkv", variant: "480p", placementId: PLACEMENT_ID },
      })
    );
    await vi.waitFor(() => expect(started).toContain(`commit:${FORMAT}`), { timeout: 3000 });
    await crashed.cancel(FORMAT, "user");
    const atCrash = await crashed.get(FORMAT);
    console.info(
      `[${SUITE}:${label}] at crash: status=${atCrash?.job.status} steps=${JSON.stringify(
        atCrash?.steps.map((s) => `${s.kind}=${s.status}@${s.startedAt}`)
      )} dir=${existsSync(jobDir)} started=${JSON.stringify(started)}`
    );
    expect(atCrash?.job.status).toBe("cancelled");
    expect(atCrash?.steps.find((s) => s.kind === "commit")?.status).toBe("running");
    expect(existsSync(path.join(jobDir, "job_state.json"))).toBe(true);

    // Process 2 boots on the same DB with the real adapter cleanup. The library
    // double reports no committed keys, so only the commit-started guard holds.
    const library = libraryWith();
    const deleteStorageKeys = vi.fn(async (_token: string, keys: string[]) => ({ deleted: keys.length, reclaimedBytes: 0 }));
    const discarded: Array<Record<string, unknown>> = [];
    const real = buildBadgerStepDeps({
      libraryDb: library.db,
      processMediaJob: unusedIngestHook,
      resolveToken: () => "tok-1",
      authWaitMs: 0,
      deleteStorageKeys,
    });
    configureBadgerStepDeps({
      ...real,
      discardJobOutputs: async (input) => {
        discarded.push({ ...input });
        await real.discardJobOutputs?.(input);
      },
    });
    const rebooted = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 1 });
    engine = rebooted;
    registerBadgerStepHandlers(rebooted);
    await rebooted.start();

    try {
      await vi.waitFor(() => expect(existsSync(jobDir)).toBe(false), { timeout: 3000 });
    } finally {
      const after = await rebooted.get(FORMAT);
      console.info(
        `[${SUITE}:${label}] after boot: discarded=${JSON.stringify(discarded)} deleteCalls=${JSON.stringify(
          deleteStorageKeys.mock.calls
        )} libraryCalls=${JSON.stringify(library.calls)} steps=${JSON.stringify(
          after?.steps.map((s) => `${s.kind}=${s.status}`)
        )} dir=${existsSync(jobDir)}`
      );
    }
    expect(discarded).toEqual([expect.objectContaining({ jobId: FORMAT, reason: "format-cancelled-before-restart" })]);
    expect(deleteStorageKeys, "objects of a job whose commit may have landed must stay").not.toHaveBeenCalled();
  });
});

/**
 * @bugfix @regression-proof PR #143 re-review P2.
 *
 * At boot engineV2 emits `runtime.jobs.cancelled` with reason
 * `interrupted-by-restart` for every job left `running`, then requeues and
 * resumes it. A job can be `running` with no running step: its upload step
 * was marked succeeded and the process died before the job CAS back to
 * `queued`. The cleanup subscriber used to treat that event as a real cancel
 * and release every uploaded object while the resumed commit went on to write
 * media_formats rows pointing at them.
 */
describe(`[${SUITE}] boot restart of a job that is not cancelled`, () => {
  const FORMAT = "fmt-480p-restart";
  let tmp = "";
  let engine: EngineV2 | null = null;
  const prevTranscodeDir = process.env.SF_TRANSCODE_DIR;

  afterEach(async () => {
    console.info(`[${SUITE}:restart:teardown] tmp=${tmp}`);
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    __resetBadgerStepDeps();
    if (prevTranscodeDir === undefined) delete process.env.SF_TRANSCODE_DIR;
    else process.env.SF_TRANSCODE_DIR = prevTranscodeDir;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("releases nothing and lets the resumed commit run", async () => {
    const label = "restart";
    tmp = mkdtempSync(path.join(tmpdir(), "badger-cancel-restart-"));
    process.env.SF_TRANSCODE_DIR = tmp;
    const dbPath = path.join(tmp, "jobs.db");
    const jobDir = path.join(tmp, USER, FORMAT);

    // Process 1: transcode finishes, upload is in flight when the runtime dies.
    const crashed = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 1 });
    await crashed.start();
    const started: string[] = [];
    crashed.registerHandler("transcode", async (ctx) => {
      started.push(`transcode:${ctx.job.jobId}`);
      writeJobState(tmp, ctx.job.jobId);
    });
    crashed.registerHandler("upload", async (ctx) => {
      started.push(`upload:${ctx.job.jobId}`);
      await Promise.withResolvers<never>().promise;
    });
    await crashed.submit(
      baseJob({
        jobId: FORMAT,
        kind: "format",
        lane: "format",
        variant: "480p",
        priority: 30,
        payload: { userId: USER, filename: "/media/movie.mkv", variant: "480p", placementId: PLACEMENT_ID },
      })
    );
    await vi.waitFor(() => expect(started).toContain(`upload:${FORMAT}`), { timeout: 3000 });
    // The upload step's `succeeded` write landed; the job CAS back to queued
    // did not (SIGKILL / power loss between the two writes).
    const disk = createSqliteRuntimeJobsStore(dbPath);
    const upload = disk.steps.getSteps(FORMAT).find((s) => s.kind === "upload");
    expect(upload).toBeDefined();
    disk.steps.updateStepStatus(upload!.stepId, "succeeded", {});
    const atCrash = await crashed.get(FORMAT);
    console.info(
      `[${SUITE}:${label}] at crash: status=${atCrash?.job.status} steps=${JSON.stringify(
        atCrash?.steps.map((s) => `${s.kind}=${s.status}`)
      )} dir=${existsSync(jobDir)}`
    );
    expect(atCrash?.job.status).toBe("running");
    expect(atCrash?.steps.some((s) => s.status === "running")).toBe(false);

    // Process 2 boots on the same DB with the real adapter cleanup.
    const library = libraryWith();
    const deleteStorageKeys = vi.fn(async (_token: string, keys: string[]) => ({ deleted: keys.length, reclaimedBytes: 0 }));
    const discarded: Array<Record<string, unknown>> = [];
    const real = buildBadgerStepDeps({
      libraryDb: library.db,
      processMediaJob: unusedIngestHook,
      resolveToken: () => "tok-1",
      authWaitMs: 0,
      deleteStorageKeys,
    });
    configureBadgerStepDeps({
      ...real,
      discardJobOutputs: async (input) => {
        discarded.push({ ...input });
        await real.discardJobOutputs?.(input);
      },
    });
    const rebooted = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 1 });
    engine = rebooted;
    const committed: string[] = [];
    rebooted.registerHandler("commit", async (ctx) => {
      committed.push(ctx.job.jobId);
    });
    registerFormatCancelCleanup(rebooted);
    await rebooted.start();

    try {
      await vi.waitFor(async () => expect((await rebooted.get(FORMAT))?.job.status).toBe("succeeded"), {
        timeout: 3000,
      });
      // The boot event's cleanup reads the job and calls discardJobOutputs
      // before the requeued commit can even be dispatched, so by the time the
      // job has succeeded any (wrong) release has already been recorded.
    } finally {
      const after = await rebooted.get(FORMAT);
      console.info(
        `[${SUITE}:${label}] after boot: status=${after?.job.status} committed=${JSON.stringify(
          committed
        )} discarded=${JSON.stringify(discarded)} deleteCalls=${JSON.stringify(
          deleteStorageKeys.mock.calls
        )} dir=${existsSync(jobDir)}`
      );
    }
    expect(committed).toEqual([FORMAT]);
    expect(discarded, "a restart is not a cancel").toEqual([]);
    expect(deleteStorageKeys, "objects of a resumed job must stay").not.toHaveBeenCalled();
    expect(existsSync(path.join(jobDir, "job_state.json"))).toBe(true);
  });
});
