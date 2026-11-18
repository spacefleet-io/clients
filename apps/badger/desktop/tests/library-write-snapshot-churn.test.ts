/**
 * @test-id LIBRARY-WRITE-SNAPSHOT-CHURN-001
 * @bugfix @regression-proof
 *
 * Issue #25: every library write through the desktop runtime proxy pulled
 * the full library snapshot (~1 MB) TWICE — once from the
 * `sf-library-db-call` handler after the write, and once more when the
 * runtime's `badger.library.updated` frame for that same write arrived —
 * even though that frame already carries the post-write snapshot. Playback
 * persists progress every 500 ms, so a playback minute moved ~120 writes ×
 * 3 snapshots through the main process.
 *
 * Contract pinned here:
 *   - a write whose `badger.library.updated` frame carries the snapshot
 *     costs ZERO `badger.db.snapshot` fetches, whichever of the write
 *     response / the frame lands first;
 *   - the write's IPC response still resolves only after the main-process
 *     cache reflects the write (read-your-writes for the renderer);
 *   - out-of-order frames never regress the cache;
 *   - a lost frame falls back to exactly ONE fetch;
 *   - frames without a snapshot (replayed ring) coalesce into a bounded
 *     number of fetches;
 *   - reads do not fetch the snapshot.
 *
 * Set SF_MEASURE_PLAYBACK_MINUTE=1 to run the real-time playback minute
 * (120 setProgress writes at the engine's 500 ms cadence over a ~1 MB
 * snapshot) and print bytes / fetches / main-process CPU.
 */
import { appendFileSync } from "node:fs";
import { setTimeout as settle } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real (short) settle windows are deliberate here: the proxy runs through the
// real runtime-client fetch/Response parsing plus its own throttle and
// frame-wait timers, and the "no extra snapshot fetch happened" assertions
// need the fire-and-forget refreshes the pre-fix code issued to land first.

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

import {
  refreshAndEmitProxySnapshot,
  registerLibraryDbRuntimeProxy,
  resetLibraryDbRuntimeProxyForTests,
} from "../src/main/libraryDbRuntimeProxy";
import { markAppWindowVisibility } from "../src/main/appWindowVisibility";

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;

type FrameDelivery = "before-response" | "after-response" | "none";

type FakeRuntimeCounters = {
  snapshotFetches: number;
  snapshotFetchBytes: number;
  statusCalls: number;
  calls: number;
  framesPublished: number;
  frameBytes: number;
};

type FakeRuntime = {
  counters: FakeRuntimeCounters;
  fetchMock: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  publishFrame: (version: number, reason: string, snapshotJson: string | null) => void;
  snapshotJson: () => string;
  getVersion: () => number;
  bumpVersion: () => number;
  staticBytes: number;
};

type FakeRuntimeOptions = {
  /** Approximate serialized size of the static part of the snapshot. */
  snapshotBytes?: number;
  frameDelivery?: FrameDelivery;
  frameCarriesSnapshot?: boolean;
  afterResponseDelayMs?: number;
};

/**
 * Minimal stand-in for the runtime's badger module. Mirrors the real
 * ordering: a version-bumping `badger.db.call` publishes
 * `badger.library.updated` (carrying the post-write snapshot) BEFORE the
 * HTTP response is written. Snapshot JSON is assembled by string concat
 * from a pre-serialized body so the measured CPU is the proxy's (JSON
 * parse/validate/dedupe), not the fake runtime's.
 */
