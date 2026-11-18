// @vitest-environment jsdom
//
// Issue #2461: during a 5-file ingest the Home page dropped to p95 33-50 ms
// frames on the low-end profile. A Chrome trace put the cost in drawing, not
// JS: 150 twinkling stars and 3 shooting stars kept every frame restyling and
// compositing (UX-SKY-01). LabJobsProvider now marks <html data-app-busy>
// while a job can still run, and the AppBackdrop stops the sky under it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_BUSY_ATTRIBUTE } from "@space/ui/app-busy-mark";
import { LabJobsProvider } from "../src/renderer/src/lib/labJobs";
import type { LabJob } from "../src/shared/labQueueShared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockJobs: LabJob[] = [];

vi.mock("@/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: () => ({ jobs: mockJobs, groups: [], loading: false, error: null, runtimeError: null }),
  useRuntimeIngestActions: () => ({
    cancelJob: vi.fn(async () => undefined),
    cancelByGroup: vi.fn(async () => undefined),
    dismissJob: vi.fn(async () => undefined),
    retryJob: vi.fn(async () => undefined),
    submitSources: vi.fn(async () => ({ submitted: [] })),
  }),
  // The mocked hook already hands out LabJobs.
  ingestJobsToLabJobs: (records: LabJob[]) => records,
}));

vi.mock("@/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: [] }),
  useOptionalLibraryData: () => ({ media: [] }),
}));

// The provider also reports processing to the main process; not under test here.
Object.assign(window, { sf: { setWindowProcessingState: vi.fn() } });

const job = (id: string, status: LabJob["status"]): LabJob => {
  // Only the fields the provider reads; the rest of LabJob is irrelevant here.
  const partial = { id, filename: `${id}.mkv`, status, progress: 50, matchedMediaId: id, groupId: id, uploadSpeedMbps: 0 };
  return partial as unknown as LabJob;
};

const busy = () => document.documentElement.hasAttribute(APP_BUSY_ATTRIBUTE);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  mockJobs = [];
});

describe("[@bugfix #2461][@regression-proof] LabJobsProvider stops the star sky while jobs run", () => {
  it("marks <html data-app-busy> while a job can run and clears it when every job settled or on unmount", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const states: Record<string, boolean> = {};

    mockJobs = [job("a", "uploading"), job("b", "done")];
    await act(async () => root?.render(<LabJobsProvider>{null}</LabJobsProvider>));
    states.processing = busy();

    mockJobs = [job("a", "done"), job("b", "done")];
    await act(async () => root?.render(<LabJobsProvider>{null}</LabJobsProvider>));
    states.settled = busy();

    mockJobs = [job("c", "transcoding")];
    await act(async () => root?.render(<LabJobsProvider>{null}</LabJobsProvider>));
    states.processingAgain = busy();

    act(() => root?.unmount());
    root = null;
    states.unmounted = busy();

    console.info(`[lab-jobs-sky-busy-mark:test] states=${JSON.stringify(states)}`);
    expect(states).toEqual({ processing: true, settled: false, processingAgain: true, unmounted: false });
  });
});
