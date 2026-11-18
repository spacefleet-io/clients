/**
 * Publishing SQLite bytes as the app's library snapshot, platform-neutral (browser, Hermes, Node): the same steps as
 * the desktop runtime's `publishLibrarySnapshot` (@space/library-db-runtime/snapshotTransport) with the crypto, the
 * hashing, the chunk upload and PUT /library/db injected, so no client needs node:crypto or node:zlib.
 *   0. the file as a rollback-journal SQLite file (LIB-FMT-10: a phone's WAL-mode file gets the header in-memory
 *      SQLite opens), which is what the manifest's size and hash describe;
 *   1. compress (LIB-FMT-07 v2 frame) then seal with the library key;
 *   2. cut the sealed bytes into 4 MiB chunks named `library/chunks/<sha256 hex>` and upload each;
 *   3. a manifest listing them (JSON, sealed) and a key probe (32 random bytes, sealed);
 *   4. PUT /library/db over `baseVersion`, with the manifest's chunk set as `chunkRefs` (a stale base: HTTP 409).
 */
import { encodeCompressedFrame, type DeflateCodec } from "./payloadCompression";
import { asRollbackJournalImage } from "./sqliteImage";

/** Size of one uploaded snapshot chunk; readers take it from the manifest. */
export const LIBRARY_SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024;

export type LibrarySnapshotManifestChunk = { index: number; hash: string; size: number };

/** The snapshot's manifest as every reader parses it (`schemaVersion` 1). */
export type LibrarySnapshotUploadManifest = {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  dbSizeBytes: number;
  chunkSizeBytes: number;
  chunkCount: number;
  chunks: LibrarySnapshotManifestChunk[];
  encryption: { algorithm: "AES-256-GCM"; ivSize: number; tagSize: number };
  dbHash: string;
};

export type LibrarySnapshotPublishDeps = {
  /** The library envelope (`IV(12) | ciphertext | tag(16)`, AES-256-GCM) with the account's library key. */
  seal: (plaintext: Uint8Array) => Promise<Uint8Array>;
  codec: DeflateCodec;
  sha256Hex: (bytes: Uint8Array) => Promise<string>;
  /** The snapshot's id (a UUID). */
  randomId: () => string;
  /** Stores one chunk under `objectKey` (`library/chunks/<hash>`) through the storage tunnel. */
  uploadChunk: (objectKey: string, bytes: Uint8Array) => Promise<void>;
  /** PUT /library/db; resolves to the server's new version, rejects with the API's 409 on a stale `baseVersion`. */
  putSnapshot: (input: {
    baseVersion: number;
    manifestBase64: string;
    snapshotId: string;
    chunkSize: number;
    keyProbeBase64: string;
    chunkRefs: string[];
  }) => Promise<{ version: number }>;
  log?: (event: string, payload: Record<string, unknown>) => void;
};

const KEY_PROBE_BYTES = 32;

/** Base64 without Buffer (browser and Hermes both have `btoa`), in slices so large inputs fit the argument limit. */
export const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export const publishLibrarySnapshotWith = async (
  dbBytes: Uint8Array,
  baseVersion: number,
  deps: LibrarySnapshotPublishDeps
): Promise<{ version: number; snapshotId: string; manifest: LibrarySnapshotUploadManifest }> => {
  const started = Date.now();
  const image = asRollbackJournalImage(dbBytes);
  const sealed = await deps.seal(encodeCompressedFrame(image, deps.codec));
  const chunks: (LibrarySnapshotManifestChunk & { data: Uint8Array })[] = [];
  for (let offset = 0; offset < sealed.length; offset += LIBRARY_SNAPSHOT_CHUNK_BYTES) {
    const data = sealed.slice(offset, offset + LIBRARY_SNAPSHOT_CHUNK_BYTES);
    chunks.push({ index: chunks.length, hash: await deps.sha256Hex(data), size: data.length, data });
  }
  const snapshotId = deps.randomId();
  const manifest: LibrarySnapshotUploadManifest = {
    schemaVersion: 1,
    snapshotId,
    createdAt: new Date().toISOString(),
    dbSizeBytes: image.length,
    chunkSizeBytes: LIBRARY_SNAPSHOT_CHUNK_BYTES,
    chunkCount: chunks.length,
    chunks: chunks.map(({ index, hash, size }) => ({ index, hash, size })),
    encryption: { algorithm: "AES-256-GCM", ivSize: 12, tagSize: 16 },
    dbHash: await deps.sha256Hex(image),
  };
  for (const chunk of chunks) await deps.uploadChunk(`library/chunks/${chunk.hash}`, chunk.data);
  const manifestSealed = await deps.seal(new TextEncoder().encode(JSON.stringify(manifest)));
  const probe = await deps.seal(crypto.getRandomValues(new Uint8Array(KEY_PROBE_BYTES)));
  const { version } = await deps.putSnapshot({
    baseVersion,
    manifestBase64: bytesToBase64(manifestSealed),
    snapshotId,
    chunkSize: LIBRARY_SNAPSHOT_CHUNK_BYTES,
    keyProbeBase64: bytesToBase64(probe),
    chunkRefs: chunks.map((chunk) => chunk.hash),
  });
  deps.log?.("library.snapshot.published", { baseVersion, version, bytes: image.length, sealed: sealed.length, chunks: chunks.length, ms: Date.now() - started });
  return { version, snapshotId, manifest };
};
