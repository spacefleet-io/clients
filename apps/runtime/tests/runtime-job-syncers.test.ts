import { beforeEach, describe, expect, it } from "vitest";
import { runtimeJobsStore } from "../src/core/jobs/store";
import {
  syncBadgerRuntimeJobsFromCommandResult,
  syncBadgerRuntimeJobsFromEventPayload,
  upsertBadgerRuntimeJobs,
} from "../src/core/jobs/syncers";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps sync result + store state on assertion failure.
// Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpSyncerSnapshot = (
  label: string,
  ctx: {
    synced?: unknown;
    storeIds?: string[];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-syncers:${label}] snapshot ===`);
    if (ctx.synced !== undefined) {
      console.error(`synced=\n${JSON.stringify(ctx.synced, null, 2)}`);
    }
    if (ctx.storeIds) {
      console.error(`storeIds=${JSON.stringify(ctx.storeIds)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime job syncers", () => {
  beforeEach(() => {
    console.info(`[runtime-syncers:setup] resetting runtimeJobsStore`);
    runtimeJobsStore.reset({ clearPersistence: true });
  });

  it("upserts badger jobs deterministically @bugfix @regression-proof", () => {
    console.info(`[runtime-syncers:badger-upsert] upserting 1 transcoding job for user-a`);
    const jobs = upsertBadgerRuntimeJobs(
      [
        {
          id: "job-1",
          filename: "/tmp/movie.mkv",
          status: "transcoding",
          progress: 12,
        },
      ],
      "user-a"
    );

    try {
      expect(jobs).toEqual([
        expect.objectContaining({
          jobId: "badger:ingest:user-a:job-1",
          status: "running",
          stageCode: "transcoding",
        }),
      ]);
    } catch (err) {
      dumpSyncerSnapshot("badger-upsert-failure", { synced: jobs });
      throw err;
    }
  });

  it("ignores slim badger open/apply command acknowledgements without job arrays deterministically @bugfix @regression-proof", () => {
    console.info(`[runtime-syncers:slim-ack-ignore] both open + apply acks without job arrays return []`);
    const openResult = syncBadgerRuntimeJobsFromCommandResult("badger.ingest.open", {
      userId: "user-a",
      totalJobs: 0,
    });
    const applyResult = syncBadgerRuntimeJobsFromCommandResult("badger.ingest.apply", {
      userId: "user-a",
      changed: true,
      totalJobs: 1,
    });
    console.info(`[runtime-syncers:slim-ack-ignore] openResult.length=${openResult.length} applyResult.length=${applyResult.length}`);
    try {
      expect(openResult).toEqual([]);
      expect(applyResult).toEqual([]);
    } catch (err) {
      dumpSyncerSnapshot("slim-ack-ignore-failure", {
        synced: { openResult, applyResult },
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof ignores unopened badger list_jobs snapshots so a closed module cannot wipe canonical jobs", () => {
    console.info(`[runtime-syncers:unopened-list-jobs] seeding 1 job then submitting list_jobs with opened=false`);
    upsertBadgerRuntimeJobs(
      [
        {
          id: "job-1",
          filename: "/tmp/Friends - S03E01.mkv",
          status: "ready",
          progress: 0,
          matchedMediaId: "media-friends",
        },
      ],
      "user-a"
    );

    const synced = syncBadgerRuntimeJobsFromCommandResult("badger.ingest.list_jobs", {
      userId: "user-a",
      opened: false,
      jobs: [],
    });

    const stored = runtimeJobsStore.get("badger:ingest:user-a:job-1");
    console.info(`[runtime-syncers:unopened-list-jobs] synced.length=${synced.length} stored.status=${stored?.status}`);
    try {
      expect(synced).toEqual([]);
      expect(stored).toEqual(
        expect.objectContaining({
          jobId: "badger:ingest:user-a:job-1",
          status: "queued",
        })
      );
    } catch (err) {
      dumpSyncerSnapshot("unopened-list-jobs-failure", { synced, extra: { stored } });
      throw err;
    }
  });

  it("prunes stale canonical badger jobs from authoritative snapshots deterministically @bugfix @regression-proof", () => {
    console.info(`[runtime-syncers:prune-stale] seeding 2 ready jobs, then empty authoritative snapshot`);
    upsertBadgerRuntimeJobs(
      [
        {
          id: "job-1",
          filename: "/tmp/Better Call Saul - S01E01.mkv",
          status: "ready",
          progress: 0,
          matchedMediaId: "media-bcs",
        },
        {
          id: "job-2",
          filename: "/tmp/Better Call Saul - S01E03.mkv",
          status: "ready",
          progress: 0,
          matchedMediaId: "media-bcs",
        },
      ],
      "user-a"
    );

    const synced = syncBadgerRuntimeJobsFromEventPayload("ingest", "ingest.jobs_updated", {
      userId: "user-a",
      jobs: [],
    });

    const job1Stored = runtimeJobsStore.get("badger:ingest:user-a:job-1");
    const job2Stored = runtimeJobsStore.get("badger:ingest:user-a:job-2");
    console.info(`[runtime-syncers:prune-stale] synced.length=${synced.length} job1Stored=${job1Stored === null} job2Stored=${job2Stored === null}`);
    try {
      expect(job1Stored).toBeNull();
      expect(job2Stored).toBeNull();
      expect(synced).toHaveLength(2);
      expect(synced).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jobId: "badger:ingest:user-a:job-1",
            status: "cancelled",
          }),
          expect.objectContaining({
            jobId: "badger:ingest:user-a:job-2",
            status: "cancelled",
          }),
        ])
      );
    } catch (err) {
      dumpSyncerSnapshot("prune-stale-failure", {
        synced,
        extra: { job1Stored, job2Stored },
      });
      throw err;
    }
  });
});
