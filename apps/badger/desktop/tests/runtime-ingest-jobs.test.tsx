// @vitest-environment jsdom
//
// Hook tests for `useRuntimeIngestJobs` + `useRuntimeIngestActions`.
//
// Coverage:
//   - bootstrap snapshot is loaded into state
//   - live events update jobsById
//   - cancel/dismiss/retry route through the right window.sf calls
//   - subscribe cleanup on unmount stops the SSE stream

import React, { useEffect } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
// Imported up front, not inside the label tests: its module graph (labJobs →
// libraryContext) is large, and a cold dynamic import counted against the
// 15 s test timeout on a loaded runner (ci run 34854).
import { buildActiveLabJobPresentation } from "../src/renderer/src/components/labJobPresentation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStream = {
  start: vi.fn(async () => undefined),
  stop: vi.fn(),
  subscribeFreshSnapshot: vi.fn(async () => ({ jobs: [], maxEventId: 0 })),
};
let capturedOnEvent: ((e: any) => void) | null = null;

const createStreamMock = vi.fn((cfg: any) => {
  capturedOnEvent = cfg.onEvent;
  return mockStream;
});

// Lazy: the static import above loads this mock before createStreamMock exists.
vi.mock("@space/runtime-client/jobsV2", () => ({
  createRuntimeJobsV2Stream: (cfg: Parameters<typeof createStreamMock>[0]) => createStreamMock(cfg),
}));

const sampleRecord = (overrides: Record<string, unknown> = {}) => ({
  jobId: "job-1",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "init",
  stageLabel: "Init",
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
  progressPct: 0,
  ...overrides,
});

const setupSf = (overrides: Partial<Record<string, any>> = {}) => {
  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.sf = {
    runtimeJobs: {
      list: vi.fn(async () => ({ jobs: [sampleRecord()], maxEventId: 5 })),
      getStreamUrl: vi.fn(async () => ({
        url: "http://127.0.0.1:3020/runtime/events/jobs/v2/stream?token=t",
        httpBaseUrl: "http://127.0.0.1:3020",
        token: "t",
      })),
      cancel: vi.fn(async () => ({ cancelled: true })),
      cancelByGroup: vi.fn(async () => ({ cancelled: true })),
      dismiss: vi.fn(async () => ({ dismissed: true })),
      retry: vi.fn(async () => ({ retried: true })),
      submitSources: vi.fn(async () => ({ submitted: [] })),
      ...overrides,
    },
  };
};

// ---------------------------------------------------------------------------
// Diagnostic logging (per the tests-log-generously convention).
// Suite id: runtime-ingest-jobs. Phase markers: `[runtime-ingest-jobs:<phase>]`.
// dumpRuntimeIngestJobsSnapshot prints the live `window.sf.runtimeJobs` mock
// call counts + the stream-mock state + (optionally) the converter/store
// output so a failed assertion shows the exact in-renderer context.
// ---------------------------------------------------------------------------

