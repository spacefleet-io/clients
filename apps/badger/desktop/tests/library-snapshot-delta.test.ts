/**
 * @test-id LIBRARY-SNAPSHOT-DELTA-001
 * @req LIB-STORE-05
 *
 * #671 R3: the runtime's `badger.library.updated` frame is a delta
 * (`version`, `previousVersion`, `changedMediaIds`; no snapshot except on
 * `opened`). The desktop proxy:
 *   - merges a delta snapshot (`badger.db.snapshot` with `mediaIds`) into its
 *     cache when the frame continues what it holds (`previousVersion` covered);
 *   - fetches the full snapshot when it cannot: a version gap (missed frame),
 *     `changedMediaIds: null` (runtime could not attribute the write), or a
 *     delta that leaves a media without details (an unattributed new media).
 * Stamping is the subtle part: the merged cache is stamped with the frame's
 * version, not the runtime's version at response time, otherwise a write that
 * landed between the frame and the fetch would be dropped as "already current".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const webContentsSendMock = vi.hoisted(() => vi.fn());
const windowMock = vi.hoisted(() => ({
  webContents: {
    send: webContentsSendMock,
    once: vi.fn(),
    isDestroyed: () => false,
  },
  isDestroyed: () => false,
  once: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../src/main/libraryDbAccessor", () => ({
  setLibraryDbAccessorToken: () => undefined,
}));

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: () => undefined,
    warn: (...args: unknown[]) => console.warn("[proxy:warn]", JSON.stringify(args[0])),
    error: (...args: unknown[]) => console.error("[proxy:error]", JSON.stringify(args[0])),
    debug: () => undefined,
  }),
}));

// The library event stream is driven by the fake runtime below.
const streamState = vi.hoisted(() => ({
  subscriber: null as ((frame: unknown) => void) | null,
}));

vi.mock("@space/runtime-client/events", () => ({
  createRuntimeEventStream: () => ({
    start: async () => undefined,
    stop: () => {
      streamState.subscriber = null;
    },
    subscribe: (listener: (frame: unknown) => void) => {
      streamState.subscriber = listener;
      return () => {
        streamState.subscriber = null;
      };
    },
  }),
}));

process.env.SF_RUNTIME_BASE_URL = "http://mock-runtime:3020";

import { registerLibraryDbRuntimeProxy, resetLibraryDbRuntimeProxyForTests } from "../src/main/libraryDbRuntimeProxy";
import { mergeSnapshotDelta, readLibraryFrame } from "../src/main/librarySnapshotDelta";
import type { LibrarySnapshot } from "../src/shared/libraryTypes";

const LOG = "[snapshot-delta]";

/** Test snapshots only fill the fields the delta logic reads; one cast, here. */
const snap = (fields: Record<string, unknown>): LibrarySnapshot => fields as unknown as LibrarySnapshot;

type Details = { id: string; rev: number };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("readLibraryFrame (#671 R3)", () => {
  it("reads a delta frame payload", () => {
    const frame = readLibraryFrame({
      version: 9,
      previousVersion: 8,
      reason: "setProgress",
      changedMediaIds: ["a", "b"],
    });
    expect(frame).toEqual({
      version: 9,
      previousVersion: 8,
      reason: "setProgress",
      changedMediaIds: ["a", "b"],
      snapshot: null,
    });
  });

  it("keeps `changedMediaIds: null` as null (unknown) and degrades junk to no delta information", () => {
    expect(readLibraryFrame({ version: 3, changedMediaIds: null }).changedMediaIds).toBeNull();
    expect(readLibraryFrame({ version: 3, changedMediaIds: ["a", 7] }).changedMediaIds).toBeNull();
    expect(readLibraryFrame("garbage")).toEqual({
      version: undefined,
      previousVersion: undefined,
      reason: "",
      changedMediaIds: null,
      snapshot: null,
    });
  });

  it("returns the embedded snapshot of an `opened` frame", () => {
    const embedded = { media: [], playlists: [] };
    expect(readLibraryFrame({ version: 1, reason: "opened", snapshot: embedded }).snapshot).toBe(embedded);
  });
});

