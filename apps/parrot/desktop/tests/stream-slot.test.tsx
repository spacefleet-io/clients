// @vitest-environment jsdom
/**
 * PARROT-DESKTOP-STREAM-SLOT-001
 * @level integration (main-side gate with a fake `fetch` speaking the API's answers; the real Library shell, player
 * bar and prompt with `window.parrot` mocked; real translator)
 * @req ACCT-STREAM-01[parrot]
 * @req ACCT-STREAM-02[parrot]
 * @req ACCT-STREAM-03[parrot]
 * @req ACCT-STREAM-04[parrot]
 *
 * The account's stream limit on Parrot desktop: a streamed song asks for a place first (app `parrot`, the playing
 * profile), a kept song never asks, at the limit the window asks "Already playing on {device}. Play here instead?"
 * (Play here takes over, Cancel changes nothing and closes the player), a heartbeat answered "taken over" pauses and
 * says "Playing on {device} now", and stopping gives the place back.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSlotText, type StreamSlotAnswer, type StreamSlotGateState } from "@space/stream-slots";
import type { ParrotState } from "../src/shared/ipc";
import { createDesktopStreamSlots } from "../src/main/streamSlot";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";
import { streamBridgeStub, type StreamBridgeStub } from "./streamBridge";

const SUITE = "[PARROT-DESKTOP-STREAM-SLOT-001]";
const API = "http://api.test";

type Call = { method: string; url: string; body: unknown; auth: string | null };

type Reply = { status: number; body: unknown };
type FakeApi = { calls: Call[]; starts: Reply[]; beats: Reply[]; fetch: typeof globalThis.fetch };

/** A fake API: records each request and answers from a queue per route. */
const fakeApi = (): FakeApi => {
  const calls: Call[] = [];
  const starts: Reply[] = [];
  const beats: Reply[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, url, body, auth });
    let reply: Reply = { status: 204, body: null };
    if (method === "POST" && url.endsWith("/playback/streams")) reply = starts.shift() ?? { status: 500, body: { error: "no start reply queued" } };
    else if (url.endsWith("/heartbeat")) reply = beats.shift() ?? { status: 200, body: { expiresInSeconds: 60 } };
    console.info(`${SUITE} api ${method} ${url} ${JSON.stringify(body)} -> ${reply.status} ${JSON.stringify(reply.body)}`);
    return new Response(reply.body === null ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls, starts, beats, fetch: fetch as unknown as typeof globalThis.fetch };
};

