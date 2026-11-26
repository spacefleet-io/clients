/**
 * @bugfix
 * @regression-proof
 *
 * effervescent-teapot Round 3 — "delete media + re-add same file" cascade.
 * Verifies the `runtime.jobs.cancel_by_group` handler:
 *   - Cancels every non-terminal job in the group (engine cascades children).
 *   - Dismisses every terminal job so it stops blocking dedupe / appearing
 *     in the default UI list.
 *   - Returns the right `{ cancelled, dismissed }` totals.
 *   - Is idempotent: a second invocation on the same group is a no-op.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeJobsV2Handler } from "../src/routes/runtimeJobsV2";
import type { EventLog } from "@space/runtime-jobs-engine/eventLog";
import type {
  EngineV2,
  ListFilter,
  RuntimeJobEvent,
} from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "j",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: {},
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
  mediaId: "g1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

/**
 * Minimal engine harness: an in-memory `Map<jobId, IngestJobRecord>` with
 * just the surface cancel-by-group calls (`list`, `cancel`, `dismiss`).
 * The cancel cascade is faked: cancelling a "source" cascades to every
 * non-terminal "format" with `parentJobIds.includes(sourceId)`, mirroring
 * the real engine's cascade semantics.
 */
const buildHarness = (initial: IngestJobRecord[]) => {
  const jobs = new Map<string, IngestJobRecord>();
  for (const j of initial) jobs.set(j.jobId, { ...j });

  const isTerminal = (status: IngestJobRecord["status"]) =>
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted";

  const engine = {
    async list(filter?: ListFilter) {
      const all = Array.from(jobs.values());
      const filtered = all.filter((j) => {
        if (filter?.groupId && j.groupId !== filter.groupId) return false;
        if (!filter?.includeDismissed && j.dismissedAt) return false;
        return true;
      });
      return { jobs: filtered, maxEventId: 0 };
    },
    async cancel(jobId: string) {
      const cancelledIds: string[] = [];
      const job = jobs.get(jobId);
      if (!job) return { cancelledIds };
      if (!isTerminal(job.status)) {
        jobs.set(jobId, { ...job, status: "cancelled" });
        cancelledIds.push(jobId);
      }
      // Cascade to non-terminal children that parent this id.
      for (const [id, child] of jobs) {
        if (id === jobId) continue;
        if (!child.parentJobIds.includes(jobId)) continue;
        if (isTerminal(child.status)) continue;
        jobs.set(id, { ...child, status: "cancelled" });
        cancelledIds.push(id);
      }
      return { cancelledIds };
    },
    async dismiss(jobId: string) {
      const job = jobs.get(jobId);
      if (!job) return { dismissed: false, errorCode: "not-found" as const };
      if (!isTerminal(job.status)) {
        return { dismissed: false, errorCode: "not-terminal" as const };
      }
      if (job.dismissedAt) return { dismissed: true };
      jobs.set(jobId, {
        ...job,
        dismissedAt: new Date().toISOString(),
      });
      return { dismissed: true };
    },
    // Unused by cancel-by-group; provide stubs to satisfy the interface.
    async start() {},
    async stop() {},
    async submit() {
      return { jobId: "" };
    },
    async updateJobPayload() {
      return null;
    },
    async retry() {
      return { retried: false };
    },
    async get() {
      return null;
    },
    async getByDedupe() {
      return null;
    },
    registerHandler() {},
    subscribe(_listener: (event: RuntimeJobEvent) => void) {
      return () => {};
    },
  };

  const eventLog: EventLog = {
    append: () => ({
      eventId: 0,
      jobId: "",
      channel: "runtime.jobs",
      event: "runtime.jobs.created",
      payloadJson: "{}",
      createdAt: ts,
    }),
    replay: () => ({ events: [], replayOverflow: false, maxEventId: 0 }),
    maxEventId: () => 0,
    trimTerminalsOlderThan: () => 0,
  };

  const handler = createRuntimeJobsV2Handler({
    engine: engine as unknown as EngineV2,
    eventLog,
  });

  return { handler, jobs };
};

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps harness job map + handler result on assertion
// failure. Wrapped in try/catch so a dump-failure cannot mask the original.
// ---------------------------------------------------------------------------
const dumpCancelByGroupSnapshot = (
  label: string,
  ctx: {
    harness?: ReturnType<typeof buildHarness>;
    result?: { cancelled: number; dismissed: number };
    expectedGroupId?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-jobs-cancel-by-group:${label}] snapshot ===`);
    if (ctx.harness) {
      const entries = Array.from(ctx.harness.jobs.entries()).map(([id, j]) => ({
        jobId: id,
        status: j.status,
        groupId: j.groupId,
        kind: j.kind,
        parentJobIds: j.parentJobIds,
        dismissedAt: j.dismissedAt,
      }));
      console.error(`harness.jobs (${entries.length})=\n${JSON.stringify(entries, null, 2)}`);
    }
    if (ctx.result) {
      console.error(`handler.result=${JSON.stringify(ctx.result)}`);
    }
    if (ctx.expectedGroupId) {
      console.error(`expectedGroupId=${ctx.expectedGroupId}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime.jobs.cancel_by_group @bugfix @regression-proof", () => {
  let harness: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    console.info(`[runtime-jobs-cancel-by-group:setup] building harness (src running, fmt-360 queued, fmt-720 succeeded, other-src isolated)`);
    harness = buildHarness([
      // Source job — running (non-terminal).
      makeJob({ jobId: "src", status: "running", parentJobIds: [] }),
      // Format job — queued, parented on the source.
      makeJob({
        jobId: "fmt-360",
        kind: "format",
        lane: "format",
        variant: "360p",
        status: "queued",
        parentJobIds: ["src"],
      }),
      // Format job — already succeeded (terminal, not dismissed).
      makeJob({
        jobId: "fmt-720",
        kind: "format",
        lane: "format",
        variant: "720p",
        status: "succeeded",
        parentJobIds: ["src"],
      }),
      // Sibling group — must NOT be touched.
      makeJob({
        jobId: "other-src",
        groupId: "other-group",
        mediaId: "other-group",
        status: "running",
      }),
    ]);
  });

  afterEach(() => {
    /* nothing to clean up */
  });

  it("cancels non-terminal jobs and dismisses terminal jobs in the target group", async () => {
    console.info(`[runtime-jobs-cancel-by-group:happy-path] firing cancel_by_group(g1)`);
    const result = await harness.handler.handleCancelByGroup({
      groupId: "g1",
      reason: "media-deleted",
    });
    console.info(`[runtime-jobs-cancel-by-group:happy-path] result=${JSON.stringify(result)}`);
    try {
      // `src` is non-terminal → cancelled. Cascade also cancels `fmt-360`.
      // `fmt-720` is terminal (succeeded) → dismissed.
      expect(result.cancelled).toBe(2);
      expect(result.dismissed).toBe(1);

      expect(harness.jobs.get("src")!.status).toBe("cancelled");
      expect(harness.jobs.get("fmt-360")!.status).toBe("cancelled");
      expect(harness.jobs.get("fmt-720")!.dismissedAt).not.toBeNull();
    } catch (err) {
      dumpCancelByGroupSnapshot("happy-path-failure", { harness, result, expectedGroupId: "g1" });
      throw err;
    }
  });

  it("does NOT touch jobs in another group", async () => {
    console.info(`[runtime-jobs-cancel-by-group:isolation] firing cancel_by_group(g1) — other-group must stay running`);
    await harness.handler.handleCancelByGroup({ groupId: "g1" });
    try {
      expect(harness.jobs.get("other-src")!.status).toBe("running");
      expect(harness.jobs.get("other-src")!.dismissedAt).toBeNull();
    } catch (err) {
      dumpCancelByGroupSnapshot("isolation-failure", { harness, expectedGroupId: "g1" });
      throw err;
    }
  });

  it("is idempotent: a second invocation returns { cancelled: 0, dismissed: 0 }", async () => {
    console.info(`[runtime-jobs-cancel-by-group:idempotent] firing cancel_by_group(g1) twice`);
    await harness.handler.handleCancelByGroup({ groupId: "g1" });
    const second = await harness.handler.handleCancelByGroup({ groupId: "g1" });
    console.info(`[runtime-jobs-cancel-by-group:idempotent] second.result=${JSON.stringify(second)}`);
    try {
      expect(second.cancelled).toBe(0);
      expect(second.dismissed).toBe(0);
    } catch (err) {
      dumpCancelByGroupSnapshot("idempotent-failure", { harness, result: second, expectedGroupId: "g1" });
      throw err;
    }
  });

  it("returns { cancelled: 0, dismissed: 0 } for an unknown group", async () => {
    console.info(`[runtime-jobs-cancel-by-group:unknown-group] firing cancel_by_group(no-such-group)`);
    const result = await harness.handler.handleCancelByGroup({
      groupId: "no-such-group",
    });
    console.info(`[runtime-jobs-cancel-by-group:unknown-group] result=${JSON.stringify(result)}`);
    try {
      expect(result).toEqual({ cancelled: 0, dismissed: 0 });
    } catch (err) {
      dumpCancelByGroupSnapshot("unknown-group-failure", { harness, result, expectedGroupId: "no-such-group" });
      throw err;
    }
  });
});
