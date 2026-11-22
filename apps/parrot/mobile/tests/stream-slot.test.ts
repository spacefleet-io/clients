/**
 * @test-id PARROT-MOBILE-STREAM-SLOT-001
 * @level integration
 * @req ACCT-STREAM-01[parrot]
 * @req ACCT-STREAM-02[parrot]
 * @req ACCT-STREAM-03[parrot]
 * @req ACCT-STREAM-04[parrot]
 * @why The account's stream limit on Parrot's phone player. The real `playTracks` / `queueTracks` / `stopPlayback` and
 *   the real app gate (`src/lib/streamSlot.ts`, `@space/stream-slots`) run over a fake API answering
 *   `POST /playback/streams`, heartbeats and `DELETE`, with React Native's `Alert` and the native player captured:
 *   - streamed songs ask for a place (app `parrot`, the listening profile) before the queue is handed to the player;
 *   - at the limit the native alert asks "Already playing on {device}. Play here instead?"; Play here takes the place
 *     over, Cancel leaves the music as it was and `usePlay` shows no error;
 *   - another device taking the place over stops the music and says "Playing on {device} now";
 *   - songs kept on the phone, or no connection, never ask;
 *   - sign-out and the music's end give the place back; heartbeats run every 20 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ApiCall = { method: string; path: string; body: unknown; auth: string | null };
type Reply = { status: number; body?: unknown };
type StateListener = (state: { state: string; playing: boolean }) => void;

const ctl = vi.hoisted(() => ({
  alerts: [] as Array<{ title: string; buttons: Array<{ text: string; onPress?: () => void }> }>,
  language: "en",
  kept: new Set<string>(),
  offline: false,
  player: [] as string[],
  stateListeners: [] as StateListener[],
  calls: [] as Array<{ method: string; path: string; body: unknown; auth: string | null }>,
  startReplies: [] as Array<{ status: number; body?: unknown }>,
  heartbeatReplies: [] as Array<{ status: number; body?: unknown }>,
  errors: [] as unknown[],
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  // usePlay is called as a plain function here: its second state (`error`, after `starting`) records what the screen
  // would show.
  let calls = 0;
  const useState = <T>(initial: T) => {
    const slot = calls++ % 2;
    return [initial, (next: T) => slot === 1 && next !== null && ctl.errors.push(next)];
  };
  return { ...actual, default: { ...actual, useState }, useState };
});
vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, _message?: string, buttons?: Array<{ text: string; onPress?: () => void }>) => {
      ctl.alerts.push({ title, buttons: buttons ?? [] });
    },
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: (route: string) => ctl.player.push(`navigate ${route}`) }) }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }), getCurrentLanguage: () => ctl.language }));
vi.mock("@space/mobile-shell/logger", () => ({
  scopeLogger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }),
}));
vi.mock("../src/state/session", () => ({ useSignedIn: () => ({ token: "phone-token", libraryKey: "key" }) }));
vi.mock("@space/mobile-media-proxy", () => ({
  MediaProxy: {
    start: async () => undefined,
    stop: async () => undefined,
    registerChunkedFile: async (file: { id: string }) => `http://127.0.0.1:9999/${file.id}`,
    onDownload: () => () => undefined,
  },
  resolveGatewayCandidates: async () => {
    if (ctl.offline) throw new Error("NETWORK_DOWN");
    return ["http://gateway.test"];
  },
}));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: {
    setQueue: async (items: Array<{ id: string }>) => {
      ctl.player.push(`setQueue ${items.map((item) => item.id).join(",")}`);
      return { state: "buffering" };
    },
    addItems: async (items: Array<{ id: string }>, where: string) => {
      ctl.player.push(`addItems ${where} ${items.map((item) => item.id).join(",")}`);
      return { state: "ready" };
    },
    // Nothing added in this test is playing or up next already (PAR-CARD-02 leaves those out).
    getState: async () => ({ mediaId: null }),
    getUpNext: async () => [],
    setShuffle: async () => ({ state: "buffering" }),
    setGains: async () => undefined,
    setLimiting: async () => undefined,
    stop: async () => {
      ctl.player.push("stop");
      return { state: "idle" };
    },
    onState: (listener: StateListener) => {
      ctl.stateListeners.push(listener);
      return { remove: () => undefined };
    },
  },
}));
vi.mock("../src/lib/evenVolume", () => ({ getEvenVolume: () => ({ on: false, level: "normal" }), subscribeEvenVolume: () => () => undefined }));
vi.mock("../src/lib/library", () => ({
  // The account's copy, plus the phone's kept one for kept songs.
  trackFiles: async (trackId: string) =>
    [`file-${trackId}`, ...(ctl.kept.has(trackId) ? [`kept-${trackId}`] : [])].map((id) => ({
      id,
      trackId,
      mime: "audio/flac",
      lossless: true,
      bitrateKbps: null,
      sizeBytes: 1000,
      lightCopy: false,
      createdAt: 0,
    })),
  chunkedFile: async (file: { id: string; mime: string; sizeBytes: number }) => ({ ...file, chunks: [] }),
  coverUri: async () => null,
  keptCoverUri: () => null,
}));
vi.mock("../src/lib/kept", () => ({ keptFileIdFor: (trackId: string) => (ctl.kept.has(trackId) ? `kept-${trackId}` : null) }));

import { setApiBaseUrl } from "@space/shared/api";
import { playTracks, queueTracks, stopPlayback } from "../src/lib/playback";
import { streamSlots } from "../src/lib/streamSlot";
import { setActiveProfile } from "../src/lib/activeProfile";
import { usePlay } from "../src/state/usePlay";

const TAG = "[PARROT-MOBILE-STREAM-SLOT-001]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const PROFILE_ID = "8d2f3b1c-5a6e-4c7d-9b0a-1e2f3a4b5c6d";

const started = (streamId: string): Reply => ({
  status: 201,
  body: { streamId, profileId: PROFILE_ID, heartbeatIntervalSeconds: 20, expiresInSeconds: 60 },
});
const atLimit = (...devices: Array<{ name: string | null; type: string; at: string }>): Reply => ({
  status: 409,
  body: {
    error: "stream_limit",
    limit: 2,
    playingOn: devices.map((device, index) => ({ streamId: `other-${index}`, deviceName: device.name, deviceType: device.type, startedAt: device.at })),
  },
});

const track = (id: string) => ({ id, albumId: "al-1", title: id, artistName: "Juniper Skies", number: 1, disc: 1, durationMs: 1000, cover: null });
const tracks = [track("tr-1"), track("tr-2")];
const play = (startIndex = 0) => playTracks({ token: "phone-token", libraryKey: "key", albumTitle: "Low Orbit", tracks: tracks as never, startIndex });

const streamCalls = () => ctl.calls.filter((call) => call.path.includes("/playback/streams"));
const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};
/** Waits until the alert is up (the gate asks after the 409 arrives). */
const nextAlert = async () => {
  for (let i = 0; i < 50 && ctl.alerts.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  log("alert", ctl.alerts.map((alert) => ({ title: alert.title, buttons: alert.buttons.map((button) => button.text) })));
  return ctl.alerts[0];
};

beforeEach(() => {
  ctl.alerts = [];
  ctl.language = "en";
  ctl.kept = new Set();
  ctl.offline = false;
  ctl.player = [];
  ctl.calls = [];
  ctl.startReplies = [];
  ctl.heartbeatReplies = [];
  ctl.errors = [];
  setApiBaseUrl("http://api.test");
  setActiveProfile({ id: PROFILE_ID, isMain: true } as never);
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
    else reply = { status: 404 };
    log("api", { ...call, status: reply.status });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  });
});

