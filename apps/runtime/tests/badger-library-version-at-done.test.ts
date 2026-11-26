/**
 * @bugfix @regression-proof
 *
 * Phase 3 — Cross-stream version correlation
 *
 * Symptom (from Phase 0 baseline + ui-driver run): the play button
 * stayed disabled for 3-5 s after the source job hit `done` because
 * the renderer had to wait for the matching `library.updated` snapshot
 * (with `hasFiles=true`) to land on a SECOND SSE stream. The two
 * streams are uncoordinated; their relative arrival order on the
 * renderer is not guaranteed.
 *
 * Fix: the badger commit step records the library DB version AFTER
 * its coalesced snapshot publish (Phase 2 batch terminal) onto
 * `step.outputs.commitResult.libraryVersionAtDone`. EngineV2 reads
 * that field on the commit step's outputs and attaches it to the
 * `runtime.jobs.succeeded` event payload as `libraryVersionAtDone`.
 *
 * The renderer (Phase 3 part B) gates the play button on
 * `hasFiles && (libraryVersionAtDone == null ||
 * currentLibraryVersion >= libraryVersionAtDone)`. So even if the
 * succeeded event lands BEFORE the matching library snapshot, the
 * UI waits — and if the snapshot has already landed, the UI activates
 * immediately. Cross-stream race closed without merging streams.
 *
 * This file pins the runtime side: the contract carries the field,
 * the commit step records the version, and engineV2 attaches it on
 * succeeded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEngineV2,
  type EngineV2,
  type RuntimeJobEvent,
} from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
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
import { commitStepHandler } from "../src/modules/badger/steps";
import type { StepHandlerCtx } from "@space/runtime-jobs-engine/engineV2";
import type { StoredStepRecord } from "@space/runtime-jobs-engine/stepStore";

const SUITE = "badger-library-version-at-done";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerLibraryVersionAtDoneSnapshot = (
  label: string,
  ctx: {
    jobId?: string;
    mediaId?: string;
    callOrder?: unknown;
    dbVersion?: number;
    libraryVersionAtDone?: number | undefined;
    commitResult?: unknown;
    recordedOutputs?: unknown;
    recordedOutputsCount?: number;
    events?: unknown;
    eventsCount?: number;
    succeededEvent?: unknown;
    failedEvent?: unknown;
    succeededPayload?: unknown;
    failedPayload?: unknown;
    expected?: unknown;
    actual?: unknown;
    jobKind?: string;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-library-version-at-done snapshot ===`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.mediaId !== undefined) console.error(`mediaId: ${ctx.mediaId}`);
    if (ctx.jobKind !== undefined) console.error(`jobKind: ${ctx.jobKind}`);
    if (ctx.callOrder !== undefined) {
      console.error(`callOrder:\n${JSON.stringify(ctx.callOrder, jsonReplacer, 2)}`);
    }
    if (ctx.dbVersion !== undefined) console.error(`dbVersion: ${ctx.dbVersion}`);
    if (ctx.libraryVersionAtDone !== undefined) {
      console.error(`libraryVersionAtDone: ${ctx.libraryVersionAtDone}`);
    }
    if (ctx.commitResult !== undefined) {
      console.error(`commitResult:\n${JSON.stringify(ctx.commitResult, jsonReplacer, 2)}`);
    }
    if (ctx.recordedOutputs !== undefined) {
      console.error(`recordedOutputs:\n${JSON.stringify(ctx.recordedOutputs, jsonReplacer, 2)}`);
    }
    if (ctx.recordedOutputsCount !== undefined) {
      console.error(`recordedOutputsCount: ${ctx.recordedOutputsCount}`);
    }
    if (ctx.events !== undefined) {
      console.error(`events:\n${JSON.stringify(ctx.events, jsonReplacer, 2)}`);
    }
    if (ctx.eventsCount !== undefined) console.error(`eventsCount: ${ctx.eventsCount}`);
    if (ctx.succeededEvent !== undefined) {
      console.error(`succeededEvent:\n${JSON.stringify(ctx.succeededEvent, jsonReplacer, 2)}`);
    }
    if (ctx.failedEvent !== undefined) {
      console.error(`failedEvent:\n${JSON.stringify(ctx.failedEvent, jsonReplacer, 2)}`);
    }
    if (ctx.succeededPayload !== undefined) {
      console.error(`succeededPayload:\n${JSON.stringify(ctx.succeededPayload, jsonReplacer, 2)}`);
    }
    if (ctx.failedPayload !== undefined) {
      console.error(`failedPayload:\n${JSON.stringify(ctx.failedPayload, jsonReplacer, 2)}`);
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
  payload: { userId: "u1", filename: "/tmp/m.mkv", hints: {} },
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

describe("commit step records libraryVersionAtDone on commitResult outputs", () => {
  console.info(`[${SUITE}:describe] entering "commit step records libraryVersionAtDone on commitResult outputs"`);
  beforeEach(() => {
    __resetBadgerStepDeps();
    console.info(`[${SUITE}:beforeEach] reset deps`);
  });

  afterEach(() => {
    __resetBadgerStepDeps();
    vi.restoreAllMocks();
    console.info(`[${SUITE}:afterEach] reset deps & mocks`);
  });

  it("calls deps.getLibraryVersion AFTER the runBatch resolves and includes the value on commitResult", async () => {
    const label = "getLibraryVersion-after-runBatch";
    console.info(`[${SUITE}:${label}] start`);
    // Track the order in which deps methods are called so we can prove
    // getLibraryVersion fires AFTER markMediaPlayable's writes (i.e.
    // after the batch's terminal version is realized).
    const callOrder: string[] = [];
    let dbVersion = 100;
    const deps: BadgerStepDeps = {
      probe: vi.fn(async () => ({}) as ProbeResult),
      identify: vi.fn(async () => ({}) as IdentifyResult),
      extractSource: vi.fn(async () => ({}) as ExtractResult),
      transcodeFormat: vi.fn(async () => ({}) as TranscodeResult),
      uploadOutputs: vi.fn(async () => ({}) as UploadResult),
      commit: vi.fn(async (_input: CommitInput): Promise<CommitResult> => {
        callOrder.push("commit");
        dbVersion += 5;
        return { fileId: "file-1", formatIds: ["fmt-1"] };
      }),
      markMediaPlayable: vi.fn(async () => {
        callOrder.push("markMediaPlayable");
        dbVersion += 1;
      }),
      runLibraryBatch: async <T,>(_label: string, fn: () => Promise<T>): Promise<T> => {
        callOrder.push("runBatch:enter");
        const r = await fn();
        callOrder.push("runBatch:exit");
        return r;
      },
      getLibraryVersion: vi.fn(() => {
        callOrder.push(`getLibraryVersion(${dbVersion})`);
        return dbVersion;
      }),
    };
    configureBadgerStepDeps(deps);

    const recorded: { outputs: Array<Record<string, unknown>> } = { outputs: [] };
    const ctx: StepHandlerCtx = {
      job: makeJob({ jobId: "job-vad-1" }),
      step: {
        stepId: "job-vad-1:commit",
        jobId: "job-vad-1",
        ordinal: 4,
        kind: "commit",
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
      } satisfies StoredStepRecord,
      signal: new AbortController().signal,
      reportProgress: () => {},
      emitOutputs: (out) => {
        recorded.outputs.push(out);
      },
    };

    console.info(`[${SUITE}:${label}] invoking commitStepHandler`);
    await commitStepHandler(ctx);

    console.info(`[${SUITE}:${label}] callOrder=${JSON.stringify(callOrder)}`);
    try {
      // Order proves the version is captured AFTER both writes AND after
      // the batch's terminal resolution.
      expect(callOrder).toEqual([
        "runBatch:enter",
        "commit",
        "markMediaPlayable",
        "runBatch:exit",
        "getLibraryVersion(106)",
      ]);
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "job-vad-1",
        dbVersion,
        callOrder,
        recordedOutputs: recorded.outputs,
        recordedOutputsCount: recorded.outputs.length,
        expected: [
          "runBatch:enter",
          "commit",
          "markMediaPlayable",
          "runBatch:exit",
          "getLibraryVersion(106)",
        ],
        actual: callOrder,
        error: err,
      });
      throw err;
    }

    const commitResult = recorded.outputs[0]?.commitResult as
      | { libraryVersionAtDone?: number }
      | undefined;
    console.info(`[${SUITE}:${label}] recordedOutputs.length=${recorded.outputs.length} libraryVersionAtDone=${commitResult?.libraryVersionAtDone}`);
    try {
      // The recorded commitResult carries libraryVersionAtDone=106
      // (initial 100 + 5 from commit + 1 from markMediaPlayable).
      expect(recorded.outputs.length).toBe(1);
      expect(commitResult?.libraryVersionAtDone).toBe(106);
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "job-vad-1",
        dbVersion,
        callOrder,
        commitResult,
        recordedOutputs: recorded.outputs,
        recordedOutputsCount: recorded.outputs.length,
        libraryVersionAtDone: commitResult?.libraryVersionAtDone,
        expected: { outputs: 1, libraryVersionAtDone: 106 },
        actual: {
          outputs: recorded.outputs.length,
          libraryVersionAtDone: commitResult?.libraryVersionAtDone,
        },
        error: err,
      });
      throw err;
    }
  });

  it("omits libraryVersionAtDone when deps.getLibraryVersion is undefined (back-compat with legacy test setups)", async () => {
    const label = "omits-when-getLibraryVersion-undefined";
    console.info(`[${SUITE}:${label}] start`);
    const deps: BadgerStepDeps = {
      probe: vi.fn(async () => ({}) as ProbeResult),
      identify: vi.fn(async () => ({}) as IdentifyResult),
      extractSource: vi.fn(async () => ({}) as ExtractResult),
      transcodeFormat: vi.fn(async () => ({}) as TranscodeResult),
      uploadOutputs: vi.fn(async () => ({}) as UploadResult),
      commit: vi.fn(async (): Promise<CommitResult> => ({
        fileId: "file-1",
        formatIds: [],
      })),
      markMediaPlayable: vi.fn(async () => {}),
      // Deliberately omit getLibraryVersion so we test the optional path.
    };
    configureBadgerStepDeps(deps);

    const recorded: { outputs: Array<Record<string, unknown>> } = { outputs: [] };
    const ctx: StepHandlerCtx = {
      job: makeJob({ jobId: "job-vad-2" }),
      step: {
        stepId: "job-vad-2:commit",
        jobId: "job-vad-2",
        ordinal: 4,
        kind: "commit",
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
      } satisfies StoredStepRecord,
      signal: new AbortController().signal,
      reportProgress: () => {},
      emitOutputs: (out) => {
        recorded.outputs.push(out);
      },
    };

    console.info(`[${SUITE}:${label}] invoking commitStepHandler`);
    await commitStepHandler(ctx);

    const commitResult = recorded.outputs[0]?.commitResult as
      | { libraryVersionAtDone?: number; fileId: string }
      | undefined;
    console.info(`[${SUITE}:${label}] commitResult.fileId=${commitResult?.fileId} hasLibraryVersionAtDone=${Object.prototype.hasOwnProperty.call(commitResult ?? {}, "libraryVersionAtDone")}`);
    try {
      expect(commitResult?.fileId).toBe("file-1");
      // Field is OMITTED, not set to a sentinel — schema-aligned with the
      // optional-undefined contract. Renderers fall back to gating on
      // `hasFiles` alone.
      expect(commitResult).not.toHaveProperty("libraryVersionAtDone");
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "job-vad-2",
        commitResult,
        recordedOutputs: recorded.outputs,
        recordedOutputsCount: recorded.outputs.length,
        expected: { fileId: "file-1", hasLibraryVersionAtDone: false },
        actual: {
          fileId: commitResult?.fileId,
          hasLibraryVersionAtDone: Object.prototype.hasOwnProperty.call(
            commitResult ?? {},
            "libraryVersionAtDone"
          ),
        },
        error: err,
      });
      throw err;
    }
  });
});

describe("engineV2 attaches libraryVersionAtDone to runtime.jobs.succeeded", () => {
  console.info(`[${SUITE}:describe] entering "engineV2 attaches libraryVersionAtDone to runtime.jobs.succeeded"`);
  let engine: EngineV2;
  let events: RuntimeJobEvent[];
  let unsub: () => void;

  afterEach(async () => {
    unsub?.();
    await engine?.stop();
    console.info(`[${SUITE}:afterEach] engine stopped (events seen=${events?.length ?? 0})`);
  });

  it("includes libraryVersionAtDone on the succeeded event when the commit step recorded it", async () => {
    const label = "succeeded-includes-libraryVersionAtDone";
    console.info(`[${SUITE}:${label}] start`);
    engine = createEngineV2({ dbPath: ":memory:" });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));

    // Wire trivial handlers for every step except commit; commit emits
    // a commitResult carrying the field — mirroring what
    // `commitStepHandler` does in production with deps.getLibraryVersion
    // wired through.
    for (const kind of SOURCE_STEPS) {
      if (kind === "commit") continue;
      engine.registerHandler(kind, async () => {});
    }
    engine.registerHandler("commit", async (ctx) => {
      ctx.emitOutputs({
        commitResult: {
          fileId: "file-1",
          formatIds: ["fmt-1"],
          libraryVersionAtDone: 1923,
        },
      });
    });

    console.info(`[${SUITE}:${label}] submitting source job`);
    await engine.submit(makeJob());
    console.info(`[${SUITE}:${label}] waiting for runtime.jobs.succeeded`);
    try {
      await vi.waitFor(
        () => {
          expect(
            events.find((e) => e.event === "runtime.jobs.succeeded")
          ).toBeDefined();
        },
        { timeout: 3000 }
      );
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "src1",
        events,
        eventsCount: events.length,
        expected: { event: "runtime.jobs.succeeded" },
        actual: { eventTypes: events.map((e) => e.event) },
        error: err,
      });
      throw err;
    }

    const succeeded = events.find((e) => e.event === "runtime.jobs.succeeded");
    const lv = (succeeded?.payload as { libraryVersionAtDone?: number } | undefined)?.libraryVersionAtDone;
    console.info(`[${SUITE}:${label}] succeededEvent defined=${succeeded !== undefined} libraryVersionAtDone=${lv}`);
    try {
      expect(succeeded).toBeDefined();
      expect(
        (succeeded?.payload as { libraryVersionAtDone?: number })
          .libraryVersionAtDone
      ).toBe(1923);
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "src1",
        events,
        eventsCount: events.length,
        succeededEvent: succeeded,
        succeededPayload: succeeded?.payload,
        libraryVersionAtDone: lv,
        expected: { libraryVersionAtDone: 1923 },
        actual: { libraryVersionAtDone: lv },
        error: err,
      });
      throw err;
    }
  });

  it("omits libraryVersionAtDone when the commit step did not record it (e.g. format jobs / pre-Phase-3 commits)", async () => {
    const label = "succeeded-omits-libraryVersionAtDone";
    console.info(`[${SUITE}:${label}] start`);
    engine = createEngineV2({ dbPath: ":memory:" });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));

    for (const kind of SOURCE_STEPS) {
      if (kind === "commit") continue;
      engine.registerHandler(kind, async () => {});
    }
    // Commit step with no libraryVersionAtDone in outputs.
    engine.registerHandler("commit", async (ctx) => {
      ctx.emitOutputs({
        commitResult: { fileId: "file-1", formatIds: [] },
      });
    });

    console.info(`[${SUITE}:${label}] submitting source job src-omit`);
    await engine.submit(makeJob({ jobId: "src-omit" }));
    console.info(`[${SUITE}:${label}] waiting for runtime.jobs.succeeded`);
    try {
      await vi.waitFor(
        () => {
          expect(
            events.find((e) => e.event === "runtime.jobs.succeeded")
          ).toBeDefined();
        },
        { timeout: 3000 }
      );
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "src-omit",
        events,
        eventsCount: events.length,
        expected: { event: "runtime.jobs.succeeded" },
        actual: { eventTypes: events.map((e) => e.event) },
        error: err,
      });
      throw err;
    }

    const succeeded = events.find((e) => e.event === "runtime.jobs.succeeded");
    const payload = succeeded?.payload as Record<string, unknown>;
    const hasField = payload ? Object.prototype.hasOwnProperty.call(payload, "libraryVersionAtDone") : false;
    console.info(`[${SUITE}:${label}] succeededEvent defined=${succeeded !== undefined} hasLibraryVersionAtDone=${hasField}`);
    try {
      // Schema validation passes (event is contract-conforming) but the
      // field is OMITTED from the payload — renderer treats absent as
      // "no version known" and activates immediately on hasFiles.
      expect(succeeded).toBeDefined();
      expect((succeeded?.payload as Record<string, unknown>)).not.toHaveProperty(
        "libraryVersionAtDone"
      );
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "src-omit",
        events,
        succeededEvent: succeeded,
        succeededPayload: payload,
        expected: { defined: true, hasLibraryVersionAtDone: false },
        actual: { defined: succeeded !== undefined, hasLibraryVersionAtDone: hasField },
        error: err,
      });
      throw err;
    }
  });

  it("format-job succeeded events also carry libraryVersionAtDone when the format-job commit step records it (symmetric with source-jobs)", async () => {
    const label = "format-job-carries-libraryVersionAtDone";
    console.info(`[${SUITE}:${label}] start`);
    // Documented semantics: format-jobs use the same commit step
    // handler as source-jobs (commit.ts), so they ALSO call
    // deps.getLibraryVersion after their runBatch resolves and emit
    // the field on commitResult. EngineV2 then carries it through
    // to the succeeded event symmetrically. Format-jobs typically
    // bump the library version (addMediaFormat is a WRITE_METHOD)
    // so the field is non-zero; renderers that only care about
    // play-button activation simply ignore format-job successes
    // because the play-button gate is per-media, not per-job.
    engine = createEngineV2({ dbPath: ":memory:" });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));

    // Format jobs run transcode → upload → commit (3 steps, not 5).
    const FORMAT_STEPS = ["transcode", "upload", "commit"];
    for (const kind of FORMAT_STEPS) {
      if (kind === "commit") continue;
      engine.registerHandler(kind, async () => {});
    }
    engine.registerHandler("commit", async (ctx) => {
      ctx.emitOutputs({
        commitResult: {
          fileId: "file-parent-1",
          formatIds: ["fmt-360p"],
          libraryVersionAtDone: 4242,
        },
      });
    });

    const formatJob: IngestJobRecord = makeJob({
      jobId: "fmt-1",
      kind: "format",
      lane: "format",
      variant: "360p",
      payload: {
        userId: "u1",
        filename: "/tmp/m.mkv",
        variant: "360p",
        parentSourceJobId: "src1",
        hints: {},
      },
    });
    console.info(`[${SUITE}:${label}] submitting format job fmt-1`);
    await engine.submit(formatJob);
    console.info(`[${SUITE}:${label}] waiting for runtime.jobs.succeeded jobId=fmt-1`);
    try {
      await vi.waitFor(
        () => {
          expect(
            events.find((e) => e.event === "runtime.jobs.succeeded" && e.jobId === "fmt-1")
          ).toBeDefined();
        },
        { timeout: 3000 }
      );
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "fmt-1",
        jobKind: "format",
        events,
        eventsCount: events.length,
        expected: { event: "runtime.jobs.succeeded", jobId: "fmt-1" },
        actual: { eventTypes: events.map((e) => `${e.event}@${e.jobId}`) },
        error: err,
      });
      throw err;
    }

    const succeeded = events.find(
      (e) => e.event === "runtime.jobs.succeeded" && e.jobId === "fmt-1"
    );
    const lv = (succeeded?.payload as { libraryVersionAtDone?: number } | undefined)?.libraryVersionAtDone;
    console.info(`[${SUITE}:${label}] succeededEvent defined=${succeeded !== undefined} libraryVersionAtDone=${lv}`);
    try {
      expect(succeeded).toBeDefined();
      expect(
        (succeeded?.payload as { libraryVersionAtDone?: number })
          .libraryVersionAtDone
      ).toBe(4242);
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "fmt-1",
        jobKind: "format",
        events,
        succeededEvent: succeeded,
        succeededPayload: succeeded?.payload,
        libraryVersionAtDone: lv,
        expected: { libraryVersionAtDone: 4242 },
        actual: { libraryVersionAtDone: lv },
        error: err,
      });
      throw err;
    }
  });

  it("does not attach libraryVersionAtDone to failed or cancelled events (only to succeeded)", async () => {
    const label = "failed-omits-libraryVersionAtDone";
    console.info(`[${SUITE}:${label}] start`);
    engine = createEngineV2({ dbPath: ":memory:" });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));

    for (const kind of SOURCE_STEPS) {
      if (kind === "commit") continue;
      engine.registerHandler(kind, async () => {});
    }
    engine.registerHandler("commit", async () => {
      throw new Error("commit-blew-up");
    });

    console.info(`[${SUITE}:${label}] submitting source job src-fail (commit throws)`);
    await engine.submit(makeJob({ jobId: "src-fail" }));
    console.info(`[${SUITE}:${label}] waiting for runtime.jobs.failed`);
    try {
      await vi.waitFor(
        () => {
          expect(
            events.find((e) => e.event === "runtime.jobs.failed")
          ).toBeDefined();
        },
        { timeout: 3000 }
      );
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "src-fail",
        events,
        eventsCount: events.length,
        expected: { event: "runtime.jobs.failed" },
        actual: { eventTypes: events.map((e) => e.event) },
        error: err,
      });
      throw err;
    }

    const failed = events.find((e) => e.event === "runtime.jobs.failed");
    const succeeded = events.find((e) => e.event === "runtime.jobs.succeeded");
    const failedPayload = failed?.payload as Record<string, unknown>;
    const hasField = failedPayload ? Object.prototype.hasOwnProperty.call(failedPayload, "libraryVersionAtDone") : false;
    console.info(`[${SUITE}:${label}] failedEvent defined=${failed !== undefined} hasLibraryVersionAtDone=${hasField} succeededEvent defined=${succeeded !== undefined}`);
    try {
      expect(failed).toBeDefined();
      expect((failed?.payload as Record<string, unknown>)).not.toHaveProperty(
        "libraryVersionAtDone"
      );
      // No succeeded event — the commit threw.
      expect(events.find((e) => e.event === "runtime.jobs.succeeded")).toBeUndefined();
    } catch (err) {
      dumpBadgerLibraryVersionAtDoneSnapshot(label, {
        jobId: "src-fail",
        events,
        failedEvent: failed,
        succeededEvent: succeeded,
        failedPayload,
        expected: { failedDefined: true, hasLibraryVersionAtDone: false, succeededUndefined: true },
        actual: {
          failedDefined: failed !== undefined,
          hasLibraryVersionAtDone: hasField,
          succeededUndefined: succeeded === undefined,
        },
        error: err,
      });
      throw err;
    }
  });
});
