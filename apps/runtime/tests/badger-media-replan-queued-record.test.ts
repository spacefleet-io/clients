/**
 * @bugfix replan-format-job-null-stage-code-crash
 * @regression-proof
 *
 * Adding a quality submitted a `kind:"format"` job built from `baseRecord`,
 * which set `stageCode: null, stageLabel: null, progress: null,
 * progressPct: null`. Those columns are NOT NULL on `runtime_jobs`
 * (stage_code/stage_label default '', progress_pct default 0) AND non-null on
 * `IngestJobRecord`, so `engine.submit` crashed with
 * `SQLiteError: NOT NULL constraint failed: runtime_jobs.stage_code` — no job
 * was created, and the renderer surfaced a toast (not the Jobs tray).
 *
 * It never fired before because this is the ONLY path that submits a job from
 * the desktop: a sync-populated library has zero local jobs, so the queued
 * record's bad shape was latent until a user re-added a quality.
 *
 * Pre-fix: the submitted job's stageCode is null.
 * Post-fix: it mirrors the working ingest path (`stageCode: "queued"`,
 * `stageLabel: "Queued"`, `progressPct: 0`, a real `progress` object).
 *
 * The mock engine here records the submitted record rather than enforcing the
 * NOT NULL constraint, so the regression is pinned at the queued-record shape
 * (the field that actually violates the column).
 */
import { describe, expect, it, vi } from "vitest";
import type { EngineV2 } from "../src/core/jobs/engineV2";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { createBadgerMediaReplanQualitiesHandler } from "../src/modules/badger/mediaReplan";
import type { IngestJobRecord } from "@space/runtime-jobs";

type MediaFormatRow = {
  id: string;
  mediaId: string;
  fileId: string;
  quality: string;
  codec: string;
  isSource: boolean;
  initKey: string | null;
  chunks: Array<{ key: string; sizeBytes: number | null }>;
};

const buildEngine = () => {
  const submitted: IngestJobRecord[] = [];
  const engine = {
    submit: vi.fn(async (record: IngestJobRecord) => {
      console.info(
        `[badger-media-replan-queued-record:engine] submit() received kind=${JSON.stringify(record.kind)} variant=${JSON.stringify(record.variant)} stageCode=${JSON.stringify(record.stageCode)}`,
      );
      submitted.push(record);
      return { jobId: record.jobId };
    }),
  } as unknown as EngineV2;
  return { engine, submitted };
};

const buildLibraryDb = (rows: MediaFormatRow[]) => {
  const removed: string[] = [];
  const libraryDb = {
    call: vi.fn(async (method: string, args: unknown[] = []) => {
      console.info(
        `[badger-media-replan-queued-record:libraryDb] call(${method}) args=${JSON.stringify(args)}`,
      );
      if (method === "listMediaFormats") return rows;
      if (method === "removeMediaFormat") {
        removed.push(args[0] as string);
        return null;
      }
      throw new Error(`unexpected libraryDb.call: ${method}`);
    }),
  } as unknown as BadgerLibraryDbService;
  return { libraryDb, removed };
};

// On assertion failure, dump the submitted job records (the field shape the
// bug lives in) + the removed-format list so the regression is diagnosable
// offline (per the "Tests log generously" rule).
const dumpReplanSnapshot = (
  label: string,
  ctx: { result?: unknown; submitted?: IngestJobRecord[]; removed?: string[] },
) => {
  try {
    console.error(`=== [badger-media-replan-queued-record:${label}] snapshot ===`);
    console.error(`handler result=${JSON.stringify(ctx.result, null, 2)}`);
    const submitted = ctx.submitted ?? [];
    console.error(`submitted job count=${submitted.length}`);
    console.error(`submitted jobs:\n${JSON.stringify(submitted, null, 2)}`);
    console.error(`removed formatIds=${JSON.stringify(ctx.removed ?? [])}`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("@bugfix @regression-proof badger.media.replan_qualities — queued format-job record shape", () => {
  it("submits a job whose NOT NULL fields (stage_code/stage_label/progress_pct) are non-null", async () => {
    // Source-only file: adding 360p is valid (transcode down from 1080p).
    const rows: MediaFormatRow[] = [
      {
        id: "fmt-1080",
        mediaId: "m-1",
        fileId: "f-1",
        quality: "1080p",
        codec: "h264",
        isSource: true,
        initKey: "init-1080",
        chunks: [{ key: "c1", sizeBytes: 1000 }],
      },
    ];
    console.info("[badger-media-replan-queued-record:setup] building mock engine + libraryDb with 1 source row (1080p h264)");
    const { engine, submitted } = buildEngine();
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    console.info("[badger-media-replan-queued-record:invoke] calling replan handler addQualities=[360p] removeFormatIds=[]");
    const result = await handler({
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["360p"],
      removeFormatIds: [],
    });

    console.info(
      `[badger-media-replan-queued-record:invoke] result=${JSON.stringify(result)} submittedCount=${submitted.length}`,
    );

    try {
      // The handler must have reached submit (no spurious refusal) and produced
      // exactly one job.
      expect(result.errorCode).toBeUndefined();
      expect(submitted).toHaveLength(1);

      const job = submitted[0]!;
      console.info(
        `[badger-media-replan-queued-record:assert] job stageCode=${JSON.stringify(job.stageCode)} stageLabel=${JSON.stringify(job.stageLabel)} progressPct=${JSON.stringify(job.progressPct)} progress=${JSON.stringify(job.progress)}`,
      );

      // The crux: these are NOT NULL on runtime_jobs. Pre-fix they were null.
      expect(job.stageCode).not.toBeNull();
      expect(typeof job.stageCode).toBe("string");
      expect(job.stageCode).toBe("queued");
      expect(job.stageLabel).not.toBeNull();
      expect(typeof job.stageLabel).toBe("string");
      expect(job.progressPct).not.toBeNull();
      expect(job.progressPct).toBe(0);
      expect(job.progress).not.toBeNull();
      expect(typeof job.progress).toBe("object");
      // Sanity on the rest of the submitted shape.
      expect(job.kind).toBe("format");
      expect(job.variant).toBe("360p");
      expect(job.status).toBe("queued");
    } catch (err) {
      dumpReplanSnapshot("queued-record-shape-assert-failed", {
        result,
        submitted,
        removed,
      });
      throw err;
    }
  });
});
