// @vitest-environment jsdom
//
// Round 7 G3 — top-bar count = active groups, not active jobs.
//
// Pre-fix: TopNavJobsSidebar read `activeJobs.length` from useLabJobsData,
// which counted individual jobs. With two media each running a source +
// format-360p pair, the badge read "4" (jobs) instead of "2" (pipelines).
// The user's mental model is one badge per ingest pipeline.
//
// Post-fix: LabJobsProvider exposes `activeGroups` (LabJobGroup[] with at
// least one in-progress job), and TopNavJobsSidebar reads `activeGroups.length`.

import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { LabJobsContextValue } from "../src/renderer/src/lib/labJobs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockGroups: any[] = [];
let mockJobs: any[] = [];

vi.mock("@/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: () => ({
    jobs: mockJobs,
    groups: mockGroups,
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
  ingestJobsToLabJobs: (records: any[]) =>
    records.map((rec) => ({
      id: rec.jobId,
      filename: rec.payload?.filename ?? rec.jobId,
      status:
        rec.status === "queued"
          ? "waiting"
          : rec.status === "running"
            ? rec.kind === "source"
              ? "uploading"
              : "transcoding"
            : rec.status === "succeeded"
              ? "done"
              : rec.status,
      progress: rec.progressPct ?? 0,
      groupId: rec.groupId ?? rec.mediaId,
      matchedMediaId: rec.mediaId,
      uploadSpeedMbps: 0,
    })),
}));

vi.mock("@/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: [] }),
  useOptionalLibraryData: () => ({ media: [] }),
}));

(globalThis as any).window = (globalThis as any).window || {};
(globalThis as any).window.sf = {
  setWindowProcessingState: vi.fn(),
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root && container) act(() => root?.unmount());
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
  mockGroups = [];
  mockJobs = [];
});

beforeEach(() => {
  mockGroups = [];
  mockJobs = [];
});

const makeJob = (id: string, status: any, groupId: string, kind: "source" | "format") => ({
  id,
  filename: `${id}.mkv`,
  status,
  progress: 50,
  matchedMediaId: groupId,
  groupId,
  uploadSpeedMbps: 0,
  jobType: kind === "source" ? "source" : "transcode",
});

const makeGroup = (id: string, jobs: any[], status: any) => ({
  id,
  title: id,
  posterPath: null,
  type: undefined,
  jobs,
  progress: 50,
  status,
  uploadSpeedMbps: 0,
});

// On assertion failure, dump the captured LabJobsData (the activeGroups /
// jobs the badge count derives from) plus the source mock groups so a
// counting regression is diagnosable from the CI log alone. Wrapped so a
// dump failure can't mask the real assertion failure.
const dumpActiveCountSnapshot = (
  label: string,
  captured: { activeGroups?: any[]; jobs?: any[] } | null,
) => {
  try {
    console.error(`=== [top-nav-jobs-active-count:${label}] snapshot ===`);
    console.error(
      `mockGroups (${mockGroups.length}): ${JSON.stringify(mockGroups.map((g) => ({ id: g.id, status: g.status, jobs: g.jobs.length })))}`,
    );
    console.error(`mockJobs count=${mockJobs.length}`);
    if (captured) {
      console.error(
        `captured.activeGroups (${captured.activeGroups?.length ?? 0}): ${JSON.stringify((captured.activeGroups ?? []).map((g) => g.id))}`,
      );
      console.error(`captured.jobs.length=${captured.jobs?.length ?? 0}`);
    } else {
      console.error(`captured is null — Probe never received useLabJobsData()`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("LabJobsProvider — activeGroups (Round 7 G3)", () => {
  it("[@bugfix][@regression-proof] two groups each with 1 source + 1 format active job → activeGroups.length is 2 not 4", async () => {
    mockGroups = [
      makeGroup(
        "media-1",
        [
          makeJob("job-1-src", "uploading", "media-1", "source"),
          makeJob("job-1-fmt", "transcoding", "media-1", "format"),
        ],
        "uploading",
      ),
      makeGroup(
        "media-2",
        [
          makeJob("job-2-src", "uploading", "media-2", "source"),
          makeJob("job-2-fmt", "transcoding", "media-2", "format"),
        ],
        "uploading",
      ),
    ];
    mockJobs = mockGroups.flatMap((g) => g.jobs);
    console.info(
      `[top-nav-jobs-active-count:setup] 2 groups x (1 source + 1 format) = ${mockJobs.length} jobs; expect activeGroups=2`,
    );

    const { LabJobsProvider, useLabJobsData } = await import(
      "../src/renderer/src/lib/labJobs"
    );

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
    const captured = holder.current;

    console.info(
      `[top-nav-jobs-active-count:assert] captured.activeGroups=${captured ? captured.activeGroups.length : "null"} captured.jobs=${captured ? captured.jobs.length : "null"}`,
    );
    if (!captured || captured.activeGroups.length !== 2 || captured.jobs.length !== 4) {
      dumpActiveCountSnapshot("two-groups-four-jobs", captured);
    }
    expect(captured).not.toBeNull();
    expect(captured!.activeGroups).toHaveLength(2);
    // Sanity: the flat job count is 4 — we are deliberately diverging from it.
    expect(captured!.jobs.length).toBe(4);
  });

  it("[@bugfix][@regression-proof] groups with no in-progress job (done, cancelled, failed) are excluded from activeGroups", async () => {
    mockGroups = [
      makeGroup("media-active", [makeJob("a", "uploading", "media-active", "source")], "uploading"),
      makeGroup("media-done", [makeJob("d", "done", "media-done", "source")], "done"),
      makeGroup(
        "media-cancelled",
        [makeJob("c", "cancelled", "media-cancelled", "source")],
        "cancelled",
      ),
      makeGroup("media-failed", [makeJob("f", "failed", "media-failed", "source")], "failed"),
    ];
    mockJobs = mockGroups.flatMap((g) => g.jobs);
    console.info(
      `[top-nav-jobs-active-count:setup] 4 groups (active, done, cancelled, failed); expect activeGroups=[media-active]`,
    );

    const { LabJobsProvider, useLabJobsData } = await import(
      "../src/renderer/src/lib/labJobs"
    );

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
    const captured = holder.current;

    const observedIds = captured ? captured.activeGroups.map((g) => g.id).sort() : null;
    console.info(`[top-nav-jobs-active-count:assert] activeGroups ids=${JSON.stringify(observedIds)}`);
    if (JSON.stringify(observedIds) !== JSON.stringify(["media-active"])) {
      dumpActiveCountSnapshot("excludes-done-cancelled-failed", captured);
    }
    // Only a group with a job still able to run counts: a failed group needs
    // attention in the sidebar, but nothing in it runs, so the top-nav icon
    // must not spin for it (tests/top-nav-jobs-idle-icon.test.tsx).
    expect(captured!.activeGroups.map((g) => g.id).sort()).toEqual(["media-active"]);
  });
});
