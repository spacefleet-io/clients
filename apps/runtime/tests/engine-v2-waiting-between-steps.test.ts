/**
 * @bugfix @regression-proof #2499
 * @req INGS-QUEUE-01
 *
 * Chris 2026-11-15: after a multi-file upload, many 360p rows sat "started"
 * at 1 % until he restarted Badger. The runtime log shows the encodes had
 * finished: each job then waited 12–17 min for an upload-lane slot while its
 * status stayed `running` on the last label. A job that finished a step and
 * waits for its next step's lane must go back to `queued` with the
 * `waiting` stage, and say so on the event stream.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEngineV2,
  type EngineV2,
  type RuntimeJobEvent,
  WAITING_STAGE_CODE,
} from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const T = "[engine-v2-waiting-between-steps]";
const ts = "2026-11-15T00:00:00.000Z";

const makeFormatJob = (jobId: string, createdAt: string): IngestJobRecord => ({
  jobId,
  app: "badger",
  kind: "format",
  lane: "format",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: { userId: "u1" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt,
  updatedAt: createdAt,
  startedAt: null,
  finishedAt: null,
  groupId: `g-${jobId}`,
  mediaId: `m-${jobId}`,
  variant: "360p",
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
});

const dump = async (
  label: string,
  engine: EngineV2 | null,
  events: RuntimeJobEvent[],
) => {
  try {
    console.error(`${T} === ${label} snapshot ===`);
    if (engine) {
      const listed = await engine.list();
      console.error(
        `${T} jobs=${JSON.stringify(
          listed.jobs.map((j) => ({
            jobId: j.jobId,
            status: j.status,
            stageCode: j.stageCode,
            stageLabel: j.stageLabel,
            progressPct: j.progressPct,
          })),
        )}`,
      );
    }
    console.error(
      `${T} events (${events.length})=${JSON.stringify(
        events.map((e) => ({
          jobId: e.jobId,
          event: e.event,
          status: e.payload.status,
          stageCode: e.payload.stageCode,
          pct: e.payload.progressPct,
        })),
      )}`,
    );
  } catch (err) {
    console.error(`${T} snapshot failed: ${String(err)}`);
  }
};

describe("engineV2: a job waiting for its next step's lane is queued, not running", () => {
  let engine: EngineV2 | null = null;

  afterEach(async () => {
    if (engine) {
      await engine.stop();
      engine = null;
    }
  });

  it("flips to queued + waiting after the encode while the upload lane is busy", async () => {
    console.info(`${T} setup: upload cap 1, two 360p jobs, first upload blocks`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0, uploadCap: 1 });
    await engine.start();

    const { promise: uploadGate, resolve: releaseUpload } = Promise.withResolvers<void>();
    const uploadsStarted: string[] = [];
    engine.registerHandler("transcode", async ({ job, reportProgress }) => {
      console.info(`${T} transcode ${job.jobId}`);
      reportProgress(50, "Transcoding 360p", "transcoding");
      reportProgress(100, "Transcoded 360p", "transcoding");
    });
    engine.registerHandler("upload", async ({ job, reportProgress }) => {
      console.info(`${T} upload start ${job.jobId}`);
      uploadsStarted.push(job.jobId);
      reportProgress(1, "Uploading", "uploading");
      await uploadGate;
      reportProgress(100, "Uploaded", "uploading");
    });
    engine.registerHandler("commit", async () => {});

    const events: RuntimeJobEvent[] = [];
    engine.subscribe((e) => events.push(e));

    try {
      await engine.submit(makeFormatJob("job-a", "2026-11-15T00:00:00.000Z"));
      await engine.submit(makeFormatJob("job-b", "2026-11-15T00:00:01.000Z"));

      console.info(`${T} phase: wait for job-a to hold the upload lane`);
      await vi.waitFor(() => expect(uploadsStarted).toEqual(["job-a"]), { timeout: 3000 });

      console.info(`${T} phase: wait for job-b to finish its encode and wait for the lane`);
      await vi.waitFor(
        async () => {
          const b = await engine!.get("job-b");
          expect(b?.steps.find((s) => s.kind === "transcode")?.status).toBe("succeeded");
          expect(b?.job.status).toBe("queued");
        },
        { timeout: 3000 },
      );
      const b = await engine.get("job-b");
      await dump("job-b-waiting", engine, events);
      expect(uploadsStarted).toEqual(["job-a"]);
      expect(b?.job.status).toBe("queued");
      expect(b?.job.stageCode).toBe(WAITING_STAGE_CODE);
      expect(b?.job.stageLabel).toBe("Waiting");

      const lastB = events.filter((e) => e.jobId === "job-b").at(-1);
      console.info(`${T} last job-b event=${JSON.stringify(lastB)}`);
      expect(lastB?.event).toBe("runtime.jobs.progress");
      expect(lastB?.payload).toMatchObject({
        status: "queued",
        stageCode: WAITING_STAGE_CODE,
        stageLabel: "Waiting",
      });

      console.info(`${T} phase: release the lane; both jobs finish`);
      releaseUpload();
      await vi.waitFor(
        async () => {
          const listed = await engine!.list();
          expect(listed.jobs.map((j) => j.status).sort()).toEqual(["succeeded", "succeeded"]);
        },
        { timeout: 3000 },
      );
      expect(uploadsStarted).toEqual(["job-a", "job-b"]);
    } catch (err) {
      await dump("failure", engine, events);
      throw err;
    } finally {
      releaseUpload();
    }
  });
});
