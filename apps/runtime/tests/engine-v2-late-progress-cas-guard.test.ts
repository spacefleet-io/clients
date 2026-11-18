/**
 * @bugfix @regression-proof
 *
 * Bug E2 (round 5): late progress write overwrites terminal status
 *
 * The user cancelled a 360p format from the media modal. Modal updated
 * (status=cancelled). User closed the modal and opened the sidebar; the
 * sidebar showed the job as "Transcoding 360p" at 99%. The cancel did
 * not visually persist.
 *
 * Live DB evidence (format 7b1c89b6):
 *   event 1107 (22:27:53.390) → cancel: status=cancelled, errorCode='user-requested'
 *   event 1108 (22:27:53.737) → progress fired by still-in-flight ffmpeg
 *                               runner — OVERWROTE status back to running.
 *
 * Root cause: `reportProgress` in engineV2 unconditionally calls
 * `store.updateJobStatus(jobId, "running", { ... })`. There was no CAS
 * guard against a row that had already moved to a terminal state on
 * another path (cancel / fail / succeed cascade).
 *
 * Fix: in `reportProgress`, re-read the row before writing. If the row
 * is in a terminal status (cancelled / failed / succeeded / interrupted),
 * reject the write — no DB update, no progress event emitted, console.warn
 * audit trail.
 *
 * This test races a still-in-flight handler against a cancel: the handler
 * pumps progress, then cancel resolves and flips status to cancelled,
 * then the handler pumps one more progress. Pre-fix the late progress
 * resurrects status=running. Post-fix the row stays cancelled and the
 * late event is suppressed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEngineV2,
  type EngineV2,
  type RuntimeJobEvent,
} from "../src/core/jobs/engineV2";
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

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps job state, event timeline, and warn-spy calls
// on assertion failure. Wrapped in try/catch so a dump-failure cannot mask
// the original assertion failure.
// ---------------------------------------------------------------------------
const dumpCasGuardSnapshot = async (
  label: string,
  ctx: {
    engine?: EngineV2;
    events?: RuntimeJobEvent[];
    warnSpy?: ReturnType<typeof vi.spyOn>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [engine-v2-late-progress-cas-guard:${label}] snapshot ===`);
    if (ctx.engine) {
      const snapshot = await ctx.engine.get("src1").catch((err) => `(get-failed: ${err instanceof Error ? err.message : String(err)})`);
      console.error(`engine.get(src1)=\n${JSON.stringify(snapshot, null, 2)}`);
    }
    if (ctx.events) {
      const progressEvents = ctx.events
        .filter((e) => e.event === "runtime.jobs.progress" && e.jobId === "src1")
        .map((e) => ({
          event: e.event,
          stageCode: (e.payload as { stageCode?: string }).stageCode,
          progressPct: (e.payload as { progressPct?: number }).progressPct,
        }));
      console.error(
        `events.total=${ctx.events.length} progress-for-src1 (${progressEvents.length})=\n${JSON.stringify(progressEvents, null, 2)}`,
      );
      const eventNames = ctx.events.map((e) => `${e.event}:${e.jobId}`);
      console.error(`event-timeline=\n${JSON.stringify(eventNames, null, 2)}`);
    }
    if (ctx.warnSpy) {
      const warnCalls = ctx.warnSpy.mock.calls.map((args: unknown[]) => args[0]);
      console.error(`warnSpy.calls (${warnCalls.length})=\n${JSON.stringify(warnCalls, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("engineV2 late-progress CAS guard (E2)", () => {
  let engine: EngineV2;
  let events: RuntimeJobEvent[];
  let unsub: () => void;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    console.info(`[engine-v2-late-progress-cas-guard:setup] creating engine + subscribing`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 0 });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    console.info(`[engine-v2-late-progress-cas-guard:setup] engine started`);
  });

  afterEach(async () => {
    console.info(`[engine-v2-late-progress-cas-guard:teardown] stopping engine, total events=${events.length}`);
    warnSpy.mockRestore();
    unsub();
    await engine.stop();
  });

  it("rejects a late progress write that lands AFTER the row has been cancelled — row stays cancelled, no progress event emitted, audit warn fired", async () => {
    console.info(`[engine-v2-late-progress-cas-guard:race] registering non-extract handlers`);
    // Trivial succeeding handlers for every step except `extract`. The
    // extract handler is the one we'll race against the cancel.
    for (const kind of SOURCE_STEPS) {
      if (kind === "extract") continue;
      engine.registerHandler(kind, async () => {
        // succeeds immediately
      });
    }

    // Deferred promise: extract handler waits on this until the test
    // releases it. While waiting, the test fires cancel. After cancel
    // resolves we release the handler and the handler then attempts
    // ONE MORE reportProgress — exactly the race from the bug.
    let releaseHandler: () => void = () => {};
    const handlerHold = new Promise<void>((r) => {
      releaseHandler = r;
    });
    let inHandler: () => void = () => {};
    const handlerEntered = new Promise<void>((r) => {
      inHandler = r;
    });

    engine.registerHandler("extract", async ({ reportProgress }) => {
      // First emit fires while status is still running — will land.
      console.info(`[engine-v2-late-progress-cas-guard:race] extract handler: first reportProgress(50)`);
      reportProgress(50, "Extracting", "extracting");
      inHandler();
      // Block here so the test can fire cancel against an in-flight job.
      await handlerHold;
      // Late emit: at this point cancel has already flipped status to
      // cancelled. Pre-fix this resurrects status=running. Post-fix
      // it's rejected.
      console.info(`[engine-v2-late-progress-cas-guard:race] extract handler: late reportProgress(99) after release`);
      reportProgress(99, "Extracting", "extracting");
      // Throw to escape the handler — engineV2 will respect the existing
      // terminal status and not overwrite it.
      throw new Error("aborted-by-test");
    });

    try {
      console.info(`[engine-v2-late-progress-cas-guard:race] submitting src1`);
      await engine.submit(makeJob());

      // Wait for the handler to enter and emit its first (legitimate)
      // progress before we cancel.
      console.info(`[engine-v2-late-progress-cas-guard:race] awaiting handler-entered`);
      await handlerEntered;
      await vi.waitFor(
        () => {
          const inflight = events.find(
            (e) =>
              e.event === "runtime.jobs.progress" &&
              (e.payload as { stageCode?: string }).stageCode === "extracting"
          );
          expect(inflight).toBeDefined();
        },
        { timeout: 3000 }
      );
      console.info(`[engine-v2-late-progress-cas-guard:race] first progress observed; firing cancel`);

      // Cancel the job — synchronous status flip to cancelled.
      await engine.cancel("src1", "user-requested");
      const afterCancel = (await engine.get("src1"))?.job;
      console.info(`[engine-v2-late-progress-cas-guard:race] post-cancel status=${afterCancel?.status} errorCode=${afterCancel?.errorCode}`);
      expect(afterCancel?.status).toBe("cancelled");

      // Snapshot the progress event count BEFORE we release the handler so
      // we can assert no new progress event lands after cancel.
      const progressBeforeRelease = events.filter(
        (e) => e.event === "runtime.jobs.progress" && e.jobId === "src1"
      ).length;
      console.info(`[engine-v2-late-progress-cas-guard:race] progressBeforeRelease=${progressBeforeRelease}; releasing handler`);

      // Release the handler — it will pump one more progress, which the
      // CAS guard must reject.
      releaseHandler();

      // Wait for the handler's promise chain to settle. Settle is observed
      // via the engine completing its post-handler bookkeeping; we look
      // for the warn from the CAS guard.
      await vi.waitFor(
        () => {
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
              "[engineV2] progress write rejected for job src1 (terminal: cancelled)"
            )
          );
        },
        { timeout: 3000 }
      );
      console.info(`[engine-v2-late-progress-cas-guard:race] CAS warn observed`);

      // Status MUST still be cancelled (the bug was: it became running
      // again). progressPct on the row should not have been bumped to 99.
      const final = (await engine.get("src1"))?.job;
      console.info(`[engine-v2-late-progress-cas-guard:race] final status=${final?.status} progressPct=${final?.progressPct}`);
      expect(final?.status).toBe("cancelled");
      expect(final?.progressPct).not.toBe(99);

      // No new progress event was emitted after cancel.
      const progressAfterRelease = events.filter(
        (e) => e.event === "runtime.jobs.progress" && e.jobId === "src1"
      ).length;
      expect(progressAfterRelease).toBe(progressBeforeRelease);
    } catch (err) {
      await dumpCasGuardSnapshot("race-failure", { engine, events, warnSpy });
      throw err;
    }
  });
});