const dumpRuntimeIngestJobsSnapshot = (
  label: string,
  ctx: { observed?: unknown; expected?: unknown; extra?: Record<string, unknown> } = {},
) => {
  try {
    const sf = (globalThis as any).window?.sf?.runtimeJobs ?? {};
    const mockCallCounts = Object.fromEntries(
      Object.entries(sf).map(([k, v]) => [
        k,
        (v as any)?.mock?.calls?.length ?? "(not-a-mock)",
      ]),
    );
    console.error(`=== [runtime-ingest-jobs:${label}] snapshot ===`);
    console.error(`window.sf.runtimeJobs mock call counts: ${JSON.stringify(mockCallCounts)}`);
    console.error(
      `stream mock: createStreamMock.calls=${createStreamMock.mock.calls.length} start.calls=${mockStream.start.mock.calls.length} stop.calls=${mockStream.stop.mock.calls.length} subscribeFreshSnapshot.calls=${mockStream.subscribeFreshSnapshot.mock.calls.length}`,
    );
    console.error(`capturedOnEvent bound: ${capturedOnEvent != null}`);
    if (ctx.expected !== undefined || ctx.observed !== undefined) {
      console.error(`expected: ${JSON.stringify(ctx.expected)}`);
      console.error(`observed: ${JSON.stringify(ctx.observed)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const renderHook = async <T,>(useHook: () => T): Promise<{ getValue: () => T }> => {
  let value!: T;
  const Probe = () => {
    value = useHook();
    return null;
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(Probe));
  });
  await flush();
  return { getValue: () => value };
};

describe("useRuntimeIngestJobs", () => {
  beforeEach(async () => {
    console.info("[runtime-ingest-jobs:setup] resetting shared jobs store + mocks");
    const { __resetRuntimeJobsStoreForTests } = await import(
      "../src/renderer/src/lib/runtimeJobsStore"
    );
    __resetRuntimeJobsStoreForTests();
    setupSf();
    mockStream.start.mockClear();
    mockStream.stop.mockClear();
    mockStream.subscribeFreshSnapshot.mockClear();
    createStreamMock.mockClear();
    capturedOnEvent = null;
    console.info("[runtime-ingest-jobs:setup] store + mocks reset, sf seeded");
  });

  afterEach(() => {
    if (root && container) {
      act(() => root?.unmount());
    }
    root = null;
    container?.parentNode?.removeChild(container);
    container = null;
  });

  it("loads the bootstrap snapshot into state", async () => {
    console.info("[runtime-ingest-jobs:bootstrap-snapshot] mounting hook to load bootstrap snapshot");
    const { useRuntimeIngestJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const { getValue } = await renderHook(() => useRuntimeIngestJobs());
    const ids = getValue().jobs.map((j) => j.jobId);
    console.info(`[runtime-ingest-jobs:bootstrap-snapshot] jobIds=${JSON.stringify(ids)} loading=${getValue().loading}`);
    try {
      expect(ids).toEqual(["job-1"]);
      expect(getValue().loading).toBe(false);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("bootstrap-snapshot:fail", {
        expected: { jobIds: ["job-1"], loading: false },
        observed: { jobIds: ids, loading: getValue().loading },
      });
      throw err;
    }
  });

  it("updates jobsById from live progress events", async () => {
    console.info("[runtime-ingest-jobs:live-progress] mounting hook then emitting progress event (pct=42)");
    const { useRuntimeIngestJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const { getValue } = await renderHook(() => useRuntimeIngestJobs());
    try {
      expect(capturedOnEvent).toBeTruthy();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("live-progress:no-onEvent-bound", {});
      throw err;
    }
    await act(async () => {
      capturedOnEvent!({
        eventId: 6,
        emittedAt: "2026-04-01T00:00:01Z",
        event: "runtime.jobs.progress",
        jobId: "job-1",
        groupId: "media-1",
        progressPct: 42,
        stageCode: "encode",
        stageLabel: "Encoding",
        uploadSpeedBytesPerSec: null,
      });
    });
    const observed = getValue().jobs[0]?.progressPct;
    console.info(`[runtime-ingest-jobs:live-progress] post-event jobs[0].progressPct=${observed}`);
    try {
      expect(observed).toBe(42);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("live-progress:fail", {
        expected: 42,
        observed,
        extra: { jobs: getValue().jobs },
      });
      throw err;
    }
  });

  it("creates a record for runtime.jobs.created", async () => {
    console.info("[runtime-ingest-jobs:created-event] empty bootstrap then emit jobs.created for job-2");
    setupSf({ list: vi.fn(async () => ({ jobs: [], maxEventId: 0 })) });
    const { useRuntimeIngestJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const { getValue } = await renderHook(() => useRuntimeIngestJobs());
    try {
      expect(getValue().jobs).toHaveLength(0);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("created-event:non-empty-bootstrap", {
        observed: getValue().jobs.map((j) => j.jobId),
      });
      throw err;
    }
    await act(async () => {
      capturedOnEvent!({
        eventId: 1,
        emittedAt: "2026-04-01T00:00:01Z",
        event: "runtime.jobs.created",
        job: sampleRecord({ jobId: "job-2" }),
      });
    });
    const ids = getValue().jobs.map((j) => j.jobId);
    console.info(`[runtime-ingest-jobs:created-event] post-event jobIds=${JSON.stringify(ids)}`);
    try {
      expect(ids).toEqual(["job-2"]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("created-event:fail", { expected: ["job-2"], observed: ids });
      throw err;
    }
  });

  it("removes records on runtime.jobs.dismissed", async () => {
    console.info("[runtime-ingest-jobs:dismissed-event] mount then emit jobs.dismissed for job-1");
    const { useRuntimeIngestJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const { getValue } = await renderHook(() => useRuntimeIngestJobs());
    await act(async () => {
      capturedOnEvent!({
        eventId: 7,
        emittedAt: "2026-04-01T00:00:02Z",
        event: "runtime.jobs.dismissed",
        jobId: "job-1",
        groupId: "media-1",
        dismissedAt: "2026-04-01T00:00:02Z",
      });
    });
    const remaining = getValue().jobs.map((j) => j.jobId);
    console.info(`[runtime-ingest-jobs:dismissed-event] remaining jobIds=${JSON.stringify(remaining)}`);
    try {
      expect(getValue().jobs).toHaveLength(0);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("dismissed-event:fail", { expected: [], observed: remaining });
      throw err;
    }
  });

  it("filters by mediaId", async () => {
    setupSf({
      list: vi.fn(async () => ({
        jobs: [
          sampleRecord({ jobId: "j1", mediaId: "media-1", groupId: "media-1" }),
          sampleRecord({ jobId: "j2", mediaId: "media-2", groupId: "media-2" }),
        ],
        maxEventId: 0,
      })),
    });
    console.info("[runtime-ingest-jobs:filter-mediaId] seeding j1(media-1) + j2(media-2), filter=media-1");
    const { useRuntimeIngestJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const { getValue } = await renderHook(() => useRuntimeIngestJobs({ mediaId: "media-1" }));
    const ids = getValue().jobs.map((j) => j.jobId);
    console.info(`[runtime-ingest-jobs:filter-mediaId] filtered jobIds=${JSON.stringify(ids)}`);
    try {
      expect(ids).toEqual(["j1"]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("filter-mediaId:fail", { expected: ["j1"], observed: ids });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] mediaId filter includes replan jobs whose groupId is structured (replan:<mediaId>:...)", async () => {
    // The replan flow (mediaReplan.ts) sets groupId to
    //   `replan:${mediaId}:${fileId}:${variant}`
    // so each new transcode lives in its own group. Pre-fix the renderer
    // filter `(j.groupId ?? j.mediaId) === filter.mediaId` always picked
    // groupId first, which never matched the bare mediaId — the job was
    // shown in the sidebar (unfiltered) but not in the MediaDetailsDialog's
    // per-media jobs tab. Filter must include the job by mediaId match.
    console.info(
      "[runtime-ingest-jobs:setup] seeding 3 jobs: (1) ingest source matching by groupId+mediaId, (2) replan job matching by mediaId only (structured groupId), (3) unrelated other-media job",
    );
    setupSf({
      list: vi.fn(async () => ({
        jobs: [
          sampleRecord({
            jobId: "ingest-source",
            mediaId: "media-1",
            groupId: "media-1",
          }),
          sampleRecord({
            jobId: "replan-format",
            mediaId: "media-1",
            groupId: "replan:media-1:file-1:240p",
            kind: "format",
            variant: "240p",
          }),
          sampleRecord({
            jobId: "other-media",
            mediaId: "media-2",
            groupId: "media-2",
          }),
        ],
        maxEventId: 0,
      })),
    });
    const { useRuntimeIngestJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const { getValue } = await renderHook(() => useRuntimeIngestJobs({ mediaId: "media-1" }));
    const ids = getValue().jobs.map((j) => j.jobId).sort();
    console.info(`[runtime-ingest-jobs:exec] mediaId=media-1 filter result jobIds=${JSON.stringify(ids)}`);
    try {
      // Must include BOTH the ingest job and the replan job; must exclude
      // the other-media job. Pre-fix produced only ["ingest-source"].
      expect(ids).toEqual(["ingest-source", "replan-format"]);
    } catch (err) {
      console.error(
        `[runtime-ingest-jobs:fail] expected [ingest-source, replan-format], got ${JSON.stringify(ids)}`,
      );
      dumpRuntimeIngestJobsSnapshot("replan-mediaId-filter:fail", {
        expected: ["ingest-source", "replan-format"],
        observed: ids,
      });
      throw err;
    }
  });

  it("calls stream.stop on unmount", async () => {
    console.info("[runtime-ingest-jobs:stop-on-unmount] mount then unmount, expect stream.stop");
    const { useRuntimeIngestJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    await renderHook(() => useRuntimeIngestJobs());
    act(() => root?.unmount());
    root = null;
    console.info(`[runtime-ingest-jobs:stop-on-unmount] stream.stop.calls=${mockStream.stop.mock.calls.length}`);
    try {
      expect(mockStream.stop).toHaveBeenCalled();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("stop-on-unmount:fail", {});
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] N consumers share one stream connection", async () => {
    // Round-6 bug: the modal stayed stale because each useRuntimeIngestJobs
    // instance opened its own subscription, leaving three independent state
    // maps. With the shared store, two consumers must share one EventSource
    // (and therefore one createRuntimeJobsV2Stream call).
    const { useRuntimeIngestJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    let valSidebar!: ReturnType<typeof useRuntimeIngestJobs>;
    let valModal!: ReturnType<typeof useRuntimeIngestJobs>;
    const Probe = () => {
      valSidebar = useRuntimeIngestJobs();
      valModal = useRuntimeIngestJobs({ mediaId: "media-1" });
      return null;
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    console.info("[runtime-ingest-jobs:shared-stream] mounting sidebar + modal consumers in one root");
    await act(async () => {
      root?.render(React.createElement(Probe));
    });
    await flush();
    const listCalls = ((globalThis as any).window.sf.runtimeJobs.list as any).mock.calls.length;
    console.info(
      `[runtime-ingest-jobs:shared-stream] createStreamMock.calls=${createStreamMock.mock.calls.length} list.calls=${listCalls} sidebar.jobs=${valSidebar.jobs.length} modal.jobs=${valModal.jobs.length}`,
    );
    try {
      expect(createStreamMock).toHaveBeenCalledTimes(1);
      expect(listCalls).toBe(1);
      expect(valSidebar.jobs).toHaveLength(1);
      expect(valModal.jobs).toHaveLength(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("shared-stream:fail", {
        extra: {
          sidebarJobs: valSidebar.jobs.length,
          modalJobs: valModal.jobs.length,
        },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] live event reaches modal-scoped consumer without remount", async () => {
    // The user's headline bug: opening the media-details modal during an
    // ongoing ingest showed stale state because the modal-scoped
    // useRuntimeIngestJobs instance had its own subscription that hadn't
    // received recent events yet. Both consumers must observe the SAME live
    // event in the same act() flush.
    const { useRuntimeIngestJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    let valSidebar!: ReturnType<typeof useRuntimeIngestJobs>;
    let valModal!: ReturnType<typeof useRuntimeIngestJobs>;
    const Probe = () => {
      valSidebar = useRuntimeIngestJobs();
      valModal = useRuntimeIngestJobs({ mediaId: "media-1" });
      return null;
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    console.info("[runtime-ingest-jobs:live-to-modal] mounting both consumers, emitting progress pct=73");
    await act(async () => {
      root?.render(React.createElement(Probe));
    });
    await flush();
    try {
      expect(capturedOnEvent).toBeTruthy();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("live-to-modal:no-onEvent-bound", {});
      throw err;
    }
    await act(async () => {
      capturedOnEvent!({
        eventId: 6,
        emittedAt: "2026-04-01T00:00:01Z",
        event: "runtime.jobs.progress",
        jobId: "job-1",
        groupId: "media-1",
        progressPct: 73,
        stageCode: "encode",
        stageLabel: "Encoding",
        uploadSpeedBytesPerSec: null,
      });
    });
    console.info(
      `[runtime-ingest-jobs:live-to-modal] sidebar.pct=${valSidebar.jobs[0]?.progressPct} modal.pct=${valModal.jobs[0]?.progressPct}`,
    );
    try {
      expect(valSidebar.jobs[0]?.progressPct).toBe(73);
      expect(valModal.jobs[0]?.progressPct).toBe(73);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("live-to-modal:fail", {
        expected: 73,
        extra: {
          sidebarPct: valSidebar.jobs[0]?.progressPct,
          modalPct: valModal.jobs[0]?.progressPct,
        },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] refcount: third mount during second's lifetime does not re-bootstrap", async () => {
    console.info("[runtime-ingest-jobs:refcount-third-mount] mounting 3 consumers across 3 roots");
    const { useRuntimeIngestJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    // First mount.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const Probe1 = () => {
      useRuntimeIngestJobs();
      return null;
    };
    await act(async () => {
      root?.render(React.createElement(Probe1));
    });
    await flush();

    // Mount a second consumer in a separate root while the first is alive.
    const container2 = document.createElement("div");
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    const Probe2 = () => {
      useRuntimeIngestJobs();
      return null;
    };
    await act(async () => {
      root2.render(React.createElement(Probe2));
    });
    await flush();

    // Mount a third consumer.
    const container3 = document.createElement("div");
    document.body.appendChild(container3);
    const root3 = createRoot(container3);
    const Probe3 = () => {
      useRuntimeIngestJobs({ mediaId: "media-1" });
      return null;
    };
    await act(async () => {
      root3.render(React.createElement(Probe3));
    });
    await flush();

    // No re-bootstrap: list called once, stream constructor called once.
    const listCallsAfter3 = ((globalThis as any).window.sf.runtimeJobs.list as any).mock.calls.length;
    console.info(
      `[runtime-ingest-jobs:refcount-third-mount] after 3 mounts list.calls=${listCallsAfter3} createStreamMock.calls=${createStreamMock.mock.calls.length}`,
    );
    try {
      expect(listCallsAfter3).toBe(1);
      expect(createStreamMock).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("refcount-third-mount:rebootstrap", {});
      throw err;
    }

    // Tear down the second + third roots.
    act(() => root2.unmount());
    container2.parentNode?.removeChild(container2);
    act(() => root3.unmount());
    container3.parentNode?.removeChild(container3);
    // Stream not stopped yet — first root still holds a refcount.
    console.info(
      `[runtime-ingest-jobs:refcount-third-mount] after tearing 2nd+3rd roots stream.stop.calls=${mockStream.stop.mock.calls.length} (first root still alive)`,
    );
    try {
      expect(mockStream.stop).not.toHaveBeenCalled();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("refcount-third-mount:premature-stop", {});
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] refcount: full teardown then remount reopens stream and re-fetches snapshot", async () => {
    console.info("[runtime-ingest-jobs:refcount-teardown-remount] mount → full teardown → remount");
    const { useRuntimeIngestJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const Probe = () => {
      useRuntimeIngestJobs();
      return null;
    };
    await act(async () => {
      root?.render(React.createElement(Probe));
    });
    await flush();

    const listCallsInitial = ((globalThis as any).window.sf.runtimeJobs.list as any).mock.calls.length;
    console.info(
      `[runtime-ingest-jobs:refcount-teardown-remount] after first mount list.calls=${listCallsInitial} createStreamMock.calls=${createStreamMock.mock.calls.length}`,
    );
    try {
      expect(listCallsInitial).toBe(1);
      expect(createStreamMock).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("refcount-teardown-remount:initial-mount", {});
      throw err;
    }

    // Full teardown.
    act(() => root?.unmount());
    container.parentNode?.removeChild(container);
    root = null;
    container = null;
    console.info(
      `[runtime-ingest-jobs:refcount-teardown-remount] after teardown stream.stop.calls=${mockStream.stop.mock.calls.length}`,
    );
    try {
      expect(mockStream.stop).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("refcount-teardown-remount:teardown-stop", {});
      throw err;
    }

    // Remount — refcount goes 0 → 1 again, store re-bootstraps.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(Probe));
    });
    await flush();
    const listCallsAfterRemount = ((globalThis as any).window.sf.runtimeJobs.list as any).mock.calls.length;
    console.info(
      `[runtime-ingest-jobs:refcount-teardown-remount] after remount list.calls=${listCallsAfterRemount} createStreamMock.calls=${createStreamMock.mock.calls.length}`,
    );
    try {
      expect(listCallsAfterRemount).toBe(2);
      expect(createStreamMock).toHaveBeenCalledTimes(2);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("refcount-teardown-remount:remount-rebootstrap", {});
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] visibilitychange hidden→visible triggers a fresh snapshot", async () => {
    console.info("[runtime-ingest-jobs:visibilitychange] mount then dispatch hidden→visible");
    const { useRuntimeIngestJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    await renderHook(() => useRuntimeIngestJobs());
    const listMock = (globalThis as any).window.sf.runtimeJobs.list as any;
    try {
      expect(listMock.mock.calls.length).toBe(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("visibilitychange:bad-bootstrap-count", {
        observed: listMock.mock.calls.length,
      });
      throw err;
    }

    // Simulate hidden → visible. jsdom exposes document.visibilityState as a
    // getter, so we monkey-patch via Object.defineProperty.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    console.info(`[runtime-ingest-jobs:visibilitychange] post-visible list.calls=${listMock.mock.calls.length}`);
    try {
      expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("visibilitychange:fail", {
        expected: ">=2",
        observed: listMock.mock.calls.length,
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] heartbeat: no events for >60s with running job triggers reconcile", async () => {
    vi.useFakeTimers();
    setupSf({
      list: vi
        .fn()
        // bootstrap snapshot — one running job present so the heartbeat
        // predicate fires at the threshold.
        .mockResolvedValueOnce({
          jobs: [sampleRecord({ status: "running" })],
          maxEventId: 5,
        })
        // forceRefreshSnapshot triggered by heartbeat.
        .mockResolvedValueOnce({
          jobs: [sampleRecord({ status: "running" })],
          maxEventId: 6,
        }),
    });
    const { useRuntimeIngestJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const Probe = () => {
      useRuntimeIngestJobs();
      return null;
    };
    await act(async () => {
      root?.render(React.createElement(Probe));
    });
    // jsdom + fake timers: drain microtasks so the bootstrap promise resolves.
    console.info("[runtime-ingest-jobs:heartbeat-running] draining bootstrap microtasks (running job seeded)");
    await vi.advanceTimersByTimeAsync(0);

    const listMock = (globalThis as any).window.sf.runtimeJobs.list as any;
    try {
      expect(listMock.mock.calls.length).toBe(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("heartbeat-running:bad-bootstrap-count", {
        observed: listMock.mock.calls.length,
      });
      throw err;
    }

    // Heartbeat fires every 30s. The first tick at t=30s sees a 30s gap (no
    // reconcile). The second tick at t=60s sees a 60s gap (still no reconcile;
    // threshold is strictly `>60s`). The third tick at t=90s sees a 90s gap
    // and fires forceRefreshSnapshot.
    console.info("[runtime-ingest-jobs:heartbeat-running] advancing fake timers by 91s");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(91_000);
    });
    console.info(`[runtime-ingest-jobs:heartbeat-running] after 91s list.calls=${listMock.mock.calls.length}`);
    try {
      expect(listMock.mock.calls.length).toBe(2);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("heartbeat-running:fail", {
        expected: 2,
        observed: listMock.mock.calls.length,
      });
      throw err;
    }
    vi.useRealTimers();
  });

  it("[@bugfix][@regression-proof] heartbeat negative case 1: only queued jobs → NO reconcile", async () => {
    // Queued jobs waiting on a parent emit no events by design. The "running"
    // predicate (vs. "non-terminal") prevents 30s false-positive reconciles
    // during long source ingests with queued format children.
    vi.useFakeTimers();
    setupSf({
      list: vi.fn().mockResolvedValue({
        jobs: [sampleRecord({ status: "queued" })],
        maxEventId: 5,
      }),
    });
    const { useRuntimeIngestJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const Probe = () => {
      useRuntimeIngestJobs();
      return null;
    };
    console.info("[runtime-ingest-jobs:heartbeat-queued-only] mount with queued-only job, draining bootstrap");
    await act(async () => {
      root?.render(React.createElement(Probe));
    });
    await vi.advanceTimersByTimeAsync(0);

    const listMock = (globalThis as any).window.sf.runtimeJobs.list as any;
    try {
      expect(listMock.mock.calls.length).toBe(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("heartbeat-queued-only:bad-bootstrap-count", {
        observed: listMock.mock.calls.length,
      });
      throw err;
    }

    console.info("[runtime-ingest-jobs:heartbeat-queued-only] advancing fake timers by 91s (expect NO reconcile)");
    await vi.advanceTimersByTimeAsync(91_000);
    console.info(`[runtime-ingest-jobs:heartbeat-queued-only] after 91s list.calls=${listMock.mock.calls.length}`);
    // Still 1 — queued-only must not trigger reconcile.
    try {
      expect(listMock.mock.calls.length).toBe(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("heartbeat-queued-only:fail", {
        expected: 1,
        observed: listMock.mock.calls.length,
      });
      throw err;
    }
    vi.useRealTimers();
  });

  it("[@bugfix][@regression-proof] heartbeat negative case 2: all terminal → NO reconcile", async () => {
    vi.useFakeTimers();
    setupSf({
      list: vi.fn().mockResolvedValue({
        jobs: [sampleRecord({ status: "succeeded" })],
        maxEventId: 5,
      }),
    });
    const { useRuntimeIngestJobs } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const Probe = () => {
      useRuntimeIngestJobs();
      return null;
    };
    console.info("[runtime-ingest-jobs:heartbeat-all-terminal] mount with succeeded-only job, draining bootstrap");
    await act(async () => {
      root?.render(React.createElement(Probe));
    });
    await vi.advanceTimersByTimeAsync(0);

    const listMock = (globalThis as any).window.sf.runtimeJobs.list as any;
    try {
      expect(listMock.mock.calls.length).toBe(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("heartbeat-all-terminal:bad-bootstrap-count", {
        observed: listMock.mock.calls.length,
      });
      throw err;
    }
    console.info("[runtime-ingest-jobs:heartbeat-all-terminal] advancing fake timers by 91s (expect NO reconcile)");
    await vi.advanceTimersByTimeAsync(91_000);
    console.info(`[runtime-ingest-jobs:heartbeat-all-terminal] after 91s list.calls=${listMock.mock.calls.length}`);
    try {
      expect(listMock.mock.calls.length).toBe(1);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("heartbeat-all-terminal:fail", {
        expected: 1,
        observed: listMock.mock.calls.length,
      });
      throw err;
    }
    vi.useRealTimers();
  });
});

describe("applyIngestJobEvent — runtime.jobs.progress (Round 7 G1)", () => {
  // Round 7 bug: per-job badge stuck at "queued" while the runtime DB row
  // had already advanced to "running". Root cause was the progress-event
  // reducer never read `event.status`, so a missed `runtime.jobs.started`
  // (late mount, dropped event, replay from low Last-Event-ID) left the
  // in-renderer record stale on the status field. The fix piggy-backs the
  // current status onto every progress event so the reducer can recover.

  it("[@bugfix][@regression-proof] progress event with status flips a queued-stale row to running", async () => {
    const { applyIngestJobEvent } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const cur = sampleRecord({ status: "queued", progressPct: 0 }) as any;
    const byId = new Map([[cur.jobId, cur]]);
    const next = applyIngestJobEvent(byId, {
      eventId: 10,
      emittedAt: "2026-04-01T00:00:01Z",
      event: "runtime.jobs.progress",
      jobId: cur.jobId,
      groupId: "media-1",
      progressPct: 25,
      stageCode: "encode",
      stageLabel: "Encoding",
      uploadSpeedBytesPerSec: null,
      // status is currently being added to runtimeJobsProgressEventSchema by
      // runtime-eng (Round 7 G1). The test deliberately drives the reducer
      // through the field path even before the schema PR lands.
      status: "running",
    } as any);
    const after = next.get(cur.jobId)!;
    console.info(
      `[runtime-ingest-jobs:reducer-status-flip] before.status=${cur.status} after.status=${after.status} after.progressPct=${after.progressPct}`,
    );
    try {
      expect(after.status).toBe("running");
      expect(after.progressPct).toBe(25);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("reducer-status-flip:fail", {
        expected: { status: "running", progressPct: 25 },
        observed: { status: after.status, progressPct: after.progressPct },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] progress event without status preserves the existing status (back-compat)", async () => {
    const { applyIngestJobEvent } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const cur = sampleRecord({ status: "running", progressPct: 10 }) as any;
    const byId = new Map([[cur.jobId, cur]]);
    const next = applyIngestJobEvent(byId, {
      eventId: 11,
      emittedAt: "2026-04-01T00:00:02Z",
      event: "runtime.jobs.progress",
      jobId: cur.jobId,
      groupId: "media-1",
      progressPct: 35,
      stageCode: "encode",
      stageLabel: "Encoding",
      uploadSpeedBytesPerSec: null,
      // No `status` field — covers the replay path where a runtime emitted
      // pre-Round-7 progress events that don't carry status. The reducer
      // must NOT clobber an existing status with undefined.
    } as any);
    const after = next.get(cur.jobId)!;
    console.info(
      `[runtime-ingest-jobs:reducer-status-preserve] before.status=${cur.status} after.status=${after.status} after.progressPct=${after.progressPct}`,
    );
    try {
      expect(after.status).toBe("running");
      expect(after.progressPct).toBe(35);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("reducer-status-preserve:fail", {
        expected: { status: "running", progressPct: 35 },
        observed: { status: after.status, progressPct: after.progressPct },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] progress event refreshes stageCode + stageLabel when present", async () => {
    const { applyIngestJobEvent } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const cur = sampleRecord({
      status: "running",
      stageCode: "init",
      stageLabel: "Init",
    }) as any;
    const byId = new Map([[cur.jobId, cur]]);
    const next = applyIngestJobEvent(byId, {
      eventId: 12,
      emittedAt: "2026-04-01T00:00:03Z",
      event: "runtime.jobs.progress",
      jobId: cur.jobId,
      groupId: "media-1",
      progressPct: 60,
      stageCode: "uploading",
      stageLabel: "Uploading chunks",
      uploadSpeedBytesPerSec: null,
    } as any);
    const after = next.get(cur.jobId)!;
    console.info(
      `[runtime-ingest-jobs:reducer-stage-refresh] after.stageCode=${after.stageCode} after.stageLabel=${after.stageLabel}`,
    );
    try {
      expect(after.stageCode).toBe("uploading");
      expect(after.stageLabel).toBe("Uploading chunks");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("reducer-stage-refresh:fail", {
        expected: { stageCode: "uploading", stageLabel: "Uploading chunks" },
        observed: { stageCode: after.stageCode, stageLabel: after.stageLabel },
      });
      throw err;
    }
  });
});

describe("buildIngestJobGroups + ingestJobsToLabJobs (media-aware converter)", () => {
  // Bug-fix coverage for the three reported V2 ingest UI symptoms:
  //   (1) Modal "Processes" tab disappeared
  //   (2) Ghost poster lost progress in library gallery
  //   (3) Sidebar showed "job" / "a. 4 job" instead of titles + outputs
  // Root cause: V2 → LabJob converter ignored the matched MediaRow and
  // dropped jobType / selectedFormats. These tests exercise the new
  // media-aware converter.

  const mediaRow = (overrides: Record<string, unknown> = {}): any => ({
    id: "media-1",
    type: "movie",
    tmdbId: 100,
    externalIds: null,
    title: "Orchard",
    originalTitle: null,
    originalLanguage: null,
    overview: null,
    year: "2017",
    rating: null,
    posterPath: "/orchard.jpg",
    backdropPath: null,
    genres: [],
    addedAt: "",
    updatedAt: "",
    hasFiles: false,
    progressPct: 0,
    lastWatchedAt: null,
    totalEpisodes: null,
    episodeCount: 0,
    ...overrides,
  });

  it("[@bugfix][@regression-proof] converter populates matchedTo/posterPath from MediaRow (sidebar showed UUIDs as titles)", async () => {
    console.info("[runtime-ingest-jobs:converter-matchedTo] source job + Orchard MediaRow");
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const labJobs = ingestJobsToLabJobs(
      [sampleRecord({ kind: "source" }) as any],
      [mediaRow()]
    );
    try {
      expect(labJobs[0].matchedTo).toEqual({
        title: "Orchard",
        year: "2017",
        posterPath: "/orchard.jpg",
        type: "movie",
      });
      expect(labJobs[0].matchedMediaId).toBe("media-1");
      expect(labJobs[0].detectedTitle).toBe("Orchard");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("converter-matchedTo:fail", {
        extra: { labJob0: labJobs[0] },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] converter sets jobType + selectedFormats so outputLabel is '360p' not 'job'", async () => {
    console.info("[runtime-ingest-jobs:converter-jobType] format(360p) + source variants");
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const labJobs = ingestJobsToLabJobs(
      [sampleRecord({ kind: "format", variant: "360p" }) as any],
      [mediaRow()]
    );
    const srcJobs = ingestJobsToLabJobs(
      [sampleRecord({ kind: "source", variant: null }) as any],
      [mediaRow()]
    );
    try {
      expect(labJobs[0].jobType).toBe("transcode");
      expect(labJobs[0].selectedFormats).toEqual([{ quality: "360p", codec: "h264" }]);
      // Source kind → "source" jobType, no selectedFormats
      expect(srcJobs[0].jobType).toBe("source");
      expect(srcJobs[0].selectedFormats).toBeUndefined();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("converter-jobType:fail", {
        extra: { formatLabJob: labJobs[0], sourceLabJob: srcJobs[0] },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] converter pulls TV detectedSeason/detectedEpisode from payload.hints (S01E01 chip)", async () => {
    console.info("[runtime-ingest-jobs:converter-tv-hints] Saltmarsh S01E01 payload.hints");
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const labJobs = ingestJobsToLabJobs(
      [
        sampleRecord({
          kind: "source",
          payload: { filename: "Saltmarsh.S01E01.mkv", hints: { season: 1, episode: 1 } },
        }) as any,
      ],
      [mediaRow({ id: "media-1", type: "tv", title: "Saltmarsh" })]
    );
    try {
      expect(labJobs[0].detectedSeason).toBe(1);
      expect(labJobs[0].detectedEpisode).toBe(1);
      expect(labJobs[0].matchedTo?.type).toBe("tv");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("converter-tv-hints:fail", {
        extra: { labJob0: labJobs[0] },
      });
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // @bugfix offline-download-job-uuid-label-2026-06-04
  // @regression-proof Reported: offline-save jobs showed raw UUIDs (e.g.
  //   "bd9d4f67-...") in the jobs sidebar, and TV jobs never said WHICH episode.
  //   Root cause: download jobs don't set payload.filename/hints (the ingest
  //   shape); their friendly data lives in payload.manifest.filenameInputs,
  //   which toLabJob didn't read → filename fell through to rec.mediaId/jobId.
  //   These pin the manifest-fallback (load-bearing for ALREADY-COMPLETED jobs)
  //   AND the new runtime payload.filename/hints stamp path.
  // -------------------------------------------------------------------------
  it("[@bugfix][@regression-proof] download TV job resolves friendly label + S/E from manifest (completed/legacy jobs)", async () => {
    console.info("[runtime-ingest-jobs:download-tv-manifest] no payload.filename/hints — manifest fallback only");
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const labJobs = ingestJobsToLabJobs(
      [
        sampleRecord({
          jobId: "dl-1",
          kind: "download",
          // The COMMON case: a job that finished before the runtime stamp shipped
          // carries ONLY the manifest snapshot, no payload.filename/hints.
          payload: {
            fileId: "file-s1e1",
            mediaId: "media-1",
            manifest: {
              filenameInputs: {
                kind: "episode",
                showTitle: "Brooklyn Nine-Nine",
                seasonNumber: 1,
                episodeNumber: 1,
                episodeTitle: "Pilot",
              },
            },
          },
        }) as any,
      ],
      [mediaRow({ id: "media-1", type: "tv", title: "Brooklyn Nine-Nine" })]
    );
    try {
      expect(labJobs[0].filename).toBe("Brooklyn Nine-Nine - S01E01 - Pilot");
      expect(labJobs[0].filename).not.toContain("dl-1"); // never the UUID
      expect(labJobs[0].detectedSeason).toBe(1);
      expect(labJobs[0].detectedEpisode).toBe(1);
      expect(labJobs[0].jobType).toBe("download");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("download-tv-manifest:fail", { extra: { labJob0: labJobs[0] } });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] download job prefers the runtime payload.filename/hints stamp when present", async () => {
    console.info("[runtime-ingest-jobs:download-stamp] new job carries payload.filename + hints");
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const labJobs = ingestJobsToLabJobs(
      [
        sampleRecord({
          jobId: "dl-2",
          kind: "download",
          payload: {
            fileId: "file-s2e3",
            mediaId: "media-1",
            filename: "Brooklyn Nine-Nine - S02E03 - The Slump",
            hints: { season: 2, episode: 3 },
            manifest: {
              filenameInputs: {
                kind: "episode",
                showTitle: "Brooklyn Nine-Nine",
                seasonNumber: 2,
                episodeNumber: 3,
                episodeTitle: "The Slump",
              },
            },
          },
        }) as any,
      ],
      [mediaRow({ id: "media-1", type: "tv", title: "Brooklyn Nine-Nine" })]
    );
    try {
      expect(labJobs[0].filename).toBe("Brooklyn Nine-Nine - S02E03 - The Slump");
      expect(labJobs[0].detectedSeason).toBe(2);
      expect(labJobs[0].detectedEpisode).toBe(3);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("download-stamp:fail", { extra: { labJob0: labJobs[0] } });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] download MOVIE job resolves 'Title (Year)' and no S/E chip", async () => {
    console.info("[runtime-ingest-jobs:download-movie] movie manifest → Title (Year), no episode");
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const labJobs = ingestJobsToLabJobs(
      [
        sampleRecord({
          jobId: "dl-3",
          kind: "download",
          payload: {
            fileId: "file-movie",
            mediaId: "media-1",
            manifest: { filenameInputs: { kind: "movie", title: "Orchard", year: 2017 } },
          },
        }) as any,
      ],
      [mediaRow({ id: "media-1", type: "movie", title: "Orchard" })]
    );
    try {
      expect(labJobs[0].filename).toBe("Orchard (2017)");
      expect(labJobs[0].detectedSeason).toBeUndefined();
      expect(labJobs[0].detectedEpisode).toBeUndefined();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("download-movie:fail", { extra: { labJob0: labJobs[0] } });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] download episode with season/episode < 1 hides the S/E chip but keeps a filename-consistent label", async () => {
    console.info("[runtime-ingest-jobs:download-zero-se] seasonNumber/episodeNumber 0 → no chip; label mirrors saved filename");
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const labJobs = ingestJobsToLabJobs(
      [
        sampleRecord({
          jobId: "dl-4",
          kind: "download",
          payload: {
            fileId: "file-x",
            mediaId: "media-1",
            manifest: {
              filenameInputs: {
                kind: "episode",
                showTitle: "Some Show",
                seasonNumber: 0,
                episodeNumber: 0,
                episodeTitle: null,
              },
            },
          },
        }) as any,
      ],
      [mediaRow({ id: "media-1", type: "tv", title: "Some Show" })]
    );
    try {
      // Chip is hidden for season/episode < 1 (matches the runtime stamp's >= 1
      // hints guard) — no phantom S00E00 chip rendered beside the row.
      expect(labJobs[0].detectedSeason).toBeUndefined();
      expect(labJobs[0].detectedEpisode).toBeUndefined();
      // The LABEL deliberately mirrors the on-disk saved filename
      // (buildOfflineFilename always renders SxxEyy for episodes), so it stays
      // byte-consistent with the file the user sees on disk — and is still far
      // better than the raw UUID.
      expect(labJobs[0].filename).toBe("Some Show - S00E00");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("download-zero-se:fail", { extra: { labJob0: labJobs[0] } });
      throw err;
    }
  });

  it("ingest (source) jobs are unaffected by the download manifest fallback", async () => {
    console.info("[runtime-ingest-jobs:download-no-regress] source job with no manifest keeps payload.filename");
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const labJobs = ingestJobsToLabJobs(
      [sampleRecord({ kind: "source", payload: { filename: "movie.mkv" } }) as any],
      [mediaRow()]
    );
    try {
      expect(labJobs[0].filename).toBe("movie.mkv");
      expect(labJobs[0].detectedSeason).toBeUndefined();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("download-no-regress:fail", { extra: { labJob0: labJobs[0] } });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] download group title falls back to manifest showTitle when media unsynced", async () => {
    console.info("[runtime-ingest-jobs:download-group-title] no MediaRow → group title from manifest, not UUID");
    const { buildIngestJobGroups } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const groups = buildIngestJobGroups(
      [
        sampleRecord({
          jobId: "dl-5",
          kind: "download",
          mediaId: "media-unsynced",
          groupId: "media-unsynced",
          payload: {
            fileId: "file-s1e1",
            mediaId: "media-unsynced",
            manifest: {
              filenameInputs: {
                kind: "episode",
                showTitle: "Brooklyn Nine-Nine",
                seasonNumber: 1,
                episodeNumber: 1,
                episodeTitle: "Pilot",
              },
            },
          },
        }) as any,
      ],
      [] // media NOT synced
    );
    try {
      expect(groups[0]?.title).toBe("Brooklyn Nine-Nine");
      expect(groups[0]?.title).not.toBe("media-unsynced");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("download-group-title:fail", { extra: { group0: groups[0] } });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] groups carry posterPath + title + type from MediaRow (no more 'a. 4 job')", async () => {
    console.info("[runtime-ingest-jobs:groups-mediaRow] 1 source + 3 formats → 1 Orchard group");
    const { buildIngestJobGroups } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const groups = buildIngestJobGroups(
      [
        sampleRecord({ jobId: "j-src", kind: "source", variant: null }) as any,
        sampleRecord({ jobId: "j-360", kind: "format", variant: "360p" }) as any,
        sampleRecord({ jobId: "j-720", kind: "format", variant: "720p" }) as any,
        sampleRecord({ jobId: "j-1080", kind: "format", variant: "1080p" }) as any,
      ],
      [mediaRow()]
    );
    try {
      expect(groups).toHaveLength(1);
      expect(groups[0].title).toBe("Orchard");
      expect(groups[0].posterPath).toBe("/orchard.jpg");
      expect(groups[0].type).toBe("movie");
      expect(groups[0].jobs).toHaveLength(4);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("groups-mediaRow:fail", { extra: { groups } });
      throw err;
    }
  });

  // End-to-end label coverage (Symptom C from the V2 ingest plan):
  // sidebar showed generic "Job" for source rows and bare "360p" for
  // format rows because the cast `as unknown as LabJob` had been masking
  // any drift between the converter output and the LabJob shape that
  // `buildActiveLabJobPresentation` consumes. Lock the contract end to
  // end so the labels survive future converter edits.
  const mockT = ((key: string, fallback?: string) => {
    const dict: Record<string, string> = {
      "lab.queue.sourceIngest": "Source ingest",
      "lab.queue.transcode": "Transcode",
      "lab.queue.job": "Job",
      "lab.queue.tracks": "Tracks",
      "lab.source": "Source",
      "lab.queue.help.sourceIngest": "Encrypt + upload original",
      "lab.queue.help.transcode": "Transcode to selected formats",
      "lab.queue.help.tracks": "Audio + subtitle tracks",
      "lab.queue.help.job": "Job",
    };
    return dict[key] ?? fallback ?? key;
  }) as any;

  it("[@bugfix][@regression-proof] source job renders 'Source ingest' label end to end", async () => {
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const [labJob] = ingestJobsToLabJobs(
      [sampleRecord({ kind: "source", variant: null, status: "running" }) as any],
      [mediaRow()]
    );
    const { outputLabel } = buildActiveLabJobPresentation(labJob, false, mockT);
    console.info(`[runtime-ingest-jobs:label-source-e2e] outputLabel=${JSON.stringify(outputLabel)}`);
    // Running jobs surface the runtime-emitted stageLabel ("Init") so the
    // user sees which micro-stage of the source pipeline is active. See the
    // V2 sidebar stage-progress fix in lab-job-presentation.test.ts. A queued
    // job carries no stage suffix: it reads "Waiting · #N in line" (#2499).
    try {
      expect(outputLabel).toBe("Source ingest · Init");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("label-source-e2e:fail", {
        expected: "Source ingest · Init",
        observed: outputLabel,
        extra: { labJob },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] format job renders 'Transcode · 360p' label end to end", async () => {
    const { ingestJobsToLabJobs } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    const [labJob] = ingestJobsToLabJobs(
      [sampleRecord({ kind: "format", variant: "360p", status: "running" }) as any],
      [mediaRow()]
    );
    const { outputLabel } = buildActiveLabJobPresentation(labJob, false, mockT);
    console.info(`[runtime-ingest-jobs:label-format-e2e] outputLabel=${JSON.stringify(outputLabel)}`);
    // Running format jobs include the runtime stageLabel ("Init") suffix.
    try {
      expect(outputLabel).toBe("Transcode · 360p · Init");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("label-format-e2e:fail", {
        expected: "Transcode · 360p · Init",
        observed: outputLabel,
        extra: { labJob },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] group surfaces live stageLabel from active source job (sidebar matched per-job badge)", async () => {
    // Round 8 H1: per-job badges already showed the runtime stageLabel via
    // the round-5 fix; the group badge fell through to bucketed status
    // ("Uploading") and lost the micro-stage. The buildIngestJobGroups
    // adapter now picks the most-active LabJob and forwards its stageLabel.
    const { buildIngestJobGroups } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs",
    );
    console.info("[runtime-ingest-jobs:group-live-stage] running source stageLabel=Extracting");
    const groups = buildIngestJobGroups(
      [
        sampleRecord({
          jobId: "j-src",
          kind: "source",
          status: "running",
          stageLabel: "Extracting",
          progressPct: 99,
        }) as any,
      ],
      [mediaRow()],
    );
    try {
      expect(groups).toHaveLength(1);
      expect(groups[0].stageLabel).toBe("Extracting");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("group-live-stage:fail", {
        expected: "Extracting",
        observed: groups[0]?.stageLabel,
        extra: { groups },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] group with all-terminal jobs has no stageLabel (no stale label leak)", async () => {
    // Symmetry: succeeded/failed/cancelled groups must not surface a stageLabel
    // because the picker falls through to the first-job branch which carries
    // the terminal job's old stageLabel — but the badge guard means this only
    // matters because we want the bucketed status text to take over.
    // Empty stageLabel from picker keeps the LabStatusBadge fallback intact.
    const { buildIngestJobGroups } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs",
    );
    console.info("[runtime-ingest-jobs:group-all-terminal-no-stage] succeeded source + format, undefined stageLabel");
    const groups = buildIngestJobGroups(
      [
        sampleRecord({
          jobId: "j-src",
          kind: "source",
          status: "succeeded",
          stageLabel: undefined,
        }) as any,
        sampleRecord({
          jobId: "j-360p",
          kind: "format",
          variant: "360p",
          status: "succeeded",
          stageLabel: undefined,
        }) as any,
      ],
      [mediaRow()],
    );
    try {
      expect(groups).toHaveLength(1);
      expect(groups[0].stageLabel).toBeUndefined();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("group-all-terminal-no-stage:fail", {
        observed: groups[0]?.stageLabel,
        extra: { groups },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] picker prefers transcoding/uploading over a queued sibling (multi-job group consistency)", async () => {
    // When a source ingest is mid-upload and a format job is already queued,
    // the group should show the uploader's stageLabel — not the queued job's.
    const { buildIngestJobGroups } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs",
    );
    console.info("[runtime-ingest-jobs:group-picker-prefers-active] running uploader + queued format sibling");
    const groups = buildIngestJobGroups(
      [
        sampleRecord({
          jobId: "j-src",
          kind: "source",
          status: "running",
          stageLabel: "Uploading chunks",
          progressPct: 60,
        }) as any,
        sampleRecord({
          jobId: "j-360",
          kind: "format",
          variant: "360p",
          status: "queued",
          stageLabel: "Init",
          progressPct: 0,
        }) as any,
      ],
      [mediaRow()],
    );
    try {
      expect(groups[0].stageLabel).toBe("Uploading chunks");
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("group-picker-prefers-active:fail", {
        expected: "Uploading chunks",
        observed: groups[0]?.stageLabel,
        extra: { groups },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] converter falls back gracefully when media is unknown (no crash, raw filename)", async () => {
    const { ingestJobsToLabJobs, buildIngestJobGroups } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const recs = [
      sampleRecord({
        kind: "source",
        mediaId: "media-unknown",
        groupId: "media-unknown",
        payload: { filename: "Mystery.mkv" },
      }) as any,
    ];
    console.info("[runtime-ingest-jobs:converter-unknown-media] empty media list, raw filename fallback");
    const labJobs = ingestJobsToLabJobs(recs, []);
    const groups = buildIngestJobGroups(recs, []);
    try {
      expect(labJobs[0].matchedTo).toBeUndefined();
      expect(labJobs[0].filename).toBe("Mystery.mkv");
      expect(groups[0].title).toBe("Mystery.mkv");
      expect(groups[0].posterPath).toBeNull();
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("converter-unknown-media:fail", {
        extra: { labJob0: labJobs[0], group0: groups[0] },
      });
      throw err;
    }
  });
});

describe("buildIngestJobGroups + findStaleOrphanGroupIds — orphan group filter (Bug #10)", () => {
  // 9 rows in runtime_jobs.db carried groupIds with no matching media_items
  // row from a prior session's failed/cancelled non-dismissed jobs. The
  // sidebar surfaced them as un-openable, un-deletable cards. The renderer
  // now hides terminal-only orphan groups; active orphans are still shown
  // because they represent valid in-flight pre-commit state. A "Dismiss
  // stale jobs" action sweeps them via cancelByGroup.

  const mediaRow = (overrides: Record<string, unknown> = {}): any => ({
    id: "media-real",
    type: "movie",
    tmdbId: 100,
    externalIds: null,
    title: "Orchard",
    originalTitle: null,
    originalLanguage: null,
    overview: null,
    year: "2017",
    rating: null,
    posterPath: "/orchard.jpg",
    backdropPath: null,
    genres: [],
    addedAt: "",
    updatedAt: "",
    hasFiles: false,
    progressPct: 0,
    lastWatchedAt: null,
    totalEpisodes: null,
    episodeCount: 0,
    ...overrides,
  });

  // Four scenarios from the team-lead brief:
  //   (a) media row + active job          → render
  //   (b) media row + all terminal        → render (user can dismiss per-job)
  //   (c) orphan + all terminal           → FILTER OUT (the bug)
  //   (d) orphan + at least one active    → render (in-flight pre-commit)
  const scenarioJobs = () => [
    sampleRecord({
      jobId: "j-a",
      groupId: "media-real",
      mediaId: "media-real",
      status: "running",
    }),
    sampleRecord({
      jobId: "j-b",
      groupId: "media-real",
      mediaId: "media-real",
      status: "succeeded",
    }),
    sampleRecord({
      jobId: "j-c1",
      groupId: "media-orphan-terminal",
      mediaId: "media-orphan-terminal",
      status: "failed",
    }),
    sampleRecord({
      jobId: "j-c2",
      groupId: "media-orphan-terminal",
      mediaId: "media-orphan-terminal",
      status: "cancelled",
    }),
    sampleRecord({
      jobId: "j-d1",
      groupId: "media-orphan-active",
      mediaId: "media-orphan-active",
      status: "running",
    }),
    sampleRecord({
      jobId: "j-d2",
      groupId: "media-orphan-active",
      mediaId: "media-orphan-active",
      status: "failed",
    }),
  ];

  it("[@bugfix][@regression-proof] buildIngestJobGroups filters terminal-only orphan groups but keeps active orphans + media-backed groups", async () => {
    console.info("[runtime-ingest-jobs:orphan-filter-build] 4 scenarios (a)media+active (b)media+terminal (c)orphan+terminal (d)orphan+active");
    const { buildIngestJobGroups } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const groups = buildIngestJobGroups(
      scenarioJobs() as any,
      [mediaRow()],
    );
    const groupIds = groups.map((g) => g.id).sort();
    console.info(`[runtime-ingest-jobs:orphan-filter-build] surviving groupIds=${JSON.stringify(groupIds)}`);
    try {
      // Bug #10 assertion: media-orphan-terminal must NOT survive.
      expect(groupIds).not.toContain("media-orphan-terminal");
      // The other three scenarios must all survive.
      expect(groupIds).toEqual(["media-orphan-active", "media-real"]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("orphan-filter-build:fail", {
        expected: ["media-orphan-active", "media-real"],
        observed: groupIds,
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] findStaleOrphanGroupIds returns ONLY the terminal-only orphan groupIds", async () => {
    console.info("[runtime-ingest-jobs:orphan-filter-find] findStaleOrphanGroupIds over 4 scenarios");
    const { findStaleOrphanGroupIds } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const ids = findStaleOrphanGroupIds(
      scenarioJobs() as any,
      [mediaRow()],
    );
    console.info(`[runtime-ingest-jobs:orphan-filter-find] stale orphan ids=${JSON.stringify(ids)}`);
    try {
      expect(ids).toEqual(["media-orphan-terminal"]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("orphan-filter-find:fail", {
        expected: ["media-orphan-terminal"],
        observed: ids,
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] orphan group with single 'cancelled' job is filtered out (single-job stale orphan reproduces the user's stuck cards)", async () => {
    const { buildIngestJobGroups, findStaleOrphanGroupIds } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    console.info("[runtime-ingest-jobs:orphan-single-cancelled] single cancelled orphan job, no media");
    const recs = [
      sampleRecord({
        jobId: "j-orphan",
        groupId: "media-gone",
        mediaId: "media-gone",
        status: "cancelled",
      }) as any,
    ];
    const built = buildIngestJobGroups(recs, []);
    const stale = findStaleOrphanGroupIds(recs, []);
    console.info(`[runtime-ingest-jobs:orphan-single-cancelled] built=${JSON.stringify(built.map((g: any) => g.id))} stale=${JSON.stringify(stale)}`);
    try {
      expect(built).toEqual([]);
      expect(stale).toEqual(["media-gone"]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("orphan-single-cancelled:fail", {
        extra: { built, stale },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] empty media list: every all-terminal group is treated as orphan (defensive)", async () => {
    const { buildIngestJobGroups, findStaleOrphanGroupIds } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    console.info("[runtime-ingest-jobs:orphan-empty-media] empty media list, g1=failed g2=queued");
    const recs = [
      sampleRecord({ jobId: "j1", groupId: "g1", mediaId: "g1", status: "failed" }),
      sampleRecord({ jobId: "j2", groupId: "g2", mediaId: "g2", status: "queued" }),
    ];
    const groups = buildIngestJobGroups(recs as any, []);
    const stale = findStaleOrphanGroupIds(recs as any, []);
    console.info(`[runtime-ingest-jobs:orphan-empty-media] groupIds=${JSON.stringify(groups.map((g) => g.id))} stale=${JSON.stringify(stale)}`);
    try {
      expect(groups.map((g) => g.id)).toEqual(["g2"]);
      expect(stale).toEqual(["g1"]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("orphan-empty-media:fail", {
        extra: { groupIds: groups.map((g) => g.id), stale },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] orphan group with only 'interrupted' jobs is filtered + dismissable (Bug #10 Walk #3)", async () => {
    // Verifier surfaced a strict orphan (groupId 3f1995dc-..., status=interrupted,
    // no media row, dismissed_at NULL) that survived the bulk-dismiss action
    // because the previous filter set was `succeeded | failed | cancelled`. The
    // runtime's IngestJobStatus enum has 4 terminal-ish states; `interrupted`
    // means "runtime gave up mid-flight" and post-hydrate is dead weight from
    // the user's perspective. Treating it as terminal in the orphan filter is
    // the correct semantic — recoverable interrupted jobs would have been
    // re-promoted by hydrate-on-boot and wouldn't satisfy the orphan predicate
    // (they'd have a different status or a media row by then).
    const { buildIngestJobGroups, findStaleOrphanGroupIds } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    console.info("[runtime-ingest-jobs:orphan-interrupted-only] single interrupted orphan job (Bug #10 Walk #3)");
    const recs = [
      sampleRecord({
        jobId: "j-int",
        groupId: "3f1995dc-orphan-interrupted",
        mediaId: "3f1995dc-orphan-interrupted",
        status: "interrupted",
      }) as any,
    ];
    const built = buildIngestJobGroups(recs, []);
    const stale = findStaleOrphanGroupIds(recs, []);
    console.info(`[runtime-ingest-jobs:orphan-interrupted-only] built=${JSON.stringify(built.map((g: any) => g.id))} stale=${JSON.stringify(stale)}`);
    try {
      expect(built).toEqual([]);
      expect(stale).toEqual([
        "3f1995dc-orphan-interrupted",
      ]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("orphan-interrupted-only:fail", {
        extra: { built, stale },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] mixed-terminal orphan (failed + cancelled + interrupted) is filtered as a single stale group", async () => {
    // Defends against future drift: if any one of the terminal statuses is
    // dropped from the set, this test fires because the mixed group would
    // resurface in buildIngestJobGroups output.
    const { buildIngestJobGroups, findStaleOrphanGroupIds } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    console.info("[runtime-ingest-jobs:orphan-mixed-terminal] g-mixed = failed + cancelled + interrupted");
    const recs = [
      sampleRecord({ jobId: "j-f", groupId: "g-mixed", mediaId: "g-mixed", status: "failed" }),
      sampleRecord({ jobId: "j-c", groupId: "g-mixed", mediaId: "g-mixed", status: "cancelled" }),
      sampleRecord({ jobId: "j-i", groupId: "g-mixed", mediaId: "g-mixed", status: "interrupted" }),
    ];
    const built = buildIngestJobGroups(recs as any, []);
    const stale = findStaleOrphanGroupIds(recs as any, []);
    console.info(`[runtime-ingest-jobs:orphan-mixed-terminal] built=${JSON.stringify(built.map((g: any) => g.id))} stale=${JSON.stringify(stale)}`);
    try {
      expect(built).toEqual([]);
      expect(stale).toEqual(["g-mixed"]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("orphan-mixed-terminal:fail", {
        extra: { built, stale },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] orphan group with one 'interrupted' + one 'running' job survives (active orphan, not stale)", async () => {
    // Symmetry check with the (d) scenario above: any forward-progress job
    // keeps the group visible regardless of how many siblings are interrupted.
    const { buildIngestJobGroups, findStaleOrphanGroupIds } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    console.info("[runtime-ingest-jobs:orphan-active-survives] g-active = interrupted + running");
    const recs = [
      sampleRecord({ jobId: "j-i", groupId: "g-active", mediaId: "g-active", status: "interrupted" }),
      sampleRecord({ jobId: "j-r", groupId: "g-active", mediaId: "g-active", status: "running" }),
    ];
    const builtIds = buildIngestJobGroups(recs as any, []).map((g) => g.id);
    const stale = findStaleOrphanGroupIds(recs as any, []);
    console.info(`[runtime-ingest-jobs:orphan-active-survives] builtIds=${JSON.stringify(builtIds)} stale=${JSON.stringify(stale)}`);
    try {
      expect(builtIds).toEqual([
        "g-active",
      ]);
      expect(stale).toEqual([]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("orphan-active-survives:fail", {
        extra: { builtIds, stale },
      });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] terminal-only group SURVIVES when its mediaId is in the supplied media list (Orchard regression — Round 4 D3)", async () => {
    // Verifier symptom #4: opening Orchard's Media Details modal showed the
    // Processes tab blank even though runtime_jobs.db had 2 rows
    // (source=succeeded, format/360p=cancelled). MediaDetailsProcessingPanel
    // was calling useRuntimeIngestJobs({ mediaId }) WITHOUT passing media,
    // so buildIngestJobGroups received an empty mediaById index, declared
    // every group an orphan, and dropped all rows. Fix: panel now passes
    // useLibraryData().media. This test guards the underlying contract:
    // when the media row IS present in the index, the orphan filter must
    // NOT fire even if every job in the group is terminal.
    const { buildIngestJobGroups, findStaleOrphanGroupIds } = await import(
      "../src/renderer/src/lib/runtimeIngestJobs"
    );
    const orchardId = "37749009-2692-482d-9768-de04bc7fdcd2";
    const recs = [
      sampleRecord({
        jobId: "j-source",
        groupId: orchardId,
        mediaId: orchardId,
        kind: "source",
        status: "succeeded",
      }),
      sampleRecord({
        jobId: "j-360p",
        groupId: orchardId,
        mediaId: orchardId,
        kind: "format",
        variant: "360p",
        status: "cancelled",
      }),
    ];
    console.info("[runtime-ingest-jobs:orchard-terminal-survives] terminal-only group WITH media row must survive (Round 4 D3)");
    const media = [mediaRow({ id: orchardId, title: "Orchard" })];
    const groups = buildIngestJobGroups(recs as any, media);
    const stale = findStaleOrphanGroupIds(recs as any, media);
    console.info(`[runtime-ingest-jobs:orchard-terminal-survives] groupIds=${JSON.stringify(groups.map((g) => g.id))} jobs=${groups[0]?.jobs?.length} stale=${JSON.stringify(stale)}`);
    try {
      expect(groups.map((g) => g.id)).toEqual([orchardId]);
      expect(groups[0]!.jobs).toHaveLength(2);
      expect(stale).toEqual([]);
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("orchard-terminal-survives:fail", {
        expected: { groupIds: [orchardId], jobs: 2, stale: [] },
        extra: { groups, stale },
      });
      throw err;
    }
  });
});

describe("useRuntimeIngestActions", () => {
  beforeEach(() => setupSf());

  afterEach(() => {
    if (root && container) act(() => root?.unmount());
    root = null;
    container?.parentNode?.removeChild(container);
    container = null;
  });

  it("cancel/dismiss/retry/submitSources route to the matching window.sf calls", async () => {
    console.info("[runtime-ingest-jobs:actions-routing] mounting actions hook then invoking each action");
    const { useRuntimeIngestActions } = await import("../src/renderer/src/lib/runtimeIngestJobs");
    let actions!: ReturnType<typeof useRuntimeIngestActions>;
    const Probe = () => {
      actions = useRuntimeIngestActions();
      useEffect(() => {}, []);
      return null;
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(Probe));
    });
    await flush();

    await actions.cancelJob("a");
    await actions.cancelByGroup("g", "stale-orphan-cleanup");
    await actions.dismissJob("b");
    await actions.retryJob("c");
    await actions.submitSources({ userId: "u", sources: [{ filename: "x.mkv" }] });

    const sf = (globalThis as any).window.sf.runtimeJobs;
    console.info(
      `[runtime-ingest-jobs:actions-routing] call args: cancel=${JSON.stringify(sf.cancel.mock.calls[0])} cancelByGroup=${JSON.stringify(sf.cancelByGroup.mock.calls[0])} dismiss=${JSON.stringify(sf.dismiss.mock.calls[0])} retry=${JSON.stringify(sf.retry.mock.calls[0])} submitSources=${JSON.stringify(sf.submitSources.mock.calls[0])}`,
    );
    try {
      expect(sf.cancel).toHaveBeenCalledWith({ jobId: "a" });
      expect(sf.cancelByGroup).toHaveBeenCalledWith({
        groupId: "g",
        reason: "stale-orphan-cleanup",
      });
      expect(sf.dismiss).toHaveBeenCalledWith({ jobId: "b" });
      expect(sf.retry).toHaveBeenCalledWith({ jobId: "c" });
      expect(sf.submitSources).toHaveBeenCalledWith({ userId: "u", sources: [{ filename: "x.mkv" }] });
    } catch (err) {
      dumpRuntimeIngestJobsSnapshot("actions-routing:fail", {
        extra: {
          cancel: sf.cancel.mock.calls,
          cancelByGroup: sf.cancelByGroup.mock.calls,
          dismiss: sf.dismiss.mock.calls,
          retry: sf.retry.mock.calls,
          submitSources: sf.submitSources.mock.calls,
        },
      });
      throw err;
    }
  });
});
