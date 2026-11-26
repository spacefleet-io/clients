/**
 * @bugfix @regression-proof format-outputs-left-on-cancel (issue #25).
 *
 * With per-step parent gating a format job's transcode runs while its source
 * is still uploading. If the source upload then fails (or the user cancels the
 * source), the format job is cancelled with an encode on disk — either half
 * written (encoder killed mid-run) or finished (waiting for the source upload
 * before its own upload). A cancelled job never resumes, so its local outputs
 * must be removed. A graceful runtime stop is NOT a cancel: the step resumes
 * next boot and keeps its outputs.
 *
 * Runs the real badger step handlers on a real engineV2 with fake deps.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEngineV2, type EngineV2 } from "@space/runtime-jobs-engine/engineV2";
import { registerBadgerStepHandlers } from "../src/modules/badger/steps";
import { buildBadgerStepDeps } from "../src/modules/badger/steps/deps-adapter";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
  type ExtractResult,
  type UploadResult,
  type DiscardJobOutputsInput,
} from "../src/modules/badger/steps/deps";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "badger-format-cancel-cleanup";
const ts = "2026-01-01T00:00:00.000Z";
const SOURCE = "src-1";
const FORMAT = "fmt-480p";
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
  payload: { userId: "u1", filename: "/media/movie.mkv", hints: {}, placementId: PLACEMENT_ID },
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

const extractResult = (): ExtractResult => ({
  jobDir: "/tmp/never-used",
  state: { version: 1, inputPath: "/media/movie.mkv", userId: "u1", createdAt: ts, outputs: [], subtitles: [] },
  segmentCount: 1,
});

const uploadResult = (): UploadResult => ({
  produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
  uploadedKeys: [],
});

/** Resolves on release, rejects with an AbortError when the signal fires. */
const holdUntil = (signal: AbortSignal, release: Promise<void>, log: string[], key: string) => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    log.push(`abort:${key}`);
    reject(Object.assign(new Error("CANCELLED"), { name: "AbortError" }));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  release.then(resolve, reject);
  return promise;
};

