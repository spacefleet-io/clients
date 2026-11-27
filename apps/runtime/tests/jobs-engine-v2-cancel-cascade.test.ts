/**
 * @bugfix
 * @regression-proof
 *
 * Orchard bug regression: cancelling a `source` ingest job must cascade to all
 * dependent format jobs, while cancelling one format must NOT touch its
 * sibling formats.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineV2, type EngineV2 } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "j",
  app: "badger",
  kind: "source",
  lane: "source",
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
  ...overrides,
});

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps tracked job statuses on assertion failure.
// Wrapped in try/catch so a dump-failure cannot mask the original.
// ---------------------------------------------------------------------------
const dumpCancelCascadeSnapshot = async (
  label: string,
  ctx: {
    engine?: EngineV2;
    jobIds?: string[];
    cancelResult?: { cancelledIds: string[] };
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [jobs-engine-v2-cancel-cascade:${label}] snapshot ===`);
    if (ctx.engine && ctx.jobIds) {
      for (const id of ctx.jobIds) {
        const snap = await ctx.engine.get(id).catch((err) => `(get-failed: ${err instanceof Error ? err.message : String(err)})`);
        console.error(`engine.get(${id})=\n${JSON.stringify(snap, null, 2)}`);
      }
    }
    if (ctx.cancelResult) {
      console.error(`cancelResult.cancelledIds=${JSON.stringify(ctx.cancelResult.cancelledIds)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("engineV2 cancel cascade @bugfix @regression-proof", () => {
  let engine: EngineV2;

  beforeEach(async () => {
    console.info(`[jobs-engine-v2-cancel-cascade:setup] creating engine (encodeCap=2)`);
    engine = createEngineV2({
      dbPath: ":memory:",
      progressThrottleMs: 0,
      // The sibling-formats test needs both formats running concurrently;
      // bump format cap so we don't serialize them.
      encodeCap: 2,
    });
    await engine.start();
  });

  afterEach(async () => {
    console.info(`[jobs-engine-v2-cancel-cascade:teardown] stopping engine`);
    await engine.stop();
  });

  it("cancelling source cascades to its two format children (Orchard bug)", async () => {
    console.info(`[jobs-engine-v2-cancel-cascade:source-cascade] registering hanging probe`);
    // Source handler hangs until aborted, simulating a long extract.
    engine.registerHandler("probe", async ({ signal }) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    });
    // Other handlers should never run (they're downstream of probe).
    for (const kind of ["identify", "extract", "upload", "commit", "transcode"]) {
      engine.registerHandler(kind, async () => {});
    }

    try {
      console.info(`[jobs-engine-v2-cancel-cascade:source-cascade] submitting src + f360 + f720`);
      await engine.submit(makeJob({ jobId: "src", kind: "source", lane: "source" }));
      await engine.submit(
        makeJob({
          jobId: "f360",
          kind: "format",
          lane: "format",
          variant: "360p",
          parentJobIds: ["src"],
        })
      );
      await engine.submit(
        makeJob({
          jobId: "f720",
          kind: "format",
          lane: "format",
          variant: "720p",
          parentJobIds: ["src"],
        })
      );

      // Wait until source is running, then cancel.
      console.info(`[jobs-engine-v2-cancel-cascade:source-cascade] waiting for src to be running`);
      await vi.waitFor(
        async () => {
          const got = await engine.get("src");
          expect(got!.job.status).toBe("running");
        },
        { timeout: 3000 }
      );

      console.info(`[jobs-engine-v2-cancel-cascade:source-cascade] firing cancel(src)`);
      const result = await engine.cancel("src", "user");
      console.info(`[jobs-engine-v2-cancel-cascade:source-cascade] result.cancelledIds=${JSON.stringify(result.cancelledIds)}`);
      expect(new Set(result.cancelledIds)).toEqual(new Set(["src", "f360", "f720"]));

      const src = await engine.get("src");
      const f360 = await engine.get("f360");
      const f720 = await engine.get("f720");
      console.info(
        `[jobs-engine-v2-cancel-cascade:source-cascade] final statuses src=${src!.job.status} f360=${f360!.job.status} f720=${f720!.job.status}`,
      );
      expect(src!.job.status).toBe("cancelled");
      expect(f360!.job.status).toBe("cancelled");
      expect(f720!.job.status).toBe("cancelled");
    } catch (err) {
      await dumpCancelCascadeSnapshot("source-cascade-failure", {
        engine,
        jobIds: ["src", "f360", "f720"],
      });
      throw err;
    }
  });

  it("cancelling one format does NOT touch its sibling format (downstream-only)", async () => {
    console.info(`[jobs-engine-v2-cancel-cascade:sibling-isolation] registering handlers`);
    // All handlers hang until aborted so we can cancel mid-flight.
    for (const kind of ["probe", "identify", "extract", "upload", "commit", "transcode"]) {
      engine.registerHandler(kind, async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
          // For non-cancelled paths, finish promptly so source can succeed.
          setTimeout(resolve, 5);
        });
      });
    }

    // Set up a tree where source has succeeded by the time the formats run.
    // Easier: hand-craft a `source` job that completes (handlers resolve).
    engine.registerHandler("probe", async () => {});
    engine.registerHandler("identify", async () => {});
    engine.registerHandler("extract", async () => {});
    engine.registerHandler("upload", async () => {});
    engine.registerHandler("commit", async () => {});
    // Format transcode hangs until abort.
    engine.registerHandler("transcode", async ({ signal }) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    });

    await engine.submit(makeJob({ jobId: "src", kind: "source", lane: "source" }));
    await engine.submit(
      makeJob({
        jobId: "f360",
        kind: "format",
        lane: "format",
        variant: "360p",
        parentJobIds: ["src"],
      })
    );
    await engine.submit(
      makeJob({
        jobId: "f720",
        kind: "format",
        lane: "format",
        variant: "720p",
        parentJobIds: ["src"],
      })
    );

    try {
      // Wait until both formats are running.
      console.info(`[jobs-engine-v2-cancel-cascade:sibling-isolation] waiting for both formats running`);
      await vi.waitFor(
        async () => {
          const a = await engine.get("f360");
          const b = await engine.get("f720");
          expect(a!.job.status).toBe("running");
          expect(b!.job.status).toBe("running");
        },
        { timeout: 5000 }
      );

      console.info(`[jobs-engine-v2-cancel-cascade:sibling-isolation] firing cancel(f360)`);
      const result = await engine.cancel("f360", "user");
      console.info(`[jobs-engine-v2-cancel-cascade:sibling-isolation] result.cancelledIds=${JSON.stringify(result.cancelledIds)}`);
      expect(result.cancelledIds).toEqual(["f360"]);

      const f360 = await engine.get("f360");
      const f720 = await engine.get("f720");
      console.info(`[jobs-engine-v2-cancel-cascade:sibling-isolation] post: f360=${f360!.job.status} f720=${f720!.job.status}`);
      expect(f360!.job.status).toBe("cancelled");
      // Sibling untouched
      expect(f720!.job.status).toBe("running");
    } catch (err) {
      await dumpCancelCascadeSnapshot("sibling-isolation-failure", {
        engine,
        jobIds: ["src", "f360", "f720"],
      });
      throw err;
    }
  });

  it("cancel on a non-existent job returns empty cancelledIds", async () => {
    console.info(`[jobs-engine-v2-cancel-cascade:ghost] cancel(ghost)`);
    const result = await engine.cancel("ghost", "user");
    console.info(`[jobs-engine-v2-cancel-cascade:ghost] result=${JSON.stringify(result)}`);
    expect(result.cancelledIds).toEqual([]);
  });

  it("cancel on an already-terminal job is a no-op", async () => {
    console.info(`[jobs-engine-v2-cancel-cascade:terminal-noop] registering noop handlers`);
    for (const k of ["probe", "identify", "extract", "upload", "commit"]) {
      engine.registerHandler(k, async () => {});
    }
    await engine.submit(makeJob({ jobId: "done" }));
    try {
      await vi.waitFor(
        async () => {
          const got = await engine.get("done");
          expect(got!.job.status).toBe("succeeded");
        },
        { timeout: 3000 }
      );
      const result = await engine.cancel("done", "user");
      console.info(`[jobs-engine-v2-cancel-cascade:terminal-noop] cancel result=${JSON.stringify(result)}`);
      expect(result.cancelledIds).toEqual([]);
    } catch (err) {
      await dumpCancelCascadeSnapshot("terminal-noop-failure", {
        engine,
        jobIds: ["done"],
      });
      throw err;
    }
  });
});
