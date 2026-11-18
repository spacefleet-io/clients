/**
 * Tests for `badger.ingest.attach_metadata` and `badger.ingest.plan_outputs`
 * runtime command implementations.
 *
 * Strategy:
 *  - These commands manipulate engineV2 jobs mid-flight. To reach the
 *    "between submit and identify" or "after extract started" states
 *    deterministically, we register controllable step handlers (gates) that
 *    can be released or held forever.
 *  - The handlers themselves don't need to do real work — exercising
 *    payload merging, child cancellation, and add-job-mid-flight is enough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineV2, type EngineV2 } from "../src/core/jobs/engineV2";
import {
  createBadgerIngestSubmitHandler,
  createBadgerIngestAttachMetadataHandler,
  createBadgerIngestPlanOutputsHandler,
} from "../src/modules/badger/ingestSubmit";

type Resolver = () => void;

const allStepKinds = [
  "probe",
  "identify",
  "extract",
  "upload",
  "commit",
  "transcode",
];

/** Build a per-step gate map. Each step kind blocks until released() is called. */
const buildGates = () => {
  const gates = new Map<
    string,
    { promise: Promise<void>; release: Resolver; entered: boolean }
  >();
  for (const kind of allStepKinds) {
    let release!: Resolver;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(kind, { promise, release, entered: false });
  }
  return gates;
};

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps engineV2 job list + gate state on assertion
// failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpAttachPlanSnapshot = async (
  label: string,
  ctx: {
    engine?: EngineV2;
    gates?: ReturnType<typeof buildGates>;
    sourceJobId?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-ingest-attach-plan:${label}] snapshot ===`);
    if (ctx.gates) {
      const gateState: Record<string, boolean> = {};
      for (const [k, v] of ctx.gates.entries()) gateState[k] = v.entered;
      console.error(`gates.entered=${JSON.stringify(gateState)}`);
    }
    if (ctx.engine) {
      try {
        const listed = await ctx.engine.list();
        console.error(
          `engine.list (${listed.jobs.length})=\n${JSON.stringify(
            listed.jobs.map((j) => ({
              jobId: j.jobId,
              kind: j.kind,
              variant: j.variant,
              status: j.status,
              stageCode: j.stageCode,
              parentJobIds: j.parentJobIds,
            })),
            null,
            2,
          )}`,
        );
      } catch (err) {
        console.error(
          `(engine.list failed: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (ctx.sourceJobId) {
        try {
          const got = await ctx.engine.get(ctx.sourceJobId);
          console.error(
            `source job (${ctx.sourceJobId})=\n${JSON.stringify(got, null, 2)}`,
          );
        } catch (err) {
          console.error(
            `(get source job failed: ${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("badger.ingest.attach_metadata", () => {
  let engine: EngineV2;
  let gates: ReturnType<typeof buildGates>;

  beforeEach(async () => {
    console.info(`[badger-ingest-attach-plan:attach-setup] creating engine + gates`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    gates = buildGates();
    for (const kind of allStepKinds) {
      engine.registerHandler(kind, async () => {
        const g = gates.get(kind)!;
        g.entered = true;
        console.info(`[badger-ingest-attach-plan:gate] entered kind=${kind}`);
        await g.promise;
      });
    }
  });

  afterEach(async () => {
    console.info(`[badger-ingest-attach-plan:attach-teardown] releasing gates + stopping engine`);
    // Release any still-pending gates so stop() can drain inflight handlers.
    for (const g of gates.values()) g.release();
    await engine.stop();
  });

  const submitOne = async (mediaId = "media-1") => {
    const submit = createBadgerIngestSubmitHandler({ engine });
    return submit({
      userId: "u1",
      sources: [
        {
          filename: "movie.mkv",
          desiredFormats: ["360p"],
          hints: { mediaId },
        },
      ],
    });
  };

  it("attaches hints onto a queued source job before identify runs", async () => {
    console.info(`[badger-ingest-attach-plan:attach-before-identify] submitting`);
    const { submitted } = await submitOne();
    const sourceJobId = submitted[0].sourceJobId;
    console.info(
      `[badger-ingest-attach-plan:attach-before-identify] sourceJobId=${sourceJobId} probe gate still held`,
    );

    try {
      // Don't release the probe gate — the source job is sitting in `running`
      // at the probe step. attach_metadata should still succeed because the
      // post-identify step kinds (extract/upload/commit) are still `queued`.
      const attach = createBadgerIngestAttachMetadataHandler({ engine });
      const result = await attach({
        jobId: sourceJobId,
        mediaId: "tmdb-42",
        season: 2,
        episode: 5,
      });
      console.info(
        `[badger-ingest-attach-plan:attach-before-identify] attach result=${JSON.stringify(result)}`,
      );

      expect(result.attached).toBe(true);
      expect(result.jobId).toBe(sourceJobId);
      expect("errorCode" in result ? result.errorCode : undefined).toBeUndefined();

      const got = await engine.get(sourceJobId);
      const hints = got!.job.payload.hints as Record<string, unknown>;
      expect(hints.mediaId).toBe("tmdb-42");
      expect(hints.season).toBe(2);
      expect(hints.episode).toBe(5);
    } catch (err) {
      await dumpAttachPlanSnapshot("attach-before-identify", { engine, gates, sourceJobId });
      throw err;
    }
  });

  it("returns too-late once the extract step has started", async () => {
    console.info(`[badger-ingest-attach-plan:attach-too-late] submitting`);
    const { submitted } = await submitOne();
    const sourceJobId = submitted[0].sourceJobId;

    try {
      // Walk the source job through probe → identify → extract entered.
      console.info(`[badger-ingest-attach-plan:attach-too-late] releasing probe + identify`);
      gates.get("probe")!.release();
      gates.get("identify")!.release();

      await vi.waitFor(
        () => {
          expect(gates.get("extract")!.entered).toBe(true);
        },
        { timeout: 3000 }
      );
      console.info(`[badger-ingest-attach-plan:attach-too-late] extract entered; attempting attach`);

      const attach = createBadgerIngestAttachMetadataHandler({ engine });
      const result = await attach({
        jobId: sourceJobId,
        mediaId: "tmdb-late",
      });
      console.info(
        `[badger-ingest-attach-plan:attach-too-late] attach result=${JSON.stringify(result)}`,
      );
      expect(result.attached).toBe(false);
      expect(result.errorCode).toBe("too-late");
    } catch (err) {
      await dumpAttachPlanSnapshot("attach-too-late", { engine, gates, sourceJobId });
      throw err;
    }
  });

  it("returns not-found for a bogus jobId", async () => {
    console.info(`[badger-ingest-attach-plan:attach-not-found] dispatching with bogus jobId`);
    try {
      const attach = createBadgerIngestAttachMetadataHandler({ engine });
      const result = await attach({
        jobId: "does-not-exist",
        mediaId: "x",
      });
      console.info(
        `[badger-ingest-attach-plan:attach-not-found] result=${JSON.stringify(result)}`,
      );
      expect(result.attached).toBe(false);
      expect(result.errorCode).toBe("not-found");
    } catch (err) {
      await dumpAttachPlanSnapshot("attach-not-found", { engine, gates });
      throw err;
    }
  });
});

describe("badger.ingest.plan_outputs", () => {
  let engine: EngineV2;
  let gates: ReturnType<typeof buildGates>;

  beforeEach(async () => {
    console.info(`[badger-ingest-attach-plan:plan-setup] creating engine + gates`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    gates = buildGates();
    for (const kind of allStepKinds) {
      engine.registerHandler(kind, async () => {
        const g = gates.get(kind)!;
        g.entered = true;
        console.info(`[badger-ingest-attach-plan:gate] entered kind=${kind}`);
        await g.promise;
      });
    }
  });

  afterEach(async () => {
    console.info(`[badger-ingest-attach-plan:plan-teardown] releasing gates + stopping`);
    for (const g of gates.values()) g.release();
    await engine.stop();
  });

  const submitWithFormats = async (
    desiredFormats: Array<"1080p" | "720p" | "480p" | "360p" | "240p" | "144p">
  ) => {
    const submit = createBadgerIngestSubmitHandler({ engine });
    return submit({
      userId: "u1",
      sources: [
        {
          filename: "movie.mkv",
          desiredFormats,
          hints: { mediaId: "media-1" },
        },
      ],
    });
  };

  it("adds new format jobs for variants not previously requested", async () => {
    console.info(`[badger-ingest-attach-plan:plan-adds-new] submitting with 360p`);
    const { submitted } = await submitWithFormats(["360p"]);
    const sourceJobId = submitted[0].sourceJobId;

    try {
      console.info(`[badger-ingest-attach-plan:plan-adds-new] dispatching plan with [360p,720p]`);
      const plan = createBadgerIngestPlanOutputsHandler({ engine });
      const result = await plan({
        sourceJobId,
        formats: ["360p", "720p"],
      });
      console.info(
        `[badger-ingest-attach-plan:plan-adds-new] result=${JSON.stringify(result)}`,
      );

      expect(result.removedJobIds).toEqual([]);
      expect(result.addedJobIds).toHaveLength(1);
      expect(result.addedJobIds[0].variant).toBe("720p");

      const all = (await engine.list({ groupId: "media-1", kind: ["format"] }))
        .jobs;
      const newJob = all.find((j) => j.variant === "720p");
      expect(newJob).toBeDefined();
      expect(newJob!.parentJobIds).toEqual([sourceJobId]);
      expect(newJob!.priority).toBe(20); // §3 priority table
    } catch (err) {
      await dumpAttachPlanSnapshot("plan-adds-new", { engine, gates, sourceJobId });
      throw err;
    }
  });

  it("cancels variants that are dropped from the desired list", async () => {
    console.info(`[badger-ingest-attach-plan:plan-cancels-dropped] submitting with [360p,720p]`);
    const { submitted } = await submitWithFormats(["360p", "720p"]);
    const sourceJobId = submitted[0].sourceJobId;
    const job720 = submitted[0].formatJobIds.find((f) => f.variant === "720p")!;

    try {
      console.info(
        `[badger-ingest-attach-plan:plan-cancels-dropped] dispatching plan with [360p] (dropping 720p=${job720.jobId})`,
      );
      const plan = createBadgerIngestPlanOutputsHandler({ engine });
      const result = await plan({
        sourceJobId,
        formats: ["360p"],
      });
      console.info(
        `[badger-ingest-attach-plan:plan-cancels-dropped] result=${JSON.stringify(result)}`,
      );

      expect(result.addedJobIds).toEqual([]);
      expect(result.removedJobIds).toEqual([job720.jobId]);

      await vi.waitFor(
        async () => {
          const got = await engine.get(job720.jobId);
          expect(got!.job.status).toBe("cancelled");
        },
        { timeout: 2000 }
      );
    } catch (err) {
      await dumpAttachPlanSnapshot("plan-cancels-dropped", {
        engine,
        gates,
        sourceJobId,
        extra: { droppedJob720: job720 },
      });
      throw err;
    }
  });

  it("is a no-op when desired formats match the existing live set", async () => {
    console.info(`[badger-ingest-attach-plan:plan-noop] submitting with [360p,720p]`);
    const { submitted } = await submitWithFormats(["360p", "720p"]);
    const sourceJobId = submitted[0].sourceJobId;

    try {
      const plan = createBadgerIngestPlanOutputsHandler({ engine });
      const result = await plan({
        sourceJobId,
        formats: ["360p", "720p"],
      });
      console.info(
        `[badger-ingest-attach-plan:plan-noop] result=${JSON.stringify(result)}`,
      );

      expect(result.addedJobIds).toEqual([]);
      expect(result.removedJobIds).toEqual([]);
    } catch (err) {
      await dumpAttachPlanSnapshot("plan-noop", { engine, gates, sourceJobId });
      throw err;
    }
  });

  it("empty desired list cancels all formats (source-only ingest)", async () => {
    console.info(
      `[badger-ingest-attach-plan:plan-empty-cancels-all] submitting with [360p,720p]`,
    );
    const { submitted } = await submitWithFormats(["360p", "720p"]);
    const sourceJobId = submitted[0].sourceJobId;

    try {
      const plan = createBadgerIngestPlanOutputsHandler({ engine });
      const result = await plan({
        sourceJobId,
        formats: [],
      });
      console.info(
        `[badger-ingest-attach-plan:plan-empty-cancels-all] result=${JSON.stringify(result)}`,
      );

      expect(result.addedJobIds).toEqual([]);
      expect(result.removedJobIds).toHaveLength(2);
    } catch (err) {
      await dumpAttachPlanSnapshot("plan-empty-cancels-all", { engine, gates, sourceJobId });
      throw err;
    }
  });
});
