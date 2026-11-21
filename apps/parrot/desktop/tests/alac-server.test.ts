/**
 * @test-id PARROT-DESKTOP-ALAC-SERVER-001
 * @level unit
 * @why PAR-FMT-01: Chromium cannot play Apple Lossless, so main's loopback server answers an ALAC song's address with
 *   the WAV it decodes to, byte ranges included (the player seeks with them). The real server runs on 127.0.0.1 over a
 *   real ALAC file (ffmpeg `-c:a alac`) cut into stored chunks; only the chunk loader is replaced.
 * @covers apps/parrot/desktop/src/main/playbackServer.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createParrotChunkReads, decodeAlacMp4 } from "@space/parrot-core";
import type { ParrotLibraryFile } from "@space/parrot-ingest";
import { startParrotPlaybackServer, type ParrotPlaybackServer } from "../src/main/playbackServer";

const log = (message: string, data?: unknown) => console.log(`[PARROT-DESKTOP-ALAC-SERVER-001] ${message}`, data === undefined ? "" : JSON.stringify(data));
const stored = new Uint8Array(readFileSync(join(__dirname, "../../../../packages/parrot-core/tests/fixtures/alac/s16-44100-stereo.m4a")));
const CHUNK = 4096;
const chunks = Array.from({ length: Math.ceil(stored.length / CHUNK) }, (_, idx) => ({
  idx,
  objectKey: `c${idx}`,
  plainOffset: idx * CHUNK,
  plainSize: Math.min(CHUNK, stored.length - idx * CHUNK),
}));
const file: ParrotLibraryFile = { id: "f-alac", trackId: "t1", mime: "audio/mp4; codecs=alac", codec: "alac", sizeBytes: stored.length, chunks };

// The whole WAV the song decodes to: header, then interleaved 16-bit little-endian samples.
const wav = (() => {
  const decoded = decodeAlacMp4(stored);
  const pcm = Buffer.alloc(decoded.samples[0]!.length * decoded.channels * 2);
  let at = 0;
  for (let i = 0; i < decoded.samples[0]!.length; i += 1) for (const channel of decoded.samples) at = pcm.writeInt16LE(channel[i]!, at);
  return pcm;
})();

describe("parrot playback server, Apple Lossless", () => {
  let server: ParrotPlaybackServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("serves an ALAC song as WAV, whole and by byte range, and leaves other songs as stored", async () => {
    const loaded: string[] = [];
    const lines: string[] = [];
    server = await startParrotPlaybackServer({
      findFile: (id) => (id === file.id ? file : id === "f-aac" ? { ...file, id: "f-aac", mime: "audio/mp4", codec: "aac" } : null),
      load: async (chunk) => {
        loaded.push(chunk.objectKey);
        return stored.subarray(chunk.plainOffset, chunk.plainOffset + chunk.plainSize);
      },
      loadForReading: async () => {
        throw new Error("the player's address never reads through the loudness pass's chunks");
      },
      loadCover: async () => null,
      reads: createParrotChunkReads(),
      log: (line) => lines.push(line),
    });

    const whole = await fetch(server.urlFor(file.id));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/wav");
    const body = Buffer.from(await whole.arrayBuffer());
    expect(body.subarray(0, 4).toString()).toBe("RIFF");
    expect(body.subarray(44).equals(wav)).toBe(true);
    const size = body.length;

    // A seek: the player asks from the middle of the song.
    const from = 44 + 2 * 2 * 7_000 + 3;
    const seek = await fetch(server.urlFor(file.id), { headers: { Range: `bytes=${from}-` } });
    expect(seek.status).toBe(206);
    expect(seek.headers.get("content-range")).toBe(`bytes ${from}-${size - 1}/${size}`);
    expect(Buffer.from(await seek.arrayBuffer()).equals(body.subarray(from))).toBe(true);

    loaded.length = 0;
    const late = await fetch(server.urlFor(file.id), { headers: { Range: `bytes=${size - 100}-${size - 1}` } });
    expect(Buffer.from(await late.arrayBuffer()).equals(body.subarray(size - 100))).toBe(true);
    log("chunks read for the last 100 bytes", loaded);
    // The frame table is cached; the end of the song needs only the stored chunks of its last frames.
    expect(loaded.length).toBeLessThan(chunks.length / 2);

    const head = await fetch(server.urlFor(file.id), { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(size));
    expect(size).toBe(44 + wav.length);

    const aac = await fetch(server.urlFor("f-aac"), { method: "HEAD" });
    expect(aac.headers.get("content-type")).toBe("audio/mp4");
    expect(aac.headers.get("content-length")).toBe(String(stored.length));
    log("server log", lines);
  });
});
