/**
 * @bugfix @regression-proof
 *
 * Issue #25 (ultimate stress, F4): every add-quality (replan) job failed at
 * its final step with `STEP_COMMIT_MISSING_FILENAME`, so no extra quality was
 * ever committed (and the next ones with `STEP_COMMIT_MISSING_PARENT_SOURCE_
 * JOB_ID`).
 *
 * Root cause: `badger.media.replan_qualities` builds a `retranscode: true`
 * format job whose payload carries `fileId` (the exact media_files row the new
 * format belongs to) but neither `filename` nor `parentSourceJobId` /
 * `parentJobIds`. The shared commit step still demanded all three, as if the
 * job were an ingest-time format job chained to a live source job. A replan
 * has no source job (it ran in an earlier session), and `filename` is only
 * read by the source-scope commit.
 *
 * The test feeds the payload the REAL replan handler produces into the REAL
 * commit step handler and asserts the format row is committed against the
 * payload's `fileId`.
 */
import { describe, expect, it, vi } from "vitest";
import type { EngineV2, StepHandlerCtx } from "../src/core/jobs/engineV2";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { createBadgerMediaReplanQualitiesHandler } from "../src/modules/badger/mediaReplan";
import { commitStepHandler } from "../src/modules/badger/steps";
import {
  __resetBadgerStepDeps,
  configureBadgerStepDeps,
  type BadgerStepDeps,
  type CommitInput,
} from "../src/modules/badger/steps/deps";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "badger-replan-commit";
const ts = "2026-01-01T00:00:00.000Z";

const row = (id: string, quality: string, isSource: boolean) => ({
  id,
  mediaId: "m-1",
  fileId: "f-ep2",
  quality,
  codec: "h264",
  isSource,
  initKey: `${id}.init`,
  chunks: [{ key: `${id}.1`, sizeBytes: 10 }],
});

async function replanJob(): Promise<IngestJobRecord> {
  const submitted: IngestJobRecord[] = [];
  const engine = {
    submit: vi.fn(async (record: IngestJobRecord) => {
      submitted.push(record);
      return { jobId: record.jobId };
    }),
  } as unknown as EngineV2;
  const libraryDb = {
    call: vi.fn(async (method: string) => {
      if (method === "listMediaFormats") return [row("fmt-1080", "1080p", true), row("fmt-360", "360p", false)];
      throw new Error(`unexpected libraryDb.call: ${method}`);
    }),
  } as unknown as BadgerLibraryDbService;
  const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb, resolveActiveUserId: () => "user-1" });
  const result = await handler({ mediaId: "m-1", fileId: "f-ep2", addQualities: ["720p"], removeFormatIds: [] });
  expect(result.errorCode).toBeUndefined();
  expect(submitted).toHaveLength(1);
  return { ...submitted[0]!, status: "running" };
}

describe("replan (retranscode) format job commit @bugfix @regression-proof", () => {
  it("commits the new format against the payload fileId without filename or a parent source job", async () => {
    const job = await replanJob();
    console.info(`[${SUITE}] replan job payload=${JSON.stringify(job.payload)} parentJobIds=${JSON.stringify(job.parentJobIds)}`);

    const commit = vi.fn(async (input: CommitInput) => ({ fileId: input.sourceFileId ?? "?", formatIds: ["fmt-720"] }));
    const lookupParentSourceFileId = vi.fn(async () => null);
    configureBadgerStepDeps({ commit, lookupParentSourceFileId, markMediaPlayable: vi.fn(async () => undefined) } as unknown as BadgerStepDeps);

    const step = {
      stepId: `${job.jobId}:commit`,
      jobId: job.jobId,
      kind: "commit",
      outputs: { uploadResult: { produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] } } },
    } as unknown as StoredStepRecord;
    const emitted: Record<string, unknown> = {};
    const ctx: StepHandlerCtx = {
      job,
      step,
      signal: new AbortController().signal,
      reportProgress: () => {},
      emitOutputs: (out) => Object.assign(emitted, out),
    };

    try {
      await commitStepHandler(ctx);
    } finally {
      console.info(`[${SUITE}] commit calls=${JSON.stringify(commit.mock.calls.map((c) => ({ ...c[0], signal: undefined, produced: undefined })))} emitted=${JSON.stringify(emitted)}`);
      __resetBadgerStepDeps();
    }

    expect(commit).toHaveBeenCalledTimes(1);
    const input = commit.mock.calls[0]![0];
    expect(input).toMatchObject({ scope: "format", variant: "720p", mediaId: "m-1", sourceFileId: "f-ep2", userId: "user-1" });
    expect(lookupParentSourceFileId).not.toHaveBeenCalled();
    expect(emitted.commitResult).toMatchObject({ fileId: "f-ep2", formatIds: ["fmt-720"] });
  });
});
