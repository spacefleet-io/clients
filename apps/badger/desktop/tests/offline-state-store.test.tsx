// @vitest-environment jsdom
//
// Feature-coverage tests for `offlineState.ts` — the renderer-side offline-
// availability store.
//
// Coverage:
//   1. acquireOfflineState / releaseOfflineState refcount lifecycle:
//      - First acquire triggers exactly ONE hydrate; subsequent acquires do NOT.
//      - Data survives the last release (no reset — tile remounts must not flicker).
//   2. hydrate behavior (full vs targeted merge):
//      - Full hydrate replaces the entire byFileId map.
//      - Targeted hydrate drops/re-inserts only the requested mediaId's entries;
//        entries for OTHER mediaIds survive.
//      - IPC error path: store sets error/loading:false without corrupting byFileId.
//      - Thrown exception path: store sets error/loading:false without corrupting byFileId.
//   3. refreshOfflineState / refreshOfflineStateForMedia shape:
//      - refreshOfflineState calls callOfflineListLocal with no mediaIds ({}).
//      - refreshOfflineStateForMedia calls callOfflineListLocal with { mediaIds: [id] }.
//   4. useOfflineStateByMediaId roll-up (the badge driver):
//      - Empty store → empty output map.
//      - Movie with local file → "full".
//      - TV show: localCount >= total → "full"; 0 < localCount < total → "partial"; 0 → "none".
//      - TV show with both episodeCount=0 and totalEpisodes=null (no denominator) + >=1 local → "partial".
//      - Roll-up is keyed by the SHOW's mediaId, not the fileId.
//   5. localFileIdsForMedia — happy path and empty.
//   6. computeOfflineLocalCountsForDetails — happy path and null-details.
//
// Test logging follows the "tests log generously" convention — phase
// markers and state dumps on assertion failures throughout.

import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// callOfflineListLocal is the sole IPC dependency the store uses.
// We hoist the mock fn so vi.mock's factory can reference it.
const { callOfflineListLocalMock } = vi.hoisted(() => ({
  callOfflineListLocalMock: vi.fn(),
}));

vi.mock("../src/renderer/src/lib/offlineIpc", () => ({
  callOfflineListLocal: (...args: unknown[]) => callOfflineListLocalMock(...args),
  isOfflineIpcError: (v: unknown) =>
    !!v &&
    typeof v === "object" &&
    (v as { __runtimeJobsError?: unknown }).__runtimeJobsError === true,
}));

