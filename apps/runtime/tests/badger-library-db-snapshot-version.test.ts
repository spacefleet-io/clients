/**
 * @bugfix @regression-proof
 *
 * Issue #25 — library write snapshot churn.
 *
 * The desktop proxy used to apply the snapshot carried by each
 * `library.updated` frame; since #671 R3 the frame is a delta (previous
 * version, changed media, counts) and the proxy fetches what it needs through
 * `badger.db.snapshot` (optionally with `mediaIds`). Two runtime guarantees make
 * that safe:
 *   1. every `call()` that moved the library version publishes a frame —
 *      not only the methods on a hand-kept write list (a version-bumping
 *      method missing from the list left the desktop with no frame and, pre-
 *      fix, relied on the unconditional post-write fetch);
 *   2. a `badger.db.snapshot` result is stamped with the version its content
 *      is at, so the proxy can order a fetched snapshot against frames.
 */
import { describe, expect, it } from "vitest";
import { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { BadgerModule } from "../src/modules/badger";

type PublishedEvent = { channel: string; event: string; payload: Record<string, unknown> };

const makeFakeDb = () => {
  const state = { version: 7, jobs: 0, changed: new Set<string>(), unattributed: false, snapshotBuilds: 0 };
  const fakeDb = {
    getVersion: () => state.version,
    getSnapshot: () => {
      state.snapshotBuilds += 1;
      return { media: [], playlists: [], ingestJobs: Array.from({ length: state.jobs }, (_, i) => ({ id: `job-${i}` })) };
    },
    // The delta snapshot echoes the requested ids so the test can see they were passed through.
    getSnapshotDelta: (mediaIds: string[]) => ({ media: [], playlists: [], requestedDetails: mediaIds }),
    getCountSummary: () => ({ mediaCount: 3, playlistCount: 1 }),
    takeChangedMedia: () => {
      const taken = { mediaIds: [...state.changed], all: state.unattributed };
      state.changed.clear();
      state.unattributed = false;
      return taken;
    },
    getDatasetStatus: () => ({ core: true, metadata: true, playback: true }),
    // Not on the old WRITE_METHODS list, but persists (bumps the version).
    upsertIngestJob: () => {
      state.jobs += 1;
      state.changed.add("m-job");
      state.version += 1;
    },
    // A read: version unchanged.
    listIngestJobs: () => [],
    close: () => undefined,
  };
  return { fakeDb, state };
};

const makeService = () => {
  const { fakeDb, state } = makeFakeDb();
  const service = new BadgerLibraryDbService();
  // Inject the fake LibraryDb into the private slots, like the run-batch suite.
  Reflect.set(service, "db", fakeDb);
  Reflect.set(service, "lastSnapshotVersion", state.version);
  const events: PublishedEvent[] = [];
  service.setEventPublisher((channel, event, payload) => {
    events.push({ channel, event, payload });
  });
  return { service, state, events };
};

describe("badger library db snapshot version (#25) @bugfix @regression-proof", () => {
  it("publishes a delta library.updated (previous version, changed media, counts) for any call that moved the version", async () => {
    const { service, state, events } = makeService();
    await service.call("upsertIngestJob", [{ id: "job-0" }]);
    console.info(`[snapshot-version:publish] version=${state.version} events=${JSON.stringify(events.map((e) => ({ event: e.event, version: e.payload.version, reason: e.payload.reason })))}`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: "library",
      event: "library.updated",
      payload: { version: 8, previousVersion: 7, reason: "upsertIngestJob", changedMediaIds: ["m-job"], mediaCount: 3 },
    });
    // #671 R3: the frame carries no snapshot; consumers fetch what they need.
    expect(events[0].payload).not.toHaveProperty("snapshot");
  });

  it("does not publish for a call that left the version alone", async () => {
    const { service, events } = makeService();
    await service.call("listIngestJobs", []);
    console.info(`[snapshot-version:read] events=${events.length}`);
    expect(events).toHaveLength(0);
  });

  it("stamps badger.db.snapshot results with the library version and no `partial` flag", async () => {
    const mod = new BadgerModule();
    const { fakeDb } = makeFakeDb();
    Reflect.set(mod.libraryDbService, "db", fakeDb);
    const result = await mod.execute({ requestId: "snap-1", module: "badger", command: "badger.db.snapshot", payload: {} });
    console.info(`[snapshot-version:fetch] response=${JSON.stringify(result.response)}`);
    expect(result.response.ok).toBe(true);
    expect(result.response.result).toMatchObject({ version: 7, media: [] });
    expect(result.response.result).not.toHaveProperty("partial");
  });

  it("badger.db.snapshot with mediaIds returns the delta snapshot, marked partial, at the library version", async () => {
    const mod = new BadgerModule();
    const { fakeDb } = makeFakeDb();
    Reflect.set(mod.libraryDbService, "db", fakeDb);
    const result = await mod.execute({
      requestId: "snap-2",
      module: "badger",
      command: "badger.db.snapshot",
      payload: { mediaIds: ["m1", "m2"] },
    });
    console.info(`[snapshot-version:delta-fetch] response=${JSON.stringify(result.response)}`);
    expect(result.response.ok).toBe(true);
    expect(result.response.result).toMatchObject({ version: 7, partial: true, requestedDetails: ["m1", "m2"] });
  });

  it("publishes changedMediaIds: null when the write could not name its media (consumer refetches everything)", async () => {
    const { service, state, events } = makeService();
    state.unattributed = true;
    await service.call("upsertIngestJob", [{ id: "job-0" }]);
    console.info(`[snapshot-version:unattributed] payload=${JSON.stringify(events[0]?.payload)}`);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ version: 8, previousVersion: 7, changedMediaIds: null });
  });

  it("chains previousVersion across writes, resets the changed set each time, and never builds the full snapshot", async () => {
    const { service, state, events } = makeService();
    state.changed.add("m-first");
    await service.call("upsertIngestJob", [{ id: "job-0" }]);
    state.changed.add("m-second");
    await service.call("upsertIngestJob", [{ id: "job-1" }]);
    console.info(
      `[snapshot-version:chain] frames=${JSON.stringify(events.map((e) => ({ version: e.payload.version, previousVersion: e.payload.previousVersion, changed: e.payload.changedMediaIds })))} snapshotBuilds=${state.snapshotBuilds}`
    );
    expect(events.map((e) => [e.payload.previousVersion, e.payload.version])).toEqual([
      [7, 8],
      [8, 9],
    ]);
    // Each frame names only its own write's media: the set was reset after the first publish.
    expect(events.map((e) => e.payload.changedMediaIds)).toEqual([
      ["m-first", "m-job"],
      ["m-second", "m-job"],
    ]);
    // #671 R3: the ~13-queries-per-media snapshot build is off the write path.
    expect(state.snapshotBuilds).toBe(0);
  });
});
