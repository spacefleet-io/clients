/**
 * @bugfix @regression-proof
 *
 * Phase 1 — Source-job badge stuck on "extracting" for the entire run
 *
 * Symptom (from Phase 0 baseline): a 2.5 GB 1080p ingest's source-job
 * badge sat on "Extracting" for ~200 s of chunk upload, then jumped to
 * "done" without ever showing "Uploading" or "Committing". The verifier
 * confirmed the runtime never emitted a stageCode transition for the
 * source-job mid-upload.
 *
 * Root cause: the legacy `processMediaJob` pipeline is monolithic
 * (encode + chunk + encrypt + upload all in one call). The deps-adapter
 * only forwarded its `transcoding`-stage progress to the engine extract
 * step and silently dropped `uploading` progress, so the engine kept
 * emitting `stageCode='extracting'` until the inner monolith returned.
 *
 * Fix:
 *   1A. `extractStepHandler` threads the `(stage, pct)` pair through to
 *       `ctx.reportProgress`. When `stage="uploading"` arrives mid-step
 *       it emits `stageCode='uploading'`. EngineV2's existing
 *       stage-transition throttle bypass (see
 *       engine-v2-progress-throttle-stage-bypass.test.ts) ensures that
 *       transition lands on the renderer.
 *   1B. `BadgerModule.publishIngestJobsUpdate` tracks
 *       `lastPublishedStatusByJob` and bypasses the 2 s throttle whenever
 *       any job's status differs from its last-published value. Same-
 *       status pct samples within the window stay throttled.
 *
 * The two halves are independent: 1A drives engine v2 progress events;
 * 1B drives the legacy `ingest.jobs_updated` channel that downstream
 * runtime jobs mirroring still consumes. This file pins both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractStepHandler } from "../src/modules/badger/steps";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
  type ExtractInput,
  type ExtractResult,
  type IdentifyResult,
  type ProbeResult,
  type UploadResult,
  type CommitResult,
} from "../src/modules/badger/steps/deps";
import type { StepHandlerCtx } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";
import { BadgerModule } from "../src/modules/badger";
import { runtimeJobsStore } from "../src/core/jobs/store";

const SUITE = "badger-ingest-uploading-stage";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerIngestUploadingStageSnapshot = (
  label: string,
  ctx: {
    jobId?: string;
    userId?: string;
    progressEvents?: unknown;
    progressEventsCount?: number;
    codes?: unknown;
    labels?: unknown;
    extractingIdx?: number;
    uploadingIdx?: number;
    terminalEntry?: unknown;
    publishedEvents?: unknown;
    publishedEventsCount?: number;
    jobsUpdated?: unknown;
    jobsUpdatedCount?: number;
    statusesObserved?: unknown;
    expectedStatuses?: unknown;
    actualStatuses?: unknown;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-ingest-uploading-stage snapshot ===`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.userId !== undefined) console.error(`userId: ${ctx.userId}`);
    if (ctx.progressEvents !== undefined) {
      console.error(`progressEvents:\n${JSON.stringify(ctx.progressEvents, jsonReplacer, 2)}`);
    }
    if (ctx.progressEventsCount !== undefined) {
      console.error(`progressEventsCount: ${ctx.progressEventsCount}`);
    }
    if (ctx.codes !== undefined) {
      console.error(`codes:\n${JSON.stringify(ctx.codes, jsonReplacer, 2)}`);
    }
    if (ctx.labels !== undefined) {
      console.error(`labels:\n${JSON.stringify(ctx.labels, jsonReplacer, 2)}`);
    }
    if (ctx.extractingIdx !== undefined) console.error(`extractingIdx: ${ctx.extractingIdx}`);
    if (ctx.uploadingIdx !== undefined) console.error(`uploadingIdx: ${ctx.uploadingIdx}`);
    if (ctx.terminalEntry !== undefined) {
      console.error(`terminalEntry:\n${JSON.stringify(ctx.terminalEntry, jsonReplacer, 2)}`);
    }
    if (ctx.publishedEvents !== undefined) {
      console.error(`publishedEvents:\n${JSON.stringify(ctx.publishedEvents, jsonReplacer, 2)}`);
    }
    if (ctx.publishedEventsCount !== undefined) {
      console.error(`publishedEventsCount: ${ctx.publishedEventsCount}`);
    }
    if (ctx.jobsUpdated !== undefined) {
      console.error(`jobsUpdated:\n${JSON.stringify(ctx.jobsUpdated, jsonReplacer, 2)}`);
    }
    if (ctx.jobsUpdatedCount !== undefined) {
      console.error(`jobsUpdatedCount: ${ctx.jobsUpdatedCount}`);
    }
    if (ctx.statusesObserved !== undefined) {
      console.error(`statusesObserved: ${JSON.stringify(ctx.statusesObserved)}`);
    }
    if (ctx.expectedStatuses !== undefined) {
      console.error(`expectedStatuses: ${JSON.stringify(ctx.expectedStatuses)}`);
    }
    if (ctx.actualStatuses !== undefined) {
      console.error(`actualStatuses: ${JSON.stringify(ctx.actualStatuses)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
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

const baseUpload = (): UploadResult => ({
  produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
  uploadedKeys: [],
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
  transcodeFormat: vi.fn(async () => ({ ...baseExtract(), variant: "360p" })),
  uploadOutputs: vi.fn(async () => baseUpload()),
  commit: vi.fn(
    async (): Promise<CommitResult> => ({ fileId: "file-1", formatIds: ["fmt-1"] })
  ),
  markMediaPlayable: vi.fn(async () => undefined),
  ...over,
});

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
    hints: {},
    placementId: "placement-media-1",
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
  stepId: "job-1:extract",
  jobId: "job-1",
  ordinal: 2,
  kind: "extract",
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

type Recorded = {
  progress: Array<{ pct: number; label: string | undefined; code: string | undefined }>;
};

const makeCtx = (
  job: IngestJobRecord,
  step: StoredStepRecord,
  signal: AbortSignal = new AbortController().signal
): StepHandlerCtx & { recorded: Recorded } => {
  const recorded: Recorded = { progress: [] };
  return {
    job,
    step,
    signal,
    reportProgress: (pct, label, code) => {
      recorded.progress.push({ pct, label, code });
    },
    emitOutputs: () => {
      // not under test
    },
    recorded,
  };
};

beforeEach(() => {
  __resetBadgerStepDeps();
  console.info(`[${SUITE}:beforeEach] reset deps`);
});

describe("extract step bridges upload-stage progress to stageCode='uploading'", () => {
  console.info(`[${SUITE}:describe] entering "extract step bridges upload-stage progress to stageCode='uploading'"`);
  it("emits a stageCode='uploading' transition when the deps adapter reports stage='uploading' mid-call", async () => {
    const label = "uploading-transition-emitted";
    console.info(`[${SUITE}:${label}] start`);
    // Mirror the legacy processMediaJob shape: it emits a few transcoding
    // progress samples, then crosses into the upload phase and emits
    // uploading progress samples. Under the pre-fix code, only the
    // transcoding samples reached ctx.reportProgress, so the engine
    // event stream never carried a stageCode transition.
    const deps = makeDeps({
      extractSource: vi.fn(async (input: ExtractInput) => {
        input.onProgress?.("transcoding", 10);
        input.onProgress?.("transcoding", 50);
        input.onProgress?.("transcoding", 100);
        input.onProgress?.("uploading", 5);
        input.onProgress?.("uploading", 73);
        input.onProgress?.("uploading", 99);
        return baseExtract();
      }),
    });
    configureBadgerStepDeps(deps);
    const ctx = makeCtx(makeJob(), makeStep());
    console.info(`[${SUITE}:${label}] invoking extractStepHandler`);
    await extractStepHandler(ctx);

    // The extract step must emit at least one progress event with
    // stageCode='uploading' AFTER its initial 'extracting' emit. Order
    // matters: the renderer relies on transitions arriving in physical
    // order (extracting before uploading).
    const codes = ctx.recorded.progress.map((p) => p.code);
    const extractingIdx = codes.indexOf("extracting");
    const uploadingIdx = codes.indexOf("uploading");
    console.info(`[${SUITE}:${label}] codes=${JSON.stringify(codes)} extractingIdx=${extractingIdx} uploadingIdx=${uploadingIdx}`);
    try {
      expect(codes).toContain("extracting");
      expect(codes).toContain("uploading");
      expect(codes.indexOf("uploading")).toBeGreaterThan(codes.indexOf("extracting"));
    } catch (err) {
      dumpBadgerIngestUploadingStageSnapshot(label, {
        jobId: "job-1",
        progressEvents: ctx.recorded.progress,
        progressEventsCount: ctx.recorded.progress.length,
        codes,
        extractingIdx,
        uploadingIdx,
        expected: {
          containsExtracting: true,
          containsUploading: true,
          uploadingAfterExtracting: true,
        },
        actual: {
          containsExtracting: codes.includes("extracting"),
          containsUploading: codes.includes("uploading"),
          uploadingAfterExtracting: uploadingIdx > extractingIdx,
        },
        error: err,
      });
      throw err;
    }

    // Every uploading progress emit must carry a clamped pct in [1..100]
    // (interior emits are clamped to [1..99]; the terminal step emit
    // anchors at 100). The label is "Uploading" mid-flight and
    // "Uploaded" on the terminal anchor — both are acceptable as long
    // as the stageCode stays on "uploading".
    console.info(`[${SUITE}:${label}] verifying ${ctx.recorded.progress.filter(p => p.code === "uploading").length} uploading entries clamping`);
    for (const entry of ctx.recorded.progress) {
      if (entry.code !== "uploading") continue;
      try {
        expect(entry.pct).toBeGreaterThanOrEqual(1);
        expect(entry.pct).toBeLessThanOrEqual(100);
        expect(["Uploading", "Uploaded"]).toContain(entry.label);
      } catch (err) {
        dumpBadgerIngestUploadingStageSnapshot(label, {
          jobId: "job-1",
          progressEvents: ctx.recorded.progress,
          terminalEntry: entry,
          expected: { pctInRange: "[1..100]", labelIn: ["Uploading", "Uploaded"] },
          actual: { pct: entry.pct, label: entry.label },
          error: err,
        });
        throw err;
      }
    }
  });

  it("anchors the terminal progress on stageCode='uploading' (not 'extracting') so the badge does not snap backward", async () => {
    const label = "terminal-anchored-uploading";
    console.info(`[${SUITE}:${label}] start`);
    // The legacy monolith returns AFTER both encode and upload are done.
    // The extract step must finish on 'uploading' (the most-recent real
    // phase) rather than re-emit 'extracting' at 100%.
    const deps = makeDeps({
      extractSource: vi.fn(async (input: ExtractInput) => {
        input.onProgress?.("uploading", 50);
        return baseExtract();
      }),
    });
    configureBadgerStepDeps(deps);
    const ctx = makeCtx(makeJob(), makeStep());
    console.info(`[${SUITE}:${label}] invoking extractStepHandler`);
    await extractStepHandler(ctx);

    const last = ctx.recorded.progress.at(-1);
    console.info(`[${SUITE}:${label}] last.code=${String(last?.code)} last.pct=${String(last?.pct)} progressEvents=${ctx.recorded.progress.length}`);
    try {
      expect(last).toBeDefined();
      expect(last?.code).toBe("uploading");
      expect(last?.pct).toBe(100);
    } catch (err) {
      dumpBadgerIngestUploadingStageSnapshot(label, {
        jobId: "job-1",
        progressEvents: ctx.recorded.progress,
        progressEventsCount: ctx.recorded.progress.length,
        terminalEntry: last,
        expected: { code: "uploading", pct: 100 },
        actual: { code: last?.code, pct: last?.pct },
        error: err,
      });
      throw err;
    }
  });
});

describe("BadgerModule.publishIngestJobsUpdate — bypass throttle on status change", () => {
  console.info(`[${SUITE}:describe] entering "BadgerModule.publishIngestJobsUpdate — bypass throttle on status change"`);
  const baseConfig = {
    enableCodecSelection: false,
    transcodeOutputs: [{ quality: "360p", codec: "h264" }],
    uiLanguage: "en" as const,
    token: "backend-token",
    libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
  };

  let module: BadgerModule;
  let publishedEvents: Array<{ channel: string; event: string; payload: Record<string, unknown> }>;

  beforeEach(async () => {
    runtimeJobsStore.reset();
    publishedEvents = [];
    module = new BadgerModule({ processMediaJob: vi.fn() });
    module.setEventPublisher((channel, event, payload) => {
      publishedEvents.push({ channel, event, payload });
    });
    console.info(`[${SUITE}:beforeEach] opening queue for user-throttle`);
    await module.execute({
      requestId: "open-throttle",
      module: "badger",
      command: "badger.ingest.open",
      payload: {
        userId: "user-throttle",
        config: baseConfig,
      },
    });
  });

  afterEach(() => {
    module.shutdown();
    console.info(`[${SUITE}:afterEach] module shutdown (publishedEvents=${publishedEvents.length})`);
  });

  const queueJob = async (jobId: string) => {
    await module.execute({
      requestId: `queue-${jobId}`,
      module: "badger",
      command: "badger.ingest.apply",
      payload: {
        userId: "user-throttle",
        actions: [
          {
            type: "queue_files",
            files: [
              {
                id: jobId,
                filename: `/tmp/${jobId}.mkv`,
                sizeMb: 10,
                includeSource: true,
                includeFallback: false,
                includeAudio: false,
                includeSubtitles: false,
                includeChapters: false,
                selectedFormats: [{ quality: "360p", codec: "h264" }],
              },
            ],
            preset: {
              media: {
                id: `${jobId}-media`,
                type: "movie" as const,
                tmdbId: 1,
                title: jobId,
                year: "2020",
                posterPath: "/p.jpg",
                originalLanguage: "en",
              },
            },
          },
        ],
      },
    });
  };

  const findJobsUpdated = (jobId: string) =>
    publishedEvents.filter(
      (e) =>
        e.channel === "ingest" &&
        e.event === "ingest.jobs_updated" &&
        Array.isArray(e.payload.jobs) &&
        (e.payload.jobs as Array<Record<string, unknown>>).some(
          (j) => j.id === jobId
        )
    );

  const jobStatus = (
    entry: { payload: Record<string, unknown> },
    jobId: string
  ): string | undefined => {
    const jobs = entry.payload.jobs as Array<Record<string, unknown>>;
    const found = jobs.find((j) => j.id === jobId);
    return found?.status as string | undefined;
  };

  it("publishes immediately when a job's status transitions, even within the 2s throttle window", async () => {
    const label = "publishes-immediately-on-status-change";
    console.info(`[${SUITE}:${label}] start`);
    await queueJob("job-status-change");
    publishedEvents.length = 0;

    const internal = module as unknown as {
      ingestUsers: Map<string, { userId: string; jobs: Array<{ id: string; status: string; progress?: number }> }>;
      publishIngestJobsUpdate: (state: unknown, force?: boolean) => void;
    };
    const state = internal.ingestUsers.get("user-throttle");
    console.info(`[${SUITE}:${label}] state defined=${state !== undefined}`);
    try {
      expect(state).toBeDefined();
    } catch (err) {
      dumpBadgerIngestUploadingStageSnapshot(label, {
        jobId: "job-status-change", userId: "user-throttle",
        expected: { stateDefined: true }, actual: { stateDefined: state !== undefined }, error: err,
      });
      throw err;
    }
    if (!state) return;
    const job = state.jobs.find((j) => j.id === "job-status-change");
    console.info(`[${SUITE}:${label}] job defined=${job !== undefined}`);
    try {
      expect(job).toBeDefined();
    } catch (err) {
      dumpBadgerIngestUploadingStageSnapshot(label, {
        jobId: "job-status-change",
        extra: { stateJobs: state.jobs.map((j) => j.id) },
        expected: { jobDefined: true }, actual: { jobDefined: job !== undefined }, error: err,
      });
      throw err;
    }
    if (!job) return;

    console.info(`[${SUITE}:${label}] phase A: burn initial publish (status=transcoding)`);
    // Burn an initial publish so lastIngestEventAt is recent (within 2s).
    job.status = "transcoding";
    job.progress = 10;
    internal.publishIngestJobsUpdate(state);

    console.info(`[${SUITE}:${label}] phase B: same-status progress update (should be throttled)`);
    // Same-status, different-progress publish a few ms later: should be
    // suppressed by the throttle (preserves no-fire-hose contract).
    job.progress = 20;
    internal.publishIngestJobsUpdate(state);

    console.info(`[${SUITE}:${label}] phase C: status flip to uploading (must bypass throttle)`);
    // Now flip status: must publish IMMEDIATELY, not wait for 2s.
    job.status = "uploading";
    job.progress = 1;
    internal.publishIngestJobsUpdate(state);

    const updates = findJobsUpdated("job-status-change");
    const statusesObserved = updates.map((u) => jobStatus(u, "job-status-change"));
    console.info(`[${SUITE}:${label}] updates=${updates.length} statuses=${JSON.stringify(statusesObserved)}`);
    try {
      // The renderer needs to see BOTH transcoding and uploading. Pre-fix
      // the second publish was suppressed by the 2s throttle and the
      // status change never reached the wire.
      expect(statusesObserved).toContain("transcoding");
      expect(statusesObserved).toContain("uploading");
    } catch (err) {
      dumpBadgerIngestUploadingStageSnapshot(label, {
        jobId: "job-status-change",
        userId: "user-throttle",
        publishedEvents,
        publishedEventsCount: publishedEvents.length,
        jobsUpdated: updates,
        jobsUpdatedCount: updates.length,
        statusesObserved,
        expectedStatuses: ["transcoding", "uploading"],
        actualStatuses: statusesObserved,
        error: err,
      });
      throw err;
    }
  });

  it("collapses same-status repeated publishes within the 2s throttle window (no fire-hose regression)", async () => {
    const label = "collapses-same-status-flood";
    console.info(`[${SUITE}:${label}] start`);
    await queueJob("job-no-flood");
    publishedEvents.length = 0;

    const internal = module as unknown as {
      ingestUsers: Map<string, { userId: string; jobs: Array<{ id: string; status: string; progress?: number }> }>;
      publishIngestJobsUpdate: (state: unknown, force?: boolean) => void;
    };
    const state = internal.ingestUsers.get("user-throttle")!;
    const job = state.jobs.find((j) => j.id === "job-no-flood")!;

    console.info(`[${SUITE}:${label}] phase A: pre-prime first publish (status=transcoding)`);
    // Pre-prime: get the first publish out so the throttle window is
    // engaged. Otherwise the very first publish always lands.
    job.status = "transcoding";
    internal.publishIngestJobsUpdate(state);
    publishedEvents.length = 0;

    console.info(`[${SUITE}:${label}] phase B: firing 20 same-status progress samples (must all throttle)`);
    // Twenty same-status progress samples within ~2 ms. All but zero of
    // these must be throttled because the status didn't change. Pre-fix
    // would also throttle them — but a regression that flipped the
    // bypass condition (e.g. always-bypass) would let them all through.
    for (let i = 0; i < 20; i++) {
      job.progress = i * 5;
      internal.publishIngestJobsUpdate(state);
    }

    const updates = findJobsUpdated("job-no-flood");
    console.info(`[${SUITE}:${label}] updates.length=${updates.length} (expected <=1)`);
    try {
      expect(updates.length).toBeLessThanOrEqual(1);
    } catch (err) {
      dumpBadgerIngestUploadingStageSnapshot(label, {
        jobId: "job-no-flood",
        userId: "user-throttle",
        publishedEvents,
        publishedEventsCount: publishedEvents.length,
        jobsUpdated: updates,
        jobsUpdatedCount: updates.length,
        expected: { jobsUpdatedCount: "<=1" },
        actual: { jobsUpdatedCount: updates.length },
        error: err,
      });
      throw err;
    }
  });
});
