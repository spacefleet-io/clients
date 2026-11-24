/**
 * Packed chunk lists (LIB-FMT-11): one format's or one audio track's whole list of chunks as one row
 * (`media_chunk_lists`) and one JSON object in op stream 4, instead of one row per chunk.
 *
 * Byte layout, shared with the Kotlin, Swift and Python codecs (`test-vectors/chunk-lists.json` is the contract;
 * any change here edits the vectors first):
 *   - `sizes`: one unsigned LEB128 varint per chunk holding `sizeBytes + 1`; `0` means the size is unknown (null).
 *   - `starts`: `null` when no chunk has a start time. Otherwise one unsigned LEB128 varint per chunk: `0` for a chunk
 *     without a start time, else `zigzag(ms - previousMs) + 1`, where `ms` is the start rounded to whole milliseconds
 *     and `previousMs` is the previous chunk's that HAD a start (0 before the first).
 *   - key mode 0: every key's UTF-8 text, joined by `\n` (no key may contain `\n`). Used for any list whose keys are not
 *     all `media/<placementId>/<lowercase uuid>` with one placement (old shard keys, test keys, mixed placements).
 *   - key mode 1: 16 raw UUID bytes per chunk; key i = `media/<placementId>/<uuid i>`.
 *   - key mode 2: one 16-byte secret seed; key i = `media/<placementId>/` + UUID text of the first 16 bytes of
 *     HMAC-SHA256(seed, "chunk:" || u32be(i)). Written only once the account is switched (LIB-FMT-13).
 * Sizes and starts may be `null` because old rows have them null (`media_format_chunks.size_bytes`,
 * `start_seconds` are nullable); the `+1` offset keeps a null distinguishable without a second blob.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { PackedChunkListJson } from "@space/shared/libraryOps";
import { bytesToBase64 } from "./snapshotPublish";

export type { PackedChunkListJson };

export const CHUNK_LIST_KEY_MODE = { keyTexts: 0, uuidBytes: 1, seed: 2 } as const;
export type ChunkListKeyMode = (typeof CHUNK_LIST_KEY_MODE)[keyof typeof CHUNK_LIST_KEY_MODE];

/** `media_chunk_lists.owner_kind`. */
export const CHUNK_LIST_OWNER_KIND = { format: 1, audioTrack: 2 } as const;
export type ChunkListOwnerKind = (typeof CHUNK_LIST_OWNER_KIND)[keyof typeof CHUNK_LIST_OWNER_KIND];

export const CHUNK_LIST_SEED_BYTES = 16;

/** One chunk as players and `MediaDetails` see it (unchanged by LIB-FMT-11). */
export type ChunkRef = { key: string; sizeBytes: number | null; startSeconds: number | null };

/** A packed list in memory and in `media_chunk_lists` (minus owner columns and `updated_at`). */
export type PackedChunkList = {
  placementId: string;
  keyMode: ChunkListKeyMode;
  keyData: Uint8Array;
  count: number;
  sizes: Uint8Array;
  starts: Uint8Array | null;
};

/** A stored or received chunk list that does not decode: corrupt bytes or a writer bug. Never skipped (LIB-OPS-01). */
export class ChunkListFormatError extends Error {
  constructor(message: string) {
    super(`CHUNK_LIST_FORMAT: ${message}`);
    this.name = "ChunkListFormatError";
  }
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEDIA_KEY = /^media\/([^/]+)\/([^/]+)$/;
const HEX = "0123456789abcdef";

// --- varints --------------------------------------------------------------------------------------------------------
// Plain arithmetic, not bitwise operators: sizes go past 2^31, and JS bitwise ops are 32-bit.

const pushVarint = (out: number[], value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new ChunkListFormatError(`varint out of range: ${value}`);
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) + 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
};

const readVarints = (bytes: Uint8Array, count: number, field: string): number[] => {
  const values: number[] = [];
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (offset >= bytes.length) throw new ChunkListFormatError(`${field}: ${i} of ${count} values, bytes ran out`);
      const byte = bytes[offset++]!;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 0x80;
      if (scale > 2 ** 56) throw new ChunkListFormatError(`${field}: varint ${i} too long`);
    }
    values.push(value);
  }
  if (offset !== bytes.length) throw new ChunkListFormatError(`${field}: ${bytes.length - offset} bytes left after ${count} values`);
  return values;
};

const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzigzag = (z: number) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

export const encodeChunkSizes = (sizes: ReadonlyArray<number | null>): Uint8Array => {
  const out: number[] = [];
  for (const size of sizes) pushVarint(out, size === null ? 0 : size + 1);
  return Uint8Array.from(out);
};

