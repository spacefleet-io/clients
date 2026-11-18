/**
 * @bugfix @regression-proof
 *
 * Issue #25 — playback must cost no more than plain local mpv.
 *
 * Replay R3 + a `--cpu-prof` of the runtime on c023 (episode, playing, lowend
 * profile): during playback the runtime's busy time was dominated by progress
 * saves. Every `setProgress` (one per second while the app window is hidden
 * behind external mpv) bumped the library version, so `publishIfVersionMoved`
 * rebuilt the WHOLE library snapshot (`getSnapshot` -> `listMedia` ->
 * `getMediaDetails` per title: ~28 % of the busy time) and pushed a ~1 MB
 * `library.updated` frame to a desktop that holds progress-only frames while
 * the window is hidden anyway.
 *
 * A write that says `deferPublish` is still persisted at once, but its frame is
 * coalesced: one publish per burst, carrying the newest version. Anything else
 * that publishes in the meantime already carries it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";

type PublishedEvent = {
  channel: string;
  event: string;
  payload: { version: number; previousVersion: number; reason: string; changedMediaIds: string[] | null };
};

const COALESCE_MS = BadgerLibraryDbService.deferredPublishMs;

const makeService = () => {
  const state = { version: 7, snapshotBuilds: 0, takes: 0, changed: new Set<string>() };
  const fakeDb = {
    getVersion: () => state.version,
    getSnapshot: () => {
      state.snapshotBuilds += 1;
      return { media: [], playlists: [] };
    },
    getCountSummary: () => ({ mediaCount: 1, playlistCount: 0 }),
    takeChangedMedia: () => {
      state.takes += 1;
      const mediaIds = [...state.changed];
      state.changed.clear();
      return { mediaIds, all: false };
    },
    getDatasetStatus: () => ({ core: true, metadata: true, playback: true }),
    setProgress: (mediaId: string) => {
      state.changed.add(mediaId);
      state.version += 1;
    },
    setSetting: () => {
      state.version += 1;
    },
    close: () => undefined,
  };
  const service = new BadgerLibraryDbService();
  Reflect.set(service, "db", fakeDb);
  Reflect.set(service, "lastSnapshotVersion", state.version);
  const events: PublishedEvent[] = [];
  service.setEventPublisher((channel, event, payload) => {
    // The publisher hands over an untyped payload; this fake db always publishes the shape declared above.
    const published: PublishedEvent["payload"] = payload as PublishedEvent["payload"];
    events.push({ channel, event, payload: published });
  });
  return { service, state, events };
};

const log = (label: string, state: { version: number; snapshotBuilds: number }, events: PublishedEvent[]) =>
  console.info(
    `[progress-publish-defer:${label}] version=${state.version} snapshotBuilds=${state.snapshotBuilds} frames=${JSON.stringify(events.map((e) => ({ version: e.payload.version, reason: e.payload.reason })))}`,
  );

describe("runtime library progress publish (#25) @bugfix @regression-proof", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a hidden-window playback minute (60 progress saves) publishes at most one delta per coalesce window, not 60", async () => {
    const { service, state, events } = makeService();
    for (let second = 1; second <= 60; second += 1) {
      await service.call("setProgress", ["m1", second], { deferPublish: true });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    log("minute", state, events);
    // 60 s with a 5 s window = 12 coalesced frames at most; the pre-fix path made 60.
    expect(events.length).toBeLessThanOrEqual(Math.ceil(60_000 / COALESCE_MS) + 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    // #671 R3: a publish builds no snapshot at all, deferred or not.
    expect(state.snapshotBuilds).toBe(0);
    // Nothing is lost: the last frame carries the newest version and the media written since the previous frame.
    expect(events.at(-1)?.payload.version).toBe(state.version);
    expect(events.at(-1)?.payload.changedMediaIds).toEqual(["m1"]);
  });

  it("holds the frame back, then publishes the newest version once", async () => {
    const { service, state, events } = makeService();
    await service.call("setProgress", ["m1", 10], { deferPublish: true });
    await service.call("setProgress", ["m1", 11], { deferPublish: true });
    await service.call("setProgress", ["m1", 12], { deferPublish: true });
    log("held", state, events);
    expect(events).toHaveLength(0);
    expect(state.takes).toBe(0);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    log("fired", state, events);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ version: 10, reason: "setProgress" });
    expect(events[0].payload).toMatchObject({ previousVersion: 7, changedMediaIds: ["m1"] });
  });

  it("an immediate publish carries the deferred write; the timer then publishes nothing", async () => {
    const { service, state, events } = makeService();
    await service.call("setProgress", ["m1", 30], { deferPublish: true });
    expect(events).toHaveLength(0);
    // The visible / mpv-exit save does not defer: publishes right now, newest state.
    await service.call("setProgress", ["m1", 95]);
    log("immediate", state, events);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ version: 9, reason: "setProgress" });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(events).toHaveLength(1);
    expect(state.snapshotBuilds).toBe(0);
  });

  it("a non-deferred write is published immediately (default contract unchanged)", async () => {
    const { service, events } = makeService();
    await service.call("setSetting", ["k", "v"]);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ version: 8, reason: "setSetting" });
  });

  it("does not publish a batch's half-written state when the timer fires inside the batch", async () => {
    const { service, state, events } = makeService();
    await service.call("setProgress", ["m1", 40], { deferPublish: true });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batch = service.runBatch("commit", async () => {
      await held;
    });
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    log("in-batch", state, events);
    expect(events).toHaveLength(0);
    release();
    await batch;
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    log("after-batch", state, events);
    expect(events).toHaveLength(1);
    expect(events[0].payload.version).toBe(state.version);
  });
});
