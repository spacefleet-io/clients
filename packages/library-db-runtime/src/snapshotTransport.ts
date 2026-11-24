/**
 * The library snapshot on the wire, for any app whose library is an encrypted SQLite snapshot plus
 * an op stream (Badger's videos, Parrot's music). The schema inside the SQLite bytes is the app's
 * business; this module only moves bytes:
 *
 *   publish: SQLite bytes → compressed frame + AES-GCM (`encryptSnapshotBytes`) → 4 MiB chunks
 *            `library/chunks/<sha256>` through the storage tunnel → encrypted manifest JSON →
 *            PUT /library/db (the API stores the manifest under `library/<app>/manifests/`).
 *   open:    GET /library/db → manifest object → `decodeStoredManifest` → chunks → decrypt.
 *
 * Every network call carries the app's `x-space-app` scope; Badger's `LibraryDb` passes the
 * default scope, so its requests are unchanged.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_SPACE_APP_ID, type SpaceAppId } from "@space/shared/appScope";
import { TRUSTED_CHUNK_REFS_VERSION, type ChunkRefsSource } from "@space/shared/contracts/library";
import { decodeStorageHeader, STORAGE_FORMAT_VERSION, STORAGE_HEADER_SIZE } from "@space/library-db-definition/storageFormat";
import { reencryptLibrarySnapshotWith, type RotationSnapshotCopy } from "@space/library-db-definition/snapshotPublish";
import {
  assertLibraryCompatible,
  currentLibrarySupport,
  type LibrarySupport,
} from "@space/library-db-definition/compatibility";
import {
  downloadStorageObjectViaTunnel,
  getLibraryDb,
  getLibraryMeta,
  putLibraryDb,
  uploadStorageObjectViaTunnel,
  type LibraryMeta,
} from "./api";
import { getApiBaseUrl } from "./apiHost";
import { decryptBase64ToBytes, decryptBytesToBytes, encryptBytesToBase64, encryptBytesToBytes } from "./crypto";
import { decryptLibraryPayload, encryptSnapshotBytes, nodeDeflateCodec } from "./payloadCodec";
import { rewriteLibraryBytesForReseal } from "./resealSnapshot";
import { retryTransient } from "./transientRetry";
import { scopeLogger } from "./logger";

export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 6;

const LIBRARY_SYNC_DEBUG = process.env.SF_LIBRARY_SYNC_DEBUG === "1";
const logger = scopeLogger("library-sync");
export const syncDebug = (message: string, meta?: Record<string, unknown>) => {
  if (!LIBRARY_SYNC_DEBUG) return;
  if (meta) {
    logger.info({ message, ...meta }, "debug");
    return;
  }
  logger.info({ message }, "debug");
};

/** Every runtime publish sends the chunk hashes of exactly the manifest it publishes. */
export const DESKTOP_CHUNK_REFS_SOURCE: ChunkRefsSource = { client: "desktop-runtime", refsVersion: TRUSTED_CHUNK_REFS_VERSION };

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

/** One encrypted snapshot chunk ready for upload; `hash` names its object `library/chunks/<hash>`. */
export type SnapshotChunk = { hash: string; size: number; data: Uint8Array };

export const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const createKeyProbe = async (keyBase64: string) => {
  const bytes = randomBytes(32);
  return encryptBytesToBase64(keyBase64, new Uint8Array(bytes));
};

/** Thrown before a publish whose key is not the account's: the vault was erased, or its key replaced, elsewhere. */
export const KEY_MISMATCH = "KEY_MISMATCH";

/**
 * PRIV-KEY-01: refuse to publish under a key that is not the account's. The key probe is account-wide (Badger and
 * Parrot, every device and profile) and every publish writes a new one, so an app still holding a key from before an
 * erase elsewhere would otherwise overwrite the new key's probe with its own and lock the other apps out. Reads the
 * account's probe (or uses `meta` already read) and throws `KEY_MISMATCH` when one exists that `keyBase64` cannot open.
 * An account with no probe yet is left to the publish (a first library, or an account from before probes).
 * Returns the probe it checked (null: none), for the publish to send as `checkedKeyProbe`: the API refuses it (412
 * `key_probe_changed`) when the account's probe changed in between (PRIV-KEY-06/10).
 */
