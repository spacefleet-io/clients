// @vitest-environment jsdom
//
// @bugfix @regression-proof issue #25 P19 — job-progress SSE re-renders of the
// hidden app window (ultimate confirmation run, seed 1791373829836: about 6 %
// of hidden-window long-frame attribution was
// `EventSource.onruntime.jobs.progress`). While main reports the window
// hidden, `runtime.jobs.progress` events update the store but do not notify
// listeners; a non-progress event or the window showing again notifies once
// with the coalesced state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStream = { start: vi.fn(async () => undefined), stop: vi.fn() };
let capturedOnEvent: ((e: unknown) => void) | null = null;
vi.mock("@space/runtime-client/jobsV2", () => ({
  createRuntimeJobsV2Stream: vi.fn((cfg: { onEvent: (e: unknown) => void }) => {
    capturedOnEvent = cfg.onEvent;
    return mockStream;
  }),
}));
vi.mock("../src/renderer/src/lib/offlineState", () => ({
  refreshOfflineStateForMedia: vi.fn(),
  refreshOfflineState: vi.fn(),
}));

import {
  __resetAppWindowVisibilityForTests,
  __setAppWindowHiddenForTests,
} from "../src/renderer/src/lib/appWindowVisibility";
import {
  __resetRuntimeJobsStoreForTests,
  acquire,
  getSnapshot,
  release,
  subscribe,
} from "../src/renderer/src/lib/runtimeJobsStore";

const LOG = "[runtime-jobs-hidden-coalesce]";
const JOB_ID = "job-fmt-720p";

const record = {
  jobId: JOB_ID,
  app: "badger",
  kind: "format",
  lane: "transcode",
  status: "running",
  stageCode: "transcode",
  stageLabel: "Transcoding",
  progress: { mode: "none", completed: null, total: null, unit: null },
  payload: {},
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-10-07T11:50:00Z",
  updatedAt: "2026-10-07T11:50:00Z",
  startedAt: "2026-10-07T11:50:00Z",
  finishedAt: null,
  groupId: "media-1",
  mediaId: "media-1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 0,
};

let eventId = 100;
const progressEvent = (progressPct: number) => ({
  eventId: ++eventId,
  emittedAt: "2026-10-07T11:51:00Z",
  event: "runtime.jobs.progress",
  jobId: JOB_ID,
  progressPct,
});

// bootstrap() awaits list() → getStreamUrl() → start(); drain those hops
// (promise-only, no wall-clock wait).
const flushBootstrap = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

beforeEach(() => {
  __resetRuntimeJobsStoreForTests();
  __resetAppWindowVisibilityForTests();
  capturedOnEvent = null;
  window.sf = {
    runtimeJobs: {
      list: vi.fn(async () => ({ jobs: [record], maxEventId: 100 })),
      getStreamUrl: vi.fn(async () => ({
        url: "http://127.0.0.1:3020/runtime/events/jobs/v2/stream?token=t",
        httpBaseUrl: "http://127.0.0.1:3020",
        token: "t",
      })),
    },
  } as unknown as Window["sf"];
});

afterEach(() => {
  release();
  __resetRuntimeJobsStoreForTests();
  __resetAppWindowVisibilityForTests();
});

describe("runtime jobs store while the app window is hidden (@bugfix @regression-proof issue #25 P19)", () => {
  it("coalesces hidden progress events into one notification on show, state stays current", async () => {
    acquire();
    await flushBootstrap();
    expect(capturedOnEvent).toBeTruthy();
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    capturedOnEvent!(progressEvent(5));
    console.info(`${LOG} visible progress → notifications=${listener.mock.calls.length}`);
    expect(listener).toHaveBeenCalledTimes(1);

    __setAppWindowHiddenForTests({ hidden: true, atMs: Date.now(), reason: "external-mpv-hide" });
    for (let pct = 6; pct <= 45; pct += 1) capturedOnEvent!(progressEvent(pct));
    const hiddenPct = getSnapshot().byId.get(JOB_ID)?.progressPct;
    console.info(`${LOG} 40 hidden progress events → notifications=${listener.mock.calls.length} storePct=${hiddenPct}`);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hiddenPct).toBe(45);

    __setAppWindowHiddenForTests({ hidden: false, atMs: Date.now(), reason: "external-mpv-show" });
    console.info(`${LOG} show → notifications=${listener.mock.calls.length}`);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSnapshot().byId.get(JOB_ID)?.progressPct).toBe(45);
    unsubscribe();
  });

  it("still notifies non-progress events at once while hidden (a finished format must not wait for show)", async () => {
    acquire();
    await flushBootstrap();
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    __setAppWindowHiddenForTests({ hidden: true, atMs: Date.now(), reason: "external-mpv-hide" });

    capturedOnEvent!(progressEvent(99));
    capturedOnEvent!({
      eventId: ++eventId,
      emittedAt: "2026-10-07T11:52:00Z",
      event: "runtime.jobs.succeeded",
      job: { ...record, status: "succeeded", progressPct: 100 },
    });
    console.info(`${LOG} hidden progress+succeeded → notifications=${listener.mock.calls.length} status=${getSnapshot().byId.get(JOB_ID)?.status}`);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSnapshot().byId.get(JOB_ID)?.status).toBe("succeeded");

    // Nothing left to flush: the succeeded notification carried the progress.
    __setAppWindowHiddenForTests({ hidden: false, atMs: Date.now(), reason: "external-mpv-show" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