describe(`[${SUITE}] cancelled format jobs drop their local encode outputs`, () => {
  let tmp = "";
  let engine: EngineV2 | null = null;

  afterEach(async () => {
    console.info(`[${SUITE}:teardown] tmp=${tmp}`);
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    __resetBadgerStepDeps();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const boot = async (label: string, opts: { holdTranscode: boolean }) => {
    tmp = mkdtempSync(path.join(tmpdir(), "badger-fmt-cancel-"));
    const log: string[] = [];
    const sourceUpload = Promise.withResolvers<void>();
    const transcode = Promise.withResolvers<void>();
    const discardJobOutputs = vi.fn(async (input: DiscardJobOutputsInput) => {
      log.push(`discard:${input.jobId}:${input.reason}`);
      console.info(`[${SUITE}:${label}] discardJobOutputs ${JSON.stringify(input)}`);
    });
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
      extractSource: vi.fn(async () => extractResult()),
      transcodeFormat: vi.fn(async (input) => {
        log.push(`start:transcode:${input.jobId}`);
        if (opts.holdTranscode) await holdUntil(input.signal, transcode.promise, log, `transcode:${input.jobId}`);
        log.push(`end:transcode:${input.jobId}`);
        return { ...extractResult(), variant: input.variant };
      }),
      uploadOutputs: vi.fn(async (input) => {
        log.push(`start:upload:${input.jobId}`);
        if (input.scope === "source") await holdUntil(input.signal, sourceUpload.promise, log, `upload:${input.jobId}`);
        log.push(`end:upload:${input.jobId}`);
        return uploadResult();
      }),
      commit: vi.fn(async () => ({ fileId: "file-1", formatIds: ["fmt-row-1"] })),
      markMediaPlayable: vi.fn(async () => undefined),
      discardJobOutputs,
    };
    configureBadgerStepDeps(deps);
    const e = createEngineV2({ dbPath: path.join(tmp, "jobs.db"), progressThrottleMs: 0, encodeCap: 1 });
    engine = e;
    await e.start();
    registerBadgerStepHandlers(e);
    const dump = async (why: string) => {
      const src = await e.get(SOURCE);
      const fmt = await e.get(FORMAT);
      console.info(
        `[${SUITE}:${label}] DUMP(${why}) log=${JSON.stringify(log)}\n` +
          `  source status=${src?.job.status} code=${src?.job.errorCode} steps=${JSON.stringify(src?.steps.map((s) => `${s.kind}=${s.status}`))}\n` +
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
          userId: "u1",
          filename: "/media/movie.mkv",
          variant: "480p",
          parentSourceJobId: SOURCE,
          placementId: PLACEMENT_ID,
        },
      })
    );
    const waitLog = async (entry: string) => {
      try {
        await vi.waitFor(() => expect(log).toContain(entry), { timeout: 3000 });
      } catch (err) {
        await dump(`timeout waiting for ${entry}`);
        throw err;
      }
    };
    return { e, log, sourceUpload, transcode, discardJobOutputs, dump, waitLog };
  };

  it("removes the half-written encode when the source upload fails mid-transcode", async () => {
    const label = "fail-mid-transcode";
    const { e, log, sourceUpload, discardJobOutputs, dump, waitLog } = await boot(label, { holdTranscode: true });
    await waitLog(`start:upload:${SOURCE}`);
    await waitLog(`start:transcode:${FORMAT}`);
    sourceUpload.reject(new Error("STORAGE_GATEWAY_UNREACHABLE"));
    await waitLog(`discard:${FORMAT}:format-transcode-cancelled`);
    await dump("after-discard");
    expect(log.indexOf(`abort:transcode:${FORMAT}`)).toBeGreaterThanOrEqual(0);
    // The directory is removed only after the aborted encoder returned.
    expect(log.indexOf(`discard:${FORMAT}:format-transcode-cancelled`)).toBeGreaterThan(
      log.indexOf(`abort:transcode:${FORMAT}`)
    );
    expect(discardJobOutputs).toHaveBeenCalledWith({
      userId: "u1",
      jobId: FORMAT,
      reason: "format-transcode-cancelled",
      mediaId: "m1",
      commitStarted: false,
    });
    expect((await e.get(FORMAT))?.job.status).toBe("cancelled");
  });

  it("removes the finished encode when the source upload fails while the format waits for it", async () => {
    const label = "fail-between-steps";
    const { e, sourceUpload, discardJobOutputs, dump, waitLog } = await boot(label, { holdTranscode: false });
    await waitLog(`start:upload:${SOURCE}`);
    await waitLog(`end:transcode:${FORMAT}`);
    await vi.waitFor(async () => {
      const fmt = await e.get(FORMAT);
      expect(fmt?.steps.find((s) => s.kind === "transcode")?.status).toBe("succeeded");
      expect(fmt?.job.status).toBe("queued");
    });
    await dump("format-waiting-for-source-upload");
    sourceUpload.reject(new Error("STORAGE_GATEWAY_UNREACHABLE"));
    await waitLog(`discard:${FORMAT}:format-cancelled-between-steps`);
    await dump("after-discard");
    expect(discardJobOutputs).toHaveBeenCalledTimes(1);
    expect((await e.get(FORMAT))?.job.status).toBe("cancelled");
  });

  it("keeps the encode outputs on a graceful runtime stop (the step resumes next boot)", async () => {
    const label = "shutdown-keeps-outputs";
    const { e, log, discardJobOutputs, dump, waitLog } = await boot(label, { holdTranscode: true });
    await waitLog(`start:transcode:${FORMAT}`);
    await e.stop();
    engine = null;
    console.info(`[${SUITE}:${label}] log=${JSON.stringify(log)}`);
    expect(log).toContain(`abort:transcode:${FORMAT}`);
    expect(discardJobOutputs).not.toHaveBeenCalled();
    void dump;
  });
});

/**
 * @bugfix @regression-proof cancelled-format-dir-leaks-on-crash (#137 review P3).
 *
 * A running format job is cancelled; its handler only deletes the encode dir
 * once the aborted encoder returns. If the runtime dies in that window, the
 * job is stored `cancelled` with its step still `running`, hydration ignores
 * it (cancelled is terminal), and the dir leaks forever. Boot must settle the
 * stale step to `cancelled` and drop the dir — while a live job that was
 * running at the crash keeps its dir and resumes.
 */
