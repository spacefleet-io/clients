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

export const decryptLibraryFromFile = async (
  sourcePath: string,
  keyBase64: string,
  outputPath: string
) => {
  if (!LibrarySync?.decryptBase64File) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  return await LibrarySync.decryptBase64File(sourcePath, keyBase64, outputPath);
};

export const decryptLibraryFromBinaryFile = async (
  sourcePath: string,
  keyBase64: string,
  outputPath: string
) => {
  if (!LibrarySync?.decryptBinaryFile) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  return await LibrarySync.decryptBinaryFile(sourcePath, keyBase64, outputPath);
};

export const encryptLibraryToBinaryFile = async (
  sourcePath: string,
  keyBase64: string,
  outputPath: string
) => {
  if (!LibrarySync?.encryptBinaryFile) {
    throw new Error("LIBRARY_SYNC_UNAVAILABLE");
  }
  return await LibrarySync.encryptBinaryFile(sourcePath, keyBase64, outputPath);
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