// tla: VaultKeys/PubCheck
export const assertAccountLibraryKey = async (
  token: string,
  keyBase64: string,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  meta?: Pick<LibraryMeta, "keyProbe"> | null,
): Promise<string | null> => {
  const probe = (meta ?? (await getLibraryMeta(token, appId))).keyProbe;
  if (!probe) return null;
  const opens = await decryptBase64ToBytes(keyBase64, probe).then(
    () => true,
    () => false,
  );
  if (!opens) throw new Error(KEY_MISMATCH);
  return probe;
};

export const buildChunks = (bytes: Uint8Array): SnapshotChunk[] => {
  const chunks: SnapshotChunk[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE_BYTES) {
    const slice = bytes.slice(offset, offset + CHUNK_SIZE_BYTES);
    chunks.push({ hash: hashBytes(slice), size: slice.length, data: slice });
  }
  return chunks;
};

export const buildManifest = (
  snapshotId: string,
  encryptedBytes: Uint8Array,
  dbBytes: Uint8Array,
  chunks = buildChunks(encryptedBytes)
): LibrarySnapshotManifest => ({
  schemaVersion: 1,
  snapshotId,
  createdAt: new Date().toISOString(),
  dbSizeBytes: dbBytes.length,
  chunkSizeBytes: CHUNK_SIZE_BYTES,
  chunkCount: chunks.length,
  chunks: chunks.map((chunk, index) => ({ index, hash: chunk.hash, size: chunk.size })),
  encryption: { algorithm: "AES-256-GCM", ivSize: 12, tagSize: 16 },
  dbHash: hashBytes(dbBytes),
});

export const downloadObjectViaDedicatedSession = (
  token: string,
  objectKey: string,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) =>
  downloadStorageObjectViaTunnel(
    token,
    objectKey,
    {
      clientType: "library-db-runtime",
      clientVersion: "library-db-runtime",
      downloadId: randomUUID(),
      // Library metadata stays readable when unpaid (#145) and keeps flowing at saturation (STOR-BW-09).
      purpose: "library",
    },
    appId
  );

export const uploadChunks = async (
  token: string,
  chunks: ReadonlyArray<SnapshotChunk>,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) => {
  for (const chunk of chunks) {
    const objectKey = `library/chunks/${chunk.hash}`;
    await uploadStorageObjectViaTunnel(
      token,
      objectKey,
      Uint8Array.from(chunk.data),
      {
        clientType: "library-db-runtime",
        clientVersion: "library-db-runtime",
        objectNamespace: "library",
        logicalRef: objectKey,
        uploadId: randomUUID(),
        checksumFn: (data) => `sha256:${hashBytes(data)}`,
      },
      appId
    );
  }
};

export const fetchManifestBytes = async (
  token: string,
  manifestKey: string,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) => {
  syncDebug("fetch-manifest:start", { apiBaseUrl: getApiBaseUrl(), manifestKey, appId });
  try {
    const bytes = await downloadStorageObjectViaTunnel(
      token,
      manifestKey,
      {
        clientType: "library-db-runtime",
        clientVersion: "library-db-runtime",
        downloadId: randomUUID(),
        purpose: "library",
      },
      appId
    );
    if (!bytes.byteLength) {
      throw new Error("REMOTE_MISSING");
    }
    return bytes;
  } catch (error) {
    syncDebug("fetch-manifest:failed", {
      manifestKey,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error && error.message.includes("TUNNEL_DOWNLOAD_ERROR")) {
      throw new Error("REMOTE_MISSING");
    }
    throw error;
  }
};

export const fetchManifestWithRetry = async (
  token: string,
  manifestKey: string,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) => {
  try {
    return await fetchManifestBytes(token, manifestKey, appId);
  } catch (error) {
    if (error instanceof Error && error.message === "REMOTE_MISSING") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return await fetchManifestBytes(token, manifestKey, appId);
    }
    throw error;
  }
};

/** The storage-surface support of this build: a stored manifest only declares its storage format. */
const STORAGE_SUPPORT: LibrarySupport = currentLibrarySupport({});

