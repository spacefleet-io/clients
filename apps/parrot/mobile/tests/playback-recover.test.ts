/**
 * @test-id PARROT-MOBILE-PLAYBACK-RECOVER-001
 * @level unit
 * @req PAR-PLAY-12[parrot]
 * @bugfix @regression-proof
 * @why Chris 2026-11-27 (Parrot Android 0.1.63, "Armored Frame" by NULLREDUX_EXE): the player stopped at 0:00 with
 *   "Playback error: ERROR_CODE_IO_BAD_HTTP_STATUS" and stayed there, although every chunk download on the gateway
 *   answered 200: the media proxy answered the player's own read 502 once and nothing tried again. A song the player
 *   stops on with an error is queued again once, from where it stopped, with the same queue around it; a second
 *   failure of that song is left to the plain message, so a song that cannot play never loops. Starting a queue gives
 *   every song its retry back. The native player, the media proxy and the library are replaced; playTracks and the
 *   state listener are the real code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Item = Record<string, unknown> & { id: string; key: string; url: string };
type State = { key: string | null; mediaId?: string | null; nextKey?: string | null; previousKey?: string | null; error?: string | null; positionMs?: number };

const state = vi.hoisted(() => ({
  setQueues: [] as Array<{ items: Item[]; start: number; positionMs: number }>,
  playerState: null as null | ((state: State) => void),
  /** When set, setQueue waits on it: the retry is still being prepared. */
  hold: null as null | Promise<void>,
  /** When set, the library has no file for any song: the phone is offline. */
  offline: false,
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-PLAYBACK-RECOVER-001] ${step}`, JSON.stringify(detail));

vi.mock("@space/shared/api", () => ({ listProfiles: async () => ({ profiles: [{ id: "profile-main", isMain: true }] }) }));
vi.mock("@space/mobile-media-proxy", () => ({
  MediaProxy: {
    start: async () => undefined,
    stop: async () => true,
    registerChunkedFile: async (file: { id: string }) => `http://127.0.0.1:9999/playback/chunked/${encodeURIComponent(file.id)}`,
    swapChunkedFile: async () => true,
    setNeighbours: async () => true,
    onDownload: () => () => undefined,
  },
  resolveGatewayCandidates: async () => ["http://gateway.test"],
}));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: {
    setQueue: async (items: Item[], start: number, positionMs: number) => {
      if (state.hold) await state.hold;
      state.setQueues.push({ items: [...items], start, positionMs });
      return { state: "buffering" };
    },
    addItems: async () => ({ state: "playing" }),
    getState: async () => ({ mediaId: null }),
    getUpNext: async () => [],
    setShuffle: async () => ({ state: "buffering" }),
    setGains: async () => undefined,
    setLimiting: async () => undefined,
    stop: async () => undefined,
    onState: (listener: (state: State) => void) => {
      state.playerState = listener;
      return {
        remove: () => {
          state.playerState = null;
        },
      };
    },
  },
}));
vi.mock("../src/lib/library", () => ({
  trackFiles: async (trackId: string) => {
    if (state.offline) throw new Error("NO_PLAYABLE_FILE");
    return [
      { id: `${trackId}-flac`, trackId, mime: "audio/flac", lossless: true, bitrateKbps: 1800, sizeBytes: 40_500_000, lightCopy: false, createdAt: 1 },
    ];
  },
  chunkedFile: async (file: { id: string; mime: string; sizeBytes: number }) => ({
    id: file.id,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    chunks: [{ objectKey: `library/chunks/${file.id}`, plainOffset: 0, plainSize: file.sizeBytes }],
  }),
  coverUri: async () => null,
  keptCoverUri: () => null,
}));
vi.mock("../src/lib/kept", () => ({ keptFileIdFor: () => null }));
vi.mock("../src/lib/evenVolume", () => ({ getEvenVolume: () => ({ on: false, level: "normal" }), subscribeEvenVolume: () => () => undefined }));
vi.mock("../src/lib/streamSlot", () => ({ acquireStream: async () => "play", releaseStream: async () => undefined }));

import { isRecovering, playTracks, stopPlayback } from "../src/lib/playback";

const song = (id: string, title: string, number: number) => ({
  id,
  albumId: "al-hollow-machine",
  title,
  artistName: "NULLREDUX_EXE",
  number,
  disc: 1,
  durationMs: 240_000,
  cover: null,
});
const intro = song("tr-boot", "Boot Sequence", 1);
const armored = song("tr-armored", "Armored Frame", 2);
const outro = song("tr-shutdown", "Shutdown", 3);
const album = [intro, armored, outro];

/** Lets the recovery's awaited steps (file lookups, setQueue) run: microtasks only, no wall clock. */
const settle = async () => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};
const lastQueue = () => state.setQueues[state.setQueues.length - 1];
const playing = (trackId: string) => lastQueue().items.find((item) => item.id === trackId)!;
/** The player sits on `trackId` with the error Chris saw (it repeats its state while it does). */
const fails = async (trackId: string, positionMs: number) => {
  const item = playing(trackId);
  const failed = { key: item.key, mediaId: trackId, error: "ERROR_CODE_IO_BAD_HTTP_STATUS", positionMs };
  log("player.error", failed);
  state.playerState!(failed);
  state.playerState!(failed);
  await settle();
};