describe(`[${SUITE}] boot settles cancelled format jobs left with a running step`, () => {
  const CANCELLED = "fmt-480p-cancelled";
  const LIVE = "fmt-720p-live";
  let tmp = "";
  let engine: EngineV2 | null = null;
  const prevTranscodeDir = process.env.SF_TRANSCODE_DIR;

  afterEach(async () => {
    console.info(`[${SUITE}:boot-sweep:teardown] tmp=${tmp}`);
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    __resetBadgerStepDeps();
    if (prevTranscodeDir === undefined) delete process.env.SF_TRANSCODE_DIR;
    else process.env.SF_TRANSCODE_DIR = prevTranscodeDir;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("drops the dir of a cancelled job stuck at transcode=running and keeps a resumable job's dir", async () => {
    const label = "boot-sweep";
    tmp = mkdtempSync(path.join(tmpdir(), "badger-fmt-boot-sweep-"));
    process.env.SF_TRANSCODE_DIR = path.join(tmp, "transcode");
    const dbPath = path.join(tmp, "jobs.db");
    const dirOf = (jobId: string) => path.join(tmp, "transcode", "u1", jobId);
    const formatJob = (jobId: string, variant: string) =>
      baseJob({
        jobId,
        kind: "format",
        lane: "format",
        variant,
        priority: 30,
        payload: { userId: "u1", filename: "/media/movie.mkv", variant, placementId: PLACEMENT_ID },
      });

    // Process 1: both encodes run; the handler ignores abort, standing in for
    // an encoder that has not exited yet when the runtime dies.
    const crashed = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 2 });
    await crashed.start();
    const started: string[] = [];
    crashed.registerHandler("transcode", async (ctx) => {
      started.push(ctx.job.jobId);
      mkdirSync(dirOf(ctx.job.jobId), { recursive: true });
      writeFileSync(path.join(dirOf(ctx.job.jobId), "seg-00001.m4s"), "partial");
      await new Promise<never>(() => {});
    });
    await crashed.submit(formatJob(CANCELLED, "480p"));
    await crashed.submit(formatJob(LIVE, "720p"));
    await vi.waitFor(() => expect(started.sort()).toEqual([LIVE, CANCELLED].sort()), { timeout: 3000 });
    await crashed.cancel(CANCELLED, "user");
    const atCrash = await crashed.get(CANCELLED);
    console.info(
      `[${SUITE}:${label}] at crash: ${CANCELLED} status=${atCrash?.job.status} steps=${JSON.stringify(
        atCrash?.steps.map((s) => `${s.kind}=${s.status}`)
      )} dirs: cancelled=${existsSync(dirOf(CANCELLED))} live=${existsSync(dirOf(LIVE))}`
    );
    expect(atCrash?.job.status).toBe("cancelled");
    expect(atCrash?.steps.find((s) => s.kind === "transcode")?.status).toBe("running");
    // "Crash": process 1 is abandoned without stop(); process 2 boots on the same DB.

    const discarded: string[] = [];
    const resumed: string[] = [];
    // Only discardJobOutputs (real fs.rm) is used from the adapter; the ingest
    // hook is required by the builder but never called here.
    const real = buildBadgerStepDeps({
      libraryDb: {} as never,
      processMediaJob: async () => {
        throw new Error("processMediaJob is not used by this test");
      },
      authWaitMs: 0,
    });
    configureBadgerStepDeps({
      ...real,
      discardJobOutputs: async (input) => {
        discarded.push(`${input.jobId}:${input.reason}`);
        await real.discardJobOutputs?.(input);
      },
      transcodeFormat: async (input) => {
        // Resumed live job: hold until the test stops the engine.
        console.info(`[${SUITE}:${label}] resumed transcode ${input.jobId}`);
        resumed.push(input.jobId);
        await new Promise<void>((_, reject) =>
          input.signal.addEventListener("abort", () => reject(Object.assign(new Error("CANCELLED"), { name: "AbortError" })))
        );
        throw new Error("unreachable");
      },
    });
    const rebooted = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 2 });
    engine = rebooted;
    // Production order (apps/runtime/src/index.ts): handlers before start().
    registerBadgerStepHandlers(rebooted);
    await rebooted.start();

    try {
      await vi.waitFor(() => expect(existsSync(dirOf(CANCELLED))).toBe(false), { timeout: 3000 });
    } finally {
      const after = await rebooted.get(CANCELLED);
      const live = await rebooted.get(LIVE);
      console.info(
        `[${SUITE}:${label}] after boot: discarded=${JSON.stringify(discarded)}\n` +
          `  ${CANCELLED} status=${after?.job.status} steps=${JSON.stringify(after?.steps.map((s) => `${s.kind}=${s.status}`))} dir=${existsSync(dirOf(CANCELLED))}\n` +
          `  ${LIVE} status=${live?.job.status} steps=${JSON.stringify(live?.steps.map((s) => `${s.kind}=${s.status}`))} dir=${existsSync(dirOf(LIVE))}`
      );
    }
    const after = await rebooted.get(CANCELLED);
    expect(after?.job.status).toBe("cancelled");
    expect(after?.steps.find((s) => s.kind === "transcode")?.status).toBe("cancelled");
    expect(discarded).toEqual([`${CANCELLED}:format-cancelled-before-restart`]);
    // The live job was interrupted by the crash: requeued, resumed, dir kept.
    expect(existsSync(dirOf(LIVE))).toBe(true);
    expect((await rebooted.get(LIVE))?.job.status).not.toBe("cancelled");
    // #25 P11: the cancelled job is never handed to an encoder again; only the
    // interrupted live job resumes.
    await vi.waitFor(() => expect(resumed).toContain(LIVE), { timeout: 3000 });
    expect(resumed).not.toContain(CANCELLED);
  });
});
