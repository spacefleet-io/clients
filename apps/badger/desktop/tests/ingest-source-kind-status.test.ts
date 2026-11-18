// @vitest-environment jsdom
//
// B1: source-kind badge says "transcoding" while a source job is uploading.
// Root cause: runtimeIngestJobs.mapStatus collapses runtime status="running"
// to LabJob.status="transcoding" regardless of kind. For kind="source" the
// job is actually uploading (encrypt + chunk + push), so the badge should
// say "uploading".
//
// Fix: make the converter kind-aware so kind="source" + running maps to
// "uploading", while kind="format" + running stays "transcoding".

import { describe, expect, it } from "vitest";

// Dump-on-failure helper: surfaces the converter input/output mapping so a
// failed status assertion is diagnosable offline (per "Tests log generously").
// Body wrapped in try/catch so a dump failure can never mask the real assertion.
const dumpStatusSnapshot = (
  label: string,
  ctx: { kind?: unknown; status?: unknown; expected?: unknown; actual?: unknown; labJob?: unknown },
) => {
  try {
    console.error(`=== [ingest-source-kind-status:${label}] mapping snapshot ===`);
    console.error(
      `input: kind=${JSON.stringify(ctx.kind)} runtimeStatus=${JSON.stringify(ctx.status)}`,
    );
    console.error(
      `expected labJob.status=${JSON.stringify(ctx.expected)} actual=${JSON.stringify(ctx.actual)}`,
    );
    console.error(`labJob:\n${JSON.stringify(ctx.labJob, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const baseRecord = (overrides: Record<string, unknown> = {}) => ({
  jobId: "job-1",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "running",
  stageCode: "upload",
  stageLabel: "Uploading",
  progress: { mode: "none", completed: null, total: null, unit: null },
  payload: { filename: "movie.mkv" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: true,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  groupId: "media-1",
  mediaId: "media-1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 30,
  ...overrides,
});

describe("[@bugfix][@regression-proof] B1 source-kind running maps to uploading (not transcoding)", () => {
  it("source kind + running → status='uploading'", async () => {
    console.info("[ingest-source-kind-status:setup] mapping kind=source status=running");
    const { ingestJobsToLabJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const [labJob] = ingestJobsToLabJobs([
      baseRecord({ kind: "source", status: "running" }) as any,
    ]);
    console.info(`[ingest-source-kind-status:assert] got labJob.status=${labJob.status}`);
    if (labJob.status !== "uploading") {
      dumpStatusSnapshot("source-running", {
        kind: "source", status: "running", expected: "uploading", actual: labJob.status, labJob,
      });
    }
    expect(labJob.status).toBe("uploading");
  });

  it("format kind + running → status='transcoding'", async () => {
    console.info("[ingest-source-kind-status:setup] mapping kind=format status=running");
    const { ingestJobsToLabJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const [labJob] = ingestJobsToLabJobs([
      baseRecord({ kind: "format", variant: "720p", status: "running" }) as any,
    ]);
    console.info(`[ingest-source-kind-status:assert] got labJob.status=${labJob.status}`);
    if (labJob.status !== "transcoding") {
      dumpStatusSnapshot("format-running", {
        kind: "format", status: "running", expected: "transcoding", actual: labJob.status, labJob,
      });
    }
    expect(labJob.status).toBe("transcoding");
  });

  it("source kind + queued stays 'waiting' (regression on queued path)", async () => {
    console.info("[ingest-source-kind-status:setup] mapping kind=source status=queued");
    const { ingestJobsToLabJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const [labJob] = ingestJobsToLabJobs([
      baseRecord({ kind: "source", status: "queued" }) as any,
    ]);
    console.info(`[ingest-source-kind-status:assert] got labJob.status=${labJob.status}`);
    if (labJob.status !== "waiting") {
      dumpStatusSnapshot("source-queued", {
        kind: "source", status: "queued", expected: "waiting", actual: labJob.status, labJob,
      });
    }
    expect(labJob.status).toBe("waiting");
  });

  it("source kind + succeeded still maps to 'done'", async () => {
    console.info("[ingest-source-kind-status:setup] mapping kind=source status=succeeded");
    const { ingestJobsToLabJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const [labJob] = ingestJobsToLabJobs([
      baseRecord({ kind: "source", status: "succeeded" }) as any,
    ]);
    console.info(`[ingest-source-kind-status:assert] got labJob.status=${labJob.status}`);
    if (labJob.status !== "done") {
      dumpStatusSnapshot("source-succeeded", {
        kind: "source", status: "succeeded", expected: "done", actual: labJob.status, labJob,
      });
    }
    expect(labJob.status).toBe("done");
  });
});
