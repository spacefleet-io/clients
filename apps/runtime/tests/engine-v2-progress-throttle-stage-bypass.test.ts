/**
 * @bugfix @regression-proof
 *
 * Bug E1 (round 5): source-stage transitions throttled out
 *
 * The user observed a Orchard source job whose badge sat on "Extracting" the
 * entire run, then jumped to "done". The renderer never saw "Uploading" or
 * "Committing" badges.
 *
 * Root cause: engineV2's `lastProgressAt` throttle gated emits by elapsed
 * time only (default 1000ms). When extract → upload → commit happens
 * within <1s, the throttle swallows the upload + commit progress emits,
 * so the renderer's stageCode stays at "extracting" until the terminal
 * succeeded event lands.
 *
 * Fix: bypass the throttle when stageCode CHANGES between consecutive
 * emits. Same-stage progress-pct updates still throttle. Track the
 * last-emitted stageCode per-job alongside the timestamp; on a stage
 * transition, the throttle window resets so subsequent same-stage emits
 * get the fresh `progressThrottleMs` budget.
 *
 * This test pins both halves of the contract:
 *   1. five distinct stageCode emits inside one synchronous tick all
 *      survive the throttle (pre-fix: ~1 survives);
 *   2. 100 same-stage emits inside a sub-throttle window are still
 *      collapsed to ~1 (no regression on flood protection).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEngineV2,
  type EngineV2,
  type RuntimeJobEvent,
} from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ts = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps emitted event sequence (filtered to progress +
// terminal) on assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpThrottleSnapshot = (
  label: string,
  ctx: {
    events?: RuntimeJobEvent[];
    stageCodes?: Array<string | undefined>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [engine-v2-throttle:${label}] snapshot ===`);
    if (ctx.events) {
      const compact = ctx.events.map((e) => ({
        event: e.event,
        stageCode: (e.payload as { stageCode?: string }).stageCode,
        progressPct: (e.payload as { progressPct?: number }).progressPct,
      }));
      console.error(`events(${compact.length})=\n${JSON.stringify(compact, null, 2)}`);
    }
    if (ctx.stageCodes) {
      console.error(`stageCodes=${JSON.stringify(ctx.stageCodes)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

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

describe("engineV2 progress throttle — stage-transition bypass (E1)", () => {
  let engine: EngineV2;
  let events: RuntimeJobEvent[];
  let unsub: () => void;

  afterEach(async () => {
    console.info(`[engine-v2-throttle:teardown] unsub + engine.stop`);
    unsub?.();
    await engine?.stop();
  });

  it("emits a distinct progress event for every stageCode transition even when they happen inside the same throttle window", async () => {
    console.info(`[engine-v2-throttle:5-stage-transitions] creating engine throttleMs=1000`);
    // Production-like throttle: 1s. The whole sequence completes well
    // under 1s, so a time-only gate would swallow every emit after the
    // first.
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 1000 });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));

    // Each step fires its own stageCode. We deliberately pump 5 distinct
    // stageCodes inside the same job's lifetime — across step handlers,
    // so the throttle's per-job state is shared.
    const stageCodeByStep: Record<string, { code: string; label: string }> = {
      probe: { code: "probing", label: "Probing" },
      identify: { code: "identifying", label: "Identifying" },
      extract: { code: "extracting", label: "Extracting" },
      upload: { code: "uploading", label: "Uploading" },
      commit: { code: "committing", label: "Committing" },
    };
    for (const kind of SOURCE_STEPS) {
      const { code, label } = stageCodeByStep[kind]!;
      engine.registerHandler(kind, async ({ reportProgress }) => {
        // Two emits per step: the second is same-stage and will be
        // throttled (correct). The first carries the new stageCode and
        // MUST bypass.
        reportProgress(50, label, code);
        reportProgress(100, label, code);
      });
    }

    console.info(`[engine-v2-throttle:5-stage-transitions] submitting job, waiting for succeeded`);
    await engine.submit(makeJob());
    await vi.waitFor(
      () => {
        expect(
          events.find((e) => e.event === "runtime.jobs.succeeded")
        ).toBeDefined();
      },
      { timeout: 3000 }
    );

    const stageCodes = events
      .filter((e) => e.event === "runtime.jobs.progress")
      .map((e) => (e.payload as { stageCode?: string }).stageCode);
    console.info(`[engine-v2-throttle:5-stage-transitions] observed stageCodes=${JSON.stringify(stageCodes)} total-events=${events.length}`);

    try {
      // Pre-fix: throttle swallows all but ~1 of these. Post-fix: every
      // stage transition lands a progress event.
      expect(stageCodes).toContain("probing");
      expect(stageCodes).toContain("identifying");
      expect(stageCodes).toContain("extracting");
      expect(stageCodes).toContain("uploading");
      expect(stageCodes).toContain("committing");

      // Order is preserved — the renderer relies on this for the badge.
      const indexOfFirst = (code: string) =>
        stageCodes.findIndex((c) => c === code);
      expect(indexOfFirst("probing")).toBeLessThan(indexOfFirst("identifying"));
      expect(indexOfFirst("identifying")).toBeLessThan(indexOfFirst("extracting"));
      expect(indexOfFirst("extracting")).toBeLessThan(indexOfFirst("uploading"));
      expect(indexOfFirst("uploading")).toBeLessThan(indexOfFirst("committing"));
    } catch (err) {
      dumpThrottleSnapshot("5-stage-transitions-failure", { events, stageCodes });
      throw err;
    }
  });

  it("collapses a flood of same-stage emits to ~1 within the throttle window (no regression on flood protection)", async () => {
    console.info(`[engine-v2-throttle:flood-collapse] creating engine throttleMs=1000`);
    engine = createEngineV2({ dbPath: ":memory:", progressThrottleMs: 1000 });
    await engine.start();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));

    // Wire trivial no-op handlers for the steps we don't care about.
    for (const kind of SOURCE_STEPS) {
      if (kind === "extract") continue;
      engine.registerHandler(kind, async () => {
        // succeed silently — no progress emits, no stage-transition
        // bypass to pollute the count.
      });
    }
    // The step under test floods 100 same-stage progress emits, all
    // synchronously, well inside the 1000ms throttle window.
    engine.registerHandler("extract", async ({ reportProgress }) => {
      for (let i = 0; i < 100; i++) {
        reportProgress(i, "Extracting", "extracting");
      }
    });

    console.info(`[engine-v2-throttle:flood-collapse] submitting job, expecting flood collapse to 1`);
    await engine.submit(makeJob());
    await vi.waitFor(
      () => {
        expect(
          events.find((e) => e.event === "runtime.jobs.succeeded")
        ).toBeDefined();
      },
      { timeout: 3000 }
    );

    const extractingProgress = events.filter(
      (e) =>
        e.event === "runtime.jobs.progress" &&
        (e.payload as { stageCode?: string }).stageCode === "extracting"
    );
    console.info(`[engine-v2-throttle:flood-collapse] extracting-progress-count=${extractingProgress.length} total-events=${events.length}`);
    try {
      // Exactly one emit lands: the first (it bypasses on stage
      // transition). The remaining 99 are throttled because (a) stageCode
      // didn't change, (b) the throttle window was reset on the bypass.
      expect(extractingProgress.length).toBe(1);
    } catch (err) {
      dumpThrottleSnapshot("flood-collapse-failure", {
        events,
        extra: { extractingProgressCount: extractingProgress.length },
      });
      throw err;
    }
  });
});
