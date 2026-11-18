/**
 * @test-id STREAM-SLOT-TV-001
 * @level integration
 *
 * The account's stream limit on Badger's TV app (ACCT-STREAM-01..04). The TV's `Player` route is the shared
 * `PlayerScreen` / `usePlayerSession` (see `tvPlaybackProfile.test.ts`), so this mounts the real `usePlayerSession`
 * with the real app gate (`src/lib/playback/streamSlot.ts`, `@space/stream-slots`) as the TV runs it (`Platform.isTV`
 * true, the TV's own sign-in token), over a fake API answering `POST /playback/streams`, heartbeats and `DELETE`, with
 * the native `Alert` (an Android TV / tvOS dialog the remote moves through) captured:
 *  - a streamed title asks for a place for the watching profile before the proxy starts, and closing frees it;
 *  - with the phone or the desktop playing, the TV asks "Already playing on {device}. Play here instead?"; Play here
 *    takes the place over, Cancel closes the player with nothing started;
 *  - the TV heartbeats every 20 s; when the phone takes the place over, the TV player closes and says
 *    "Playing on {device} now";
 *  - a "Play on TV" start from the phone (UX-TV-02) is the TV's own playback: the phone, as the remote, holds no place,
 *    so the TV takes one place for the profile and the account still counts one stream; a download never asks.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ApiCall = { method: string; path: string; body: unknown; auth: string | null };
type Reply = { status: number; body?: unknown };

const ctl = vi.hoisted(() => ({
  alerts: [] as Array<{ title: string; buttons: Array<{ text: string; onPress?: () => void }> }>,
  language: "en",
  downloaded: false,
  startProxyCalls: 0,
  calls: [] as ApiCall[],
  startReplies: [] as Reply[],
  heartbeatReplies: [] as Reply[],
}));

const details = {
  type: "movie",
  files: [{ id: "f1" }],
  formats: [{ id: "fm1", fileId: "f1", durationSeconds: 100, initKey: "media/placement-1/init", chunks: [] }],
  audioTracks: [],
  subtitleTracks: [],
  chapters: [],
  skipMarkers: [],
  episodes: [],
  progressPct: 0,
};

const libraryValue = {
  getMediaDetails: async () => details,
  getPlaybackChunks: async () => ({ formats: { fm1: [{ key: "media/placement-1/c0", sizeBytes: null, startSeconds: null }] }, audio: {} }),
  getPlayableTrackIds: async () => ["fm1"],
  getEpisodeResumeMap: async () => ({}),
  getTrackPrefs: async () => null,
  awaitDatasetReady: async () => undefined,
  datasetStatus: { core: true, metadata: true, playback: true },
};

vi.mock("react-native", async () => ({
  ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
  // The TV build: react-native-tvos reports `isTV` on Android TV and Apple TV alike.
  Platform: { isTV: true, OS: "android", select: <T,>(choices: { android?: T; default?: T }) => choices.android ?? choices.default },
  Alert: {
    alert: (title: string, _message?: string, buttons?: Array<{ text: string; onPress?: () => void }>) => {
      ctl.alerts.push({ title, buttons: buttons ?? [] });
    },
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock("@space/mobile-mpv-playback", () => ({
  PlaybackBridge: {
    startProxy: async () => {
      ctl.startProxyCalls += 1;
      return "http://127.0.0.1:1/master.m3u8";
    },
    stopProxy: async () => true,
  },
}));
vi.mock("@space/mobile-shell/i18n", () => ({ translate: (key: string) => key, getCurrentLanguage: () => ctl.language }));
vi.mock("../../store/auth", () => ({ useAuth: () => ({ token: "tv-token" }) }));
vi.mock("../../store/library", () => ({ useLibraryActions: () => libraryValue, useLibraryStatus: () => libraryValue }));
vi.mock("../../components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({ showLoading: () => "modal", hideLoading: () => undefined }),
}));
vi.mock("../../lib/resume", () => ({ setLastPlayedEpisodeId: async () => undefined, reconcileResumeHints: async () => undefined }));
vi.mock("../../lib/onboarding", () => ({ getStoredLibraryKey: async () => "key" }));
vi.mock("../../lib/playbackGateway", () => ({ resolveGatewayCandidates: async () => ["https://gw"] }));
vi.mock("../../lib/downloads/offlinePlayback", () => ({
  resolveOfflinePlayback: async () => (ctl.downloaded ? { fileId: "f1" } : null),
  filterToDownloadedFormat: <T>(formats: T[]) => (ctl.downloaded ? formats : []),
}));
vi.mock("../../lib/playback/ingestMetadata", () => ({
  buildIngestMetadata: () => ({ videos: [{ durationSeconds: 100 }], audios: [], subtitles: [], chapters: [] }),
}));
vi.mock("../../lib/playback/nextEpisode", () => ({ selectMarkersForPlayback: () => [] }));
vi.mock("@space/shared/playableEpisodes", () => ({
  getNextPlayableEpisode: () => null,
  getPreviousPlayableEpisode: () => null,
}));

import { usePlayerSession, type PlayerSession } from "../../screens/player/usePlayerSession";
import { streamSlots } from "../../lib/playback/streamSlot";
import { setViewingScope } from "../../lib/profiles/activeViewingScope";
import { MAIN_VIEWING_SCOPE, viewingScopeFor } from "@space/shared/profileViewing";

const TAG = "[stream-slot-tv]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const PROFILE_ID = "6f1c2a7e-0b4d-4e7a-9a51-3c2d1e0f9a11";

const started = (streamId: string): Reply => ({
  status: 201,
  body: { streamId, profileId: PROFILE_ID, heartbeatIntervalSeconds: 20, expiresInSeconds: 60 },
});
const atLimit = (deviceName: string | null, deviceType = "tv"): Reply => ({
  status: 409,
  body: { error: "stream_limit", limit: 1, playingOn: [{ streamId: "other", deviceName, deviceType, startedAt: "2026-11-11T01:00:00Z" }] },
});

const json = (reply: Reply) =>
  new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });

let latest: PlayerSession | null = null;
const Harness = () => {
  latest = usePlayerSession("media-1", null);
  return null;
};
let renderer: ReactTestRenderer | null = null;

const settle = async (rounds = 15) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const mount = async () => {
  await act(async () => {
    renderer = create(React.createElement(Harness));
  });
  await settle();
};

const streamCalls = () => ctl.calls.filter((call) => call.path.includes("/playback/streams"));

beforeEach(() => {
  ctl.alerts = [];
  ctl.language = "en";
  ctl.downloaded = false;
  ctl.startProxyCalls = 0;
  ctl.calls = [];
  ctl.startReplies = [];
  ctl.heartbeatReplies = [];
  latest = null;
  setViewingScope(viewingScopeFor({ id: PROFILE_ID, isMain: true }));
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: ApiCall = { method, path, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.Authorization ?? null };
    ctl.calls.push(call);
    let reply: Reply;
    if (method === "POST" && path.endsWith("/playback/streams")) reply = ctl.startReplies.shift() ?? { status: 500 };
    else if (method === "POST" && path.endsWith("/heartbeat")) reply = ctl.heartbeatReplies.shift() ?? { status: 200, body: { expiresInSeconds: 60 } };
    else if (method === "DELETE") reply = { status: 204 };
    else reply = { status: 200, body: { traffic: { state: "normal" } } };
    log("api", { ...call, status: reply.status });
    return json(reply);
  });
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  await streamSlots.release();
  streamSlots.dismiss();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setViewingScope(MAIN_VIEWING_SCOPE);
});


describe("Badger TV player obeys the account's stream limit", () => {
  it("@req ACCT-STREAM-01[badger-tv] a streamed title asks for a place for the watching profile before the proxy starts; closing frees it", async () => {
    ctl.startReplies.push(started("tv-1"));
    log("phase.mount");
    await mount();
    log("phase.loaded", { phase: latest?.phase, closeReason: latest?.closeReason, calls: streamCalls(), proxies: ctl.startProxyCalls });
    expect(streamCalls()[0]).toMatchObject({
      method: "POST",
      body: { app: "badger", profileId: PROFILE_ID, kind: "play", takeover: false },
      auth: "Bearer tv-token",
    });
    expect(latest?.phase).toBe("ready");
    expect(ctl.startProxyCalls).toBe(1);
    expect(ctl.alerts).toEqual([]);

    log("phase.back");
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
    await settle(5);
    log("phase.closed", { calls: streamCalls() });
    expect(streamCalls().at(-1)).toMatchObject({ method: "DELETE", path: expect.stringContaining("/playback/streams/tv-1") });
  });

  it("@req ACCT-STREAM-02[badger-tv] with the desktop playing, the TV asks 'Play here instead?' and Play here takes the place over", async () => {
    ctl.startReplies.push(atLimit("Office laptop", "desktop"), started("tv-2"));
    await mount();
    log("phase.asked", { alerts: ctl.alerts.map((alert) => ({ title: alert.title, buttons: alert.buttons.map((button) => button.text) })), proxies: ctl.startProxyCalls });
    expect(ctl.startProxyCalls).toBe(0);
    expect(ctl.alerts).toHaveLength(1);
    expect(ctl.alerts[0]?.title).toBe("Already playing on Office laptop. Play here instead?");
    expect(ctl.alerts[0]?.buttons.map((button) => button.text)).toEqual(["Cancel", "Play here"]);

    log("phase.play-here");
    await act(async () => {
      ctl.alerts[0]?.buttons[1]?.onPress?.();
    });
    await settle();
    log("phase.played", { phase: latest?.phase, calls: streamCalls() });
    expect(streamCalls()).toMatchObject([{ body: { takeover: false } }, { body: { takeover: true } }]);
    expect(latest?.phase).toBe("ready");
    expect(latest?.closeReason).toBeNull();
    expect(ctl.startProxyCalls).toBe(1);
  });

  it("@req ACCT-STREAM-02[badger-tv] Cancel closes the TV player: no proxy, no takeover, no error", async () => {
    ctl.language = "de";
    ctl.startReplies.push(atLimit("Pixel", "mobile"));
    await mount();
    log("phase.asked", { title: ctl.alerts[0]?.title, buttons: ctl.alerts[0]?.buttons.map((button) => button.text) });
    expect(ctl.alerts[0]?.title).toContain("Pixel");
    await act(async () => {
      ctl.alerts[0]?.buttons[0]?.onPress?.();
    });
    await settle();
    log("phase.cancelled", { phase: latest?.phase, error: latest?.error, closeReason: latest?.closeReason, calls: streamCalls() });
    expect(latest?.closeReason).toBe("cancelled");
    expect(latest?.error).toBeNull();
    expect(ctl.startProxyCalls).toBe(0);
    expect(streamCalls()).toHaveLength(1);
  });

  it("@req ACCT-STREAM-02[badger-tv] @req ACCT-STREAM-04[badger-tv] heartbeats every 20 s; when the phone takes the place over, the TV player closes and says where it plays now", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ctl.startReplies.push(started("tv-1"));
    await mount();
    expect(latest?.phase).toBe("ready");

    log("phase.heartbeat-alive");
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await settle(5);
    expect(streamCalls().filter((call) => call.path.endsWith("/tv-1/heartbeat"))).toHaveLength(1);
    expect(latest?.closeReason).toBeNull();

    log("phase.heartbeat-taken-over");
    ctl.heartbeatReplies.push({ status: 409, body: { error: "stream_taken_over", byDeviceName: "Pixel de Chris", byDeviceType: "mobile" } });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await settle(5);
    log("phase.taken-over", { closeReason: latest?.closeReason, alerts: ctl.alerts.map((alert) => alert.title), gate: streamSlots.getState() });
    expect(latest?.closeReason).toBe("takenOver");
    expect(ctl.alerts.map((alert) => alert.title)).toEqual(["Playing on Pixel de Chris now"]);
    expect(streamSlots.holding).toBe(false);
  });

  it("@req ACCT-STREAM-03[badger-tv] a 'Play on TV' start is the TV's one place for the profile, and a download on the TV never asks", async () => {
    // The phone that sent "Play on TV" is only the remote (UX-TV-02) and holds no place: the TV's start is the
    // profile's single stream, asked once, with no question while the profile has a free place.
    ctl.startReplies.push(started("tv-remote-start"));
    await mount();
    log("phase.remote-start", { calls: streamCalls(), alerts: ctl.alerts.length });
    expect(streamCalls()).toHaveLength(1);
    expect(streamCalls()[0]).toMatchObject({ body: { kind: "play", takeover: false } });
    expect(ctl.alerts).toEqual([]);
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
    await settle(5);

    log("phase.offline");
    ctl.calls = [];
    ctl.downloaded = true;
    await mount();
    log("phase.offline-loaded", { phase: latest?.phase, offline: latest?.offline, calls: streamCalls() });
    expect(latest?.phase).toBe("ready");
    expect(latest?.offline).toBe(true);
    expect(streamCalls().filter((call) => call.method === "POST")).toEqual([]);
  });
});
