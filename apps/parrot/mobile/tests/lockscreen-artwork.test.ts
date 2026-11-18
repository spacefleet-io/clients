/**
 * @test-id PARROT-MOBILE-LOCKSCREEN-ARTWORK-001
 * @level unit
 * @req PLAY-OSMEDIA-01[parrot]
 * @req PAR-META-04[parrot]
 * @why PLAY-OSMEDIA-01 item 2: the notification / lock-screen media card shows the album's cover from the decrypted
 *   copy on the phone, as a local file:// address, never a remote URL. Starting a song fetches its album's LARGE cover
 *   (downloading it when not kept yet) and hands its file to the native player as each queued song's `artworkUri`;
 *   songs of other albums carry theirs when already kept, else none (the card then has no picture). The native player,
 *   the media proxy and the library are replaced; playTracks is the real code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotCoverKeys } from "@space/parrot-core";

const state = vi.hoisted(() => ({
  queued: null as null | { items: Array<Record<string, unknown>>; start: number },
  coverAsks: [] as Array<string | null | undefined>,
  kept: {} as Record<string, string>,
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-LOCKSCREEN-ARTWORK-001] ${step}`, JSON.stringify(detail));

vi.mock("@space/shared/api", () => ({ listProfiles: async () => ({ profiles: [{ id: "profile-main", isMain: true }] }) }));
vi.mock("@space/mobile-media-proxy", () => ({
  MediaProxy: {
    start: async () => undefined,
    registerChunkedFile: async (file: { id: string }) => `http://127.0.0.1:9999/${file.id}`,
    onDownload: () => () => undefined,
  },
  resolveGatewayCandidates: async () => ["http://gateway.test"],
}));
vi.mock("@space/mobile-audio-playback", () => ({
  AudioPlayback: {
    setQueue: async (items: Array<Record<string, unknown>>, start: number) => {
      state.queued = { items, start };
      return { state: "buffering" };
    },
    setShuffle: async () => ({ state: "buffering" }),
    setLimiting: async () => undefined,
    onState: () => ({ remove: () => undefined }),
  },
}));
vi.mock("../src/lib/evenVolume", () => ({ getEvenVolume: () => ({ on: false, level: "normal" }), subscribeEvenVolume: () => () => undefined }));
vi.mock("../src/lib/library", () => ({
  trackFiles: async (trackId: string) =>
    trackId === "tr-nofile"
      ? []
      : [{ id: `file-${trackId}`, trackId, mime: "audio/flac", lossless: true, bitrateKbps: null, sizeBytes: 1000, lightCopy: false, createdAt: 0 }],
  chunkedFile: async (file: { id: string; mime: string; sizeBytes: number }) => ({ ...file, chunks: [] }),
  coverUri: async (key: string | null | undefined) => {
    state.coverAsks.push(key);
    return key ? `file:///data/app/cache/parrot-covers/${key.replace(/\//g, "_")}.img` : null;
  },
  keptCoverUri: (key: string | null | undefined) => (key ? (state.kept[key] ?? null) : null),
}));
// Nothing is kept on the phone here (the keeping module drives native downloads), so every song streams.
vi.mock("../src/lib/kept", () => ({ keptFileIdFor: () => null }));
// The stream limit (ACCT-STREAM-01..04) has its own test (stream-slot.test.ts): every start gets its place here.
vi.mock("../src/lib/streamSlot", () => ({ acquireStream: async () => "play", releaseStream: async () => undefined }));

import { playTracks } from "../src/lib/playback";

const lo = { coverObjectKey: "assets/large-lo", coverThumbObjectKey: "assets/small-lo" };
const track = (id: string, albumId: string, cover: ParrotCoverKeys | null) => ({
  id,
  albumId,
  title: id,
  artistName: "Juniper Skies",
  number: 1,
  disc: 1,
  durationMs: 1000,
  cover,
});

describe("the lock-screen card's cover", () => {
  beforeEach(() => {
    state.queued = null;
    state.coverAsks = [];
    state.kept = {};
  });

  it("gives every song of the album the large cover's local file", async () => {
    const tracks = [track("tr-1", "al-lo", lo), track("tr-nofile", "al-lo", lo), track("tr-2", "al-lo", lo)];
    await playTracks({ token: "t", libraryKey: "k", albumTitle: "Low Orbit", tracks: tracks as never, startIndex: 2 });
    log("queued", state.queued);
    log("cover asks", state.coverAsks);
    expect(state.coverAsks).toEqual(["assets/large-lo"]);
    expect(state.queued!.start).toBe(1);
    expect(state.queued!.items.map((item) => item.artworkUri)).toEqual([
      "file:///data/app/cache/parrot-covers/assets_large-lo.img",
      "file:///data/app/cache/parrot-covers/assets_large-lo.img",
    ]);
    for (const item of state.queued!.items) expect(String(item.artworkUri)).toMatch(/^file:\/\//);
    expect(state.queued!.items[0]).toMatchObject({ id: "tr-1", title: "tr-1", artist: "Juniper Skies", album: "Low Orbit" });
  });

  it("in a list of songs from several albums, the other albums' covers come along only when already kept", async () => {
    state.kept["assets/large-kept"] = "file:///data/app/cache/parrot-covers/assets_large-kept.img";
    const kept = { coverObjectKey: "assets/large-kept", coverThumbObjectKey: null };
    const notKept = { coverObjectKey: "assets/large-far", coverThumbObjectKey: "assets/small-far" };
    const tracks = [track("tr-a", "al-lo", lo), track("tr-b", "al-kept", kept), track("tr-c", "al-far", notKept), track("tr-d", "al-none", null)];
    await playTracks({ token: "t", libraryKey: "k", tracks: tracks as never, startIndex: 0 });
    const artwork = state.queued!.items.map((item) => [item.id, item.artworkUri ?? null]);
    log("artwork", artwork);
    expect(state.coverAsks).toEqual(["assets/large-lo"]);
    expect(artwork).toEqual([
      ["tr-a", "file:///data/app/cache/parrot-covers/assets_large-lo.img"],
      ["tr-b", "file:///data/app/cache/parrot-covers/assets_large-kept.img"],
      ["tr-c", null],
      ["tr-d", null],
    ]);
    // An item without a picture sends no field (the bridge JSON drops it), so the native side sets no artwork.
    expect(JSON.parse(JSON.stringify(state.queued!.items[3]))).not.toHaveProperty("artworkUri");
  });
});
