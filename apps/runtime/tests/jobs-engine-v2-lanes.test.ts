import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLaneState,
  DEFAULT_LANE_CAPS,
  releaseLane,
  tryReserveLane,
} from "../src/core/jobs/engineV2Lanes";
import {
  createEngineV2,
  type EngineV2,
  type RuntimeJobEvent,
} from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps engineV2 state on failure. Wrapped in try/catch
// so dump-failure can never mask the original assertion failure.
// ---------------------------------------------------------------------------
const dumpLanesSnapshot = async (
  label: string,
  ctx: {
    engine?: EngineV2 | null;
    laneState?: ReturnType<typeof createLaneState>;
    started?: string[];
    events?: RuntimeJobEvent[];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [jobs-engine-v2-lanes:${label}] snapshot ===`);
    if (ctx.laneState) {
      console.error(`laneState=${JSON.stringify(ctx.laneState)}`);
    }
    if (ctx.engine) {
      try {
        const listed = await ctx.engine.list();
        console.error(
          `engine.list (${listed.jobs.length})=\n${JSON.stringify(
            listed.jobs.map((j) => ({
              jobId: j.jobId,
              kind: j.kind,
              lane: j.lane,
              status: j.status,
              variant: j.variant,
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
    }
    if (ctx.started) {
      console.error(`started (${ctx.started.length})=${JSON.stringify(ctx.started)}`);
    }
    if (ctx.events) {
      console.error(
        `events (last 10, of ${ctx.events.length})=\n${JSON.stringify(
          ctx.events.slice(-10),
          null,
          2,
        )}`,
      );
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

describe("engineV2 lanes", () => {
  it("reserves up to the cap and then refuses", () => {
    console.info(`[jobs-engine-v2-lanes:reserve-up-to-cap] setup`);
    const state = createLaneState();
    try {
      expect(tryReserveLane(state, "source", { source: 2, format: 1, upload: 1 })).toBe(true);
      expect(tryReserveLane(state, "source", { source: 2, format: 1, upload: 1 })).toBe(true);
      expect(tryReserveLane(state, "source", { source: 2, format: 1, upload: 1 })).toBe(false);
      expect(state.source).toBe(2);
    } catch (err) {
      void dumpLanesSnapshot("reserve-up-to-cap", { laneState: state });
      throw err;
    }
  });

  it("treats lanes independently", () => {
    console.info(`[jobs-engine-v2-lanes:lanes-independent] setup`);
    const state = createLaneState();
    const caps = { source: 1, format: 1, upload: 1 };
    try {
      expect(tryReserveLane(state, "source", caps)).toBe(true);
      expect(tryReserveLane(state, "format", caps)).toBe(true);
      expect(tryReserveLane(state, "upload", caps)).toBe(true);
      expect(tryReserveLane(state, "source", caps)).toBe(false);
      expect(tryReserveLane(state, "format", caps)).toBe(false);
      expect(tryReserveLane(state, "upload", caps)).toBe(false);
    } catch (err) {
      void dumpLanesSnapshot("lanes-independent", { laneState: state, extra: { caps } });
      throw err;
    }
  });

  it("release frees a slot for the next reservation", () => {
    console.info(`[jobs-engine-v2-lanes:release-frees-slot] setup`);
    const state = createLaneState();
    const caps = { source: 1, format: 1, upload: 1 };
    try {
      tryReserveLane(state, "format", caps);
      expect(tryReserveLane(state, "format", caps)).toBe(false);
      releaseLane(state, "format");
      expect(state.format).toBe(0);
      expect(tryReserveLane(state, "format", caps)).toBe(true);
    } catch (err) {
      void dumpLanesSnapshot("release-frees-slot", { laneState: state, extra: { caps } });
      throw err;
    }
  });

  it("releaseLane clamps to zero on double-release", () => {
    console.info(`[jobs-engine-v2-lanes:double-release-clamp] setup`);
    const state = createLaneState();
    try {
      expect(releaseLane(state, "upload")).toBe(0);
      expect(releaseLane(state, "upload")).toBe(0);
      expect(state.upload).toBe(0);
    } catch (err) {
      void dumpLanesSnapshot("double-release-clamp", { laneState: state });
      throw err;
    }
  });

  it("DEFAULT_LANE_CAPS matches plan §3 (source=2, format=1, upload=2)", () => {
    console.info(`[jobs-engine-v2-lanes:default-caps] checking DEFAULT_LANE_CAPS`);
    try {
      expect(DEFAULT_LANE_CAPS).toEqual({ source: 2, format: 1, upload: 2 });
    } catch (err) {
      void dumpLanesSnapshot("default-caps", { extra: { DEFAULT_LANE_CAPS } });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// engineV2.setLaneCaps — the live, mutable lane-cap seam wired to the desktop
// `maxParallelTranscodes` / `maxParallelExtractions` settings via the
// `badger.ingest.configure_scheduling` command.
// ---------------------------------------------------------------------------

const ts = "2026-01-01T00:00:00.000Z";

const makeSourceJob = (
  overrides: Partial<IngestJobRecord> = {}
): IngestJobRecord => ({
  jobId: "src",
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

describe("engineV2.setLaneCaps", () => {
  let engine: EngineV2 | null = null;

  afterEach(async () => {
    console.info(`[jobs-engine-v2-lanes:setLaneCaps:teardown] stopping engine`);
    if (engine) {
      await engine.stop();
      engine = null;
    }
  });

  it("clamps each provided cap to an integer >= 1", async () => {
    console.info(`[jobs-engine-v2-lanes:clamp-cap] setup`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();

    // A blocking probe handler keeps the first source job 'running' so we can
    // observe how many subsequent jobs the lane admits at a given cap.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.registerHandler("probe", async () => {
      console.info(`[jobs-engine-v2-lanes:clamp-cap] probe handler entered`);
      await gate;
    });

    try {
      // Sub-1 / fractional / non-finite values must all clamp up to 1, so a
      // bad setting never wedges a lane at 0 (which would deadlock the queue).
      console.info(`[jobs-engine-v2-lanes:clamp-cap] setLaneCaps({source:0}) — must clamp to 1`);
      engine.setLaneCaps({ source: 0 });
      await engine.submit(makeSourceJob({ jobId: "src-a" }));
      await engine.submit(makeSourceJob({ jobId: "src-b" }));

      // With source clamped to 1, exactly one job runs; the other stays queued.
      await vi.waitFor(
        async () => {
          const a = await engine!.get("src-a");
          expect(a?.job.status).toBe("running");
        },
        { timeout: 2000 }
      );
      const bWhileCapped = await engine.get("src-b");
      console.info(
        `[jobs-engine-v2-lanes:clamp-cap] src-a running, src-b status=${bWhileCapped?.job.status}`,
      );
      expect(bWhileCapped?.job.status).toBe("queued");

      // Fractional cap → truncates then clamps: 2.9 → 2.
      console.info(`[jobs-engine-v2-lanes:clamp-cap] setLaneCaps({source:2.9}) — must truncate to 2`);
      engine.setLaneCaps({ source: 2.9 });
      await vi.waitFor(
        async () => {
          const b = await engine!.get("src-b");
          expect(b?.job.status).toBe("running");
        },
        { timeout: 2000 }
      );
    } catch (err) {
      await dumpLanesSnapshot("clamp-cap", { engine });
      throw err;
    } finally {
      release();
    }
  });

  it("raising a cap immediately re-dispatches a queued job", async () => {
    console.info(`[jobs-engine-v2-lanes:raise-cap-redispatches] setup`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();

    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // probe blocks; identify/extract/upload/commit succeed instantly so a job
    // that gets past probe runs to completion without holding the lane.
    engine.registerHandler("probe", async ({ job }) => {
      console.info(`[jobs-engine-v2-lanes:raise-cap-redispatches] probe started for ${job.jobId}`);
      started.push(job.jobId);
      await gate;
    });
    for (const kind of ["identify", "extract", "upload", "commit"]) {
      engine.registerHandler(kind, async () => {});
    }

    const events: RuntimeJobEvent[] = [];
    engine.subscribe((e) => events.push(e));

    try {
      // Cap the source lane at 1, then queue two source jobs.
      engine.setLaneCaps({ source: 1 });
      await engine.submit(makeSourceJob({ jobId: "job-1" }));
      await engine.submit(makeSourceJob({ jobId: "job-2" }));

      // Only the first job's probe runs — the second is blocked on lane capacity.
      await vi.waitFor(
        () => {
          expect(started).toContain("job-1");
        },
        { timeout: 2000 }
      );
      console.info(
        `[jobs-engine-v2-lanes:raise-cap-redispatches] job-1 started; started=${JSON.stringify(started)}`,
      );
      expect(started).not.toContain("job-2");
      const job2Queued = await engine.get("job-2");
      expect(job2Queued?.job.status).toBe("queued");

      // Raise the cap — setLaneCaps must tick() so the queued job dispatches now,
      // WITHOUT waiting for job-1 to finish (its probe is still gated).
      console.info(`[jobs-engine-v2-lanes:raise-cap-redispatches] raising source cap 1→2`);
      engine.setLaneCaps({ source: 2 });
      await vi.waitFor(
        () => {
          expect(started).toContain("job-2");
        },
        { timeout: 2000 }
      );

      // Sanity: job-1 is still gated, proving the re-dispatch was driven by the
      // raised cap and not by job-1 releasing its lane slot.
      const job1 = await engine.get("job-1");
      expect(job1?.job.status).toBe("running");
    } catch (err) {
      await dumpLanesSnapshot("raise-cap-redispatches", { engine, started, events });
      throw err;
    } finally {
      release();
    }
  });

  it("omitted lanes keep their current cap; a no-op change does not throw", async () => {
    console.info(`[jobs-engine-v2-lanes:omitted-lanes] setup`);
    engine = createEngineV2({
      dbPath: ":memory:",
      progressThrottleMs: 0,
      sourceCap: 1,
      encodeCap: 1,
    });
    await engine.start();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.registerHandler("probe", async () => {
      await gate;
    });

    try {
      // Patch only `format`; `source` (cap 1) must be untouched.
      console.info(`[jobs-engine-v2-lanes:omitted-lanes] setLaneCaps({format:3}) — source cap must stay 1`);
      engine.setLaneCaps({ format: 3 });
      await engine.submit(makeSourceJob({ jobId: "s1" }));
      await engine.submit(makeSourceJob({ jobId: "s2" }));

      await vi.waitFor(
        async () => {
          const s1 = await engine!.get("s1");
          expect(s1?.job.status).toBe("running");
        },
        { timeout: 2000 }
      );
      // source cap stayed at 1 → s2 is still queued.
      const s2 = await engine.get("s2");
      console.info(
        `[jobs-engine-v2-lanes:omitted-lanes] s1 running, s2 status=${s2?.job.status}`,
      );
      expect(s2?.job.status).toBe("queued");

      // Re-applying the same source cap is a no-op and must not throw.
      expect(() => engine!.setLaneCaps({ source: 1 })).not.toThrow();
    } catch (err) {
      await dumpLanesSnapshot("omitted-lanes", { engine });
      throw err;
    } finally {
      release();
    }
  });
});

// ---------------------------------------------------------------------------
// @bugfix background-encode-starves-playback @regression-proof
// Host-aware lane ceilings: on the reference 4-core machine only ONE libx264
// encode may run at a time, whatever the user's "parallel transcodes" setting.
// ---------------------------------------------------------------------------
import { clampLaneCapsForHost, maxLaneCapsForHost } from "../src/core/jobs/engineV2Lanes";

describe("host-aware lane caps", () => {
  it("maxLaneCapsForHost: one encode per 4 cores (min 1), one extract per 2 cores (min 1)", () => {
    const table: Array<[number, number, number]> = [
      [1, 1, 1],
      [2, 1, 1],
      [4, 1, 2], // reference i5
      [7, 1, 3],
      [8, 2, 4],
      [12, 3, 6],
      [32, 8, 16],
    ];
    for (const [cores, format, source] of table) {
      const max = maxLaneCapsForHost(cores);
      console.info(`[jobs-engine-v2-lanes:host-caps] cores=${cores} -> format<=${max.format} source<=${max.source}`);
      expect(max.format).toBe(format);
      expect(max.source).toBe(source);
    }
  });

  it("clampLaneCapsForHost never raises a cap and leaves upload alone", () => {
    expect(clampLaneCapsForHost({ source: 1, format: 3, upload: 2 }, 4)).toEqual({ source: 1, format: 1, upload: 2 });
    expect(clampLaneCapsForHost({ source: 1, format: 1, upload: 2 }, 32)).toEqual({ source: 1, format: 1, upload: 2 });
  });

  describe("engineV2 with hostCpuCount", () => {
    let engine: EngineV2 | null = null;
    afterEach(async () => {
      if (engine) {
        await engine.stop();
        engine = null;
      }
    });

    it("setLaneCaps({format:3}) on a 4-core host is honoured as 1 and the effective caps are returned", () => {
      engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0, hostCpuCount: 4 });
      const effective = engine.setLaneCaps({ format: 3, source: 3 });
      console.info("[jobs-engine-v2-lanes:host-caps] effective", effective);
      expect(effective.format).toBe(1);
      expect(effective.source).toBe(2);
    });

    it("the same request on a 32-core host is honoured as asked", () => {
      engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0, hostCpuCount: 32 });
      expect(engine.setLaneCaps({ format: 3, source: 3 })).toMatchObject({ format: 3, source: 3 });
    });

    it("constructor caps are clamped too (before the renderer's mount-time sync arrives)", () => {
      engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0, hostCpuCount: 2, sourceCap: 2, encodeCap: 2 });
      expect(engine.setLaneCaps({})).toMatchObject({ format: 1, source: 1 });
    });
  });
});