describe("mergeSnapshotDelta (#671 R3)", () => {
  const base = snap({
    media: [{ id: "a" }, { id: "b" }, { id: "c" }],
    playlists: [],
    mediaDetails: [
      { id: "a", rev: 1 },
      { id: "b", rev: 1 },
      { id: "c", rev: 1 },
    ],
    settings: { old: "yes" },
    version: 10,
  });

  it("takes fresh details for changed media, keeps cached ones, replaces every list", () => {
    const delta = snap({
      media: [{ id: "a" }, { id: "b" }, { id: "c" }],
      playlists: [{ id: "p" }],
      mediaDetails: [{ id: "b", rev: 2 }],
      settings: { fresh: "yes" },
      version: 12,
      partial: true,
    });
    const merged = mergeSnapshotDelta(base, delta);
    console.info(`${LOG} merged=${JSON.stringify(merged)}`);
    expect(merged?.mediaDetails).toEqual([
      { id: "a", rev: 1 },
      { id: "b", rev: 2 },
      { id: "c", rev: 1 },
    ]);
    expect(merged?.playlists).toEqual([{ id: "p" }]);
    expect(merged?.settings).toEqual({ fresh: "yes" });
    // `version` / `partial` describe the delta response: the caller stamps the merge.
    expect(merged?.version).toBe(10);
    expect(merged).not.toHaveProperty("partial");
  });

  it("follows the delta's media order and drops details of media that no longer exist", () => {
    const delta = snap({
      media: [{ id: "c" }, { id: "a" }],
      playlists: [],
      mediaDetails: [],
      version: 12,
      partial: true,
    });
    expect(mergeSnapshotDelta(base, delta)?.mediaDetails).toEqual([
      { id: "c", rev: 1 },
      { id: "a", rev: 1 },
    ]);
  });

  it("returns null when a media has no details anywhere (an unattributed new media)", () => {
    const delta = snap({
      media: [{ id: "a" }, { id: "new" }],
      playlists: [],
      mediaDetails: [],
      version: 12,
      partial: true,
    });
    expect(mergeSnapshotDelta(base, delta)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Proxy against a fake runtime that speaks the delta protocol
// ---------------------------------------------------------------------------

type Counters = { fullFetches: number; deltaFetches: number; deltaRequests: string[][]; framesPublished: number };

type FakeRuntime = {
  counters: Counters;
  fetchMock: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Move the library: bump the version, touch `ids`' details, optionally publish the frame. */
  commit: (ids: string[], options?: { frameIds?: string[] | null; publish?: boolean; reason?: string }) => number;
  /** Add a media (rows + details) and move the library; the frame names `frameIds`. */
  addMedia: (id: string, frameIds: string[] | null) => number;
  publishFrame: (frame: { version: number; previousVersion: number; changedMediaIds: string[] | null; reason?: string }) => void;
  getVersion: () => number;
  /** Highest `rev` the runtime holds for a media. */
  rev: (id: string) => number;
  /** Park every delta response until the returned function is called (a slow runtime). */
  holdDeltas: () => () => void;
  /** Publish the frame a deferred `setProgress` is waiting to announce. */
  releaseWriteFrame: () => void;
};

const createFakeRuntime = (mediaCount: number, deferWriteFrame = false): FakeRuntime => {
  const counters: Counters = { fullFetches: 0, deltaFetches: 0, deltaRequests: [], framesPublished: 0 };
  const rows: Array<{ id: string; title: string }> = [];
  const details = new Map<string, Details>();
  for (let i = 0; i < mediaCount; i += 1) {
    rows.push({ id: `media-${i}`, title: `Title ${i}` });
    details.set(`media-${i}`, { id: `media-${i}`, rev: 0 });
  }
  let version = 100;
  let sequence = 0;
  let deltaGate: PromiseWithResolvers<void> | null = null;
  let releaseWriteFrame = () => {};

  const publishFrame: FakeRuntime["publishFrame"] = ({ version: v, previousVersion, changedMediaIds, reason }) => {
    sequence += 1;
    counters.framesPublished += 1;
    const frame = {
      eventId: `evt-${sequence}`,
      sequence,
      app: "badger",
      channel: "badger.library",
      event: "badger.library.updated",
      ts: "t",
      payload: {
        version: v,
        previousVersion,
        reason: reason ?? "setProgress",
        mediaCount: rows.length,
        playlistCount: 0,
        changedMediaIds,
      },
    };
    // The real WS client hands the proxy parsed JSON.
    streamState.subscriber?.(JSON.parse(JSON.stringify(frame)));
  };

  const commit: FakeRuntime["commit"] = (ids, options = {}) => {
    const previousVersion = version;
    version += 1;
    for (const id of ids) {
      const current = details.get(id);
      if (current) details.set(id, { id, rev: current.rev + 1 });
    }
    if (options.publish !== false) {
      publishFrame({
        version,
        previousVersion,
        changedMediaIds: options.frameIds === undefined ? ids : options.frameIds,
        reason: options.reason,
      });
    }
    return version;
  };

  const addMedia: FakeRuntime["addMedia"] = (id, frameIds) => {
    rows.push({ id, title: id });
    details.set(id, { id, rev: 1 });
    return commit([], { frameIds });
  };

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const ok = (result: unknown) => json({ requestId: "r", ok: true, result, error: null });

  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/runtime/session/login")) {
      return json({
        ok: true,
        token: "rt-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        capabilities: { apps: ["badger"] },
      });
    }
    if (!urlStr.includes("/modules/badger/commands")) return new Response("not found", { status: 404 });
    const body = init?.body ? (JSON.parse(String(init.body)) as { command?: string; payload?: Record<string, unknown> }) : {};
    const command = body.command ?? "";
    if (command === "badger.db.open") return ok({});
    if (command === "badger.db.status") {
      return ok({ open: true, version, datasetStatus: { core: true, metadata: true, playback: true } });
    }
    if (command === "badger.db.snapshot") {
      const mediaIds = body.payload?.mediaIds as string[] | undefined;
      if (mediaIds) {
        counters.deltaFetches += 1;
        counters.deltaRequests.push(mediaIds);
        await deltaGate?.promise;
        return ok({
          media: rows,
          playlists: [],
          mediaDetails: mediaIds.map((id) => details.get(id)).filter((d): d is Details => Boolean(d)),
          settings: {},
          version,
          partial: true,
        });
      }
      counters.fullFetches += 1;
      return ok({ media: rows, playlists: [], mediaDetails: [...details.values()], settings: {}, version });
    }
    if (command === "badger.db.call") {
      const method = String(body.payload?.method ?? "");
      if (method === "setProgress") {
        // The write moves the library; with `deferWriteFrame` its frame is published by the test, after the response.
        const previousVersion = version;
        version += 1;
        const current = details.get("media-0");
        if (current) details.set("media-0", { id: "media-0", rev: current.rev + 1 });
        const frame = { version, previousVersion, changedMediaIds: ["media-0"] };
        if (deferWriteFrame) releaseWriteFrame = () => publishFrame(frame);
        else publishFrame(frame);
        return ok(null);
      }
      return ok(null);
    }
    return ok({});
  };

  return {
    counters,
    fetchMock,
    commit,
    addMedia,
    publishFrame,
    getVersion: () => version,
    rev: (id) => details.get(id)?.rev ?? -1,
    holdDeltas: () => {
      const gate = Promise.withResolvers<void>();
      deltaGate = gate;
      return () => {
        deltaGate = null;
        gate.resolve();
      };
    },
    releaseWriteFrame: () => releaseWriteFrame(),
  };
};

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;

describe("library proxy applies delta frames (#671 R3) @bugfix @regression-proof", () => {
  let handlers: Map<string, IpcHandler>;
  let runtime: FakeRuntime;

  const call = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  };

  const setup = async (mediaCount = 5, deferWriteFrame = false) => {
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    webContentsSendMock.mockReset();
    streamState.subscriber = null;
    runtime = createFakeRuntime(mediaCount, deferWriteFrame);
    vi.stubGlobal("fetch", runtime.fetchMock);
    handlers = new Map<string, IpcHandler>();
    registerLibraryDbRuntimeProxy(
      { handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as never,
      () => windowMock as never
    );
    await call("sf-library-db-open", { token: "backend-token", keyBase64: "key" });
    expect(streamState.subscriber).toBeTruthy();
    console.info(`${LOG}:setup opened; counters=${JSON.stringify(runtime.counters)}`);
    // The open's full fetch is the baseline: measure only what a test does.
    Object.assign(runtime.counters, { fullFetches: 0, deltaFetches: 0, deltaRequests: [], framesPublished: 0 });
  };

  const cached = async () => (await call("sf-library-db-call", { method: "getSnapshot" })) as LibrarySnapshot & { version?: number };

  const revOf = (snapshot: LibrarySnapshot, id: string) =>
    (snapshot.mediaDetails as unknown as Details[]).find((d) => d.id === id)?.rev;

  beforeEach(() => {
    webContentsSendMock.mockReset();
  });

  it("merges a delta frame at previousVersion: one delta fetch for the changed media, no full fetch", async () => {
    await setup();
    const v = runtime.commit(["media-2"]);
    await vi.waitFor(async () => expect((await cached()).version).toBe(v));
    const snapshot = await cached();
    console.info(`${LOG}:merge counters=${JSON.stringify(runtime.counters)} version=${String(snapshot.version)}`);
    expect(runtime.counters.deltaFetches).toBe(1);
    expect(runtime.counters.deltaRequests).toEqual([["media-2"]]);
    expect(runtime.counters.fullFetches).toBe(0);
    expect(revOf(snapshot, "media-2")).toBe(1);
    // Untouched media keep their cached details.
    expect(revOf(snapshot, "media-0")).toBe(0);
    expect(snapshot.mediaDetails).toHaveLength(5);
  });

  it("a media-free write (empty changedMediaIds) still advances the cache through a delta fetch", async () => {
    await setup();
    const v = runtime.commit([]);
    await vi.waitFor(async () => expect((await cached()).version).toBe(v));
    console.info(`${LOG}:media-free counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.deltaRequests).toEqual([[]]);
    expect(runtime.counters.fullFetches).toBe(0);
  });

  it("falls back to a full fetch on a version gap (a missed frame)", async () => {
    await setup();
    runtime.commit(["media-1"], { publish: false }); // frame lost
    const v = runtime.commit(["media-3"]); // next frame's previousVersion is ahead of the cache
    await vi.waitFor(async () => expect((await cached()).version).toBe(v));
    const snapshot = await cached();
    console.info(`${LOG}:gap counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.fullFetches).toBe(1);
    expect(runtime.counters.deltaFetches).toBe(0);
    // The lost frame's change arrived with the full fetch.
    expect(revOf(snapshot, "media-1")).toBe(1);
    expect(revOf(snapshot, "media-3")).toBe(1);
  });

  it("falls back to a full fetch when the frame's changedMediaIds is null (unattributed write)", async () => {
    await setup();
    const v = runtime.commit(["media-1", "media-4"], { frameIds: null });
    await vi.waitFor(async () => expect((await cached()).version).toBe(v));
    const snapshot = await cached();
    console.info(`${LOG}:null-ids counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.fullFetches).toBe(1);
    expect(runtime.counters.deltaFetches).toBe(0);
    expect(revOf(snapshot, "media-1")).toBe(1);
    expect(revOf(snapshot, "media-4")).toBe(1);
  });

  it("falls back to a full fetch when the delta leaves a new media without details", async () => {
    await setup();
    // The runtime added a media but the frame (wrongly) named none: the delta cannot be merged.
    const v = runtime.addMedia("media-new", []);
    await vi.waitFor(async () => expect((await cached()).version).toBe(v));
    const snapshot = await cached();
    console.info(`${LOG}:new-media counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.deltaFetches).toBe(1);
    expect(runtime.counters.fullFetches).toBe(1);
    expect(revOf(snapshot, "media-new")).toBe(1);
    expect(snapshot.mediaDetails).toHaveLength(6);
  });

  it("a write that lands between a frame and its fetch is not dropped (cache is stamped with the frame version)", async () => {
    await setup();
    const v1 = runtime.commit(["media-1"]);
    // Before the proxy's delta fetch runs, the runtime moves again; that frame is not delivered yet.
    const v2 = runtime.commit(["media-2"], { publish: false });
    await vi.waitFor(async () => expect((await cached()).version).toBe(v1));
    runtime.publishFrame({ version: v2, previousVersion: v1, changedMediaIds: ["media-2"] });
    await vi.waitFor(async () => expect((await cached()).version).toBe(v2));
    const snapshot = await cached();
    console.info(`${LOG}:between counters=${JSON.stringify(runtime.counters)}`);
    expect(revOf(snapshot, "media-1")).toBe(1);
    expect(revOf(snapshot, "media-2")).toBe(1);
    expect(runtime.counters.fullFetches).toBe(0);
  });

  it("a burst of chained frames coalesces into at most two delta fetches and ends fully merged", async () => {
    await setup(20);
    let last = 0;
    for (let i = 0; i < 10; i += 1) last = runtime.commit([`media-${i}`]);
    await vi.waitFor(async () => expect((await cached()).version).toBe(last));
    const snapshot = await cached();
    console.info(`${LOG}:burst counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.fullFetches).toBe(0);
    expect(runtime.counters.deltaFetches).toBeLessThanOrEqual(2);
    for (let i = 0; i < 10; i += 1) expect(revOf(snapshot, `media-${i}`)).toBe(1);
    expect(revOf(snapshot, "media-15")).toBe(0);
  });

  it("a write waits for its delta to land: the response resolves with the merged cache and no snapshot fetch", async () => {
    await setup(5, true);
    const write = call("sf-library-db-call", { method: "setProgress", args: ["media-0", 42, null, null] });
    // The runtime answers the command, then announces it: the frame trails the response.
    await vi.waitFor(() => expect(runtime.getVersion()).toBe(101));
    runtime.releaseWriteFrame();
    await write;
    // Read-your-writes: by the time the write resolves the merge is in the cache.
    const snapshot = await cached();
    console.info(`${LOG}:writer-waits counters=${JSON.stringify(runtime.counters)} version=${String(snapshot.version)}`);
    expect(revOf(snapshot, "media-0")).toBe(1);
    expect(runtime.counters.fullFetches).toBe(0);
    expect(runtime.counters.deltaRequests).toEqual([["media-0"]]);
  });

  it("never labels the old cache with a frame's version while that frame's delta is still in flight", async () => {
    await setup();
    const base = runtime.getVersion();
    const release = runtime.holdDeltas();
    const v = runtime.commit(["media-2"]);
    await vi.waitFor(() => expect(runtime.counters.deltaFetches).toBe(1));
    webContentsSendMock.mockClear();

    // A forced emit (a commit-reason replay of the same frame) lands in the window between frame and merge.
    runtime.publishFrame({ version: v, previousVersion: base, changedMediaIds: ["media-2"], reason: "commit:replay" });
    const during = webContentsSendMock.mock.calls.map(([, payload]) => payload as { snapshot: LibrarySnapshot; version?: number });
    console.info(`${LOG}:in-flight emits=${JSON.stringify(during.map((p) => p.version))}`);
    for (const payload of during) {
      expect(payload.version === v && revOf(payload.snapshot, "media-2") === 0).toBe(false);
    }

    release();
    await vi.waitFor(async () => expect((await cached()).version).toBe(v));
    // The merged cache goes out on the next throttle tick, with its own version.
    await vi.waitFor(() => {
      const last = webContentsSendMock.mock.calls.at(-1)?.[1] as { snapshot: LibrarySnapshot; version?: number } | undefined;
      expect(last?.version).toBe(v);
      expect(revOf(last!.snapshot, "media-2")).toBe(1);
    });
  });
});
