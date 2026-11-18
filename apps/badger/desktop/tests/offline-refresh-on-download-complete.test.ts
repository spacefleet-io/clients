// @vitest-environment jsdom
//
// @bugfix offline-download-completion-no-badge
// @regression-proof
//
// Bug: after an offline download job completes successfully, no "available
// offline" badge / per-episode "saved" state appears in the UI — even though
// the file is on disk AND the `media_local_downloads` row was written by the
// runtime. Root cause: the renderer's offline-state store (offlineState.ts)
// hydrates exactly once per app session via a module-level `bootstrapped`
// flag (acquireOfflineState), which runs at app startup — before any download
// exists. There is NO signal that re-hydrates the store when a download job
// finishes: the submit-time refresh fires before the row is written, and the
// modal-open reconcile only refreshes when a file was *dropped*.
//
// Fix: the central runtime-jobs store (runtimeJobsStore.ts) is the single seam
// every job event flows through. On a `runtime.jobs.succeeded` event for a
// `download`-kind job, re-hydrate the offline store for that media so the
// badge + button state light up immediately.
//
// This test drives the store's captured `onEvent` callback directly and
// asserts the offline-state refresh is (a) called for a download success and
// (b) NOT called for unrelated (format/source) successes — pinning the precise
// contract so we neither miss the refresh nor over-refresh on every ingest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Capture the SSE stream's onEvent so we can synthesize runtime job events.
const mockStream = {
  start: vi.fn(async () => undefined),
  stop: vi.fn(),
};
let capturedOnEvent: ((e: unknown) => void) | null = null;
const createStreamMock = vi.fn((cfg: { onEvent: (e: unknown) => void }) => {
  capturedOnEvent = cfg.onEvent;
  return mockStream;
});
vi.mock("@space/runtime-client/jobsV2", () => ({
  createRuntimeJobsV2Stream: createStreamMock,
}));

// Spy on the offline-state store API the fix is expected to call.
const refreshOfflineStateForMedia = vi.fn();
const refreshOfflineState = vi.fn();
vi.mock("../src/renderer/src/lib/offlineState", () => ({
  refreshOfflineStateForMedia,
  refreshOfflineState,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleRecord = (overrides: Record<string, unknown> = {}) => ({
  jobId: "job-dl-1",
  app: "badger",
  kind: "download",
  lane: "download",
  status: "succeeded",
  stageCode: "done",
  stageLabel: "Done",
  progress: { mode: "none", completed: null, total: null, unit: null },
  payload: {},
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-06-03T22:00:00Z",
  updatedAt: "2026-06-03T22:53:49Z",
  startedAt: "2026-06-03T22:50:00Z",
  finishedAt: "2026-06-03T22:53:49Z",
  groupId: "media-bn99",
  mediaId: "media-bn99",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 100,
  ...overrides,
});

const succeededEvent = (job: Record<string, unknown>, libraryVersionAtDone?: number) => ({
  eventId: 42,
  emittedAt: "2026-06-03T22:53:49Z",
  event: "runtime.jobs.succeeded",
  job,
  libraryVersionAtDone,
});

const setupSf = () => {
  (globalThis as unknown as { window: Record<string, unknown> }).window =
    (globalThis as unknown as { window?: Record<string, unknown> }).window || {};
  (globalThis as unknown as { window: { sf: unknown } }).window.sf = {
    runtimeJobs: {
      // Empty bootstrap snapshot — mirrors the real-world ordering where the
      // download had not completed at the time the store first hydrated.
      list: vi.fn(async () => ({ jobs: [], maxEventId: 0 })),
      getStreamUrl: vi.fn(async () => ({
        url: "http://127.0.0.1:3020/runtime/events/jobs/v2/stream?token=t",
        httpBaseUrl: "http://127.0.0.1:3020",
        token: "t",
      })),
    },
  };
};

// Drain microtasks AND one macrotask — bootstrap() awaits list() →
// getStreamUrl() → start(), and the offline refresh is dispatched via a
// dynamic `import("./offlineState")` whose `.then` resolves on a later tick.
const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("offline-state refresh on download-job completion", () => {
  beforeEach(async () => {
    const { __resetRuntimeJobsStoreForTests } = await import(
      "../src/renderer/src/lib/runtimeJobsStore"
    );
    __resetRuntimeJobsStoreForTests();
    setupSf();
    refreshOfflineStateForMedia.mockClear();
    refreshOfflineState.mockClear();
    mockStream.start.mockClear();
    mockStream.stop.mockClear();
    createStreamMock.mockClear();
    capturedOnEvent = null;
  });

  afterEach(async () => {
    const { release, getSnapshot } = await import("../src/renderer/src/lib/runtimeJobsStore");
    // Best-effort: drop our acquire so timers/stream are torn down.
    try {
      release();
    } catch {
      /* ignore */
    }
    void getSnapshot();
  });

  it("re-hydrates offline state for the media when a download job succeeds", async () => {
    const { acquire } = await import("../src/renderer/src/lib/runtimeJobsStore");
    acquire();
    await flush();
    expect(capturedOnEvent, "stream onEvent should be captured after bootstrap").toBeTruthy();

    capturedOnEvent!(succeededEvent(sampleRecord({ kind: "download", mediaId: "media-bn99" })));
    await flush();

    // The whole point of the fix: the offline store learns about the new file.
    expect(refreshOfflineStateForMedia).toHaveBeenCalledWith("media-bn99");
  });

  it("falls back to a full offline refresh when the download job has no mediaId", async () => {
    const { acquire } = await import("../src/renderer/src/lib/runtimeJobsStore");
    acquire();
    await flush();

    capturedOnEvent!(
      succeededEvent(sampleRecord({ kind: "download", mediaId: undefined, groupId: undefined })),
    );
    await flush();

    expect(refreshOfflineStateForMedia).not.toHaveBeenCalled();
    expect(refreshOfflineState).toHaveBeenCalledTimes(1);
  });

  it("does NOT refresh offline state for a non-download (format) job success", async () => {
    const { acquire } = await import("../src/renderer/src/lib/runtimeJobsStore");
    acquire();
    await flush();

    capturedOnEvent!(succeededEvent(sampleRecord({ kind: "format", mediaId: "media-bn99" })));
    await flush();

    expect(refreshOfflineStateForMedia).not.toHaveBeenCalled();
    expect(refreshOfflineState).not.toHaveBeenCalled();
  });

  it("does NOT refresh offline state for a download job that only STARTED (not yet succeeded)", async () => {
    const { acquire } = await import("../src/renderer/src/lib/runtimeJobsStore");
    acquire();
    await flush();

    // A started event for the download — file not written yet, must not refresh.
    capturedOnEvent!({
      eventId: 7,
      emittedAt: "2026-06-03T22:50:00Z",
      event: "runtime.jobs.started",
      jobId: "job-dl-1",
      groupId: "media-bn99",
    });
    await flush();

    expect(refreshOfflineStateForMedia).not.toHaveBeenCalled();
    expect(refreshOfflineState).not.toHaveBeenCalled();
  });
});
