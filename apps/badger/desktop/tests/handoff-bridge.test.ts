/**
 * PLAT-WEB-05: the desktop's web player hand-off bridge (main/handoffIpc.ts). It subscribes to `badger.handoff`,
 * plays in a window it never shows, and reports the playback to the runtime: starting → playing (≤ 1/s) → closed
 * with the last position, or failed. A plain playback's exit is untouched (tests/external-mpv-handoff-window.test.ts).
 */
import type { BrowserWindow } from "electron";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
  HANDOFF_IPC,
  HANDOFF_PENDING_TTL_MS,
  HandoffRuntimeBridge,
  registerHandoffIpc,
} from "../src/main/handoffIpc";
import { DESKTOP_HANDOFF_CHANNEL, DESKTOP_HANDOFF_PLAY_EVENT } from "@space/tool-access/contracts";

type Frame = { event: string; payload: unknown };

type FakeSession = {
  getToken: () => Promise<string>;
  invalidate: Mock<() => void>;
  reset: () => void;
  setBackendToken: (token: string) => void;
  getBackendToken: () => string;
};

const fakeSession = (): FakeSession => ({
  getToken: async () => "app-session-token",
  invalidate: vi.fn(() => undefined),
  reset: () => undefined,
  setBackendToken: () => undefined,
  getBackendToken: () => "backend",
});

type StreamOptions = { channels?: string[]; apps?: string[] };

type FakeStreams = {
  createStream: Mock<(options: StreamOptions) => unknown>;
  created: StreamOptions[];
  /** Shared by every stream the bridge creates. */
  stop: Mock<() => void>;
  emit: (frame: Frame) => void;
};

const fakeStreams = (): FakeStreams => {
  const subscribers: Array<(frame: Frame) => void> = [];
  const created: StreamOptions[] = [];
  const stop = vi.fn(() => undefined);
  const createStream = vi.fn((options: StreamOptions) => {
    created.push(options);
    return {
      subscribe: (listener: (frame: Frame) => void) => {
        subscribers.push(listener);
        return () => undefined;
      },
      start: async () => undefined,
      stop,
    };
  });
  return { createStream, created, stop, emit: (frame) => subscribers.forEach((s) => s(frame)) };
};

type FakeWindow = {
  win: {
    destroyed: boolean;
    visible: boolean;
    show: Mock<() => void>;
    isDestroyed: () => boolean;
    isVisible: () => boolean;
    webContents: { isLoading: () => boolean; send: (channel: string, payload: unknown) => void };
  };
  sent: Array<{ channel: string; payload: unknown }>;
  asWindow: BrowserWindow;
};

const fakeWindow = (options: { loading?: boolean } = {}): FakeWindow => {
  const sent: FakeWindow["sent"] = [];
  const win: FakeWindow["win"] = {
    destroyed: false,
    visible: false,
    show: vi.fn(),
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    webContents: {
      isLoading: () => options.loading === true,
      send: (channel, payload) => {
        sent.push({ channel, payload });
      },
    },
  };
  return { win, sent, asWindow: win as unknown as BrowserWindow };
};

type Reported = { url: string; body: Record<string, unknown> };

type Harness = {
  bridge: HandoffRuntimeBridge;
  reports: Reported[];
  fetchImpl: Mock<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>;
  stream: FakeStreams;
  sessions: FakeSession[];
  existing: FakeWindow | null;
  recreated: FakeWindow;
  ensureHiddenWindow: Mock<() => BrowserWindow>;
  advance: (ms: number) => void;
};

const harness = (options: { window?: FakeWindow | null; loading?: boolean; status?: number[] } = {}): Harness => {
  let now = 1_000_000;
  const reports: Reported[] = [];
  const statuses = [...(options.status ?? [])];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    reports.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true }), { status: statuses.shift() ?? 200 });
  });
  const stream = fakeStreams();
  const sessions: FakeSession[] = [];
  const existing = options.window === undefined ? fakeWindow({ loading: options.loading }) : options.window;
  const recreated = fakeWindow();
  const ensureHiddenWindow = vi.fn(() => recreated.asWindow);
  const bridge = new HandoffRuntimeBridge({
    getWindow: () => existing?.asWindow ?? null,
    ensureHiddenWindow,
    runtimeBaseUrl: "http://127.0.0.1:3020/",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    createSession: (() => {
      const session = fakeSession();
      sessions.push(session);
      return session;
    }) as never,
    createStream: stream.createStream as never,
    now: () => now,
  });
  return {
    bridge,
    reports,
    fetchImpl,
    stream,
    sessions,
    existing,
    recreated,
    ensureHiddenWindow,
    advance: (ms) => {
      now += ms;
    },
  };
};

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const dump = (label: string, value: unknown) => console.info(`[handoff-bridge:${label}] state`, JSON.stringify(value));

