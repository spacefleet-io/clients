/**
 * @test-id PARROT-CORE-FILERANGE-001
 * @level unit
 * @why The desktop's loopback server and the web player's service worker answer the audio element's `Range:`
 *   requests from these two functions (PAR-PLAY-01, PLAT-WEB-08). A wrong range answer stalls or garbles a song
 *   mid-play, and a seek that loads chunks it does not need wastes the user's bandwidth.
 * @covers packages/parrot-core/src/fileRange.ts
 */
import { describe, expect, it } from "bun:test";
import { parseByteRange, readParrotFileRange, type ParrotChunkRef } from "../src/fileRange";

const SIZE = 10;
// A 25-byte file in chunks of 10, 10 and 5 bytes; byte i holds the value i.
const chunks: ParrotChunkRef[] = [
  { objectKey: "c0", plainOffset: 0, plainSize: SIZE },
  { objectKey: "c1", plainOffset: 10, plainSize: SIZE },
  { objectKey: "c2", plainOffset: 20, plainSize: 5 },
];
const plainOf = (chunk: ParrotChunkRef) => Uint8Array.from({ length: chunk.plainSize }, (_, i) => chunk.plainOffset + i);

const collect = async (parts: AsyncGenerator<Uint8Array>) => {
  const out: number[] = [];
  for await (const part of parts) out.push(...part);
  return out;
};

describe("parseByteRange", () => {
  it("serves the whole file without a header", () => {
    expect(parseByteRange(null, 25)).toEqual({ start: 0, end: 24 });
  });

  it("reads open, closed and suffix ranges, clamping the end to the file", () => {
    expect(parseByteRange("bytes=5-", 25)).toEqual({ start: 5, end: 24 });
    expect(parseByteRange("bytes=5-9", 25)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange("bytes=20-99", 25)).toEqual({ start: 20, end: 24 });
    expect(parseByteRange("bytes=-5", 25)).toEqual({ start: 20, end: 24 });
    expect(parseByteRange("bytes=-99", 25)).toEqual({ start: 0, end: 24 });
  });

  it("refuses ranges it cannot serve", () => {
    expect(parseByteRange("bytes=25-", 25)).toBeNull();
    expect(parseByteRange("bytes=9-5", 25)).toBeNull();
    expect(parseByteRange("bytes=-", 25)).toBeNull();
    expect(parseByteRange("bytes=-0", 25)).toBeNull();
    expect(parseByteRange("bytes=0-1,4-5", 25)).toBeNull();
    expect(parseByteRange("items=0-1", 25)).toBeNull();
    expect(parseByteRange(null, 0)).toBeNull();
  });
});

describe("readParrotFileRange", () => {
  it("returns exactly the asked bytes across chunk borders, loading only the chunks they cover", async () => {
    const loaded: string[] = [];
    const load = async (chunk: ParrotChunkRef) => {
      loaded.push(chunk.objectKey);
      return plainOf(chunk);
    };
    expect(await collect(readParrotFileRange(chunks, 8, 21, load))).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(loaded).toEqual(["c0", "c1", "c2"]);
    loaded.length = 0;
    expect(await collect(readParrotFileRange(chunks, 12, 14, load))).toEqual([12, 13, 14]);
    expect(loaded).toEqual(["c1"]);
  });

  it("passes a chunk's load failure to the reader", async () => {
    const load = async (chunk: ParrotChunkRef) => {
      if (chunk.objectKey === "c1") throw new Error("gone");
      return plainOf(chunk);
    };
    await expect(collect(readParrotFileRange(chunks, 0, 24, load))).rejects.toThrow("gone");
  });
});