const started = (streamId: string) => ({
  status: 201,
  body: { streamId, profileId: "p-main", heartbeatIntervalSeconds: 20, expiresInSeconds: 60 },
});
const atLimit = {
  status: 409,
  body: {
    error: "stream_limit",
    limit: 1,
    playingOn: [{ streamId: "s-old", deviceName: "Living room TV", deviceType: "tv", app: "badger", kind: "play", startedAt: "2026-11-11T08:00:00.000Z" }],
  },
};

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("Parrot desktop: the main-side stream place", () => {
  const states: StreamSlotGateState[] = [];
  const make = (api: FakeApi, kept: string[] = []) =>
    createDesktopStreamSlots({
      apiBaseUrl: API,
      token: () => "tok-1",
      profileId: async () => "p-kid",
      isKept: (trackId) => kept.includes(trackId),
      onState: (state) => {
        states.push(state);
        console.info(`${SUITE} state ${JSON.stringify(state)}`);
      },
      log: (line) => console.info(`${SUITE} ${line}`),
      fetch: api.fetch,
    });

  beforeEach(() => {
    states.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // @req ACCT-STREAM-01[parrot]
  // @req ACCT-STREAM-03[parrot]
  it("a streamed song asks for a place as app parrot with the playing profile; a kept song never asks", async () => {
    const api = fakeApi();
    const slots = make(api, ["t-kept"]);
    expect(await slots.acquire("t-kept")).toBe("play");
    console.info(`${SUITE} after kept song: ${api.calls.length} requests`);
    expect(api.calls).toHaveLength(0);

    api.starts.push(started("s-1"));
    expect(await slots.acquire("t-1")).toBe("play");
    console.info(`${SUITE} calls ${JSON.stringify(api.calls)}`);
    expect(api.calls[0]).toMatchObject({ method: "POST", url: `${API}/playback/streams`, auth: "Bearer tok-1" });
    expect(api.calls[0]!.body).toMatchObject({ app: "parrot", profileId: "p-kid", kind: "play" });
    expect(slots.state()).toEqual({ kind: "playing" });

    // The next song while the place is held reuses it: no second request.
    expect(await slots.acquire("t-2")).toBe("play");
    expect(api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/playback/streams"))).toHaveLength(1);
    await slots.release();
  });

  // @req ACCT-STREAM-02[parrot]
  it("at the limit it asks; Play here starts again with takeover, Cancel changes nothing", async () => {
    const api = fakeApi();
    const slots = make(api);
    api.starts.push(atLimit);
    const first = slots.acquire("t-1");
    await vi.waitFor(() => expect(slots.state().kind).toBe("asking"));
    console.info(`${SUITE} asking ${JSON.stringify(slots.state())}`);
    expect(slots.state()).toEqual({ kind: "asking", device: { deviceName: "Living room TV", deviceType: "tv" } });
    slots.answer("cancel");
    expect(await first).toBe("cancel");
    expect(slots.state()).toEqual({ kind: "idle" });
    expect(api.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);

    api.starts.push(atLimit, started("s-2"));
    const second = slots.acquire("t-1");
    await vi.waitFor(() => expect(slots.state().kind).toBe("asking"));
    slots.answer("playHere");
    expect(await second).toBe("play");
    const posts = api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/playback/streams"));
    console.info(`${SUITE} posts ${JSON.stringify(posts.map((call) => call.body))}`);
    expect(posts.at(-1)!.body).toMatchObject({ app: "parrot", takeover: true });
    expect(slots.state()).toEqual({ kind: "playing" });
    await slots.release();
  });

  // @req ACCT-STREAM-02[parrot]
  // @req ACCT-STREAM-04[parrot]
  it("heartbeats every 20 s; a taken-over answer tells the window; release gives the place back", async () => {
    const api = fakeApi();
    const slots = make(api);
    api.starts.push(started("s-3"));
    expect(await slots.acquire("t-1")).toBe("play");
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(api.calls.filter((call) => call.url.endsWith("/playback/streams/s-3/heartbeat"))).toHaveLength(1);

    api.beats.push({ status: 409, body: { error: "stream_taken_over", byDeviceName: "Kitchen phone", byDeviceType: "phone" } });
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    console.info(`${SUITE} states ${JSON.stringify(states)}`);
    expect(states.at(-1)).toEqual({ kind: "takenOver", device: { deviceName: "Kitchen phone", deviceType: "phone" } });
    slots.dismiss();
    expect(slots.state()).toEqual({ kind: "idle" });

    api.starts.push(started("s-4"));
    expect(await slots.acquire("t-2")).toBe("play");
    await slots.release();
    await settle();
    const deletes = api.calls.filter((call) => call.method === "DELETE").map((call) => call.url);
    console.info(`${SUITE} deletes ${JSON.stringify(deletes)}`);
    expect(deletes).toEqual([`${API}/playback/streams/s-4`]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls.filter((call) => call.url.endsWith("/playback/streams/s-4/heartbeat"))).toHaveLength(0);
  });
});

const state: ParrotState = {
  setup: { step: "errorReports", done: true, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: true,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
};
const library = {
  snapshotVersion: 1,
  artists: [{ id: "art-1", name: "Test Band", albumCount: 1, trackCount: 2 }],
  albums: [{ id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 2, coverUrl: null, coverThumbUrl: null }],
  tracks: ["Harbour", "Lantern"].map((title, index) => ({
    id: `t${index + 1}`,
    title,
    albumId: "alb-1",
    albumTitle: "First Light",
    artistId: "art-1",
    artistName: "Test Band",
    disc: 1,
    number: index + 1,
    durationMs: 180_000,
    fileId: `file-t${index + 1}`,
    mime: "audio/flac",
    sizeBytes: 1000,
  })),
};

describe("Parrot desktop: the window's question and the player", () => {
  let container: HTMLDivElement;
  let root: Root;
  const stateListeners = new Set<(next: StreamSlotGateState) => void>();
  const push = (next: StreamSlotGateState) => {
    for (const listener of [...stateListeners]) listener(next);
  };
  let bridge: StreamBridgeStub;
  let answerAcquire: (answer: "play" | "cancel") => void = () => undefined;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = async (id: string) => {
    await act(async () => q(id)[0]!.click());
    await flush();
  };
  const mount = async (language: "en" | "fr") => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const shown = { ...state, setup: { ...state.setup, language } };
    await act(async () => root.render(<Library t={translator(language)} state={shown} onState={() => undefined} />));
    await flush();
  };
  const show = async (next: StreamSlotGateState) => {
    await act(async () => push(next));
    await flush();
  };

  beforeEach(() => {
    localStorage.clear();
    bridge = streamBridgeStub();
    // The prompt's store subscribes once per window (module state), the player once per mount: one shared set.
    bridge.onStreamState.mockImplementation((listener: (next: StreamSlotGateState) => void) => {
      stateListeners.add(listener);
      return () => void stateListeners.delete(listener);
    });
    bridge.streamAcquire.mockImplementation(
      (trackId: string) =>
        new Promise<"play" | "cancel">((resolve) => {
          console.info(`${SUITE} window asks for a place for ${trackId}`);
          answerAcquire = resolve;
        })
    );
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...bridge,
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
        getImportScan: vi.fn(async () => null),
        getLyrics: vi.fn(async () => null),
        // A playing song without lyrics asks main for them, once (PAR-LYR-05).
        wantLyrics: vi.fn(async () => undefined),
        fetchLyrics: vi.fn(async () => ({ ok: true as const, outcome: "none" as const, lyrics: null })),
        onLyricsChanged: vi.fn(() => () => undefined),
        onLibraryChanged: vi.fn(() => () => undefined),
        onLibraryPatch: vi.fn(() => () => undefined),
        onImportStatus: vi.fn(() => () => undefined),
        getCoversWaiting: vi.fn(async () => []),
        onCoversWaiting: vi.fn(() => () => undefined),
        getImportJobs: vi.fn(async () => []),
        onImportJobs: vi.fn(() => () => undefined),
        dismissImportJob: vi.fn(async () => []),
        getBackgroundWork: vi.fn(async () => []),
        onBackgroundWork: vi.fn(() => () => undefined),
        getKept: vi.fn(async () => ({ entries: [], songs: [], downloading: false })),
        onKept: vi.fn(() => () => undefined),
        playbackUrl: vi.fn(async () => "blob:none"),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await show({ kind: "idle" });
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req ACCT-STREAM-01[parrot]
  // @req ACCT-STREAM-04[parrot]
  it("a song loads only once main gave it a place, and closing the player gives the place back", async () => {
    await mount("en");
    await click("home-resume");
    console.info(`${SUITE} acquire calls ${JSON.stringify(bridge.streamAcquire.mock.calls)}`);
    expect(bridge.streamAcquire).toHaveBeenCalledWith("t1");
    // The next song may be looked up ahead (gapless); the song itself waits for its place.
    expect(window.parrot.playbackUrl).not.toHaveBeenCalledWith("file-t1");
    await act(async () => answerAcquire("play"));
    await flush();
    expect(window.parrot.playbackUrl).toHaveBeenCalledWith("file-t1");
    act(() => root.unmount());
    root = createRoot(container);
    console.info(`${SUITE} release calls ${bridge.streamRelease.mock.calls.length}`);
    expect(bridge.streamRelease).toHaveBeenCalledTimes(1);
  });

  // @req ACCT-STREAM-02[parrot]
  it("asks 'Already playing on {device}. Play here instead?'; Cancel answers cancel and the song never loads", async () => {
    await mount("en");
    await click("home-resume");
    await show({ kind: "asking", device: { deviceName: "Living room TV", deviceType: "tv" } });
    const prompt = q("stream-slot-prompt")[0];
    console.info(`${SUITE} prompt ${prompt?.textContent}`);
    expect(prompt?.textContent).toContain("Already playing on Living room TV. Play here instead?");
    expect(q("stream-slot-play-here")[0]?.textContent).toBe("Play here");
    expect(q("stream-slot-cancel")[0]?.textContent).toBe("Cancel");
    await click("stream-slot-cancel");
    expect(bridge.streamAnswer).toHaveBeenCalledWith("cancel" satisfies StreamSlotAnswer);
    await act(async () => answerAcquire("cancel"));
    await show({ kind: "idle" });
    console.info(`${SUITE} after cancel: title=${q("player-title")[0]?.textContent ?? "none"}`);
    // The next song may be looked up ahead (gapless); the song itself waits for its place.
    expect(window.parrot.playbackUrl).not.toHaveBeenCalledWith("file-t1");
    expect(q("stream-slot-prompt")).toHaveLength(0);
    expect(bridge.streamRelease).not.toHaveBeenCalled();
  });

  // @req ACCT-STREAM-02[parrot]
  it("in French, Play here answers playHere; taken over, it pauses and says 'Playing on {device} now'", async () => {
    await mount("fr");
    await click("home-resume");
    await show({ kind: "asking", device: { deviceName: "Living room TV", deviceType: "tv" } });
    console.info(`${SUITE} fr prompt ${q("stream-slot-prompt")[0]?.textContent}`);
    expect(q("stream-slot-prompt")[0]?.textContent).toContain("Déjà en lecture sur Living room TV. Lire ici à la place ?");
    expect(q("stream-slot-cancel")[0]?.textContent).toBe("Annuler");
    await click("stream-slot-play-here");
    expect(bridge.streamAnswer).toHaveBeenCalledWith("playHere");
    await act(async () => answerAcquire("play"));
    await show({ kind: "playing" });
    expect(window.parrot.playbackUrl).toHaveBeenCalledWith("file-t1");

    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();
    await show({ kind: "takenOver", device: { deviceName: "Kitchen phone", deviceType: "phone" } });
    const notice = q("stream-slot-prompt")[0]?.textContent;
    console.info(`${SUITE} notice ${notice}; pauses ${pause.mock.calls.length}`);
    expect(notice).toContain(streamSlotTextFr("Kitchen phone"));
    expect(pause).toHaveBeenCalled();
    await click("stream-slot-close");
    expect(bridge.streamDismiss).toHaveBeenCalled();
  });
});

/** The French taken-over sentence, read from the shared strings so this test proves the window uses them. */
const streamSlotTextFr = (deviceName: string) => streamSlotText("fr", "playingElsewhere", { deviceName, deviceType: "phone" });