export const decodeChunkSizes = (bytes: Uint8Array, count: number): Array<number | null> =>
  readVarints(bytes, count, "sizes").map((v) => (v === 0 ? null : v - 1));

export const encodeChunkStarts = (starts: ReadonlyArray<number | null>): Uint8Array | null => {
  if (starts.every((start) => start === null)) return null;
  const out: number[] = [];
  let previousMs = 0;
  for (const start of starts) {
    if (start === null) {
      out.push(0);
      continue;
    }
    if (!Number.isFinite(start)) throw new ChunkListFormatError(`start not finite: ${start}`);
    const ms = Math.round(start * 1000);
    pushVarint(out, zigzag(ms - previousMs) + 1);
    previousMs = ms;
  }
  return Uint8Array.from(out);
};

export const decodeChunkStarts = (bytes: Uint8Array | null, count: number): Array<number | null> => {
  if (bytes === null) return new Array<number | null>(count).fill(null);
  let previousMs = 0;
  return readVarints(bytes, count, "starts").map((v) => {
    if (v === 0) return null;
    previousMs += unzigzag(v - 1);
    return previousMs / 1000;
  });
};

// --- keys -----------------------------------------------------------------------------------------------------------

const uuidToBytes = (uuid: string, out: Uint8Array, offset: number) => {
  const hex = uuid.replace(/-/g, "");
  for (let i = 0; i < 16; i += 1) out[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
};

const bytesToUuid = (bytes: Uint8Array, offset: number): string => {
  let s = "";
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    const byte = bytes[offset + i]!;
    s += HEX[byte >> 4]! + HEX[byte & 15]!;
  }
  return s;
};

/** Key of chunk `index` of a key-mode-2 list. */
export const seedChunkKey = (seed: Uint8Array, placementId: string, index: number): string => {
  if (seed.length !== CHUNK_LIST_SEED_BYTES) throw new ChunkListFormatError(`seed must be 16 bytes, got ${seed.length}`);
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new ChunkListFormatError(`chunk index out of range: ${index}`);
  const message = new Uint8Array(10);
  message.set([0x63, 0x68, 0x75, 0x6e, 0x6b, 0x3a]); // "chunk:"
  message[6] = Math.floor(index / 0x1000000) & 0xff;
  message[7] = (index >>> 16) & 0xff;
  message[8] = (index >>> 8) & 0xff;
  message[9] = index & 0xff;
  return `media/${placementId}/${bytesToUuid(hmac(sha256, seed, message), 0)}`;
};

/** Every key of a list, in chunk order. */
export const chunkListKeys = (list: PackedChunkList): string[] => {
  const { keyMode, keyData, count, placementId } = list;
  if (!Number.isSafeInteger(count) || count < 0) throw new ChunkListFormatError(`bad count ${count}`);
  switch (keyMode) {
    case CHUNK_LIST_KEY_MODE.keyTexts: {
      if (count === 0) {
        if (keyData.length) throw new ChunkListFormatError("key texts present for an empty list");
        return [];
      }
      const keys = new TextDecoder("utf-8", { fatal: true }).decode(keyData).split("\n");
      if (keys.length !== count) throw new ChunkListFormatError(`key texts: ${keys.length} keys for count ${count}`);
      return keys;
    }
    case CHUNK_LIST_KEY_MODE.uuidBytes: {
      if (keyData.length !== count * 16) throw new ChunkListFormatError(`uuid bytes: ${keyData.length} bytes for count ${count}`);
      const keys: string[] = [];
      for (let i = 0; i < count; i += 1) keys.push(`media/${placementId}/${bytesToUuid(keyData, i * 16)}`);
      return keys;
    }
    case CHUNK_LIST_KEY_MODE.seed: {
      const keys: string[] = [];
      for (let i = 0; i < count; i += 1) keys.push(seedChunkKey(keyData, placementId, i));
      return keys;
    }
    default:
      throw new ChunkListFormatError(`unknown key mode ${String(keyMode)}`);
  }
};

// --- pack / unpack --------------------------------------------------------------------------------------------------

/**
 * Packs an existing list of explicit keys (conversion of old rows, v3→v4 translation). Key mode 1 when every key is
 * `media/<one placement>/<lowercase uuid>`, so it round-trips byte for byte; key mode 0 otherwise.
 */
