/**
 * @test-id LIB-DB-PAYLOAD-COMPRESSION-001
 * @level unit
 * @why Storage format v2 (LIB-FMT-07) puts a compressed frame INSIDE the AES-GCM plaintext of
 *   every saved copy and of big changes. The whole compatibility story hangs on three
 *   properties: (1) a frame round-trips, (2) a v1 payload (SQLite file / op JSON) is never
 *   mistaken for a frame and passes through untouched, (3) a frame this build cannot read fails
 *   loudly instead of being handed to SQLite / JSON.parse as garbage.
 *
 * @req LIB-FMT-07[badger-desktop,runtime]
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  COMPRESSED_FRAME_HEADER_SIZE,
  COMPRESSION_CODEC,
  COMPRESSION_LEVEL,
  CompressedFrameError,
  decodeCompressedFrame,
  encodeCompressedFrame,
  isCompressedFrame,
  type DeflateCodec,
} from "../src/payloadCompression";

const SUITE = "payloadCompression";

const codec: DeflateCodec = {
  deflateRaw: (bytes) => new Uint8Array(deflateRawSync(bytes, { level: COMPRESSION_LEVEL })),
  inflateRaw: (bytes) => new Uint8Array(inflateRawSync(bytes)),
};

const sqliteHeader = new TextEncoder().encode("SQLite format 3\0");
const text = (s: string) => new TextEncoder().encode(s);

const fakeDb = (rows: number) => {
  const out = new Uint8Array(sqliteHeader.length + rows * 40);
  out.set(sqliteHeader, 0);
  for (let i = 0; i < rows; i += 1) out.set(text(`chunk-row-${i % 97}-aaaaaaaaaaaaaaaaaaaaaaaa`), sqliteHeader.length + i * 40);
  return out;
};

const bigOp = () =>
  text(JSON.stringify({ id: "op-1", type: "media.add", payload: { title: "x".repeat(2000), tags: Array(50).fill("tag") } }));

describe("payloadCompression (LIB-FMT-07)", () => {
  it("frame round-trips a SQLite-shaped payload and is smaller", () => {
    const raw = fakeDb(4000);
    const framed = encodeCompressedFrame(raw, codec);
    console.info(`[${SUITE}:roundtrip] raw=${raw.length} framed=${framed.length} head=${Array.from(framed.subarray(0, 3))}`);
    expect(isCompressedFrame(framed)).toBe(true);
    expect(framed[2]).toBe(COMPRESSION_CODEC.deflateRaw);
    expect(framed.length).toBeLessThan(raw.length / 4);
    expect(Buffer.from(decodeCompressedFrame(framed, codec)).equals(Buffer.from(raw))).toBe(true);
  });

  it("v1 payloads (SQLite header, op JSON) are not frames and pass through untouched", () => {
    const db = fakeDb(10);
    const op = bigOp();
    console.info(`[${SUITE}:v1] sqliteFrame=${isCompressedFrame(db)} jsonFrame=${isCompressedFrame(op)}`);
    expect(isCompressedFrame(db)).toBe(false);
    expect(isCompressedFrame(op)).toBe(false);
    expect(decodeCompressedFrame(db, codec)).toBe(db);
    expect(decodeCompressedFrame(op, codec)).toBe(op);
  });

  it("tiny and empty inputs never read as frames", () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([0, 0x5a])]) {
      console.info(`[${SUITE}:tiny] len=${bytes.length}`);
      expect(isCompressedFrame(bytes)).toBe(false);
      expect(decodeCompressedFrame(bytes, codec)).toBe(bytes);
    }
  });

  it("an empty payload round-trips through a frame", () => {
    const framed = encodeCompressedFrame(new Uint8Array(0), codec);
    expect(framed.length).toBeGreaterThan(COMPRESSED_FRAME_HEADER_SIZE - 1);
    expect(decodeCompressedFrame(framed, codec).length).toBe(0);
  });

  it("unknown codec id is a CompressedFrameError, not garbage", () => {
    const framed = encodeCompressedFrame(fakeDb(10), codec);
    framed[2] = 9;
    console.info(`[${SUITE}:codec] codecByte=${framed[2]}`);
    expect(() => decodeCompressedFrame(framed, codec)).toThrow(CompressedFrameError);
    expect(() => decodeCompressedFrame(framed, codec)).toThrow(/unknown_compression_codec:9/);
  });

  it("corrupt deflate stream is a CompressedFrameError", () => {
    const framed = encodeCompressedFrame(fakeDb(2000), codec);
    const broken = framed.slice(0, 40);
    broken.fill(0xff, 10);
    console.info(`[${SUITE}:corrupt] framedLen=${framed.length} brokenLen=${broken.length}`);
    expect(() => decodeCompressedFrame(broken, codec)).toThrow(/corrupt_compressed_frame/);
  });

  it("every op is framed, small ones included, and round-trips", () => {
    const small = text(JSON.stringify({ id: "p", type: "media.progress", positionMs: 1234 }));
    const big = bigOp();
    const smallOut = encodeCompressedFrame(small, codec);
    const bigOut = encodeCompressedFrame(big, codec);
    console.info(`[${SUITE}:ops] small ${small.length}->${smallOut.length} big ${big.length}->${bigOut.length}`);
    expect(isCompressedFrame(smallOut)).toBe(true);
    expect(isCompressedFrame(bigOut)).toBe(true);
    expect(bigOut.length).toBeLessThan(big.length / 3);
    expect(Buffer.from(decodeCompressedFrame(smallOut, codec)).equals(Buffer.from(small))).toBe(true);
    expect(Buffer.from(decodeCompressedFrame(bigOut, codec)).equals(Buffer.from(big))).toBe(true);
  });
});
