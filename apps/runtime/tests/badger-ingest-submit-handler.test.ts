import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineV2, type EngineV2 } from "@space/runtime-jobs-engine/engineV2";
import { registerBadgerStepHandlers } from "../src/modules/badger/steps";
import { createBadgerIngestSubmitHandler } from "../src/modules/badger/ingestSubmit";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps engineV2 job list + relevant submit results on
// assertion failure. Wrapped in try/catch so it cannot mask the original
// failure.
// ---------------------------------------------------------------------------
const dumpIngestSubmitSnapshot = async (
  label: string,
  ctx: {
    engine?: EngineV2;
    submitted?: unknown;
    focusJobId?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-ingest-submit-handler:${label}] snapshot ===`);
    if (ctx.submitted) {
      console.error(`submitted=\n${JSON.stringify(ctx.submitted, null, 2)}`);
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
              priority: j.priority,
              parentJobIds: j.parentJobIds,
              dedupeKey: j.dedupeKey,
              errorCode: j.errorCode,
              errorMessage: j.errorMessage,
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
      if (ctx.focusJobId) {
        try {
          const got = await ctx.engine.get(ctx.focusJobId);
          console.error(
            `focusJob (${ctx.focusJobId})=\n${JSON.stringify(got, null, 2)}`,
          );
        } catch (err) {
          console.error(
            `(focus get failed: ${err instanceof Error ? err.message : String(err)})`,
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

describe("createBadgerIngestSubmitHandler", () => {
  let engine: EngineV2;

  beforeEach(async () => {
    console.info(`[badger-ingest-submit-handler:setup] creating engineV2`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    registerBadgerStepHandlers(engine);
  });

  afterEach(async () => {
    console.info(`[badger-ingest-submit-handler:teardown] stopping engineV2`);
    await engine.stop();
  });

  const buildHandler = () => createBadgerIngestSubmitHandler({ engine });

  const submitOne = async () => {
    const handler = buildHandler();
    return handler({
      userId: "u1",
      sources: [
        {
          filename: "movie.mkv",
          sizeMb: 4096,
          sourceQuality: "1080p",
          desiredFormats: ["1080p", "720p", "360p"],
          hints: { mediaId: "media-1" },
        },
      ],
    });
  };

  it("returns the contract-shaped response with one source + N format jobs", async () => {
    console.info(`[badger-ingest-submit-handler:shape] submitOne`);
    const result = await submitOne();
    try {
      console.info(`[badger-ingest-submit-handler:shape] submitted=${JSON.stringify(result)}`);
      expect(result.submitted).toHaveLength(1);
      const entry = result.submitted[0];
      expect(entry.groupId).toBe("media-1");
      expect(typeof entry.sourceJobId).toBe("string");
      expect(entry.formatJobIds).toHaveLength(3);
      expect(entry.formatJobIds.map((f: { variant: string }) => f.variant)).toEqual([
        "1080p",
        "720p",
        "360p",
      ]);
    } catch (err) {
      await dumpIngestSubmitSnapshot("shape", { engine, submitted: result });
      throw err;
    }
  });

  it("creates 1 source + 3 format jobs in engineV2", async () => {
    console.info(`[badger-ingest-submit-handler:engine-job-count] submitOne`);
    await submitOne();
    try {
      const listed = await engine.list();
      const jobs = listed.jobs.filter((j) => j.groupId === "media-1");
      console.info(
        `[badger-ingest-submit-handler:engine-job-count] media-1 jobs=${jobs.length} source=${jobs.filter((j) => j.kind === "source").length} format=${jobs.filter((j) => j.kind === "format").length}`,
      );
      expect(jobs).toHaveLength(4);
      expect(jobs.filter((j) => j.kind === "source")).toHaveLength(1);
      expect(jobs.filter((j) => j.kind === "format")).toHaveLength(3);
    } catch (err) {
      await dumpIngestSubmitSnapshot("engine-job-count", { engine });
      throw err;
    }
  });

  it("an empty ladder (fallback 360p copy OFF on this computer) still creates the source job, with no format jobs", async () => {
    console.info(`[badger-ingest-submit-handler:empty-ladder] submit desiredFormats=[]`);
    const result = await buildHandler()({
      userId: "u1",
      sources: [{ filename: "movie.mkv", sizeMb: 4096, sourceQuality: "1080p", desiredFormats: [], hints: { mediaId: "media-empty" } }],
    });
    try {
      expect(result.submitted).toHaveLength(1);
      expect(result.submitted[0].formatJobIds).toEqual([]);
      const jobs = (await engine.list()).jobs.filter((j) => j.groupId === "media-empty");
      console.info(`[badger-ingest-submit-handler:empty-ladder] jobs=${jobs.map((j) => j.kind).join(",")}`);
      expect(jobs.map((j) => j.kind)).toEqual(["source"]);
    } catch (err) {
      await dumpIngestSubmitSnapshot("empty-ladder", { engine, submitted: result });
      throw err;
    }
  });

  it("source has empty parents; format jobs all parent the source", async () => {
    console.info(`[badger-ingest-submit-handler:parent-edges] submitOne`);
    const { submitted } = await submitOne();
    const sourceJobId = submitted[0].sourceJobId;
    try {
      const listed = await engine.list();
      const source = listed.jobs.find((j) => j.jobId === sourceJobId);
      const formats = listed.jobs.filter((j) => j.kind === "format");
      expect(source?.parentJobIds).toEqual([]);
      for (const f of formats) {
        expect(f.parentJobIds).toEqual([sourceJobId]);
      }
    } catch (err) {
      await dumpIngestSubmitSnapshot("parent-edges", { engine, focusJobId: sourceJobId, submitted });
      throw err;
    }
  });

  it("priorities follow the plan §3 table (source=0, 1080p=10, 720p=20, 360p=40)", async () => {
    console.info(`[badger-ingest-submit-handler:priorities] submitOne`);
    const { submitted } = await submitOne();
    try {
      const listed = await engine.list();
      const byId = new Map(listed.jobs.map((j) => [j.jobId, j]));
      expect(byId.get(submitted[0].sourceJobId)?.priority).toBe(0);
      const formats = submitted[0].formatJobIds;
      const variantToPrio = Object.fromEntries(
        formats.map((f: { variant: string; jobId: string }) => [
          f.variant,
          byId.get(f.jobId)?.priority,
        ])
      );
      console.info(
        `[badger-ingest-submit-handler:priorities] variantToPrio=${JSON.stringify(variantToPrio)}`,
      );
      expect(variantToPrio["1080p"]).toBe(10);
      expect(variantToPrio["720p"]).toBe(20);
      expect(variantToPrio["360p"]).toBe(40);
    } catch (err) {
      await dumpIngestSubmitSnapshot("priorities", { engine, submitted });
      throw err;
    }
  });

  it("generates a fresh groupId when no hints.mediaId is supplied", async () => {
    console.info(`[badger-ingest-submit-handler:fresh-group] no hints.mediaId`);
    const handler = buildHandler();
    let result: Awaited<ReturnType<typeof handler>> | undefined;
    try {
      result = await handler({
        userId: "u1",
        sources: [
          {
            filename: "no-hints.mkv",
            desiredFormats: ["360p"],
          },
        ],
      });
      console.info(
        `[badger-ingest-submit-handler:fresh-group] groupId=${result.submitted[0].groupId}`,
      );
      expect(result.submitted[0].groupId).not.toBe("");
      expect(result.submitted[0].groupId).not.toBe("media-1");
    } catch (err) {
      await dumpIngestSubmitSnapshot("fresh-group", { engine, submitted: result });
      throw err;
    }
  });

  it("supports multiple sources in one submission", async () => {
    console.info(`[badger-ingest-submit-handler:multi-source] submitting 2 sources`);
    const handler = buildHandler();
    let result: Awaited<ReturnType<typeof handler>> | undefined;
    try {
      result = await handler({
        userId: "u1",
        sources: [
          {
            filename: "a.mkv",
            desiredFormats: ["360p"],
            hints: { mediaId: "a-id" },
          },
          {
            filename: "b.mkv",
            desiredFormats: ["360p", "720p"],
            hints: { mediaId: "b-id" },
          },
        ],
      });
      console.info(
        `[badger-ingest-submit-handler:multi-source] result submitted.length=${result.submitted.length}`,
      );
      expect(result.submitted).toHaveLength(2);
      expect(result.submitted[0].formatJobIds).toHaveLength(1);
      expect(result.submitted[1].formatJobIds).toHaveLength(2);
    } catch (err) {
      await dumpIngestSubmitSnapshot("multi-source", { engine, submitted: result });
      throw err;
    }
  });

  it(
    "the source job is dispatched and lands in 'failed' when step deps are not configured (proves engine wiring)",
    async () => {
      console.info(`[badger-ingest-submit-handler:no-deps-fail] submitOne`);
      const { submitted } = await submitOne();
      const sourceJobId = submitted[0].sourceJobId;
      try {
        // The probe handler now requires `configureBadgerStepDeps()` to be
        // called first; in this test the deps registry is intentionally empty,
        // so the handler throws BADGER_STEP_DEPS_NOT_CONFIGURED and engineV2
        // marks the job 'failed' with errorCode 'handler-error'.
        await vi.waitFor(
          async () => {
            const got = await engine.get(sourceJobId);
            expect(got).not.toBeNull();
            expect(got!.job.status).toBe("failed");
          },
          { timeout: 3000 }
        );
        const got = await engine.get(sourceJobId);
        console.info(
          `[badger-ingest-submit-handler:no-deps-fail] got status=${got?.job.status} errorCode=${got?.job.errorCode} errorMessage=${got?.job.errorMessage}`,
        );
        expect(got!.job.errorCode).toBe("handler-error");
        // @bugfix @regression-proof — runtime_jobs.error_message must mirror
        // the failing step's message so DB-only consumers can see why the job
        // failed without joining against the event log. (verifier observed
        // the column was empty even though event_payload.errorMessage carried
        // the AUTH_REQUIRED string.)
        expect(got!.job.errorMessage ?? "").toContain(
          "BADGER_STEP_DEPS_NOT_CONFIGURED"
        );
        // The probe step is the failing one.
        const probeStep = got!.steps.find((s) => s.kind === "probe");
        expect(probeStep?.status).toBe("failed");
        expect(probeStep?.errorMessage ?? "").toContain("BADGER_STEP_DEPS_NOT_CONFIGURED");
      } catch (err) {
        await dumpIngestSubmitSnapshot("no-deps-fail", { engine, focusJobId: sourceJobId, submitted });
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // Bugfix (effervescent-teapot Symptom A): "4 jobs per movie".
  // Duplicate `submit_sources` calls with the same user+filename must be
  // deduped via `(app, dedupe_key)` so we don't end up with 2x source +
  // 2x format jobs per drag.
  // -------------------------------------------------------------------------
  describe("dedupe (@bugfix @regression-proof effervescent-teapot)", () => {
    const dupePayload = {
      userId: "u-dupe",
      sources: [
        {
          filename: "/movies/orchard.mkv",
          sizeMb: 1024,
          sourceQuality: "1080p",
          desiredFormats: ["360p"] as Array<"360p">,
          hints: { mediaId: "media-orchard" },
        },
      ],
    };

    it("submitting the same payload twice while the previous is still ACTIVE (queued/running) returns the same jobIds and creates no duplicate rows", async () => {
      console.info(`[badger-ingest-submit-handler:dedupe-active] first submit`);
      const handler = buildHandler();
      const first = await handler({ ...dupePayload });
      try {
        // Force the previous jobs into `running` so the dedupe lookup is
        // deterministic. The default step handlers fail fast with
        // BADGER_STEP_DEPS_NOT_CONFIGURED; without this guard the source can
        // race to `failed`, which (correctly, per the new policy) frees the
        // dedupe slot.
        const pinRunning = async (jobId: string) => {
          const found = await engine.get(jobId);
          if (!found) throw new Error(`expected job ${jobId}`);
          await engine.submit({
            ...found.job,
            status: "running",
            progressPct: 10,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        };
        await pinRunning(first.submitted[0].sourceJobId);
        for (const f of first.submitted[0].formatJobIds) {
          await pinRunning(f.jobId);
        }
        console.info(`[badger-ingest-submit-handler:dedupe-active] all pinned to running; resubmitting`);
        const second = await handler({ ...dupePayload });
        console.info(
          `[badger-ingest-submit-handler:dedupe-active] first.source=${first.submitted[0].sourceJobId} second.source=${second.submitted[0].sourceJobId}`,
        );

        expect(second.submitted[0].groupId).toBe(first.submitted[0].groupId);
        expect(second.submitted[0].sourceJobId).toBe(first.submitted[0].sourceJobId);
        expect(second.submitted[0].formatJobIds).toEqual(first.submitted[0].formatJobIds);
      } catch (err) {
        await dumpIngestSubmitSnapshot("dedupe-active", { engine, submitted: first });
        throw err;
      }
    });

    it("@bugfix @regression-proof re-submit after the previous job was dismissed produces a FRESH sourceJobId (delete + re-add same file)", async () => {
      console.info(`[badger-ingest-submit-handler:dedupe-dismissed] first submit`);
      const handler = buildHandler();
      const first = await handler({ ...dupePayload });
      const previousId = first.submitted[0].sourceJobId;
      try {
        // Simulate the cancel_by_group cascade: cancel + dismiss the source.
        await engine.cancel(previousId, "media-deleted");
        await engine.dismiss(previousId);
        console.info(`[badger-ingest-submit-handler:dedupe-dismissed] resubmitting after dismiss`);
        const second = await handler({ ...dupePayload });
        console.info(
          `[badger-ingest-submit-handler:dedupe-dismissed] previousId=${previousId} newId=${second.submitted[0].sourceJobId}`,
        );
        expect(second.submitted[0].sourceJobId).not.toBe(previousId);
        // The fresh source must exist in the engine.
        const fresh = await engine.get(second.submitted[0].sourceJobId);
        expect(fresh?.job.dedupeKey).toBe("u-dupe|/movies/orchard.mkv|source");
      } catch (err) {
        await dumpIngestSubmitSnapshot("dedupe-dismissed", {
          engine,
          submitted: first,
          extra: { previousId },
        });
        throw err;
      }
    });

    it("@bugfix @regression-proof re-submit after the previous job was cancelled (but not dismissed) still produces a fresh job", async () => {
      console.info(`[badger-ingest-submit-handler:dedupe-cancelled] first submit`);
      const handler = buildHandler();
      const first = await handler({ ...dupePayload });
      const previousId = first.submitted[0].sourceJobId;
      try {
        await engine.cancel(previousId, "user-cancel");
        console.info(`[badger-ingest-submit-handler:dedupe-cancelled] resubmitting after cancel-only`);
        const second = await handler({ ...dupePayload });
        console.info(
          `[badger-ingest-submit-handler:dedupe-cancelled] previousId=${previousId} newId=${second.submitted[0].sourceJobId}`,
        );
        expect(second.submitted[0].sourceJobId).not.toBe(previousId);
      } catch (err) {
        await dumpIngestSubmitSnapshot("dedupe-cancelled", {
          engine,
          submitted: first,
          extra: { previousId },
        });
        throw err;
      }
    });

    it("@bugfix @regression-proof re-submit while previous source is succeeded-but-not-dismissed produces a FRESH jobId (terminal-frees-the-slot policy)", async () => {
      console.info(`[badger-ingest-submit-handler:dedupe-succeeded] first submit`);
      // Live verifier reproduction (Orchard re-drag). Old policy treated
      // succeeded-without-dismissed_at as still-blocking for double-click
      // idempotency; that left stale terminal rows owning the dedupe slot
      // and blocked legitimate re-submits indefinitely. New policy: any
      // terminal status frees the slot; the user re-submitting an already-
      // completed payload is expressing clear new intent.
      const handler = buildHandler();
      const first = await handler({ ...dupePayload });
      const previousId = first.submitted[0].sourceJobId;
      const previousFormatIds = first.submitted[0].formatJobIds.map(
        (f) => f.jobId
      );
      try {
        // Manually mark every job in the group succeeded (no dismiss). This
        // guards against the default step handlers racing the source/format
        // jobs to `failed` (no deps configured).
        const stabilise = async (jobId: string) => {
          const found = await engine.get(jobId);
          if (!found) throw new Error(`expected job ${jobId}`);
          await engine.submit({
            ...found.job,
            status: "succeeded",
            progressPct: 100,
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        };
        await stabilise(previousId);
        for (const f of first.submitted[0].formatJobIds) {
          await stabilise(f.jobId);
        }
        console.info(`[badger-ingest-submit-handler:dedupe-succeeded] all stabilised to succeeded`);
        const second = await handler({ ...dupePayload });
        console.info(
          `[badger-ingest-submit-handler:dedupe-succeeded] previousId=${previousId} newId=${second.submitted[0].sourceJobId}`,
        );
        expect(second.submitted[0].sourceJobId).not.toBe(previousId);
        // Format jobs are also fresh.
        const newFormatIds = second.submitted[0].formatJobIds.map((f) => f.jobId);
        for (const id of newFormatIds) {
          expect(previousFormatIds).not.toContain(id);
        }
        // Old rows still durable (history preserved); they just no longer hold
        // the (app, dedupe_key) unique slot.
        const oldSource = await engine.get(previousId);
        expect(oldSource?.job.status).toBe("succeeded");
        expect(oldSource?.job.dedupeKey).toBeNull();
      } catch (err) {
        await dumpIngestSubmitSnapshot("dedupe-succeeded", {
          engine,
          submitted: first,
          extra: { previousId, previousFormatIds },
        });
        throw err;
      }
    });

    it("dedupeKey is set on every emitted job", async () => {
      console.info(`[badger-ingest-submit-handler:dedupe-key-set] dispatching`);
      const handler = buildHandler();
      let result: Awaited<ReturnType<typeof handler>> | undefined;
      try {
        result = await handler({ ...dupePayload });
        const sourceJob = (await engine.get(result.submitted[0].sourceJobId))!.job;
        console.info(
          `[badger-ingest-submit-handler:dedupe-key-set] sourceJob.dedupeKey=${sourceJob.dedupeKey}`,
        );
        expect(sourceJob.dedupeKey).toBe("u-dupe|/movies/orchard.mkv|source");

        const formatJobId = result.submitted[0].formatJobIds[0].jobId;
        const formatJob = (await engine.get(formatJobId))!.job;
        expect(formatJob.dedupeKey).toBe("u-dupe|/movies/orchard.mkv|format|360p");
      } catch (err) {
        await dumpIngestSubmitSnapshot("dedupe-key-set", { engine, submitted: result });
        throw err;
      }
    });
  });

  it(
    "the format jobs cancel via parent-cascade once source is failed (downstream-only)",
    async () => {
      console.info(`[badger-ingest-submit-handler:parent-cascade] submitOne`);
      const { submitted } = await submitOne();
      const sourceJobId = submitted[0].sourceJobId;
      try {
        await vi.waitFor(
          async () => {
            const got = await engine.get(sourceJobId);
            expect(got?.job.status).toBe("failed");
          },
          { timeout: 3000 }
        );
        console.info(
          `[badger-ingest-submit-handler:parent-cascade] source failed; waiting for format cascade`,
        );
        // Cascade is driven on the next tick; submit a no-op call to trigger
        // tick (engineV2 runs tick() in submit/cancel/handler-finally).
        await vi.waitFor(
          async () => {
            const listed = await engine.list();
            const formats = listed.jobs.filter((j) => j.kind === "format");
            expect(formats.every((f) => f.status === "cancelled")).toBe(true);
          },
          { timeout: 3000 }
        );
        console.info(
          `[badger-ingest-submit-handler:parent-cascade] all format jobs cancelled`,
        );
      } catch (err) {
        await dumpIngestSubmitSnapshot("parent-cascade", { engine, focusJobId: sourceJobId, submitted });
        throw err;
      }
    }
  );

  // #145: one media = one placementId = one silo. The source job and every
  // format job of it carry the same payload.placementId (= the source job id),
  // and the response hands it to the client (import-dialog subtitles).
  describe("per-media placement (#145)", () => {
    const payloadPlacementId = (payload: Record<string, unknown>): unknown => payload.placementId;

    it("stamps placementId = sourceJobId on the source and all its format jobs, and returns it", async () => {
      const result = await submitOne();
      const entry = result.submitted[0];
      const source = (await engine.get(entry.sourceJobId))!.job;
      const formats = await Promise.all(entry.formatJobIds.map(async (f) => (await engine.get(f.jobId))!.job));
      console.info(
        `[badger-ingest-submit-handler:placement-stamp] source=${entry.sourceJobId} response=${entry.placementId} ` +
          `sourcePayload=${String(payloadPlacementId(source.payload))} formats=${JSON.stringify(formats.map((f) => payloadPlacementId(f.payload)))}`,
      );
      try {
        expect(entry.placementId).toBe(entry.sourceJobId);
        expect(payloadPlacementId(source.payload)).toBe(entry.sourceJobId);
        expect(formats).toHaveLength(3);
        for (const format of formats) expect(payloadPlacementId(format.payload)).toBe(entry.sourceJobId);
      } catch (err) {
        await dumpIngestSubmitSnapshot("placement-stamp", { engine, submitted: result });
        throw err;
      }
    });

    it("two sources in one submit (two episodes) get two different placementIds", async () => {
      const result = await buildHandler()({
        userId: "u1",
        sources: [
          { filename: "/tv/S01E01.mkv", desiredFormats: ["360p"], hints: { mediaId: "show", season: 1, episode: 1 } },
          { filename: "/tv/S01E02.mkv", desiredFormats: ["360p"], hints: { mediaId: "show", season: 1, episode: 2 } },
        ],
      });
      const ids = result.submitted.map((s) => s.placementId);
      console.info(`[badger-ingest-submit-handler:placement-two-episodes] placementIds=${JSON.stringify(ids)}`);
      expect(ids[0]).toBe(result.submitted[0].sourceJobId);
      expect(ids[1]).toBe(result.submitted[1].sourceJobId);
      expect(ids[0]).not.toBe(ids[1]);
      const fmt2 = (await engine.get(result.submitted[1].formatJobIds[0].jobId))!.job;
      expect(payloadPlacementId(fmt2.payload)).toBe(ids[1]);
    });

    it("a deduped legacy source without a valid id returns null and stamps no id on new format jobs", async () => {
      const seed = await submitOne();
      const template = (await engine.get(seed.submitted[0].sourceJobId))!.job;
      const { placementId: _dropped, ...legacyPayload } = template.payload;
      await engine.submit({
        ...template,
        jobId: "src-old",
        status: "running",
        dedupeKey: "u1|/legacy.mkv|source",
        payload: { ...legacyPayload, filename: "/legacy.mkv" },
        startedAt: new Date().toISOString(),
      });
      const result = await buildHandler()({
        userId: "u1",
        sources: [{ filename: "/legacy.mkv", desiredFormats: ["360p"] }],
      });
      const entry = result.submitted[0];
      const format = (await engine.get(entry.formatJobIds[0].jobId))!.job;
      console.info(
        `[badger-ingest-submit-handler:placement-legacy-dedupe] source=${entry.sourceJobId} placementId=${entry.placementId} ` +
          `formatPayload=${String(payloadPlacementId(format.payload))}`,
      );
      expect(entry.sourceJobId).toBe("src-old");
      expect(entry.placementId).toBeNull();
      expect(payloadPlacementId(format.payload)).toBeUndefined();
    });
  });
});
