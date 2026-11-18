import { describe, expect, it } from "vitest";
import { RuntimeJobsStore } from "../src/core/jobs/store";
import { RuntimeJobEngine } from "../src/core/jobs/engine";
import { publishRuntimeJobLifecycle, publishRuntimeJobsUpdate } from "../src/core/jobs/events";
import type { RuntimeJobRecord } from "@space/runtime-jobs";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps the store, events buffer, and recovered IDs on
// assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpRuntimeJobEngineSnapshot = (
  label: string,
  ctx: {
    store?: RuntimeJobsStore;
    events?: Array<Record<string, unknown>>;
    captured?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-job-engine:${label}] snapshot ===`);
    if (ctx.store) {
      try {
        const list = ctx.store.list();
        console.error(
          `store.list (${list.length})=\n${JSON.stringify(
            list.map((j) => ({
              jobId: j.jobId,
              status: j.status,
              stageCode: j.stageCode,
              attemptCount: j.attemptCount,
              maxAttempts: j.maxAttempts,
              errorCode: j.errorCode,
              cancelRequested: j.cancelRequested,
            })),
            null,
            2,
          )}`,
        );
      } catch (err) {
        console.error(
          `(store.list failed: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    if (ctx.events) {
      console.error(
        `events (${ctx.events.length})=\n${JSON.stringify(ctx.events, null, 2)}`,
      );
    }
    if (ctx.captured !== undefined) {
      console.error(`captured=${JSON.stringify(ctx.captured)}`);
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

const job = (overrides: Partial<RuntimeJobRecord>): RuntimeJobRecord => ({
  jobId: overrides.jobId ?? "job-1",
  app: overrides.app ?? "badger",
  kind: overrides.kind ?? "badger.ingest.media_file",
  lane: overrides.lane ?? "cpu",
  status: overrides.status ?? "queued",
  stageCode: overrides.stageCode ?? "queued",
  stageLabel: overrides.stageLabel ?? "Queued",
  progress: overrides.progress ?? { mode: "none", completed: null, total: null, unit: null },
  payload: overrides.payload ?? {},
  outputs: overrides.outputs ?? {},
  errorCode: overrides.errorCode ?? null,
  errorMessage: overrides.errorMessage ?? null,
  retryable: overrides.retryable ?? true,
  attemptCount: overrides.attemptCount ?? 0,
  maxAttempts: overrides.maxAttempts,
  nextAttemptAt: overrides.nextAttemptAt ?? null,
  lastAttemptAt: overrides.lastAttemptAt ?? null,
  cancelRequested: overrides.cancelRequested ?? false,
  priority: overrides.priority ?? 0,
  dedupeKey: overrides.dedupeKey ?? null,
  createdAt: overrides.createdAt ?? "2026-03-23T12:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-03-23T12:00:00.000Z",
  startedAt: overrides.startedAt ?? null,
  finishedAt: overrides.finishedAt ?? null,
});

describe("runtime job engine", () => {
  it("@bugfix @regression-proof runs queued canonical jobs through a registered handler and settles them as succeeded", async () => {
    console.info(`[runtime-job-engine:runs-queued-handler] setup`);
    const store = new RuntimeJobsStore();
    const events: Array<{ channel: string; event: string; payload: Record<string, unknown> }> = [];
    store.upsert(job({ jobId: "queued-1", kind: "badger.ingest.media_file" }));

    const engine = new RuntimeJobEngine(
      store,
      undefined,
      ({ channel, event, payload }) => events.push({ channel, event, payload }),
      () => "2026-03-23T12:01:00.000Z"
    );
    engine.registerHandler("badger.ingest.media_file", async () => ({
      stageCode: "done",
      stageLabel: "Done",
      progress: { mode: "fraction", completed: 100, total: 100, unit: "percent" },
      outputs: { mediaId: "media-1" },
    }));

    let finished: RuntimeJobRecord | null | undefined;
    try {
      finished = await engine.runNext();
      console.info(
        `[runtime-job-engine:runs-queued-handler] finished status=${finished?.status} events=${events.map((e) => e.event).join(",")}`,
      );
      expect(finished?.status).toBe("succeeded");
      expect(finished?.outputs).toEqual({ mediaId: "media-1" });
      expect(events.map((entry) => entry.event)).toEqual(["runtime.jobs.updated", "runtime.jobs.completed"]);
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("runs-queued-handler", { store, events, extra: { finished } });
      throw err;
    }
  });

  it("@bugfix @regression-proof marks running jobs cancelled when cancellation is requested during handler execution", async () => {
    console.info(`[runtime-job-engine:cancel-during-handler] setup`);
    const store = new RuntimeJobsStore();
    store.upsert(job({ jobId: "queued-2", kind: "parrot.ingest.local_file", app: "parrot", lane: "io" }));

    let capturedSignal: AbortSignal | null = null;
    const engine = new RuntimeJobEngine(store, undefined, () => undefined, () => "2026-03-23T12:02:00.000Z");
    engine.registerHandler("parrot.ingest.local_file", async (_job, context) => {
      capturedSignal = context.signal;
      console.info(`[runtime-job-engine:cancel-during-handler] handler entered; requesting cancel`);
      engine.requestCancel("queued-2");
      return {
        stageCode: "uploaded",
        stageLabel: "Uploaded",
      };
    });

    let finished: RuntimeJobRecord | null | undefined;
    try {
      finished = await engine.runNext();
      console.info(
        `[runtime-job-engine:cancel-during-handler] finished status=${finished?.status} signalAborted=${(capturedSignal as AbortSignal | null)?.aborted}`,
      );
      expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true);
      expect(finished?.status).toBe("cancelled");
      expect(finished?.cancelRequested).toBe(true);
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("cancel-during-handler", {
        store,
        extra: {
          finished,
          signalAborted: (capturedSignal as AbortSignal | null)?.aborted,
        },
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof cancels queued canonical jobs immediately without waiting for handler execution", () => {
    console.info(`[runtime-job-engine:cancel-queued-immediate] setup`);
    const store = new RuntimeJobsStore();
    store.upsert(job({ jobId: "queued-cancel-1", status: "queued", stageCode: "queued", stageLabel: "Queued" }));

    const engine = new RuntimeJobEngine(store, undefined, () => undefined, () => "2026-03-23T12:03:00.000Z");
    let cancelled: RuntimeJobRecord | null | undefined;
    try {
      cancelled = engine.requestCancel("queued-cancel-1");
      console.info(
        `[runtime-job-engine:cancel-queued-immediate] cancelled status=${cancelled?.status}`,
      );
      expect(cancelled).toEqual(
        expect.objectContaining({
          status: "cancelled",
          stageCode: "cancelled",
          stageLabel: "Cancelled",
          cancelRequested: false,
          finishedAt: "2026-03-23T12:03:00.000Z",
        })
      );
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("cancel-queued-immediate", { store, extra: { cancelled } });
      throw err;
    }
  });

  it("@bugfix @regression-proof retries failed canonical jobs back into the queued state", () => {
    console.info(`[runtime-job-engine:retry-failed] setup`);
    const store = new RuntimeJobsStore();
    store.upsert(
      job({
        jobId: "failed-1",
        status: "failed",
        stageCode: "failed",
        stageLabel: "Failed",
        errorCode: "quota_exceeded",
        errorMessage: "Quota exceeded",
        finishedAt: "2026-03-23T12:03:00.000Z",
      })
    );

    const engine = new RuntimeJobEngine(store, undefined, () => undefined, () => "2026-03-23T12:04:00.000Z");
    let retried: RuntimeJobRecord | null | undefined;
    try {
      retried = engine.retry("failed-1");
      console.info(`[runtime-job-engine:retry-failed] retried status=${retried?.status}`);
      expect(retried).toEqual(
        expect.objectContaining({
          status: "queued",
          stageCode: "queued",
          errorCode: null,
          cancelRequested: false,
          attemptCount: 0,
          nextAttemptAt: null,
          startedAt: null,
          finishedAt: null,
        })
      );
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("retry-failed", { store, extra: { retried } });
      throw err;
    }
  });

  it("@bugfix @regression-proof schedules retryable handler failures back into queued retry state with backoff metadata", async () => {
    console.info(`[runtime-job-engine:retryable-backoff] setup`);
    const store = new RuntimeJobsStore();
    store.upsert(job({ jobId: "retry-1", kind: "badger.ingest.media_file", retryable: true }));

    const engine = new RuntimeJobEngine(store, undefined, () => undefined, () => "2026-03-23T12:10:00.000Z");
    engine.registerHandler("badger.ingest.media_file", async () => ({
      status: "failed",
      stageCode: "failed",
      stageLabel: "Failed",
      retryable: true,
      retryAfterMs: 2_000,
      errorCode: "transient_failure",
      errorMessage: "Please retry later",
      maxAttempts: 2,
    }));

    let retried: RuntimeJobRecord | null | undefined;
    try {
      retried = await engine.runNext();
      console.info(
        `[runtime-job-engine:retryable-backoff] retried status=${retried?.status} attempt=${retried?.attemptCount}/${retried?.maxAttempts} nextAttemptAt=${retried?.nextAttemptAt}`,
      );
      expect(retried).toEqual(
        expect.objectContaining({
          status: "queued",
          stageCode: "retry_scheduled",
          stageLabel: "Retry scheduled",
          attemptCount: 1,
          maxAttempts: 2,
          nextAttemptAt: "2026-03-23T12:10:02.000Z",
          lastAttemptAt: "2026-03-23T12:10:00.000Z",
          errorCode: "transient_failure",
        })
      );
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("retryable-backoff", { store, extra: { retried } });
      throw err;
    }
  });

  it("@bugfix @regression-proof leaves exhausted retryable failures terminal instead of requeueing forever", async () => {
    console.info(`[runtime-job-engine:retry-exhausted] setup`);
    const store = new RuntimeJobsStore();
    store.upsert(
      job({
        jobId: "retry-exhausted-1",
        kind: "badger.ingest.media_file",
        retryable: true,
        attemptCount: 2,
        maxAttempts: 2,
      })
    );

    const engine = new RuntimeJobEngine(store, undefined, () => undefined, () => "2026-03-23T12:15:00.000Z");
    engine.registerHandler("badger.ingest.media_file", async () => ({
      status: "failed",
      stageCode: "failed",
      stageLabel: "Failed",
      retryable: true,
      retryAfterMs: 1_000,
      errorCode: "still_broken",
    }));

    let failed: RuntimeJobRecord | null | undefined;
    try {
      failed = await engine.runNext();
      console.info(`[runtime-job-engine:retry-exhausted] final status=${failed?.status} errorCode=${failed?.errorCode}`);
      expect(failed).toEqual(
        expect.objectContaining({
          status: "failed",
          stageCode: "failed",
          errorCode: "still_broken",
        })
      );
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("retry-exhausted", { store, extra: { failed } });
      throw err;
    }
  });

  it("@bugfix @regression-proof requeues interrupted running jobs during recovery so the shared engine can resume them after restart", async () => {
    console.info(`[runtime-job-engine:recover-interrupted] setup`);
    const store = new RuntimeJobsStore();
    store.upsert(
      job({
        jobId: "recover-1",
        kind: "badger.ingest.media_file",
        status: "running",
        stageCode: "transcoding",
        stageLabel: "Processing",
        progress: { mode: "fraction", completed: 37, total: 100, unit: "percent" },
        startedAt: "2026-03-23T12:00:10.000Z",
      })
    );

    const engine = new RuntimeJobEngine(store, undefined, () => undefined, () => "2026-03-23T12:16:00.000Z");
    engine.registerHandler("badger.ingest.media_file", async () => ({
      status: "succeeded",
      stageCode: "done",
      stageLabel: "Done",
    }));

    let recovered: RuntimeJobRecord[] | undefined;
    let resumed: RuntimeJobRecord | null | undefined;
    try {
      recovered = engine.recoverInterruptedJobs();
      console.info(
        `[runtime-job-engine:recover-interrupted] recovered=${recovered.length} ids=${JSON.stringify(recovered.map((r) => r.jobId))}`,
      );
      expect(recovered).toHaveLength(1);
      expect(store.get("recover-1")).toEqual(
        expect.objectContaining({
          status: "queued",
          stageCode: "queued",
          stageLabel: "Queued",
          startedAt: null,
          finishedAt: null,
        })
      );
      expect(store.get("recover-1")?.progress).toEqual({
        mode: "none",
        completed: null,
        total: null,
        unit: null,
      });

      resumed = await engine.runNext();
      console.info(
        `[runtime-job-engine:recover-interrupted] resumed status=${resumed?.status}`,
      );
      expect(resumed?.status).toBe("succeeded");
      expect(store.get("recover-1")?.status).toBe("succeeded");
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("recover-interrupted", {
        store,
        extra: { recovered, resumed },
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof leaves interrupted running jobs in place when a handler opts out of engine-side recovery", () => {
    console.info(`[runtime-job-engine:recover-opt-out] setup`);
    const store = new RuntimeJobsStore();
    store.upsert(
      job({
        jobId: "recover-parrot-1",
        kind: "parrot.ingest.local_file",
        app: "parrot",
        lane: "io",
        status: "running",
        stageCode: "uploading",
        stageLabel: "Uploading",
        startedAt: "2026-03-23T12:00:10.000Z",
      })
    );

    const engine = new RuntimeJobEngine(store, undefined, () => undefined, () => "2026-03-23T12:17:00.000Z");
    engine.registerHandler(
      "parrot.ingest.local_file",
      async () => ({
        status: "succeeded",
        stageCode: "done",
        stageLabel: "Done",
      }),
      { recoverInterrupted: false }
    );

    let recovered: RuntimeJobRecord[] | undefined;
    try {
      recovered = engine.recoverInterruptedJobs();
      console.info(
        `[runtime-job-engine:recover-opt-out] recovered=${recovered.length}; expecting 0 (opt-out)`,
      );
      expect(recovered).toEqual([]);
      expect(store.get("recover-parrot-1")).toEqual(
        expect.objectContaining({
          status: "running",
          stageCode: "uploading",
          stageLabel: "Uploading",
          startedAt: "2026-03-23T12:00:10.000Z",
        })
      );
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("recover-opt-out", { store, extra: { recovered } });
      throw err;
    }
  });
});

describe("runtime job event helpers", () => {
  it("@bugfix @regression-proof publishes canonical runtime job update mirrors from runtime job records", () => {
    console.info(`[runtime-job-engine:publish-update] dispatching publishRuntimeJobsUpdate`);
    const events: Array<{ channel: string; event: string; payload: Record<string, unknown> }> = [];
    publishRuntimeJobsUpdate(
      ({ channel, event, payload }) => events.push({ channel, event, payload }),
      {
        app: "badger",
        requestId: "req-1",
        sourceChannel: "badger.command",
        sourceEvent: "badger.ingest.apply",
        jobs: [job({ jobId: "evt-1" })],
      }
    );

    try {
      console.info(
        `[runtime-job-engine:publish-update] events=${JSON.stringify(events.map((e) => `${e.channel}:${e.event}`))}`,
      );
      expect(events.map((entry) => `${entry.channel}:${entry.event}`)).toEqual(["runtime.jobs:runtime.jobs.updated"]);
      expect(events[0]?.payload.requestId).toBe("req-1");
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("publish-update", { events });
      throw err;
    }
  });

  it("@bugfix @regression-proof emits completed runtime lifecycle events for succeeded jobs", () => {
    console.info(`[runtime-job-engine:publish-lifecycle] dispatching publishRuntimeJobLifecycle`);
    const events: Array<{ channel: string; event: string }> = [];
    publishRuntimeJobLifecycle(
      ({ channel, event }) => events.push({ channel, event }),
      {
        app: "badger",
        sourceChannel: "runtime.jobs",
        sourceEvent: "runtime.jobs.settled",
        job: job({ status: "succeeded", stageCode: "done", stageLabel: "Done", progress: { mode: "fraction", completed: 100, total: 100, unit: "percent" } }),
      }
    );

    try {
      console.info(
        `[runtime-job-engine:publish-lifecycle] events=${JSON.stringify(events)}`,
      );
      expect(events).toEqual([{ channel: "runtime.jobs", event: "runtime.jobs.completed" }]);
    } catch (err) {
      dumpRuntimeJobEngineSnapshot("publish-lifecycle", { events });
      throw err;
    }
  });
});
