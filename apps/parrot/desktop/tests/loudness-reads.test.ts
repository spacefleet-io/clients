/**
 * @test-id PARROT-DESKTOP-LOUDNESS-READS-001
 * @level integration (the real loopback server on 127.0.0.1 and the real loudness pass; chunk loaders, the decoder and
 *   the IPC bridge are stand-ins)
 * @bugfix @regression-proof
 * @why PAR-PLAY-02 / PAR-PLAY-04 / PAR-PLAY-03: the loudness pass that runs after an import read every song through the
 *   player's own address. Each read asked the copy picker for the song's copy, as if the song were starting, and filled
 *   the player's chunk cache with every song it measured (the 10 songs of the light-copy e2e test, 27 MB, fit its
 *   48 MB). Playback then read those songs from memory, measured no download once the connection slowed, and never
 *   stepped down to the light copy (2026-11-13 suite run, `light-copy.e2e.test.ts`). The pass now reads each song's own
 *   file from a separate address, through chunks that skip the player's cache, and picks no copy.
 * @covers apps/parrot/desktop/src/main/playbackServer.ts
 * @covers apps/parrot/desktop/src/renderer/src/loudness.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { createParrotChunkReads, type ParrotChunkRef } from "@space/parrot-core";
import type { ParrotLibraryFile, ParrotLibraryTrack } from "@space/parrot-ingest";
import { startParrotPlaybackServer, type ParrotPlaybackServer } from "../src/main/playbackServer";
import { startLoudnessPass } from "../src/renderer/src/loudness";

const ID = "[PARROT-DESKTOP-LOUDNESS-READS-001]";
// The renderer's globals the pass reads (node has neither): the preload bridge and Web Audio's offline decoder.
const renderer = globalThis as { window?: unknown; OfflineAudioContext?: unknown };
const log = (message: string, data?: unknown) => console.log(`${ID} ${message}`, data === undefined ? "" : JSON.stringify(data));

const CHUNK = 1024;
const SIZE = 3 * CHUNK + 100;
const stored = new Uint8Array(SIZE).map((_, i) => i % 251);
const chunks = Array.from({ length: Math.ceil(SIZE / CHUNK) }, (_, idx) => ({
  idx,
  objectKey: `c${idx}`,
  plainOffset: idx * CHUNK,
  plainSize: Math.min(CHUNK, SIZE - idx * CHUNK),
}));
const file: ParrotLibraryFile = { id: "f-original", trackId: "t1", mime: "audio/flac", codec: "flac", sizeBytes: SIZE, chunks };
const chunkOf = (chunk: ParrotChunkRef) => stored.subarray(chunk.plainOffset, chunk.plainOffset + chunk.plainSize);

describe("the loudness pass reads songs beside the player, not through it", () => {
  let server: ParrotPlaybackServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
    delete renderer.window;
    delete renderer.OfflineAudioContext;
  });

  it("serves a song's own file at a reading address, through the reading chunks only", async () => {
    const played: string[] = [];
    const read: string[] = [];
    const lines: string[] = [];
    server = await startParrotPlaybackServer({
      findFile: (id) => (id === file.id ? file : null),
      load: async (chunk) => {
        played.push(chunk.objectKey);
        return chunkOf(chunk);
      },
      loadForReading: async (chunk) => {
        read.push(chunk.objectKey);
        return chunkOf(chunk);
      },
      loadCover: async () => null,
      reads: createParrotChunkReads(),
      log: (line) => lines.push(line),
    });
    const url = server.readUrlFor(file.id);
    log("reading url", url);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/read\/f-original$/);
    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(stored);
    log("chunks", { played, read });
    expect(read).toEqual(["c0", "c1", "c2", "c3"]);
    expect(played).toEqual([]);

    // The player's address still reads through the player's chunks.
    const playing = await fetch(server.urlFor(file.id));
    expect(new Uint8Array(await playing.arrayBuffer())).toEqual(stored);
    expect(played).toEqual(["c0", "c1", "c2", "c3"]);
    expect(read).toHaveLength(4);
    expect((await fetch(server.readUrlFor("f-missing"))).status).toBe(404);
    log("server log", lines);
  });

  it("measures each song from its reading address and never asks for the player's", async () => {
    const played: string[] = [];
    const read: string[] = [];
    server = await startParrotPlaybackServer({
      findFile: (id) => (id === file.id ? file : null),
      load: async (chunk) => {
        played.push(chunk.objectKey);
        return chunkOf(chunk);
      },
      loadForReading: async (chunk) => {
        read.push(chunk.objectKey);
        return chunkOf(chunk);
      },
      loadCover: async () => null,
      reads: createParrotChunkReads(),
      log: () => undefined,
    });
    const playbackAsked: string[] = [];
    const measureAsked: string[] = [];
    const { promise: saved, resolve: onSaved } = Promise.withResolvers<unknown>();
    const running = server;
    renderer.window = {
      parrot: {
        // The player's address: in main it also picks the song's copy (PAR-PLAY-04).
        playbackUrl: async (fileId: string) => {
          playbackAsked.push(fileId);
          return running.urlFor(fileId);
        },
        measureUrl: async (fileId: string) => {
          measureAsked.push(fileId);
          return running.readUrlFor(fileId);
        },
        saveLoudness: async (measured: unknown) => {
          log("saveLoudness", measured);
          return { ok: true, library: { measured } };
        },
      },
    };
    // A 3 s tone at -20 dBFS stands in for the decoded song.
    const rate = 48_000;
    const tone = Float32Array.from({ length: 3 * rate }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / rate));
    const decodedBytes: number[] = [];
    renderer.OfflineAudioContext = class {
      decodeAudioData = async (bytes: ArrayBuffer) => {
        decodedBytes.push(bytes.byteLength);
        return { numberOfChannels: 1, sampleRate: rate, getChannelData: () => tone };
      };
    };
    const track = { id: "t1", fileId: file.id, gainDb: null, durationMs: 3000 } as unknown as ParrotLibraryTrack;
    startLoudnessPass([track], (library) => onSaved(library));
    const library = await saved;
    log("pass", { playbackAsked, measureAsked, played, read, decodedBytes, library });
    expect(measureAsked).toEqual([file.id]);
    expect(playbackAsked).toEqual([]);
    expect(decodedBytes).toEqual([SIZE]);
    expect(read).toEqual(["c0", "c1", "c2", "c3"]);
    expect(played).toEqual([]);
  });

  // @req PAR-LYR-07
  it("holds a file's chunks until the reading of it ends, so a step replacing them meanwhile waits", async () => {
    // 2026-11-21 (Daft Punk import): lyrics:file removed a song's old chunks while the loudness pass was reading them,
    // and the pass failed with `download_source_missing`. That pass is gone (PAR-FMT-01); a step that replaces a file's
    // chunks (a file stored whole split later) waits on the same hold (`reads.free`) before removing the old ones.
    const reads = createParrotChunkReads();
    const oldKeys = chunks.map((chunk) => chunk.objectKey);
    const { promise: lastAsked, resolve: onLastAsked } = Promise.withResolvers<void>();
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
    server = await startParrotPlaybackServer({
      findFile: (id) => (id === file.id ? file : null),
      load: async (chunk) => chunkOf(chunk),
      loadForReading: async (chunk) => {
        if (chunk.objectKey === "c3") {
          onLastAsked();
          await gate;
        }
        return chunkOf(chunk);
      },
      loadCover: async () => null,
      reads,
      log: (line) => log("server", line),
    });
    const reading = fetch(server.readUrlFor(file.id)).then(async (res) => new Uint8Array(await res.arrayBuffer()));
    await lastAsked;
    log("phase: the pass is mid-file, a replacing step waits for the old chunks");
    const removed: string[][] = [];
    const removal = reads.free(oldKeys, 10_000).then((free) => {
      log("old chunks free", free);
      removed.push(oldKeys);
    });
    // The hold itself is the signal: the old chunks read as busy, and nothing was removed.
    expect(await reads.free(oldKeys, 0)).toBe(false);
    log("removed while the read runs", removed);
    expect(removed).toEqual([]);
    openGate();
    expect(await reading).toEqual(stored);
    await removal;
    log("removed after the read ended", removed);
    expect(removed).toEqual([oldKeys]);
    expect(await reads.free(oldKeys, 0)).toBe(true);
  });
});
