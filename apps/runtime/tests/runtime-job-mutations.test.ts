import { describe, expect, it } from "vitest";
import type { RuntimeJobRecord } from "@space/runtime-jobs";
import {
  buildBadgerRuntimeJobMutation,
  buildRuntimeJobMutationRequestId,
} from "../src/core/jobs/mutations";

const makeJob = (overrides: Partial<RuntimeJobRecord>): RuntimeJobRecord => ({
  jobId: overrides.jobId ?? "job-1",
  app: overrides.app ?? "badger",
  kind: overrides.kind ?? "badger.ingest.media_file",
  lane: overrides.lane ?? "background",
  status: overrides.status ?? "running",
  stageCode: overrides.stageCode ?? "uploading",
  stageLabel: overrides.stageLabel ?? "Uploading",
  progress: overrides.progress ?? { mode: "indeterminate", completed: null, total: null, unit: null },
  payload: overrides.payload ?? {},
  outputs: overrides.outputs ?? {},
  errorCode: overrides.errorCode ?? null,
  errorMessage: overrides.errorMessage ?? null,
  retryable: overrides.retryable ?? true,
  cancelRequested: overrides.cancelRequested ?? false,
  priority: overrides.priority ?? 0,
  dedupeKey: overrides.dedupeKey ?? null,
  createdAt: overrides.createdAt ?? "2026-03-23T10:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-03-23T10:00:00.000Z",
  startedAt: overrides.startedAt ?? "2026-03-23T10:00:00.000Z",
  finishedAt: overrides.finishedAt ?? null,
});

const dumpMutationSnapshot = (label: string, ctx: { received?: unknown; expected?: unknown }) => {
  try {
    console.error(`=== [runtime-job-mutations:${label}] snapshot ===`);
    if (ctx.received !== undefined) console.error(`received=${JSON.stringify(ctx.received, null, 2)}`);
    if (ctx.expected !== undefined) console.error(`expected=${JSON.stringify(ctx.expected, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime job mutation planner [runtime-job-mutations]", () => {
  it("builds deterministic runtime job mutation request ids @bugfix @regression-proof", () => {
    console.info(`[runtime-job-mutations:request-id] verifying cancel/retry id format`);
    try {
      expect(buildRuntimeJobMutationRequestId("cancel", "task-7")).toBe("runtime-jobs-cancel-task-7");
      expect(buildRuntimeJobMutationRequestId("retry", "job-9")).toBe("runtime-jobs-retry-job-9");
    } catch (err) {
      dumpMutationSnapshot("request-id-failure", {
        received: {
          cancelTask7: buildRuntimeJobMutationRequestId("cancel", "task-7"),
          retryJob9: buildRuntimeJobMutationRequestId("retry", "job-9"),
        },
      });
      throw err;
    }
  });

  it("prefers canonical job payload userId when planning badger mutations @bugfix @regression-proof", () => {
    console.info(`[runtime-job-mutations:prefer-payload-userId] payload.userId=owner-from-payload vs parsed=owner-from-id`);
    const received = buildBadgerRuntimeJobMutation(
      "cancel",
      {
        app: "badger",
        kind: "ingest",
        ownerId: "owner-from-id",
        rawId: "job-9",
        jobId: "badger:ingest:owner-from-id:job-9",
      },
      makeJob({
        payload: { userId: "owner-from-payload" },
      }),
    );
    const expected = {
      requestId: "runtime-jobs-cancel-job-9",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "owner-from-payload",
        actions: [{ type: "cancel_job", jobId: "job-9" }],
      },
    };
    try {
      expect(received).toEqual(expected);
    } catch (err) {
      dumpMutationSnapshot("prefer-payload-userId-failure", { received, expected });
      throw err;
    }
  });

  it("falls back to parsed ownerId for badger mutations when canonical payload is missing @bugfix @regression-proof", () => {
    console.info(`[runtime-job-mutations:fallback-parsed-ownerId] job=null, parsed ownerId=owner-from-id`);
    const received = buildBadgerRuntimeJobMutation(
      "retry",
      {
        app: "badger",
        kind: "ingest",
        ownerId: "owner-from-id",
        rawId: "job-10",
        jobId: "badger:ingest:owner-from-id:job-10",
      },
      null,
    );
    const expected = {
      requestId: "runtime-jobs-retry-job-10",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "owner-from-id",
        actions: [{ type: "start_job", jobId: "job-10" }],
      },
    };
    try {
      expect(received).toEqual(expected);
    } catch (err) {
      dumpMutationSnapshot("fallback-parsed-ownerId-failure", { received, expected });
      throw err;
    }
  });

  it("omits badger userId when the canonical id carries only the active placeholder @bugfix @regression-proof", () => {
    console.info(`[runtime-job-mutations:active-placeholder] ownerId=active should drop userId from payload`);
    const received = buildBadgerRuntimeJobMutation(
      "cancel",
      {
        app: "badger",
        kind: "ingest",
        ownerId: "active",
        rawId: "job-11",
        jobId: "badger:ingest:active:job-11",
      },
      null,
    );
    const expected = {
      requestId: "runtime-jobs-cancel-job-11",
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        actions: [{ type: "cancel_job", jobId: "job-11" }],
      },
    };
    try {
      expect(received).toEqual(expected);
    } catch (err) {
      dumpMutationSnapshot("active-placeholder-failure", { received, expected });
      throw err;
    }
  });
});