// Silence the rendererLogger so test output is clean.
vi.mock("../src/renderer/src/logger", () => ({
  rendererLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal OfflineLocalEntry as returned by callOfflineListLocal */
const makeEntry = (
  mediaId: string,
  fileId: string,
  overrides: Partial<{
    quality: string;
    container: "mkv" | "mp4";
    totalBytes: number;
    downloadedAt: string;
    localPath: string;
  }> = {},
) => ({
  mediaId,
  fileId,
  quality: "1080p",
  container: "mkv" as const,
  totalBytes: 500_000_000,
  downloadedAt: "2026-06-01T00:00:00Z",
  localPath: `/offline/${fileId}.mkv`,
  ...overrides,
});

/** canned success result from callOfflineListLocal */
const ipcOk = (entries: ReturnType<typeof makeEntry>[]) => ({ entries });

/** canned IPC error result (the OfflineIpcError envelope) */
const ipcError = (message: string) => ({
  __runtimeJobsError: true as const,
  status: 500,
  errorCode: "list_failed",
  message,
});

/** Minimal MediaRow for useOfflineStateByMediaId tests */
const makeMediaRow = (
  id: string,
  type: "movie" | "tv",
  episodeCount: number,
  totalEpisodes: number | null,
): import("../src/renderer/src/lib/libraryDb").MediaRow => ({
  id,
  type,
  catalogId: 1,
  title: type === "movie" ? "Test Movie" : "Test Show",
  originalTitle: null,
  originalLanguage: null,
  overview: null,
  year: "2020",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2024-01-01",
  updatedAt: "2024-01-01",
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes,
  episodeCount,
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Drain several microtask turns so async store hydration resolves. */
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
};

/** Render a probe component that calls a hook and captures its return value. */
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

// ---------------------------------------------------------------------------
// Reset + cleanup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  console.info("[offline-state-store:setup] resetting store + clearing mocks");
  const { __resetOfflineStateForTests } = await import(
    "../src/renderer/src/lib/offlineState"
  );
  __resetOfflineStateForTests();
  callOfflineListLocalMock.mockReset();
});

afterEach(() => {
  if (root && container) {
    act(() => root?.unmount());
  }
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
});

// ---------------------------------------------------------------------------
// 1. acquireOfflineState / releaseOfflineState refcount lifecycle
// ---------------------------------------------------------------------------

describe("acquireOfflineState / releaseOfflineState — refcount lifecycle", () => {
  it("first acquire triggers exactly one hydrate call", async () => {
    console.info("[offline-state-store:refcount] first acquire should trigger one hydrate");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { acquireOfflineState } = await import("../src/renderer/src/lib/offlineState");
    acquireOfflineState();
    await flush();

    console.info(`[offline-state-store:refcount] callOfflineListLocal called ${callOfflineListLocalMock.mock.calls.length} time(s)`);
    expect(callOfflineListLocalMock).toHaveBeenCalledTimes(1);
  });

  it("second acquire does NOT trigger another hydrate", async () => {
    console.info("[offline-state-store:refcount] second acquire must be a no-op for hydrate");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { acquireOfflineState } = await import("../src/renderer/src/lib/offlineState");
    acquireOfflineState();
    await flush();
    acquireOfflineState();
    await flush();

    console.info(`[offline-state-store:refcount] callCount=${callOfflineListLocalMock.mock.calls.length}`);
    expect(callOfflineListLocalMock).toHaveBeenCalledTimes(1);
  });

  it("third acquire across three separate acquire calls still only hydrates once", async () => {
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { acquireOfflineState } = await import("../src/renderer/src/lib/offlineState");
    acquireOfflineState();
    acquireOfflineState();
    acquireOfflineState();
    await flush();

    expect(callOfflineListLocalMock).toHaveBeenCalledTimes(1);
  });

  it("data survives a full release (no reset) so remounting tiles do not flicker", async () => {
    console.info("[offline-state-store:refcount] populate store, release, then re-acquire and check data persists");
    const entry = makeEntry("media-1", "file-1");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([entry]));

    const { acquireOfflineState, releaseOfflineState, getOfflineStateSnapshot } = await import(
      "../src/renderer/src/lib/offlineState"
    );

    acquireOfflineState();
    await flush();

    const snapshotAfterHydrate = getOfflineStateSnapshot();
    console.info(`[offline-state-store:refcount] byFileId.size after hydrate=${snapshotAfterHydrate.byFileId.size}`);
    expect(snapshotAfterHydrate.byFileId.size).toBe(1);

    // Release completely (refcount → 0).
    releaseOfflineState();
    const snapshotAfterRelease = getOfflineStateSnapshot();
    console.info(`[offline-state-store:refcount] byFileId.size after release=${snapshotAfterRelease.byFileId.size}`);
    // Data must survive the release — no flicker.
    expect(snapshotAfterRelease.byFileId.size).toBe(1);
    expect(snapshotAfterRelease.byFileId.get("file-1")).toEqual(entry);
  });
});

// ---------------------------------------------------------------------------
// 2. hydrate behavior
// ---------------------------------------------------------------------------

describe("hydrate — full hydrate replaces the entire byFileId map", () => {
  it("full hydrate from two entries populates byFileId with exactly those entries", async () => {
    console.info("[offline-state-store:hydrate-full] seeding two entries via full hydrate");
    const e1 = makeEntry("media-1", "file-1");
    const e2 = makeEntry("media-2", "file-2");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([e1, e2]));

    const { acquireOfflineState, getOfflineStateSnapshot } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    const snap = getOfflineStateSnapshot();
    console.info(`[offline-state-store:hydrate-full] byFileId.size=${snap.byFileId.size}, loading=${snap.loading}, error=${snap.error}`);
    expect(snap.loading).toBe(false);
    expect(snap.error).toBeNull();
    expect(snap.byFileId.size).toBe(2);
    expect(snap.byFileId.get("file-1")).toEqual(e1);
    expect(snap.byFileId.get("file-2")).toEqual(e2);
  });

  it("second full hydrate replaces stale entries entirely", async () => {
    console.info("[offline-state-store:hydrate-full] first hydrate gives file-1; second gives file-3 only");
    callOfflineListLocalMock
      .mockResolvedValueOnce(ipcOk([makeEntry("media-1", "file-1")]))
      .mockResolvedValueOnce(ipcOk([makeEntry("media-2", "file-3")]));

    const { acquireOfflineState, refreshOfflineState, getOfflineStateSnapshot } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    let snap = getOfflineStateSnapshot();
    expect(snap.byFileId.has("file-1")).toBe(true);

    refreshOfflineState();
    await flush();

    snap = getOfflineStateSnapshot();
    console.info(`[offline-state-store:hydrate-full] after refresh: byFileId.size=${snap.byFileId.size}`);
    expect(snap.byFileId.has("file-1")).toBe(false);
    expect(snap.byFileId.has("file-3")).toBe(true);
    expect(snap.byFileId.size).toBe(1);
  });
});

