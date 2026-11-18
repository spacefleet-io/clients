/**
 * Reading a suite app's library snapshot on the phone, the same way for every app (Badger, Parrot): the API's
 * `/library/db` (scoped by `x-space-app`) names the encrypted manifest; the manifest lists the encrypted chunks
 * `library/chunks/<hash>`; the chunks put end to end are one AES-256-GCM envelope (`IV(12) | ciphertext | tag(16)`)
 * whose plaintext is the SQLite file, compressed in a v2 frame (LIB-FMT-07) or bare (v1).
 *
 * The network, crypto and inflate calls are passed in, so this module has no native import and runs under plain
 * unit tests. Badger's phone app streams big snapshots through its own native decryptor and only shares the
 * manifest decoders below; Parrot's library is small enough to open in memory with `openRemoteLibrarySnapshot`.
 */
import { LibraryFormatTooNewError } from "@space/library-db-definition/compatibility";
import { decodeCompressedFrame, isCompressedFrame, type DeflateCodec } from "@space/library-db-definition/payloadCompression";
import { decodeStorageHeader, STORAGE_HEADER_SIZE } from "@space/library-db-definition/storageFormat";

export type LibrarySnapshotManifest = {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  dbSizeBytes: number;
  chunkSizeBytes: number;
  chunkCount: number;
  chunks: Array<{ index: number; hash: string; size: number }>;
  encryption: { algorithm: "AES-256-GCM"; ivSize: number; tagSize: number };
  dbHash: string;
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();
const BASE64_TEXT_BYTES = (() => {
  const table = new Uint8Array(256);
  for (const char of `${BASE64_ALPHABET}=\n\r\t `) table[char.charCodeAt(0)] = 1;
  return table;
})();

/** Base64 (whitespace ignored) to bytes, without `Buffer` or `atob`. */
export const base64ToBytes = (text: string): Uint8Array => {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const value = BASE64_VALUES[text.charCodeAt(i)];
    if (value < 0) continue;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length] = (acc >> bits) & 0xff;
      length += 1;
    }
  }
  return out.subarray(0, length);
};

/**
 * A legacy manifest object holds the base64 TEXT of its envelope (the API's JSON-body PUT stored the string's bytes).
 * Only bytes that are all base64 characters are decoded; a binary envelope or a headered one passes unchanged.
 */
export const decodeManifestBytes = (bytes: Uint8Array): Uint8Array => {
  if (bytes.byteLength < 24 || bytes.byteLength % 4 !== 0) return bytes;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    if (!BASE64_TEXT_BYTES[bytes[i]]) return bytes;
  }
  let text = "";
  for (let i = 0; i < bytes.byteLength; i += 1) text += String.fromCharCode(bytes[i]);
  return base64ToBytes(text);
};

/** AES-256-GCM open of `IV | ciphertext | tag` with the base64 library key; throws on a bad tag. */
export type EnvelopeDecrypt = (keyBase64: string, envelope: Uint8Array) => Promise<Uint8Array>;

/**
 * The plaintext of a stored manifest object. v1 objects carry the 8-byte `0x00 SBL` storage header: a storage
 * version above `supportedStorageFormatVersion` throws `LibraryFormatTooNewError` before any decrypt. Legacy v0
 * objects are the base64 text of the envelope. A decrypt failure is `DECRYPT_FAILED`.
 */
export const decodeStoredManifest = async (
  keyBase64: string,
  storedBytes: Uint8Array,
  supportedStorageFormatVersion: number,
  decrypt: EnvelopeDecrypt
): Promise<Uint8Array> => {
  const header = decodeStorageHeader(storedBytes);
  let envelope: Uint8Array;
  if (header) {
    if (header.storageFormatVersion > supportedStorageFormatVersion) {
      throw new LibraryFormatTooNewError({
        surface: "storage",
        observed: header.storageFormatVersion,
        supported: supportedStorageFormatVersion,
      });
    }
    envelope = storedBytes.subarray(STORAGE_HEADER_SIZE);
  } else {
    envelope = decodeManifestBytes(storedBytes);
  }
  return decrypt(keyBase64, envelope).catch(() => {
    throw new Error("DECRYPT_FAILED");
  });
};

export type RemoteSnapshotDeps = {
  /** `GET /library/db` for the app (`x-space-app`). */
  getLibraryDb: () => Promise<{ exists: boolean; manifestKey: string | null; snapshotVersion?: number; version: number }>;
  /** One storage object's bytes, through the storage tunnel, under the app's scope. */
  download: (objectKey: string) => Promise<Uint8Array>;
  decrypt: EnvelopeDecrypt;
  inflate: DeflateCodec;
  supportedStorageFormatVersion: number;
  log?: (event: string, payload: Record<string, unknown>) => void;
};

/**
 * The app's library snapshot as SQLite file bytes. Throws `LIBRARY_MISSING` when the account has no snapshot for
 * the app yet, `LIBRARY_CHUNK_SIZE_MISMATCH` on a short chunk, `DECRYPT_FAILED` when the key does not open it.
 */
export const openRemoteLibrarySnapshot = async (
  keyBase64: string,
  deps: RemoteSnapshotDeps
): Promise<{ dbBytes: Uint8Array; snapshotVersion: number; manifest: LibrarySnapshotManifest }> => {
  const startedAt = Date.now();
  const remote = await deps.getLibraryDb();
  if (!remote.exists || !remote.manifestKey) throw new Error("LIBRARY_MISSING");
  const manifestPlain = await decodeStoredManifest(
    keyBase64,
    await deps.download(remote.manifestKey),
    deps.supportedStorageFormatVersion,
    deps.decrypt
  );
  const manifest = JSON.parse(new TextDecoder().decode(manifestPlain)) as LibrarySnapshotManifest;
  const chunks = [...manifest.chunks].sort((a, b) => a.index - b.index);
  const parts = await Promise.all(chunks.map((chunk) => deps.download(`library/chunks/${chunk.hash}`)));
  const total = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const envelope = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part, index) => {
    if (part.byteLength !== chunks[index].size) throw new Error("LIBRARY_CHUNK_SIZE_MISMATCH");
    envelope.set(part, offset);
    offset += part.byteLength;
  });
  const plain = await deps.decrypt(keyBase64, envelope).catch(() => {
    throw new Error("DECRYPT_FAILED");
  });
  const dbBytes = isCompressedFrame(plain) ? decodeCompressedFrame(plain, deps.inflate) : plain;
  const snapshotVersion = remote.snapshotVersion ?? remote.version;
  deps.log?.("library.snapshot.opened", {
    chunks: chunks.length,
    encryptedBytes: total,
    dbBytes: dbBytes.byteLength,
    snapshotVersion,
    ms: Date.now() - startedAt,
  });
  return { dbBytes, snapshotVersion, manifest };
};
