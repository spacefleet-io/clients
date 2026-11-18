import RNFS from "react-native-fs";
import { Buffer } from "buffer";
import crypto from "react-native-quick-crypto";
import {
  encryptLibraryToBinaryFile,
  decryptLibraryFromBinaryFile,
  decryptLibraryFromFile,
  onLibrarySyncProgress,
  sha256File,
} from "../../native/LibrarySync";
import { CHUNK_SIZE_BYTES, downloadObjectViaTunnel } from "./transport";
import {
  decryptBytesToBytes,
  encryptBytesToBase64,
  encryptBytesToBytes,
} from "../crypto";
import { decodeStoredManifest as decodeSharedStoredManifest } from "@space/mobile-shell/librarySnapshot";
import {
  COMPRESSED_FRAME_HEADER_SIZE,
  decodeCompressedFrame,
  encodeCompressedFrame,
  isCompressedFrame,
} from "@space/library-db-definition/payloadCompression";
import { fflateCodec } from "@space/mobile-shell/libraryOps";
import type { LibrarySupport } from "@space/library-db-definition/compatibility";

export const SQLITE_HEADER = "SQLite format 3 ";

export type LibrarySnapshotChunk = {
  index: number;
  hash: string;
  size: number;
};

export type LibrarySnapshotManifest = {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  dbSizeBytes: number;
  chunkSizeBytes: number;
  chunkCount: number;
  chunks: LibrarySnapshotChunk[];
  encryption: {
    algorithm: "AES-256-GCM";
    ivSize: number;
    tagSize: number;
  };
  dbHash: string;
};

export const decodeUtf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
export const encodeUtf8 = (value: string) => Buffer.from(value, "utf8");

const nowIso = () => new Date().toISOString();

export const isSqliteHeader = (bytes: Uint8Array) => {
  if (bytes.length < SQLITE_HEADER.length) return false;
  for (let i = 0; i < SQLITE_HEADER.length; i += 1) {
    if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) return false;
  }
  return true;
};

export const buildChunkIndexFromFile = async (filePath: string) => {
  const { size: totalSize, chunks: hashed } = await sha256File(filePath, CHUNK_SIZE_BYTES);
  let offset = 0;
  const chunks = hashed.map((chunk, index) => {
    const entry = { index, hash: chunk.hash, size: chunk.size, offset };
    offset += chunk.size;
    return entry;
  });
  return { totalSize, chunks };
};

/** Size and SHA-256 of a (plaintext) DB file, hashed natively so the 8 MB never crosses the bridge as base64. */
export const hashDbFile = async (dbPath: string) => {
  const { size, hash } = await sha256File(dbPath, 0);
  return { sizeBytes: size, hash };
};

export const buildManifest = (
  snapshotId: string,
  db: { sizeBytes: number; hash: string },
  chunkIndex: Array<{ index: number; hash: string; size: number }>
): LibrarySnapshotManifest => ({
  schemaVersion: 1,
  snapshotId,
  createdAt: nowIso(),
  dbSizeBytes: db.sizeBytes,
  chunkSizeBytes: CHUNK_SIZE_BYTES,
  chunkCount: chunkIndex.length,
  chunks: chunkIndex.map((chunk) => ({
    index: chunk.index,
    hash: chunk.hash,
    size: chunk.size,
  })),
  encryption: {
    algorithm: "AES-256-GCM",
    ivSize: 12,
    tagSize: 16,
  },
  dbHash: db.hash,
});

/**
 * The decrypted plaintext of a stored manifest object (v1 `0x00 SBL` header or legacy v0 base64 text); the shared
 * phone reader in `@space/mobile-shell/librarySnapshot`. A too-new storage version throws `LibraryFormatTooNewError`
 * before any decrypt; a decrypt failure is `DECRYPT_FAILED`.
 */
export const decodeStoredManifest = (keyBase64: string, storedBytes: Uint8Array, support: LibrarySupport) =>
  decodeSharedStoredManifest(keyBase64, storedBytes, support.storageFormatVersion, decryptBytesToBytes);

export const fetchManifestChunks = async (
  token: string,
  keyBase64: string,
  manifestKeys: string[],
  support: LibrarySupport
) => {
  if (!manifestKeys.length) return new Set<string>();
  const chunkHashes = new Set<string>();
  for (const manifestKey of manifestKeys) {
    const bytes = await downloadObjectViaTunnel(token, manifestKey);
    // Dual reader: retention scans must also decode v0 base64-text manifests
    // and v1 headered ones. decodeStoredManifest throws DECRYPT_FAILED on a
    // decrypt failure — remap to this path's MANIFEST_DECRYPT_FAILED.
    const decrypted = await decodeStoredManifest(keyBase64, bytes, support).catch((error) => {
      if (error instanceof Error && error.message === "DECRYPT_FAILED") {
        throw new Error("MANIFEST_DECRYPT_FAILED");
      }
      throw error;
    });
    const manifest = JSON.parse(decodeUtf8(decrypted)) as LibrarySnapshotManifest;
    manifest.chunks.forEach((chunk) => chunkHashes.add(chunk.hash));
  }
  return chunkHashes;
};

