/**
 * @test-id PARROT-MOBILE-EVEN-VOLUME-001
 * @level unit
 * @req PAR-PLAY-03[parrot]
 * @why PAR-PLAY-03 item 2: songs play as recorded unless the user turns on "Even out volume" in Settings, which is kept
 *   on the phone per account. On, the playing queue's gains follow the chosen level at once (Spotify's −11 / −14 / −19
 *   LUFS), and Loud turns on the native limiter that holds the lifted peaks at −1 dB. The native player, the media
 *   proxy and the library are replaced; playback.ts and evenVolume.ts are the real code.
 */
import { setTimeout as settle } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  queued: [] as Array<Record<string, unknown>>,
  gains: [] as Array<Record<string, number>>,
  limiting: [] as boolean[],
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-EVEN-VOLUME-001] ${step}`, JSON.stringify(detail));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => state.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void state.storage.set(key, value),
  },
}));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: (line: string, detail: unknown) => log(line, detail) }) }));
vi.mock("@space/shared/api", () => ({ listProfiles: async () => ({ profiles: [{ id: "profile-main", isMain: true }] }) }));
vi.mock("@space/mobile-media-proxy", () => ({
  MediaProxy: {
    start: async () => undefined,
    stop: async () => undefined,
    registerChunkedFile: async (file: { id: string }) => `http://127.0.0.1:9999/${file.id}`,
    onDownload: () => () => undefined,
  },
  resolveGatewayCandidates: async () => ["http://gateway.test"],
}));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: {
    setQueue: async (items: Array<Record<string, unknown>>) => {
      state.queued = items;
      return { state: "buffering" };
    },
    setShuffle: async () => ({ state: "buffering" }),
    setGains: async (gains: Record<string, number>) => void state.gains.push(gains),
    setLimiting: async (on: boolean) => void state.limiting.push(on),
    stop: async () => ({ state: "idle" }),
    onState: () => ({ remove: () => undefined }),
  },
}));
// Each song has one stored file, its original (no light copy), so the copy picker has a single choice.
vi.mock("../src/lib/library", () => ({
  trackFiles: async (trackId: string) => [
    { id: `file-${trackId}`, trackId, mime: "audio/flac", lossless: true, bitrateKbps: null, sizeBytes: 1000, lightCopy: false, createdAt: 0 },
  ],
  chunkedFile: async (file: { id: string; mime: string; sizeBytes: number }) => ({ ...file, chunks: [] }),
  coverUri: async () => null,
  keptCoverUri: () => null,
}));
vi.mock("../src/lib/kept", () => ({ keptFileIdFor: () => null }));
// The stream limit (ACCT-STREAM-01..04) has its own test (stream-slot.test.ts): every start gets its place here.
vi.mock("../src/lib/streamSlot", () => ({ acquireStream: async () => "play", releaseStream: async () => undefined }));

import { loadEvenVolume, setEvenVolume } from "../src/lib/evenVolume";
import { playTracks, stopPlayback } from "../src/lib/playback";

// Stored gains are ReplayGain values (to −18 LUFS): a −24 LUFS song at +6 with a −10 dBFS peak, a −8 LUFS one at −10.
const quiet = { id: "quiet", albumId: "a", title: "Quiet", artistName: "Juniper Skies", number: 1, disc: 1, durationMs: 1000, gainDb: 6, peak: 10 ** (-10 / 20) };
const loud = { id: "loud", albumId: "b", title: "Loud", artistName: "Juniper Skies", number: 1, disc: 1, durationMs: 1000, gainDb: -10, peak: 1 };
const play = () => playTracks({ token: "t", libraryKey: "k", tracks: [quiet, loud], startIndex: 0 });
const queuedGain = (id: string) => state.queued.find((item) => item.id === id)?.gainDb;
/** The setting applies to the queue in the background (native calls); let it land, then read the last gains sent. */
const choose = async (setting: { on: boolean; level: "loud" | "normal" | "quiet" }) => {
  await setEvenVolume(setting);
  await settle(0);
  return state.gains.at(-1)!;
};
const expectGains = (gains: Record<string, number>, quietDb: number, loudDb: number) => {
  expect(gains.quiet).toBeCloseTo(quietDb, 6);
  expect(gains.loud).toBeCloseTo(loudDb, 6);
};

describe("Even out volume on the phone", () => {
  beforeEach(async () => {
    await stopPlayback();
    state.storage.clear();
    state.queued = [];
    state.gains = [];
    state.limiting = [];
    await loadEvenVolume("u-1");
  });

  it("is off by default: every song plays as recorded and no limiter runs", async () => {
    await play();
    log("off.queued", state.queued.map((item) => ({ id: item.id, gainDb: item.gainDb })));
    expect(queuedGain("quiet")).toBe(0);
    expect(queuedGain("loud")).toBe(0);
    expect(state.limiting.length).toBeGreaterThan(0);
    expect(state.limiting.every((on) => !on)).toBe(true);
  });

  it("follows the level at once, turns the limiter on for Loud only, and is kept per account", async () => {
    await play();
    const normal = await choose({ on: true, level: "normal" });
    log("normal.gains", normal);
    // Normal: the loud song cut to −14 (−6 dB); the quiet one lifted to −14 would be +10, capped at its peak's headroom (+9).
    expectGains(normal, 9, -6);
    expect(state.limiting.at(-1)).toBe(false);

    const loudLevel = await choose({ on: true, level: "loud" });
    log("loud.gains", { gains: loudLevel, limiting: state.limiting.at(-1) });
    expectGains(loudLevel, 13, -3);
    expect(state.limiting.at(-1)).toBe(true);

    const quietLevel = await choose({ on: true, level: "quiet" });
    log("quiet.gains", quietLevel);
    expectGains(quietLevel, 5, -11);
    expect(state.limiting.at(-1)).toBe(false);

    const off = await choose({ on: false, level: "quiet" });
    log("off.gains", off);
    expectGains(off, 0, 0);
    expect(JSON.parse(state.storage.get("parrot.evenVolume.u-1")!)).toEqual({ on: false, level: "quiet" });

    await choose({ on: true, level: "loud" });
    await loadEvenVolume("u-2");
    await settle(0);
    log("other-account", { limiting: state.limiting.at(-1), gains: state.gains.at(-1) });
    expectGains(state.gains.at(-1)!, 0, 0);
    expect(state.limiting.at(-1)).toBe(false);
    expect(await loadEvenVolume("u-1")).toEqual({ on: true, level: "loud" });
  });
});
