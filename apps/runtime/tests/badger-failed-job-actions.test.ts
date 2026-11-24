/**
 * @req INGS-KEEP-01[runtime]
 * Backs UX-JOBS-03 (failed job card) and the "Try again" part of INGS-RESUME-01.
 *
 * A failed Badger import offers ONE action that fits what is still on disk,
 * and running it never redoes finished work:
 * - processed copy kept → "upload again" resumes the upload, no new encode, same jobId;
 * - copy gone, original file unchanged → "process again";
 * - original file moved or changed → "find the file"; a picked file must be the same video;
 * - original file in the trash → "remove only";
 * - same video imported since → "already in the library".
 * Kept copies go after 14 days, or oldest first while the disk is low; that
 * state survives a restart; removing the job drops its copy; nothing retries
 * on its own.
 *
 * Real engineV2 + real badger step handlers + the real `removeJobDir`; fake
 * probe/identify/encode/upload/commit deps.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEngineV2, type EngineV2 } from "../src/core/jobs/engineV2";
import { registerBadgerStepHandlers } from "../src/modules/badger/steps";
import { buildBadgerStepDeps } from "../src/modules/badger/steps/deps-adapter";
import { configureBadgerStepDeps, __resetBadgerStepDeps, type BadgerStepDeps } from "../src/modules/badger/steps/deps";
import {
  createBadgerFailedJobs,
  fingerprintSourceFile,
  KEPT_COPIES_MAX_AGE_MS,
  KEPT_COPIES_MIN_FREE_BYTES,
  type BadgerFailedJobs,
} from "../src/modules/badger/failedJobs";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { FailedJobAvailability } from "@space/runtime-contracts/runtime/jobs";

const SUITE = "badger-failed-job-actions";
const ts = "2026-01-01T00:00:00.000Z";
const PLENTY = 500 * 1024 ** 3;

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
  payload: {},
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

describe(`[${SUITE}] a failed import offers the action that fits`, () => {
  let tmp = "";
  let engine: EngineV2 | null = null;
  const prevTranscodeDir = process.env.SF_TRANSCODE_DIR;

  afterEach(async () => {
    console.info(`[${SUITE}:teardown] tmp=${tmp}`);
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    __resetBadgerStepDeps();
    if (prevTranscodeDir === undefined) delete process.env.SF_TRANSCODE_DIR;
    else process.env.SF_TRANSCODE_DIR = prevTranscodeDir;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  interface Harness {
    deps: BadgerStepDeps;
    dirOf(jobId: string): string;
    writeMedia(name: string, body?: string): string;
    submitSource(jobId: string, file: string): Promise<void>;
    waitStatus(jobId: string, status: string): Promise<void>;
    ask(jobId: string): Promise<FailedJobAvailability>;
    restart(): Promise<void>;
    readonly e: EngineV2;
    readonly failed: BadgerFailedJobs;
  }

  /** `uploadFailures`: how many upload calls throw before uploads succeed. */
  const boot = async (label: string, opts: { uploadFailures?: number; uploadError?: string } = {}): Promise<Harness> => {
    tmp = mkdtempSync(path.join(tmpdir(), "badger-failed-actions-"));
    process.env.SF_TRANSCODE_DIR = path.join(tmp, "transcode");
    mkdirSync(path.join(tmp, "media"), { recursive: true });
    mkdirSync(path.join(tmp, "trash"), { recursive: true });
    const dirOf = (jobId: string) => path.join(tmp, "transcode", "u1", jobId);
    let uploadFailuresLeft = opts.uploadFailures ?? 1;
    const real = buildBadgerStepDeps({
      libraryDb: {} as never,
      processMediaJob: async () => {
        throw new Error("processMediaJob is not used by this test");
      },
      authWaitMs: 0,
    });
    const writeEncode = (jobId: string) => {
      mkdirSync(path.join(dirOf(jobId), "video"), { recursive: true });
      writeFileSync(path.join(dirOf(jobId), "video", "seg-00001.m4s"), "x".repeat(4096));
      writeFileSync(path.join(dirOf(jobId), "job_state.json"), JSON.stringify({ outputs: [{ encodingComplete: true }] }));
      console.info(`[${SUITE}:${label}] encoded ${jobId} into ${dirOf(jobId)}`);
    };
    const encodeResult = (jobId: string) => ({
      jobDir: dirOf(jobId),
      state: { version: 1, inputPath: "x", userId: "u1", createdAt: ts, outputs: [], subtitles: [] },
      segmentCount: 1,
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
      identify: vi.fn(async () => ({ mediaId: "m1", parsedTitle: "Movie", season: null, episode: null, year: null, preexistingHint: true })),
      extractSource: vi.fn(async (input) => {
        writeEncode(input.jobId);
        return encodeResult(input.jobId);
      }),
      transcodeFormat: vi.fn(async (input) => {
        writeEncode(input.jobId);
        return { ...encodeResult(input.jobId), variant: input.variant };
      }),
      uploadOutputs: vi.fn(async (input: { jobId: string }) => {
        if (uploadFailuresLeft > 0) {
          uploadFailuresLeft -= 1;
          console.info(`[${SUITE}:${label}] upload of ${input.jobId} fails on purpose`);
          throw new Error(opts.uploadError ?? "R2 upload timed out");
        }
        return { produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] }, uploadedKeys: [] };
      }),
      commit: vi.fn(async () => ({ fileId: "file-1", formatIds: ["fmt-row-1"] })),
      markMediaPlayable: vi.fn(async () => undefined),
      lookupParentSourceFileId: vi.fn(async () => "file-1"),
      discardJobOutputs: vi.fn(async (input: { userId: string; jobId: string; reason: string }) => {
        await real.removeJobDir!(input);
      }),
      removeJobDir: real.removeJobDir,
    };
    configureBadgerStepDeps(deps);
    const dbPath = path.join(tmp, "jobs.db");
    const start = async () => {
      const e = createEngineV2({ dbPath, progressThrottleMs: 0, encodeCap: 1 });
      engine = e;
      registerBadgerStepHandlers(e);
      await e.start();
      const failed = createBadgerFailedJobs({
        engine: e,
        freeBytesAt: () => PLENTY,
        trashPathsFor: (file) => [path.join(tmp, "trash", path.basename(file))],
      });
      return { e, failed };
    };
    let { e, failed } = await start();
    const writeMedia = (name: string, body = "video-bytes-".repeat(1000)) => {
      const file = path.join(tmp, "media", name);
      writeFileSync(file, body);
      return file;
    };
    const submitSource = async (jobId: string, file: string) => {
      await e.submit(
        baseJob({
          jobId,
          payload: {
            userId: "u1",
            filename: file,
            hints: {},
            placementId: `placement-${jobId}`,
            sourceFingerprint: await fingerprintSourceFile(file),
          },
        })
      );
    };
    const waitStatus = async (jobId: string, status: string) => {
      try {
        await vi.waitFor(async () => expect((await e.get(jobId))?.job.status).toBe(status), { timeout: 5000 });
      } catch (err) {
        const found = await e.get(jobId);
        console.info(
          `[${SUITE}:${label}] DUMP ${jobId} wanted=${status} got=${found?.job.status} code=${found?.job.errorCode} ` +
            `msg=${found?.job.errorMessage} steps=${JSON.stringify(found?.steps.map((s) => [s.kind, s.status]))}`
        );
        throw err;
      }
    };
    const ask = async (jobId: string) => {
      const { jobs } = await failed.availability([jobId]);
      console.info(`[${SUITE}:${label}] availability ${jobId} → ${JSON.stringify(jobs[0])}`);
      return jobs[0]!;
    };
    const restart = async () => {
      console.info(`[${SUITE}:${label}] restarting the engine on the same db`);
      await e.stop();
      ({ e, failed } = await start());
    };
    return {
      deps,
      dirOf,
      writeMedia,
      submitSource,
      waitStatus,
      ask,
      restart,
      get e() {
        return e;
      },
      get failed() {
        return failed;
      },
    };
  };

  const failOneUpload = async (h: Harness, jobId: string, name = `${jobId}.mkv`) => {
    const file = h.writeMedia(name);
    await h.submitSource(jobId, file);
    await h.waitStatus(jobId, "failed");
    return file;
  };

  it("upload failed with the copy kept → upload again resumes the upload only, same job", async () => {
    const h = await boot("upload-again");
    await failOneUpload(h, "src-a");
    expect(h.deps.extractSource).toHaveBeenCalledTimes(1);
    const before = await h.ask("src-a");
    expect(before).toMatchObject({ action: "upload_again", reason: "kept_outputs" });
    expect(before.keptBytes).toBeGreaterThan(4000);
    expect(Date.parse(before.keptUntil!) - Date.now()).toBeGreaterThan(KEPT_COPIES_MAX_AGE_MS - 60_000);

    const result = await h.failed.retry({ jobId: "src-a" });
    expect(result).toEqual({ retried: true, newJobId: "src-a" });
    await h.waitStatus("src-a", "succeeded");
    // The encode was not run again; only the upload was.
    expect(h.deps.extractSource).toHaveBeenCalledTimes(1);
    expect(h.deps.uploadOutputs).toHaveBeenCalledTimes(2);
    expect((await h.e.list({ app: "badger", includeDismissed: true })).jobs.map((j) => j.jobId)).toEqual(["src-a"]);
  });

  it("copy gone and file unchanged → process again re-encodes", async () => {
    const h = await boot("process-again");
    await failOneUpload(h, "src-b");
    rmSync(h.dirOf("src-b"), { recursive: true, force: true });
    expect(await h.ask("src-b")).toMatchObject({ action: "process_again", reason: "source_unchanged", keptBytes: null });
    // Asking for the upload when no copy is left is refused with what fits now.
    expect(await h.failed.retry({ jobId: "src-b", mode: "upload" })).toEqual({
      retried: false,
      action: "process_again",
      reason: "source_unchanged",
    });
    expect(await h.failed.retry({ jobId: "src-b" })).toEqual({ retried: true, newJobId: "src-b" });
    await h.waitStatus("src-b", "succeeded");
    expect(h.deps.extractSource).toHaveBeenCalledTimes(2);
  });

  it("file moved → find the file; another file is refused, the same video is used", async () => {
    const h = await boot("find-file");
    const file = await failOneUpload(h, "src-c");
    rmSync(h.dirOf("src-c"), { recursive: true, force: true });
    const moved = path.join(tmp, "media", "moved.mkv");
    renameSync(file, moved);
    expect(await h.ask("src-c")).toMatchObject({ action: "find_file", reason: "source_missing" });
    expect(await h.failed.retry({ jobId: "src-c" })).toMatchObject({ retried: false, action: "find_file" });

    const other = h.writeMedia("other.mkv", "another-video-".repeat(1000));
    expect(await h.failed.retry({ jobId: "src-c", mode: "relocate", path: other })).toEqual({
      retried: false,
      action: "find_file",
      reason: "picked_mismatch",
    });
    expect(await h.failed.retry({ jobId: "src-c", mode: "relocate", path: moved })).toEqual({
      retried: true,
      newJobId: "src-c",
    });
    await h.waitStatus("src-c", "succeeded");
    expect((await h.e.get("src-c"))?.job.payload.filename).toBe(moved);
  });

  it("file changed in place → find the file", async () => {
    const h = await boot("changed");
    const file = await failOneUpload(h, "src-d");
    rmSync(h.dirOf("src-d"), { recursive: true, force: true });
    appendFileSync(file, "more-bytes");
    expect(await h.ask("src-d")).toMatchObject({ action: "find_file", reason: "source_changed" });
    expect(await h.failed.retry({ jobId: "src-d", mode: "process" })).toMatchObject({ retried: false, reason: "source_changed" });
  });

  it("file in the trash → remove only", async () => {
    const h = await boot("trashed");
    const file = await failOneUpload(h, "src-e");
    rmSync(h.dirOf("src-e"), { recursive: true, force: true });
    renameSync(file, path.join(tmp, "trash", "src-e.mkv"));
    expect(await h.ask("src-e")).toMatchObject({ action: "remove_only", reason: "source_deleted" });
  });

  it("same video imported since → already in the library", async () => {
    const h = await boot("reimported");
    const file = await failOneUpload(h, "src-f");
    await h.e.submit(
      baseJob({
        jobId: "src-f2",
        createdAt: new Date(Date.now() + 1000).toISOString(),
        payload: { userId: "u1", filename: file, hints: {}, placementId: "placement-src-f2" },
      })
    );
    await h.waitStatus("src-f2", "succeeded");
    expect(await h.ask("src-f")).toMatchObject({ action: "already_in_library", reason: "reimported" });
  });

  it("plan full → upgrade plan, then upload again", async () => {
    const h = await boot("quota", { uploadError: "upload_quota_exceeded: plan is full" });
    await failOneUpload(h, "src-g");
    expect(await h.ask("src-g")).toMatchObject({ action: "upgrade_plan", reason: "upload_quota", nextAction: "upload_again" });
  });

  it("copies older than 14 days go; the job then offers process again, also after a restart", async () => {
    const h = await boot("expired");
    await failOneUpload(h, "src-h");
    const late = createBadgerFailedJobs({ engine: h.e, freeBytesAt: () => PLENTY, now: () => Date.now() + KEPT_COPIES_MAX_AGE_MS + 1 });
    expect(await late.sweepKeptCopies("test")).toMatchObject({ removed: 1 });
    expect(existsSync(h.dirOf("src-h"))).toBe(false);
    expect(await h.ask("src-h")).toMatchObject({ action: "process_again", reason: "kept_removed_expired" });
    await h.restart();
    expect(await h.ask("src-h")).toMatchObject({ action: "process_again", reason: "kept_removed_expired" });
  });

  it("low disk removes the oldest kept copy first and stops once there is room", async () => {
    const h = await boot("low-disk", { uploadFailures: 2 });
    await failOneUpload(h, "src-old");
    await failOneUpload(h, "src-new");
    // Oldest = failed first; the two runs take several engine passes each, so their times differ.
    const finishedAt = async (jobId: string) => Date.parse((await h.e.get(jobId))!.job.finishedAt!);
    expect(await finishedAt("src-old")).toBeLessThan(await finishedAt("src-new"));
    let calls = 0;
    const sweeper = createBadgerFailedJobs({
      engine: h.e,
      freeBytesAt: () => (calls++ === 0 ? KEPT_COPIES_MIN_FREE_BYTES - 1 : PLENTY),
    });
    expect(await sweeper.sweepKeptCopies("test")).toMatchObject({ removed: 1 });
    expect(existsSync(h.dirOf("src-old"))).toBe(false);
    expect(existsSync(h.dirOf("src-new"))).toBe(true);
    expect(await h.ask("src-old")).toMatchObject({ action: "process_again", reason: "kept_removed_low_disk" });
    expect(await h.ask("src-new")).toMatchObject({ action: "upload_again" });
  });

  it("a kept copy survives a restart and nothing retries on its own", async () => {
    const h = await boot("restart");
    await failOneUpload(h, "src-i");
    await h.restart();
    expect((await h.e.get("src-i"))?.job.status).toBe("failed");
    expect(h.deps.uploadOutputs).toHaveBeenCalledTimes(1);
    expect(await h.ask("src-i")).toMatchObject({ action: "upload_again" });
  });

  it("removing the failed job drops its kept copy", async () => {
    const h = await boot("dismiss");
    await failOneUpload(h, "src-j");
    expect(existsSync(h.dirOf("src-j"))).toBe(true);
    expect(await h.e.dismiss("src-j")).toEqual({ dismissed: true });
    await vi.waitFor(() => expect(existsSync(h.dirOf("src-j"))).toBe(false), { timeout: 3000 });
    expect(h.deps.discardJobOutputs).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "src-j", reason: "failed-job-removed", commitStarted: false })
    );
  });
});
