import { describe, expect, it } from "vitest";
import {
  aggregateGroupStatusFromJobs,
  aggregateJobStatusFromSteps,
  type IngestJobRecord,
  type IngestJobStatus,
  type IngestJobStepRecord,
} from "../src/index";

const SUITE = "runtime-jobs-transitions-aggregate";

const step = (status: IngestJobStatus, ordinal = 0): IngestJobStepRecord => ({
  stepId: `step-${ordinal}`,
  jobId: "job-1",
  ordinal,
  kind: "test",
  status,
  progressPct: 0,
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
});

const ingestJob = (status: IngestJobStatus, jobId = "j1"): IngestJobRecord =>
  ({
    jobId,
    app: "badger",
    kind: "source",
    lane: "source",
    status,
    stageCode: "",
    stageLabel: "",
    progress: { mode: "none", completed: null, total: null, unit: null },
    payload: {},
    outputs: {},
    errorCode: null,
    errorMessage: null,
    retryable: false,
    cancelRequested: false,
    priority: 0,
    dedupeKey: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    finishedAt: null,
    groupId: "g1",
    mediaId: "m1",
    variant: null,
    parentJobIds: [],
    dismissedAt: null,
    uploadSpeedBytesPerSec: null,
    progressPct: 0,
  }) as IngestJobRecord;

type AggregateMode = "steps" | "groupJobs";

const dumpAggregateSnapshot = (
  label: string,
  ctx: {
    mode: AggregateMode;
    input: Array<IngestJobStepRecord | IngestJobRecord>;
    expected: string;
    observed: string | unknown;
    inputSummary?: Array<{ id: string; status: IngestJobStatus; ordinal?: number }>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`mode: ${ctx.mode}`);
    console.error(`input length: ${ctx.input.length}`);
    if (ctx.inputSummary) {
      console.error(`input summary:\n${JSON.stringify(ctx.inputSummary, null, 2)}`);
    } else {
      console.error(`input:\n${JSON.stringify(ctx.input, null, 2)}`);
    }
    console.error(`expected: ${ctx.expected}`);
    console.error(`observed: ${JSON.stringify(ctx.observed)}`);
    const validation = ctx.observed === ctx.expected ? "valid" : "INVALID — mismatch";
    console.error(`validation: ${validation}`);
    if (ctx.extra) console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const summarizeSteps = (steps: IngestJobStepRecord[]) =>
  steps.map((s) => ({ id: s.stepId, status: s.status, ordinal: s.ordinal }));

const summarizeJobs = (jobs: IngestJobRecord[]) =>
  jobs.map((j) => ({ id: j.jobId, status: j.status }));

const runSteps = (label: string, steps: IngestJobStepRecord[], expected: IngestJobStatus) => {
  console.info(
    `[${SUITE}:${label}] aggregating ${steps.length} step(s) [${steps.map((s) => s.status).join(",")}] expected=${expected}`,
  );
  const observed = aggregateJobStatusFromSteps(steps);
  try {
    expect(observed).toBe(expected);
    console.info(`[${SUITE}:${label}] OK observed=${observed}`);
  } catch (err) {
    dumpAggregateSnapshot(`${label}-failure`, {
      mode: "steps",
      input: steps,
      inputSummary: summarizeSteps(steps),
      expected,
      observed,
    });
    throw err;
  }
};

const runGroupJobs = (label: string, jobs: IngestJobRecord[], expected: IngestJobStatus) => {
  console.info(
    `[${SUITE}:${label}] aggregating ${jobs.length} job(s) [${jobs.map((j) => j.status).join(",")}] expected=${expected}`,
  );
  const observed = aggregateGroupStatusFromJobs(jobs);
  try {
    expect(observed).toBe(expected);
    console.info(`[${SUITE}:${label}] OK observed=${observed}`);
  } catch (err) {
    dumpAggregateSnapshot(`${label}-failure`, {
      mode: "groupJobs",
      input: jobs,
      inputSummary: summarizeJobs(jobs),
      expected,
      observed,
    });
    throw err;
  }
};

describe("aggregateJobStatusFromSteps", () => {
  it("returns queued for empty step list", () => {
    runSteps("empty-steps", [], "queued");
  });

  it("returns running when any step is running", () => {
    runSteps(
      "any-running",
      [step("succeeded", 0), step("running", 1), step("queued", 2)],
      "running",
    );
  });

  it("returns succeeded only when every step succeeded", () => {
    runSteps(
      "all-succeeded",
      [step("succeeded", 0), step("succeeded", 1)],
      "succeeded",
    );
  });

  it("returns failed when any step failed and none running", () => {
    runSteps(
      "any-failed-no-running",
      [step("succeeded", 0), step("failed", 1), step("queued", 2)],
      "failed",
    );
  });

  it("prefers running over a failed sibling (running wins precedence)", () => {
    runSteps(
      "running-over-failed",
      [step("failed", 0), step("running", 1)],
      "running",
    );
  });

  it("returns cancelled when all steps cancelled", () => {
    runSteps(
      "all-cancelled",
      [step("cancelled", 0), step("cancelled", 1)],
      "cancelled",
    );
  });

  it("returns cancelled when some cancelled and rest non-failed/non-running", () => {
    runSteps(
      "cancelled-with-queued",
      [step("cancelled", 0), step("queued", 1)],
      "cancelled",
    );
  });

  it("returns interrupted when any step interrupted with no running/failed", () => {
    runSteps(
      "any-interrupted",
      [step("interrupted", 0), step("queued", 1)],
      "interrupted",
    );
  });

  it("returns queued when all steps are queued", () => {
    runSteps(
      "all-queued",
      [step("queued", 0), step("queued", 1)],
      "queued",
    );
  });
});

describe("aggregateGroupStatusFromJobs", () => {
  it("applies the same rules at the group level", () => {
    runGroupJobs("group-empty", [], "queued");
    runGroupJobs(
      "group-running",
      [ingestJob("succeeded", "a"), ingestJob("running", "b")],
      "running",
    );
    runGroupJobs(
      "group-all-succeeded",
      [ingestJob("succeeded", "a"), ingestJob("succeeded", "b")],
      "succeeded",
    );
    runGroupJobs(
      "group-any-failed",
      [ingestJob("succeeded", "a"), ingestJob("failed", "b")],
      "failed",
    );
    runGroupJobs(
      "group-all-cancelled",
      [ingestJob("cancelled", "a"), ingestJob("cancelled", "b")],
      "cancelled",
    );
    runGroupJobs(
      "group-cancelled-with-queued",
      [ingestJob("cancelled", "a"), ingestJob("queued", "b")],
      "cancelled",
    );
    runGroupJobs(
      "group-interrupted",
      [ingestJob("interrupted", "a"), ingestJob("queued", "b")],
      "interrupted",
    );
  });
});
