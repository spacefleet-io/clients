/**
 * @req RT-JOBS-03
 * @bugfix @regression-proof ingest-transcode-dir-leaks (issue #671, R1).
 *
 * Every engineV2 ingest job encodes into `<SF_TRANSCODE_DIR>/<userId>/<jobId>`
 * and uploads from there. Before the fix the directory (about the media's size)
 * stayed on disk forever. A succeeded source or format job must drop it; a
 * failed job keeps it (its steps may be inspected or re-run); storage objects
 * are never released on success.
 *
 * Runs the real badger step handlers on a real engineV2 with the real
 * `removeJobDir` dep from the adapter and fake encode/upload/commit deps.
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
} from "../src/modules/badger/steps/deps";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "badger-ingest-success-cleanup";
const ts = "2026-01-01T00:00:00.000Z";
const SOURCE = "src-ok";
const FORMAT = "fmt-ok-480p";
const PLACEMENT_ID = "placement-ok";

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

const extractResult = (jobDir: string): ExtractResult => ({
  jobDir,
  state: { version: 1, inputPath: "/media/movie.mkv", userId: "u1", createdAt: ts, outputs: [], subtitles: [] },
  segmentCount: 1,
});

const uploadResult = (): UploadResult => ({
  produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
  uploadedKeys: [],
});

describe(`[${SUITE}] a succeeded ingest drops its transcode directory`, () => {
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

  const boot = async (label: string, opts: { commitFails: boolean }) => {
    tmp = mkdtempSync(path.join(tmpdir(), "badger-ingest-cleanup-"));
    process.env.SF_TRANSCODE_DIR = path.join(tmp, "transcode");
    const dirOf = (jobId: string) => path.join(tmp, "transcode", "u1", jobId);
    const writeEncode = (jobId: string) => {
      mkdirSync(path.join(dirOf(jobId), "video"), { recursive: true });
      writeFileSync(path.join(dirOf(jobId), "video", "seg-00001.m4s"), "x".repeat(4096));
      writeFileSync(path.join(dirOf(jobId), "job_state.json"), "{}");
      console.info(`[${SUITE}:${label}] wrote encode dir ${dirOf(jobId)}`);
    };
    const real = buildBadgerStepDeps({
      libraryDb: {} as never,
      processMediaJob: async () => {
        throw new Error("processMediaJob is not used by this test");
      },
      authWaitMs: 0,
    });
    const discardJobOutputs = vi.fn(async () => undefined);
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
      extractSource: vi.fn(async (input) => {
        writeEncode(input.jobId);
        return extractResult(dirOf(input.jobId));
      }),
      transcodeFormat: vi.fn(async (input) => {
        writeEncode(input.jobId);
        return { ...extractResult(dirOf(input.jobId)), variant: input.variant };
      }),
      uploadOutputs: vi.fn(async () => uploadResult()),
      commit: vi.fn(async (input) => {
        if (opts.commitFails && input.scope === "source") throw new Error("LIBRARY_COMMIT_BROKEN");
        return { fileId: "file-1", formatIds: ["fmt-row-1"] };
      }),
      markMediaPlayable: vi.fn(async () => undefined),
      lookupParentSourceFileId: vi.fn(async () => "file-1"),
      discardJobOutputs,
      removeJobDir: real.removeJobDir,
    };
    configureBadgerStepDeps(deps);
    const e = createEngineV2({ dbPath: path.join(tmp, "jobs.db"), progressThrottleMs: 0, encodeCap: 1 });
    engine = e;
    await e.start();
    registerBadgerStepHandlers(e);
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
    const dump = async (why: string) => {
      const src = await e.get(SOURCE);
      const fmt = await e.get(FORMAT);
      console.info(
        `[${SUITE}:${label}] DUMP(${why}) dirs: source=${existsSync(dirOf(SOURCE))} format=${existsSync(dirOf(FORMAT))}\n` +
          `  source status=${src?.job.status} code=${src?.job.errorCode}\n` +
          `  format status=${fmt?.job.status} code=${fmt?.job.errorCode}`
      );
    };
    return { e, dirOf, discardJobOutputs, dump };
  };

  it("removes the source and format job directories once both succeeded", async () => {
    const label = "success";
    const { e, dirOf, discardJobOutputs, dump } = await boot(label, { commitFails: false });
    try {
      await vi.waitFor(async () => {
        expect((await e.get(SOURCE))?.job.status).toBe("succeeded");
        expect((await e.get(FORMAT))?.job.status).toBe("succeeded");
        expect(existsSync(dirOf(SOURCE))).toBe(false);
        expect(existsSync(dirOf(FORMAT))).toBe(false);
      }, { timeout: 5000 });
    } catch (err) {
      await dump("timeout");
      throw err;
    }
    await dump("done");
    // Success never releases uploaded storage objects.
    expect(discardJobOutputs).not.toHaveBeenCalled();
  });

  it("keeps the directory of a job that failed", async () => {
    const label = "failed-keeps-dir";
    const { e, dirOf, dump } = await boot(label, { commitFails: true });
    try {
      await vi.waitFor(async () => {
        expect((await e.get(SOURCE))?.job.status).toBe("failed");
      }, { timeout: 5000 });
    } catch (err) {
      await dump("timeout");
      throw err;
    }
    await dump("failed");
    expect(existsSync(dirOf(SOURCE))).toBe(true);
  });
});
