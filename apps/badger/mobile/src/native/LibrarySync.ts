import { NativeEventEmitter, NativeModules } from "react-native";
import RNFS from "react-native-fs";

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
 * Bytes of op text per bridge call. A 3.5 MB stored change is ~56 MB of JSON (deflate packs repetitive JSON ~16:1);
 * handed over as one Java String that is 113 MB of UTF-16, which threw OutOfMemoryError on op6's 256 MB heap.
 */
export const OP_TEXT_SLICE_BYTES = 2 * 1024 * 1024;

type OpenedOpFile = {
  storedBytes: number;
  jsonBytes: number;
  /** Exclusive end of each slice of the file, each at a UTF-8 character start; the last is `jsonBytes`. */
  sliceEnds: number[];
  ms: number;
};

/**
 * One stored library change (base64 `iv | GCM(frame or v1 JSON) | tag`) -> its JSON text. A native worker thread
 * opens it into a cache file (LIB-SYNC-14), and the text comes back in slices of about `OP_TEXT_SLICE_BYTES`, so
 * no native heap ever holds the whole text. Rejects with `DECRYPT_FAILED`, `corrupt_compressed_frame` or
 * `unknown_compression_codec:N`.
 */
export const openOpPayload = async (payloadBase64: string, keyBase64: string): Promise<string> => {
  if (!LibrarySync?.openOpPayloadToFile || !LibrarySync?.readTextSlice) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  const path = `${RNFS.CachesDirectoryPath}/library-op-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  try {
    const opened: OpenedOpFile = await LibrarySync.openOpPayloadToFile(payloadBase64, keyBase64, path, OP_TEXT_SLICE_BYTES);
    const parts: string[] = [];
    let start = 0;
    for (const end of opened.sliceEnds) {
      parts.push(await LibrarySync.readTextSlice(path, start, end));
      start = end;
    }
    return parts.join("");
  } finally {
    // Native deletes the file itself when opening fails; this removes it after reading.
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  }
};

/** One op of a native ops page: its JSON inline, or (large) in a cache file read back in slices. */
export type NativeOpsPageOp = {
  version: number;
  jsonBytes: number;
  text?: string;
  path?: string;
  /** Exclusive end of each slice of `path`, each at a UTF-8 character start. */
  sliceEnds?: number[];
};

/** One page of the binary op stream (LIB-SYNC-15), fetched, decrypted and inflated off the JS thread. */
export type NativeOpsPage = {
  version: number;
  snapshotVersion: number;
  hasMore: boolean;
  tooOld: boolean;
  storageFormatVersion: number;
  opStreamVersion: number;
  targetOpStreamVersion: number | null;
  ops: NativeOpsPageOp[];
  bytes: number;
  ms: number;
};

/**
 * `GET /library/db/ops?since=fromVersion` in the binary form (LIB-FMT-13), on a native worker thread. Native adds
 * `since` and the binary `Accept`; `headers` carry the session, the app and the op stream this build reads. Rejects
 * with code `HTTP_<status>` (message = the answer's body), `NETWORK_FAILED`, `BAD_FRAMES`, `INVALID_KEY` or
 * `OPEN_FAILED`.
 */
export const fetchOpsPage = async (request: {
  url: string;
  headers: Record<string, string>;
  keyBase64: string;
  fromVersion: number;
}): Promise<NativeOpsPage> => {
  if (!LibrarySync?.fetchOpsPage) throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  return LibrarySync.fetchOpsPage(request);
};

/** The JSON text of one op of a native page; a file op is read in slices, then deleted. */
export const readOpsPageOpText = async (op: NativeOpsPageOp): Promise<string> => {
  if (typeof op.text === "string") return op.text;
  if (!op.path || !op.sliceEnds) throw new Error("OPS_PAGE_OP_INVALID");
  try {
    const parts: string[] = [];
    let start = 0;
    for (const end of op.sliceEnds) {
      parts.push(await LibrarySync.readTextSlice(op.path, start, end));
      start = end;
    }
    return parts.join("");
  } finally {
    if (await RNFS.exists(op.path)) await RNFS.unlink(op.path);
  }
};

/** Removes the cache files of a page's ops that were never read (a page refused before its apply). */
export const discardOpsPageFiles = async (ops: ReadonlyArray<NativeOpsPageOp>) => {
  for (const op of ops) {
    if (op.path && (await RNFS.exists(op.path))) await RNFS.unlink(op.path).catch(() => undefined);
  }
};

/**
 * Packs the playback DB's per-chunk tables into `media_chunk_lists` in one native transaction (LIB-FMT-12):
 * `{lists, rows, ms}`. Call with no transaction open on that file. Rejects `NO_CHUNK_LISTS_TABLE` or
 * `CONVERT_FAILED`; the file is then unchanged.
 */
export const convertChunkLists = async (playbackDbPath: string, nowIso: string): Promise<{ lists: number; rows: number; ms: number }> => {
  if (!LibrarySync?.convertChunkLists) throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  return LibrarySync.convertChunkLists(playbackDbPath, nowIso);
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
