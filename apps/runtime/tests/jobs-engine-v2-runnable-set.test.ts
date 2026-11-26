/**
 * #671 R6 — engineV2 scheduling cost with a big queue (RT-JOBS-06).
 *
 * The scheduler keeps the queued jobs in memory (`engineV2Runnable`), looks at
 * a lane only while it has a free slot, re-checks a job that waits for a
 * parent only when that parent changes, and folds `tick()` calls made while a
 * pass runs into one more pass. These tests pin that the shortcut never costs
 * correctness: no job is starved, lane caps hold, start order is unchanged,
 * a restart recovers every queued job, and the cost of a submit no longer
 * grows with the queue.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IngestJobRecord } from "@space/runtime-jobs";
import {
  createEngineV2,
  type EngineV2,
  type RuntimeJobEvent,
  type StepHandler,
} from "@space/runtime-jobs-engine/engineV2";
import { createRunnableSet } from "@space/runtime-jobs-engine/engineV2Runnable";

const ts = "2026-01-01T00:00:00.000Z";
const T = "jobs-engine-v2-runnable-set";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "job",
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
  groupId: "g",
  mediaId: "m",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

/** createdAt that increases with `i`, so queue order is the submit order. */
const at = (i: number): string => new Date(Date.parse(ts) + i).toISOString();

const SOURCE_KINDS = ["probe", "identify", "extract", "upload", "commit"] as const;
const FORMAT_KINDS = ["transcode", "upload", "commit"] as const;
const ALL_KINDS = [...new Set([...SOURCE_KINDS, ...FORMAT_KINDS])];

