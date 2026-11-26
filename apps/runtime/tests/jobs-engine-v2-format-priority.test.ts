/**
 * @bugfix @regression-proof P23 (ultimate confirm run 2026-10-07, seed
 * 1791373829836): a user-requested 720p took 9–52 min on the low-end preset
 * (format lane cap 1).
 *
 *  1. The replan job was queued at priority 20, behind ingest backfill at
 *     10 (1080p) / 5 (2160p), so every queued backfill encode ran first.
 *  2. A finished encode's `commit` step needed the format lane slot, so it
 *     waited for the NEXT job's whole encode (4–17 min in the run's
 *     runtime_jobs.db: a7cb7488 retranscode ended 12:52:48, commit ran
 *     13:09:56).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngineV2, type EngineV2, type RuntimeJobEvent } from "@space/runtime-jobs-engine/engineV2";
import { userRequestedFormatPriority } from "../src/modules/badger/mediaReplan";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "jobs-engine-v2-format-priority";
const ts = "2026-01-01T00:00:00.000Z";

let seq = 0;
const makeFormatJob = (overrides: Partial<IngestJobRecord> & { jobId: string }): IngestJobRecord => {
  seq += 1;
  return {
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
    // Strictly increasing createdAt so FIFO ties are deterministic.
    createdAt: new Date(Date.parse(ts) + seq * 1000).toISOString(),
    updatedAt: ts,
    startedAt: null,
    finishedAt: null,
    groupId: "g1",
    mediaId: "m1",
    variant: "1080p",
    parentJobIds: [],
    dismissedAt: null,
    uploadSpeedBytesPerSec: null,
    ...overrides,
  };
};

const makeGate = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: resolve };
};

const dumpSnapshot = async (
  label: string,
  ctx: { engine: EngineV2 | null; order?: string[]; events?: RuntimeJobEvent[] }
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`order=${JSON.stringify(ctx.order ?? [])}`);
    if (ctx.engine) {
      const listed = await ctx.engine.list();
      console.error(
        `jobs=${JSON.stringify(
          listed.jobs.map((j) => ({
            jobId: j.jobId,
            status: j.status,
            priority: j.priority,
            variant: j.variant,
            payload: j.payload,
          })),
          null,
          2
        )}`
      );
    }
    if (ctx.events) {
      console.error(`events (last 15 of ${ctx.events.length})=${JSON.stringify(ctx.events.slice(-15), null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe(`${SUITE} @bugfix @regression-proof`, () => {
  let engine: EngineV2 | null = null;

  afterEach(async () => {
    console.info(`[${SUITE}:teardown] stopping engine`);
    if (engine) {
      await engine.stop();
      engine = null;
    }
  });

  it("puts a user-requested quality ahead of every ingest backfill variant", () => {
    const requested = userRequestedFormatPriority("720p");
    // Ingest backfill priorities (ingestSubmit PRIORITY_BY_VARIANT / mediaReplan): 2160p=5 … 144p=60.
    const backfill = { "2160p": 5, "1080p": 10, "720p": 20, "480p": 30, "360p": 40, "144p": 60 };
    console.info(`[${SUITE}:band] requested 720p priority=${requested} backfill=${JSON.stringify(backfill)}`);
    for (const [variant, priority] of Object.entries(backfill)) {
      expect(requested, `requested 720p must sort before backfill ${variant}`).toBeLessThan(priority);
    }
    // Requests keep their own relative order (a requested 1080p before a requested 720p).
    expect(userRequestedFormatPriority("1080p")).toBeLessThan(requested);
  });

  it("dispatches a requested 720p before queued backfill encodes on a format cap of 1", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ format: 1 });

    const order: string[] = [];
    const events: RuntimeJobEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const blocker = makeGate();
    const encode = async ({ job }: { job: IngestJobRecord }) => {
      console.info(`[${SUITE}:overtake] encode start ${job.jobId} priority=${job.priority}`);
      order.push(job.jobId);
      if (job.jobId === "running-1080p") await blocker.promise;
    };
    engine.registerHandler("transcode", encode);
    engine.registerHandler("retranscode", encode);
    engine.registerHandler("upload", async () => {});
    engine.registerHandler("commit", async () => {});

    try {
      await engine.submit(makeFormatJob({ jobId: "running-1080p", priority: 10, variant: "1080p" }));
      await vi.waitFor(() => expect(order).toEqual(["running-1080p"]), { timeout: 2000 });

      // Backfill queued while the first encode runs (other titles' ingest formats).
      await engine.submit(makeFormatJob({ jobId: "backfill-1080p", priority: 10, variant: "1080p", mediaId: "m2" }));
      await engine.submit(makeFormatJob({ jobId: "backfill-480p", priority: 30, variant: "480p", mediaId: "m3" }));
      await engine.submit(makeFormatJob({ jobId: "backfill-360p", priority: 40, variant: "360p", mediaId: "m4" }));
      // The user then picks 720p in the player: a replan retranscode job.
      await engine.submit(
        makeFormatJob({
          jobId: "requested-720p",
          priority: userRequestedFormatPriority("720p"),
          variant: "720p",
          mediaId: "m5",
          payload: { userId: "u1", retranscode: true },
        })
      );
      console.info(`[${SUITE}:overtake] queue built; releasing the running encode`);
      blocker.open();

      await vi.waitFor(() => expect(order.length).toBe(5), { timeout: 5000 });
      console.info(`[${SUITE}:overtake] dispatch order=${JSON.stringify(order)}`);
      expect(order[1]).toBe("requested-720p");
      expect(order.slice(2)).toEqual(["backfill-1080p", "backfill-480p", "backfill-360p"]);
    } catch (err) {
      blocker.open();
      await dumpSnapshot("overtake", { engine, order, events });
      throw err;
    }
  });

  it("runs a finished encode's commit while another job's encode holds the only format slot", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ format: 1 });

    const order: string[] = [];
    const events: RuntimeJobEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const longEncode = makeGate();
    engine.registerHandler("transcode", async ({ job }) => {
      console.info(`[${SUITE}:commit-exempt] transcode start ${job.jobId}`);
      order.push(`transcode:${job.jobId}`);
      if (job.jobId === "backfill") await longEncode.promise;
    });
    engine.registerHandler("upload", async ({ job }) => {
      order.push(`upload:${job.jobId}`);
    });
    engine.registerHandler("commit", async ({ job }) => {
      console.info(`[${SUITE}:commit-exempt] commit ${job.jobId}`);
      order.push(`commit:${job.jobId}`);
    });

    try {
      await engine.submit(makeFormatJob({ jobId: "requested", priority: userRequestedFormatPriority("720p"), variant: "720p" }));
      await engine.submit(makeFormatJob({ jobId: "backfill", priority: 10, variant: "1080p", mediaId: "m2" }));

      await vi.waitFor(() => expect(order).toContain("transcode:backfill"), { timeout: 2000 });
      await vi.waitFor(
        async () => {
          const requested = await engine!.get("requested");
          expect(requested?.job.status).toBe("succeeded");
        },
        { timeout: 3000 }
      );
      const backfill = await engine.get("backfill");
      console.info(`[${SUITE}:commit-exempt] order=${JSON.stringify(order)} backfill=${backfill?.job.status}`);
      // The backfill encode is still holding the format slot: the commit did not wait for it.
      expect(backfill?.job.status).toBe("running");
      expect(order).toContain("commit:requested");
    } catch (err) {
      await dumpSnapshot("commit-exempt", { engine, order, events });
      throw err;
    } finally {
      longEncode.open();
    }
  });
});