/**
 * Part A3 — the versioned dual reader. Turns the bytes of a *stored* manifest
 * object into the decrypted manifest plaintext, routing v0 and v1 layouts.
 *
 * This is the manifest-encoding bug fix. The bug (finding doc
 * library-manifest-encoding-mismatch-2026-05-14): the API uploads a manifest
 * as the UTF-8 bytes of a base64 *string*, but the reader fed those bytes
 * straight into AES-GCM decrypt — every remote manifest fetch failed with
 * DECRYPT_FAILED. The v0 branch below decodes that base64-text framing
 * correctly, so every already-stored manifest becomes readable forever; no
 * server-side back-fill is needed.
 *
 *  - Headered (`decodeStorageHeader` returns non-null): a v1 object written by
 *    the post-fix API. Run the storage version through the compatibility gate
 *    (a manifest from a newer build than this one throws
 *    `LibraryFormatTooNewError`), strip the 8-byte header, decrypt the
 *    remaining `IV ‖ ciphertext ‖ tag` envelope.
 *  - `null` (legacy v0): no header — the stored bytes are the base64 *text* of
 *    the envelope. UTF-8-decode to that base64 string, base64-decode to the
 *    raw envelope, decrypt.
 *
 * Returns the decrypted manifest plaintext bytes; callers `JSON.parse` them.
 * A decrypt failure surfaces as `DECRYPT_FAILED`, matching every prior caller.
 */
export const decodeStoredManifest = async (keyBase64: string, storedBytes: Uint8Array): Promise<Uint8Array> => {
  const header = decodeStorageHeader(storedBytes);
  if (header) {
    // v1: fail fast on a too-new format BEFORE attempting decrypt, so the
    // renderer sees a clean LibraryFormatTooNewError instead of a cryptic
    // decrypt failure (Part D — must propagate, do not swallow).
    assertLibraryCompatible({ storageFormatVersion: header.storageFormatVersion }, STORAGE_SUPPORT);
    const envelope = storedBytes.subarray(STORAGE_HEADER_SIZE);
    return decryptBytesToBytes(keyBase64, envelope).catch(() => {
      throw new Error("DECRYPT_FAILED");
    });
  }
  // v0 (legacy): stored bytes are the base64 *text* of the crypto envelope.
  const base64Text = new TextDecoder().decode(storedBytes);
  const envelope = new Uint8Array(Buffer.from(base64Text, "base64"));
  return decryptBytesToBytes(keyBase64, envelope).catch(() => {
    throw new Error("DECRYPT_FAILED");
  });
};

const downloadChunkWithRetry = (token: string, objectKey: string, appId: SpaceAppId) =>
  retryTransient(() => downloadObjectViaDedicatedSession(token, objectKey, appId), (attempt, error) =>
    syncDebug("download-chunk:retry", { objectKey, attempt, error: error instanceof Error ? error.message : String(error) })
  );

export const downloadChunks = async (
  token: string,
  manifest: LibrarySnapshotManifest,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) => {
  const totalSize = manifest.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const encrypted = new Uint8Array(totalSize);
  let offset = 0;
  if (!manifest.chunks.length) return encrypted;

  for (let i = 0; i < manifest.chunks.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = manifest.chunks.slice(i, i + DOWNLOAD_CONCURRENCY);
    const buffers = await Promise.all(
      batch.map(async (chunk) => downloadChunkWithRetry(token, `library/chunks/${chunk.hash}`, appId))
    );
    for (const bytes of buffers) {
      encrypted.set(bytes, offset);
      offset += bytes.length;
    }
  }
  return encrypted;
};

/** What `publishLibrarySnapshot` published: the server's new version and the manifest it stored. */
export type PublishedLibrarySnapshot = {
  version: number;
  snapshotId: string;
  manifest: LibrarySnapshotManifest;
  stateHash: string | null;
  lastOpId: string | null;
};

/**
 * Publish SQLite bytes as the app's library snapshot: the same chunks, manifest, key probe and
 * PUT /library/db every runtime publish sends. `baseVersion` is the server version the snapshot
 * replaces (0 for a library the server has never seen); a stale one fails with the API's conflict.
 */
