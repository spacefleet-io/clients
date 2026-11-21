import RNFS from "react-native-fs";
import { Buffer } from "buffer";
import crypto from "react-native-quick-crypto";
import BlobManager from "react-native/Libraries/Blob/BlobManager";
import {
  downloadStorageObjectViaTunnel,
  uploadStorageObjectViaTunnel,
} from "@space/shared/api";
import { readLibraryDb } from "./libraryReads";
import type { TunnelUploadSource } from "@space/shared/storageTunnel";
import type { StorageObjectCounting } from "@space/shared/storageCounting";
import { decodeManifestBytes } from "@space/mobile-shell/librarySnapshot";
import { buildUploadFrameBlob } from "../../native/LibrarySync";
import { yieldToEventLoop } from "./eventLoop";

export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
export const DOWNLOAD_CONCURRENCY = 6;
export const UPLOAD_CONCURRENCY = 4;

/** Per-frame upload checksum (native digest, one frame at a time). */
const hashBytes = (bytes: Uint8Array) => crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/**
 * Files cross the bridge as base64 that the JS thread encodes/decodes. One 4 MB chunk in a single call froze
 * the thread for ~3 s on the profile build, so chunks move in slices: per slice the work stays in the tens of
 * milliseconds, and the thread serves touches between the (asynchronous) native calls.
 */
export const FILE_SLICE_BYTES = 64 * 1024;

export const readFileChunk = async (filePath: string, length: number, position: number) => {
  const out = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const base64 = await RNFS.read(filePath, Math.min(FILE_SLICE_BYTES, length - filled), position + filled, "base64");
    if (!base64) break;
    const slice = Buffer.from(base64, "base64");
    out.set(slice, filled);
    filled += slice.length;
  }
  return filled === length ? out : out.subarray(0, filled);
};

/**
 * React Native's WebSocket.send base64-encodes a binary Uint8Array in JS (base64-js): ~0.8 s per MB on the
 * profile build, and decoding a RNFS base64 read costs ~0.8 s per MB too. So upload frames never pass through
 * JS: the native module reads the slice, hashes it and builds the whole wire frame into a Blob, and JS only
 * hands that Blob to WebSocket.send (RN's native sendBlob path). Only the HTTP fallback reads bytes in JS.
 */
export const UPLOAD_FRAME_BYTES = 1024 * 1024;

export const uploadObjectViaTunnel = async (
  token: string,
  objectKey: string,
  payload: Uint8Array | TunnelUploadSource,
  /** How the object counts toward the allowance (STOR-USE-02); the library file itself goes without a role. */
  counting?: StorageObjectCounting
) =>
  uploadStorageObjectViaTunnel(token, objectKey, payload, {
    objectNamespace: "library",
    logicalRef: objectKey,
    clientType: "mobile",
    clientVersion: "mobile-library-db",
    chunkSize: UPLOAD_FRAME_BYTES,
    checksumFn: async (chunk) => {
      await yieldToEventLoop();
      return `sha256:${hashBytes(chunk)}`;
    },
    ...(counting ? { counting } : {}),
  });

/**
 * A media object the phone sealed itself (a fetched subtitle, PLAY-SUBGET-03), stored on the media's silo (#145)
 * under a fresh key like the computer app and the web page do; returns the key the vault gave it.
 */
export const uploadMediaObjectViaTunnel = async (
  token: string,
  sealed: Uint8Array,
  options: { placementId: string; logicalRef: string }
) =>
  uploadStorageObjectViaTunnel(token, crypto.randomUUID(), sealed, {
    placementId: options.placementId,
    logicalRef: options.logicalRef,
    objectNamespace: "library",
    contentType: "application/octet-stream",
    clientType: "mobile",
    clientVersion: "mobile-library-db",
    counting: { role: "subtitle" },
  });

export const downloadObjectViaTunnel = async (token: string, objectKey: string) =>
  downloadStorageObjectViaTunnel(token, objectKey, {
    clientType: "mobile",
    clientVersion: "mobile-library-db",
    // Library data stays readable when unpaid and keeps flowing while the silo is saturated (STOR-BW-09).
    purpose: "library",
  });

export const fetchManifestBytes = async (token: string, manifestKey: string) => {
  const bytes = await downloadObjectViaTunnel(token, manifestKey);
  return decodeManifestBytes(bytes);
};