export const packChunkList = (chunks: ReadonlyArray<ChunkRef>): PackedChunkList => {
  const sizes = encodeChunkSizes(chunks.map((c) => c.sizeBytes));
  const starts = encodeChunkStarts(chunks.map((c) => c.startSeconds));
  const placements = new Set<string>();
  let allUuidKeys = chunks.length > 0;
  for (const chunk of chunks) {
    const match = MEDIA_KEY.exec(chunk.key);
    if (match) placements.add(match[1]!);
    else placements.add("");
    if (!match || !UUID_TEXT.test(match[2]!)) allUuidKeys = false;
  }
  const placementId = placements.size === 1 ? [...placements][0]! : "";
  if (allUuidKeys && placementId) {
    const keyData = new Uint8Array(chunks.length * 16);
    chunks.forEach((chunk, i) => uuidToBytes(chunk.key.slice(chunk.key.lastIndexOf("/") + 1), keyData, i * 16));
    return { placementId, keyMode: CHUNK_LIST_KEY_MODE.uuidBytes, keyData, count: chunks.length, sizes, starts };
  }
  for (const chunk of chunks) {
    if (chunk.key.includes("\n")) throw new ChunkListFormatError(`chunk key contains a line break: ${JSON.stringify(chunk.key)}`);
  }
  return {
    placementId,
    keyMode: CHUNK_LIST_KEY_MODE.keyTexts,
    keyData: new TextEncoder().encode(chunks.map((c) => c.key).join("\n")),
    count: chunks.length,
    sizes,
    starts,
  };
};

/** Packs a list whose keys derive from a seed (key mode 2): what the uploader writes after the switch. */
export const packSeededChunkList = (input: {
  placementId: string;
  seed: Uint8Array;
  sizes: ReadonlyArray<number | null>;
  starts: ReadonlyArray<number | null>;
}): PackedChunkList => {
  if (input.seed.length !== CHUNK_LIST_SEED_BYTES) throw new ChunkListFormatError(`seed must be 16 bytes, got ${input.seed.length}`);
  if (!input.placementId || input.placementId.includes("/")) throw new ChunkListFormatError(`bad placement id ${JSON.stringify(input.placementId)}`);
  if (input.sizes.length !== input.starts.length) {
    throw new ChunkListFormatError(`sizes (${input.sizes.length}) and starts (${input.starts.length}) differ in length`);
  }
  return {
    placementId: input.placementId,
    keyMode: CHUNK_LIST_KEY_MODE.seed,
    keyData: Uint8Array.from(input.seed),
    count: input.sizes.length,
    sizes: encodeChunkSizes(input.sizes),
    starts: encodeChunkStarts(input.starts),
  };
};

/** The list as `MediaDetails` carries it (`format.chunks`, `track.chunks`). */
export const unpackChunkList = (list: PackedChunkList): ChunkRef[] => {
  const keys = chunkListKeys(list);
  const sizes = decodeChunkSizes(list.sizes, list.count);
  const starts = decodeChunkStarts(list.starts, list.count);
  return keys.map((key, i) => ({ key, sizeBytes: sizes[i]!, startSeconds: starts[i]! }));
};

// --- Hex (drivers that carry no BLOB bytes, e.g. react-native-sqlite-storage: read `hex()`, write `X'..'`) -------------

export const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
};

export const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new ChunkListFormatError("BLOB hex is malformed");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

// --- JSON (op stream 4) ---------------------------------------------------------------------------------------------

export const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

export const chunkListToJson = (list: PackedChunkList): PackedChunkListJson => ({
  placementId: list.placementId,
  keyMode: list.keyMode,
  keyData: bytesToBase64(list.keyData),
  count: list.count,
  sizes: bytesToBase64(list.sizes),
  starts: list.starts === null ? null : bytesToBase64(list.starts),
});

export const chunkListFromJson = (json: PackedChunkListJson): PackedChunkList => {
  if (!json || typeof json !== "object") throw new ChunkListFormatError("chunk list is not an object");
  if (typeof json.placementId !== "string") throw new ChunkListFormatError("placementId missing");
  if (json.keyMode !== 0 && json.keyMode !== 1 && json.keyMode !== 2) throw new ChunkListFormatError(`unknown key mode ${String(json.keyMode)}`);
  if (!Number.isSafeInteger(json.count) || json.count < 0) throw new ChunkListFormatError(`bad count ${String(json.count)}`);
  if (typeof json.keyData !== "string" || typeof json.sizes !== "string") throw new ChunkListFormatError("keyData/sizes must be base64 text");
  if (json.starts !== null && typeof json.starts !== "string") throw new ChunkListFormatError("starts must be base64 text or null");
  const list: PackedChunkList = {
    placementId: json.placementId,
    keyMode: json.keyMode,
    keyData: base64ToBytes(json.keyData),
    count: json.count,
    sizes: base64ToBytes(json.sizes),
    starts: json.starts === null ? null : base64ToBytes(json.starts),
  };
  if (list.keyMode === CHUNK_LIST_KEY_MODE.seed && list.keyData.length !== CHUNK_LIST_SEED_BYTES) {
    throw new ChunkListFormatError(`seed must be 16 bytes, got ${list.keyData.length}`);
  }
  return list;
};
