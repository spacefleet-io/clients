import { NativeEventEmitter, NativeModules } from "react-native";

const { LibrarySync } = NativeModules;

if (!LibrarySync) {
  // eslint-disable-next-line no-console
  console.warn("LibrarySync native module is not available");
}

export type LibrarySyncProgress = {
  stage: string;
  bytesRead: number;
  totalBytes: number;
  pct: number;
};

const emitter =
  LibrarySync?.addListener && LibrarySync?.removeListeners
    ? new NativeEventEmitter(LibrarySync)
    : new NativeEventEmitter();

export const onLibrarySyncProgress = (listener: (event: LibrarySyncProgress) => void) => {
  return emitter.addListener("librarySyncProgress", (event) => listener(event as LibrarySyncProgress));
};

export type SnapshotFileResult = {
  /** Bytes of the SQLite file. */
  dbBytes: number;
  /** Bytes of the encrypted saved copy. */
  storedBytes: number;
  /** False only when a v1 (uncompressed) saved copy was read. */
  compressed: boolean;
  /** Time spent on the native worker thread. */
  ms: number;
};

/**
 * SQLite file -> saved copy of the library (LIB-FMT-07 v2: `00 5A 01` + raw deflate, then AES-256-GCM), streamed on a
 * native worker thread (LIB-SYNC-14): the database never reaches the JS thread.
 */
export const encryptSnapshotFile = async (dbPath: string, keyBase64: string, outputPath: string): Promise<SnapshotFileResult> => {
  if (!LibrarySync?.encryptSnapshotFile) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  return await LibrarySync.encryptSnapshotFile(dbPath, keyBase64, outputPath);
};

/** Saved copy (v2 compressed or v1 plain) -> SQLite file, decrypted and inflated on a native worker thread. */
export const decryptSnapshotFile = async (sourcePath: string, keyBase64: string, dbPath: string): Promise<SnapshotFileResult> => {
  if (!LibrarySync?.decryptSnapshotFile) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  return await LibrarySync.decryptSnapshotFile(sourcePath, keyBase64, dbPath);
};

/**
 * One stored library change (base64 `iv | GCM(frame or v1 JSON) | tag`) -> its JSON text, opened on a native worker
 * thread (LIB-SYNC-14). Rejects with `DECRYPT_FAILED`, `corrupt_compressed_frame` or `unknown_compression_codec:N`.
 */
export const openOpPayload = async (payloadBase64: string, keyBase64: string): Promise<string> => {
  if (!LibrarySync?.openOpPayload) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  return await LibrarySync.openOpPayload(payloadBase64, keyBase64);
};

export type FileHashes = {
  size: number;
  /** Hex SHA-256 of the whole file. */
  hash: string;
  /** Hex SHA-256 + byte size of each consecutive `chunkSize` slice (empty when `chunkSize` is 0). */
  chunks: Array<{ size: number; hash: string }>;
};

/** Hashes a file natively in one streaming pass: its bytes never reach the JS thread. */
export const sha256File = async (sourcePath: string, chunkSize: number): Promise<FileHashes> => {
  if (!LibrarySync?.sha256File) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  return await LibrarySync.sha256File(sourcePath, chunkSize);
};

/**
 * Builds one storage-tunnel `upload.data` WebSocket frame natively from a slice of a file and parks it in
 * the BlobModule. Returns the blob id and byte size; the bytes never reach the JS thread.
 */
export const buildUploadFrameBlob = async (
  sourcePath: string,
  offset: number,
  length: number,
  uploadId: string,
  seq: number
): Promise<{ blobId: string; size: number }> => {
  if (!LibrarySync?.buildUploadFrameBlob) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  return await LibrarySync.buildUploadFrameBlob(sourcePath, offset, length, uploadId, seq);
};

/**
 * Android `ActivityManager.isLowRamDevice()`. False where the native method is missing (iOS, older builds) or the
 * query fails: only a positive answer makes the sky still.
 */
export const isLowRamDevice = async (): Promise<boolean> => {
  if (!LibrarySync?.isLowRamDevice) return false;
  try {
    return (await LibrarySync.isLowRamDevice()) === true;
  } catch {
    return false;
  }
};
