/**
 * @test-id PARROT-MOBILE-LIGHT-COPY-001
 * @level unit
 * @req PAR-PLAY-04[parrot]
 * @req PAR-PLAY-02[parrot]
 * @why The phone picks each song's copy itself, from how fast the media proxy downloads (PAR-PLAY-02), and changes it
 *   only from one song to the next (PAR-PLAY-04): "Nook" plays its FLAC original; the connection slows, so "Fable",
 *   the song after it, plays the light copy; once the connection is fast again a following song plays its original.
 *   The copy of a queued song is settled when the song before it starts and is swapped behind the song's own proxy id;
 *   songs further ahead follow the measured speed too, since the player may read ahead more than one song (seen on the
 *   emulator with one-minute songs). The song playing is never swapped. A song kept on the phone always plays its kept
 *   original. The native player, the media proxy and the library are replaced; playTracks, queueTracks and the shared
 *   copy picker are the real code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Item = Record<string, unknown> & { id: string; key: string; url: string };
type State = { key: string | null; nextKey: string | null };

const state = vi.hoisted(() => ({
  queued: [] as Item[],
  registered: [] as Array<{ id: string; mime: string }>,
  swaps: [] as Array<{ id: string; mime: string }>,
  download: null as null | ((event: { bytes: number; ms: number }) => void),
  playerState: null as null | ((state: State) => void),
  kept: {} as Record<string, string>,
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-LIGHT-COPY-001] ${step}`, JSON.stringify(detail));

vi.mock("@space/shared/api", () => ({ listProfiles: async () => ({ profiles: [{ id: "profile-main", isMain: true }] }) }));
vi.mock("@space/mobile-media-proxy", () => ({
  MediaProxy: {
    start: async () => undefined,
    stop: async () => true,
    registerChunkedFile: async (file: { id: string; mime: string }) => {
      state.registered.push({ id: file.id, mime: file.mime });
      return `http://127.0.0.1:9999/playback/chunked/${encodeURIComponent(file.id)}`;
    },
    swapChunkedFile: async (file: { id: string; mime: string }) => {
      state.swaps.push({ id: file.id, mime: file.mime });
      return true;
    },
    onDownload: (handler: (event: { bytes: number; ms: number }) => void) => {
      state.download = handler;
      return () => {
        state.download = null;
      };
    },
  },
  resolveGatewayCandidates: async () => ["http://gateway.test"],
}));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: {
    setQueue: async (items: Item[]) => {
      state.queued = [...items];
      return { state: "buffering" };
    },
    addItems: async (items: Item[]) => {
      state.queued.push(...items);
      return { state: "playing" };
    },
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

const FLAC = "audio/flac";
const OPUS = "audio/ogg; codecs=opus";
const DURATION_MS = 180_000;
/** Each song's FLAC original (~1800 kbps) and its light copy (Opus 64 kbps, PAR-FMT-02). */
const filesOf = (trackId: string) => [
  { id: `${trackId}-flac`, trackId, mime: FLAC, lossless: true, bitrateKbps: 1800, sizeBytes: 40_500_000, lightCopy: false, createdAt: 1 },
  { id: `${trackId}-light`, trackId, mime: OPUS, lossless: false, bitrateKbps: 64, sizeBytes: 1_440_000, lightCopy: true, createdAt: 2 },
];
vi.mock("../src/lib/library", () => ({
  trackFiles: async (trackId: string) => filesOf(trackId),
  chunkedFile: async (file: { id: string; mime: string; sizeBytes: number }) => ({
    id: file.id,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    chunks: [{ objectKey: `library/chunks/${file.id}`, plainOffset: 0, plainSize: file.sizeBytes }],
  }),
  coverUri: async () => null,
  keptCoverUri: () => null,
}));
vi.mock("../src/lib/kept", () => ({ keptFileIdFor: (trackId: string) => state.kept[trackId] ?? null }));
vi.mock("../src/lib/evenVolume", () => ({ getEvenVolume: () => ({ on: false, level: "normal" }), subscribeEvenVolume: () => () => undefined }));
// The stream limit (ACCT-STREAM-01..04) has its own test (stream-slot.test.ts): every start gets its place here.
vi.mock("../src/lib/streamSlot", () => ({ acquireStream: async () => "play", releaseStream: async () => undefined }));

import { playTracks, queueTracks, stopPlayback } from "../src/lib/playback";

const song = (id: string, title: string, number: number) => ({
  id,
  albumId: "al-meltway",
  title,
  artistName: "Linnet Park",
  number,
  disc: 1,
  durationMs: DURATION_MS,
  cover: null,
});
const nook = song("tr-nook", "Nook", 13);
const fable = song("tr-fable", "Fable", 7);
const habit = song("tr-habit", "Breaking the Tide", 10);
const belong = song("tr-belong", "Somewhere I Wander", 3);