const play = (h: Harness, handoffId = "h-1", mediaId = "m-1") =>
  h.stream.emit({ event: DESKTOP_HANDOFF_PLAY_EVENT, payload: { handoffId, mediaId, requestedAt: new Date(0).toISOString() } });

describe("HandoffRuntimeBridge", () => {
  // @req PLAT-WEB-05
  it("subscribes to badger.handoff with a badger app session, plays in the hidden window, reports starting", async () => {
    console.info("[handoff-bridge:play] phase: sign in");
    const h = harness();
    h.bridge.setAuthToken("backend-token");
    expect(h.stream.created).toEqual([expect.objectContaining({ channels: [DESKTOP_HANDOFF_CHANNEL], apps: ["badger"] })]);

    console.info("[handoff-bridge:play] phase: runtime sends play");
    play(h);
    await settle();
    dump("play", { sent: h.existing?.sent, reports: h.reports, visible: h.existing?.win.visible });
    expect(h.existing?.sent).toEqual([{ channel: HANDOFF_IPC.play, payload: { handoffId: "h-1", mediaId: "m-1" } }]);
    expect(h.existing?.win.show).not.toHaveBeenCalled();
    expect(h.ensureHiddenWindow).not.toHaveBeenCalled();
    expect(h.reports).toEqual([{ url: "http://127.0.0.1:3020/runtime/handoff/h-1/state", body: { state: "starting" } }]);
    expect(h.bridge.isHandoffPlayback()).toBe(true);
  });

  // @req PLAT-WEB-05
  it("recreates a destroyed window hidden and ignores malformed frames", async () => {
    const destroyed = fakeWindow();
    destroyed.win.destroyed = true;
    const h = harness({ window: destroyed });
    h.bridge.setAuthToken("backend-token");
    console.info("[handoff-bridge:recreate] phase: malformed frame");
    h.stream.emit({ event: DESKTOP_HANDOFF_PLAY_EVENT, payload: { mediaId: "m-1" } });
    h.stream.emit({ event: "something.else", payload: { handoffId: "x", mediaId: "y", requestedAt: "z" } });
    await settle();
    expect(h.reports).toEqual([]);

    console.info("[handoff-bridge:recreate] phase: play with the window destroyed");
    play(h);
    await settle();
    dump("recreate", { recreatedSent: h.recreated.sent, reports: h.reports });
    expect(h.ensureHiddenWindow).toHaveBeenCalledTimes(1);
    expect(h.recreated.sent).toHaveLength(1);
    expect(h.recreated.win.show).not.toHaveBeenCalled();
    expect(h.reports.map((r) => r.body.state)).toEqual(["starting"]);
  });

  // @req PLAT-WEB-04 @req PLAT-WEB-05
  it("reports playing at most once a second, then closed with the last position on mpv exit", async () => {
    const h = harness();
    h.bridge.setAuthToken("backend-token");
    play(h);
    await settle();
    console.info("[handoff-bridge:progress] phase: mpv launches and pushes properties");
    h.bridge.onPlaybackLaunched();
    h.bridge.onPlaybackProperty("duration", 5400);
    h.bridge.onPlaybackProperty("time-pos", 120);
    h.advance(300);
    h.bridge.onPlaybackProperty("time-pos", 120.3);
    h.advance(300);
    h.bridge.onPlaybackProperty("time-pos", 120.6);
    h.advance(500);
    h.bridge.onPlaybackProperty("time-pos", 121.1);
    h.bridge.onPlaybackProperty("time-pos", Number.NaN);
    h.bridge.onPlaybackProperty("time-pos", 121.4);
    await settle();
    console.info("[handoff-bridge:progress] phase: mpv exits");
    h.bridge.onPlaybackClosed("mpv_exit");
    await settle();
    dump("progress", h.reports.map((r) => r.body));
    expect(h.reports.map((r) => r.body)).toEqual([
      { state: "starting" },
      { state: "playing", positionSeconds: 120, durationSeconds: 5400 },
      { state: "playing", positionSeconds: 121.1, durationSeconds: 5400 },
      { state: "closed", positionSeconds: 121.4, durationSeconds: 5400 },
    ]);
    expect(h.bridge.isHandoffPlayback()).toBe(false);

    console.info("[handoff-bridge:progress] phase: a later plain playback is not reported");
    h.bridge.onPlaybackLaunched();
    h.bridge.onPlaybackProperty("time-pos", 5);
    h.bridge.onPlaybackClosed("mpv_exit");
    await settle();
    expect(h.reports).toHaveLength(4);
  });

  // @req PLAT-WEB-05
  it("ignores the stop of the playback it replaces (before its own mpv launched)", async () => {
    const h = harness();
    h.bridge.setAuthToken("backend-token");
    play(h);
    await settle();
    console.info("[handoff-bridge:replace] phase: old playback torn down before the hand-off's mpv");
    h.bridge.onPlaybackClosed("renderer_stop");
    await settle();
    dump("replace", { reports: h.reports.map((r) => r.body), active: h.bridge.isHandoffPlayback() });
    expect(h.reports.map((r) => r.body.state)).toEqual(["starting"]);
    expect(h.bridge.isHandoffPlayback()).toBe(true);
    h.bridge.onPlaybackLaunched();
    h.bridge.onPlaybackClosed("renderer_stop");
    await settle();
    expect(h.reports.map((r) => r.body.state)).toEqual(["starting", "closed"]);
  });

  // @req PLAT-WEB-05
  it("a newer play supersedes the active one; a renderer failure reports failed with the error", async () => {
    const h = harness();
    h.bridge.setAuthToken("backend-token");
    play(h, "h-1", "m-1");
    await settle();
    play(h, "h-2", "m-2");
    await settle();
    console.info("[handoff-bridge:fail] phase: renderer reports the newer play failed");
    await h.bridge.reportRendererFailure("h-2", "media_not_found");
    dump("fail", h.reports);
    expect(h.reports.map((r) => [r.url.split("/").at(-2), r.body])).toEqual([
      ["h-1", { state: "starting" }],
      ["h-2", { state: "starting" }],
      ["h-2", { state: "failed", error: "media_not_found" }],
    ]);
    expect(h.bridge.isHandoffPlayback()).toBe(false);
  });

  // @req PLAT-WEB-05
  it("hands a play sent while the page was loading to the renderer once, through sf-handoff-pending", async () => {
    const h = harness({ loading: true });
    h.bridge.setAuthToken("backend-token");
    play(h);
    await settle();
    dump("pending", { sent: h.existing?.sent });
    expect(h.existing?.sent).toEqual([]);
    expect(h.bridge.takePending()).toEqual({ handoffId: "h-1", mediaId: "m-1" });
    expect(h.bridge.takePending()).toBeNull();

    console.info("[handoff-bridge:pending] phase: an old undelivered play is dropped");
    play(h, "h-2", "m-2");
    await settle();
    h.advance(HANDOFF_PENDING_TTL_MS + 1);
    expect(h.bridge.takePending()).toBeNull();
  });

  it("logs in again once when the runtime answers 401, and stops on sign-out", async () => {
    const h = harness({ status: [401, 200] });
    h.bridge.setAuthToken("backend-token");
    play(h);
    await settle();
    dump("401", { calls: h.fetchImpl.mock.calls.length, invalidated: h.sessions[0]?.invalidate.mock.calls.length });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.sessions[0]?.invalidate).toHaveBeenCalledTimes(1);

    h.bridge.setAuthToken(null);
    expect(h.stream.stop).toHaveBeenCalledTimes(1);
  });

  it("registerHandoffIpc validates sf-handoff-failed and answers sf-handoff-pending", async () => {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    const ipc = { handle: (channel: string, fn: (event: unknown, payload?: unknown) => unknown) => handlers.set(channel, fn) };
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const bridge = registerHandoffIpc(ipc as never, {
      getWindow: () => null,
      ensureHiddenWindow: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createSession: fakeSession as never,
      createStream: fakeStreams().createStream as never,
    });
    bridge.setAuthToken("backend-token");
    expect([...handlers.keys()].sort()).toEqual([HANDOFF_IPC.failed, HANDOFF_IPC.pending].sort());
    expect(await handlers.get(HANDOFF_IPC.failed)?.({}, { error: "x" })).toEqual({ ok: false });
    expect(await handlers.get(HANDOFF_IPC.failed)?.({}, { handoffId: "h-9", error: "launch_timeout" })).toEqual({ ok: true });
    expect(await handlers.get(HANDOFF_IPC.pending)?.({})).toBeNull();
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    dump("ipc", body);
    expect(body).toEqual({ state: "failed", error: "launch_timeout" });
  });
});
