import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEngineV2, JOB_HISTORY_RETENTION_DAYS, type EngineV2 } from "../src/core/jobs/engineV2";
import { createSqliteRuntimeJobsStore } from "../src/core/jobs/sqliteStore";
import { createSqliteEventLogDeps } from "../src/core/jobs/sqliteEventLogDeps";
import type { IngestJobRecord } from "@space/runtime-jobs";

const DAY = 24 * 3_600_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

const makeJob = (jobId: string, overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId,
  app: "badger",
  kind: "source",
  lane: "source",
  status: "succeeded",
  stageCode: "done",
  stageLabel: "Done",
  progress: { mode: "fraction", completed: 100, total: 100, unit: "percent" },
  progressPct: 100,
  payload: { userId: "u1" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: iso(40),
  updatedAt: iso(40),
  startedAt: null,
  finishedAt: iso(40),
  groupId: "g1",
  mediaId: "m1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

describe("job history retention (engineV2)", () => {
  let tmp = "";
  let engine: EngineV2 | null = null;

  afterEach(async () => {
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // @req RT-JOBS-05
  it("drops finished jobs and events older than 30 days at start; keeps recent and live ones", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "engineV2-retention-"));
    const dbPath = path.join(tmp, "jobs.db");

    const seed = createSqliteRuntimeJobsStore(dbPath);
    seed.upsertJob(makeJob("old-done"));
    seed.upsertJob(makeJob("old-failed", { status: "failed", dismissedAt: iso(39) }));
    seed.upsertJob(makeJob("recent-done", { createdAt: iso(5), updatedAt: iso(5), finishedAt: iso(5) }));
    seed.upsertJob(makeJob("old-but-live", { status: "queued", finishedAt: null }));
    const events = createSqliteEventLogDeps(seed.db);
    const insert = (jobId: string, createdAt: string) =>
      events.insert({ jobId, channel: "runtime.jobs", event: "runtime.jobs.progress", payloadJson: "{}", createdAt });
    for (let i = 0; i < 5; i++) insert("old-done", iso(45));
    for (let i = 0; i < 3; i++) insert("recent-done", iso(2));
    seed.close();
    console.info(`[jobs-history-retention] seeded jobs=4 events=8 (5 old, 3 recent) retentionDays=${JOB_HISTORY_RETENTION_DAYS}`);

    engine = createEngineV2({ dbPath });
    await engine.start();
    // The pass starts at start() and works in batches: wait for its result.
    const listed = engine;
    expect(JOB_HISTORY_RETENTION_DAYS).toBe(30);
    await vi.waitFor(async () => {
      const { jobs } = await listed.list({});
      const ids = jobs.map((j) => j.jobId).sort();
      console.info(`[jobs-history-retention] jobs=${JSON.stringify(ids)}`);
      expect(ids).toEqual(["old-but-live", "recent-done"]);
    });
    await engine.stop();
    engine = null;

    const check = createSqliteRuntimeJobsStore(dbPath);
    const remaining = (check.db.prepare("SELECT COUNT(*) AS n FROM runtime_job_events;").all() as Array<{ n: number }>)[0].n;
    console.info(`[jobs-history-retention] events remaining=${remaining} (expected 3)`);
    check.close();
    expect(remaining).toBe(3);
  });

  // @req RT-JOBS-05
  it("runs again on its interval, so a long-running runtime does not grow without bound", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "engineV2-retention-timer-"));
    const dbPath = path.join(tmp, "jobs.db");
    engine = createEngineV2({ dbPath, historyPruneIntervalMs: 20 });
    await engine.start();
    // Insert an old finished job behind the engine's back after the start pass.
    const side = createSqliteRuntimeJobsStore(dbPath);
    side.upsertJob(makeJob("late-old"));
    side.close();
    const listed = engine;
    await vi.waitFor(async () => {
      const { jobs } = await listed.list({});
      console.info(`[jobs-history-retention:timer] jobs after interval passes=${JSON.stringify(jobs.map((j) => j.jobId))}`);
      expect(jobs).toEqual([]);
    });
  });

  // @req RT-JOBS-05
  it("list() reports the newest event id", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "engineV2-retention-maxid-"));
    const dbPath = path.join(tmp, "jobs.db");
    engine = createEngineV2({ dbPath });
    await engine.start();
    await engine.submit(makeJob("live", { status: "queued", finishedAt: null, createdAt: iso(0), updatedAt: iso(0) }));
    await engine.submit(makeJob("live2", { status: "queued", finishedAt: null, createdAt: iso(0), updatedAt: iso(0), mediaId: "m2" }));
    const { maxEventId } = await engine.list({});
    console.info(`[jobs-history-retention:maxid] maxEventId=${maxEventId}`);
    expect(maxEventId).toBeGreaterThanOrEqual(2);
  });
});
