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
 * tab bar's sign reads: "Updating library…" with progress while ops arrive, then a short result, or the failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLibrarySyncTracker,
  LIBRARY_SYNC_RESULT_MS,
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
    await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_SHOW_DELAY_MS);
    expect(LIBRARY_SYNC_SHOW_DELAY_MS).toBeLessThan(1_000);
    expect(last()).toMatchObject({ kind: "syncing", source: "start", fromVersion: 391, toVersion: 521, doneVersion: 391, phase: "ops" });
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

  it("a run no caller tracks (the db's own re-sync) shows nothing: it has no end to wait for", async () => {
    const tracker = make();
    tracker.progress({ kind: "start", fromVersion: 1, toVersion: 4 });
    tracker.progress({ kind: "snapshot" });
    await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_SHOW_DELAY_MS);
    expect(states).toEqual([]);
  });
});
