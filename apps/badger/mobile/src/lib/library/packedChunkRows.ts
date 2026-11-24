/**
 * Packed chunk lists (`media_chunk_lists`, LIB-FMT-11) through react-native-sqlite-storage, which carries no bytes
 * across the bridge: Android hands a BLOB back as base64 text and iOS as lossy UTF-8, and a bound `Uint8Array` does
 * not arrive as a BLOB either. So the phone reads BLOB columns as `hex()` and writes them as `X'..'` literals.
 */
import {
  bytesToHex,
  CHUNK_LIST_KEY_MODE,
  ChunkListFormatError,
  type ChunkListKeyMode,
  hexToBytes,
  type PackedChunkList,
} from "@space/library-db-definition/chunkLists";

/** `media_chunk_lists` columns with every BLOB as hex text (`starts` stays NULL when absent). */
export const PACKED_LIST_SELECT =
  "owner_id, owner_kind, placement_id, key_mode, hex(key_data) AS key_data, count, hex(sizes) AS sizes, " +
  "CASE WHEN starts IS NULL THEN NULL ELSE hex(starts) END AS starts, updated_at";

const blobFromHex = (value: unknown): Uint8Array => hexToBytes(String(value ?? ""));
const optionalBlobFromHex = (value: unknown): Uint8Array | null =>
  value === null || value === undefined ? null : hexToBytes(String(value));

/** A row read with `PACKED_LIST_SELECT`, its BLOB columns as bytes (the shape `media_chunk_lists` stores). */
export const packedRowWithBytes = (row: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  key_data: blobFromHex(row.key_data),
  sizes: blobFromHex(row.sizes),
  starts: optionalBlobFromHex(row.starts),
});

const isKeyMode = (value: number): value is ChunkListKeyMode =>
  value === CHUNK_LIST_KEY_MODE.keyTexts || value === CHUNK_LIST_KEY_MODE.uuidBytes || value === CHUNK_LIST_KEY_MODE.seed;

/** A `PACKED_LIST_SELECT` row as the list it stores. A row that does not decode throws (LIB-OPS-01). */
export const packedListFromRow = (row: Record<string, unknown>): PackedChunkList => {
  const keyMode = Number(row.key_mode);
  if (!isKeyMode(keyMode)) throw new ChunkListFormatError(`unknown key_mode ${keyMode} for owner ${String(row.owner_id)}`);
  return {
    placementId: String(row.placement_id),
    keyMode,
    keyData: blobFromHex(row.key_data),
    count: Number(row.count),
    sizes: blobFromHex(row.sizes),
    starts: optionalBlobFromHex(row.starts),
  };
};

/**
 * The statement with each `Uint8Array` parameter written into the SQL as an `X'..'` literal and dropped from the
 * parameters. Placeholders inside quoted text or identifiers are not parameters and are skipped.
 */
export const inlineBlobParams = (sql: string, params: readonly unknown[]): [string, unknown[]] => {
  if (!params.some((param) => param instanceof Uint8Array)) return [sql, [...params]];
  let out = "";
  let index = 0;
  let quote: string | null = null;
  const kept: unknown[] = [];
  for (const char of sql) {
    if (quote) {
      if (char === quote) quote = null;
      out += char;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char !== "?") {
      out += char;
      continue;
    }
    const param = params[index];
    index += 1;
    if (param instanceof Uint8Array) {
      out += `X'${bytesToHex(param)}'`;
    } else {
      out += "?";
      kept.push(param);
    }
  }
  return [out, kept];
};