export const publishLibrarySnapshot = async (input: {
  token: string;
  keyBase64: string;
  dbBytes: Uint8Array;
  baseVersion: number;
  appId: SpaceAppId;
  /** The publishing app's own change-type version (Badger `OP_STREAM_VERSION`, Parrot `PARROT_OP_STREAM_VERSION`), LIB-FMT-09. */
  opStreamVersion: number;
  stateHash?: string | null;
  lastOpId?: string | null;
}): Promise<PublishedLibrarySnapshot> => {
  const { token, keyBase64, dbBytes, baseVersion, appId } = input;
  const checkedKeyProbe = await assertAccountLibraryKey(token, keyBase64, appId);
  const encrypted = await encryptSnapshotBytes(keyBase64, dbBytes);
  const chunks = buildChunks(encrypted);
  const snapshotId = randomUUID();
  const manifest = buildManifest(snapshotId, encrypted, dbBytes, chunks);
  const manifestPayload = await encryptBytesToBytes(keyBase64, new TextEncoder().encode(JSON.stringify(manifest)));
  await uploadChunks(token, chunks, appId);
  const result = await putLibraryDb(
    token,
    baseVersion,
    Buffer.from(manifestPayload).toString("base64"),
    snapshotId,
    CHUNK_SIZE_BYTES,
    await createKeyProbe(keyBase64),
    false,
    input.stateHash ?? null,
    input.lastOpId ?? null,
    appId,
    chunks.map((entry) => entry.hash),
    DESKTOP_CHUNK_REFS_SOURCE,
    input.opStreamVersion,
    checkedKeyProbe
  );
  return {
    version: result.version,
    snapshotId,
    manifest,
    stateHash: result.stateHash ?? null,
    lastOpId: result.lastOpId ?? null,
  };
};

/** The app's latest published snapshot, decrypted: the SQLite bytes plus the meta and manifest they came from. */
export type FetchedLibrarySnapshot = {
  meta: LibraryMeta;
  manifestKey: string;
  manifest: LibrarySnapshotManifest;
  snapshotVersion: number;
  dbBytes: Uint8Array;
};

/**
 * Read the app's latest snapshot the way every client opens a library: GET /library/db/meta and
 * /library/db, the manifest object through the storage tunnel, `decodeStoredManifest`, the chunks,
 * then decrypt (and inflate a v2 frame). `null` when the app has no published snapshot.
 */
export const fetchLibrarySnapshot = async (input: {
  token: string;
  keyBase64: string;
  appId: SpaceAppId;
}): Promise<FetchedLibrarySnapshot | null> => {
  const { token, keyBase64, appId } = input;
  const meta = await getLibraryMeta(token, appId);
  if (!meta.exists) return null;
  const remote = await getLibraryDb(token, appId);
  if (!remote.exists || !remote.manifestKey) return null;
  const manifestBytes = await fetchManifestWithRetry(token, remote.manifestKey, appId);
  const manifestPlain = await decodeStoredManifest(keyBase64, manifestBytes);
  const manifest = JSON.parse(new TextDecoder().decode(manifestPlain)) as LibrarySnapshotManifest;
  const encryptedSnapshot = await downloadChunks(token, manifest, appId);
  const dbBytes = await decryptLibraryPayload(keyBase64, encryptedSnapshot).catch(() => {
    throw new Error("DECRYPT_FAILED");
  });
  return {
    meta,
    manifestKey: remote.manifestKey,
    manifest,
    snapshotVersion: remote.snapshotVersion ?? remote.version,
    dbBytes,
  };
};

/** Another app's library re-encrypted under the new key: one entry of the rotation's `otherLibraries`. */
export type RotationLibraryCopy = RotationSnapshotCopy & {
  appId: SpaceAppId;
  chunkRefsSource: ChunkRefsSource;
  storageFormatVersion: number;
  opStreamVersion: number;
};

/**
 * PRIV-KEY-13: the rotating device's own library for POST /library/recovery/rotate: its snapshot under the new key (a
 * manifest naming the chunks, uploaded already) and the storage format and op stream it is written in.
 */
export type RotationOwnLibrary = {
  manifestBase64: string;
  snapshotId: string;
  chunkSize: number;
  chunkRefs: string[];
  chunkRefsSource: ChunkRefsSource;
  storageFormatVersion: number;
  opStreamVersion: number;
};

/**
 * PRIV-KEY-13: library bytes sealed under `keyBase64` and cut into chunks exactly as this build publishes a snapshot
 * (`uploadSnapshot`), the chunks uploaded under `appId`; the rotation writes the manifest. The op stream is the caller's
 * to declare.
 */
