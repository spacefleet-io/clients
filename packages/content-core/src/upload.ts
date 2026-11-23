import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { StorageObjectCounting } from "@space/shared/storageCounting";

export type ContentObjectUploadRuntime = {
  encryptObject: (bytes: Buffer) => Buffer;
  uploadObject: (
    token: string,
    objectKey: string,
    payload: Uint8Array,
    options?: {
      objectNamespace?: string;
      logicalRef?: string;
      contentType?: string;
      chunkSize?: number;
      clientType?: string;
      clientVersion?: string;
      uploadId?: string;
      checksumFn?: (chunk: Uint8Array, seq: number) => string | Promise<string>;
      /** Per-media silo placement (#145): the object lands under media/<placementId>/. */
      placementId?: string;
      /** How the object counts toward the allowance (STOR-USE-02); absent: `other`, its stored bytes. */
      counting?: StorageObjectCounting;
    }
  ) => Promise<string>;
};

export type ContentObjectUploadResult = {
  key: string;
  sizeBytes: number;
  checksum: string;
};

export type ContentUploadLedgerPart = {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  checksum?: string;
  path?: string;
};

export type ContentUploadLedger = {
  getCompletedParts: (outputId: string) => Promise<ContentUploadLedgerPart[]>;
  recordPart: (outputId: string, part: ContentUploadLedgerPart) => Promise<void>;
};

export type ContentObjectUploadOptions = {
  outputId?: string;
  uploadLedger?: ContentUploadLedger;
  signal?: AbortSignal;
  placementId?: string;
  /** How the object counts toward the allowance (STOR-USE-02). */
  counting?: StorageObjectCounting;
};

export type ContentBytesUploadArgs = {
  plaintext: Buffer;
  logicalRef: string;
  objectNamespace?: string;
  contentType?: string;
  placementId?: string;
  counting?: StorageObjectCounting;
};

const checksumBytes = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new Error("CANCELLED");
  }
};

export const uploadEncryptedContentObject = async (
  runtime: ContentObjectUploadRuntime,
  token: string,
  filePath: string,
  options: ContentObjectUploadOptions = {}
): Promise<ContentObjectUploadResult> => {
  throwIfAborted(options.signal);

  const stats = await fs.stat(filePath);
  const sizeBytes = stats.size;

  if (options.uploadLedger && options.outputId) {
    const completed = await options.uploadLedger.getCompletedParts(options.outputId);
    const match = completed.find((part) => part.path === filePath);
    if (match) {
      return {
        key: match.etag,
        sizeBytes: match.sizeBytes,
        checksum: match.checksum ?? checksumBytes(await fs.readFile(filePath)),
      };
    }
  }

  const uploaded = await uploadEncryptedContentBytes(runtime, token, {
    plaintext: await fs.readFile(filePath),
    logicalRef: filePath,
    placementId: options.placementId,
    counting: options.counting,
  });
  const result = {
    ...uploaded,
    sizeBytes,
  };

  if (options.uploadLedger && options.outputId) {
    await options.uploadLedger.recordPart(options.outputId, {
      partNumber: 0,
      etag: result.key,
      sizeBytes: result.sizeBytes,
      checksum: result.checksum,
      path: filePath,
    });
  }

  return result;
};

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per object upload

export const uploadEncryptedContentBytes = async (
  runtime: ContentObjectUploadRuntime,
  token: string,
  args: ContentBytesUploadArgs
): Promise<ContentObjectUploadResult> => {
  const checksum = checksumBytes(args.plaintext);
  const encrypted = runtime.encryptObject(args.plaintext);
  const key = randomUUID();
  const uploadPromise = runtime.uploadObject(token, key, encrypted, {
    objectNamespace: args.objectNamespace ?? "library",
    logicalRef: args.logicalRef,
    contentType: args.contentType ?? "application/octet-stream",
    clientType: "desktop",
    clientVersion: "ingest-core",
    ...(args.placementId ? { placementId: args.placementId } : {}),
    ...(args.counting ? { counting: args.counting } : {}),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`UPLOAD_TIMEOUT: storage upload for ${args.logicalRef ?? key} did not complete within 5 minutes — check gateway health`)),
      UPLOAD_TIMEOUT_MS
    );
  });
  try {
    const persistedKey = await Promise.race([uploadPromise, timeoutPromise]);
    return {
      key: persistedKey,
      sizeBytes: encrypted.byteLength,
      checksum,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
