/**
 * @test-id MOBILE-LIBRARY-SYNC-STATUS-001
 * @level unit
 * @req LIB-SYNC-13[badger-mobile]
 * @bugfix
 * @regression-proof
 *
 * Why this exists: Chris opened Badger on his phone after a night of episode uploads from Badger desktop and saw the
 * old library with no sign that anything was loading; the new episodes arrived minutes later, silently (2026-11-21).
 * Every sync (cold start, back to the front, the live stream, pull-to-refresh) now goes through one tracker that the
 * tab bar's sign reads: "Updating media library…" with progress while ops arrive, then a short result, or the failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLibrarySyncTracker,
  LIBRARY_SYNC_RESULT_MS,
  LIBRARY_SYNC_SHOW_AT_ONCE_BYTES,
  LIBRARY_SYNC_SHOW_AT_ONCE_VERSIONS,
  LIBRARY_SYNC_SHOW_DELAY_MS,
  librarySyncProgress,
  type LibrarySyncCounts,
  type LibrarySyncState,
} from "../src/lib/librarySyncStatus";

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

let states: LibrarySyncState[] = [];
let counts: LibrarySyncCounts = { titles: 10, episodes: 100 };
const make = () =>
  createLibrarySyncTracker({
    onState: (state) => states.push(state),
    counts: async () => ({ ...counts }),
    log: () => undefined,
  });
const last = () => states[states.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  states = [];
  counts = { titles: 10, episodes: 100 };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("library sync tracker (LIB-SYNC-13)", () => {
  // @req LIB-SYNC-13[badger-mobile]
  it("a cold-start sync shows 'updating' within a second of finding the server newer, with page progress, then the new episodes", async () => {
    const tracker = make();
    const run = Promise.withResolvers<boolean>();
    const done = tracker.track("start", () => run.promise);
    await flush();
    expect(states, "asking the server for its version is quiet").toEqual([]);

    tracker.progress({ kind: "start", fromVersion: 391, toVersion: 521 });
    expect(
      last(),
      "a batch shows before the first page is asked for (reading a page holds the JS thread for seconds)"
    ).toMatchObject({ kind: "syncing", source: "start", fromVersion: 391, toVersion: 521, doneVersion: 391, phase: "ops" });
    expect(LIBRARY_SYNC_SHOW_AT_ONCE_VERSIONS).toBeLessThanOrEqual(521 - 391);
    expect(librarySyncProgress(last())).toBe(0);

    tracker.progress({ kind: "page", version: 456 });
    expect(last()).toMatchObject({ kind: "syncing", doneVersion: 456 });
    expect(librarySyncProgress(last())).toBeCloseTo(0.5, 2);

    counts = { titles: 11, episodes: 112 };
    run.resolve(true);
    await done;
    await flush();
    expect(last()).toMatchObject({ kind: "done", source: "start", changed: true, newTitles: 1, newEpisodes: 12 });

    await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_RESULT_MS);
    expect(last(), "the result passes on its own").toEqual({ kind: "idle" });
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("a quick sync of other changes (another device's play position) passes unseen", async () => {
    const tracker = make();
    await tracker.track("stream", async () => {
      tracker.progress({ kind: "start", fromVersion: 520, toVersion: 521 });
      tracker.progress({ kind: "fetch", bytes: 4_096 });
      tracker.progress({ kind: "page", version: 521 });
      return true;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_SHOW_DELAY_MS * 2);
    expect(states, JSON.stringify(states)).toEqual([]);
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("a quick sync that brings new episodes still says so", async () => {
    const tracker = make();
    await tracker.track("stream", async () => {
      tracker.progress({ kind: "start", fromVersion: 520, toVersion: 521 });
      counts = { titles: 10, episodes: 101 };
      return true;
    });
    await flush();
    expect(states.map((s) => s.kind)).toEqual(["done"]);
    expect(last()).toMatchObject({ newTitles: 0, newEpisodes: 1 });
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("a sync one or two versions behind shows only once it outlasts the delay", async () => {
    const tracker = make();
    const run = Promise.withResolvers<boolean>();
    const done = tracker.track("foreground", () => run.promise);
    tracker.progress({ kind: "start", fromVersion: 520, toVersion: 522 });
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_SHOW_DELAY_MS);
    expect(LIBRARY_SYNC_SHOW_DELAY_MS).toBeLessThan(1_000);
    expect(last()).toMatchObject({ kind: "syncing", source: "foreground" });
    run.resolve(true);
    await done;
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("@bugfix a large page shows the sign before its download, even one version behind", async () => {
    // op9 2026-11-21: one 4.65 MB media.upsert op held the JS thread ~11 s, so the 400 ms timer fired 11.2 s late.
    const tracker = make();
    const run = Promise.withResolvers<boolean>();
    const done = tracker.track("stream", () => run.promise);
    tracker.progress({ kind: "start", fromVersion: 23, toVersion: 24 });
    expect(states).toEqual([]);
    tracker.progress({ kind: "fetch", bytes: LIBRARY_SYNC_SHOW_AT_ONCE_BYTES });
    expect(last(), "no timer: the sign is set before the download starts").toMatchObject({
      kind: "syncing",
      fromVersion: 23,
      toVersion: 24,
    });
    run.resolve(true);
    await done;
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("nothing new stays quiet, unless the user pulled to refresh (then it says up to date)", async () => {
    const tracker = make();
    await tracker.track("foreground", async () => false);
    await flush();
    expect(states).toEqual([]);

    await tracker.track("pull", async () => false);
    await flush();
    expect(last()).toMatchObject({ kind: "done", source: "pull", changed: false, newTitles: 0, newEpisodes: 0 });
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("overlapping syncs (stream + foreground) show ONE updating state, done once the last one settles", async () => {
    const tracker = make();
    const a = Promise.withResolvers<boolean>();
    const b = Promise.withResolvers<boolean>();
    const first = tracker.track("stream", () => a.promise);
    const second = tracker.track("foreground", () => b.promise);
    tracker.progress({ kind: "start", fromVersion: 1, toVersion: 9 });
    tracker.progress({ kind: "start", fromVersion: 1, toVersion: 12 });
    await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_SHOW_DELAY_MS);
    a.resolve(true);
    await first;
    await flush();
    expect(last().kind, "still syncing while the foreground run is in flight").toBe("syncing");
    expect(last()).toMatchObject({ toVersion: 12 });
    counts = { titles: 12, episodes: 100 };
    b.resolve(false);
    await second;
    await flush();
    expect(states.filter((s) => s.kind === "done")).toHaveLength(1);
    expect(last()).toMatchObject({ kind: "done", changed: true, newTitles: 2, newEpisodes: 0 });
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("a snapshot restore shows at once, without page progress", async () => {
    const tracker = make();
    const run = Promise.withResolvers<boolean>();
    const done = tracker.track("start", () => run.promise);
    tracker.progress({ kind: "start", fromVersion: 3, toVersion: 800 });
    tracker.progress({ kind: "snapshot" });
    expect(last()).toMatchObject({ kind: "syncing", phase: "snapshot" });
    expect(librarySyncProgress(last())).toBeNull();
    run.resolve(true);
    await done;
    await flush();
    expect(last()).toMatchObject({ kind: "done", changed: true });
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("a failed sync is shown and the error still reaches the caller; the next good sync clears it", async () => {
    const tracker = make();
    const failing = tracker.track("stream", async () => {
      throw new Error("Network request failed");
    });
    await expect(failing).rejects.toThrow("Network request failed");
    await flush();
    expect(last()).toMatchObject({ kind: "failed", source: "stream", error: "Network request failed" });
    await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_RESULT_MS * 3);
    expect(last().kind, "a failure stays until a sync works").toBe("failed");

    await tracker.track("foreground", async () => false);
    await flush();
    expect(last()).toEqual({ kind: "idle" });
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("@bugfix a retry after a failure replaces the failed sign at once", async () => {
    // op9 2026-11-21: after a tap on the failed sign the screen kept saying the update failed for 11 s of retry.
    const tracker = make();
    await expect(tracker.track("stream", async () => Promise.reject(new Error("Network request failed")))).rejects.toThrow();
    await flush();
    expect(last().kind).toBe("failed");
    const run = Promise.withResolvers<boolean>();
    const retry = tracker.track("pull", () => run.promise);
    tracker.progress({ kind: "start", fromVersion: 26, toVersion: 27 });
    expect(last()).toMatchObject({ kind: "syncing", fromVersion: 26, toVersion: 27 });
    run.resolve(true);
    await retry;
  });

  it("counts that cannot be read still give a result after a sync that showed (changed, no numbers)", async () => {
    const tracker = createLibrarySyncTracker({
      onState: (state) => states.push(state),
      counts: async () => {
        throw new Error("metadata db closed");
      },
      log: () => undefined,
    });
    const run = Promise.withResolvers<boolean>();
    const done = tracker.track("stream", () => run.promise);
    tracker.progress({ kind: "start", fromVersion: 1, toVersion: 2 });
    await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_SHOW_DELAY_MS);
    run.resolve(true);
    await done;
    await flush();
    expect(last()).toMatchObject({ kind: "done", changed: true, newTitles: null, newEpisodes: null });
  });

  // @req LIB-SYNC-13[badger-mobile]
  it("a run the db starts on its own shows, and its `end` settles it (with its failure)", async () => {
    const tracker = make();
    tracker.progress({ kind: "start", fromVersion: 1, toVersion: 4 });
    expect(last()).toMatchObject({ kind: "syncing", fromVersion: 1, toVersion: 4 });
    counts = { titles: 11, episodes: 100 };
    tracker.progress({ kind: "end", error: null });
    await flush();
    expect(last()).toMatchObject({ kind: "done", changed: true, newTitles: 1 });

    tracker.progress({ kind: "start", fromVersion: 4, toVersion: 9 });
    tracker.progress({ kind: "end", error: "OPS_RESPONSE_INVALID" });
    await flush();
    expect(last()).toMatchObject({ kind: "failed", error: "OPS_RESPONSE_INVALID" });
  });

  // @req LIB-SYNC-13[badger-mobile]
  // op9, 2026-11-21: the cold start's sync was already running (begun by the db's own re-sync) when the store's tracked
  // "start" call joined it, so the tracker never saw a `start` while it had a caller and the sign never showed.
  it("a tracked caller that joins a run the db started keeps the sign until the caller settles", async () => {
    const tracker = make();
    tracker.progress({ kind: "start", fromVersion: 7, toVersion: 16 });
    expect(last()).toMatchObject({ kind: "syncing", fromVersion: 7, toVersion: 16 });
    const run = Promise.withResolvers<boolean>();
    const done = tracker.track("start", () => run.promise);
    tracker.progress({ kind: "page", version: 11 });
    expect(last()).toMatchObject({ kind: "syncing", doneVersion: 11 });
    tracker.progress({ kind: "end", error: null });
    await flush();
    expect(last().kind, "the caller is still waiting: no result yet").toBe("syncing");
    counts = { titles: 11, episodes: 110 };
    run.resolve(true);
    await done;
    await flush();
    expect(states.filter((s) => s.kind === "done")).toHaveLength(1);
    expect(last()).toMatchObject({ kind: "done", newTitles: 1, newEpisodes: 10 });
  });
});
