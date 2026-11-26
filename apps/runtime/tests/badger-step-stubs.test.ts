/**
 * Per-step handler tests for the Phase D badger ingest pipeline.
 *
 * The handlers themselves are thin wrappers around a `BadgerStepDeps` registry
 * (see `apps/runtime/src/modules/badger/steps/deps.ts`); production wires the
 * deps to the legacy `processMediaJob` helpers in `packages/ingest-core/`,
 * tests inject mocks so we never spin up real ffmpeg or storage.
 *
 * Coverage target per the task plan: ~3-5 tests per step, ~20 total.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  probeStepHandler,
  identifyStepHandler,
  extractStepHandler,
  transcodeStepHandler,
  uploadStepHandler,
  commitStepHandler,
  NotImplementedError,
} from "../src/modules/badger/steps";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
  type ProbeResult,
  type IdentifyResult,
  type ExtractResult,
  type TranscodeResult,
  type UploadResult,
  type CommitResult,
} from "../src/modules/badger/steps/deps";
import type { StepHandlerCtx } from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "@space/runtime-jobs-engine/stepStore";

const SUITE = "badger-step-stubs";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerStepStubsSnapshot = (
  label: string,
  ctx: {
    handler?: string;
    stepKind?: string;
    jobKind?: string;
    jobLane?: string;
    jobMediaId?: string;
    jobVariant?: string | null;
    payload?: unknown;
    job?: unknown;
    step?: unknown;
    stepOutputs?: unknown;
    depsConfigured?: boolean;
    recordedProgress?: unknown;
    recordedOutputs?: unknown;
    depsProbeCalls?: number;
    depsProbeArgs?: unknown;
    depsIdentifyCalls?: number;
    depsIdentifyArgs?: unknown;
    depsExtractCalls?: number;
    depsExtractArgs?: unknown;
    depsTranscodeCalls?: number;
    depsTranscodeArgs?: unknown;
    depsUploadCalls?: number;
    depsUploadArgs?: unknown;
    depsCommitCalls?: number;
    depsCommitArgs?: unknown;
    depsMarkMediaPlayableCalls?: number;
    depsMarkMediaPlayableArgs?: unknown;
    expected?: unknown;
    actual?: unknown;
    signalAborted?: boolean;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-step-stubs snapshot ===`);
    if (ctx.handler !== undefined) console.error(`handler: ${ctx.handler}`);
    if (ctx.stepKind !== undefined) console.error(`stepKind: ${ctx.stepKind}`);
    if (ctx.jobKind !== undefined) console.error(`jobKind: ${ctx.jobKind}`);
    if (ctx.jobLane !== undefined) console.error(`jobLane: ${ctx.jobLane}`);
    if (ctx.jobMediaId !== undefined) console.error(`jobMediaId: ${ctx.jobMediaId}`);
    if (ctx.jobVariant !== undefined) console.error(`jobVariant: ${ctx.jobVariant ?? "(null)"}`);
    if (ctx.payload !== undefined) {
      console.error(`payload:\n${JSON.stringify(ctx.payload, jsonReplacer, 2)}`);
    }
    if (ctx.job !== undefined) {
      console.error(`job:\n${JSON.stringify(ctx.job, jsonReplacer, 2)}`);
    }
    if (ctx.step !== undefined) {
      console.error(`step:\n${JSON.stringify(ctx.step, jsonReplacer, 2)}`);
    }
    if (ctx.stepOutputs !== undefined) {
      console.error(`stepOutputs:\n${JSON.stringify(ctx.stepOutputs, jsonReplacer, 2)}`);
    }
    if (ctx.depsConfigured !== undefined) console.error(`depsConfigured: ${ctx.depsConfigured}`);
    if (ctx.recordedProgress !== undefined) {
      console.error(`recordedProgress:\n${JSON.stringify(ctx.recordedProgress, jsonReplacer, 2)}`);
    }
    if (ctx.recordedOutputs !== undefined) {
      console.error(`recordedOutputs:\n${JSON.stringify(ctx.recordedOutputs, jsonReplacer, 2)}`);
    }
    if (ctx.depsProbeCalls !== undefined) console.error(`depsProbeCalls: ${ctx.depsProbeCalls}`);
    if (ctx.depsProbeArgs !== undefined) {
      console.error(`depsProbeArgs:\n${JSON.stringify(ctx.depsProbeArgs, jsonReplacer, 2)}`);
    }
    if (ctx.depsIdentifyCalls !== undefined) console.error(`depsIdentifyCalls: ${ctx.depsIdentifyCalls}`);
    if (ctx.depsIdentifyArgs !== undefined) {
      console.error(`depsIdentifyArgs:\n${JSON.stringify(ctx.depsIdentifyArgs, jsonReplacer, 2)}`);
    }
    if (ctx.depsExtractCalls !== undefined) console.error(`depsExtractCalls: ${ctx.depsExtractCalls}`);
    if (ctx.depsExtractArgs !== undefined) {
      console.error(`depsExtractArgs:\n${JSON.stringify(ctx.depsExtractArgs, jsonReplacer, 2)}`);
    }
    if (ctx.depsTranscodeCalls !== undefined) console.error(`depsTranscodeCalls: ${ctx.depsTranscodeCalls}`);
    if (ctx.depsTranscodeArgs !== undefined) {
      console.error(`depsTranscodeArgs:\n${JSON.stringify(ctx.depsTranscodeArgs, jsonReplacer, 2)}`);
    }
    if (ctx.depsUploadCalls !== undefined) console.error(`depsUploadCalls: ${ctx.depsUploadCalls}`);
    if (ctx.depsUploadArgs !== undefined) {
      console.error(`depsUploadArgs:\n${JSON.stringify(ctx.depsUploadArgs, jsonReplacer, 2)}`);
    }
    if (ctx.depsCommitCalls !== undefined) console.error(`depsCommitCalls: ${ctx.depsCommitCalls}`);
    if (ctx.depsCommitArgs !== undefined) {
      console.error(`depsCommitArgs:\n${JSON.stringify(ctx.depsCommitArgs, jsonReplacer, 2)}`);
    }
    if (ctx.depsMarkMediaPlayableCalls !== undefined) {
      console.error(`depsMarkMediaPlayableCalls: ${ctx.depsMarkMediaPlayableCalls}`);
    }
    if (ctx.depsMarkMediaPlayableArgs !== undefined) {
      console.error(`depsMarkMediaPlayableArgs:\n${JSON.stringify(ctx.depsMarkMediaPlayableArgs, jsonReplacer, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.signalAborted !== undefined) console.error(`signalAborted: ${ctx.signalAborted}`);
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const ts = "2026-01-01T00:00:00.000Z";
// Submit stamps payload.placementId on every job of one media (#145).
const PLACEMENT_ID = "placement-media-1";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "job-1",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "running",
  stageCode: "running",
  stageLabel: "Running",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: {
    userId: "user-1",
    filename: "/tmp/movie.mkv",
    placementId: PLACEMENT_ID,
    hints: {},
  },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: ts,
  updatedAt: ts,
  startedAt: ts,
  finishedAt: null,
  groupId: "media-1",
  mediaId: "media-1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

const makeStep = (overrides: Partial<StoredStepRecord> = {}): StoredStepRecord => ({
  stepId: "job-1:probe",
  jobId: "job-1",
  ordinal: 0,
  kind: "probe",
  status: "running",
  progressPct: 0,
  errorCode: null,
  errorMessage: null,
  startedAt: ts,
  finishedAt: null,
  app: "badger",
  lane: "source",
  dependsOn: [],
  payload: {},
  outputs: {},
  createdAt: ts,
  updatedAt: ts,
  ...overrides,
});

const makeCtx = (
  job: IngestJobRecord,
  step: StoredStepRecord,
  signal: AbortSignal = new AbortController().signal
): StepHandlerCtx & {
  recorded: { progress: Array<[number, string?]>; outputs: Array<Record<string, unknown>> };
} => {
  const recorded = {
    progress: [] as Array<[number, string?]>,
    outputs: [] as Array<Record<string, unknown>>,
  };
  return {
    job,
    step,
    signal,
    reportProgress: (pct, label) => {
      recorded.progress.push([pct, label]);
    },
    emitOutputs: (out) => {
      recorded.outputs.push(out);
      // Mirror onto step.outputs so the commit step can read upload outputs.
      for (const [k, v] of Object.entries(out)) {
        (step.outputs as Record<string, unknown>)[k] = v;
      }
    },
    recorded,
  };
};

const baseProbe = (): ProbeResult => ({
  durationSeconds: 7200,
  videoCodec: "h264",
  videoWidth: 1920,
  videoHeight: 1080,
  sourceQuality: "1080p",
  audioStreamCount: 1,
  subtitleStreamCount: 0,
  streams: [],
  chapters: [],
});

const baseExtract = (): ExtractResult => ({
  jobDir: "/tmp/jobs/job-1",
  state: {
    version: 1,
    inputPath: "/tmp/movie.mkv",
    userId: "user-1",
    createdAt: ts,
    outputs: [],
    subtitles: [],
  },
  segmentCount: 12,
});

const baseTranscode = (variant = "360p"): TranscodeResult => ({
  ...baseExtract(),
  variant,
});

const baseUpload = (): UploadResult => ({
  produced: {
    videoFormats: [
      {
        quality: "1080p",
        codec: "h264",
        codecString: "avc1.640028",
        initKey: "k:init",
        initSize: 100,
        durationSeconds: 7200,
        totalSize: 1_000_000,
        chunks: [{ key: "k:1", sizeBytes: 100_000, startSeconds: 0 }],
        chapters: [],
      },
    ],
    audioTracks: [],
    subtitleTracks: [],
  },
  uploadedKeys: ["k:init", "k:1"],
});

const makeDeps = (over: Partial<BadgerStepDeps> = {}): BadgerStepDeps => ({
  probe: vi.fn(async () => baseProbe()),
  identify: vi.fn(
    async (): Promise<IdentifyResult> => ({
      mediaId: null,
      parsedTitle: "Movie",
      season: null,
      episode: null,
      year: null,
      preexistingHint: false,
    })
  ),
  extractSource: vi.fn(async () => baseExtract()),
  transcodeFormat: vi.fn(async (input) => baseTranscode(input.variant)),
  uploadOutputs: vi.fn(async () => baseUpload()),
  commit: vi.fn(
    async (): Promise<CommitResult> => ({ fileId: "file-1", formatIds: ["fmt-1"] })
  ),
  markMediaPlayable: vi.fn(async () => undefined),
  ...over,
});

beforeEach(() => {
  __resetBadgerStepDeps();
});

afterEach(() => {
  __resetBadgerStepDeps();
});

describe("NotImplementedError export", () => {
  it("is still exported for backwards compat with any callers checking the type", () => {
    const err = new NotImplementedError("probe");
    expect(err.errorCode).toBe("step-not-implemented");
    expect(err.message).toContain("probe");
  });
});

// -----------------------------------------------------------------------------
// probe
// -----------------------------------------------------------------------------

describe("probeStepHandler", () => {
  it("calls deps.probe with the job's filename and stashes the result on outputs", async () => {
    const label = "probe-calls-deps-and-stashes-result";
    console.info(`[${SUITE}:${label}] configuring base deps and running probe handler`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob();
    const step = makeStep();
    const ctx = makeCtx(job, step);
    await probeStepHandler(ctx);
    try {
      expect(deps.probe).toHaveBeenCalledWith("/tmp/movie.mkv", ctx.signal);
      const last = ctx.recorded.outputs.at(-1);
      expect(last?.probeResult).toMatchObject({ videoCodec: "h264", sourceQuality: "1080p" });
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "probe",
        stepKind: "probe",
        jobKind: job.kind,
        payload: job.payload,
        depsProbeCalls: (deps.probe as ReturnType<typeof vi.fn>).mock.calls.length,
        depsProbeArgs: (deps.probe as ReturnType<typeof vi.fn>).mock.calls,
        recordedOutputs: ctx.recorded.outputs,
        recordedProgress: ctx.recorded.progress,
        expected: { probeCalledWith: ["/tmp/movie.mkv", "<signal>"], lastOutput: { probeResult: { videoCodec: "h264", sourceQuality: "1080p" } } },
        actual: ctx.recorded.outputs.at(-1),
        error: err,
      });
      throw err;
    }
  });

  it("reports progress at start and end", async () => {
    const label = "probe-progress-bounds";
    console.info(`[${SUITE}:${label}] running probe handler and asserting progress markers`);
    configureBadgerStepDeps(makeDeps());
    const ctx = makeCtx(makeJob(), makeStep());
    await probeStepHandler(ctx);
    try {
      expect(ctx.recorded.progress[0][0]).toBeLessThan(100);
      expect(ctx.recorded.progress.at(-1)?.[0]).toBe(100);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "probe",
        recordedProgress: ctx.recorded.progress,
        expected: { firstLessThan: 100, lastEquals: 100 },
        actual: { first: ctx.recorded.progress[0]?.[0], last: ctx.recorded.progress.at(-1)?.[0] },
        error: err,
      });
      throw err;
    }
  });

  it("throws CANCELLED when signal is already aborted", async () => {
    const label = "probe-cancelled-pre-abort";
    console.info(`[${SUITE}:${label}] aborting signal before invoking probe handler`);
    configureBadgerStepDeps(makeDeps());
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = makeCtx(makeJob(), makeStep(), ctrl.signal);
    try {
      await expect(probeStepHandler(ctx)).rejects.toThrow("CANCELLED");
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "probe",
        signalAborted: ctrl.signal.aborted,
        expected: "throws /CANCELLED/",
        error: err,
      });
      throw err;
    }
  });

  it("fails loudly when filename is missing from job payload", async () => {
    const label = "probe-missing-filename";
    console.info(`[${SUITE}:${label}] running probe with payload lacking filename`);
    configureBadgerStepDeps(makeDeps());
    const job = makeJob({ payload: { userId: "u1" } });
    const ctx = makeCtx(job, makeStep());
    try {
      await expect(probeStepHandler(ctx)).rejects.toThrow(/MISSING_FILENAME/);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "probe",
        payload: job.payload,
        expected: "throws /MISSING_FILENAME/",
        error: err,
      });
      throw err;
    }
  });
});

// -----------------------------------------------------------------------------
// identify
// -----------------------------------------------------------------------------

describe("identifyStepHandler", () => {
  it("delegates to deps.identify with filename + hints and writes the result", async () => {
    const label = "identify-delegates-and-writes";
    console.info(`[${SUITE}:${label}] configuring deps with canned identify response for Orchard`);
    const deps = makeDeps({
      identify: vi.fn(async () => ({
        mediaId: "media-tt-orchard",
        parsedTitle: "Orchard",
        season: null,
        episode: null,
        year: 2017,
        preexistingHint: true,
      })),
    });
    configureBadgerStepDeps(deps);
    const job = makeJob({
      payload: {
        userId: "u1",
        filename: "/tmp/Orchard.2017.mkv",
        hints: { mediaId: "media-tt-orchard" },
      },
    });
    const ctx = makeCtx(job, makeStep({ kind: "identify" }));
    await identifyStepHandler(ctx);
    try {
      expect(deps.identify).toHaveBeenCalledWith({
        filename: "/tmp/Orchard.2017.mkv",
        hint: { mediaId: "media-tt-orchard" },
      });
      const out = ctx.recorded.outputs.at(-1)?.identifyResult as IdentifyResult;
      expect(out?.mediaId).toBe("media-tt-orchard");
      expect(out?.preexistingHint).toBe(true);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "identify",
        stepKind: "identify",
        payload: job.payload,
        depsIdentifyCalls: (deps.identify as ReturnType<typeof vi.fn>).mock.calls.length,
        depsIdentifyArgs: (deps.identify as ReturnType<typeof vi.fn>).mock.calls,
        recordedOutputs: ctx.recorded.outputs,
        expected: {
          identifyCalledWith: { filename: "/tmp/Orchard.2017.mkv", hint: { mediaId: "media-tt-orchard" } },
          mediaId: "media-tt-orchard",
          preexistingHint: true,
        },
        actual: ctx.recorded.outputs.at(-1),
        error: err,
      });
      throw err;
    }
  });

  it("aborts when signal fires before deps return", async () => {
    const label = "identify-cancelled-mid-deps";
    console.info(`[${SUITE}:${label}] deps will abort the signal mid-call then return; handler must throw CANCELLED`);
    const ctrl = new AbortController();
    const deps = makeDeps({
      identify: vi.fn(async () => {
        ctrl.abort();
        return {
          mediaId: null,
          parsedTitle: null,
          season: null,
          episode: null,
          year: null,
          preexistingHint: false,
        };
      }),
    });
    configureBadgerStepDeps(deps);
    const ctx = makeCtx(makeJob(), makeStep({ kind: "identify" }), ctrl.signal);
    try {
      await expect(identifyStepHandler(ctx)).rejects.toThrow("CANCELLED");
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "identify",
        signalAborted: ctrl.signal.aborted,
        expected: "throws /CANCELLED/",
        error: err,
      });
      throw err;
    }
  });

  it("hands an empty hints object to deps when payload omits hints", async () => {
    const label = "identify-defaults-empty-hints";
    console.info(`[${SUITE}:${label}] running identify with payload omitting hints`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob({ payload: { userId: "u1", filename: "/x.mkv" } });
    const ctx = makeCtx(job, makeStep({ kind: "identify" }));
    await identifyStepHandler(ctx);
    try {
      expect(deps.identify).toHaveBeenCalledWith({ filename: "/x.mkv", hint: {} });
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "identify",
        payload: job.payload,
        depsIdentifyCalls: (deps.identify as ReturnType<typeof vi.fn>).mock.calls.length,
        depsIdentifyArgs: (deps.identify as ReturnType<typeof vi.fn>).mock.calls,
        expected: { identifyCalledWith: { filename: "/x.mkv", hint: {} } },
        error: err,
      });
      throw err;
    }
  });
});

// -----------------------------------------------------------------------------
// extract
// -----------------------------------------------------------------------------

describe("extractStepHandler", () => {
  it("invokes deps.extractSource with userId, jobId, inputPath, signal", async () => {
    const label = "extract-invokes-deps-with-args";
    console.info(`[${SUITE}:${label}] running extract step on a movie source job`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob();
    const step = makeStep({ kind: "extract" });
    const ctx = makeCtx(job, step);
    await extractStepHandler(ctx);
    try {
      expect(deps.extractSource).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          jobId: "job-1",
          placementId: PLACEMENT_ID,
          inputPath: "/tmp/movie.mkv",
          signal: ctx.signal,
        })
      );
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "extract",
        stepKind: "extract",
        payload: job.payload,
        depsExtractCalls: (deps.extractSource as ReturnType<typeof vi.fn>).mock.calls.length,
        depsExtractArgs: (deps.extractSource as ReturnType<typeof vi.fn>).mock.calls,
        expected: { userId: "user-1", jobId: "job-1", inputPath: "/tmp/movie.mkv", signal: "<signal>" },
        error: err,
      });
      throw err;
    }
  });

  it("forwards onProgress callbacks from deps to ctx.reportProgress (clamped to 1..99)", async () => {
    const label = "extract-progress-clamped";
    console.info(`[${SUITE}:${label}] deps will emit 0/45/120 progress; handler must clamp to 1/45/99`);
    const deps = makeDeps({
      extractSource: vi.fn(async (input) => {
        input.onProgress?.("transcoding", 0); // should clamp to 1
        input.onProgress?.("transcoding", 45);
        input.onProgress?.("transcoding", 120); // should clamp to 99
        return baseExtract();
      }),
    });
    configureBadgerStepDeps(deps);
    const ctx = makeCtx(makeJob(), makeStep({ kind: "extract" }));
    await extractStepHandler(ctx);
    const interior = ctx.recorded.progress.slice(1, -1).map((p) => p[0]);
    console.info(`[${SUITE}:${label}] interior progress values: ${JSON.stringify(interior)}`);
    try {
      expect(interior).toEqual(expect.arrayContaining([1, 45, 99]));
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "extract",
        recordedProgress: ctx.recorded.progress,
        expected: { interiorContains: [1, 45, 99] },
        actual: interior,
        error: err,
      });
      throw err;
    }
  });

  it("re-throws CANCELLED when signal aborted after deps return", async () => {
    const label = "extract-cancelled-post-deps";
    console.info(`[${SUITE}:${label}] deps will abort then return; handler must re-throw CANCELLED`);
    const ctrl = new AbortController();
    const deps = makeDeps({
      extractSource: vi.fn(async () => {
        ctrl.abort();
        return baseExtract();
      }),
    });
    configureBadgerStepDeps(deps);
    const ctx = makeCtx(makeJob(), makeStep({ kind: "extract" }), ctrl.signal);
    try {
      await expect(extractStepHandler(ctx)).rejects.toThrow("CANCELLED");
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "extract",
        signalAborted: ctrl.signal.aborted,
        expected: "throws /CANCELLED/",
        error: err,
      });
      throw err;
    }
  });

  it("rejects when payload is missing userId", async () => {
    const label = "extract-missing-user-id";
    console.info(`[${SUITE}:${label}] running extract with payload lacking userId`);
    configureBadgerStepDeps(makeDeps());
    const job = makeJob({ payload: { filename: "/x.mkv" } });
    const ctx = makeCtx(job, makeStep({ kind: "extract" }));
    try {
      await expect(extractStepHandler(ctx)).rejects.toThrow(/MISSING_USER_ID/);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "extract",
        payload: job.payload,
        expected: "throws /MISSING_USER_ID/",
        error: err,
      });
      throw err;
    }
  });
});

// -----------------------------------------------------------------------------
// transcode
// -----------------------------------------------------------------------------

describe("transcodeStepHandler", () => {
  it("passes the variant from job.payload through to deps.transcodeFormat", async () => {
    const label = "transcode-passes-variant";
    console.info(`[${SUITE}:${label}] running transcode handler with format/360p job`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob({
      kind: "format",
      lane: "format",
      variant: "360p",
      payload: { userId: "u1", filename: "/m.mkv", variant: "360p", placementId: PLACEMENT_ID },
    });
    const ctx = makeCtx(job, makeStep({ kind: "transcode", lane: "format" }));
    await transcodeStepHandler(ctx);
    try {
      expect(deps.transcodeFormat).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "360p", inputPath: "/m.mkv", placementId: PLACEMENT_ID })
      );
      const out = ctx.recorded.outputs.at(-1)?.transcodeResult as TranscodeResult;
      expect(out?.variant).toBe("360p");
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "transcode",
        stepKind: "transcode",
        jobKind: job.kind,
        jobLane: job.lane,
        jobVariant: job.variant,
        payload: job.payload,
        depsTranscodeCalls: (deps.transcodeFormat as ReturnType<typeof vi.fn>).mock.calls.length,
        depsTranscodeArgs: (deps.transcodeFormat as ReturnType<typeof vi.fn>).mock.calls,
        recordedOutputs: ctx.recorded.outputs,
        expected: { transcodeCalledWith: { variant: "360p", inputPath: "/m.mkv" }, outVariant: "360p" },
        error: err,
      });
      throw err;
    }
  });

  it("rejects when the variant is missing from payload", async () => {
    const label = "transcode-missing-variant";
    console.info(`[${SUITE}:${label}] running transcode with payload lacking variant`);
    configureBadgerStepDeps(makeDeps());
    const job = makeJob({
      kind: "format",
      lane: "format",
      payload: { userId: "u1", filename: "/m.mkv" },
    });
    const ctx = makeCtx(job, makeStep({ kind: "transcode", lane: "format" }));
    try {
      await expect(transcodeStepHandler(ctx)).rejects.toThrow(/MISSING_VARIANT/);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "transcode",
        jobKind: job.kind,
        jobLane: job.lane,
        payload: job.payload,
        expected: "throws /MISSING_VARIANT/",
        error: err,
      });
      throw err;
    }
  });

  it("aborts cleanly when signal fires", async () => {
    const label = "transcode-cancelled-pre-abort";
    console.info(`[${SUITE}:${label}] running transcode with pre-aborted signal`);
    const ctrl = new AbortController();
    ctrl.abort();
    configureBadgerStepDeps(makeDeps());
    const job = makeJob({
      kind: "format",
      lane: "format",
      payload: { userId: "u1", filename: "/m.mkv", variant: "720p" },
    });
    const ctx = makeCtx(job, makeStep({ kind: "transcode" }), ctrl.signal);
    try {
      await expect(transcodeStepHandler(ctx)).rejects.toThrow("CANCELLED");
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "transcode",
        signalAborted: ctrl.signal.aborted,
        payload: job.payload,
        expected: "throws /CANCELLED/",
        error: err,
      });
      throw err;
    }
  });
});

// -----------------------------------------------------------------------------
// upload
// -----------------------------------------------------------------------------

describe("uploadStepHandler", () => {
  it("scopes to 'source' for source jobs and writes a producedSummary", async () => {
    const label = "upload-source-scope";
    console.info(`[${SUITE}:${label}] running upload on a source job; expecting scope=source`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const ctx = makeCtx(makeJob(), makeStep({ kind: "upload" }));
    await uploadStepHandler(ctx);
    try {
      expect(deps.uploadOutputs).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "source", variant: undefined, placementId: PLACEMENT_ID })
      );
      const out = ctx.recorded.outputs.at(-1)?.uploadResult as {
        producedSummary: { videoFormatCount: number };
      };
      expect(out.producedSummary.videoFormatCount).toBe(1);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "upload",
        stepKind: "upload",
        depsUploadCalls: (deps.uploadOutputs as ReturnType<typeof vi.fn>).mock.calls.length,
        depsUploadArgs: (deps.uploadOutputs as ReturnType<typeof vi.fn>).mock.calls,
        recordedOutputs: ctx.recorded.outputs,
        expected: { scope: "source", variant: undefined, videoFormatCount: 1 },
        actual: ctx.recorded.outputs.at(-1),
        error: err,
      });
      throw err;
    }
  });

  it("scopes to 'format' for format jobs and forwards variant", async () => {
    const label = "upload-format-scope";
    console.info(`[${SUITE}:${label}] running upload on a format/480p job; expecting scope=format variant=480p`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob({
      kind: "format",
      lane: "format",
      variant: "480p",
      payload: { userId: "u1", filename: "/m.mkv", variant: "480p", placementId: PLACEMENT_ID },
    });
    const ctx = makeCtx(job, makeStep({ kind: "upload", lane: "upload" }));
    await uploadStepHandler(ctx);
    try {
      expect(deps.uploadOutputs).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "format", variant: "480p", placementId: PLACEMENT_ID })
      );
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "upload",
        jobKind: job.kind,
        jobLane: job.lane,
        jobVariant: job.variant,
        payload: job.payload,
        depsUploadCalls: (deps.uploadOutputs as ReturnType<typeof vi.fn>).mock.calls.length,
        depsUploadArgs: (deps.uploadOutputs as ReturnType<typeof vi.fn>).mock.calls,
        expected: { scope: "format", variant: "480p" },
        error: err,
      });
      throw err;
    }
  });

  it("records uploadedKeys for the cancel-cleanup path to reference later", async () => {
    const label = "upload-records-keys";
    console.info(`[${SUITE}:${label}] running upload; expecting uploadedKeys to be threaded through`);
    configureBadgerStepDeps(makeDeps());
    const ctx = makeCtx(makeJob(), makeStep({ kind: "upload" }));
    await uploadStepHandler(ctx);
    const out = ctx.recorded.outputs.at(-1)?.uploadResult as { uploadedKeys: string[] };
    try {
      expect(out.uploadedKeys).toEqual(["k:init", "k:1"]);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "upload",
        recordedOutputs: ctx.recorded.outputs,
        expected: { uploadedKeys: ["k:init", "k:1"] },
        actual: { uploadedKeys: out?.uploadedKeys },
        error: err,
      });
      throw err;
    }
  });

  it("aborts when signal is already fired", async () => {
    const label = "upload-cancelled-pre-abort";
    console.info(`[${SUITE}:${label}] running upload with pre-aborted signal`);
    configureBadgerStepDeps(makeDeps());
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = makeCtx(makeJob(), makeStep({ kind: "upload" }), ctrl.signal);
    try {
      await expect(uploadStepHandler(ctx)).rejects.toThrow("CANCELLED");
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "upload",
        signalAborted: ctrl.signal.aborted,
        expected: "throws /CANCELLED/",
        error: err,
      });
      throw err;
    }
  });
});

// -----------------------------------------------------------------------------
// commit
// -----------------------------------------------------------------------------

describe("commitStepHandler", () => {
  it("calls deps.commit and deps.markMediaPlayable for source jobs", async () => {
    const label = "commit-source-marks-playable";
    console.info(`[${SUITE}:${label}] running commit on source job; expects markMediaPlayable("media-1")`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const step = makeStep({
      kind: "commit",
      // Simulate the upload step having emitted its produced object onto the
      // shared step.outputs (engineV2 keeps step.outputs scoped per-step but
      // the test ctx uses a single shared map for simplicity).
      outputs: { uploadResult: { produced: baseUpload().produced } },
    });
    const ctx = makeCtx(makeJob(), step);
    await commitStepHandler(ctx);
    try {
      expect(deps.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "source",
          mediaId: "media-1",
          produced: expect.objectContaining({ videoFormats: expect.any(Array) }),
        })
      );
      expect(deps.markMediaPlayable).toHaveBeenCalledWith("media-1");
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "commit",
        stepKind: step.kind,
        step,
        stepOutputs: step.outputs,
        depsCommitCalls: (deps.commit as ReturnType<typeof vi.fn>).mock.calls.length,
        depsCommitArgs: (deps.commit as ReturnType<typeof vi.fn>).mock.calls,
        depsMarkMediaPlayableCalls: (deps.markMediaPlayable as ReturnType<typeof vi.fn>).mock.calls.length,
        depsMarkMediaPlayableArgs: (deps.markMediaPlayable as ReturnType<typeof vi.fn>).mock.calls,
        expected: { commitScope: "source", mediaId: "media-1", markedPlayableWith: "media-1" },
        error: err,
      });
      throw err;
    }
  });

  it("does NOT flip playability for format jobs", async () => {
    const label = "commit-format-no-playable-flip";
    console.info(`[${SUITE}:${label}] running commit on format job; markMediaPlayable must NOT be called`);
    const deps = makeDeps({
      lookupParentSourceFileId: vi.fn(async () => "file-parent"),
    });
    configureBadgerStepDeps(deps);
    const job = makeJob({
      kind: "format",
      lane: "format",
      variant: "360p",
      payload: {
        userId: "u1",
        filename: "/m.mkv",
        variant: "360p",
        parentSourceJobId: "src-parent",
      },
      parentJobIds: ["src-parent"],
    });
    const ctx = makeCtx(job, makeStep({ kind: "commit" }));
    await commitStepHandler(ctx);
    try {
      expect(deps.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "format",
          variant: "360p",
          sourceFileId: "file-parent",
        })
      );
      expect(deps.markMediaPlayable).not.toHaveBeenCalled();
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "commit",
        jobKind: job.kind,
        jobLane: job.lane,
        jobVariant: job.variant,
        payload: job.payload,
        depsCommitCalls: (deps.commit as ReturnType<typeof vi.fn>).mock.calls.length,
        depsCommitArgs: (deps.commit as ReturnType<typeof vi.fn>).mock.calls,
        depsMarkMediaPlayableCalls: (deps.markMediaPlayable as ReturnType<typeof vi.fn>).mock.calls.length,
        depsMarkMediaPlayableArgs: (deps.markMediaPlayable as ReturnType<typeof vi.fn>).mock.calls,
        expected: { commitScope: "format", variant: "360p", sourceFileId: "file-parent", markedPlayableCalled: false },
        error: err,
      });
      throw err;
    }
  });

  it("works without markMediaPlayable wired (graceful degradation)", async () => {
    const label = "commit-no-mark-playable-wired";
    console.info(`[${SUITE}:${label}] running commit with markMediaPlayable deleted from deps`);
    const deps = makeDeps();
    delete (deps as Partial<BadgerStepDeps>).markMediaPlayable;
    configureBadgerStepDeps(deps);
    const ctx = makeCtx(makeJob(), makeStep({ kind: "commit" }));
    try {
      await expect(commitStepHandler(ctx)).resolves.toBeUndefined();
      expect(deps.commit).toHaveBeenCalled();
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "commit",
        depsCommitCalls: (deps.commit as ReturnType<typeof vi.fn>).mock.calls.length,
        depsCommitArgs: (deps.commit as ReturnType<typeof vi.fn>).mock.calls,
        expected: "resolves; deps.commit called; no throw",
        error: err,
      });
      throw err;
    }
  });

  it("rejects when mediaId is missing on the job", async () => {
    const label = "commit-missing-media-id";
    console.info(`[${SUITE}:${label}] running commit with mediaId=""`);
    configureBadgerStepDeps(makeDeps());
    const job = makeJob({ mediaId: "" });
    const ctx = makeCtx(job, makeStep({ kind: "commit" }));
    try {
      await expect(commitStepHandler(ctx)).rejects.toThrow(/MISSING_MEDIA_ID/);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "commit",
        jobMediaId: job.mediaId,
        expected: "throws /MISSING_MEDIA_ID/",
        error: err,
      });
      throw err;
    }
  });

  // [@bugfix @regression-proof] Play button stays disabled after TV ingest:
  // without these hints threading season/episode onto CommitInput, the deps
  // adapter wrote media_files / media_audio_tracks with (season=null,
  // episode=null), addAudioTrackWithChunks resolved episodeId=null,
  // getPlayableEpisodeKeySet returned empty, and defaultPlayableEpisodeId was
  // null forever. Reproduces playback.e2e.test.ts:1043 +
  // playback-subtitle-switch.e2e.test.ts:1029.
  it("[@bugfix @regression-proof] threads hints.season/episode onto CommitInput for TV ingests", async () => {
    const label = "commit-threads-tv-hints";
    console.info(`[${SUITE}:${label}] running commit for TV ingest with hints.season=1 hints.episode=1`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob({
      payload: {
        userId: "user-1",
        filename: "Saltmarsh - S01E01 - Low Tide.mkv",
        hints: { mediaId: "media-1", season: 1, episode: 1 },
      },
    });
    const step = makeStep({
      kind: "commit",
      outputs: { uploadResult: { produced: baseUpload().produced } },
    });
    const ctx = makeCtx(job, step);
    await commitStepHandler(ctx);
    try {
      expect(deps.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "source",
          mediaId: "media-1",
          season: 1,
          episode: 1,
        })
      );
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "commit",
        stepKind: step.kind,
        payload: job.payload,
        step,
        stepOutputs: step.outputs,
        depsCommitCalls: (deps.commit as ReturnType<typeof vi.fn>).mock.calls.length,
        depsCommitArgs: (deps.commit as ReturnType<typeof vi.fn>).mock.calls,
        expected: { scope: "source", mediaId: "media-1", season: 1, episode: 1 },
        error: err,
      });
      throw err;
    }
  });

  it("[@bugfix @regression-proof] leaves season/episode null when hints absent (movie case)", async () => {
    const label = "commit-movie-null-season-episode";
    console.info(`[${SUITE}:${label}] running commit for movie; expects season=null episode=null`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob({
      payload: {
        userId: "user-1",
        filename: "/tmp/movie.mkv",
        hints: { mediaId: "media-movie" },
      },
    });
    const ctx = makeCtx(
      job,
      makeStep({
        kind: "commit",
        outputs: { uploadResult: { produced: baseUpload().produced } },
      })
    );
    await commitStepHandler(ctx);
    try {
      expect(deps.commit).toHaveBeenCalledWith(
        expect.objectContaining({ season: null, episode: null })
      );
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "commit",
        payload: job.payload,
        depsCommitCalls: (deps.commit as ReturnType<typeof vi.fn>).mock.calls.length,
        depsCommitArgs: (deps.commit as ReturnType<typeof vi.fn>).mock.calls,
        expected: { season: null, episode: null },
        error: err,
      });
      throw err;
    }
  });

  it("[@bugfix @regression-proof] rejects non-positive season/episode hints (defensive)", async () => {
    const label = "commit-rejects-non-positive-hints";
    console.info(`[${SUITE}:${label}] running commit with hints.season=0 hints.episode=-1; expects nulls`);
    const deps = makeDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob({
      payload: {
        userId: "user-1",
        filename: "/tmp/badhints.mkv",
        hints: { mediaId: "m", season: 0, episode: -1 },
      },
    });
    const ctx = makeCtx(
      job,
      makeStep({
        kind: "commit",
        outputs: { uploadResult: { produced: baseUpload().produced } },
      })
    );
    await commitStepHandler(ctx);
    try {
      expect(deps.commit).toHaveBeenCalledWith(
        expect.objectContaining({ season: null, episode: null })
      );
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "commit",
        payload: job.payload,
        depsCommitCalls: (deps.commit as ReturnType<typeof vi.fn>).mock.calls.length,
        depsCommitArgs: (deps.commit as ReturnType<typeof vi.fn>).mock.calls,
        expected: { season: null, episode: null },
        error: err,
      });
      throw err;
    }
  });
});

// -----------------------------------------------------------------------------
// deps wiring
// -----------------------------------------------------------------------------

describe("deps wiring", () => {
  it("throws if a handler runs without configureBadgerStepDeps()", async () => {
    const label = "deps-not-configured";
    console.info(`[${SUITE}:${label}] resetting badger step deps and invoking probe; expects BADGER_STEP_DEPS_NOT_CONFIGURED`);
    __resetBadgerStepDeps();
    const ctx = makeCtx(makeJob(), makeStep());
    try {
      await expect(probeStepHandler(ctx)).rejects.toThrow(/BADGER_STEP_DEPS_NOT_CONFIGURED/);
    } catch (err) {
      dumpBadgerStepStubsSnapshot(label, {
        handler: "probe",
        depsConfigured: false,
        expected: "throws /BADGER_STEP_DEPS_NOT_CONFIGURED/",
        error: err,
      });
      throw err;
    }
  });
});
