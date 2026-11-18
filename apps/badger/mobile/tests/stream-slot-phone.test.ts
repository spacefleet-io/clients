/**
 * @test-id STREAM-SLOT-PHONE-001
 * @level integration
 *
 * The account's stream limit on Badger's phone player (ACCT-STREAM-01..04). Mounts the real `usePlayerSession` with the
 * real app gate (`src/lib/playback/streamSlot.ts`, `@space/stream-slots`) over a fake API answering
 * `POST /playback/streams`, heartbeats and `DELETE`, with React Native's `Alert` captured:
 *  - a streamed file asks for a place before the proxy starts, and plays when one is free;
 *  - at the limit the native alert says "Already playing on {device}. Play here instead?" (app language); Play here
 *    takes the place over, Cancel closes the player with nothing started and nothing taken over;
 *  - another device taking the place over closes the player and says "Playing on {device} now";
 *  - a download played from disk never asks;
 *  - casting takes the place as kind `cast`, handed over from the player without a question; closing frees it.
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

vi.mock("react-native", () => ({
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
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: "phone-token" }) }));
vi.mock("../src/store/library", () => ({ useLibraryActions: () => libraryValue, useLibraryStatus: () => libraryValue }));
vi.mock("../src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({ showLoading: () => "modal", hideLoading: () => undefined }),
}));
vi.mock("../src/lib/resume", () => ({ setLastPlayedEpisodeId: async () => undefined, reconcileResumeHints: async () => undefined }));
vi.mock("../src/lib/onboarding", () => ({ getStoredLibraryKey: async () => "key" }));
vi.mock("../src/lib/playbackGateway", () => ({ resolveGatewayCandidates: async () => ["https://gw"] }));
vi.mock("../src/lib/downloads/offlinePlayback", () => ({
  resolveOfflinePlayback: async () => (ctl.downloaded ? { fileId: "f1" } : null),
  filterToDownloadedFormat: <T>(formats: T[]) => (ctl.downloaded ? formats : []),
}));
vi.mock("../src/lib/playback/ingestMetadata", () => ({
  buildIngestMetadata: () => ({ videos: [{ durationSeconds: 100 }], audios: [], subtitles: [], chapters: [] }),
}));
vi.mock("../src/lib/playback/nextEpisode", () => ({ selectMarkersForPlayback: () => [] }));
vi.mock("@space/shared/playableEpisodes", () => ({
  getNextPlayableEpisode: () => null,
  getPreviousPlayableEpisode: () => null,
}));

import { usePlayerSession, type PlayerSession } from "../src/screens/player/usePlayerSession";
import { acquireStream, streamSlots } from "../src/lib/playback/streamSlot";
import { setViewingScope } from "../src/lib/profiles/activeViewingScope";
import { MAIN_VIEWING_SCOPE, viewingScopeFor } from "@space/shared/profileViewing";

const TAG = "[stream-slot-phone]";
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

describe("Badger phone player obeys the account's stream limit", () => {
  it("@req ACCT-STREAM-01[badger-mobile] a streamed file asks for a place for the active profile before the proxy starts", async () => {
    ctl.startReplies.push(started("s1"));
    log("phase.mount");
    await mount();
    log("phase.loaded", { phase: latest?.phase, closeReason: latest?.closeReason, calls: streamCalls(), proxies: ctl.startProxyCalls });
    expect(streamCalls()[0]).toMatchObject({
      method: "POST",
      body: { app: "badger", profileId: PROFILE_ID, kind: "play", takeover: false },
      auth: "Bearer phone-token",
    });
    expect(latest?.phase).toBe("ready");
    expect(ctl.startProxyCalls).toBe(1);
    expect(ctl.alerts).toEqual([]);

    log("phase.close");
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
    await settle(5);
    log("phase.closed", { calls: streamCalls() });
    // ACCT-STREAM-04: closing the player frees the place.
    expect(streamCalls().at(-1)).toMatchObject({ method: "DELETE", path: expect.stringContaining("/playback/streams/s1") });
  });

  it("@req ACCT-STREAM-02[badger-mobile] at the limit the alert asks 'Play here instead?' and Play here takes the place over", async () => {
    ctl.language = "fr";
    ctl.startReplies.push(atLimit("TV du salon"), started("s2"));
    await mount();
    log("phase.asked", { alerts: ctl.alerts.map((alert) => ({ title: alert.title, buttons: alert.buttons.map((button) => button.text) })), proxies: ctl.startProxyCalls });
    expect(ctl.startProxyCalls).toBe(0);
    expect(ctl.alerts).toHaveLength(1);
    expect(ctl.alerts[0]?.title).toBe("Déjà en lecture sur TV du salon. Lire ici à la place ?");
    expect(ctl.alerts[0]?.buttons.map((button) => button.text)).toEqual(["Annuler", "Lire ici"]);

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

  it("@req ACCT-STREAM-02[badger-mobile] Cancel closes the player: no proxy, no takeover, no error", async () => {
    ctl.startReplies.push(atLimit(null, "mobile"));
    await mount();
    log("phase.asked", { title: ctl.alerts[0]?.title });
    expect(ctl.alerts[0]?.title).toBe("Already playing on a phone. Play here instead?");
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

  it("@req ACCT-STREAM-02[badger-mobile] @req ACCT-STREAM-04[badger-mobile] heartbeats every 20 s; taken over by another device, the player closes and says where it plays now", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ctl.startReplies.push(started("s1"));
    await mount();
    expect(latest?.phase).toBe("ready");

    log("phase.heartbeat-alive");
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await settle(5);
    expect(streamCalls().filter((call) => call.path.endsWith("/s1/heartbeat"))).toHaveLength(1);
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
    expect(streamSlots.getState()).toEqual({ kind: "idle" });
    expect(streamSlots.holding).toBe(false);
  });

  it("@req ACCT-STREAM-03[badger-mobile] a download played from disk never asks", async () => {
    ctl.downloaded = true;
    await mount();
    log("phase.offline", { phase: latest?.phase, offline: latest?.offline, calls: streamCalls() });
    expect(latest?.phase).toBe("ready");
    expect(latest?.offline).toBe(true);
    expect(streamCalls()).toEqual([]);
  });

  it("@req ACCT-STREAM-03[badger-mobile] casting from the phone takes the player's place as kind cast, without a question; stopping the cast frees it", async () => {
    ctl.startReplies.push(started("play-1"), started("cast-1"));
    await mount();
    log("phase.casting");
    // What useCastPlayback does once the cast source is known (the player screen is replaced by the cast screen).
    expect(await acquireStream({ token: "phone-token", kind: "cast", owner: "cast", offline: false })).toBe("play");
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
    await settle(5);
    log("phase.player-closed", { calls: streamCalls() });
    expect(streamCalls().map((call) => `${call.method} ${call.path.replace(/^.*\/playback\/streams/u, "")}`)).toEqual([
      "POST ",
      "DELETE /play-1",
      "POST ",
    ]);
    expect(streamCalls()[2]).toMatchObject({ body: { app: "badger", profileId: PROFILE_ID, kind: "cast", takeover: false } });
    expect(ctl.alerts).toEqual([]);
    expect(streamSlots.holding).toBe(true);

    log("phase.cast-stopped");
    await streamSlots.release("cast");
    expect(streamCalls().at(-1)).toMatchObject({ method: "DELETE", path: expect.stringContaining("/cast-1") });
    // A cast of a download never asks either.
    expect(await acquireStream({ token: "phone-token", kind: "cast", owner: "cast", offline: true })).toBe("play");
    expect(streamCalls()).toHaveLength(4);
  });
});
