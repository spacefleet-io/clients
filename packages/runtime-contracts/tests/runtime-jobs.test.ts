import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ingestJobKindSchema,
  ingestJobLaneSchema,
  ingestJobRecordSchema,
  ingestJobStatusSchema,
  ingestJobStepRecordSchema,
  runtimeJobsCancelCommand,
  runtimeJobsCancelledEventSchema,
  runtimeJobsCreatedEventSchema,
  runtimeJobsDismissCommand,
  runtimeJobsDismissedEventSchema,
  runtimeJobsEventSchema,
  runtimeJobsFailedEventSchema,
  runtimeJobsGetCommand,
  runtimeJobsListCommand,
  runtimeJobsProgressEventSchema,
  runtimeJobsRetryCommand,
  runtimeJobsStartedEventSchema,
  runtimeJobsSubscribeHandshakeSchema,
  runtimeJobsSucceededEventSchema,
} from "../src/runtime/jobs";

const SUITE = "runtime-jobs";

const baseJob = {
  jobId: "job-1",
  app: "badger" as const,
  kind: "source" as const,
  lane: "source" as const,
  status: "running" as const,
  stageCode: "extracting",
  stageLabel: "Extracting tracks",
  progress: { mode: "fraction" as const, completed: 5, total: 10, unit: "items" as const },
  payload: { filename: "movie.mkv" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:01Z",
  startedAt: "2026-05-01T00:00:00.5Z",
  finishedAt: null,
  groupId: "media-1",
  mediaId: "media-1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 50,
};

const summarizeJob = (job: typeof baseJob | Record<string, unknown>) => ({
  jobId: (job as { jobId?: unknown }).jobId,
  status: (job as { status?: unknown }).status,
  kind: (job as { kind?: unknown }).kind,
  lane: (job as { lane?: unknown }).lane,
  progressPct: (job as { progressPct?: unknown }).progressPct,
  groupId: (job as { groupId?: unknown }).groupId,
});

const dumpRuntimeJobsSnapshot = (
  label: string,
  ctx: {
    schemaName: string;
    input: unknown;
    safeParse?: z.ZodSafeParseResult<unknown>;
    parsed?: unknown;
    note?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    console.error(`schema under test: ${ctx.schemaName}`);
    const inputIsObj = ctx.input && typeof ctx.input === "object";
    if (inputIsObj) {
      const asJob = ctx.input as Record<string, unknown>;
      console.error(
        `job event shape:\n${JSON.stringify(
          {
            keys: Object.keys(asJob),
            event: asJob.event,
            jobSummary: asJob.job
              ? summarizeJob(asJob.job as Record<string, unknown>)
              : undefined,
          },
          null,
          2,
        )}`,
      );
      if (asJob.status !== undefined || asJob.progressPct !== undefined) {
        console.error(
          `job state:\n${JSON.stringify(summarizeJob(asJob), null, 2)}`,
        );
      }
    }
    console.error(`raw input:\n${JSON.stringify(ctx.input, null, 2)}`);
    if (ctx.safeParse !== undefined) {
      console.error(
        `parse result:\n${JSON.stringify(
          {
            success: ctx.safeParse.success,
            data: ctx.safeParse.success ? ctx.safeParse.data : undefined,
            issues: ctx.safeParse.success ? null : ctx.safeParse.error.issues,
          },
          null,
          2,
        )}`,
      );
    }
    if (ctx.parsed !== undefined) {
      console.error(`parsed value:\n${JSON.stringify(ctx.parsed, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("ingest enum schemas", () => {
  console.info(
    `[${SUITE}:setup] baseJob.jobId=${baseJob.jobId} status=${baseJob.status} kind=${baseJob.kind} lane=${baseJob.lane}`,
  );

  it("accepts every valid ingest job status", () => {
    const statuses = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ];
    for (const s of statuses) {
      const result = ingestJobStatusSchema.safeParse(s);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpRuntimeJobsSnapshot("status-enum-missing", {
          schemaName: "ingestJobStatusSchema",
          input: s,
          safeParse: result,
          extra: { allTested: statuses },
        });
        throw err;
      }
    }
  });

  it("rejects unknown status", () => {
    const result = ingestJobStatusSchema.safeParse("paused");
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("status-unknown-accepted", {
        schemaName: "ingestJobStatusSchema",
        input: "paused",
        safeParse: result,
      });
      throw err;
    }
  });

  it("accepts source/format kinds and source/format/upload lanes", () => {
    const sourceKind = ingestJobKindSchema.safeParse("source");
    const formatKind = ingestJobKindSchema.safeParse("format");
    const transcodeKind = ingestJobKindSchema.safeParse("transcode");
    const uploadLane = ingestJobLaneSchema.safeParse("upload");
    const networkLane = ingestJobLaneSchema.safeParse("network");
    try {
      expect(sourceKind.success).toBe(true);
      expect(formatKind.success).toBe(true);
      expect(transcodeKind.success).toBe(false);
      expect(uploadLane.success).toBe(true);
      expect(networkLane.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("kind-lane-enum-drift", {
        schemaName: "ingestJobKindSchema / ingestJobLaneSchema",
        input: {
          kinds: ["source", "format", "transcode"],
          lanes: ["upload", "network"],
        },
        safeParse: networkLane,
        extra: {
          sourceKindOk: sourceKind.success,
          formatKindOk: formatKind.success,
          transcodeKindOk: transcodeKind.success,
          uploadLaneOk: uploadLane.success,
          networkLaneOk: networkLane.success,
        },
      });
      throw err;
    }
  });
});

describe("ingestJobRecordSchema", () => {
  it("round-trip-parses a minimal source job", () => {
    try {
      const parsed = ingestJobRecordSchema.parse(baseJob);
      expect(parsed.jobId).toBe("job-1");
      expect(parsed.kind).toBe("source");
      expect(parsed.progressPct).toBe(50);
    } catch (err) {
      dumpRuntimeJobsSnapshot("source-job-round-trip-failed", {
        schemaName: "ingestJobRecordSchema",
        input: baseJob,
        safeParse: ingestJobRecordSchema.safeParse(baseJob),
      });
      throw err;
    }
  });

  it("rejects progressPct out of [0,100]", () => {
    const high = { ...baseJob, progressPct: 150 };
    const low = { ...baseJob, progressPct: -1 };
    const highResult = ingestJobRecordSchema.safeParse(high);
    const lowResult = ingestJobRecordSchema.safeParse(low);
    try {
      expect(highResult.success).toBe(false);
      expect(lowResult.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("progress-pct-bounds-drift", {
        schemaName: "ingestJobRecordSchema",
        input: { high, low },
        safeParse: highResult.success ? highResult : lowResult,
        extra: {
          highOk: highResult.success,
          lowOk: lowResult.success,
        },
        note: "progressPct must be in [0,100]",
      });
      throw err;
    }
  });

  it("rejects unknown status on record", () => {
    const input = { ...baseJob, status: "paused" };
    const result = ingestJobRecordSchema.safeParse(input);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("record-unknown-status-accepted", {
        schemaName: "ingestJobRecordSchema",
        input,
        safeParse: result,
      });
      throw err;
    }
  });

  it("requires the ingest extension fields", () => {
    const { groupId: _, ...withoutGroupId } = baseJob;
    void _;
    const result = ingestJobRecordSchema.safeParse(withoutGroupId);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("ingest-extension-missing-accepted", {
        schemaName: "ingestJobRecordSchema",
        input: withoutGroupId,
        safeParse: result,
        note: "groupId is a required ingest extension field",
      });
      throw err;
    }
  });
});

describe("ingestJobStepRecordSchema", () => {
  it("round-trip-parses a step", () => {
    const step = {
      stepId: "step-1",
      jobId: "job-1",
      ordinal: 0,
      kind: "probe",
      status: "succeeded" as const,
      progressPct: 100,
      errorCode: null,
      errorMessage: null,
      startedAt: "2026-05-01T00:00:00Z",
      finishedAt: "2026-05-01T00:00:01Z",
    };
    try {
      expect(ingestJobStepRecordSchema.parse(step).stepId).toBe("step-1");
    } catch (err) {
      dumpRuntimeJobsSnapshot("step-round-trip-failed", {
        schemaName: "ingestJobStepRecordSchema",
        input: step,
        safeParse: ingestJobStepRecordSchema.safeParse(step),
      });
      throw err;
    }
  });

  it("rejects negative ordinal", () => {
    const step = {
      stepId: "step-1",
      jobId: "job-1",
      ordinal: -1,
      kind: "probe",
      status: "queued",
      progressPct: 0,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
    };
    const result = ingestJobStepRecordSchema.safeParse(step);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("step-negative-ordinal-accepted", {
        schemaName: "ingestJobStepRecordSchema",
        input: step,
        safeParse: result,
      });
      throw err;
    }
  });
});

describe("event schemas", () => {
  const env = { eventId: 42, emittedAt: "2026-05-01T00:00:00Z" };

  console.info(
    `[${SUITE}:event-setup] envelope=${JSON.stringify(env)}`,
  );

  it("created event round-trips through the discriminated union", () => {
    const evt = { ...env, event: "runtime.jobs.created" as const, job: baseJob };
    try {
      expect(runtimeJobsCreatedEventSchema.parse(evt).job.jobId).toBe("job-1");
      expect(runtimeJobsEventSchema.parse(evt).event).toBe("runtime.jobs.created");
    } catch (err) {
      dumpRuntimeJobsSnapshot("created-event-union-failed", {
        schemaName: "runtimeJobsCreatedEventSchema / runtimeJobsEventSchema",
        input: evt,
        safeParse: runtimeJobsEventSchema.safeParse(evt),
      });
      throw err;
    }
  });

  it("started event accepts source variant=null", () => {
    const evt = {
      ...env,
      event: "runtime.jobs.started" as const,
      jobId: "job-1",
      groupId: "media-1",
      kind: "source" as const,
      variant: null,
      startedAt: "2026-05-01T00:00:00Z",
    };
    try {
      expect(runtimeJobsStartedEventSchema.parse(evt).variant).toBeNull();
    } catch (err) {
      dumpRuntimeJobsSnapshot("started-source-null-variant-rejected", {
        schemaName: "runtimeJobsStartedEventSchema",
        input: evt,
        safeParse: runtimeJobsStartedEventSchema.safeParse(evt),
        note: "source jobs may have null variant",
      });
      throw err;
    }
  });

  it("progress event rejects progressPct > 100", () => {
    const evt = {
      ...env,
      event: "runtime.jobs.progress",
      jobId: "job-1",
      groupId: "media-1",
      progressPct: 150,
      stageCode: "uploading",
      stageLabel: "Uploading",
      uploadSpeedBytesPerSec: 1000,
    };
    const result = runtimeJobsProgressEventSchema.safeParse(evt);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("progress-over-100-accepted", {
        schemaName: "runtimeJobsProgressEventSchema",
        input: evt,
        safeParse: result,
      });
      throw err;
    }
  });

  it("progress event accepts an optional `status` field (round 7)", () => {
    const evt = {
      ...env,
      event: "runtime.jobs.progress" as const,
      jobId: "job-1",
      groupId: "media-1",
      progressPct: 42,
      stageCode: "uploading",
      stageLabel: "Uploading",
      uploadSpeedBytesPerSec: 1000,
      status: "running" as const,
    };
    try {
      const parsed = runtimeJobsProgressEventSchema.parse(evt);
      expect(parsed.status).toBe("running");
    } catch (err) {
      dumpRuntimeJobsSnapshot("progress-with-status-rejected", {
        schemaName: "runtimeJobsProgressEventSchema",
        input: evt,
        safeParse: runtimeJobsProgressEventSchema.safeParse(evt),
        note: "Round 7 added optional `status` to progress events",
      });
      throw err;
    }
  });

  it("progress event still parses without `status` (back-compat with replayed pre-round-7 events)", () => {
    const evt = {
      ...env,
      event: "runtime.jobs.progress" as const,
      jobId: "job-1",
      groupId: "media-1",
      progressPct: 42,
      stageCode: "uploading",
      stageLabel: "Uploading",
      uploadSpeedBytesPerSec: 1000,
    };
    try {
      const parsed = runtimeJobsProgressEventSchema.parse(evt);
      expect(parsed.status).toBeUndefined();
    } catch (err) {
      dumpRuntimeJobsSnapshot("progress-without-status-backcompat-broken", {
        schemaName: "runtimeJobsProgressEventSchema",
        input: evt,
        safeParse: runtimeJobsProgressEventSchema.safeParse(evt),
        note: "Pre-round-7 progress events lacked `status` — must still parse",
      });
      throw err;
    }
  });

  it("progress event rejects an unknown status string", () => {
    const evt = {
      ...env,
      event: "runtime.jobs.progress" as const,
      jobId: "job-1",
      groupId: "media-1",
      progressPct: 42,
      stageCode: "uploading",
      stageLabel: "Uploading",
      uploadSpeedBytesPerSec: 1000,
      status: "paused",
    };
    const result = runtimeJobsProgressEventSchema.safeParse(evt);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("progress-unknown-status-accepted", {
        schemaName: "runtimeJobsProgressEventSchema",
        input: evt,
        safeParse: result,
      });
      throw err;
    }
  });

  it("succeeded/failed/cancelled events parse with required fields", () => {
    const succ = { ...env, event: "runtime.jobs.succeeded" as const, job: baseJob };
    const fail = {
      ...env,
      event: "runtime.jobs.failed" as const,
      job: baseJob,
      errorCode: "upload_quota_exceeded",
      errorMessage: "Quota hit",
    };
    const canc = {
      ...env,
      event: "runtime.jobs.cancelled" as const,
      job: baseJob,
      reason: "user-requested",
    };
    try {
      expect(runtimeJobsSucceededEventSchema.parse(succ).job.jobId).toBe("job-1");
      expect(runtimeJobsFailedEventSchema.parse(fail).errorCode).toBe(
        "upload_quota_exceeded",
      );
      expect(runtimeJobsCancelledEventSchema.parse(canc).reason).toBe(
        "user-requested",
      );
    } catch (err) {
      dumpRuntimeJobsSnapshot("terminal-event-parse-failed", {
        schemaName:
          "runtimeJobsSucceededEventSchema / runtimeJobsFailedEventSchema / runtimeJobsCancelledEventSchema",
        input: { succ, fail, canc },
        extra: {
          succResult: runtimeJobsSucceededEventSchema.safeParse(succ),
          failResult: runtimeJobsFailedEventSchema.safeParse(fail),
          cancResult: runtimeJobsCancelledEventSchema.safeParse(canc),
        },
      });
      throw err;
    }
  });

  it("dismissed event has no full job payload", () => {
    const evt = {
      ...env,
      event: "runtime.jobs.dismissed" as const,
      jobId: "job-1",
      groupId: "media-1",
      dismissedAt: "2026-05-01T00:00:05Z",
    };
    try {
      expect(runtimeJobsDismissedEventSchema.parse(evt).jobId).toBe("job-1");
    } catch (err) {
      dumpRuntimeJobsSnapshot("dismissed-event-rejected", {
        schemaName: "runtimeJobsDismissedEventSchema",
        input: evt,
        safeParse: runtimeJobsDismissedEventSchema.safeParse(evt),
      });
      throw err;
    }
  });

  it("discriminated union rejects unknown event tag", () => {
    const input = {
      ...env,
      event: "runtime.jobs.unknown",
      jobId: "x",
      groupId: "y",
    };
    const result = runtimeJobsEventSchema.safeParse(input);
    try {
      expect(result.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("union-unknown-tag-accepted", {
        schemaName: "runtimeJobsEventSchema",
        input,
        safeParse: result,
      });
      throw err;
    }
  });
});

describe("commands", () => {
  it("runtime.jobs.list accepts an empty payload and a full filter", () => {
    const fullFilter = {
      filter: {
        app: "badger",
        mediaId: "m1",
        status: ["queued", "running"],
        kind: "format",
        lane: "format",
        includeDismissed: false,
      },
    };
    try {
      expect(runtimeJobsListCommand.payloadSchema.parse({}).filter).toBeUndefined();
      const parsed = runtimeJobsListCommand.payloadSchema.parse(fullFilter);
      expect(parsed.filter?.status).toEqual(["queued", "running"]);
    } catch (err) {
      dumpRuntimeJobsSnapshot("list-payload-failed", {
        schemaName: "runtimeJobsListCommand.payloadSchema",
        input: fullFilter,
        safeParse: runtimeJobsListCommand.payloadSchema.safeParse(fullFilter),
      });
      throw err;
    }
  });

  it("runtime.jobs.list result includes jobs and maxEventId", () => {
    const input = { jobs: [baseJob], maxEventId: 99 };
    try {
      const r = runtimeJobsListCommand.resultSchema.parse(input);
      expect(r.maxEventId).toBe(99);
      expect(r.jobs).toHaveLength(1);
    } catch (err) {
      dumpRuntimeJobsSnapshot("list-result-failed", {
        schemaName: "runtimeJobsListCommand.resultSchema",
        input,
        safeParse: runtimeJobsListCommand.resultSchema.safeParse(input),
      });
      throw err;
    }
  });

  it("runtime.jobs.get parses payload and result", () => {
    const payload = { jobId: "j1" };
    const resultInput = { job: baseJob, steps: [] };
    try {
      expect(runtimeJobsGetCommand.payloadSchema.parse(payload).jobId).toBe("j1");
      expect(
        runtimeJobsGetCommand.resultSchema.parse(resultInput).steps,
      ).toEqual([]);
    } catch (err) {
      dumpRuntimeJobsSnapshot("get-failed", {
        schemaName: "runtimeJobsGetCommand",
        input: { payload, resultInput },
        extra: {
          payloadResult: runtimeJobsGetCommand.payloadSchema.safeParse(payload),
          resultResult:
            runtimeJobsGetCommand.resultSchema.safeParse(resultInput),
        },
      });
      throw err;
    }
  });

  it("runtime.jobs.cancel accepts optional reason", () => {
    const payload = { jobId: "j1" };
    const resultInput = { cancelled: true };
    try {
      expect(
        runtimeJobsCancelCommand.payloadSchema.parse(payload).reason,
      ).toBeUndefined();
      expect(
        runtimeJobsCancelCommand.resultSchema.parse(resultInput).cancelled,
      ).toBe(true);
    } catch (err) {
      dumpRuntimeJobsSnapshot("cancel-failed", {
        schemaName: "runtimeJobsCancelCommand",
        input: { payload, resultInput },
        extra: {
          payloadResult:
            runtimeJobsCancelCommand.payloadSchema.safeParse(payload),
          resultResult:
            runtimeJobsCancelCommand.resultSchema.safeParse(resultInput),
        },
      });
      throw err;
    }
  });

  it("runtime.jobs.dismiss result distinguishes terminal-vs-not-terminal", () => {
    const yes = { dismissed: true };
    const noTerminal = { dismissed: false, errorCode: "not-terminal" };
    const noBad = { dismissed: false, errorCode: "something-else" };
    try {
      expect(runtimeJobsDismissCommand.resultSchema.parse(yes)).toEqual({
        dismissed: true,
      });
      expect(runtimeJobsDismissCommand.resultSchema.parse(noTerminal)).toEqual({
        dismissed: false,
        errorCode: "not-terminal",
      });
      expect(
        runtimeJobsDismissCommand.resultSchema.safeParse(noBad).success,
      ).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("dismiss-discriminated-result-drift", {
        schemaName: "runtimeJobsDismissCommand.resultSchema",
        input: { yes, noTerminal, noBad },
        extra: {
          yesResult: runtimeJobsDismissCommand.resultSchema.safeParse(yes),
          noTerminalResult:
            runtimeJobsDismissCommand.resultSchema.safeParse(noTerminal),
          noBadResult: runtimeJobsDismissCommand.resultSchema.safeParse(noBad),
        },
        note: "errorCode must be literal 'not-terminal' when dismissed=false",
      });
      throw err;
    }
  });

  it("runtime.jobs.retry result optionally returns newJobId", () => {
    const withId = { retried: true, newJobId: "j2" };
    const without = { retried: false };
    try {
      expect(runtimeJobsRetryCommand.resultSchema.parse(withId).newJobId).toBe(
        "j2",
      );
      expect(runtimeJobsRetryCommand.resultSchema.parse(without).retried).toBe(
        false,
      );
    } catch (err) {
      dumpRuntimeJobsSnapshot("retry-newJobId-drift", {
        schemaName: "runtimeJobsRetryCommand.resultSchema",
        input: { withId, without },
        extra: {
          withIdResult:
            runtimeJobsRetryCommand.resultSchema.safeParse(withId),
          withoutResult:
            runtimeJobsRetryCommand.resultSchema.safeParse(without),
        },
      });
      throw err;
    }
  });

  it("rejects empty jobId in command payloads", () => {
    const getEmpty = { jobId: "" };
    const cancelEmpty = { jobId: "" };
    const getResult = runtimeJobsGetCommand.payloadSchema.safeParse(getEmpty);
    const cancelResult =
      runtimeJobsCancelCommand.payloadSchema.safeParse(cancelEmpty);
    try {
      expect(getResult.success).toBe(false);
      expect(cancelResult.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("empty-jobId-accepted", {
        schemaName: "runtimeJobsGetCommand / runtimeJobsCancelCommand",
        input: { getEmpty, cancelEmpty },
        extra: { getResult, cancelResult },
      });
      throw err;
    }
  });
});

describe("subscribe handshake", () => {
  it("request accepts optional lastEventId; rejects negative", () => {
    const emptyRequest = {};
    const validRequest = { lastEventId: 50 };
    const negRequest = { lastEventId: -1 };
    const negResult =
      runtimeJobsSubscribeHandshakeSchema.requestSchema.safeParse(negRequest);
    try {
      expect(
        runtimeJobsSubscribeHandshakeSchema.requestSchema.parse(emptyRequest)
          .lastEventId,
      ).toBeUndefined();
      expect(
        runtimeJobsSubscribeHandshakeSchema.requestSchema.parse(validRequest)
          .lastEventId,
      ).toBe(50);
      expect(negResult.success).toBe(false);
    } catch (err) {
      dumpRuntimeJobsSnapshot("subscribe-request-failed", {
        schemaName: "runtimeJobsSubscribeHandshakeSchema.requestSchema",
        input: { emptyRequest, validRequest, negRequest },
        safeParse: negResult,
        extra: {
          emptyResult:
            runtimeJobsSubscribeHandshakeSchema.requestSchema.safeParse(
              emptyRequest,
            ),
          validResult:
            runtimeJobsSubscribeHandshakeSchema.requestSchema.safeParse(
              validRequest,
            ),
        },
      });
      throw err;
    }
  });

  it("response signals replay overflow", () => {
    const input = { replayed: true, replayOverflow: true, maxEventId: 6000 };
    try {
      const r = runtimeJobsSubscribeHandshakeSchema.responseSchema.parse(input);
      expect(r.replayOverflow).toBe(true);
      expect(r.maxEventId).toBe(6000);
    } catch (err) {
      dumpRuntimeJobsSnapshot("subscribe-response-overflow-rejected", {
        schemaName: "runtimeJobsSubscribeHandshakeSchema.responseSchema",
        input,
        safeParse:
          runtimeJobsSubscribeHandshakeSchema.responseSchema.safeParse(input),
      });
      throw err;
    }
  });
});