describe("hydrate — targeted hydrate merges without clobbering other mediaIds", () => {
  it("targeted refresh updates the requested mediaId entries and preserves other media", async () => {
    console.info("[offline-state-store:hydrate-targeted] pre-populate show-1 + show-2 entries, then target-refresh show-1 only");

    // Bootstrap: two entries for different media.
    const e_show1 = makeEntry("show-1", "file-show1-old");
    const e_show2 = makeEntry("show-2", "file-show2");
    callOfflineListLocalMock
      // first: bootstrap full hydrate
      .mockResolvedValueOnce(ipcOk([e_show1, e_show2]))
      // second: targeted refresh for show-1 (returns new entry)
      .mockResolvedValueOnce(ipcOk([makeEntry("show-1", "file-show1-new")]));

    const { acquireOfflineState, refreshOfflineStateForMedia, getOfflineStateSnapshot } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    let snap = getOfflineStateSnapshot();
    console.info(`[offline-state-store:hydrate-targeted] after bootstrap: show-1 file=${[...snap.byFileId.keys()].filter(k => snap.byFileId.get(k)!.mediaId === "show-1").join(",")}`);
    expect(snap.byFileId.has("file-show1-old")).toBe(true);
    expect(snap.byFileId.has("file-show2")).toBe(true);

    // Targeted refresh for show-1 only.
    refreshOfflineStateForMedia("show-1");
    await flush();

    snap = getOfflineStateSnapshot();
    console.info(`[offline-state-store:hydrate-targeted] after targeted refresh: keys=${[...snap.byFileId.keys()]}`);
    // Old show-1 entry must be gone; show-2 must survive.
    expect(snap.byFileId.has("file-show1-old"), "old show-1 entry must be evicted").toBe(false);
    expect(snap.byFileId.has("file-show1-new"), "new show-1 entry must be present").toBe(true);
    expect(snap.byFileId.has("file-show2"), "show-2 entry must survive targeted refresh").toBe(true);
  });

  it("targeted refresh with an empty result removes ALL entries for that mediaId while preserving others", async () => {
    console.info("[offline-state-store:hydrate-targeted] targeted refresh with empty result should drop mediaId entries");
    callOfflineListLocalMock
      .mockResolvedValueOnce(ipcOk([makeEntry("show-1", "file-s1"), makeEntry("show-2", "file-s2")]))
      .mockResolvedValueOnce(ipcOk([])); // show-1 no longer on disk

    const { acquireOfflineState, refreshOfflineStateForMedia, getOfflineStateSnapshot } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    refreshOfflineStateForMedia("show-1");
    await flush();

    const snap = getOfflineStateSnapshot();
    console.info(`[offline-state-store:hydrate-targeted] after empty targeted refresh: keys=${[...snap.byFileId.keys()]}`);
    expect(snap.byFileId.has("file-s1")).toBe(false);
    expect(snap.byFileId.has("file-s2")).toBe(true);
  });
});

