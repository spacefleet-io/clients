/**
 * Verifies that every event emitted by engineV2 conforms to the
 * `runtimeJobsEventSchema` discriminated union from
 * `@space/runtime-contracts`. Each test:
 *   1. drives the engine through the transition that emits a given event type
 *   2. captures the matching event row via `engine.subscribe(...)`
 *   3. reconstructs the wire frame the v2 route forwards (flat top-level
 *      fields: `eventId`, `emittedAt`, `event`, plus per-event payload),
 *   4. parses it through the contract schema and asserts success.
 *
 * Mirrors the strict-validation step the v2 client performs in production —
 * a regression here would surface as `onError` on the client and ship a
 * broken UI. Authoring this test is the single best line of defense against
 * engine/contract drift.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEngineV2,
  type EngineV2,
  type RuntimeJobEvent,
} from "@space/runtime-jobs-engine/engineV2";
import {
  runtimeJobsCancelledEventSchema,
  runtimeJobsCreatedEventSchema,
  runtimeJobsDismissedEventSchema,
  runtimeJobsEventSchema,
  runtimeJobsFailedEventSchema,
  runtimeJobsProgressEventSchema,
  runtimeJobsStartedEventSchema,
  runtimeJobsSucceededEventSchema,
} from "@space/runtime-contracts/runtime/jobs";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "src1",
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

const SOURCE_STEPS = ["probe", "identify", "extract", "upload", "commit"];

/** Reconstruct the wire frame from a captured `RuntimeJobEvent`. */
const toFrame = (e: RuntimeJobEvent): Record<string, unknown> => ({
  eventId: e.eventId,
  emittedAt: e.createdAt,
  event: e.event,
  ...e.payload,
});

