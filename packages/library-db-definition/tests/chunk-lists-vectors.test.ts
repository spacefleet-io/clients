/**
 * @test-id LIB-DB-CHUNK-LISTS-001
 * @level unit
 * @why Packed chunk lists (LIB-FMT-11) are decoded by four codecs (TS, Kotlin, Swift, Python) from one byte layout.
 *   `test-vectors/chunk-lists.json` is that contract. This suite proves the TS codec reproduces every vector, that a
 *   list round-trips back to the player's `chunks[]`, that corrupt lists fail loud (LIB-OPS-01), and re-derives the
 *   seed keys (node:crypto HMAC) and varints by hand so the vectors are not only the codec agreeing with itself.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChunkListFormatError,
  chunkListFromJson,
  chunkListKeys,
  chunkListToJson,
  packChunkList,
  packSeededChunkList,
  seedChunkKey,
  unpackChunkList,
  type ChunkRef,
  type PackedChunkList,
  type PackedChunkListJson,
} from "../src/chunkLists";
import { translateV3MediaUpsert, type TranslatedMediaUpsert } from "../src/ops";
import type { MediaUpsertOp } from "@space/shared/libraryOps";

const SUITE = "chunk-lists-vectors";
type Expected = Record<string, unknown> & { json: PackedChunkListJson; decodedStarts: Array<number | null> };
type Vectors = {
  explicit: Array<{ name: string; note: string; input: { chunks: ChunkRef[] }; expected: Expected }>;
  seeded: Array<{
    name: string;
    note: string;
    input: { placementId: string; seedHex: string; sizes: Array<number | null>; starts: Array<number | null> };
    expected: Expected;
  }>;
  seedKeys: Array<{ seedHex: string; placementId: string; index: number; key: string }>;
  invalid: Array<{ name: string; note: string; json: PackedChunkListJson }>;
  translations: Array<{ name: string; note: string; input: MediaUpsertOp; expected: TranslatedMediaUpsert }>;
};
const vectors: Vectors = JSON.parse(readFileSync(join(__dirname, "../test-vectors/chunk-lists.json"), "utf8"));
const hex = (bytes: Uint8Array | null) => (bytes === null ? null : Buffer.from(bytes).toString("hex"));
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

const dump = (label: string, data: unknown) => console.info(`[${SUITE}:${label}] ${JSON.stringify(data)}`);

const expectPacked = (label: string, list: PackedChunkList, expected: Record<string, unknown>) => {
  const actual = {
    placementId: list.placementId,
    keyMode: list.keyMode,
    count: list.count,
    keyDataHex: hex(list.keyData),
    sizesHex: hex(list.sizes),
    startsHex: hex(list.starts),
  };
  dump(`${label}:packed`, actual);
  expect(actual).toEqual({
    placementId: expected.placementId,
    keyMode: expected.keyMode,
    count: expected.count,
    keyDataHex: expected.keyDataHex,
    sizesHex: expected.sizesHex,
    startsHex: expected.startsHex,
  });
  expect(chunkListToJson(list)).toEqual(expected.json);
  expect(chunkListKeys(list)).toEqual(expected.keys);
};

describe("packed chunk list vectors", () => {
  it.each(vectors.explicit)("explicit $name packs, decodes and round-trips", ({ name, input, expected, note }) => {
    dump(`${name}:input`, { note, chunks: input.chunks.length });
    expectPacked(name, packChunkList(input.chunks), expected);

    const fromJson = chunkListFromJson(expected.json);
    const unpacked = unpackChunkList(fromJson);
    const want = input.chunks.map((c, i) => ({ ...c, startSeconds: expected.decodedStarts[i] }));
    dump(`${name}:unpacked`, unpacked);
    expect(unpacked).toEqual(want);
    // Start times survive to the millisecond.
    input.chunks.forEach((c, i) => {
      if (c.startSeconds === null) expect(unpacked[i]!.startSeconds).toBeNull();
      else expect(Math.abs(unpacked[i]!.startSeconds! - c.startSeconds)).toBeLessThanOrEqual(0.0005);
    });
    // Packing what was unpacked gives the same bytes (stable on re-conversion).
    expect(chunkListToJson(packChunkList(unpacked))).toEqual(expected.json);
  });

  it.each(vectors.seeded)("seeded $name packs and derives its keys", ({ name, input, expected }) => {
    const list = packSeededChunkList({ ...input, seed: fromHex(input.seedHex) });
    expectPacked(name, list, expected);
    const unpacked = unpackChunkList(chunkListFromJson(expected.json));
    expect(unpacked.map((c) => c.sizeBytes)).toEqual(input.sizes);
    expect(unpacked.map((c) => c.startSeconds)).toEqual(expected.decodedStarts);
  });

  it("seed keys match an independent HMAC-SHA256 (node:crypto)", () => {
    for (const v of vectors.seedKeys) {
      const message = Buffer.alloc(10);
      message.write("chunk:", 0, "ascii");
      message.writeUInt32BE(v.index, 6);
      const h = createHmac("sha256", fromHex(v.seedHex)).update(message).digest("hex").slice(0, 32);
      const independent = `media/${v.placementId}/${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      dump("seed-key", { index: v.index, key: v.key, independent });
      expect(independent).toBe(v.key);
      expect(seedChunkKey(fromHex(v.seedHex), v.placementId, v.index)).toBe(v.key);
    }
  });

  it("varints match a hand encoding", () => {
    // sizes [0, null, 2^32 + 7] → varint(1), varint(0), varint(2^32 + 8).
    const mixed = vectors.explicit.find((v) => v.name === "mixed-placements-and-nulls")!;
    const big = 2 ** 32 + 8;
    const bigBytes: number[] = [];
    for (let n = big; ; n = Math.floor(n / 128)) {
      if (n < 128) {
        bigBytes.push(n);
        break;
      }
      bigBytes.push((n % 128) | 0x80);
    }
    const want = Buffer.from([0x01, 0x00, ...bigBytes]).toString("hex");
    dump("varint-hand", { want, vector: mixed.expected.sizesHex });
    expect(mixed.expected.sizesHex).toBe(want);
    // starts [10 s, null, 4.5 s] → zigzag(10000)+1 = 20001, 0, zigzag(4500-10000)+1 = 11000.
    expect(mixed.expected.startsHex).toBe(Buffer.from([0xa1, 0x9c, 0x01, 0x00, 0xf8, 0x55]).toString("hex"));
  });

  it.each(vectors.invalid)("invalid $name is refused, never skipped", ({ name, json, note }) => {
    let error: unknown;
    try {
      unpackChunkList(chunkListFromJson(json));
    } catch (caught) {
      error = caught;
    }
    dump(`${name}:refused`, { note, error: String(error) });
    expect(error).toBeInstanceOf(ChunkListFormatError);
  });

  it("refuses a seed that is not 16 bytes and a key with a line break", () => {
    expect(() => packSeededChunkList({ placementId: "p", seed: new Uint8Array(8), sizes: [1], starts: [null] })).toThrow(ChunkListFormatError);
    expect(() => packChunkList([{ key: "a\nb", sizeBytes: 1, startSeconds: null }])).toThrow(ChunkListFormatError);
  });

  it("a 3-hour 2160p list stays small", () => {
    const chunks: ChunkRef[] = Array.from({ length: 900 }, (_, i) => ({
      key: `media/p1/${crypto.randomUUID()}`,
      sizeBytes: 8_000_000 + i,
      startSeconds: i * 12,
    }));
    const json = JSON.stringify(chunkListToJson(packChunkList(chunks)));
    const rowsJson = JSON.stringify(chunks);
    dump("size", { chunks: chunks.length, packedJsonBytes: json.length, rowsJsonBytes: rowsJson.length });
    expect(json.length).toBeLessThan(30_000);
    expect(unpackChunkList(chunkListFromJson(JSON.parse(json)))).toEqual(chunks);
  });
});

describe("v3 media.upsert translation vectors (LIB-FMT-11)", () => {
  it.each(vectors.translations)("$name", (v) => {
    const actual = translateV3MediaUpsert(v.input);
    dump(`translation:${v.name}`, {
      sets: actual.playbackSets.map((set) => set.payload.fileId),
      keep: actual.prune.keepFileIds,
    });
    expect(actual).toEqual(v.expected);
  });

  it("has the three translation cases", () => {
    expect(vectors.translations.map((v) => v.name)).toEqual([
      "movie-two-files",
      "empty-playback-prunes-all",
      "row-file-not-in-files",
    ]);
  });
});