describe("hydrate — error handling", () => {
  it("IPC error response: sets error field and loading=false, does not corrupt byFileId", async () => {
    console.info("[offline-state-store:error] IPC error envelope returned from callOfflineListLocal");
    // Seed data first, then cause error on the second call.
    const existing = makeEntry("media-ok", "file-ok");
    callOfflineListLocalMock
      .mockResolvedValueOnce(ipcOk([existing]))
      .mockResolvedValueOnce(ipcError("runtime unavailable"));

    const { acquireOfflineState, refreshOfflineState, getOfflineStateSnapshot } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    refreshOfflineState();
    await flush();

    const snap = getOfflineStateSnapshot();
    console.info(`[offline-state-store:error] snap.error=${snap.error} loading=${snap.loading} byFileId.size=${snap.byFileId.size}`);
    expect(snap.loading).toBe(false);
    expect(snap.error).toBe("runtime unavailable");
    // The error path (isOfflineIpcError branch) returns early before the byFileId
    // swap, so existing entries from the previous successful hydrate survive.
    expect(snap.byFileId.has("file-ok")).toBe(true);
  });

  it("IPC error on initial bootstrap: sets error, byFileId stays empty", async () => {
    console.info("[offline-state-store:error] IPC error on very first hydrate");
    callOfflineListLocalMock.mockResolvedValue(ipcError("no bridge"));

    const { acquireOfflineState, getOfflineStateSnapshot } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    const snap = getOfflineStateSnapshot();
    console.info(`[offline-state-store:error] snap.error=${snap.error}, byFileId.size=${snap.byFileId.size}`);
    expect(snap.loading).toBe(false);
    expect(snap.error).not.toBeNull();
    expect(snap.byFileId.size).toBe(0);
  });

  it("thrown exception: sets error field and loading=false", async () => {
    console.info("[offline-state-store:error] callOfflineListLocal throws an Error");
    callOfflineListLocalMock.mockRejectedValue(new Error("network_timeout"));

    const { acquireOfflineState, getOfflineStateSnapshot } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    const snap = getOfflineStateSnapshot();
    console.info(`[offline-state-store:error] snap.error=${snap.error}, loading=${snap.loading}`);
    expect(snap.loading).toBe(false);
    expect(snap.error).toBe("network_timeout");
  });
});

// ---------------------------------------------------------------------------
// 3. refreshOfflineState / refreshOfflineStateForMedia call shapes
// ---------------------------------------------------------------------------

