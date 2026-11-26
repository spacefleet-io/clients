/**
 * @bugfix @regression-proof
 *
 * Bug #4 — audio language override dropped during ingest.
 *
 * Reproduction: a user opens the FileIngestionDialog for a file whose audio
 * track is tagged `und` in the container, types "English" as the override,
 * and submits. The encoded audio shipped with `language='und',
 * label='Undefined'` regardless of what the user picked.
 *
 * Root cause: the `submit_sources` contract had no slot for per-track
 * overrides, so they never reached the runtime. The encode-side path in
 * `packages/ingest-core/mediaProcessor.ts` already accepts
 * `audioTrackOverrides` / `subtitleTrackOverrides` and merges them at encode
 * time — the missing piece was the threading from contract → submit handler
 * payload → extract step → deps adapter → processMediaJob.
 *
 * Coverage in this file:
 *   1. The contract accepts audioOverrides / subtitleOverrides on a source
 *      item (covered in packages/runtime-contracts tests; cross-checked
 *      here via end-to-end runtime flow).
 *   2. The submit handler threads overrides into the source-job payload.
 *   3. The extract step reads them off the payload and passes them to
 *      deps.extractSource.
 *   4. The deps adapter forwards them as audioTrackOverrides /
 *      subtitleTrackOverrides to processMediaJob.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEngineV2,
  type EngineV2,
} from "@space/runtime-jobs-engine/engineV2";
import { registerBadgerStepHandlers } from "../src/modules/badger/steps";
import { createBadgerIngestSubmitHandler } from "../src/modules/badger/ingestSubmit";
import { extractStepHandler } from "../src/modules/badger/steps";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
  type ExtractResult,
  type ProbeResult,
  type IdentifyResult,
  type TranscodeResult,
  type UploadResult,
  type CommitResult,
} from "../src/modules/badger/steps/deps";
import {
  buildBadgerStepDeps,
  __resetBadgerStepDepsAdapter,
  type ProcessMediaJobFn,
} from "../src/modules/badger/steps/deps-adapter";
import type { StepHandlerCtx } from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "@space/runtime-jobs-engine/stepStore";

const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "job-src-1",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "running",
  stageCode: "running",
  stageLabel: "Running",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: {
    userId: "u1",
    filename: "/tmp/Orchard.mkv",
    audioOverrides: [
      { index: 0, language: "en", label: "English" },
      { index: 1, language: "fr", label: "French (5.1)" },
    ],
    subtitleOverrides: [{ index: 0, language: "en", label: "English" }],
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
  stepId: "job-src-1:extract",
  jobId: "job-src-1",
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

const makeCtx = (
  job: IngestJobRecord,
  step: StoredStepRecord
): StepHandlerCtx => ({
  job,
  step,
  signal: new AbortController().signal,
  reportProgress: () => {},
  emitOutputs: (out) => {
    for (const [k, v] of Object.entries(out)) {
      (step.outputs as Record<string, unknown>)[k] = v;
    }
  },
});

const baseDeps = (over: Partial<BadgerStepDeps> = {}): BadgerStepDeps => ({
  probe: vi.fn(
    async (): Promise<ProbeResult> => ({
      durationSeconds: 7200,
      videoCodec: "h264",
      videoWidth: 1920,
      videoHeight: 1080,
      sourceQuality: "1080p",
      audioStreamCount: 2,
      subtitleStreamCount: 1,
      streams: [],
      chapters: [],
    })
  ),
  identify: vi.fn(
    async (): Promise<IdentifyResult> => ({
      mediaId: "media-1",
      parsedTitle: "Orchard",
      season: null,
      episode: null,
      year: 2017,
      preexistingHint: true,
    })
  ),
  extractSource: vi.fn(
    async (): Promise<ExtractResult> => ({
      jobDir: "/tmp",
      state: {
        version: 1,
        inputPath: "/tmp/Orchard.mkv",
        userId: "u1",
        createdAt: ts,
        outputs: [],
        subtitles: [],
      },
      segmentCount: 1,
    })
  ),
  transcodeFormat: vi.fn(
    async (input): Promise<TranscodeResult> => ({
      jobDir: "/tmp",
      state: {
        version: 1,
        inputPath: "/tmp/Orchard.mkv",
        userId: "u1",
        createdAt: ts,
        outputs: [],
        subtitles: [],
      },
      segmentCount: 1,
      variant: input.variant,
    })
  ),
  uploadOutputs: vi.fn(
    async (): Promise<UploadResult> => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      uploadedKeys: [],
    })
  ),
  commit: vi.fn(
    async (): Promise<CommitResult> => ({ fileId: "file-1", formatIds: [] })
  ),
  markMediaPlayable: vi.fn(async () => undefined),
  ...over,
});

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps job payload + extractSource/processMediaJob
// call args on assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpAudioOverridesSnapshot = (
  label: string,
  ctx: {
    job?: IngestJobRecord;
    step?: StoredStepRecord;
    deps?: Partial<BadgerStepDeps>;
    processMediaJob?: ReturnType<typeof vi.fn>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-audio-overrides:${label}] snapshot ===`);
    if (ctx.job) {
      console.error(
        `job: id=${ctx.job.jobId} kind=${ctx.job.kind} variant=${ctx.job.variant}`,
      );
      console.error(`job.payload=\n${JSON.stringify(ctx.job.payload, null, 2)}`);
    }
    if (ctx.step) {
      console.error(`step.outputs=\n${JSON.stringify(ctx.step.outputs, null, 2)}`);
    }
    if (ctx.deps?.extractSource) {
      const fn = ctx.deps.extractSource as ReturnType<typeof vi.fn>;
      console.error(
        `deps.extractSource.calls=${JSON.stringify(fn.mock?.calls ?? "(not-a-vi-fn)", null, 2)}`,
      );
    }
    if (ctx.processMediaJob) {
      console.error(
        `processMediaJob.calls=${JSON.stringify(ctx.processMediaJob.mock?.calls ?? "(not-a-vi-fn)", null, 2)}`,
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

beforeEach(() => {
  console.info(
    `[badger-audio-overrides:setup] resetting badger step deps and adapter`,
  );
  __resetBadgerStepDeps();
  __resetBadgerStepDepsAdapter();
});

afterEach(() => {
  console.info(
    `[badger-audio-overrides:teardown] resetting badger step deps and adapter`,
  );
  __resetBadgerStepDeps();
  __resetBadgerStepDepsAdapter();
});

describe("@bugfix @regression-proof Bug #4 — audio language override threading", () => {
  it("submit handler writes audioOverrides and subtitleOverrides into the source-job payload", async () => {
    console.info(
      `[badger-audio-overrides:submit-writes-payload] starting engine and registering badger step handlers`,
    );
    const engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    registerBadgerStepHandlers(engine);
    try {
      const handler = createBadgerIngestSubmitHandler({ engine });
      const result = await handler({
        userId: "u1",
        sources: [
          {
            filename: "Orchard.mkv",
            sizeMb: 4096,
            desiredFormats: ["360p"],
            hints: { mediaId: "media-orchard" },
            audioOverrides: [
              { index: 0, language: "en", label: "English" },
            ],
            subtitleOverrides: [
              { index: 0, language: "en", label: "English" },
            ],
          },
        ],
      });
      const sourceJobId = result.submitted[0].sourceJobId;
      console.info(
        `[badger-audio-overrides:submit-writes-payload] submit returned sourceJobId=${sourceJobId}; fetching from engine`,
      );
      const found = await engine.get(sourceJobId);
      try {
        expect(found).not.toBeNull();
        const payload = found!.job.payload as Record<string, unknown>;
        console.info(
          `[badger-audio-overrides:submit-writes-payload] payload=${JSON.stringify(payload)}`,
        );
        expect(payload.audioOverrides).toEqual([
          { index: 0, language: "en", label: "English" },
        ]);
        expect(payload.subtitleOverrides).toEqual([
          { index: 0, language: "en", label: "English" },
        ]);
      } catch (err) {
        dumpAudioOverridesSnapshot("submit-writes-payload-failure", {
          job: found?.job,
          extra: { sourceJobId, result },
        });
        throw err;
      }
    } finally {
      await engine.stop();
    }
  });

  it("extract step reads audioOverrides from job payload and passes them to deps.extractSource", async () => {
    console.info(
      `[badger-audio-overrides:extract-reads-payload] running extract step with full overrides in payload`,
    );
    const deps = baseDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob();
    const step = makeStep();
    const ctx = makeCtx(job, step);
    await extractStepHandler(ctx);
    const extractCalls = (deps.extractSource as ReturnType<typeof vi.fn>).mock
      .calls;
    console.info(
      `[badger-audio-overrides:extract-reads-payload] extractSource called ${extractCalls.length}x; firstArg=${JSON.stringify(extractCalls[0]?.[0])}`,
    );
    try {
      expect(deps.extractSource).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "u1",
          jobId: "job-src-1",
          inputPath: "/tmp/Orchard.mkv",
          audioOverrides: [
            { index: 0, language: "en", label: "English" },
            { index: 1, language: "fr", label: "French (5.1)" },
          ],
          subtitleOverrides: [{ index: 0, language: "en", label: "English" }],
        })
      );
    } catch (err) {
      dumpAudioOverridesSnapshot("extract-reads-payload-failure", {
        job,
        step,
        deps,
      });
      throw err;
    }
  });

  it("extract step defaults to empty arrays when payload has no overrides (backwards-compat)", async () => {
    console.info(
      `[badger-audio-overrides:defaults-empty] payload without overrides; expecting deps.extractSource called with []/[]`,
    );
    const deps = baseDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob({
      payload: { userId: "u1", filename: "/tmp/movie.mkv" },
    });
    const step = makeStep();
    const ctx = makeCtx(job, step);
    await extractStepHandler(ctx);
    const extractCalls = (deps.extractSource as ReturnType<typeof vi.fn>).mock
      .calls;
    console.info(
      `[badger-audio-overrides:defaults-empty] extractSource firstArg=${JSON.stringify(extractCalls[0]?.[0])}`,
    );
    try {
      expect(deps.extractSource).toHaveBeenCalledWith(
        expect.objectContaining({
          audioOverrides: [],
          subtitleOverrides: [],
        })
      );
    } catch (err) {
      dumpAudioOverridesSnapshot("defaults-empty-failure", { job, step, deps });
      throw err;
    }
  });

  it("extract step ignores malformed override entries (defensive read)", async () => {
    console.info(
      `[badger-audio-overrides:defensive-malformed] payload contains 5 invalid entries among valid ones; expect only the 2 valid kept`,
    );
    const deps = baseDeps();
    configureBadgerStepDeps(deps);
    const job = makeJob({
      payload: {
        userId: "u1",
        filename: "/tmp/movie.mkv",
        audioOverrides: [
          { index: 0, language: "en", label: "English" },
          { index: "not-a-number", language: "fr", label: "French" }, // bad index type
          { index: -1, language: "es", label: "Spanish" }, // negative index
          null,
          "garbage",
          { index: 1, language: 5, label: "?" }, // bad language type
          { index: 2, language: "de", label: "German" },
        ],
      },
    });
    const step = makeStep();
    const ctx = makeCtx(job, step);
    await extractStepHandler(ctx);
    const call = (deps.extractSource as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    console.info(
      `[badger-audio-overrides:defensive-malformed] extractSource received audioOverrides=${JSON.stringify(call.audioOverrides)}`,
    );
    try {
      expect(call.audioOverrides).toEqual([
        { index: 0, language: "en", label: "English" },
        { index: 2, language: "de", label: "German" },
      ]);
    } catch (err) {
      dumpAudioOverridesSnapshot("defensive-malformed-failure", {
        job,
        step,
        deps,
      });
      throw err;
    }
  });

  it("deps adapter forwards audioOverrides as audioTrackOverrides into processMediaJob", async () => {
    console.info(
      `[badger-audio-overrides:adapter-forwards] driving deps.extractSource through the adapter with overrides`,
    );
    const processMediaJob = vi.fn(async () => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu",
    })) as unknown as ProcessMediaJobFn;
    const libraryDb = {
      call: vi.fn(async () => null),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob,
      resolveToken: () => "test-token",
      resolveLibraryKey: () => "key",
    });

    await deps.extractSource({
      userId: "u1",
      jobId: "job-1",
      placementId: "placement-job-1",
      inputPath: "/tmp/Orchard.mkv",
      audioOverrides: [{ index: 0, language: "en", label: "English" }],
      subtitleOverrides: [{ index: 0, language: "en", label: "Eng-Sub" }],
      signal: new AbortController().signal,
    });
    const pmjCalls = (processMediaJob as ReturnType<typeof vi.fn>).mock.calls;
    console.info(
      `[badger-audio-overrides:adapter-forwards] processMediaJob called ${pmjCalls.length}x; firstArg.audioTrackOverrides=${JSON.stringify((pmjCalls[0]?.[0] as Record<string, unknown> | undefined)?.audioTrackOverrides)}`,
    );

    try {
      expect(processMediaJob).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "u1",
          jobId: "job-1",
          // Critical: the deps adapter passes overrides under the names
          // mediaProcessor.ts expects (audioTrackOverrides /
          // subtitleTrackOverrides). Pre-fix these were never set.
          audioTrackOverrides: [
            { index: 0, language: "en", label: "English" },
          ],
          subtitleTrackOverrides: [
            { index: 0, language: "en", label: "Eng-Sub" },
          ],
        })
      );
    } catch (err) {
      dumpAudioOverridesSnapshot("adapter-forwards-failure", {
        processMediaJob: processMediaJob as unknown as ReturnType<typeof vi.fn>,
      });
      throw err;
    }
  });

  it("deps adapter omits overrides when none are provided", async () => {
    console.info(
      `[badger-audio-overrides:adapter-omits-when-absent] deps.extractSource called without overrides; adapter should not set them on processMediaJob`,
    );
    const processMediaJob = vi.fn(async () => ({
      produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
      encoder: "cpu",
    })) as unknown as ProcessMediaJobFn;
    const libraryDb = {
      call: vi.fn(async () => null),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob,
      resolveToken: () => "test-token",
      resolveLibraryKey: () => "key",
    });

    await deps.extractSource({
      userId: "u1",
      jobId: "job-1",
      placementId: "placement-job-1",
      inputPath: "/tmp/Orchard.mkv",
      signal: new AbortController().signal,
    });

    const call = (processMediaJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    console.info(
      `[badger-audio-overrides:adapter-omits-when-absent] processMediaJob firstArg.audioTrackOverrides=${JSON.stringify(call.audioTrackOverrides)} subtitleTrackOverrides=${JSON.stringify(call.subtitleTrackOverrides)}`,
    );
    try {
      expect(call.audioTrackOverrides).toBeUndefined();
      expect(call.subtitleTrackOverrides).toBeUndefined();
    } catch (err) {
      dumpAudioOverridesSnapshot("adapter-omits-when-absent-failure", {
        processMediaJob: processMediaJob as unknown as ReturnType<typeof vi.fn>,
      });
      throw err;
    }
  });
});
