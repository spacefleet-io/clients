/**
 * Phase 6 — Direct runtime library SSE subscription + version IPC exposure.
 *
 * Closes the residual structural gap that left Phase 3B's play-button gate
 * inert in production: desktop main was dropping the `version` field at
 * `libraryDbRuntimeProxy.ts:65` (sent only `cachedSnapshot`, not the
 * `{snapshot, version}` shape) AND had no subscription to the runtime's
 * library SSE channel — commit-step writes (which happen inside the
 * runtime, bypassing desktop IPC) only reached the renderer via the API
 * server's `/library/db/stream` 8-10 s round-trip.
 *
 * Plan reference: we-ve-done-quite-a-immutable-dahl.md (Phase 6).
 *
 * Coverage in this file:
 *   - `parseSnapshotIpcPayload`: round-trips the new `{snapshot, version}`
 *     shape AND the legacy bare-snapshot shape (back-compat for older
 *     preload bundles in the field).
 *   - Desktop main proxy: emits the new wrapper shape on
 *     `sf-library-db-snapshot`, including the version captured from
 *     `badger.db.status` at db-open time.
 *   - Desktop main proxy: a simulated `badger.library.updated` SSE frame
 *     drives a snapshot refresh + push, with the latest version stamped
 *     onto the IPC payload.
 *   - Phase 3B gate effectiveness end-to-end: with a non-undefined
 *     `currentLibraryVersion < libraryVersionAtDone`, the gate disables
 *     play; with `>=`, it enables. Pre-Phase-6 these always passed
 *     trivially because `currentLibraryVersion` was always undefined.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseSnapshotIpcPayload,
} from "../src/renderer/src/lib/libraryContext";
import { isLibraryVersionPending } from "../src/renderer/src/lib/runtimeIngestJobs";

// ---------------------------------------------------------------------------
// Diagnostic-logging helpers (per the tests-log-generously convention).
// Suite id: library-version-ipc. Phase markers: `[library-version-ipc:<phase>]`.
// dumpLibraryVersionIpcSnapshot prints the state useful when an assertion
// inside this file fails — IPC payloads pushed to the renderer, the captured
// SSE subscriber state, login/command fetch traffic.
// ---------------------------------------------------------------------------

const dumpLibraryVersionIpcSnapshot = (
  label: string,
  extra: Record<string, unknown> = {},
) => {
  try {
    const sendCalls = webContentsSendMock.mock.calls.map((args) => ({
      channel: args[0],
      payload: args[1],
    }));
     
    console.log(
      `[library-version-ipc:dump] ${label}`,
      JSON.stringify(
        {
          sendCallCount: sendCalls.length,
          sendCalls,
          eventStreamStartCalls: eventStreamStartMock.mock.calls.length,
          eventStreamStopCalls: eventStreamStopMock.mock.calls.length,
          capturedFrameSubscriberPresent: Boolean(capturedFrameSubscriber),
          setLibraryDbAccessorTokenCalls:
            setLibraryDbAccessorTokenMock.mock.calls.length,
          ...extra,
        },
        null,
        2,
      ),
    );
  } catch (dumpError) {
     
    console.log(`[library-version-ipc:dump-error] ${label}`, dumpError);
  }
};

// ---------------------------------------------------------------------------
// Pure helper: parseSnapshotIpcPayload
// ---------------------------------------------------------------------------

describe("parseSnapshotIpcPayload @bugfix @regression-proof", () => {
  it("parses the Phase-6 `{ snapshot, version }` wrapper shape", () => {
    const result = parseSnapshotIpcPayload({
      snapshot: { media: [{ id: "m1" }], playlists: [] },
      version: 1923,
    });
    expect(result).not.toBeNull();
    expect(result?.snapshot.media).toHaveLength(1);
    expect(result?.version).toBe(1923);
  });

  it("returns version=undefined when the wrapper omits version (older main)", () => {
    const result = parseSnapshotIpcPayload({
      snapshot: { media: [], playlists: [] },
    });
    expect(result).not.toBeNull();
    expect(result?.version).toBeUndefined();
  });

  it("falls back to legacy bare-snapshot shape (older preload still in field)", () => {
    // Pre-Phase-6 preloads forwarded the bare LibrarySnapshot. The
    // renderer must keep accepting that shape so a half-upgraded build
    // (new renderer + old preload, e.g. mid-rollout) keeps rendering.
    const result = parseSnapshotIpcPayload({
      media: [{ id: "m1" }],
      playlists: [],
      version: 42, // legacy snapshots could carry version inline too
    });
    expect(result).not.toBeNull();
    expect(result?.snapshot.media).toHaveLength(1);
    // Legacy shape has no out-of-band version — renderer falls through.
    expect(result?.version).toBeUndefined();
  });

  it("returns null for an empty payload (defensive)", () => {
    expect(parseSnapshotIpcPayload(null)).toBeNull();
    expect(parseSnapshotIpcPayload(undefined)).toBeNull();
    expect(parseSnapshotIpcPayload({})).toBeNull();
  });

  it("returns null for a payload with neither shape's discriminator", () => {
    // No `.snapshot` property AND no `.media` array → unknown shape.
    expect(parseSnapshotIpcPayload({ foo: "bar" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 3B gate effectiveness with a real currentLibraryVersion
// ---------------------------------------------------------------------------

describe("isLibraryVersionPending — Phase 3B gate effective with Phase 6 version @bugfix @regression-proof", () => {
  it("currentVersion < libraryVersionAtDone, fresh doneAt → DISABLED (Phase-6-fixed race window)", () => {
    // Pre-Phase-6 this assertion was never tripped in production because
    // `currentLibraryVersion` was always undefined. With the IPC version
    // wired, the gate disables during the race window — provided the
    // succeeded event landed recently enough (Phase-7 timeout fallback).
    const now = 1_000_000;
    expect(
      isLibraryVersionPending(
        { libraryVersionAtDone: 1923, libraryVersionDoneAt: now },
        1922,
        now,
      ),
    ).toBe(true);
  });

  it("currentVersion === libraryVersionAtDone → enabled (renderer caught up)", () => {
    expect(
      isLibraryVersionPending({ libraryVersionAtDone: 1923 }, 1923),
    ).toBe(false);
  });

  it("currentVersion > libraryVersionAtDone → enabled (renderer ahead)", () => {
    expect(
      isLibraryVersionPending({ libraryVersionAtDone: 1923 }, 1924),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Desktop main proxy — IPC payload shape + library SSE subscription
// ---------------------------------------------------------------------------

const setLibraryDbAccessorTokenMock = vi.hoisted(() => vi.fn());
const webContentsSendMock = vi.hoisted(() => vi.fn());
const windowMock = vi.hoisted(() => ({
  webContents: {
    send: webContentsSendMock,
    once: vi.fn(),
  },
  isDestroyed: () => false,
  once: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../src/main/libraryDbAccessor", () => ({
  setLibraryDbAccessorToken: (...args: unknown[]) => setLibraryDbAccessorTokenMock(...args),
}));

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Capture the event-stream subscriber so the test can drive synthetic
// `badger.library.updated` frames and observe the resulting snapshot push.
let capturedFrameSubscriber: ((frame: unknown) => void) | null = null;
const eventStreamStartMock = vi.hoisted(() => vi.fn(async () => undefined));
const eventStreamStopMock = vi.hoisted(() => vi.fn());

vi.mock("@space/runtime-client/events", () => ({
  createRuntimeEventStream: vi.fn(() => {
    return {
      start: eventStreamStartMock,
      stop: eventStreamStopMock,
      subscribe: (listener: (frame: unknown) => void) => {
        capturedFrameSubscriber = listener;
        return () => {
          capturedFrameSubscriber = null;
        };
      },
    };
  }),
}));

process.env.SF_RUNTIME_BASE_URL = "http://mock-runtime:3020";

import {
  registerLibraryDbRuntimeProxy,
  resetLibraryDbRuntimeProxyForTests,
} from "../src/main/libraryDbRuntimeProxy";

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;

const createIpcHarness = () => {
  const handlers = new Map<string, IpcHandler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  };
  return { ipc, handlers };
};

// Mock the runtime HTTP API: returns a snapshot whose version increments
// on each fetch so successive emits aren't deduped.
const createFetchMock = () => {
  let snapshotVersion = 100;
  const buildSnapshot = (): Record<string, unknown> => ({
    media: [{ id: "m1", title: "Phase 6 Test" }],
    playlists: [],
    version: ++snapshotVersion,
  });
  const buildStatus = (): Record<string, unknown> => ({
    open: true,
    version: snapshotVersion,
    datasetStatus: { core: true, metadata: true, playback: true },
  });
  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      body = {};
    }
    if (urlStr.includes("/runtime/session/login")) {
      return new Response(
        JSON.stringify({
          ok: true,
          token: "rt-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          capabilities: { apps: ["badger"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.includes("/modules/badger/commands")) {
      const command = (body as { command?: string })?.command ?? "";
      if (command === "badger.db.open") {
        return new Response(
          JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (command === "badger.db.snapshot") {
        return new Response(
          JSON.stringify({ requestId: "r", ok: true, result: buildSnapshot(), error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (command === "badger.db.status") {
        return new Response(
          JSON.stringify({ requestId: "r", ok: true, result: buildStatus(), error: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ requestId: "r", ok: true, result: {}, error: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  return { mockFetch };
};

describe("libraryDbRuntimeProxy IPC payload + library SSE subscription @bugfix @regression-proof", () => {
  let handlers: Map<string, IpcHandler>;

  beforeEach(async () => {
     
    console.log("[library-version-ipc:beforeEach] resetting proxy + mocks");
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    setLibraryDbAccessorTokenMock.mockReset();
    webContentsSendMock.mockReset();
    eventStreamStartMock.mockReset();
    eventStreamStopMock.mockReset();
    capturedFrameSubscriber = null;

    const harness = createIpcHarness();
    handlers = harness.handlers;

    const fetchCtrl = createFetchMock();
    vi.stubGlobal("fetch", fetchCtrl.mockFetch);

    registerLibraryDbRuntimeProxy(harness.ipc as never, () => windowMock as never);
     
    console.log(
      `[library-version-ipc:beforeEach:registered] handlers=${handlers.size}`,
    );
  });

  const callHandler = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  };

  it("emits the `{ snapshot, version }` wrapper on `sf-library-db-snapshot`", async () => {
    try {
       
      console.log("[library-version-ipc:wrapper-shape] calling sf-library-db-open");
      await callHandler("sf-library-db-open", { token: "t", keyBase64: "k" });
       
      console.log(
        `[library-version-ipc:wrapper-shape:asserting] sendCalls=${webContentsSendMock.mock.calls.length}`,
      );
      expect(webContentsSendMock).toHaveBeenCalledWith(
        "sf-library-db-snapshot",
        expect.objectContaining({
          snapshot: expect.objectContaining({ media: expect.any(Array) }),
          version: expect.any(Number),
        }),
      );
    } catch (assertionError) {
      dumpLibraryVersionIpcSnapshot("wrapper-shape:fail");
      throw assertionError;
    }
  });

  it("captures version from `badger.db.status` at open time", async () => {
    try {
       
      console.log("[library-version-ipc:version-capture] calling sf-library-db-open");
      await callHandler("sf-library-db-open", { token: "t", keyBase64: "k" });
      // `createFetchMock` sets initial snapshotVersion=101 after first fetch
      // (the buildStatus returns the post-increment value). The IPC payload
      // must carry a numeric version, not undefined.
      const [, payload] = webContentsSendMock.mock.calls[0]!;
       
      console.log(
        `[library-version-ipc:version-capture:asserting] payloadVersion=${
          (payload as { version?: unknown }).version
        }`,
      );
      expect(typeof (payload as { version?: unknown }).version).toBe("number");
    } catch (assertionError) {
      dumpLibraryVersionIpcSnapshot("version-capture:fail");
      throw assertionError;
    }
  });

  it("starts the runtime library event stream on db-open", async () => {
    try {
       
      console.log("[library-version-ipc:stream-start] calling sf-library-db-open");
      await callHandler("sf-library-db-open", { token: "t", keyBase64: "k" });
       
      console.log(
        `[library-version-ipc:stream-start:asserting] startCalls=${eventStreamStartMock.mock.calls.length} subscriberPresent=${Boolean(capturedFrameSubscriber)}`,
      );
      expect(eventStreamStartMock).toHaveBeenCalled();
      expect(capturedFrameSubscriber).toBeTruthy();
    } catch (assertionError) {
      dumpLibraryVersionIpcSnapshot("stream-start:fail");
      throw assertionError;
    }
  });

  it("a synthetic `badger.library.updated` SSE frame drives a snapshot refresh + push", async () => {
    try {
       
      console.log("[library-version-ipc:sse-refresh] opening DB");
      await callHandler("sf-library-db-open", { token: "t", keyBase64: "k" });
      expect(capturedFrameSubscriber).toBeTruthy();

       
      console.log("[library-version-ipc:sse-refresh] clearing send-mock");
      webContentsSendMock.mockClear();

      // Drive a synthetic SSE frame as if the runtime had emitted one. The
      // proxy must (a) capture the new version and (b) refresh + push the
      // snapshot to the renderer with the new version stamped onto the
      // IPC payload.
       
      console.log("[library-version-ipc:sse-refresh] pushing synthetic SSE frame v=9999");
      capturedFrameSubscriber!({
        eventId: "evt-1",
        sequence: 1,
        app: "badger",
        channel: "badger.library",
        event: "badger.library.updated",
        ts: new Date().toISOString(),
        payload: {
          version: 9999,
          reason: "commit:job-abc",
          mediaCount: 1,
          playlistCount: 0,
        },
      });

       
      console.log("[library-version-ipc:sse-refresh] waiting for refreshed snapshot push");
      await vi.waitFor(() => {
        expect(webContentsSendMock).toHaveBeenCalledWith(
          "sf-library-db-snapshot",
          expect.objectContaining({
            version: 9999,
          }),
        );
      });
    } catch (assertionError) {
      dumpLibraryVersionIpcSnapshot("sse-refresh:fail");
      throw assertionError;
    }
  });

  it("ignores frames for non-library events (defensive)", async () => {
    try {
       
      console.log("[library-version-ipc:sse-ignore] opening DB");
      await callHandler("sf-library-db-open", { token: "t", keyBase64: "k" });
      webContentsSendMock.mockClear();

       
      console.log("[library-version-ipc:sse-ignore] pushing unrelated event");
      capturedFrameSubscriber!({
        eventId: "evt-1",
        sequence: 1,
        app: "badger",
        channel: "badger.library",
        event: "badger.unrelated",
        ts: new Date().toISOString(),
        payload: { foo: "bar" },
      });

      // Wait briefly to confirm no emit happens.
       
      console.log("[library-version-ipc:sse-ignore] sleeping 50ms for any unwanted push");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(webContentsSendMock).not.toHaveBeenCalled();
    } catch (assertionError) {
      dumpLibraryVersionIpcSnapshot("sse-ignore:fail");
      throw assertionError;
    }
  });

  it("tears down the event stream when the local cache is cleared (logout path)", async () => {
    try {
       
      console.log("[library-version-ipc:stream-stop] opening DB");
      await callHandler("sf-library-db-open", { token: "t", keyBase64: "k" });
      expect(eventStreamStartMock).toHaveBeenCalled();

       
      console.log("[library-version-ipc:stream-stop] clearing local cache");
      await callHandler("sf-library-db-clear-local-cache");
       
      console.log(
        `[library-version-ipc:stream-stop:asserting] stopCalls=${eventStreamStopMock.mock.calls.length}`,
      );
      expect(eventStreamStopMock).toHaveBeenCalled();
    } catch (assertionError) {
      dumpLibraryVersionIpcSnapshot("stream-stop:fail");
      throw assertionError;
    }
  });
});
