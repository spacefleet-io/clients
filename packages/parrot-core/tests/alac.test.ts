/**
 * @test-id PARROT-CORE-ALAC-001
 * @level unit
 * @why Chromium and Android ship no ALAC decoder, so Parrot decodes Apple Lossless itself (PAR-FMT-01). A lossless
 *   decoder that is off by one bit is broken; a WAV range that is off by one byte garbles the song after a seek; an
 *   ignored edit list leaves a click of silence between gapless songs (PAR-PLAY-03).
 * @covers packages/parrot-core/src/alac.ts
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alacWavLayout, decodeAlacMp4, indexAlacMp4, isAlacCodec, readAlacAsWav } from "../src/alac";

const dir = join(import.meta.dir, "fixtures", "alac");
// Each line: fixture name, then the sha256 of ffmpeg's decode as interleaved little-endian PCM (s16le or s24le).
const references = readFileSync(join(dir, "reference.sha256"), "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split(" ") as [string, string]);
const fixture = (name: string) => new Uint8Array(readFileSync(join(dir, `${name}.m4a`)));

const pcmOf = (samples: Int32Array[], bytesPerSample: number) => {
  const out = new Uint8Array(samples[0]!.length * samples.length * bytesPerSample);
  let at = 0;
  for (let i = 0; i < samples[0]!.length; i += 1) {
    for (const channel of samples) {
      for (let b = 0; b < bytesPerSample; b += 1) out[at++] = (channel[i]! >> (8 * b)) & 0xff;
    }
  }
  return out;
};

const collect = async (parts: AsyncGenerator<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const part of parts) chunks.push(part);
  return Buffer.concat(chunks);
};

const readerOver = (bytes: Uint8Array) => ({
  read: async (start: number, end: number) => bytes.slice(start, end + 1),
  // Hands the stored bytes out in odd-sized pieces, as chunked storage does.
  async *readStream(start: number, end: number) {
    for (let at = start; at <= end; at += 1013) yield bytes.slice(at, Math.min(end + 1, at + 1013));
  },
});

// Rewrites the first edit-list entry of an MP4 (same length, so every offset stays put).
const withEdit = (bytes: Uint8Array, mediaTime: number, duration: number) => {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const elst = Buffer.from(copy).indexOf("elst") + 4;
  expect(copy[elst]).toBe(0); // version 0: 32-bit fields
  view.setUint32(elst + 8, duration);
  view.setUint32(elst + 12, mediaTime);
  return copy;
};
const movieTimescale = (bytes: Uint8Array) => {
  const mvhd = Buffer.from(bytes).indexOf("mvhd") + 4;
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(mvhd + (bytes[mvhd] === 1 ? 20 : 12));
};

describe("ALAC decoding", () => {
  it("knows which stored codec it decodes", () => {
    expect(isAlacCodec("ALAC")).toBe(true);
    expect(isAlacCodec("alac")).toBe(true);
    expect(isAlacCodec("aac")).toBe(false);
    expect(isAlacCodec(null)).toBe(false);
  });

  for (const [name, reference] of references) {
    it(`decodes ${name} bit for bit like ffmpeg`, () => {
      const decoded = decodeAlacMp4(fixture(name));
      const [, bits, rate, layout] = name.match(/^s(\d+)-(\d+)-(\w+)$/)!;
      expect(decoded.bitDepth).toBe(Number(bits));
      expect(decoded.sampleRate).toBe(Number(rate));
      expect(decoded.channels).toBe(layout === "stereo" ? 2 : 1);
      const hash = createHash("sha256")
        .update(pcmOf(decoded.samples, decoded.bitDepth === 16 ? 2 : 3))
        .digest("hex");
      expect(hash).toBe(reference);
    });
  }
});

describe("readAlacAsWav", () => {
  for (const name of ["s16-44100-stereo", "s24-48000-mono", "s24-96000-stereo"]) {
    it(`serves any byte range of ${name} as the matching slice of the whole WAV`, async () => {
      const bytes = fixture(name);
      const { read, readStream } = readerOver(bytes);
      const index = await indexAlacMp4(read, bytes.length);
      const layout = alacWavLayout(index);
      const decoded = decodeAlacMp4(bytes);
      const whole = Buffer.concat([layout.header, pcmOf(decoded.samples, layout.bytesPerSample)]);
      expect(layout.size).toBe(whole.length);
      // RIFF header a player reads: format, channels, rate, bits.
      const header = new DataView(layout.header.buffer);
      expect(Buffer.from(layout.header.subarray(0, 4)).toString()).toBe("RIFF");
      expect(header.getUint16(22, true)).toBe(decoded.channels);
      expect(header.getUint32(24, true)).toBe(decoded.sampleRate);
      expect(header.getUint16(34, true)).toBe(layout.bytesPerSample * 8);
      expect(header.getUint32(40, true)).toBe(whole.length - 44);

      let seed = 7;
      const random = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      const ranges: [number, number][] = [
        [0, whole.length - 1],
        [0, 10],
        [3, 43],
        [40, 50],
        [44, 44],
        [45, 46],
        [whole.length - 5, whole.length - 1],
      ];
      for (let i = 0; i < 20; i += 1) {
        const start = random(whole.length);
        ranges.push([start, Math.min(whole.length - 1, start + random(40_000))]);
      }
      for (const [start, end] of ranges) {
        const served = await collect(readAlacAsWav(index, start, end, readStream));
        expect(served.length).toBe(end - start + 1);
        expect(served.equals(whole.subarray(start, end + 1))).toBe(true);
      }
    });
  }
});

describe("edit list (gapless)", () => {
  it("drops the encoder delay and the padding the edit list cuts, in the decode and in the served WAV", async () => {
    const original = fixture("s16-44100-stereo");
    const full = decodeAlacMp4(original);
    const timescale = movieTimescale(original);
    const skip = 1000;
    const kept = 10_000;
    const edited = withEdit(original, skip, Math.round((kept * timescale) / 44_100));
    const keptFrames = Math.round((Math.round((kept * timescale) / 44_100) * 44_100) / timescale);

    const decoded = decodeAlacMp4(edited);
    expect(decoded.samples[0]!.length).toBe(keptFrames);
    for (let c = 0; c < 2; c += 1) {
      expect(decoded.samples[c]).toEqual(full.samples[c]!.subarray(skip, skip + keptFrames));
    }

    const { read, readStream } = readerOver(edited);
    const index = await indexAlacMp4(read, edited.length);
    expect(index.skipFrames).toBe(skip);
    expect(index.totalFrames).toBe(keptFrames);
    const layout = alacWavLayout(index);
    const served = await collect(readAlacAsWav(index, 0, layout.size - 1, readStream));
    expect(served.equals(Buffer.concat([layout.header, pcmOf(decoded.samples, 2)]))).toBe(true);
  });
});
