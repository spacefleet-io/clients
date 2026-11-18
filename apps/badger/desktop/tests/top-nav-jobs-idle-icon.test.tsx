// @vitest-environment jsdom
//
// @bugfix @regression-proof — top-nav Jobs icon kept spinning with no job running.
//
// TopNavJobsSidebar spins `Loader2` whenever `useLabJobsData().activeGroups`
// is non-empty. Pre-fix `activeGroups` filtered on the GROUP status computed by
// buildIngestJobGroups (uploading > transcoding > failed > labJobs[0].status),
// keeping every group whose status was not done/cancelled:
//   - a group whose source failed (its quality job cancelled by the cascade,
//     INGS-JOBS-02) has group status "failed" → counted active → spinner
//     forever, though nothing can run;
//   - a group whose first job is a finished source but whose quality job is
//     still queued has group status "done" → NOT counted, icon idle while work
//     is pending.
// Post-fix a group is active iff one of its jobs is still in progress
// (queued / running / interrupted-awaiting-requeue), whatever the group label.
//
// Uses the REAL buildIngestJobGroups + ingestJobsToLabJobs so the group status
// fallback is exercised exactly as in the app; only the store hook is stubbed.

import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { LabJobsContextValue } from "../src/renderer/src/lib/labJobs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockRecords: any[] = [];

vi.mock("@/lib/runtimeIngestJobs", async () => {
  const actual = await vi.importActual<typeof import("../src/renderer/src/lib/runtimeIngestJobs")>(
    "../src/renderer/src/lib/runtimeIngestJobs",
  );
  return {
    ...actual,
    useRuntimeIngestJobs: () => ({
      jobs: mockRecords,
      // The movie's media_items row exists (it was committed), so the
      // stale-orphan filter does not hide terminal groups.
      groups: actual.buildIngestJobGroups(mockRecords, [{ id: MEDIA, title: "The Pond Lighthouse" } as any]),
      loading: false,
      error: null,
      runtimeError: null,
    }),
    useRuntimeIngestActions: () => ({
      cancelJob: vi.fn(async () => undefined),
      cancelByGroup: vi.fn(async () => undefined),
      dismissJob: vi.fn(async () => undefined),
      retryJob: vi.fn(async () => undefined),
      submitSources: vi.fn(async () => ({ submitted: [] })),
    }),
  };
});

vi.mock("@/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: [] }),
  useOptionalLibraryData: () => ({ media: [] }),
}));

(globalThis as any).window = (globalThis as any).window || {};
(globalThis as any).window.sf = { setWindowProcessingState: vi.fn() };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root && container) act(() => root?.unmount());
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
  mockRecords = [];
});

const MEDIA = "5be026ef-9e69-4874-8c4d-d485390d2ea2";

// Shape of a `/runtime/jobs/v2/list` row (IngestJobRecord).
const record = (overrides: Record<string, unknown>) => ({
  jobId: "job",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "none", completed: null, total: null, unit: null },
  payload: { filename: "The Pond Lighthouse (2001).mkv" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: true,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-10-26T22:11:52.450Z",
  updatedAt: "2026-10-26T22:11:52.450Z",
  startedAt: null,
  finishedAt: null,
  groupId: MEDIA,
  mediaId: MEDIA,
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 0,
  ...overrides,
});

const captureLabJobsData = async (): Promise<LabJobsContextValue> => {
  const { LabJobsProvider, useLabJobsData } = await import("../src/renderer/src/lib/labJobs");
  const holder: { current: LabJobsContextValue | null } = { current: null };
  const Probe = () => {
    holder.current = useLabJobsData();
    return null;
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <LabJobsProvider>
        <Probe />
      </LabJobsProvider>,
    );
  });
  expect(holder.current).not.toBeNull();
  return holder.current!;
};

const assertActiveGroups = (label: string, captured: LabJobsContextValue, expectedIds: string[]) => {
  const observed = captured.activeGroups.map((g) => g.id).sort();
  console.info(
    `[top-nav-jobs-idle:${label}] activeGroups=${JSON.stringify(observed)} expected=${JSON.stringify(expectedIds)} → icon=${observed.length > 0 ? "Loader2(spin)" : "FlaskConical"}`,
  );
  if (JSON.stringify(observed) !== JSON.stringify([...expectedIds].sort())) {
    console.error(`=== [top-nav-jobs-idle:${label}] state dump ===`);
    console.error(
      `records: ${JSON.stringify(mockRecords.map((r) => ({ jobId: r.jobId, kind: r.kind, status: r.status, groupId: r.groupId })))}`,
    );
    console.error(
      `groups(activeGroups): ${JSON.stringify(captured.activeGroups.map((g) => ({ id: g.id, status: g.status, jobs: g.jobs.map((j) => j.status) })))}`,
    );
  }
  expect(observed).toEqual([...expectedIds].sort());
};

describe("[@bugfix][@regression-proof] top-nav Jobs icon idles when no job can run", () => {
  // Guard, not the reproduction: with the succeeded source listed first the
  // pre-fix group label was already "done". The two cases below fail pre-fix.
  it("guard: a real 4K re-import group (2 succeeded sources + 2 cancelled 360p, live list order) → no active group", async () => {
    mockRecords = [
      record({ jobId: "4656b848", status: "succeeded", createdAt: "2026-10-26T20:16:39.903Z" }),
      record({ jobId: "33356ffa", status: "succeeded" }),
      record({ jobId: "a06218c1", kind: "format", lane: "format", variant: "360p", status: "cancelled", errorCode: "user-requested", parentJobIds: ["4656b848"], createdAt: "2026-10-26T20:16:39.903Z" }),
      record({ jobId: "25a949d6", kind: "format", lane: "format", variant: "360p", status: "cancelled", errorCode: "user-requested", parentJobIds: ["33356ffa"] }),
    ];
    assertActiveGroups("succeeded+cancelled", await captureLabJobsData(), []);
  });

  // @req UX-WAIT-01
  it("source failed, its quality job cancelled by the cascade → no active group (pre-fix: group status 'failed' spun forever)", async () => {
    mockRecords = [
      record({ jobId: "src", status: "failed", errorCode: "upload_failed" }),
      record({ jobId: "fmt", kind: "format", lane: "format", variant: "360p", status: "cancelled", parentJobIds: ["src"] }),
    ];
    assertActiveGroups("failed+cancelled", await captureLabJobsData(), []);
  });

  // @req UX-WAIT-01
  it("source succeeded first in list, quality job still queued → group IS active (pre-fix: labJobs[0]='done' hid it)", async () => {
    mockRecords = [
      record({ jobId: "src", status: "succeeded" }),
      record({ jobId: "fmt", kind: "format", lane: "format", variant: "720p", status: "queued", parentJobIds: ["src"] }),
    ];
    assertActiveGroups("succeeded+queued", await captureLabJobsData(), [MEDIA]);
  });

  it("a running source keeps its group active", async () => {
    mockRecords = [record({ jobId: "src", status: "running", stageCode: "uploading" })];
    assertActiveGroups("running", await captureLabJobsData(), [MEDIA]);
  });
});