const createFakeRuntime = (options: FakeRuntimeOptions = {}): FakeRuntime => {
  const frameDelivery = options.frameDelivery ?? "before-response";
  const frameCarriesSnapshot = options.frameCarriesSnapshot ?? true;
  const targetBytes = options.snapshotBytes ?? 4_000;
  const media: Array<Record<string, unknown>> = [];
  let staticBody = "";
  for (let i = 0; staticBody.length < targetBytes; i += 1) {
    media.push({
      id: `media-${i}`,
      title: `Title ${i} ${"x".repeat(180)}`,
      overview: "o".repeat(400),
      posterPath: `/poster/${i}.jpg`,
    });
    if (i % 50 === 0 || staticBody.length + 700 >= targetBytes) {
      staticBody = `"media":${JSON.stringify(media)},"playlists":[]`;
    }
  }
  staticBody = `"media":${JSON.stringify(media)},"playlists":[]`;

  const counters: FakeRuntimeCounters = {
    snapshotFetches: 0,
    snapshotFetchBytes: 0,
    statusCalls: 0,
    calls: 0,
    framesPublished: 0,
    frameBytes: 0,
  };
  let version = 100;
  let progressPct = 0;
  let sequence = 0;

  const snapshotJson = () =>
    `{${staticBody},"settings":{"progress":{"value":"${progressPct}","updatedAt":"t"}},"version":${version}}`;

  const publishFrame = (v: number, reason: string, snapJson: string | null) => {
    sequence += 1;
    const payload = snapJson
      ? `{"version":${v},"reason":"${reason}","mediaCount":${media.length},"playlistCount":0,"snapshot":${snapJson}}`
      : `{"version":${v},"reason":"${reason}","mediaCount":${media.length},"playlistCount":0}`;
    const frameJson = `{"eventId":"evt-${sequence}","sequence":${sequence},"app":"badger","channel":"badger.library","event":"badger.library.updated","ts":"t","payload":${payload}}`;
    counters.framesPublished += 1;
    counters.frameBytes += frameJson.length;
    // The real WS client parses every frame in the main process.
    streamState.subscriber?.(JSON.parse(frameJson));
  };

  const json = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  const ok = (resultJson: string) => json(`{"requestId":"r","ok":true,"result":${resultJson},"error":null}`);

  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/runtime/session/login")) {
      return json(
        JSON.stringify({
          ok: true,
          token: "rt-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          capabilities: { apps: ["badger"] },
        })
      );
    }
    if (!urlStr.includes("/modules/badger/commands")) return new Response("not found", { status: 404 });
    const body = init?.body ? (JSON.parse(String(init.body)) as { command?: string; payload?: Record<string, unknown> }) : {};
    const command = body.command ?? "";
    if (command === "badger.db.open") return ok("{}");
    if (command === "badger.db.status") {
      counters.statusCalls += 1;
      return ok(`{"open":true,"version":${version},"datasetStatus":{"core":true,"metadata":true,"playback":true}}`);
    }
    if (command === "badger.db.snapshot") {
      const snap = snapshotJson();
      counters.snapshotFetches += 1;
      counters.snapshotFetchBytes += snap.length;
      return ok(snap);
    }
    if (command === "badger.db.call") {
      counters.calls += 1;
      const method = String(body.payload?.method ?? "");
      if (method === "setProgress") {
        progressPct = Number((body.payload?.args as unknown[] | undefined)?.[1] ?? 0);
        version += 1;
        const v = version;
        const snap = frameCarriesSnapshot ? snapshotJson() : null;
        if (frameDelivery === "before-response") {
          publishFrame(v, method, snap);
        } else if (frameDelivery === "after-response") {
          setTimeout(() => publishFrame(v, method, snap), options.afterResponseDelayMs ?? 30);
        }
        return ok("null");
      }
      // Reads (getMediaDetails etc.) don't bump the version.
      return ok(`{"id":"media-0"}`);
    }
    return ok("{}");
  };

  return {
    counters,
    fetchMock,
    publishFrame,
    snapshotJson,
    getVersion: () => version,
    bumpVersion: () => {
      version += 1;
      return version;
    },
    staticBytes: staticBody.length,
  };
};

const createIpcHarness = () => {
  const handlers = new Map<string, IpcHandler>();
  const ipc = {
    handle: (channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    },
  };
  return { ipc, handlers };
};

const snapshotSends = () =>
  webContentsSendMock.mock.calls.filter((c) => c[0] === "sf-library-db-snapshot") as Array<
    [string, { snapshot: Record<string, unknown>; version?: number }]
  >;

