/**
 * @test-id PARROT-MOBILE-UP-NEXT-ONCE-001
 * @level integration
 * @req PAR-CARD-02[parrot]
 * @why Chris 2026-11-21: "I can add a whole album to the up next queue, but not a single song, and currently I can add
 *   a song multiple times to the queue." The phone's queue lives in the native player, so the real `queueTracks` runs
 *   over a fake native player that holds a queue (current song, Up next) and answers `getState` / `getUpNext` as
 *   Media3 does: adding the album while one of its songs plays leaves that song out, a song added twice is one row, and
 *   the second add resolves 0 (the app's "Already in Up next" notice).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Item = { id: string; key: string };

const player = vi.hoisted(() => ({
  ids: [] as string[],
  index: -1,
  calls: [] as string[],
}));
const TAG = "[PARROT-MOBILE-UP-NEXT-ONCE-001]";
const dump = (step: string) =>
  console.info(`${TAG} ${step}`, JSON.stringify({ now: player.ids[player.index] ?? null, upNext: player.ids.slice(player.index + 1), calls: player.calls }));

vi.mock("@space/shared/api", () => ({ listProfiles: async () => ({ profiles: [{ id: "profile-main", isMain: true }] }) }));
vi.mock("@space/mobile-media-proxy", () => ({
  MediaProxy: {
    start: async () => undefined,
    stop: async () => true,
    registerChunkedFile: async (file: { id: string }) => `http://127.0.0.1:9999/${file.id}`,
    onDownload: () => () => undefined,
  },
  resolveGatewayCandidates: async () => ["http://gateway.test"],
}));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: {
    setQueue: async (items: Item[], start: number) => {
      player.ids = items.map((item) => item.id);
      player.index = start;
      player.calls.push(`setQueue ${player.ids.join(",")}`);
      return { state: "buffering" };
    },
    addItems: async (items: Item[], where: "next" | "end") => {
      const ids = items.map((item) => item.id);
      if (where === "next") player.ids.splice(player.index + 1, 0, ...ids);
      else player.ids.push(...ids);
      if (player.index < 0) player.index = 0;
      player.calls.push(`addItems ${where} ${ids.join(",")}`);
      return { state: "ready" };
    },
    getState: async () => ({ mediaId: player.ids[player.index] ?? null }),
    getUpNext: async () => player.ids.slice(player.index + 1),
    setShuffle: async () => ({ state: "buffering" }),
    setGains: async () => undefined,
    setLimiting: async () => undefined,
    stop: async () => undefined,
    onState: () => ({ remove: () => undefined }),
  },
}));
vi.mock("../src/lib/library", () => ({
  trackFiles: async (trackId: string) => [
    { id: `${trackId}-flac`, trackId, mime: "audio/flac", lossless: true, bitrateKbps: 1800, sizeBytes: 1000, lightCopy: false, createdAt: 1 },
  ],
  chunkedFile: async (file: { id: string; mime: string; sizeBytes: number }) => ({ ...file, chunks: [] }),
  coverUri: async () => null,
  keptCoverUri: () => null,
}));
vi.mock("../src/lib/kept", () => ({ keptFileIdFor: () => null }));
vi.mock("../src/lib/evenVolume", () => ({ getEvenVolume: () => ({ on: false, level: "normal" }), subscribeEvenVolume: () => () => undefined }));
vi.mock("../src/lib/streamSlot", () => ({ acquireStream: async () => "play", releaseStream: async () => undefined }));

import { playTracks, queueTracks } from "../src/lib/playback";

const song = (id: string, number: number) => ({ id, albumId: "al-ocie", title: id, artistName: "Ocie Elliott", number, disc: 1, durationMs: 180_000, cover: null });
const album = () => [song("intro", 1), song("without-you", 2), song("lanterns", 3)];
const add = (tracks: unknown[], where: "next" | "end" = "end") =>
  queueTracks({ token: "t", libraryKey: "k", albumTitle: "Ocie Elliott", tracks: tracks as never, where });

beforeEach(() => {
  player.ids = [];
  player.index = -1;
  player.calls = [];
});

describe("@req PAR-CARD-02[parrot] a song is in Up next at most once on the phone", () => {
  it("adding the album while 'Without You' plays leaves it out of Up next", async () => {
    await playTracks({ token: "t", libraryKey: "k", tracks: [song("without-you", 2)] as never, startIndex: 0 });
    dump("playing");
    const added = await add(album());
    dump("album added");
    expect(added).toBe(2);
    expect(player.ids[player.index]).toBe("without-you");
    expect(player.ids.slice(player.index + 1)).toEqual(["intro", "lanterns"]);
  });

  it("one song added twice is still one row, and the second add resolves 0 for the notice", async () => {
    await playTracks({ token: "t", libraryKey: "k", tracks: [song("other", 9)] as never, startIndex: 0 });
    expect(await add([song("lanterns", 3)])).toBe(1);
    const again = await add([song("lanterns", 3)]);
    dump("added twice");
    expect(again).toBe(0);
    expect(player.ids.slice(player.index + 1)).toEqual(["lanterns"]);
    expect(player.calls.filter((call) => call.startsWith("addItems"))).toEqual(["addItems end lanterns"]);
    // Play next of a song already up next adds nothing either.
    expect(await add([song("lanterns", 3)], "next")).toBe(0);
  });

  it("into an empty player the songs are added and start", async () => {
    expect(await add(album())).toBe(3);
    dump("empty player");
    expect(player.ids).toEqual(["intro", "without-you", "lanterns"]);
  });
});