export const sealLibrarySnapshot = async (
  token: string,
  keyBase64: string,
  rawBytes: Uint8Array,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
): Promise<Omit<RotationOwnLibrary, "opStreamVersion">> => {
  const encrypted = await encryptSnapshotBytes(keyBase64, rawBytes);
  const chunks = buildChunks(encrypted);
  const snapshotId = randomUUID();
  const manifest = buildManifest(snapshotId, encrypted, rawBytes, chunks);
  const manifestPayload = await encryptBytesToBytes(keyBase64, new TextEncoder().encode(JSON.stringify(manifest)));
  await uploadChunks(token, chunks, appId);
  return {
    manifestBase64: Buffer.from(manifestPayload).toString("base64"),
    snapshotId,
    chunkSize: CHUNK_SIZE_BYTES,
    chunkRefs: chunks.map((chunk) => chunk.hash),
    chunkRefsSource: DESKTOP_CHUNK_REFS_SOURCE,
    storageFormatVersion: STORAGE_FORMAT_VERSION,
  };
};

/** A library the rotating device cannot re-encrypt whole: changes after its latest snapshot (PRIV-KEY-06). */
export const LIBRARY_NOT_SNAPSHOTTED = "LIBRARY_NOT_SNAPSHOTTED";

/**
 * PRIV-KEY-06: before a key rotation, every other app's library is opened with the old key and re-encrypted under the
 * new one (its chunks uploaded), each with the version it was read at, for the rotation to write all of them in one
 * step. An app with no snapshot is skipped (the server refuses the rotation if it has a library after all); a library
 * the old key does not open (`DECRYPT_FAILED`) or with changes after its snapshot (`LIBRARY_NOT_SNAPSHOTTED`) throws,
 * so nothing is rotated and nothing is lost. With `resealCopies` (old key → re-sealed copy, STOR-RESEAL-01), each
 * library is re-encrypted with its media references renamed to the copies the switch keeps.
 */
// tla: VaultKeys/RotateRead
export const reencryptLibrariesForRotation = async (input: {
  token: string;
  oldKeyBase64: string;
  newKeyBase64: string;
  appIds: readonly SpaceAppId[];
  resealCopies?: ReadonlyMap<string, string>;
}): Promise<RotationLibraryCopy[]> => {
  const copies: RotationLibraryCopy[] = [];
  for (const appId of input.appIds) {
    const fetched = await fetchLibrarySnapshot({ token: input.token, keyBase64: input.oldKeyBase64, appId });
    if (!fetched) continue;
    // Changes after the latest snapshot are not in it: re-encrypting it would drop them, so the rotation waits.
    if (fetched.meta.version !== fetched.meta.snapshotVersion) throw new Error(`${LIBRARY_NOT_SNAPSHOTTED}:${appId}`);
    // Read at the snapshot's version: an edit landing since makes the server answer `version_conflict` (user tries again).
    const dbBytes = input.resealCopies
      ? (await rewriteLibraryBytesForReseal(fetched.dbBytes, appId, input.resealCopies)).bytes
      : fetched.dbBytes;
    const copy = await reencryptLibrarySnapshotWith(dbBytes, fetched.snapshotVersion, {
      seal: (plaintext) => encryptBytesToBytes(input.newKeyBase64, plaintext),
      codec: nodeDeflateCodec,
      sha256Hex: async (bytes) => hashBytes(bytes),
      randomId: () => randomUUID(),
      uploadChunk: async (objectKey, bytes) => {
        await uploadStorageObjectViaTunnel(
          input.token,
          objectKey,
          bytes,
          {
            clientType: "library-db-runtime",
            clientVersion: "library-db-runtime",
            objectNamespace: "library",
            logicalRef: objectKey,
            uploadId: randomUUID(),
            checksumFn: (data) => `sha256:${hashBytes(data)}`,
          },
          appId
        );
      },
    });
    copies.push({
      ...copy,
      appId,
      chunkRefsSource: DESKTOP_CHUNK_REFS_SOURCE,
      storageFormatVersion: STORAGE_FORMAT_VERSION,
      opStreamVersion: fetched.meta.opStreamVersion,
    });
  }
  return copies;
};