const lastSentProgress = () => {
  const sends = snapshotSends();
  const last = sends[sends.length - 1];
  const settings = last?.[1]?.snapshot?.settings as Record<string, { value: string }> | undefined;
  return settings?.progress?.value;
};

describe("library write snapshot churn (#25) @bugfix @regression-proof", () => {
  let handlers: Map<string, IpcHandler>;
  let runtime: FakeRuntime;

  const setup = async (options: FakeRuntimeOptions = {}) => {
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    webContentsSendMock.mockReset();
    streamState.subscriber = null;
    runtime = createFakeRuntime(options);
    vi.stubGlobal("fetch", runtime.fetchMock);
    const harness = createIpcHarness();
    handlers = harness.handlers;
    registerLibraryDbRuntimeProxy(harness.ipc as never, () => windowMock as never);
    await call("sf-library-db-open", { token: "backend-token", keyBase64: "key" });
    expect(streamState.subscriber).toBeTruthy();
    console.info(
      `[write-churn:setup] opened; frameDelivery=${options.frameDelivery ?? "before-response"} counters=${JSON.stringify(runtime.counters)}`
    );
    // Reset counters so each test measures only its own traffic.
    Object.assign(runtime.counters, {
      snapshotFetches: 0,
      snapshotFetchBytes: 0,
      statusCalls: 0,
      calls: 0,
      framesPublished: 0,
      frameBytes: 0,
    });
    webContentsSendMock.mockClear();
  };

  const call = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  };

  const setProgress = (pct: number) =>
    call("sf-library-db-call", { method: "setProgress", args: ["media-0", pct, null, null] });

  beforeEach(() => {
    webContentsSendMock.mockReset();
  });

  it("a write whose updated frame carries the snapshot costs zero snapshot fetches", async () => {
    await setup({ frameDelivery: "before-response" });
    await setProgress(42);
    // Let any fire-and-forget refresh (pre-fix: the frame handler's) land.
    await settle(50);
    console.info(`[write-churn:frame-first] counters=${JSON.stringify(runtime.counters)} sends=${snapshotSends().length}`);
    expect(runtime.counters.snapshotFetches).toBe(0);
    const cached = (await call("sf-library-db-call", { method: "getSnapshot" })) as Record<string, unknown>;
    expect((cached.settings as Record<string, { value: string }>).progress.value).toBe("42");
    await vi.waitFor(() => expect(lastSentProgress()).toBe("42"));
  });

  it("when the write response beats the frame, the response waits for the frame instead of fetching", async () => {
    await setup({ frameDelivery: "after-response", afterResponseDelayMs: 40 });
    await setProgress(7);
    // Read-your-writes: by the time the write resolves, the cache serves it.
    const cached = (await call("sf-library-db-call", { method: "getSnapshot" })) as Record<string, unknown>;
    console.info(`[write-churn:response-first] counters=${JSON.stringify(runtime.counters)} cachedVersion=${String(cached.version)}`);
    expect((cached.settings as Record<string, { value: string }>).progress.value).toBe("7");
    await settle(80);
    expect(runtime.counters.snapshotFetches).toBe(0);
  });

  it("a lost frame falls back to exactly one snapshot fetch", async () => {
    await setup({ frameDelivery: "none" });
    await setProgress(9);
    await settle(50);
    console.info(`[write-churn:lost-frame] counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.snapshotFetches).toBe(1);
    const cached = (await call("sf-library-db-call", { method: "getSnapshot" })) as Record<string, unknown>;
    expect((cached.settings as Record<string, { value: string }>).progress.value).toBe("9");
  });

  it("an out-of-order (older) frame never regresses the cached snapshot", async () => {
    await setup({ frameDelivery: "none" });
    const vOld = runtime.bumpVersion();
    const oldSnap = runtime.snapshotJson();
    const vNew = runtime.bumpVersion();
    const newSnap = runtime.snapshotJson().replace('"value":"0"', '"value":"99"');
    runtime.publishFrame(vNew, "setProgress", newSnap);
    runtime.publishFrame(vOld, "setProgress", oldSnap);
    await settle(20);
    const cached = (await call("sf-library-db-call", { method: "getSnapshot" })) as Record<string, unknown>;
    console.info(`[write-churn:out-of-order] cachedVersion=${String(cached.version)} counters=${JSON.stringify(runtime.counters)}`);
    expect(cached.version).toBe(vNew);
    expect((cached.settings as Record<string, { value: string }>).progress.value).toBe("99");
    expect(runtime.counters.snapshotFetches).toBe(0);
  });

  it("snapshot-less frames (replayed ring) coalesce into a bounded number of fetches", async () => {
    await setup({ frameDelivery: "none" });
    for (let i = 0; i < 10; i += 1) {
      runtime.publishFrame(runtime.bumpVersion(), "replay", null);
    }
    await vi.waitFor(() => {
      const cached = snapshotSends().at(-1)?.[1]?.snapshot;
      expect(cached?.version).toBe(runtime.getVersion());
    });
    await settle(50);
    console.info(`[write-churn:replay-burst] counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.snapshotFetches).toBeGreaterThanOrEqual(1);
    expect(runtime.counters.snapshotFetches).toBeLessThanOrEqual(2);
  });

  it("a read through sf-library-db-call does not fetch the snapshot", async () => {
    await setup({ frameDelivery: "before-response" });
    await call("sf-library-db-call", { method: "getMediaDetails", args: ["media-0"] });
    await settle(30);
    console.info(`[write-churn:read] counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.snapshotFetches).toBe(0);
  });

  it("refreshAndEmitProxySnapshot does not re-fetch a snapshot the frame already delivered", async () => {
    await setup({ frameDelivery: "before-response" });
    await setProgress(55);
    await refreshAndEmitProxySnapshot({ force: true });
    await settle(30);
    console.info(`[write-churn:explicit-refresh] counters=${JSON.stringify(runtime.counters)}`);
    expect(runtime.counters.snapshotFetches).toBe(0);
    expect(lastSentProgress()).toBe("55");
  });

  // Issue #25 P1 (ultimate "before" baseline #2): the hidden
  // renderer burned 12–15 % CPU (budget ≤ 5 %) during external playback. The
  // engine's 1 Hz hidden progress save persists through `setProgress`; the
  // runtime's `badger.library.updated` frame (reason "setProgress") was echoed
  // to the hidden renderer every second, which rebuilt media /
  // mediaDetailsMap / settingsMap and re-ran the MediaDetailsDialog
  // `selectedDetails` effect (~4000 reassignments per shard). Progress-only
  // frames are now held while the window is hidden and the latest snapshot
  // is pushed once on show. Progress itself still persists every save.
  describe("progress-only frames while the app window is hidden (@bugfix @regression-proof issue #25 P1)", () => {
    const LOG = "[write-churn:hidden-p1]";
    const hide = () => markAppWindowVisibility(windowMock as never, true, "external-mpv-hide");
    const show = () => markAppWindowVisibility(windowMock as never, false, "external-mpv-show");
    // The visibility flag is module state keyed by the shared mock window:
    // a failed assertion must not leave later tests' pushes held.
    afterEach(() => {
      show();
    });

    it("10 hidden progress saves send 0 snapshots to the renderer, persist every save, and push the latest once on show", async () => {
      await setup({ frameDelivery: "before-response" });
      await setProgress(1);
      await vi.waitFor(() => expect(lastSentProgress()).toBe("1"));
      const visibleSends = snapshotSends().length;
      console.info(`${LOG} visible baseline sends=${visibleSends}`);

      hide();
      webContentsSendMock.mockClear();
      for (let pct = 2; pct <= 11; pct += 1) {
        await setProgress(pct);
        // Past the 200 ms emit throttle so a trailing-edge flush would fire.
        await settle(220);
      }
      const hiddenSends = snapshotSends().length;
      const cached = (await call("sf-library-db-call", { method: "getSnapshot" })) as Record<string, unknown>;
      const persisted = (cached.settings as Record<string, { value: string }>).progress.value;
      console.info(
        `${LOG} hidden: writes=10 calls=${runtime.counters.calls} frames=${runtime.counters.framesPublished} rendererSends=${hiddenSends} cachedProgress=${persisted} counters=${JSON.stringify(runtime.counters)}`
      );
      expect(runtime.counters.framesPublished).toBeGreaterThanOrEqual(10);
      expect(persisted).toBe("11");
      expect(hiddenSends).toBe(0);

      show();
      await settle(20);
      const onShow = snapshotSends();
      console.info(`${LOG} on show: sends=${onShow.length} progress=${String(lastSentProgress())} version=${String(onShow.at(-1)?.[1]?.version)}`);
      expect(onShow).toHaveLength(1);
      expect(lastSentProgress()).toBe("11");
      expect(onShow[0][1].version).toBe(runtime.getVersion());

      // Visible again: progress frames reach the renderer as before.
      await settle(220);
      await setProgress(12);
      await vi.waitFor(() => expect(lastSentProgress()).toBe("12"));
      // A second show with nothing held sends nothing extra.
      hide();
      const beforeReshow = snapshotSends().length;
      show();
      await settle(20);
      expect(snapshotSends().length).toBe(beforeReshow);
    });

    it("a non-progress frame while hidden still reaches the renderer (only progress-only frames are held)", async () => {
      await setup({ frameDelivery: "before-response" });
      hide();
      await setProgress(30);
      await settle(220);
      expect(snapshotSends()).toHaveLength(0);
      runtime.publishFrame(runtime.bumpVersion(), "commit:job-1", runtime.snapshotJson());
      await settle(20);
      const sends = snapshotSends();
      console.info(`${LOG} hidden commit frame: sends=${sends.length} progress=${String(lastSentProgress())}`);
      expect(sends).toHaveLength(1);
      expect(lastSentProgress()).toBe("30");
      expect(sends[0][1].version).toBe(runtime.getVersion());
      // The held progress frame was carried by that emit: show adds nothing.
      show();
      await settle(20);
      expect(snapshotSends()).toHaveLength(1);
    });
  });

  const measure = process.env.SF_MEASURE_PLAYBACK_MINUTE === "1";
  it.runIf(measure)(
    "MEASURE: playback minute — 120 setProgress writes at 500 ms over a ~1 MB snapshot",
    async () => {
      await setup({ frameDelivery: "before-response", snapshotBytes: 1_000_000 });
      const writes = 120;
      const cadenceMs = 500;
      const cpuStart = process.cpuUsage();
      const wallStart = Date.now();
      for (let i = 0; i < writes; i += 1) {
        const tickStart = Date.now();
        await setProgress(i);
        const spent = Date.now() - tickStart;
        await settle(Math.max(0, cadenceMs - spent));
      }
      await settle(300);
      const cpu = process.cpuUsage(cpuStart);
      const wallMs = Date.now() - wallStart;
      const c = runtime.counters;
      const report = {
        writes,
        wallMs,
        snapshotBytes: runtime.staticBytes,
        snapshotFetches: c.snapshotFetches,
        snapshotFetchesPerWrite: c.snapshotFetches / writes,
        statusCalls: c.statusCalls,
        frameBytes: c.frameBytes,
        snapshotFetchBytes: c.snapshotFetchBytes,
        bytesPerWrite: Math.round((c.frameBytes + c.snapshotFetchBytes) / writes),
        rendererSends: snapshotSends().length,
        mainCpuMs: Math.round((cpu.user + cpu.system) / 1000),
        mainCpuPct: Number((((cpu.user + cpu.system) / 1000 / wallMs) * 100).toFixed(1)),
      };
      console.info(`[write-churn:MEASURE] ${JSON.stringify(report)}`);
      if (process.env.SF_MEASURE_OUT) appendFileSync(process.env.SF_MEASURE_OUT, `${JSON.stringify(report)}\n`);
      expect(lastSentProgress()).toBe(String(writes - 1));
    },
    180_000
  );
});