describe("a song the player stops on with an error (PAR-PLAY-12)", () => {
  beforeEach(async () => {
    await stopPlayback();
    state.setQueues = [];
    state.offline = false;
  });

  it("is queued again once from where it stopped, with the same queue around it", async () => {
    await playTracks({ token: "tok", libraryKey: "lk", albumTitle: "Hollow Machine", tracks: album, startIndex: 1 });
    expect(state.setQueues).toHaveLength(1);
    const firstKey = playing("tr-armored").key;

    await fails("tr-armored", 0);

    log("queues", state.setQueues.map((queue) => ({ start: queue.start, positionMs: queue.positionMs, keys: queue.items.map((item) => item.key) })));
    expect(state.setQueues).toHaveLength(2);
    const retry = lastQueue();
    expect(retry.items.map((item) => item.id)).toEqual(["tr-boot", "tr-armored", "tr-shutdown"]);
    expect(retry.items[retry.start].id).toBe("tr-armored");
    expect(retry.items[retry.start].key).not.toBe(firstKey);
    expect(retry.items[retry.start].album).toBe("Hollow Machine");
    expect(retry.positionMs).toBe(0);
  });

  it("resumes at the position the error stopped it", async () => {
    await playTracks({ token: "tok", libraryKey: "lk", albumTitle: "Hollow Machine", tracks: album, startIndex: 0 });
    await fails("tr-boot", 42_000);
    expect(state.setQueues).toHaveLength(2);
    expect(lastQueue().positionMs).toBe(42_000);
    expect(lastQueue().items[lastQueue().start].id).toBe("tr-boot");
  });

  it("is not retried a second time: the plain message stays, no loop", async () => {
    await playTracks({ token: "tok", libraryKey: "lk", albumTitle: "Hollow Machine", tracks: album, startIndex: 1 });
    await fails("tr-armored", 0);
    await fails("tr-armored", 0);
    log("queues", state.setQueues.length);
    expect(state.setQueues).toHaveLength(2);
  });

  it("gets its retry back when a queue is started again", async () => {
    await playTracks({ token: "tok", libraryKey: "lk", albumTitle: "Hollow Machine", tracks: album, startIndex: 1 });
    await fails("tr-armored", 0);
    await fails("tr-armored", 0);
    await playTracks({ token: "tok", libraryKey: "lk", albumTitle: "Hollow Machine", tracks: album, startIndex: 1 });
    expect(state.setQueues).toHaveLength(3);
    await fails("tr-armored", 0);
    expect(state.setQueues).toHaveLength(4);
  });

  it("leaves a state without an error alone", async () => {
    await playTracks({ token: "tok", libraryKey: "lk", albumTitle: "Hollow Machine", tracks: album, startIndex: 1 });
    state.playerState!({ key: playing("tr-armored").key, mediaId: "tr-armored", error: null, positionMs: 1_000 });
    await settle();
    expect(state.setQueues).toHaveLength(1);
  });

  it("@bugfix @regression-proof holds the plain message back while its one retry is prepared, shows it once that fails", async () => {
    await playTracks({ token: "tok", libraryKey: "lk", albumTitle: "Hollow Machine", tracks: album, startIndex: 1 });
    const item = playing("tr-armored");
    const failed = { key: item.key, mediaId: "tr-armored", error: "ERROR_CODE_IO_BAD_HTTP_STATUS", positionMs: 0 };
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    state.playerState!(failed);
    await settle();
    log("retry_pending", { recovering: isRecovering(failed) });
    expect(isRecovering(failed)).toBe(true);
    expect(isRecovering({ ...failed, error: null })).toBe(false);
    release();
    state.hold = null;
    await settle();
    expect(isRecovering(failed)).toBe(false);
    // The retried song fails as well: no second retry, and the message shows.
    const again = { ...failed, key: playing("tr-armored").key };
    state.playerState!(again);
    await settle();
    log("second_failure", { recovering: isRecovering(again), queues: state.setQueues.length });
    expect(isRecovering(again)).toBe(false);
    expect(state.setQueues).toHaveLength(2);
  });

  it("@bugfix @regression-proof gets its retry back when the retry could not be prepared (offline), so the next error retries", async () => {
    // Chris 2026-11-27 / op9 check: the song failed while offline, its one retry found no playable file, and once the
    // network was back tapping Play only gave ERROR_CODE_IO_NETWORK_CONNECTION_FAILED with no retry left.
    await playTracks({ token: "tok", libraryKey: "lk", albumTitle: "Hollow Machine", tracks: album, startIndex: 1 });
    const key = playing("tr-armored").key;
    state.offline = true;
    await fails("tr-armored", 12_000);
    log("offline_retry", { queues: state.setQueues.length });
    expect(state.setQueues).toHaveLength(1);
    state.offline = false;
    const back = { key, mediaId: "tr-armored", error: "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED", positionMs: 12_000 };
    log("player.error", back);
    state.playerState!(back);
    await settle();
    log("network_back_retry", { queues: state.setQueues.length });
    expect(state.setQueues).toHaveLength(2);
    expect(lastQueue().items[lastQueue().start].id).toBe("tr-armored");
    expect(lastQueue().positionMs).toBe(12_000);
    // That retry reached the player: a further failure is left to the plain message.
    await fails("tr-armored", 12_000);
    expect(state.setQueues).toHaveLength(2);
  });
});