/** 256 KiB chunks downloaded at `kbps`. */
const downloads = (kbps: number, count: number) => {
  for (let i = 0; i < count; i += 1) state.download!({ bytes: 256 * 1024, ms: (256 * 1024 * 8) / kbps });
};
const keyOf = (trackId: string) => state.queued.find((item) => item.id === trackId)!.key;
/** The player starts `trackId`; the song after it in the queue is `nextKey`. */
const starts = async (trackId: string) => {
  const index = state.queued.findIndex((item) => item.id === trackId);
  state.playerState!({ key: state.queued[index]!.key, nextKey: state.queued[index + 1]?.key ?? null });
  // The swap runs as a promise chain off the state event (chunk layout, then the proxy): let it finish.
  for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
};
const servedMime = (trackId: string) => {
  const key = keyOf(trackId);
  return [...state.registered, ...state.swaps].filter((entry) => entry.id === key).at(-1)?.mime;
};

describe("Parrot phone: which copy each song plays", () => {
  beforeEach(async () => {
    await stopPlayback();
    state.queued = [];
    state.registered = [];
    state.swaps = [];
    state.kept = {};
  });

  it("plays the original, drops the next song to the light copy when the connection slows, and climbs back", async () => {
    await playTracks({ token: "t", libraryKey: "k", albumTitle: "Meltway", tracks: [nook, fable, habit] as never, startIndex: 0 });
    log("queued", state.queued.map((item) => ({ id: item.id, key: item.key, mimeType: item.mimeType ?? null })));
    log("registered", state.registered);
    // Nothing measured yet: every song starts on its original (PAR-PLAY-02).
    expect(state.registered.map((entry) => entry.mime)).toEqual([FLAC, FLAC, FLAC]);
    // Each queue entry has its own proxy id, and no mime type: the player reads the format from the copy it gets.
    expect(new Set(state.queued.map((item) => item.key)).size).toBe(3);
    for (const item of state.queued) expect(item).not.toHaveProperty("mimeType");

    // "Nook" plays; the train enters a tunnel while it downloads (~340 kbps, under the original's 1800 kbps).
    downloads(340, 4);
    await starts("tr-nook");
    log("after Nook started on a slow link", state.swaps);
    expect(servedMime("tr-nook")).toBe(FLAC);
    expect(servedMime("tr-fable")).toBe(OPUS);
    // "Breaking the Tide", two songs ahead, drops too: the player may read it before "Fable" starts.
    expect(servedMime("tr-habit")).toBe(OPUS);
    expect(state.swaps).toEqual([
      { id: keyOf("tr-fable"), mime: OPUS },
      { id: keyOf("tr-habit"), mime: OPUS },
    ]);

    // Later state events of the same song (pause, seek, progress) never touch its copy or the next ones again.
    downloads(340, 2);
    await starts("tr-nook");
    expect(state.swaps).toHaveLength(2);

    // Still slow when "Fable" starts: "Breaking the Tide" is settled on the light copy, with no further swap.
    // "Nook" was never swapped.
    await starts("tr-fable");
    expect(servedMime("tr-habit")).toBe(OPUS);
    expect(state.swaps).toHaveLength(2);
    expect(state.swaps.some((entry) => entry.id === keyOf("tr-nook"))).toBe(false);

    // "Somewhere I Wander" is added to the queue while the link is slow: it is registered on the light copy.
    await queueTracks({ token: "t", libraryKey: "k", albumTitle: "Meltway", tracks: [belong] as never, where: "end" });
    expect(servedMime("tr-belong")).toBe(OPUS);

    // The connection is fast again (50 Mbps): the song after the one starting climbs back to its original.
    downloads(50_000, 12);
    await starts("tr-habit");
    log("after the link recovered", state.swaps);
    expect(servedMime("tr-belong")).toBe(FLAC);
    // The song playing kept the copy it started on.
    expect(servedMime("tr-habit")).toBe(OPUS);
  });

  it("the song started now gets its copy from the measured speed; a kept song always plays its kept original", async () => {
    await playTracks({ token: "t", libraryKey: "k", tracks: [nook] as never, startIndex: 0 });
    downloads(300, 4);
    state.kept["tr-fable"] = "tr-fable-flac";
    await playTracks({ token: "t", libraryKey: "k", albumTitle: "Meltway", tracks: [fable, habit] as never, startIndex: 1 });
    log("registered", state.registered);
    // "Breaking the Tide" starts now on a slow link: light copy. "Fable" is kept on the phone: its original.
    expect(servedMime("tr-habit")).toBe(OPUS);
    expect(servedMime("tr-fable")).toBe(FLAC);
    downloads(300, 2);
    await starts("tr-habit");
    await starts("tr-fable");
    expect(state.swaps).toEqual([]);
  });
});
