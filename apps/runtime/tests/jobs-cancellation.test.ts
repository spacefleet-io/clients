import { describe, expect, it } from "vitest";
import { cancelJobCascade, type CancelDeps } from "../src/core/jobs/cancellation";
import type { IngestJobRecord, IngestJobStatus } from "@space/runtime-jobs";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps cascade state (jobs map, CAS calls, abort calls,
// cascade result) on assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpCascadeSnapshot = (
  label: string,
  ctx: {
    jobs?: Map<string, IngestJobRecord>;
    casCalls?: Array<{ jobId: string; from: IngestJobStatus[]; to: IngestJobStatus }>;
    aborted?: string[];
    result?: { cancelledIds: string[]; alreadyTerminal: string[] };
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [jobs-cancel:${label}] snapshot ===`);
    if (ctx.jobs) {
      const dump = [...ctx.jobs.entries()].map(([id, j]) => ({
        id,
        status: j.status,
        parents: j.parentJobIds,
      }));
      console.error(`jobs=\n${JSON.stringify(dump, null, 2)}`);
    }
    if (ctx.casCalls) {
      console.error(`casCalls=\n${JSON.stringify(ctx.casCalls, null, 2)}`);
    }
    if (ctx.aborted) console.error(`aborted=${JSON.stringify(ctx.aborted)}`);
    if (ctx.result) {
      console.error(`result=\n${JSON.stringify(ctx.result, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const baseRecord = (
  jobId: string,
  status: IngestJobStatus,
  parentJobIds: string[] = []
): IngestJobRecord => ({
  jobId,
  app: "badger",
  kind: parentJobIds.length === 0 ? "source" : "format",
  lane: parentJobIds.length === 0 ? "source" : "format",
  status,
  stageCode: "",
  stageLabel: "",
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  groupId: "g1",
  mediaId: "m1",
  variant: parentJobIds.length === 0 ? null : "360p",
  parentJobIds,
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
});

const buildDeps = (jobs: Map<string, IngestJobRecord>) => {
  const aborted: string[] = [];
  const casCalls: Array<{ jobId: string; from: IngestJobStatus[]; to: IngestJobStatus }> = [];
  const deps: CancelDeps = {
    loadJob: (id) => jobs.get(id) ?? null,
    findChildren: (id) =>
      [...jobs.values()].filter((j) => j.parentJobIds.includes(id)),
    setStatusCAS: (id, from, to) => {
      casCalls.push({ jobId: id, from, to });
      const job = jobs.get(id);
      if (!job) return false;
      if (!from.includes(job.status)) return false;
      jobs.set(id, { ...job, status: to });
      return true;
    },
    abortRunner: (id) => {
      aborted.push(id);
    },
  };
  return { deps, aborted, casCalls };
};

describe("cancelJobCascade", () => {
  it("cancels only the leaf when target is a format with no descendants", () => {
    console.info(`[jobs-cancel:leaf-only] building 3-job tree, cancelling f360`);
    const jobs = new Map<string, IngestJobRecord>();
    jobs.set("source", baseRecord("source", "succeeded", []));
    jobs.set("f360", baseRecord("f360", "running", ["source"]));
    jobs.set("f720", baseRecord("f720", "running", ["source"]));
    const { deps, aborted, casCalls } = buildDeps(jobs);

    const result = cancelJobCascade("f360", "user", deps);
    console.info(`[jobs-cancel:leaf-only] result.cancelledIds=${JSON.stringify(result.cancelledIds)} aborted=${JSON.stringify(aborted)}`);

    try {
      expect(result.cancelledIds).toEqual(["f360"]);
      expect(result.alreadyTerminal).toEqual([]);
      expect(jobs.get("f360")!.status).toBe("cancelled");
      expect(jobs.get("f720")!.status).toBe("running");
      expect(jobs.get("source")!.status).toBe("succeeded");
      expect(aborted).toEqual(["f360"]);
    } catch (err) {
      dumpCascadeSnapshot("leaf-only-failure", { jobs, casCalls, aborted, result });
      throw err;
    }
  });

  it("cascades from root to all 3 direct children", () => {
    console.info(`[jobs-cancel:cascade-3-children] building source + 3 children`);
    const jobs = new Map<string, IngestJobRecord>();
    jobs.set("source", baseRecord("source", "running", []));
    jobs.set("f720", baseRecord("f720", "queued", ["source"]));
    jobs.set("f480", baseRecord("f480", "queued", ["source"]));
    jobs.set("f360", baseRecord("f360", "queued", ["source"]));
    const { deps, aborted, casCalls } = buildDeps(jobs);

    const result = cancelJobCascade("source", "user", deps);
    console.info(`[jobs-cancel:cascade-3-children] cancelledIds=${JSON.stringify(result.cancelledIds)} aborted=${JSON.stringify(aborted)}`);

    try {
      expect(new Set(result.cancelledIds)).toEqual(
        new Set(["source", "f720", "f480", "f360"])
      );
      expect(jobs.get("source")!.status).toBe("cancelled");
      expect(jobs.get("f720")!.status).toBe("cancelled");
      expect(jobs.get("f480")!.status).toBe("cancelled");
      expect(jobs.get("f360")!.status).toBe("cancelled");
      expect(new Set(aborted)).toEqual(new Set(["source", "f720", "f480", "f360"]));
    } catch (err) {
      dumpCascadeSnapshot("cascade-3-children-failure", { jobs, casCalls, aborted, result });
      throw err;
    }
  });

  it("recurses through grandchildren", () => {
    console.info(`[jobs-cancel:grandchildren] building 4-deep chain a→b→c→d`);
    const jobs = new Map<string, IngestJobRecord>();
    jobs.set("a", baseRecord("a", "running", []));
    jobs.set("b", baseRecord("b", "queued", ["a"]));
    jobs.set("c", baseRecord("c", "queued", ["b"]));
    jobs.set("d", baseRecord("d", "queued", ["c"]));
    const { deps, aborted, casCalls } = buildDeps(jobs);

    const result = cancelJobCascade("a", "user", deps);
    console.info(`[jobs-cancel:grandchildren] cancelledIds=${JSON.stringify(result.cancelledIds)}`);

    try {
      expect(new Set(result.cancelledIds)).toEqual(new Set(["a", "b", "c", "d"]));
      for (const id of ["a", "b", "c", "d"]) {
        expect(jobs.get(id)!.status).toBe("cancelled");
      }
    } catch (err) {
      dumpCascadeSnapshot("grandchildren-failure", { jobs, casCalls, aborted, result });
      throw err;
    }
  });

  it("skips terminal nodes encountered during BFS without continuing through them", () => {
    console.info(`[jobs-cancel:terminal-skip] a(running) → b(succeeded) → c(queued); expect c untouched`);
    const jobs = new Map<string, IngestJobRecord>();
    jobs.set("a", baseRecord("a", "running", []));
    jobs.set("b", baseRecord("b", "succeeded", ["a"])); // already done
    jobs.set("c", baseRecord("c", "queued", ["b"]));
    const { deps, aborted, casCalls } = buildDeps(jobs);

    const result = cancelJobCascade("a", "user", deps);
    console.info(`[jobs-cancel:terminal-skip] cancelledIds=${JSON.stringify(result.cancelledIds)} alreadyTerminal=${JSON.stringify(result.alreadyTerminal)}`);

    try {
      expect(result.cancelledIds).toContain("a");
      expect(result.alreadyTerminal).toContain("b");
      // c remains untouched: BFS does not traverse past terminal nodes
      expect(jobs.get("c")!.status).toBe("queued");
    } catch (err) {
      dumpCascadeSnapshot("terminal-skip-failure", { jobs, casCalls, aborted, result });
      throw err;
    }
  });

  it("does not propagate cascade past a node where CAS rejected the write", () => {
    console.info(`[jobs-cancel:cas-race-loss] a→b→c; CAS on b simulates a race loss`);
    const jobs = new Map<string, IngestJobRecord>();
    jobs.set("a", baseRecord("a", "running", []));
    jobs.set("b", baseRecord("b", "queued", ["a"]));
    jobs.set("c", baseRecord("c", "queued", ["b"]));

    // Custom deps where CAS on `b` always returns false (concurrent writer).
    const aborted: string[] = [];
    const casCalls: Array<{ jobId: string; from: IngestJobStatus[]; to: IngestJobStatus }> = [];
    const deps: CancelDeps = {
      loadJob: (id) => jobs.get(id) ?? null,
      findChildren: (id) =>
        [...jobs.values()].filter((j) => j.parentJobIds.includes(id)),
      setStatusCAS: (id, from, to) => {
        casCalls.push({ jobId: id, from, to });
        if (id === "b") return false; // simulate race loss
        const job = jobs.get(id);
        if (!job || !from.includes(job.status)) return false;
        jobs.set(id, { ...job, status: to });
        return true;
      },
      abortRunner: (id) => {
        aborted.push(id);
      },
    };

    const result = cancelJobCascade("a", "user", deps);
    console.info(`[jobs-cancel:cas-race-loss] cancelledIds=${JSON.stringify(result.cancelledIds)} casCalls=${casCalls.length}`);

    try {
      expect(result.cancelledIds).toEqual(["a"]);
      // c was NOT enqueued because b's CAS failed
      expect(jobs.get("c")!.status).toBe("queued");
      expect(aborted).toEqual(["a"]);
    } catch (err) {
      dumpCascadeSnapshot("cas-race-loss-failure", { jobs, casCalls, aborted, result });
      throw err;
    }
  });

  it("returns empty result for a missing job id", () => {
    console.info(`[jobs-cancel:missing-id] cancelling unknown id 'ghost'`);
    const jobs = new Map<string, IngestJobRecord>();
    const { deps, aborted, casCalls } = buildDeps(jobs);
    const result = cancelJobCascade("ghost", "user", deps);
    try {
      expect(result.cancelledIds).toEqual([]);
      expect(result.alreadyTerminal).toEqual([]);
    } catch (err) {
      dumpCascadeSnapshot("missing-id-failure", { jobs, casCalls, aborted, result });
      throw err;
    }
  });

  it("is idempotent on a second invocation against the same root", () => {
    console.info(`[jobs-cancel:idempotent] first + second cancel against same root 'a'`);
    const jobs = new Map<string, IngestJobRecord>();
    jobs.set("a", baseRecord("a", "running", []));
    jobs.set("b", baseRecord("b", "queued", ["a"]));
    const { deps, aborted, casCalls } = buildDeps(jobs);

    const first = cancelJobCascade("a", "user", deps);
    const second = cancelJobCascade("a", "user", deps);
    console.info(`[jobs-cancel:idempotent] first.cancelled=${JSON.stringify(first.cancelledIds)} second.cancelled=${JSON.stringify(second.cancelledIds)} second.alreadyTerminal=${JSON.stringify(second.alreadyTerminal)}`);

    try {
      expect(new Set(first.cancelledIds)).toEqual(new Set(["a", "b"]));
      expect(second.cancelledIds).toEqual([]);
      // Second call hits root `a` which is already terminal; BFS exits without
      // traversing children, so only `a` is recorded as alreadyTerminal.
      expect(second.alreadyTerminal).toEqual(["a"]);
    } catch (err) {
      dumpCascadeSnapshot("idempotent-failure", {
        jobs,
        casCalls,
        aborted,
        result: second,
        extra: { firstCancelled: first.cancelledIds, firstAlreadyTerminal: first.alreadyTerminal },
      });
      throw err;
    }
  });
});
