import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  COMPRESSION_LEVEL,
  decodeCompressedFrame,
  encodeCompressedFrame,
  type DeflateCodec,
} from "@space/library-db-definition/payloadCompression";
import { decryptBytesToBytes, encryptBytesToBytes } from "./crypto";

/** Raw DEFLATE through the zlib that ships with Node / Electron / Bun. */
export const nodeDeflateCodec: DeflateCodec = {
  deflateRaw: (bytes) => new Uint8Array(deflateRawSync(bytes, { level: COMPRESSION_LEVEL })),
  inflateRaw: (bytes) => new Uint8Array(inflateRawSync(bytes)),
};

/**
 * Storage format v2 (LIB-FMT-07): compress, THEN encrypt. Writers use it for
 * every saved copy of the library.
 */
export const encryptSnapshotBytes = (keyBase64: string, dbBytes: Uint8Array) =>
  encryptBytesToBytes(keyBase64, encodeCompressedFrame(dbBytes, nodeDeflateCodec));

/** One library change, compressed then encrypted (LIB-FMT-07); every change is framed, small ones too. */
export const encryptOpPayload = (keyBase64: string, opJsonBytes: Uint8Array) =>
  encryptBytesToBytes(keyBase64, encodeCompressedFrame(opJsonBytes, nodeDeflateCodec));

/**
 * Decrypt a saved copy of the library or one library change written by v1
 * (plain bytes) or v2 (framed): the frame is detected from the bytes, so no
 * version number has to be right.
 */
export const decryptLibraryPayload = async (keyBase64: string, encrypted: Uint8Array) =>
  decodeCompressedFrame(await decryptBytesToBytes(keyBase64, encrypted), nodeDeflateCodec);
