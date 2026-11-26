/**
 * @bugfix @regression-proof commit-library-db-not-open-at-boot (issue #25 P3,
 * ultimate stress run 1791294602218864000: c015 source job a20fa312 and c040
 * 360p job f4a5154b).
 *
 * Symptom: a job resumed at runtime boot reached its commit step right after
 * `[runtime] started`, 0.4-0.9 s BEFORE the desktop re-opened the library DB,
 * and failed permanently:
 *   [engineV2] step 'commit' … threw: LIBRARY_DB_NOT_OPEN
 *     at badgerLibraryDb.ts:261 (runBatch)
 *
 * #48 added a bounded wait for the open library DB inside deps.commit, but the
 * commit step wraps deps.commit in deps.runLibraryBatch → libraryDb.runBatch,
 * whose own guard throws LIBRARY_DB_NOT_OPEN before `fn` (and its wait) runs.
 *
 * Fix: the commit step hands its identity to runLibraryBatch, which waits
 * (bounded, abortable, logged) for the DB in front of the batch.
 *
 * Exercised path: commitStepHandler → buildBadgerStepDeps().runLibraryBatch
 * → the real BadgerLibraryDbService.runBatch guard. Time is driven with fake
 * timers (the wait polls on setTimeout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestJobRecord } from "@space/runtime-jobs";
import {
  buildBadgerStepDeps,
  type ProduceMediaOutputsFn,
  type UploadProducedMediaFn,
} from "../src/modules/badger/steps/deps-adapter";
import {
  configureBadgerStepDeps,
  __resetBadgerStepDeps,
  type BadgerStepDeps,
  type CommitResult,
} from "../src/modules/badger/steps/deps";
import { commitStepHandler } from "../src/modules/badger/steps";
import type { StepHandlerCtx } from "../src/core/jobs/engineV2";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";
import { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";

const SUITE = "badger-commit-library-reopen-wait";
const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (jobId: string): IngestJobRecord => ({
  jobId,
  app: "badger",
  kind: "source",
  lane: "source",
  status: "running",
  stageCode: "committing",
  stageLabel: "Committing",
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
  startedAt: ts,
  finishedAt: null,
  groupId: "g1",
  mediaId: "m1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
});

const makeCtx = (jobId: string, signal: AbortSignal, outputs: Array<Record<string, unknown>>): StepHandlerCtx => ({
  job: makeJob(jobId),
  step: {
    stepId: `${jobId}:commit`,
    jobId,
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
  signal,
  reportProgress: () => {},
  emitOutputs: (out) => {
    outputs.push(out);
  },
});

/**
 * Simulates the desktop's badger.db.open landing: the service now holds a
 * live db. The private slot is set directly — a real open needs an encrypted
 * library file + backend session, and only the open/closed guard matters here.
 */
const reopenLibrary = (svc: BadgerLibraryDbService) => {
  Reflect.set(svc, "db", { getVersion: () => 7, getSnapshot: () => ({}) });
};

describe(`[${SUITE}] commit at runtime boot waits for the library re-open`, () => {
  let svc: BadgerLibraryDbService;
  let commitCalls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    __resetBadgerStepDeps();
    svc = new BadgerLibraryDbService();
    commitCalls = [];
    const adapter = buildBadgerStepDeps({
      libraryDb: svc,
      produceMediaOutputs: vi.fn() as unknown as ProduceMediaOutputsFn,
      uploadProducedMedia: vi.fn() as unknown as UploadProducedMediaFn,
      authWaitMs: 5_000,
      authPollMs: 10,
    });
    // Only the library batch is the real adapter seam under test; the row
    // writes inside it are stubbed (their own wait is covered elsewhere).
    const deps: BadgerStepDeps = {
      ...adapter,
      commit: vi.fn(async (input): Promise<CommitResult> => {
        commitCalls.push(`commit:${input.jobId}:dbOpen=${svc.isOpen()}`);
        return { fileId: "file-1", formatIds: ["fmt-1"] };
      }),
      markMediaPlayable: vi.fn(async () => {
        commitCalls.push(`markMediaPlayable:dbOpen=${svc.isOpen()}`);
      }),
    };
    configureBadgerStepDeps(deps);
    console.info(`[${SUITE}:beforeEach] library db open=${svc.isOpen()} (fresh runtime, desktop not re-attached yet)`);
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetBadgerStepDeps();
  });

  it("library re-opened 400 ms after commit starts → commit succeeds, rows written against the open db", async () => {
    const label = "late-reopen";
    const outputs: Array<Record<string, unknown>> = [];
    const settled = commitStepHandler(makeCtx("job-a20fa312", new AbortController().signal, outputs)).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) })
    );
    await vi.advanceTimersByTimeAsync(400);
    reopenLibrary(svc);
    console.info(`[${SUITE}:${label}] desktop re-opened the library at +400ms`);
    await vi.advanceTimersByTimeAsync(50);

    const outcome = await settled;
    console.info(
      `[${SUITE}:${label}] outcome=${JSON.stringify(outcome)} calls=${JSON.stringify(commitCalls)} outputs=${JSON.stringify(outputs)}`
    );
    expect(outcome).toEqual({ ok: true });
    expect(commitCalls).toEqual(["commit:job-a20fa312:dbOpen=true", "markMediaPlayable:dbOpen=true"]);
    expect(outputs[0]).toMatchObject({ commitResult: { fileId: "file-1", formatIds: ["fmt-1"] } });
  });

  it("library never re-opens → bounded wait, then STEP_COMMIT_LIBRARY_NOT_READY (not a raw LIBRARY_DB_NOT_OPEN)", async () => {
    const label = "never-reopens";
    const settled = commitStepHandler(makeCtx("job-never", new AbortController().signal, [])).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) })
    );
    await vi.advanceTimersByTimeAsync(4_900);
    let early: unknown = "pending";
    void settled.then((o) => {
      early = o;
    });
    await vi.advanceTimersByTimeAsync(0);
    console.info(`[${SUITE}:${label}] at +4900ms outcome=${JSON.stringify(early)}`);
    expect(early).toBe("pending");
    await vi.advanceTimersByTimeAsync(200);
    const outcome = await settled;
    console.info(`[${SUITE}:${label}] outcome=${JSON.stringify(outcome)} calls=${JSON.stringify(commitCalls)}`);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/^STEP_COMMIT_LIBRARY_NOT_READY/);
    expect(commitCalls).toEqual([]);
  });

  it("abort while waiting (runtime stop) → CANCELLED promptly, no writes", async () => {
    const label = "abort-while-waiting";
    const ctrl = new AbortController();
    const settled = commitStepHandler(makeCtx("job-abort", ctrl.signal, [])).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) })
    );
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await settled;
    console.info(`[${SUITE}:${label}] outcome=${JSON.stringify(outcome)} calls=${JSON.stringify(commitCalls)}`);
    expect(outcome).toEqual({ ok: false, error: "CANCELLED" });
    expect(commitCalls).toEqual([]);
  });
});