const dump = async (label: string, engine: EngineV2 | null, extra?: Record<string, unknown>) => {
  try {
    console.error(`=== [${T}:${label}] snapshot ===`);
    if (engine) {
      console.error(`schedulerStats=${JSON.stringify(engine.schedulerStats())}`);
      const listed = await engine.list();
      const byStatus: Record<string, string[]> = {};
      for (const j of listed.jobs) (byStatus[j.status] ??= []).push(j.jobId);
      console.error(`jobs by status=${JSON.stringify(byStatus)}`);
    }
    if (extra) console.error(`extra=${JSON.stringify(extra, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Resolves once `count` jobs have reached a terminal event, or rejects after `ms`. */
const waitForTerminals = (
  engine: EngineV2,
  count: number,
  ms = 15_000
): Promise<RuntimeJobEvent[]> =>
  new Promise((resolve, reject) => {
    const seen: RuntimeJobEvent[] = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`only ${seen.length}/${count} terminal events after ${ms}ms`));
    }, ms);
    const unsubscribe = engine.subscribe((e) => {
      if (
        e.event === "runtime.jobs.succeeded" ||
        e.event === "runtime.jobs.failed" ||
        e.event === "runtime.jobs.cancelled"
      ) {
        seen.push(e);
        if (seen.length === count) {
          clearTimeout(timer);
          unsubscribe();
          resolve(seen);
        }
      }
    });
  });

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

describe("runnable set (pure bookkeeping)", () => {
  // @req RT-JOBS-06
  it("hands out ready jobs in (priority, createdAt, first-seen) order across buckets", () => {
    const set = createRunnableSet();
    for (const id of ["a", "b", "c", "d", "e"]) set.enqueue(id);
    // Same createdAt for b and c: first-seen order (b before c) decides.
    set.place("c", 0, at(1), "format");
    set.place("b", 0, at(1), "source");
    set.place("a", 1, at(0), "source");
    set.place("e", 0, at(5), "exempt");
    set.place("d", 0, at(2), "upload");
    const order: string[] = [];
    for (let entry = set.peek(() => true); entry; entry = set.peek(() => true)) {
      order.push(entry.jobId);
      set.consume(entry);
    }
    console.info(`[${T}:order] order=${order.join(",")}`);
    // b was enqueued before c; priority 1 'a' goes last despite being oldest.
    expect(order).toEqual(["b", "c", "d", "e", "a"]);
  });

  // @req RT-JOBS-06
  it("never offers a bucket whose lane is closed, and offers it again once open", () => {
    const set = createRunnableSet();
    set.enqueue("s1");
    set.enqueue("f1");
    set.place("s1", 0, at(0), "source");
    set.place("f1", 0, at(1), "format");
    expect(set.peek((b) => b !== "source")?.jobId).toBe("f1");
    expect(set.peek(() => false)).toBeNull();
    expect(set.peek(() => true)?.jobId).toBe("s1");
    expect(set.stats().ready).toEqual({ source: 1, format: 1, upload: 0, exempt: 0 });
  });

  // @req RT-JOBS-06
  it("keeps a parked job out of the buckets until a parent it waits on changes", () => {
    const set = createRunnableSet();
    set.enqueue("child");
    set.drainIncoming();
    set.park("child", ["p1", "p2"]);
    expect(set.stats()).toMatchObject({ parked: 1, incoming: 0 });
    expect(set.wake("unrelated")).toBe(0);
    expect(set.stats().incoming).toBe(0);
    expect(set.wake("p2")).toBe(1);
    // Woken once: waiting on p1 as well must not wake it a second time.
    expect(set.wake("p1")).toBe(0);
    expect(set.drainIncoming()).toEqual(["child"]);
    expect(set.stats().parked).toBe(0);
  });

  // @req RT-JOBS-06
  it("enqueue is idempotent while a job waits for classification or sits in a bucket", () => {
    const set = createRunnableSet();
    set.enqueue("x");
    set.enqueue("x");
    expect(set.drainIncoming()).toEqual(["x"]);
    set.place("x", 0, at(0), "source");
    set.enqueue("x");
    expect(set.stats().incoming).toBe(0);
    const entry = set.peek(() => true)!;
    set.consume(entry);
    set.enqueue("x");
    expect(set.drainIncoming()).toEqual(["x"]);
  });

  // @req RT-JOBS-06
  it("forget drops the parking and the first-seen rank of a finished job", () => {
    const set = createRunnableSet();
    set.enqueue("c");
    set.drainIncoming();
    set.park("c", ["p"]);
    set.forget("c");
    expect(set.stats().parked).toBe(0);
    expect(set.wake("p")).toBe(0);
  });

  // @req RT-JOBS-06
  it("stays ordered across many inserts and compacts consumed heads", () => {
    const set = createRunnableSet();
    const n = 500;
    // Insert in a scrambled order; createdAt carries the true rank.
    const ids = Array.from({ length: n }, (_, i) => (i * 7919) % n);
    for (const i of ids) {
      set.enqueue(`j${i}`);
      set.place(`j${i}`, 0, at(i), "source");
    }
    const out: number[] = [];
    for (let e = set.peek(() => true); e; e = set.peek(() => true)) {
      out.push(Number(e.jobId.slice(1)));
      set.consume(e);
    }
    console.info(`[${T}:many-inserts] consumed=${out.length}`);
    expect(out).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(set.stats().ready.source).toBe(0);
  });
});

describe("engineV2 scheduler with the runnable set", () => {
  let engine: EngineV2 | null = null;
  let engineB: EngineV2 | null = null;
  let tmp: string | null = null;

  afterEach(async () => {
    if (engine) await engine.stop().catch(() => {});
    if (engineB) await engineB.stop().catch(() => {});
    engine = null;
    engineB = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  const registerAll = (e: EngineV2, handler: StepHandler) => {
    for (const kind of ALL_KINDS) e.registerHandler(kind, handler);
  };

  // @req RT-JOBS-06
  it("folds tick() calls made during a pass into one more pass", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ source: 20, format: 1, upload: 20 });
    // Handlers hold at a gate so no step-end tick lands inside the window measured below.
    const gate = Promise.withResolvers<void>();
    registerAll(engine, async () => {
      await gate.promise;
    });

    // The listener runs inside the pass that starts `first`; each submit it
    // makes calls tick() re-entrantly.
    const burst = 8;
    let fired = false;
    const started: string[] = [];
    engine.subscribe((e) => {
      if (e.event === "runtime.jobs.started") started.push(e.jobId);
      if (e.event !== "runtime.jobs.started" || e.jobId !== "first" || fired) return;
      fired = true;
      for (let i = 0; i < burst; i += 1) {
        void engine!.submit(makeJob({ jobId: `burst${i}`, createdAt: at(10 + i) }));
      }
    });

    const before = engine.schedulerStats();
    const done = waitForTerminals(engine, burst + 1);
    await engine.submit(makeJob({ jobId: "first", createdAt: at(0) }));
    // Let the submits the listener made (they are async functions) all run.
    await nextMacrotask();
    const during = engine.schedulerStats();
    console.info(
      `[${T}:coalesce] before=${JSON.stringify(before)} during=${JSON.stringify(during)} started=${started.length}`
    );

    // first's own tick + the pass its request asked for: 2. The 8 nested ticks
    // were folded, not run.
    expect(during.coalescedTicks - before.coalescedTicks).toBe(burst);
    expect(during.tickPasses - before.tickPasses).toBeLessThanOrEqual(2);
    gate.resolve();
    // And folding lost nothing: every burst job started and finished.
    await done.catch(async (err) => {
      await dump("coalesce-timeout", engine, { started });
      throw err;
    });
    expect(new Set(started)).toEqual(new Set(["first", ...Array.from({ length: burst }, (_, i) => `burst${i}`)]));
  });

  // @req RT-JOBS-06
  it("honours lane caps, starts nothing from a full lane and starves no job", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ source: 2, format: 1, upload: 2 });

    const running: Record<string, number> = { source: 0, format: 0, upload: 0 };
    const peak: Record<string, number> = { source: 0, format: 0, upload: 0 };
    registerAll(engine, async ({ step }) => {
      const lane = step.lane as string;
      // commit never holds a lane (LANE_EXEMPT_STEP_KINDS).
      const tracked = step.kind !== "commit";
      if (tracked) {
        running[lane] += 1;
        peak[lane] = Math.max(peak[lane]!, running[lane]!);
      }
      await nextMacrotask();
      if (tracked) running[lane] -= 1;
    });

    const sources = 10;
    const formats = 6;
    const done = waitForTerminals(engine, sources + formats);
    for (let i = 0; i < sources; i += 1) {
      await engine.submit(makeJob({ jobId: `s${i}`, mediaId: `m${i}`, createdAt: at(i) }));
    }
    for (let i = 0; i < formats; i += 1) {
      await engine.submit(
        makeJob({
          jobId: `f${i}`,
          kind: "format",
          lane: "format",
          variant: "720p",
          mediaId: `m${i}`,
          createdAt: at(100 + i),
        })
      );
    }
    const events = await done.catch(async (err) => {
      await dump("lanes-timeout", engine, { peak, running });
      throw err;
    });
    console.info(`[${T}:lanes] peak=${JSON.stringify(peak)} terminals=${events.length}`);
    const ok = events.filter((e) => e.event === "runtime.jobs.succeeded").length;
    expect(ok).toBe(sources + formats);
    expect(peak.source).toBeLessThanOrEqual(2);
    expect(peak.format).toBeLessThanOrEqual(1);
    expect(peak.upload).toBeLessThanOrEqual(2);
    // The caps were actually reached, so the test would notice a cap of 1.
    expect(peak.source).toBe(2);
    expect(engine.schedulerStats().lanesRunning).toEqual({ source: 0, format: 0, upload: 0 });
    expect(engine.schedulerStats().ready).toEqual({ source: 0, format: 0, upload: 0, exempt: 0 });
  });

  // @req RT-JOBS-06
  it("starts jobs in (priority, createdAt) order, as listJobs ordered them", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ source: 1, format: 1, upload: 1 });

    const startedProbe: string[] = [];
    let releaseBlocker: () => void = () => {};
    engine.registerHandler("probe", async ({ job }) => {
      startedProbe.push(job.jobId);
      if (job.jobId === "blocker") await new Promise<void>((resolve) => (releaseBlocker = resolve));
    });
    for (const kind of ["identify", "extract", "upload", "commit"]) {
      engine.registerHandler(kind, async () => {});
    }

    await engine.submit(makeJob({ jobId: "blocker", createdAt: at(0) }));
    // Submitted out of order on purpose; the lane is held by the blocker.
    await engine.submit(makeJob({ jobId: "late", createdAt: at(30) }));
    await engine.submit(makeJob({ jobId: "urgent", createdAt: at(40), priority: -5 }));
    await engine.submit(makeJob({ jobId: "early", createdAt: at(10) }));
    await engine.submit(makeJob({ jobId: "middle", createdAt: at(20) }));

    const done = waitForTerminals(engine, 5);
    releaseBlocker();
    await done;
    console.info(`[${T}:order] probe order=${startedProbe.join(",")}`);
    expect(startedProbe).toEqual(["blocker", "urgent", "early", "middle", "late"]);
  });

  // @req RT-JOBS-06
  it("starts a child only after its parent got far enough, however it was queued", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ source: 1, format: 1, upload: 1 });

    const log: string[] = [];
    registerAll(engine, async ({ job, step }) => {
      log.push(`${job.jobId}:${step.kind}`);
      await nextMacrotask();
    });

    // The format child is submitted BEFORE its parent exists: it must wait
    // (parked behind an unknown parent), then run once the parent appears.
    // Its transcode is gated on the parent's `extract`.
    const done = waitForTerminals(engine, 2);
    await engine.submit(
      makeJob({
        jobId: "child",
        kind: "format",
        lane: "format",
        variant: "720p",
        mediaId: "m",
        parentJobIds: ["parent"],
        createdAt: at(0),
      })
    );
    await nextMacrotask();
    expect(log).toEqual([]);
    expect(engine.schedulerStats().parked).toBe(1);

    await engine.submit(makeJob({ jobId: "parent", createdAt: at(1) }));
    await done.catch(async (err) => {
      await dump("parent-after-child-timeout", engine, { log });
      throw err;
    });
    console.info(`[${T}:parent-gate] log=${log.join(" ")}`);
    expect(log.indexOf("child:transcode")).toBeGreaterThan(log.indexOf("parent:extract"));
    // `commit` waits for the whole parent job.
    expect(log.indexOf("child:commit")).toBeGreaterThan(log.indexOf("parent:commit"));
    expect(engine.schedulerStats().parked).toBe(0);
  });

  // @req RT-JOBS-06
  it("does not run a cancelled queued job that sits in a full lane's bucket", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ source: 1, format: 1, upload: 1 });

    const startedProbe: string[] = [];
    let releaseBlocker: () => void = () => {};
    engine.registerHandler("probe", async ({ job }) => {
      startedProbe.push(job.jobId);
      if (job.jobId === "blocker") await new Promise<void>((resolve) => (releaseBlocker = resolve));
    });
    for (const kind of ["identify", "extract", "upload", "commit"]) {
      engine.registerHandler(kind, async () => {});
    }

    await engine.submit(makeJob({ jobId: "blocker", createdAt: at(0) }));
    await engine.submit(makeJob({ jobId: "victim", createdAt: at(1) }));
    await engine.submit(makeJob({ jobId: "survivor", createdAt: at(2) }));
    await engine.cancel("victim", "user");

    const done = waitForTerminals(engine, 2); // blocker + survivor (victim already cancelled)
    releaseBlocker();
    await done;
    const victim = await engine.get("victim");
    console.info(`[${T}:cancel-bucket] startedProbe=${startedProbe.join(",")} victim=${victim?.job.status}`);
    expect(startedProbe).toEqual(["blocker", "survivor"]);
    expect(victim?.job.status).toBe("cancelled");
  });

  // @req RT-JOBS-06
  it("cancels a running, a ready and a parked child when their parent fails", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    // One format slot: runningChild holds it, readyChild waits in the format
    // bucket (a full lane's bucket is never looked at), waitingChild is parked.
    engine.setLaneCaps({ source: 1, format: 1, upload: 2 });

    let parentFails: () => void = () => {};
    let transcodeAborted = false;
    engine.registerHandler("probe", async () => {});
    engine.registerHandler("identify", async () => {});
    engine.registerHandler("extract", async () => {});
    engine.registerHandler("upload", async ({ job }) => {
      // Parent's upload blocks until the test makes it fail.
      if (job.jobId === "parent") {
        await new Promise<void>((_, reject) => (parentFails = () => reject(new Error("boom"))));
      }
    });
    engine.registerHandler("commit", async () => {});
    engine.registerHandler("transcode", async ({ job, signal }) => {
      if (job.jobId !== "runningChild") return;
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          transcodeAborted = true;
          reject(abortError());
        });
      });
    });

    // runningChild transcodes (gated on parent's extract) while the parent uploads.
    await engine.submit(makeJob({ jobId: "parent", createdAt: at(0) }));
    await engine.submit(
      makeJob({
        jobId: "runningChild",
        kind: "format",
        lane: "format",
        variant: "720p",
        parentJobIds: ["parent"],
        createdAt: at(1),
      })
    );
    await engine.submit(
      makeJob({
        jobId: "readyChild",
        kind: "format",
        lane: "format",
        variant: "480p",
        parentJobIds: ["parent"],
        createdAt: at(2),
      })
    );
    await engine.submit(
      makeJob({
        jobId: "waitingChild",
        kind: "format",
        lane: "format",
        variant: "360p",
        parentJobIds: ["parent", "ghost"],
        createdAt: at(3),
      })
    );
    await vi.waitFor(
      async () => {
        const mid = await engine!.get("runningChild");
        expect(mid?.job.status).toBe("running");
      },
      { timeout: 5000, interval: 10 }
    );
    console.info(`[${T}:failed-parent] mid stats=${JSON.stringify(engine.schedulerStats())}`);
    expect(engine.schedulerStats()).toMatchObject({ parked: 1 });
    expect(engine.schedulerStats().ready.format).toBe(1);

    parentFails();
    await vi
      .waitFor(
        async () => {
          const statuses = await Promise.all(
            ["parent", "runningChild", "readyChild", "waitingChild"].map(
              async (id) => (await engine!.get(id))?.job.status
            )
          );
          expect(statuses).toEqual(["failed", "cancelled", "cancelled", "cancelled"]);
          // The stale entry of readyChild leaves the bucket once the format slot frees.
          expect(engine!.schedulerStats().ready.format).toBe(0);
        },
        { timeout: 5000, interval: 10 }
      )
      .catch(async (err) => {
        await dump("failed-parent-timeout", engine);
        throw err;
      });
    expect(transcodeAborted).toBe(true);
    expect(engine.schedulerStats().parked).toBe(0);
  });

  // @req RT-JOBS-06
  it("a raised lane cap starts the jobs a full lane was holding back", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ source: 1, format: 1, upload: 1 });

    const startedProbe: string[] = [];
    engine.registerHandler("probe", async ({ job, signal }) => {
      startedProbe.push(job.jobId);
      // Blocks until aborted by engine.stop(), so later probes cannot hang the teardown.
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(abortError())));
    });
    for (const kind of ["identify", "extract", "upload", "commit"]) {
      engine.registerHandler(kind, async () => {});
    }
    for (let i = 0; i < 4; i += 1) {
      await engine.submit(makeJob({ jobId: `s${i}`, createdAt: at(i) }));
    }
    expect(startedProbe).toEqual(["s0"]);
    expect(engine.schedulerStats().ready.source).toBe(3);

    const caps = engine.setLaneCaps({ source: 3 });
    console.info(`[${T}:raise-cap] caps=${JSON.stringify(caps)} started=${startedProbe.join(",")}`);
    expect(startedProbe).toEqual(["s0", "s1", "s2"]);
    expect(engine.schedulerStats().ready.source).toBe(1);
  });

  // @req RT-JOBS-06
  it("recovers every queued and interrupted job after a restart, parents and children alike", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "engineV2-runnable-"));
    const dbPath = path.join(tmp, "jobs.db");
    console.info(`[${T}:restart] dbPath=${dbPath}`);

    engine = createEngineV2({ dbPath, progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ source: 1, format: 1, upload: 1 });
    // Everything blocks until the engine stops (stop() requeues running steps).
    registerAll(engine, ({ signal }) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(abortError()));
      })
    );
    const pairs = 6;
    for (let i = 0; i < pairs; i += 1) {
      await engine.submit(makeJob({ jobId: `s${i}`, mediaId: `m${i}`, createdAt: at(2 * i) }));
      await engine.submit(
        makeJob({
          jobId: `f${i}`,
          kind: "format",
          lane: "format",
          variant: "720p",
          mediaId: `m${i}`,
          parentJobIds: [`s${i}`],
          createdAt: at(2 * i + 1),
        })
      );
    }
    const statsBefore = engine.schedulerStats();
    console.info(`[${T}:restart] before stop stats=${JSON.stringify(statsBefore)}`);
    expect(statsBefore.lanesRunning.source).toBe(1);
    await engine.stop();
    engine = null;

    engineB = createEngineV2({ dbPath, progressThrottleMs: 0 });
    engineB.setLaneCaps({ source: 1, format: 1, upload: 1 });
    const order: string[] = [];
    registerAll(engineB, async ({ job, step }) => {
      order.push(`${job.jobId}:${step.kind}`);
      await nextMacrotask();
    });
    const done = waitForTerminals(engineB, pairs * 2);
    await engineB.start();
    await done.catch(async (err) => {
      await dump("restart-timeout", engineB, { order });
      throw err;
    });
    const listed = await engineB.list();
    const statuses = Object.fromEntries(listed.jobs.map((j) => [j.jobId, j.status]));
    console.info(`[${T}:restart] statuses=${JSON.stringify(statuses)}`);
    expect(Object.values(statuses).every((s) => s === "succeeded")).toBe(true);
    expect(Object.keys(statuses)).toHaveLength(pairs * 2);
    // Oldest first after the restart too: s0 starts before s1.
    expect(order.indexOf("s0:probe")).toBeLessThan(order.indexOf("s1:probe"));
  });

  // @req RT-JOBS-06
  it("a submit costs about the same with 300 jobs queued as with none", async () => {
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    engine.setLaneCaps({ source: 1, format: 1, upload: 1 });
    registerAll(engine, ({ signal }) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(abortError()));
      })
    );

    const pairs = 150;
    const submitMs: number[] = [];
    for (let i = 0; i < pairs; i += 1) {
      const t0 = performance.now();
      await engine.submit(makeJob({ jobId: `s${i}`, mediaId: `m${i}`, createdAt: at(2 * i) }));
      await engine.submit(
        makeJob({
          jobId: `f${i}`,
          kind: "format",
          lane: "format",
          variant: "720p",
          mediaId: `m${i}`,
          parentJobIds: [`s${i}`],
          createdAt: at(2 * i + 1),
        })
      );
      submitMs.push(performance.now() - t0);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const first = avg(submitMs.slice(10, 30));
    const last = avg(submitMs.slice(-20));
    const stats = engine.schedulerStats();
    console.info(
      `[${T}:cost] firstAvgMs=${first.toFixed(2)} lastAvgMs=${last.toFixed(2)} ratio=${(last / first).toFixed(2)} stats=${JSON.stringify(stats)}`
    );
    // Before the runnable set the last pairs cost 8-50x the first ones at this
    // size (every tick re-read the whole queue); a 4x margin absorbs noise.
    expect(last).toBeLessThan(first * 4 + 2);
    // The source lane holds one job; the format children wait for their parents.
    expect(stats.lanesRunning.source).toBe(1);
    expect(stats.ready.source).toBe(pairs - 1);
    expect(stats.parked).toBe(pairs);
  });
});

