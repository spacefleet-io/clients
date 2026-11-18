import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSqliteRuntimeJobsStore,
  type SqliteRuntimeJobsStore,
} from "../src/core/jobs/sqliteStore";
import type { IngestJobRecord } from "@space/runtime-jobs";

const baseJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "j1",
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
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
// Diagnostic snapshot helper — dumps full store state (all jobs + counts) on
// assertion failure. Wrapped in try/catch so a dump-failure cannot mask the
// original assertion. Each test calls into the store directly so the dumper
// just needs the store ref + a context payload.
// ---------------------------------------------------------------------------
const dumpJobsSqliteStoreSnapshot = (
  label: string,
  ctx: {
    store?: SqliteRuntimeJobsStore;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [jobs-sqlite-store:${label}] snapshot ===`);
    if (ctx.store) {
      const all = ctx.store.listJobs({ includeDismissed: true });
      console.error(`store.listJobs(includeDismissed=true).length=${all.length}`);
      console.error(
        `store rows (jobId/status/dedupeKey/dismissedAt):\n${JSON.stringify(
          all.map((j) => ({
            jobId: j.jobId,
            status: j.status,
            dedupeKey: j.dedupeKey,
            dismissedAt: j.dismissedAt,
            parentJobIds: j.parentJobIds,
            mediaId: j.mediaId,
            variant: j.variant,
            priority: j.priority,
          })),
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

describe("createSqliteRuntimeJobsStore", () => {
  let store: SqliteRuntimeJobsStore;

  beforeEach(() => {
    console.info(`[jobs-sqlite-store:setup] creating in-memory sqlite store`);
    store = createSqliteRuntimeJobsStore(":memory:");
  });

  afterEach(() => {
    console.info(`[jobs-sqlite-store:teardown] closing sqlite store`);
    store.close();
  });

  it("upserts and retrieves a job round-trip", () => {
    console.info(`[jobs-sqlite-store:round-trip] upserting baseJob jobId=j1`);
    const job = baseJob();
    store.upsertJob(job);
    const loaded = store.getJob("j1");
    console.info(
      `[jobs-sqlite-store:round-trip] loaded jobId=${loaded?.jobId} app=${loaded?.app}`,
    );
    try {
      expect(loaded).not.toBeNull();
      expect(loaded!.jobId).toBe("j1");
      expect(loaded!.app).toBe("badger");
      expect(loaded!.payload).toEqual({ userId: "u1" });
      expect(loaded!.parentJobIds).toEqual([]);
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("round-trip-failure", {
        store,
        extra: { loaded },
      });
      throw err;
    }
  });

  it("upsert is idempotent (second upsert updates the row)", () => {
    console.info(
      `[jobs-sqlite-store:idempotent-upsert] upserting twice with progressPct 0 then 50`,
    );
    store.upsertJob(baseJob({ progressPct: 0 }));
    store.upsertJob(baseJob({ progressPct: 50 }));
    const after = store.getJob("j1");
    console.info(
      `[jobs-sqlite-store:idempotent-upsert] after second upsert progressPct=${after?.progressPct}`,
    );
    try {
      expect(after!.progressPct).toBe(50);
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("idempotent-upsert-failure", {
        store,
        extra: { after },
      });
      throw err;
    }
  });

  it("listJobs filters by status, kind, lane, mediaId", () => {
    console.info(
      `[jobs-sqlite-store:list-filter] seeding 1 source + 2 format jobs with mixed priorities`,
    );
    store.upsertJob(baseJob({ jobId: "src", kind: "source", lane: "source", priority: 0 }));
    store.upsertJob(
      baseJob({
        jobId: "f360",
        kind: "format",
        lane: "format",
        variant: "360p",
        parentJobIds: ["src"],
        priority: 40,
      })
    );
    store.upsertJob(
      baseJob({
        jobId: "f720",
        kind: "format",
        lane: "format",
        variant: "720p",
        parentJobIds: ["src"],
        priority: 20,
      })
    );

    const allFormats = store.listJobs({ kind: ["format"] });
    const sourceLane = store.listJobs({ lane: ["source"] });
    console.info(
      `[jobs-sqlite-store:list-filter] format ids=${JSON.stringify(allFormats.map((j) => j.jobId))} source ids=${JSON.stringify(sourceLane.map((j) => j.jobId))}`,
    );
    try {
      expect(allFormats.map((j) => j.jobId).sort()).toEqual(["f360", "f720"]);
      // priority order: 720p (20) before 360p (40)
      expect(allFormats[0].jobId).toBe("f720");
      expect(sourceLane.map((j) => j.jobId)).toEqual(["src"]);
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("list-filter-failure", {
        store,
        extra: { allFormats, sourceLane },
      });
      throw err;
    }
  });

  // ---------------------------------------------------------------------
  // Dedupe — @bugfix @regression-proof (effervescent-teapot Symptom A).
  // The unique index `(app, dedupe_key) WHERE dedupe_key IS NOT NULL` must
  // make a second upsert with the same dedupe key a no-op that returns the
  // existing row instead of creating a duplicate.
  // ---------------------------------------------------------------------
  it("upsertJob with the same (app, dedupe_key) twice is a no-op and returns the existing record", () => {
    console.info(
      `[jobs-sqlite-store:dedupe-collision] upserting two jobs sharing dedupeKey u1|/movies/orchard.mkv|source`,
    );
    const first = store.upsertJob(
      baseJob({ jobId: "orig", dedupeKey: "u1|/movies/orchard.mkv|source" })
    );
    const second = store.upsertJob(
      baseJob({ jobId: "duplicate", dedupeKey: "u1|/movies/orchard.mkv|source" })
    );
    console.info(
      `[jobs-sqlite-store:dedupe-collision] first.jobId=${first.jobId} second.jobId=${second.jobId} (expected: both "orig")`,
    );
    try {
      expect(second.jobId).toBe(first.jobId);
      expect(store.getJob("duplicate")).toBeNull();
      expect(store.listJobs()).toHaveLength(1);
      expect(store.getJobByDedupe("badger", "u1|/movies/orchard.mkv|source")?.jobId).toBe(
        "orig"
      );
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("dedupe-collision-failure", {
        store,
        extra: { first, second },
      });
      throw err;
    }
  });

  it("getJobByDedupe returns null when no matching row exists", () => {
    console.info(
      `[jobs-sqlite-store:dedupe-miss] empty store; getJobByDedupe(badger, missing) expected null`,
    );
    try {
      expect(store.getJobByDedupe("badger", "missing")).toBeNull();
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("dedupe-miss-failure", { store });
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // @bugfix @regression-proof — effervescent-teapot Round 3
  // "delete media + re-add same file" must produce a fresh job.
  // Stale dedupe rows (dismissed / failed / cancelled) must NOT block.
  // A succeeded-but-not-dismissed row still wins (double-click idempotency).
  // -----------------------------------------------------------------------
  it("@bugfix @regression-proof getJobByDedupe ignores dismissed rows", () => {
    console.info(
      `[jobs-sqlite-store:dedupe-ignore-dismissed] seeding succeeded+dismissed row; dedupe lookup should return null`,
    );
    store.upsertJob(
      baseJob({
        jobId: "dismissed-old",
        status: "succeeded",
        dedupeKey: "u1|orchard.mkv|source",
      })
    );
    store.dismissJob("dismissed-old", "2026-04-01T00:00:00.000Z");
    try {
      expect(
        store.getJobByDedupe("badger", "u1|orchard.mkv|source")
      ).toBeNull();
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("dedupe-ignore-dismissed-failure", { store });
      throw err;
    }
  });

  it("@bugfix @regression-proof getJobByDedupe ignores failed rows", () => {
    console.info(
      `[jobs-sqlite-store:dedupe-ignore-failed] seeding failed row; dedupe lookup should return null`,
    );
    store.upsertJob(
      baseJob({
        jobId: "failed-old",
        status: "failed",
        dedupeKey: "u1|orchard.mkv|source",
      })
    );
    try {
      expect(
        store.getJobByDedupe("badger", "u1|orchard.mkv|source")
      ).toBeNull();
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("dedupe-ignore-failed-failure", { store });
      throw err;
    }
  });

  it("@bugfix @regression-proof getJobByDedupe ignores cancelled rows", () => {
    console.info(
      `[jobs-sqlite-store:dedupe-ignore-cancelled] seeding cancelled row; dedupe lookup should return null`,
    );
    store.upsertJob(
      baseJob({
        jobId: "cancelled-old",
        status: "cancelled",
        dedupeKey: "u1|orchard.mkv|source",
      })
    );
    try {
      expect(
        store.getJobByDedupe("badger", "u1|orchard.mkv|source")
      ).toBeNull();
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("dedupe-ignore-cancelled-failure", { store });
      throw err;
    }
  });

  it("getJobByDedupe still returns active (queued / running) rows", () => {
    console.info(
      `[jobs-sqlite-store:dedupe-returns-active] iterating queued/running statuses; each should round-trip via dedupe key`,
    );
    for (const status of ["queued", "running"] as const) {
      const jobId = `live-${status}`;
      const dedupeKey = `u1|live-${status}|source`;
      store.upsertJob(
        baseJob({
          jobId,
          status,
          dedupeKey,
        })
      );
      const found = store.getJobByDedupe("badger", dedupeKey);
      console.info(
        `[jobs-sqlite-store:dedupe-returns-active] status=${status} → found.jobId=${found?.jobId}`,
      );
      try {
        expect(found?.jobId).toBe(jobId);
      } catch (err) {
        dumpJobsSqliteStoreSnapshot("dedupe-returns-active-failure", {
          store,
          extra: { status, dedupeKey, found },
        });
        throw err;
      }
    }
  });

  // ---------------------------------------------------------------------
  // @bugfix #9 follow-up — terminal-rows-no-dedupe.
  //
  // The Day 0 commit (1b434fa6) treated `succeeded` (without `dismissed_at`)
  // as a dedupe-blocking state so accidental double-clicks during in-flight
  // work would be idempotent. That reasoning was wrong: by the time a job
  // reaches `succeeded`, the work is done and the user re-submitting the
  // same payload is expressing clear new intent. The dedupe slot must free.
  //
  // Verifier observed this live: re-dragging Orchard after the source had
  // succeeded returned the OLD jobId (`a66a235c`) and never created a new
  // row. The fix narrows the predicate to active (queued/running) only.
  // ---------------------------------------------------------------------
  it("@bugfix @regression-proof getJobByDedupe returns NULL for succeeded rows (terminal frees the slot)", () => {
    console.info(
      `[jobs-sqlite-store:dedupe-succeeded-null] seeding succeeded-not-dismissed row; dedupe lookup should now return null (post-fix)`,
    );
    store.upsertJob(
      baseJob({
        jobId: "succeeded-old",
        status: "succeeded",
        dedupeKey: "u1|orchard.mkv|source",
      })
    );
    try {
      expect(store.getJobByDedupe("badger", "u1|orchard.mkv|source")).toBeNull();
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("dedupe-succeeded-null-failure", { store });
      throw err;
    }
  });

  it("@bugfix @regression-proof getJobByDedupe returns NULL for interrupted rows (terminal frees the slot)", () => {
    console.info(
      `[jobs-sqlite-store:dedupe-interrupted-null] seeding interrupted row; dedupe lookup should return null`,
    );
    store.upsertJob(
      baseJob({
        jobId: "interrupted-old",
        status: "interrupted",
        dedupeKey: "u1|orchard.mkv|source",
      })
    );
    try {
      expect(store.getJobByDedupe("badger", "u1|orchard.mkv|source")).toBeNull();
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("dedupe-interrupted-null-failure", { store });
      throw err;
    }
  });

  it("@bugfix @regression-proof re-submit after a succeeded source produces a fresh jobId (live verifier scenario)", () => {
    console.info(
      `[jobs-sqlite-store:resubmit-fresh] seeding succeeded source then re-upserting fresh row with same dedupe key`,
    );
    // Reproduces the live trace: an old succeeded row owns the dedupe slot.
    store.upsertJob(
      baseJob({
        jobId: "old-succeeded-source",
        status: "succeeded",
        dedupeKey: "u1|orchard.mkv|source",
      })
    );
    // Re-submit with the same dedupe key; the upsert must INSERT a new row,
    // not return the old one. `upsertJob` will free the stale slot first
    // (NULL-out the old row's dedupe_key), then INSERT.
    const next = store.upsertJob(
      baseJob({
        jobId: "fresh-source",
        status: "queued",
        dedupeKey: "u1|orchard.mkv|source",
      })
    );
    const oldRow = store.getJob("old-succeeded-source");
    const ownerByDedupe = store.getJobByDedupe("badger", "u1|orchard.mkv|source");
    console.info(
      `[jobs-sqlite-store:resubmit-fresh] next.jobId=${next.jobId} oldRow.dedupeKey=${oldRow?.dedupeKey ?? "null"} ownerByDedupe.jobId=${ownerByDedupe?.jobId}`,
    );
    try {
      expect(next.jobId).toBe("fresh-source");
      // Old row is still durable for history, just no longer holds the slot.
      expect(oldRow).toBeTruthy();
      expect(oldRow?.dedupeKey).toBeNull();
      // Fresh row owns the slot.
      expect(ownerByDedupe?.jobId).toBe("fresh-source");
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("resubmit-fresh-failure", {
        store,
        extra: { next, oldRow, ownerByDedupe },
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof upsertJob with a stale dedupe row inserts a fresh row (frees the unique slot)", () => {
    console.info(
      `[jobs-sqlite-store:stale-dedupe-slot] seeding cancelled+dismissed row then upserting fresh row with same dedupe key`,
    );
    // Old row: cancelled + dismissed.
    store.upsertJob(
      baseJob({
        jobId: "old",
        status: "cancelled",
        dedupeKey: "u1|orchard.mkv|source",
      })
    );
    store.dismissJob("old", "2026-04-01T00:00:00.000Z");

    // New ingest with the same dedupe key must succeed.
    store.upsertJob(
      baseJob({ jobId: "fresh", dedupeKey: "u1|orchard.mkv|source" })
    );
    const fresh = store.getJob("fresh");
    const old = store.getJob("old");
    console.info(
      `[jobs-sqlite-store:stale-dedupe-slot] fresh.dedupeKey=${fresh?.dedupeKey} old.dedupeKey=${old?.dedupeKey ?? "null"}`,
    );

    try {
      expect(fresh).not.toBeNull();
      expect(fresh!.dedupeKey).toBe("u1|orchard.mkv|source");
      // Old row still exists (history) but its dedupe_key has been freed.
      expect(old).not.toBeNull();
      expect(old!.dedupeKey).toBeNull();
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("stale-dedupe-slot-failure", {
        store,
        extra: { fresh, old },
      });
      throw err;
    }
  });

  it("upsertJob does NOT dedupe rows with null dedupe_key", () => {
    console.info(
      `[jobs-sqlite-store:null-dedupe-no-collision] two upserts with dedupeKey=null should produce 2 rows`,
    );
    store.upsertJob(baseJob({ jobId: "a", dedupeKey: null }));
    store.upsertJob(baseJob({ jobId: "b", dedupeKey: null }));
    try {
      expect(store.listJobs()).toHaveLength(2);
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("null-dedupe-no-collision-failure", { store });
      throw err;
    }
  });

  it("updateJobStatus stamps startedAt on first running and finishedAt on terminal", () => {
    console.info(
      `[jobs-sqlite-store:status-stamps] running → succeeded transitions stamp timestamps`,
    );
    store.upsertJob(baseJob());
    const running = store.updateJobStatus("j1", "running");
    console.info(
      `[jobs-sqlite-store:status-stamps] after running: startedAt=${running?.startedAt} finishedAt=${running?.finishedAt}`,
    );

    const succeeded = store.updateJobStatus("j1", "succeeded", { progressPct: 100 });
    console.info(
      `[jobs-sqlite-store:status-stamps] after succeeded: finishedAt=${succeeded?.finishedAt} progressPct=${succeeded?.progressPct}`,
    );
    try {
      expect(running!.startedAt).not.toBeNull();
      expect(running!.finishedAt).toBeNull();
      expect(succeeded!.finishedAt).not.toBeNull();
      expect(succeeded!.progressPct).toBe(100);
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("status-stamps-failure", {
        store,
        extra: { running, succeeded },
      });
      throw err;
    }
  });

  it("updateJobStatus returns null when the job does not exist", () => {
    console.info(
      `[jobs-sqlite-store:status-ghost] updateJobStatus(ghost) should return null`,
    );
    try {
      expect(store.updateJobStatus("ghost", "running")).toBeNull();
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("status-ghost-failure", { store });
      throw err;
    }
  });

  it("setCancelRequested toggles the flag", () => {
    console.info(
      `[jobs-sqlite-store:cancel-flag] before=false → setCancelRequested(true)`,
    );
    store.upsertJob(baseJob());
    try {
      expect(store.getJob("j1")!.cancelRequested).toBe(false);
      store.setCancelRequested("j1", true);
      expect(store.getJob("j1")!.cancelRequested).toBe(true);
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("cancel-flag-failure", { store });
      throw err;
    }
  });

  it("findChildren returns jobs whose parentJobIds JSON contains the id (multi-parent)", () => {
    console.info(
      `[jobs-sqlite-store:find-children] seeding 4 jobs (a, b, c<-[a,b], d<-[a])`,
    );
    store.upsertJob(baseJob({ jobId: "a" }));
    store.upsertJob(baseJob({ jobId: "b" }));
    store.upsertJob(
      baseJob({
        jobId: "c",
        parentJobIds: ["a", "b"], // multi-parent
        kind: "format",
        variant: "360p",
      })
    );
    store.upsertJob(
      baseJob({
        jobId: "d",
        parentJobIds: ["a"],
        kind: "format",
        variant: "720p",
      })
    );

    const childrenOfA = store.findChildren("a");
    const childrenOfB = store.findChildren("b");
    const childrenOfMissing = store.findChildren("nonexistent");
    console.info(
      `[jobs-sqlite-store:find-children] children(a)=${JSON.stringify(childrenOfA.map((j) => j.jobId))} children(b)=${JSON.stringify(childrenOfB.map((j) => j.jobId))} children(nonexistent)=${childrenOfMissing.length}`,
    );

    try {
      expect(childrenOfA.map((j) => j.jobId).sort()).toEqual(["c", "d"]);
      expect(childrenOfB.map((j) => j.jobId)).toEqual(["c"]);
      expect(childrenOfMissing).toEqual([]);
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("find-children-failure", {
        store,
        extra: { childrenOfA, childrenOfB, childrenOfMissing },
      });
      throw err;
    }
  });

  it("dismissJob sets dismissedAt and excludes from default list", () => {
    console.info(
      `[jobs-sqlite-store:dismiss-exclude] dismissing cancelled j1; default list should exclude, includeDismissed should include`,
    );
    store.upsertJob(baseJob({ status: "cancelled" }));
    store.dismissJob("j1", "2026-05-01T00:00:00.000Z");
    try {
      expect(store.listJobs()).toHaveLength(0);
      expect(store.listJobs({ includeDismissed: true })).toHaveLength(1);
      expect(store.getJob("j1")!.dismissedAt).toBe("2026-05-01T00:00:00.000Z");
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("dismiss-exclude-failure", { store });
      throw err;
    }
  });

  // @req RT-JOBS-05
  it("purgeFinishedBefore deletes old finished jobs and their steps, keeps live jobs and live parents", () => {
    const old = "2026-01-01T00:00:00.000Z";
    const recent = "2026-04-01T00:00:00.000Z";
    const cutoff = "2026-03-01T00:00:00.000Z";
    store.upsertJob(baseJob({ jobId: "old-ok", status: "succeeded", finishedAt: old, updatedAt: old }));
    store.upsertJob(baseJob({ jobId: "old-failed", status: "failed", finishedAt: old, updatedAt: old }));
    store.upsertJob(baseJob({ jobId: "old-cancelled-no-finish", status: "cancelled", finishedAt: null, updatedAt: old }));
    store.upsertJob(baseJob({ jobId: "recent-ok", status: "succeeded", finishedAt: recent, updatedAt: recent }));
    store.upsertJob(baseJob({ jobId: "old-running", status: "running", updatedAt: old }));
    store.upsertJob(baseJob({ jobId: "old-queued", status: "queued", updatedAt: old }));
    store.upsertJob(baseJob({ jobId: "old-parent", status: "succeeded", finishedAt: old, updatedAt: old }));
    store.upsertJob(baseJob({ jobId: "waiting-child", status: "queued", parentJobIds: ["old-parent"] }));
    store.steps.upsertStep({
      stepId: "old-ok:extract", jobId: "old-ok", ordinal: 0, kind: "extract", status: "succeeded",
      progressPct: 100, errorCode: null, errorMessage: null, startedAt: old, finishedAt: old,
      app: "badger", lane: "source", dependsOn: [], payload: {}, outputs: {}, createdAt: old, updatedAt: old,
    } as never);

    const first = store.purgeFinishedBefore(cutoff, 2);
    const second = store.purgeFinishedBefore(cutoff, 100);
    const left = store.listJobs({}).map((j) => j.jobId).sort();
    console.info(`[jobs-sqlite-store:purge-finished] batch1=${first} (limit 2) batch2=${second} left=${JSON.stringify(left)} stepsOfDeleted=${store.steps.getSteps("old-ok").length}`);
    expect(first).toBe(2);
    expect(second).toBe(1);
    expect(left).toEqual(["old-parent", "old-queued", "old-running", "recent-ok", "waiting-child"]);
    expect(store.steps.getSteps("old-ok")).toHaveLength(0);
  });

  // @req RT-JOBS-05
  it("purgeFinishedBefore stays cheap on a large table (one batch of 200 among 30000 rows)", () => {
    const old = "2026-01-01T00:00:00.000Z";
    store.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
      INSERT INTO runtime_jobs (job_id, app, owner_id, group_id, media_id, kind, status, lane, priority, created_at, updated_at, finished_at)
      SELECT 'bulk-' || i, 'badger', 'u1', 'g1', 'm' || i, 'source', 'succeeded', 'source', 0, '${old}', '${old}', '${old}' FROM n;
    `);
    for (let i = 0; i < 20; i++) store.upsertJob(baseJob({ jobId: `live-${i}`, status: "queued", parentJobIds: [`bulk-${i + 1}`] }));
    const t0 = performance.now();
    const removed = store.purgeFinishedBefore("2026-03-01T00:00:00.000Z", 200);
    const ms = performance.now() - t0;
    console.info(`[jobs-sqlite-store:purge-batch] rows=30020 removed=${removed} ms=${ms.toFixed(1)} (a per-row substring scan of the table took ~700 ms+)`);
    expect(removed).toBe(200);
    expect(store.getJob("bulk-1")).not.toBeNull(); // live parent kept
    expect(ms).toBeLessThan(300);
  });

  it("listJobs respects limit", () => {
    console.info(
      `[jobs-sqlite-store:list-limit] seeding 5 jobs; expect listJobs({limit:2}) to return 2`,
    );
    for (let i = 0; i < 5; i++) {
      store.upsertJob(baseJob({ jobId: `j${i}`, priority: i }));
    }
    try {
      expect(store.listJobs({ limit: 2 })).toHaveLength(2);
    } catch (err) {
      dumpJobsSqliteStoreSnapshot("list-limit-failure", { store });
      throw err;
    }
  });
});