const findEvent = (events: RuntimeJobEvent[], name: string) =>
  events.find((e) => e.event === name);

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps the events bus tail + a Zod-parse error
// payload on assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpEventPayloadSnapshot = (
  label: string,
  ctx: {
    events?: RuntimeJobEvent[];
    parse?: { success: boolean; error?: unknown; data?: unknown };
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(
      `=== [jobs-engine-v2-event-payloads:${label}] snapshot ===`,
    );
    if (ctx.events) {
      console.error(
        `events bus length=${ctx.events.length}; recent events:\n${JSON.stringify(
          ctx.events.slice(-12).map((e) => ({
            eventId: e.eventId,
            event: e.event,
            createdAt: e.createdAt,
            payloadKeys: Object.keys(e.payload as Record<string, unknown>),
          })),
          null,
          2,
        )}`,
      );
    }
    if (ctx.parse) {
      console.error(`parse.success=${ctx.parse.success}`);
      if (!ctx.parse.success && ctx.parse.error) {
        console.error(
          `parse.error=${JSON.stringify(
            (ctx.parse.error as { issues?: unknown })?.issues ?? ctx.parse.error,
            null,
            2,
          )}`,
        );
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

describe("engineV2 emitted-event payload shapes (contract conformance)", () => {
  let engine: EngineV2;
  let events: RuntimeJobEvent[];
  let unsub: () => void;

  beforeEach(async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:setup] starting in-memory engine + subscribing to events`,
    );
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));
  });

  afterEach(async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:teardown] unsubscribing + stopping engine; total events captured=${events.length}`,
    );
    unsub();
    await engine.stop();
  });

  it("emits a created event whose frame parses against runtimeJobsCreatedEventSchema and carries the full job record", async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:created] submitting baseJob; expecting runtime.jobs.created`,
    );
    await engine.submit(makeJob());
    const created = findEvent(events, "runtime.jobs.created");
    console.info(
      `[jobs-engine-v2-event-payloads:created] found event? ${Boolean(created)}; total events=${events.length}`,
    );
    try {
      expect(created).toBeDefined();
      const frame = toFrame(created!);
      const parsed = runtimeJobsCreatedEventSchema.safeParse(frame);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.job.jobId).toBe("src1");
        // Full record, not just `{ jobId }`.
        expect(parsed.data.job.groupId).toBe("g1");
        expect(parsed.data.job.payload).toEqual({ userId: "u1" });
      }
    } catch (err) {
      const frame = created ? toFrame(created) : null;
      const parsed = frame
        ? runtimeJobsCreatedEventSchema.safeParse(frame)
        : null;
      dumpEventPayloadSnapshot("created-failure", {
        events,
        parse: parsed ?? undefined,
        extra: { createdFrame: frame },
      });
      throw err;
    }
  });

  it("emits started, progress, and succeeded events whose frames parse against their schemas across a full job run", async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:full-run] registering no-op handlers for ${SOURCE_STEPS.length} steps`,
    );
    for (const kind of SOURCE_STEPS) {
      engine.registerHandler(kind, async ({ reportProgress }) => {
        reportProgress(50, "Encoding");
        reportProgress(100);
      });
    }

    await engine.submit(makeJob());
    await vi.waitFor(
      () => {
        expect(findEvent(events, "runtime.jobs.succeeded")).toBeDefined();
      },
      { timeout: 3000 }
    );
    console.info(
      `[jobs-engine-v2-event-payloads:full-run] succeeded event seen; total events=${events.length}; eventTypes=${JSON.stringify(events.map((e) => e.event))}`,
    );

    const started = findEvent(events, "runtime.jobs.started");
    try {
      expect(started).toBeDefined();
      const startedParse = runtimeJobsStartedEventSchema.safeParse(toFrame(started!));
      expect(startedParse.success).toBe(true);
      if (startedParse.success) {
        expect(startedParse.data.kind).toBe("source");
        expect(startedParse.data.groupId).toBe("g1");
        expect(typeof startedParse.data.startedAt).toBe("string");
      }
    } catch (err) {
      const parse = started
        ? runtimeJobsStartedEventSchema.safeParse(toFrame(started))
        : undefined;
      dumpEventPayloadSnapshot("full-run-started-failure", {
        events,
        parse,
        extra: { started: started ? toFrame(started) : null },
      });
      throw err;
    }

    const progress = findEvent(events, "runtime.jobs.progress");
    try {
      expect(progress).toBeDefined();
      const progressParse = runtimeJobsProgressEventSchema.safeParse(
        toFrame(progress!)
      );
      expect(progressParse.success).toBe(true);
      if (progressParse.success) {
        expect(progressParse.data.progressPct).toBeGreaterThanOrEqual(0);
        // uploadSpeedBytesPerSec is null when not relevant — the schema requires
        // the key to be present and `number | null`.
        expect(progressParse.data.uploadSpeedBytesPerSec).toBeNull();
        expect(typeof progressParse.data.stageCode).toBe("string");
        expect(typeof progressParse.data.stageLabel).toBe("string");
        // Round 7 [@bugfix][@regression-proof]: progress events now carry the
        // live job status. A handler reportProgress() runs while the job is in
        // `running`, so the wire payload must reflect that. This guards
        // against the per-job-badge-stuck-at-queued bug where progress events
        // arrived but the renderer reducer never saw a status update.
        expect(progressParse.data.status).toBe("running");
      }
    } catch (err) {
      const parse = progress
        ? runtimeJobsProgressEventSchema.safeParse(toFrame(progress))
        : undefined;
      dumpEventPayloadSnapshot("full-run-progress-failure", {
        events,
        parse,
        extra: { progress: progress ? toFrame(progress) : null },
      });
      throw err;
    }

    const succeeded = findEvent(events, "runtime.jobs.succeeded");
    try {
      const succeededParse = runtimeJobsSucceededEventSchema.safeParse(
        toFrame(succeeded!)
      );
      expect(succeededParse.success).toBe(true);
      if (succeededParse.success) {
        // succeeded carries a full record, not just `{ jobId }`.
        expect(succeededParse.data.job.jobId).toBe("src1");
        expect(succeededParse.data.job.status).toBe("succeeded");
        // The job's `finishedAt` field is the canonical "when did this end"
        // timestamp; the schema does not require a separate `completedAt` key.
        expect(typeof succeededParse.data.job.finishedAt).toBe("string");
      }
    } catch (err) {
      const parse = succeeded
        ? runtimeJobsSucceededEventSchema.safeParse(toFrame(succeeded))
        : undefined;
      dumpEventPayloadSnapshot("full-run-succeeded-failure", {
        events,
        parse,
        extra: { succeeded: succeeded ? toFrame(succeeded) : null },
      });
      throw err;
    }
  });

  it("emits a failed event with full job record + errorCode/errorMessage when the handler throws", async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:failed] registering probe handler that throws "kaboom"`,
    );
    engine.registerHandler("probe", async () => {
      throw new Error("kaboom");
    });
    for (const kind of ["identify", "extract", "upload", "commit"]) {
      engine.registerHandler(kind, async () => {});
    }

    await engine.submit(makeJob());
    await vi.waitFor(
      () => {
        expect(findEvent(events, "runtime.jobs.failed")).toBeDefined();
      },
      { timeout: 3000 }
    );
    console.info(
      `[jobs-engine-v2-event-payloads:failed] failed event seen; total events=${events.length}`,
    );

    const failed = findEvent(events, "runtime.jobs.failed");
    try {
      const parsed = runtimeJobsFailedEventSchema.safeParse(toFrame(failed!));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.job.jobId).toBe("src1");
        expect(parsed.data.errorCode).toBe("handler-error");
        expect(parsed.data.errorMessage).toContain("kaboom");
      }
    } catch (err) {
      const parse = failed
        ? runtimeJobsFailedEventSchema.safeParse(toFrame(failed))
        : undefined;
      dumpEventPayloadSnapshot("failed-failure", {
        events,
        parse,
        extra: { failed: failed ? toFrame(failed) : null },
      });
      throw err;
    }
  });

  it("emits a cancelled event with full job record + reason on engine.cancel()", async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:cancelled] registering slow probe handler; will race cancel against it`,
    );
    // Slow handler so we can race a cancel against it.
    engine.registerHandler("probe", async ({ signal }) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5_000);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });
    });

    await engine.submit(makeJob());
    // Give the engine a tick to dispatch.
    await vi.waitFor(() => {
      expect(findEvent(events, "runtime.jobs.started")).toBeDefined();
    });
    console.info(
      `[jobs-engine-v2-event-payloads:cancelled] started seen; calling engine.cancel(src1, user-requested)`,
    );

    await engine.cancel("src1", "user-requested");
    await vi.waitFor(() => {
      expect(findEvent(events, "runtime.jobs.cancelled")).toBeDefined();
    });

    const cancelled = findEvent(events, "runtime.jobs.cancelled");
    try {
      const parsed = runtimeJobsCancelledEventSchema.safeParse(toFrame(cancelled!));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.job.jobId).toBe("src1");
        expect(parsed.data.reason).toBe("user-requested");
      }
    } catch (err) {
      const parse = cancelled
        ? runtimeJobsCancelledEventSchema.safeParse(toFrame(cancelled))
        : undefined;
      dumpEventPayloadSnapshot("cancelled-failure", {
        events,
        parse,
        extra: { cancelled: cancelled ? toFrame(cancelled) : null },
      });
      throw err;
    }
  });

  it("emits a dismissed event whose frame parses against runtimeJobsDismissedEventSchema after a terminal job is dismissed", async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:dismissed] running job to completion, then calling engine.dismiss(src1)`,
    );
    for (const kind of SOURCE_STEPS) {
      engine.registerHandler(kind, async () => {});
    }
    await engine.submit(makeJob());
    await vi.waitFor(() => {
      expect(findEvent(events, "runtime.jobs.succeeded")).toBeDefined();
    });

    const before = events.length;
    await engine.dismiss("src1");
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before));
    console.info(
      `[jobs-engine-v2-event-payloads:dismissed] events grew from ${before} to ${events.length} after dismiss`,
    );

    const dismissed = findEvent(events, "runtime.jobs.dismissed");
    try {
      expect(dismissed).toBeDefined();
      const parsed = runtimeJobsDismissedEventSchema.safeParse(toFrame(dismissed!));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.jobId).toBe("src1");
        expect(parsed.data.groupId).toBe("g1");
        expect(typeof parsed.data.dismissedAt).toBe("string");
      }
    } catch (err) {
      const parse = dismissed
        ? runtimeJobsDismissedEventSchema.safeParse(toFrame(dismissed))
        : undefined;
      dumpEventPayloadSnapshot("dismissed-failure", {
        events,
        parse,
        extra: { dismissed: dismissed ? toFrame(dismissed) : null },
      });
      throw err;
    }
  });

  it("assigns monotonically increasing eventId values across emitted events", async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:monotonic-eventid] running job to completion; checking eventId ordering`,
    );
    for (const kind of SOURCE_STEPS) {
      engine.registerHandler(kind, async () => {});
    }
    await engine.submit(makeJob());
    await vi.waitFor(() => {
      expect(findEvent(events, "runtime.jobs.succeeded")).toBeDefined();
    });

    const ids = events.map((e) => e.eventId);
    console.info(
      `[jobs-engine-v2-event-payloads:monotonic-eventid] ids=${JSON.stringify(ids)}`,
    );
    try {
      expect(ids.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }
      // Sanity-check: the union schema accepts every emitted event.
      for (const e of events) {
        const parsed = runtimeJobsEventSchema.safeParse(toFrame(e));
        expect(parsed.success).toBe(true);
      }
    } catch (err) {
      // Find the first failing union parse, if any, to surface the offender.
      let firstBad: { event: string; parse: ReturnType<typeof runtimeJobsEventSchema.safeParse> } | null = null;
      for (const e of events) {
        const parsed = runtimeJobsEventSchema.safeParse(toFrame(e));
        if (!parsed.success) {
          firstBad = { event: e.event, parse: parsed };
          break;
        }
      }
      dumpEventPayloadSnapshot("monotonic-eventid-failure", {
        events,
        parse: firstBad?.parse,
        extra: { ids, firstBadEvent: firstBad?.event ?? null },
      });
      throw err;
    }
  });

  it("throws at the emit boundary when a malformed payload would violate the schema (validateEvents=true)", async () => {
    console.info(
      `[jobs-engine-v2-event-payloads:emit-validates] building engine2 with validateEvents=true; submitting a job with invalid kind`,
    );
    // Build a separate engine where we can corrupt the store seam to force a
    // bad payload. The simplest path: register a handler that triggers the
    // failed-emit branch, then stub the store to return a job missing
    // required fields.
    const engine2 = createEngineV2({
      dbPath: ":memory:",
      progressThrottleMs: 0,
      validateEvents: true,
    });
    await engine2.start();
    const captured: RuntimeJobEvent[] = [];
    const unsub2 = engine2.subscribe((e) => captured.push(e));
    let lastError: unknown = null;

    // Replace the global default error swallow by listening for the throw via
    // a process-level handler. Easier: trigger the failure in a synchronous
    // path. We'll use submit() with a job whose required field is corrupted
    // post-upsert via a direct field override that the schema rejects.
    //
    // The most direct path: submit a job whose `kind` is NOT in the kind
    // enum. The submit emits runtime.jobs.created with `job: <bad>`, which
    // fails schema validation, which throws synchronously inside emit.
    const badJob = makeJob({
      // @ts-expect-error  intentionally invalid
      kind: "definitely-not-a-kind",
    });
    try {
      await engine2.submit(badJob);
    } catch (err) {
      lastError = err;
    }
    console.info(
      `[jobs-engine-v2-event-payloads:emit-validates] lastError.message=${(lastError as Error | null)?.message ?? "(null)"}; captured events=${captured.length}`,
    );

    try {
      expect(lastError).toBeInstanceOf(Error);
      expect((lastError as Error).message).toMatch(
        /failed schema validation/i
      );
    } catch (err) {
      dumpEventPayloadSnapshot("emit-validates-failure", {
        events: captured,
        extra: {
          lastErrorMessage: (lastError as Error | null)?.message ?? null,
          lastErrorType: lastError === null ? "null" : typeof lastError,
        },
      });
      throw err;
    } finally {
      unsub2();
      await engine2.stop();
    }
  });
});