describe("refreshOfflineState / refreshOfflineStateForMedia — IPC call shapes", () => {
  it("refreshOfflineState passes an empty object payload (full hydrate)", async () => {
    console.info("[offline-state-store:refresh-shape] refreshOfflineState must call listLocal with {}");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { acquireOfflineState, refreshOfflineState } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();
    callOfflineListLocalMock.mockClear();

    refreshOfflineState();
    await flush();

    const calls = callOfflineListLocalMock.mock.calls;
    console.info(`[offline-state-store:refresh-shape] calls=${JSON.stringify(calls)}`);
    expect(calls).toHaveLength(1);
    // Full hydrate: no mediaIds key, or empty object.
    expect(calls[0]![0]).not.toHaveProperty("mediaIds");
  });

  it("refreshOfflineStateForMedia passes { mediaIds: [id] } to listLocal", async () => {
    console.info("[offline-state-store:refresh-shape] refreshOfflineStateForMedia must call listLocal with mediaIds array");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { acquireOfflineState, refreshOfflineStateForMedia } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();
    callOfflineListLocalMock.mockClear();

    refreshOfflineStateForMedia("media-abc");
    await flush();

    const calls = callOfflineListLocalMock.mock.calls;
    console.info(`[offline-state-store:refresh-shape] targeted calls=${JSON.stringify(calls)}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ mediaIds: ["media-abc"] });
  });
});

// ---------------------------------------------------------------------------
// 4. useOfflineStateByMediaId roll-up
// ---------------------------------------------------------------------------

describe("useOfflineStateByMediaId — tile badge roll-up logic", () => {
  it("empty store → returns an empty map regardless of media list", async () => {
    console.info("[offline-state-store:rollup] empty store should produce empty map");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    const media = [makeMediaRow("media-1", "movie", 0, null)];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    console.info(`[offline-state-store:rollup] map.size=${getValue().size}`);
    expect(getValue().size).toBe(0);
  });

  it("undefined media → returns an empty map", async () => {
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(undefined));
    expect(getValue().size).toBe(0);
  });

  it("movie with a local file → 'full'", async () => {
    console.info("[offline-state-store:rollup] movie: 1 local file → full");
    const entry = makeEntry("movie-1", "movie-file-1");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([entry]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    const media = [makeMediaRow("movie-1", "movie", 0, null)];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] movie-1=${result.get("movie-1")}`);
    expect(result.get("movie-1")).toBe("full");
  });

  it("movie with no local file → 'none'", async () => {
    console.info("[offline-state-store:rollup] movie: 0 local files → none");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([makeEntry("movie-1", "movie-file-1")]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    // Provide TWO media: one with the file (movie-1), one without (movie-2).
    const media = [
      makeMediaRow("movie-1", "movie", 0, null),
      makeMediaRow("movie-2", "movie", 0, null),
    ];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] movie-1=${result.get("movie-1")}, movie-2=${result.get("movie-2")}`);
    expect(result.get("movie-1")).toBe("full");
    expect(result.get("movie-2")).toBe("none");
  });

  it("TV show: localCount === total (episodeCount) → 'full'", async () => {
    console.info("[offline-state-store:rollup] TV show: 4 of 4 episodes → full");
    const entries = [
      makeEntry("show-1", "ep-1"),
      makeEntry("show-1", "ep-2"),
      makeEntry("show-1", "ep-3"),
      makeEntry("show-1", "ep-4"),
    ];
    callOfflineListLocalMock.mockResolvedValue(ipcOk(entries));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    // episodeCount=4 → denominator is 4; 4 local files → full
    const media = [makeMediaRow("show-1", "tv", 4, 8)];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] show-1=${result.get("show-1")}`);
    expect(result.get("show-1")).toBe("full");
  });

  it("TV show: 0 < localCount < total → 'partial'", async () => {
    console.info("[offline-state-store:rollup] TV show: 2 of 4 episodes → partial");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([
      makeEntry("show-1", "ep-1"),
      makeEntry("show-1", "ep-2"),
    ]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    const media = [makeMediaRow("show-1", "tv", 4, 8)];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] show-1=${result.get("show-1")}`);
    expect(result.get("show-1")).toBe("partial");
  });

  it("TV show: localCount === 0 → 'none'", async () => {
    console.info("[offline-state-store:rollup] TV show with no local files → none");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([makeEntry("show-1", "ep-1")]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    // show-1 has the file, show-2 doesn't.
    const media = [
      makeMediaRow("show-1", "tv", 4, 4),
      makeMediaRow("show-2", "tv", 4, 4),
    ];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] show-2=${result.get("show-2")}`);
    expect(result.get("show-2")).toBe("none");
  });

  it("TV show: no denominator (episodeCount=0, totalEpisodes=null) + 1 local file → 'partial' (conservative badge)", async () => {
    // This is the exact case from the bug report:
    // A show with 1 saved episode and no usable episode count must show "partial"
    // (not "none") — the conservative fallback that makes the badge visible.
    console.info("[offline-state-store:rollup] TV show: no denominator + 1 local file → partial (bug case)");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([makeEntry("show-nodenom", "ep-x")]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    const media = [makeMediaRow("show-nodenom", "tv", 0, null)];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] show-nodenom=${result.get("show-nodenom")} (expected partial)`);
    try {
      expect(result.get("show-nodenom")).toBe("partial");
    } catch (err) {
      console.error(
        `[offline-state-store:rollup:fail] expected 'partial', got '${result.get("show-nodenom")}'. ` +
        `store.byFileId entries: ${JSON.stringify([...result.entries()])}`,
      );
      throw err;
    }
  });

  it("TV show: totalEpisodes=0 and episodeCount=0 + 2 local files → 'partial'", async () => {
    console.info("[offline-state-store:rollup] TV show: totalEpisodes=0 episodeCount=0 + 2 local → partial");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([
      makeEntry("show-zero", "ep-a"),
      makeEntry("show-zero", "ep-b"),
    ]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    const media = [makeMediaRow("show-zero", "tv", 0, 0)];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] show-zero=${result.get("show-zero")}`);
    expect(result.get("show-zero")).toBe("partial");
  });

  it("roll-up is keyed by the SHOW's mediaId, not the fileId", async () => {
    console.info("[offline-state-store:rollup] output map must use mediaId as key, not fileId");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([
      makeEntry("show-abc", "file-uuid-123"),
      makeEntry("show-abc", "file-uuid-456"),
    ]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    const media = [makeMediaRow("show-abc", "tv", 2, 2)];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] keys=${[...result.keys()]} values=${[...result.values()]}`);
    // Must be keyed by show mediaId, not fileId.
    expect(result.has("show-abc")).toBe(true);
    expect(result.has("file-uuid-123")).toBe(false);
    expect(result.has("file-uuid-456")).toBe(false);
    expect(result.get("show-abc")).toBe("full");
  });

  it("episodeCount wins over totalEpisodes as denominator when both are set", async () => {
    console.info("[offline-state-store:rollup] episodeCount=2 takes precedence over totalEpisodes=8 as denominator");
    // localCount=2, episodeCount=2, totalEpisodes=8.
    // If episodeCount is used: 2/2 → full.
    // If totalEpisodes is used: 2/8 → partial.
    callOfflineListLocalMock.mockResolvedValue(ipcOk([
      makeEntry("show-denom", "ep-1"),
      makeEntry("show-denom", "ep-2"),
    ]));

    const { useOfflineStateByMediaId } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    const media = [makeMediaRow("show-denom", "tv", 2, 8)];
    const { getValue } = await renderHook(() => useOfflineStateByMediaId(media));

    const result = getValue();
    console.info(`[offline-state-store:rollup] show-denom=${result.get("show-denom")} (expected full because episodeCount=2 wins)`);
    expect(result.get("show-denom")).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// 5. localFileIdsForMedia
// ---------------------------------------------------------------------------

describe("localFileIdsForMedia", () => {
  it("returns the set of fileIds for the requested mediaId", async () => {
    console.info("[offline-state-store:localFileIds] populate two media, query one");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([
      makeEntry("show-1", "file-s1-ep1"),
      makeEntry("show-1", "file-s1-ep2"),
      makeEntry("show-2", "file-s2-ep1"),
    ]));

    const { acquireOfflineState, localFileIdsForMedia } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    const ids = localFileIdsForMedia("show-1");
    console.info(`[offline-state-store:localFileIds] show-1 ids=${JSON.stringify([...ids])}`);
    expect(ids.has("file-s1-ep1")).toBe(true);
    expect(ids.has("file-s1-ep2")).toBe(true);
    expect(ids.has("file-s2-ep1")).toBe(false);
    expect(ids.size).toBe(2);
  });

  it("returns an empty set when no entries exist for the requested mediaId", async () => {
    console.info("[offline-state-store:localFileIds] no entries for queried media → empty set");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([makeEntry("show-other", "file-x")]));

    const { acquireOfflineState, localFileIdsForMedia } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    const ids = localFileIdsForMedia("show-not-here");
    console.info(`[offline-state-store:localFileIds] empty set size=${ids.size}`);
    expect(ids.size).toBe(0);
  });

  it("returns an empty set when store is empty", async () => {
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { acquireOfflineState, localFileIdsForMedia } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    const ids = localFileIdsForMedia("any-media");
    expect(ids.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. computeOfflineLocalCountsForDetails
// ---------------------------------------------------------------------------

describe("computeOfflineLocalCountsForDetails", () => {
  it("null details → returns zero counts without crashing", async () => {
    console.info("[offline-state-store:counts] computeOfflineLocalCountsForDetails(null) must not throw");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([]));

    const { acquireOfflineState, computeOfflineLocalCountsForDetails } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    const counts = computeOfflineLocalCountsForDetails(null);
    console.info(`[offline-state-store:counts] null counts.movieLocal=${counts.movieLocal} episodesLocal.size=${counts.episodesLocal.size}`);
    expect(counts.movieLocal).toBe(false);
    expect(counts.episodesLocal.size).toBe(0);
  });

  it("movie details with a saved file → movieLocal=true", async () => {
    console.info("[offline-state-store:counts] movie with local file → movieLocal=true");
    callOfflineListLocalMock.mockResolvedValue(ipcOk([makeEntry("movie-det", "movie-file")]));

    const { acquireOfflineState, computeOfflineLocalCountsForDetails } = await import(
      "../src/renderer/src/lib/offlineState"
    );
    acquireOfflineState();
    await flush();

    // Build a minimal MediaDetails-compatible object.
    const details = {
      id: "movie-det",
      type: "movie" as const,
      catalogId: 1,
      title: "Test Movie",
      originalTitle: null,
      originalLanguage: null,
      overview: null,
      year: "2020",
      rating: null,
      posterPath: null,
      backdropPath: null,
      genres: [],
      addedAt: "2024-01-01",
      updatedAt: "2024-01-01",
      hasFiles: true,
      progressPct: 0,
      lastWatchedAt: null,
      totalEpisodes: null,
      episodeCount: 0,
      cast: [],
      playlistIds: [],
      seasons: [],
      episodes: [],
      trailers: [],
      files: [
        { id: "movie-file", filename: "movie.mkv", season: null, episode: null, desiredFormats: [] },
      ],
      formats: [],
      audioTracks: [],
      subtitleTracks: [],
      subtitles: [],
      chapters: [],
      skipMarkers: [],
      hasLocalFiles: true,
    } as import("../src/renderer/src/lib/libraryDb").MediaDetails;

    const counts = computeOfflineLocalCountsForDetails(details);
    console.info(`[offline-state-store:counts] movieLocal=${counts.movieLocal}`);
    expect(counts.movieLocal).toBe(true);
  });
});