afterEach(async () => {
  await streamSlots.release();
  streamSlots.dismiss();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setActiveProfile(null);
});

describe("Parrot phone player obeys the account's stream limit", () => {
  it("@req ACCT-STREAM-01[parrot] streamed songs ask for a place for the listening profile before the player gets the queue; sign-out gives it back", async () => {
    ctl.startReplies.push(started("s1"));
    log("phase.play");
    await play();
    log("phase.playing", { calls: streamCalls(), player: ctl.player });
    expect(streamCalls()[0]).toMatchObject({
      method: "POST",
      body: { app: "parrot", profileId: PROFILE_ID, kind: "play", takeover: false },
      auth: "Bearer phone-token",
    });
    expect(ctl.player).toEqual(["setQueue tr-1,tr-2"]);
    expect(ctl.alerts).toEqual([]);

    log("phase.queue-more");
    await queueTracks({ token: "phone-token", libraryKey: "key", tracks: [track("tr-3")] as never, where: "end" });
    // The place already held is reused: no second request.
    expect(streamCalls()).toHaveLength(1);
    expect(ctl.player.at(-1)).toBe("addItems end tr-3");

    log("phase.sign-out");
    await stopPlayback();
    log("phase.signed-out", { calls: streamCalls() });
    expect(streamCalls().at(-1)).toMatchObject({ method: "DELETE", path: expect.stringContaining("/playback/streams/s1") });
    expect(streamSlots.holding).toBe(false);
  });

  it("@req ACCT-STREAM-02[parrot] at the limit the alert asks 'Play here instead?' about the oldest stream; Play here takes it over", async () => {
    ctl.language = "fr";
    ctl.startReplies.push(
      atLimit({ name: "Mac de Chris", type: "desktop", at: "2026-11-11T02:00:00Z" }, { name: "Pixel de Léa", type: "mobile", at: "2026-11-11T01:00:00Z" }),
      started("s2")
    );
    const playing = play();
    const alert = await nextAlert();
    expect(alert?.title).toBe("Déjà en lecture sur Pixel de Léa. Lire ici à la place ?");
    expect(alert?.buttons.map((button) => button.text)).toEqual(["Annuler", "Lire ici"]);
    expect(ctl.player).toEqual([]);

    log("phase.play-here");
    alert?.buttons[1]?.onPress?.();
    await playing;
    log("phase.played", { calls: streamCalls(), player: ctl.player });
    expect(streamCalls()).toMatchObject([{ body: { takeover: false } }, { body: { takeover: true } }]);
    expect(ctl.player).toEqual(["setQueue tr-1,tr-2"]);
  });

  it("@req ACCT-STREAM-02[parrot] Cancel leaves the music as it was: no queue change, no takeover, no error shown", async () => {
    ctl.startReplies.push(atLimit({ name: null, type: "mobile", at: "2026-11-11T01:00:00Z" }));
    const { play: playFromScreen } = usePlay();
    const playing = playFromScreen(tracks as never, 0, { title: "Low Orbit" });
    const alert = await nextAlert();
    expect(alert?.title).toBe("Already playing on a phone. Play here instead?");
    expect(alert?.buttons.map((button) => button.text)).toEqual(["Cancel", "Play here"]);

    log("phase.cancel");
    alert?.buttons[0]?.onPress?.();
    await playing;
    log("phase.cancelled", { calls: streamCalls(), player: ctl.player, errors: ctl.errors });
    expect(ctl.player).toEqual([]);
    expect(ctl.errors).toEqual([]);
    expect(streamCalls()).toHaveLength(1);
    expect(streamSlots.holding).toBe(false);
  });

  it("@req ACCT-STREAM-02[parrot] @req ACCT-STREAM-04[parrot] heartbeats every 20 s; taken over by another device, the music stops and the alert says where it plays now", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ctl.startReplies.push(started("s1"));
    await play();

    log("phase.heartbeat-alive");
    vi.advanceTimersByTime(20_000);
    await settle();
    expect(streamCalls().filter((call) => call.path.endsWith("/s1/heartbeat"))).toHaveLength(1);
    expect(ctl.player).toEqual(["setQueue tr-1,tr-2"]);

    log("phase.heartbeat-taken-over");
    ctl.heartbeatReplies.push({ status: 409, body: { error: "stream_taken_over", byDeviceName: "Mac de Chris", byDeviceType: "desktop" } });
    vi.advanceTimersByTime(20_000);
    // The 409 reaches the gate after more microtask turns than settle() gives on some hosts (the public GitHub runner):
    // wait for the stop itself.
    await vi.waitFor(() => expect(ctl.player).toEqual(["setQueue tr-1,tr-2", "stop"]));
    log("phase.taken-over", { player: ctl.player, alerts: ctl.alerts.map((alert) => alert.title), gate: streamSlots.getState() });
    expect(ctl.alerts.map((alert) => alert.title)).toEqual(["Playing on Mac de Chris now"]);
    expect(streamSlots.holding).toBe(false);
  });

  it("@req ACCT-STREAM-04[parrot] the music reaching its end gives the place back", async () => {
    ctl.startReplies.push(started("s3"));
    await play();
    log("phase.ended", { listeners: ctl.stateListeners.length });
    for (const listener of ctl.stateListeners) listener({ state: "ended", playing: false });
    await settle();
    log("phase.released", { calls: streamCalls() });
    expect(streamCalls().at(-1)).toMatchObject({ method: "DELETE", path: expect.stringContaining("/playback/streams/s3") });
    expect(streamSlots.holding).toBe(false);
  });

  it("@req ACCT-STREAM-03[parrot] songs kept on the phone, or played with no connection, never ask", async () => {
    ctl.kept = new Set(["tr-1", "tr-2"]);
    await play();
    log("phase.kept", { calls: streamCalls(), player: ctl.player });
    expect(streamCalls()).toEqual([]);
    expect(ctl.player).toEqual(["setQueue tr-1,tr-2"]);

    ctl.kept = new Set(["tr-2"]);
    ctl.offline = true;
    await play(1);
    log("phase.offline", { calls: streamCalls(), player: ctl.player });
    expect(streamCalls()).toEqual([]);
    expect(ctl.player.at(-1)).toBe("setQueue tr-2");

    // One streamed song in an otherwise kept list does ask.
    ctl.offline = false;
    ctl.startReplies.push(started("s4"));
    await play();
    expect(streamCalls()).toHaveLength(1);
  });
});