export const fetchRemoteManifestWithRetry = async (token: string, attempts = 3) => {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remote = await readLibraryDb(token);
    if (!remote.exists || !remote.manifestKey) {
      throw new Error("LIBRARY_MISSING");
    }
    try {
      const manifestBytes = await fetchManifestBytes(token, remote.manifestKey);
      return { remote, manifestBytes };
    } catch (error) {
      lastError = error;
      console.warn(
        "library.manifest.download.retry",
        JSON.stringify({
          attempt,
          key: remote.manifestKey,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError ?? new Error("REMOTE_FETCH_FAILED");
};

export const uploadChunksFromFile = async (
  token: string,
  filePath: string,
  chunks: Array<{ hash: string; size: number; offset: number }>
) => {
  if (!chunks.length) return;
  for (let i = 0; i < chunks.length; i += UPLOAD_CONCURRENCY) {
    const batch = chunks.slice(i, i + UPLOAD_CONCURRENCY);
    await Promise.all(
      batch.map((chunk) =>
        uploadObjectViaTunnel(token, `library/chunks/${chunk.hash}`, {
          byteLength: chunk.size,
          read: (offset, length) => readFileChunk(filePath, length, chunk.offset + offset),
          buildWsMessage: async ({ uploadId, seq, offset, length }) => {
            const { blobId, size } = await buildUploadFrameBlob(filePath, chunk.offset + offset, length, uploadId, seq);
            const blob = BlobManager.createFromOptions({ blobId, offset: 0, size });
            return { message: blob, release: () => blob.close() };
          },
        })
      )
    );
  }
};

/**
 * Slice of a downloaded chunk written in one native call. The download side used to encode 64 KB slices with the
 * JS `buffer` package and append each with its own call (64 file opens per 4 MB chunk, one after the other); Hermes'
 * native `btoa` encodes a 1 MB slice in a few milliseconds, so a chunk now takes 4 writes.
 */
export const DOWNLOAD_WRITE_SLICE_BYTES = 1024 * 1024;

/** Bytes turned into one `String.fromCharCode` call: well under the engine's argument limit. */
const CHAR_CODE_STEP = 8 * 1024;

/** Base64 of `bytes`: the engine's native `btoa` over a binary string when there is one, else the `buffer` package. */
export const encodeBase64 = (bytes: Uint8Array): string => {
  if (typeof globalThis.btoa !== "function") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHAR_CODE_STEP) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHAR_CODE_STEP) as unknown as number[]));
  }
  return globalThis.btoa(parts.join(""));
};

/**
 * Downloads the snapshot's chunks into `targetPath`. Each chunk is written at its own offset as soon as it lands,
 * in 1 MB slices, while up to DOWNLOAD_CONCURRENCY other chunks keep downloading: no batch waits for its slowest
 * chunk before anything is written, and a chunk's bytes are dropped once written. Logs `library.snapshot.download`.
 */
export const downloadChunksToFile = async (
  token: string,
  manifest: { chunks: Array<{ hash: string; size: number }> },
  targetPath: string
) => {
  const startedAt = Date.now();
  await RNFS.writeFile(targetPath, "", "base64");
  const offsets: number[] = [];
  let totalBytes = 0;
  for (const chunk of manifest.chunks) {
    offsets.push(totalBytes);
    totalBytes += chunk.size;
  }
  let writeMs = 0;
  let writes = 0;
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < manifest.chunks.length) {
      const index = next;
      next += 1;
      const chunk = manifest.chunks[index];
      const buffer = await downloadObjectViaTunnel(token, `library/chunks/${chunk.hash}`);
      // Chunks land at fixed offsets: a short one would leave a hole instead of shifting the rest.
      if (buffer.length !== chunk.size) throw new Error("LIBRARY_CHUNK_SIZE_MISMATCH");
      const writeStartedAt = Date.now();
      for (let offset = 0; offset < buffer.length; offset += DOWNLOAD_WRITE_SLICE_BYTES) {
        const base64 = encodeBase64(buffer.subarray(offset, offset + DOWNLOAD_WRITE_SLICE_BYTES));
        await RNFS.write(targetPath, base64, offsets[index] + offset, "base64");
        writes += 1;
      }
      writeMs += Date.now() - writeStartedAt;
    }
  };
  const run = () =>
    worker().catch((error: unknown) => {
      failed = true;
      throw error;
    });
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, manifest.chunks.length) }, run));
  console.warn(
    "library.snapshot.download",
    JSON.stringify({ chunks: manifest.chunks.length, bytes: totalBytes, writes, writeMs, ms: Date.now() - startedAt })
  );
};
