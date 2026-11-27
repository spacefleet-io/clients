/**
 * @bugfix @regression-proof
 *
 * Bug #11 — 360p (and any non-source) format variant invisible in playback.
 *
 * Root cause: V2 ingest engine seeded `FORMAT_STEPS = ["transcode", "upload"]`
 * with NO commit step. The 360p chunks uploaded to storage successfully, but
 * nothing wrote a `media_formats` row referencing them, so playback only saw
 * the source-job's 1080p row. The format-commit branch in deps-adapter also
 * passed `mediaId` as the `fileId` argument to `addMediaFormat`, which would
 * have FK-failed (or stored a corrupt row) once the step actually ran.
 *
 * This regression test asserts the post-fix behavior in two layers:
 *   1. FORMAT_STEPS includes "commit" so the engine seeds it.
 *   2. The commit step handler, when running for a format job, looks up the
 *      parent source-job's committed file_id via deps.lookupParentSourceFileId
 *      and threads it into deps.commit() as `sourceFileId` — never substitutes
 *      the mediaId.
 *   3. The deps-adapter's format-commit branch uses sourceFileId (NOT mediaId)
 *      when calling addMediaFormat, and fails loud when sourceFileId is
 *      missing rather than silently writing a corrupt row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitStepHandler } from "../src/modules/badger/steps";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
  type CommitInput,
  type CommitResult,
  type ProbeResult,
  type IdentifyResult,
  type ExtractResult,
  type TranscodeResult,
  type UploadResult,
} from "../src/modules/badger/steps/deps";
import { buildBadgerStepDeps } from "../src/modules/badger/steps/deps-adapter";
import type { StepHandlerCtx } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";

const ts = "2026-01-01T00:00:00.000Z";

const makeFormatJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "fmt-360p",
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
    filename: "/tmp/Orchard.mkv",
    variant: "360p",
    parentSourceJobId: "src-orchard",
  },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 1,
  dedupeKey: null,
  createdAt: ts,
  updatedAt: ts,
  startedAt: ts,
  finishedAt: null,
  groupId: "media-orchard",
  mediaId: "media-orchard",
  variant: "360p",
  parentJobIds: ["src-orchard"],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

const makeStep = (overrides: Partial<StoredStepRecord> = {}): StoredStepRecord => ({
  stepId: "fmt-360p:commit",
  jobId: "fmt-360p",
  ordinal: 2,
  kind: "commit",
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
  outputs: { uploadResult: { produced: makeProduced() } },
  createdAt: ts,
  updatedAt: ts,
  ...overrides,
});

function makeProduced(): ProducedMedia {
  return {
    videoFormats: [
      {
        quality: "360p",
        codec: "h264",
        codecString: "avc1.4d401e",
        initKey: "k:360p:init",
        initSize: 100,
        durationSeconds: 7200,
        totalSize: 250_000,
        chunks: [{ key: "k:360p:1", sizeBytes: 25_000, startSeconds: 0 }],
        chapters: [],
      },
    ],
    audioTracks: [],
    subtitleTracks: [],
  };
}

const makeCtx = (
  job: IngestJobRecord,
  step: StoredStepRecord,
  signal: AbortSignal = new AbortController().signal
): StepHandlerCtx => ({
  job,
  step,
  signal,
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
      audioStreamCount: 1,
      subtitleStreamCount: 0,
      streams: [],
      chapters: [],
    })
  ),
  identify: vi.fn(
    async (): Promise<IdentifyResult> => ({
      mediaId: "media-orchard",
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
        userId: "user-1",
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
        userId: "user-1",
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
      produced: makeProduced(),
      uploadedKeys: ["k:360p:init", "k:360p:1"],
    })
  ),
  commit: vi.fn(
    async (): Promise<CommitResult> => ({ fileId: "file-orchard-src", formatIds: ["fmt-360p-row"] })
  ),
  markMediaPlayable: vi.fn(async () => undefined),
  ...over,
});

// ---------------------------------------------------------------------------
// Diagnostic snapshot helper — dumps step-handler context + deps-call state
// on assertion failure. Wrapped in try/catch so a dump-failure cannot mask
// the assertion failure.
// ---------------------------------------------------------------------------
const dumpFormatCommitSnapshot = (
  label: string,
  ctx: {
    job?: IngestJobRecord;
    step?: StoredStepRecord;
    deps?: Partial<BadgerStepDeps>;
    libraryDbCalls?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-format-commit:${label}] snapshot ===`);
    if (ctx.job) {
      console.error(
        `job: id=${ctx.job.jobId} kind=${ctx.job.kind} mediaId=${ctx.job.mediaId} variant=${ctx.job.variant}`,
      );
      console.error(`job.payload=\n${JSON.stringify(ctx.job.payload, null, 2)}`);
      console.error(
        `job.parentJobIds=${JSON.stringify(ctx.job.parentJobIds)}`,
      );
    }
    if (ctx.step) {
      console.error(
        `step: id=${ctx.step.stepId} kind=${ctx.step.kind} status=${ctx.step.status}`,
      );
      console.error(`step.outputs=\n${JSON.stringify(ctx.step.outputs, null, 2)}`);
    }
    if (ctx.deps) {
      const commitMock = ctx.deps.commit as ReturnType<typeof vi.fn> | undefined;
      const markMock = ctx.deps.markMediaPlayable as
        | ReturnType<typeof vi.fn>
        | undefined;
      const lookupMock = ctx.deps.lookupParentSourceFileId as
        | ReturnType<typeof vi.fn>
        | undefined;
      console.error(
        `deps.commit.calls=${JSON.stringify(commitMock?.mock?.calls ?? "(not-a-vi-fn)", null, 2)}`,
      );
      console.error(
        `deps.markMediaPlayable.calls=${JSON.stringify(markMock?.mock?.calls ?? "(not-a-vi-fn)", null, 2)}`,
      );
      console.error(
        `deps.lookupParentSourceFileId.calls=${JSON.stringify(lookupMock?.mock?.calls ?? "(not-a-vi-fn)", null, 2)}`,
      );
    }
    if (ctx.libraryDbCalls !== undefined) {
      console.error(
        `libraryDb.call invocations=\n${JSON.stringify(ctx.libraryDbCalls, null, 2)}`,
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
  console.info(`[badger-format-commit:setup] resetting badger step deps`);
  __resetBadgerStepDeps();
});

afterEach(() => {
  console.info(`[badger-format-commit:teardown] resetting badger step deps`);
  __resetBadgerStepDeps();
});

describe("@bugfix @regression-proof Bug #11 — format-job commit step", () => {
  it("FORMAT_STEPS includes 'commit' so the engine seeds the step", async () => {
    console.info(
      `[badger-format-commit:seed-commit-step] starting engine + submitting format job to inspect seeded step kinds`,
    );
    // The engine factory module (engineV2.ts) keeps FORMAT_STEPS module-private
    // — we read the current step set indirectly through the engine surface to
    // avoid relying on the constant export. Submit a format job and assert the
    // commit step exists.
    const { createEngineV2 } = await import("../src/core/jobs/engineV2");
    const engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    const fmtJob: IngestJobRecord = makeFormatJob({
      jobId: "fmt-test-seed",
      status: "queued",
      stageCode: "queued",
      stageLabel: "Queued",
      startedAt: null,
      parentJobIds: [],
      payload: {
        userId: "user-1",
        filename: "/tmp/Orchard.mkv",
        variant: "360p",
        parentSourceJobId: "src-orchard",
      },
    });
    try {
      await engine.submit(fmtJob);
      const found = await engine.get("fmt-test-seed");
      console.info(
        `[badger-format-commit:seed-commit-step] engine.get returned ${found === null ? "null" : `job with ${found.steps.length} steps`}`,
      );
      try {
        expect(found).not.toBeNull();
        const stepKinds = found!.steps.map((s) => s.kind);
        console.info(
          `[badger-format-commit:seed-commit-step] stepKinds=${JSON.stringify(stepKinds)}`,
        );
        expect(stepKinds).toContain("commit");
        // Pre-fix this would have been ["transcode", "upload"] only.
        expect(stepKinds).toEqual(["transcode", "upload", "commit"]);
      } catch (err) {
        dumpFormatCommitSnapshot("seed-commit-step-failure", {
          job: fmtJob,
          extra: {
            engineGetReturned: found === null ? "null" : "non-null",
            stepKinds: found?.steps.map((s) => s.kind),
            steps: found?.steps,
          },
        });
        throw err;
      }
    } finally {
      await engine.stop();
    }
  });

  it("commitStepHandler resolves parent fileId via deps.lookupParentSourceFileId for format jobs", async () => {
    console.info(
      `[badger-format-commit:resolve-parent-file-id] configuring deps with lookup → "file-orchard-src"`,
    );
    const lookup = vi.fn(async (parentId: string) => {
      expect(parentId).toBe("src-orchard");
      return "file-orchard-src" as string | null;
    });
    const deps = baseDeps({ lookupParentSourceFileId: lookup });
    configureBadgerStepDeps(deps);

    const job = makeFormatJob();
    const step = makeStep();
    const ctx = makeCtx(job, step);
    await commitStepHandler(ctx);
    console.info(
      `[badger-format-commit:resolve-parent-file-id] commit handler returned; lookup.calls=${lookup.mock.calls.length} commit.calls=${(deps.commit as ReturnType<typeof vi.fn>).mock.calls.length}`,
    );

    try {
      expect(lookup).toHaveBeenCalledOnce();
      expect(deps.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "format",
          variant: "360p",
          // The fix: sourceFileId is the parent's media_files.id, NOT mediaId.
          sourceFileId: "file-orchard-src",
          mediaId: "media-orchard",
        })
      );
      // markMediaPlayable must NOT fire for format jobs (only sources flip
      // playability). Regression-proof against accidental wiring.
      expect(deps.markMediaPlayable).not.toHaveBeenCalled();
    } catch (err) {
      dumpFormatCommitSnapshot("resolve-parent-file-id-failure", {
        job,
        step,
        deps,
      });
      throw err;
    }
  });

  it("commit step handler fails loud when parent fileId cannot be resolved", async () => {
    console.info(
      `[badger-format-commit:lookup-returns-null] configuring deps with lookup → null; expecting STEP_COMMIT_PARENT_FILE_ID_NOT_FOUND`,
    );
    const deps = baseDeps({ lookupParentSourceFileId: vi.fn(async () => null) });
    configureBadgerStepDeps(deps);
    const job = makeFormatJob();
    const step = makeStep();
    const ctx = makeCtx(job, step);
    try {
      await expect(commitStepHandler(ctx)).rejects.toThrow(
        /STEP_COMMIT_PARENT_FILE_ID_NOT_FOUND/
      );
      // The deps.commit must NOT be called at all — the handler refuses to
      // proceed without a valid sourceFileId.
      expect(deps.commit).not.toHaveBeenCalled();
    } catch (err) {
      dumpFormatCommitSnapshot("lookup-returns-null-failure", {
        job,
        step,
        deps,
      });
      throw err;
    }
  });

  it("commit step handler fails loud when deps.lookupParentSourceFileId is unwired", async () => {
    console.info(
      `[badger-format-commit:lookup-unwired] deleting deps.lookupParentSourceFileId; expecting STEP_COMMIT_PARENT_LOOKUP_NOT_WIRED`,
    );
    const deps = baseDeps();
    delete (deps as Partial<BadgerStepDeps>).lookupParentSourceFileId;
    configureBadgerStepDeps(deps);
    const job = makeFormatJob();
    const step = makeStep();
    const ctx = makeCtx(job, step);
    try {
      await expect(commitStepHandler(ctx)).rejects.toThrow(
        /STEP_COMMIT_PARENT_LOOKUP_NOT_WIRED/
      );
      expect(deps.commit).not.toHaveBeenCalled();
    } catch (err) {
      dumpFormatCommitSnapshot("lookup-unwired-failure", { job, step, deps });
      throw err;
    }
  });

  it("commit step handler falls back to parentJobIds[0] when payload.parentSourceJobId is absent", async () => {
    console.info(
      `[badger-format-commit:fallback-parentJobIds] payload omits parentSourceJobId; expecting lookup called with parentJobIds[0]`,
    );
    const lookup = vi.fn(async () => "file-orchard-src" as string | null);
    const deps = baseDeps({ lookupParentSourceFileId: lookup });
    configureBadgerStepDeps(deps);
    const job = makeFormatJob({
      payload: { userId: "user-1", filename: "/tmp/Orchard.mkv", variant: "360p" },
      parentJobIds: ["src-orchard-fallback"],
    });
    const step = makeStep();
    await commitStepHandler(makeCtx(job, step));
    console.info(
      `[badger-format-commit:fallback-parentJobIds] lookup called with ${JSON.stringify(lookup.mock.calls[0])}`,
    );
    try {
      expect(lookup).toHaveBeenCalledWith("src-orchard-fallback");
    } catch (err) {
      dumpFormatCommitSnapshot("fallback-parentJobIds-failure", {
        job,
        step,
        deps,
      });
      throw err;
    }
  });

  it("deps-adapter format-commit calls addMediaFormat with sourceFileId, NOT mediaId", async () => {
    console.info(
      `[badger-format-commit:deps-adapter-uses-sourceFileId] running format-commit via adapter; expecting addMediaFormat(mediaId, sourceFileId)`,
    );
    // This is the load-bearing assertion for the data-integrity slice of the
    // bug: addMediaFormat MUST be invoked with the parent source job's
    // media_files.id as the file_id argument. Pre-fix the adapter passed
    // `input.mediaId` here, which would have FK-failed.
    type CallArgs = [string, unknown[]];
    const calls: CallArgs[] = [];
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        calls.push([method, args]);
        if (method === "addMediaFormat") return "fmt-360p-row";
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: vi.fn() as unknown as Parameters<
        typeof buildBadgerStepDeps
      >[0]["processMediaJob"],
    });

    const result = await deps.commit({
      userId: "user-1",
      jobId: "fmt-360p",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "format",
      variant: "360p",
      produced: makeProduced(),
      sourceFileId: "file-orchard-src",
      signal: new AbortController().signal,
    });
    console.info(
      `[badger-format-commit:deps-adapter-uses-sourceFileId] commit returned fileId=${result.fileId} formatIds=${JSON.stringify(result.formatIds)} totalLibraryDbCalls=${calls.length}`,
    );

    try {
      expect(result.fileId).toBe("file-orchard-src");
      expect(result.formatIds).toEqual(["fmt-360p-row"]);

      const addFmt = calls.find(([m]) => m === "addMediaFormat");
      console.info(
        `[badger-format-commit:deps-adapter-uses-sourceFileId] addMediaFormat args=${JSON.stringify(addFmt?.[1])}`,
      );
      expect(addFmt).toBeDefined();
      const args = addFmt![1];
      // Position [0] = mediaId, [1] = fileId.
      expect(args[0]).toBe("media-orchard");
      expect(args[1]).toBe("file-orchard-src");
      // Explicit guard against the pre-fix corruption mode.
      expect(args[1]).not.toBe(args[0]);
    } catch (err) {
      dumpFormatCommitSnapshot("deps-adapter-uses-sourceFileId-failure", {
        libraryDbCalls: calls,
        extra: { result },
      });
      throw err;
    }
  });

  it("deps-adapter format-commit fails loud when sourceFileId is missing", async () => {
    console.info(
      `[badger-format-commit:missing-sourceFileId] sourceFileId=null; expecting STEP_COMMIT_FORMAT_MISSING_SOURCE_FILE_ID and zero libraryDb calls`,
    );
    const libraryDb = {
      call: vi.fn(async () => null),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: vi.fn() as unknown as Parameters<
        typeof buildBadgerStepDeps
      >[0]["processMediaJob"],
    });

    const input: CommitInput = {
      userId: "user-1",
      jobId: "fmt-360p",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "format",
      variant: "360p",
      produced: makeProduced(),
      sourceFileId: null,
      signal: new AbortController().signal,
    };

    try {
      await expect(deps.commit(input)).rejects.toThrow(
        /STEP_COMMIT_FORMAT_MISSING_SOURCE_FILE_ID/
      );
      console.info(
        `[badger-format-commit:missing-sourceFileId] libraryDb.call invocations=${(libraryDb.call as ReturnType<typeof vi.fn>).mock.calls.length} (expect 0)`,
      );
      // Critically: addMediaFormat must NOT have been called. Pre-fix this
      // would have called it with mediaId substituted for fileId.
      expect(libraryDb.call).not.toHaveBeenCalled();
    } catch (err) {
      dumpFormatCommitSnapshot("missing-sourceFileId-failure", {
        libraryDbCalls: (libraryDb.call as ReturnType<typeof vi.fn>).mock.calls,
        extra: { input },
      });
      throw err;
    }
  });
});