export const decryptFileToDb = async (
  keyBase64: string,
  sourcePath: string,
  dbPath: string,
  encoding: "base64" | "binary"
) => {
  const subscription = onLibrarySyncProgress((event) => {
    console.warn("library.db.decrypt.progress", JSON.stringify(event));
  });
  try {
    console.warn("library.db.decrypt.start", JSON.stringify({ sourcePath, dbPath }));
    if (encoding === "binary") {
      await decryptLibraryFromBinaryFile(sourcePath, keyBase64, dbPath);
    } else {
      await decryptLibraryFromFile(sourcePath, keyBase64, dbPath);
    }
    // A v2 snapshot (LIB-FMT-07) decrypts to a compressed frame, a v1 one to the SQLite file itself.
    const head = new Uint8Array(Buffer.from(await RNFS.read(dbPath, COMPRESSED_FRAME_HEADER_SIZE, 0, "base64"), "base64"));
    if (isCompressedFrame(head)) {
      const framed = new Uint8Array(Buffer.from(await RNFS.readFile(dbPath, "base64"), "base64"));
      const plain = decodeCompressedFrame(framed, fflateCodec);
      await RNFS.writeFile(dbPath, Buffer.from(plain).toString("base64"), "base64");
      console.warn("library.db.decompress.done", JSON.stringify({ framedBytes: framed.length, dbBytes: plain.length }));
    }
    console.warn("library.db.decrypt.done", JSON.stringify({ dbPath }));
  } finally {
    subscription.remove();
  }
};

export const exportDbBytes = async (dbPath: string) => {
  const base64 = await RNFS.readFile(dbPath, "base64");
  return new Uint8Array(Buffer.from(base64, "base64"));
};

export const createKeyProbe = async (keyBase64: string) => {
  const bytes = crypto.randomBytes(32);
  return await encryptBytesToBase64(keyBase64, new Uint8Array(bytes));
};

export const createSnapshotId = () => {
  if (typeof (crypto as { randomUUID?: () => string }).randomUUID === "function") {
    return (crypto as { randomUUID: () => string }).randomUUID();
  }
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
};

/**
 * Saved copy of the library: compressed, THEN encrypted (LIB-FMT-07). The native encryptor streams a file, so the
 * framed bytes are staged next to the target and removed afterwards.
 */
export const encryptDbToBinaryFile = async (dbPath: string, keyBase64: string, targetPath: string) => {
  const framed = encodeCompressedFrame(await exportDbBytes(dbPath), fflateCodec);
  const framedPath = `${targetPath}.frame`;
  try {
    await RNFS.writeFile(framedPath, Buffer.from(framed).toString("base64"), "base64");
    await encryptLibraryToBinaryFile(framedPath, keyBase64, targetPath);
  } catch {
    const encrypted = await encryptBytesToBytes(keyBase64, framed);
    await RNFS.writeFile(targetPath, Buffer.from(encrypted).toString("base64"), "base64");
  } finally {
    await RNFS.unlink(framedPath).catch(() => undefined);
  }
};

export const getLatestSnapshotMs = (history?: Array<{ createdAt: string }>) => {
  if (!history?.length) return null;
  const sorted = history
    .map((entry) => Date.parse(entry.createdAt))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);
  return sorted[0] ?? null;
};

export const selectSnapshotsForRetention = (
  history: Array<{ snapshotId: string; manifestKey: string; createdAt: string }>
) => {
  const parsed = history
    .map((entry) => ({
      snapshotId: entry.snapshotId,
      manifestKey: entry.manifestKey,
      createdAtMs: Date.parse(entry.createdAt),
    }))
    .filter((entry) => entry.snapshotId && entry.manifestKey && Number.isFinite(entry.createdAtMs))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);

  const keep = new Map<string, { snapshotId: string; manifestKey: string; createdAtMs: number }>();
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  parsed.slice(-3).forEach((entry) => keep.set(entry.snapshotId, entry));
  parsed.forEach((entry) => {
    if (entry.createdAtMs >= cutoff) {
      keep.set(entry.snapshotId, entry);
    }
  });
  return Array.from(keep.values());
};
