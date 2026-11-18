/**
 * Tests for the Phase 7 `retranscode` step handler.
 *
 * Coverage:
 *   - happy path: handler reads payload, calls deps.retranscodeFormat with
 *     mapped fields, emits the canonical transcodeResult shape so the
 *     downstream upload step doesn't need a separate code path.
 *   - missing payload fields fail loud with the documented error codes
 *   - missing retranscodeFormat dep fails with STEP_RETRANSCODE_DEP_MISSING
 *   - cancel-before-call returns CANCELLED
 *   - cancel-after-call returns CANCELLED (and the result is dropped)
 *   - progress events: only the "transcoding" stage flips the badge
 *   - engine seed picks the retranscode step chain when
 *     payload.retranscode === true
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retranscodeStepHandler } from "../src/modules/badger/steps";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
  type ProbeResult,
  type IdentifyResult,
  type RetranscodeResult,
  type UploadResult,
  type CommitResult,
} from "../src/modules/badger/steps/deps";
import type { StepHandlerCtx } from "../src/core/jobs/engineV2";
import { createEngineV2 } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";

const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "job-retrans-1",
  app: "badger",
  kind: "format",
  lane: "format",
  status: "running",
  stageCode: "running",
  stageLabel: "Running",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: {
    userId: "user-1",
    fileId: "file-1",
    targetVariant: "720p",
    sourceFormatId: "fmt-1080",
    sourceVariant: "1080p",
    retranscode: true,
    mediaId: "media-1",
  },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 20,
  dedupeKey: null,
  createdAt: ts,
  updatedAt: ts,
  startedAt: ts,
  finishedAt: null,
  groupId: "replan:media-1:file-1:720p",
  mediaId: "media-1",
  variant: "720p",
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

const makeStep = (): StoredStepRecord => ({
  stepId: "job-retrans-1:retranscode",
  jobId: "job-retrans-1",
  ordinal: 0,
  kind: "retranscode",
  status: "running",
  progressPct: 0,
  errorCode: null,
  errorMessage: null,
  startedAt: ts,
  finishedAt: null,
  app: "badger",
  lane: "format",
  dependsOn: [],
  payload: {},
  outputs: {},
  createdAt: ts,
  updatedAt: ts,
});

const makeCtx = (
  job: IngestJobRecord,
  step: StoredStepRecord,
  signal: AbortSignal = new AbortController().signal
): StepHandlerCtx & {
  recorded: {
    progress: Array<[number, string?, string?]>;
    outputs: Array<Record<string, unknown>>;
  };
} => {
  const recorded = {
    progress: [] as Array<[number, string?, string?]>,
    outputs: [] as Array<Record<string, unknown>>,
  };
  return {
    job,
    step,
    signal,
    reportProgress: (pct, label, stage) => {
      recorded.progress.push([pct, label, stage]);
    },
    emitOutputs: (out) => {
      recorded.outputs.push(out);
    },
    recorded,
  } as StepHandlerCtx & {
    recorded: {
      progress: Array<[number, string?, string?]>;
      outputs: Array<Record<string, unknown>>;
    };
  };
};

const baseRetranscodeResult = (): RetranscodeResult => ({
  jobDir: "/tmp/jobs/job-retrans-1",
  state: {
    version: 1,
    inputPath: "/tmp/jobs/job-retrans-1/retranscode-staging/concat.txt",
    userId: "user-1",
    createdAt: ts,
    outputs: [],
    subtitles: [],
  },
  segmentCount: 5,
  variant: "720p",
});

const makeMinimalDeps = (
  retranscode: BadgerStepDeps["retranscodeFormat"]
): BadgerStepDeps => ({
  probe: vi.fn(async (): Promise<ProbeResult> => ({
    durationSeconds: 60,
    videoCodec: "h264",
    videoWidth: 1920,
    videoHeight: 1080,
    sourceQuality: "1080p",
    audioStreamCount: 1,
    subtitleStreamCount: 0,
    streams: [],
    chapters: [],
  })),
  identify: vi.fn(
    async (): Promise<IdentifyResult> => ({
      mediaId: null,
      parsedTitle: "x",
      year: null,
      season: null,
      episode: null,
      preexistingHint: false,
    })
  ),
  extractSource: vi.fn(async () => {
    throw new Error("not called");
  }),
  transcodeFormat: vi.fn(async () => {
    throw new Error("not called");
  }),
  retranscodeFormat: retranscode,
  uploadOutputs: vi.fn(async (): Promise<UploadResult> => {
    throw new Error("not called");
  }),
  commit: vi.fn(async (): Promise<CommitResult> => {
    throw new Error("not called");
  }),
});

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps job/step payload, recorded progress &
// outputs, plus retranscodeFormat mock call args on assertion failure. Wrapped
// in try/catch so a dump-failure can never mask the original assertion.
// ---------------------------------------------------------------------------
const dumpRetranscodeStepSnapshot = (
  label: string,
  ctx: {
    job?: IngestJobRecord;
    step?: StoredStepRecord;
    recorded?: {
      progress: Array<[number, string?, string?]>;
      outputs: Array<Record<string, unknown>>;
    };
    retranscodeFormat?: ReturnType<typeof vi.fn>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-retranscode-step:${label}] snapshot ===`);
    if (ctx.job) {
      console.error(
        `job: id=${ctx.job.jobId} kind=${ctx.job.kind} variant=${ctx.job.variant} status=${ctx.job.status}`,
      );
      console.error(`job.payload=\n${JSON.stringify(ctx.job.payload, null, 2)}`);
    }
    if (ctx.step) {
      console.error(
        `step: id=${ctx.step.stepId} kind=${ctx.step.kind} status=${ctx.step.status}`,
      );
    }
    if (ctx.recorded) {
      console.error(
        `recorded.progress (${ctx.recorded.progress.length} events)=\n${JSON.stringify(ctx.recorded.progress, null, 2)}`,
      );
      console.error(
        `recorded.outputs (${ctx.recorded.outputs.length} emits)=\n${JSON.stringify(ctx.recorded.outputs, null, 2)}`,
      );
    }
    if (ctx.retranscodeFormat) {
      console.error(
        `retranscodeFormat.calls=${JSON.stringify(ctx.retranscodeFormat.mock?.calls ?? "(not-a-vi-fn)", null, 2)}`,
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

describe("retranscode step handler", () => {
  beforeEach(() => {
    console.info(`[badger-retranscode-step:setup] resetting badger step deps`);
    __resetBadgerStepDeps();
  });
  afterEach(() => {
    console.info(
      `[badger-retranscode-step:teardown] resetting badger step deps`,
    );
    __resetBadgerStepDeps();
  });

  it("calls deps.retranscodeFormat with mapped payload + emits canonical transcodeResult outputs", async () => {
    console.info(
      `[badger-retranscode-step:happy-path] configuring deps + running handler`,
    );
    const retranscodeFormat = vi.fn(async (input) => {
      expect(input.userId).toBe("user-1");
      expect(input.fileId).toBe("file-1");
      expect(input.targetVariant).toBe("720p");
      expect(input.sourceFormatId).toBe("fmt-1080");
      expect(input.sourceVariant).toBe("1080p");
      expect(input.jobId).toBe("job-retrans-1");
      expect(input.mediaId).toBe("media-1");
      return baseRetranscodeResult();
    });
    configureBadgerStepDeps(makeMinimalDeps(retranscodeFormat));

    const job = makeJob();
    const step = makeStep();
    const ctx = makeCtx(job, step);
    await retranscodeStepHandler(ctx);
    console.info(
      `[badger-retranscode-step:happy-path] handler complete; retranscodeFormat called ${retranscodeFormat.mock.calls.length}x; outputs=${ctx.recorded.outputs.length} progress=${ctx.recorded.progress.length}`,
    );

    try {
      expect(retranscodeFormat).toHaveBeenCalledTimes(1);
      // Output shape mirrors transcode's so the existing upload step can read it
      // without a separate code path.
      expect(ctx.recorded.outputs).toEqual([
        {
          transcodeResult: {
            variant: "720p",
            jobDir: "/tmp/jobs/job-retrans-1",
            segmentCount: 5,
          },
        },
      ]);
      // Progress emits start at 1% (transcoding) and finish at 100%.
      expect(ctx.recorded.progress[0]).toEqual([1, "Re-transcoding 720p", "transcoding"]);
      expect(ctx.recorded.progress[ctx.recorded.progress.length - 1]).toEqual([
        100,
        "Re-transcoded 720p",
        "transcoding",
      ]);
    } catch (err) {
      dumpRetranscodeStepSnapshot("happy-path-failure", {
        job,
        step,
        recorded: ctx.recorded,
        retranscodeFormat,
      });
      throw err;
    }
  });

  it("forwards transcoding-stage progress from the dep to the engine", async () => {
    console.info(
      `[badger-retranscode-step:forward-progress] dep emits 3 onProgress events (transcoding/uploading/transcoding)`,
    );
    const retranscodeFormat = vi.fn(async (input) => {
      input.onProgress?.("transcoding", 50);
      input.onProgress?.("uploading", 70); // should be ignored — wrong stage
      input.onProgress?.("transcoding", 90);
      return baseRetranscodeResult();
    });
    configureBadgerStepDeps(makeMinimalDeps(retranscodeFormat));

    const ctx = makeCtx(makeJob(), makeStep());
    await retranscodeStepHandler(ctx);
    const transcodingPcts = ctx.recorded.progress
      .filter(([, , stage]) => stage === "transcoding")
      .map(([pct]) => pct);
    console.info(
      `[badger-retranscode-step:forward-progress] transcoding pcts=${JSON.stringify(transcodingPcts)} (uploading-stage events should be filtered)`,
    );
    try {
      expect(transcodingPcts).toContain(50);
      expect(transcodingPcts).toContain(90);
      // Uploading-stage event from the dep does NOT reach the engine via this
      // step (the upload step handles its own stage).
      expect(ctx.recorded.progress.some(([, , stage]) => stage === "uploading")).toBe(false);
    } catch (err) {
      dumpRetranscodeStepSnapshot("forward-progress-failure", {
        recorded: ctx.recorded,
        retranscodeFormat,
        extra: { transcodingPcts },
      });
      throw err;
    }
  });

  it.each([
    ["userId", "STEP_RETRANSCODE_MISSING_USER_ID"],
    ["fileId", "STEP_RETRANSCODE_MISSING_FILE_ID"],
    ["targetVariant", "STEP_RETRANSCODE_MISSING_TARGET_VARIANT"],
    ["sourceFormatId", "STEP_RETRANSCODE_MISSING_SOURCE_FORMAT_ID"],
    ["sourceVariant", "STEP_RETRANSCODE_MISSING_SOURCE_VARIANT"],
  ] as const)("fails loud when payload.%s is missing (%s)", async (field, errorCode) => {
    console.info(
      `[badger-retranscode-step:missing-payload-field] deleting payload.${field}; expect throw ${errorCode}`,
    );
    const retranscodeFormat = vi.fn(async () => baseRetranscodeResult());
    configureBadgerStepDeps(makeMinimalDeps(retranscodeFormat));

    const job = makeJob();
    const payload = { ...(job.payload as Record<string, unknown>) };
    delete payload[field];
    const ctx = makeCtx({ ...job, payload }, makeStep());

    try {
      await expect(retranscodeStepHandler(ctx)).rejects.toThrow(errorCode);
      expect(retranscodeFormat).not.toHaveBeenCalled();
    } catch (err) {
      dumpRetranscodeStepSnapshot(`missing-${field}-failure`, {
        job: { ...job, payload },
        retranscodeFormat,
        extra: { expectedErrorCode: errorCode, deletedField: field },
      });
      throw err;
    }
  });

  it("fails loud when deps.retranscodeFormat is missing (STEP_RETRANSCODE_DEP_MISSING)", async () => {
    console.info(
      `[badger-retranscode-step:missing-dep] configuring deps WITHOUT retranscodeFormat; expect STEP_RETRANSCODE_DEP_MISSING`,
    );
    configureBadgerStepDeps(makeMinimalDeps(undefined));
    const ctx = makeCtx(makeJob(), makeStep());
    try {
      await expect(retranscodeStepHandler(ctx)).rejects.toThrow(
        "STEP_RETRANSCODE_DEP_MISSING"
      );
    } catch (err) {
      dumpRetranscodeStepSnapshot("missing-dep-failure", {
        job: ctx.job,
        recorded: ctx.recorded,
      });
      throw err;
    }
  });

  it("throws CANCELLED when signal is already aborted at entry", async () => {
    console.info(
      `[badger-retranscode-step:cancelled-pre-entry] signal pre-aborted; expect CANCELLED, dep NOT called`,
    );
    const controller = new AbortController();
    controller.abort();
    const retranscodeFormat = vi.fn(async () => baseRetranscodeResult());
    configureBadgerStepDeps(makeMinimalDeps(retranscodeFormat));

    const ctx = makeCtx(makeJob(), makeStep(), controller.signal);
    try {
      await expect(retranscodeStepHandler(ctx)).rejects.toThrow("CANCELLED");
      expect(retranscodeFormat).not.toHaveBeenCalled();
    } catch (err) {
      dumpRetranscodeStepSnapshot("cancelled-pre-entry-failure", {
        job: ctx.job,
        retranscodeFormat,
        extra: { signalAborted: controller.signal.aborted },
      });
      throw err;
    }
  });

  it("throws CANCELLED when signal aborts between dep call and emit", async () => {
    console.info(
      `[badger-retranscode-step:cancelled-mid-dep] dep aborts controller after start; expect CANCELLED + no outputs`,
    );
    const controller = new AbortController();
    const retranscodeFormat = vi.fn(async () => {
      // Abort midway through the dep — handler should re-check after the
      // dep resolves and refuse to emit outputs.
      controller.abort();
      return baseRetranscodeResult();
    });
    configureBadgerStepDeps(makeMinimalDeps(retranscodeFormat));

    const ctx = makeCtx(makeJob(), makeStep(), controller.signal);
    try {
      await expect(retranscodeStepHandler(ctx)).rejects.toThrow("CANCELLED");
      expect(retranscodeFormat).toHaveBeenCalledTimes(1);
      // No transcodeResult emitted — handler bailed before emitOutputs.
      expect(ctx.recorded.outputs).toEqual([]);
    } catch (err) {
      dumpRetranscodeStepSnapshot("cancelled-mid-dep-failure", {
        job: ctx.job,
        recorded: ctx.recorded,
        retranscodeFormat,
        extra: { signalAborted: controller.signal.aborted },
      });
      throw err;
    }
  });
});

describe("seedStepsForJob — retranscode chain routing", () => {
  it("uses the retranscode → upload → commit chain when payload.retranscode === true", async () => {
    console.info(
      `[badger-retranscode-step:seed-retrans-chain] starting in-memory engine`,
    );
    const engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    let stored: Awaited<ReturnType<typeof engine.get>> | null = null;
    try {
      // Register no-op handlers for the chain steps so submit can seed them
      // without dispatch errors. We don't actually wait on the job — we just
      // inspect the seeded step rows.
      engine.registerHandler("retranscode", async () => {});
      engine.registerHandler("upload", async () => {});
      engine.registerHandler("commit", async () => {});

      const retranscodeJob: IngestJobRecord = makeJob({
        jobId: "retrans-seed",
        payload: {
          userId: "u",
          fileId: "f",
          targetVariant: "720p",
          sourceFormatId: "fmt",
          sourceVariant: "1080p",
          retranscode: true,
        },
      });
      console.info(
        `[badger-retranscode-step:seed-retrans-chain] submitting job ${retranscodeJob.jobId} with retranscode=true`,
      );
      await engine.submit(retranscodeJob);

      stored = await engine.get(retranscodeJob.jobId);
      const kinds = stored?.steps.map((s) => s.kind) ?? [];
      console.info(
        `[badger-retranscode-step:seed-retrans-chain] seeded step kinds=${JSON.stringify(kinds)}`,
      );
      try {
        expect(stored).not.toBeNull();
        expect(kinds).toEqual(["retranscode", "upload", "commit"]);
      } catch (err) {
        dumpRetranscodeStepSnapshot("seed-retrans-chain-failure", {
          job: retranscodeJob,
          extra: {
            seededKinds: kinds,
            steps: stored?.steps ?? null,
          },
        });
        throw err;
      }
    } finally {
      await engine.stop();
    }
  });

  it("uses the transcode → upload → commit chain for a plain format job (no retranscode flag)", async () => {
    console.info(
      `[badger-retranscode-step:seed-transcode-chain] starting in-memory engine`,
    );
    const engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    let stored: Awaited<ReturnType<typeof engine.get>> | null = null;
    try {
      engine.registerHandler("transcode", async () => {});
      engine.registerHandler("upload", async () => {});
      engine.registerHandler("commit", async () => {});

      const formatJob: IngestJobRecord = makeJob({
        jobId: "plain-format",
        payload: {
          userId: "u",
          filename: "x.mkv",
          variant: "720p",
        },
      });
      console.info(
        `[badger-retranscode-step:seed-transcode-chain] submitting plain format job ${formatJob.jobId} (no retranscode flag)`,
      );
      await engine.submit(formatJob);

      stored = await engine.get(formatJob.jobId);
      const kinds = stored?.steps.map((s) => s.kind) ?? [];
      console.info(
        `[badger-retranscode-step:seed-transcode-chain] seeded step kinds=${JSON.stringify(kinds)}`,
      );
      try {
        expect(stored).not.toBeNull();
        expect(kinds).toEqual(["transcode", "upload", "commit"]);
      } catch (err) {
        dumpRetranscodeStepSnapshot("seed-transcode-chain-failure", {
          job: formatJob,
          extra: {
            seededKinds: kinds,
            steps: stored?.steps ?? null,
          },
        });
        throw err;
      }
    } finally {
      await engine.stop();
    }
  });
});
