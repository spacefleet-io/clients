import { Buffer } from "buffer";
import crypto from "react-native-quick-crypto";
import {
  ApiError,
  downloadStorageObjectViaTunnel,
  getLibraryDb,
  getLibraryMeta,
  rotateLibraryKey,
  uploadStorageObjectViaTunnel,
  type RotationLibraryCopy,
  type RotationOwnLibrary,
} from "@space/shared/api";
import { TRUSTED_CHUNK_REFS_VERSION } from "@space/shared/contracts/library";
import { openRemoteLibrarySnapshot } from "@space/mobile-shell/librarySnapshot";
import { fflateCodec } from "@space/mobile-shell/libraryOps";
import { reencryptLibrarySnapshotWith } from "@space/library-db-definition/snapshotPublish";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import { decryptBytesToBytes, encryptBytesToBytes } from "./crypto";

/** Why a rotation was refused with nothing changed; each has its own words (`resetKey.errors.<reason>`). */
export type RotationRefusal = "notReencrypted" | "unreadable" | "notSnapshotted" | "changed";

class RotationRefusedError extends Error {
  constructor(readonly reason: RotationRefusal) {
    super(`ROTATION_REFUSED_${reason}`);
  }
}

/**
 * PRIV-KEY-06: Parrot's library opened with the old key and re-encrypted under the new one (chunks uploaded), with
 * the version it was read at. None when Parrot has no snapshot (the server refuses the rotation if it has a library).
 */
// tla: VaultKeys/RotateRead
const reencryptParrotLibrary = async (token: string, oldKey: string, newKey: string): Promise<RotationLibraryCopy[]> => {
  const meta = await getLibraryMeta(token, "parrot");
  if (!meta.exists) return [];
  // Changes after the latest snapshot are not in it: re-encrypting it would drop them, so the rotation waits.
  if (meta.snapshotVersion !== meta.version) throw new RotationRefusedError("notSnapshotted");
  const opened = await openRemoteLibrarySnapshot(oldKey, {
    getLibraryDb: () => getLibraryDb(token, "parrot"),
    download: (objectKey) =>
      downloadStorageObjectViaTunnel(token, objectKey, { clientType: "mobile", clientVersion: "badger-mobile", purpose: "library" }),
    decrypt: decryptBytesToBytes,
    inflate: fflateCodec,
    supportedStorageFormatVersion: STORAGE_FORMAT_VERSION,
  }).catch((err: unknown) => {
    if (err instanceof Error && err.message === "LIBRARY_MISSING") return null;
    if (err instanceof Error && err.message === "DECRYPT_FAILED") throw new RotationRefusedError("unreadable");
    throw err;
  });
  if (!opened) return [];
  // Read at the snapshot's version: an edit landing since makes the server answer `version_conflict` (user tries again).
  const copy = await reencryptLibrarySnapshotWith(opened.dbBytes, opened.snapshotVersion, {
    seal: (plaintext) => encryptBytesToBytes(newKey, plaintext),
    codec: fflateCodec,
    sha256Hex: async (bytes) => crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex") as string,
    randomId: () => crypto.randomUUID(),
    uploadChunk: async (objectKey, bytes) => {
      await uploadStorageObjectViaTunnel(token, objectKey, bytes, {
        clientType: "mobile",
        clientVersion: "badger-mobile",
        objectNamespace: "library",
        logicalRef: objectKey,
        uploadId: crypto.randomUUID(),
      });
    },
  });
  return [
    {
      ...copy,
      appId: "parrot",
      chunkRefsSource: { client: "badger-mobile", refsVersion: TRUSTED_CHUNK_REFS_VERSION },
      storageFormatVersion: STORAGE_FORMAT_VERSION,
      opStreamVersion: meta.opStreamVersion,
    },
  ];
};

/**
 * PRIV-KEY-06: rotates the key with Parrot's library re-encrypted under the new key (never emptied), in one request.
 * If Parrot's library changed meanwhile the server answers 409 `version_conflict` and the user tries again (with a new
 * 2FA code: the code is single-use, so no automatic retry). Without the old key no copy is sent and the server refuses
 * when Parrot has a library.
 */
export const rotateWithParrotLibrary = async (input: {
  token: string;
  oldKey: string | null;
  newKey: string;
  /** PRIV-KEY-13: this phone's library as a snapshot under the new key, declaring its formats. */
  library: RotationOwnLibrary;
  keyProbe: string;
  password: string;
  twoFactorCode?: string;
}) => {
  const copies = input.oldKey ? await reencryptParrotLibrary(input.token, input.oldKey, input.newKey) : [];
  return rotateLibraryKey(input.token, input.library, input.keyProbe, input.password, input.twoFactorCode, copies);
};

/**
 * The refusal a rotation error stands for (nothing changed), or null for any other error. The media refusal
 * (409 `rotation_needs_media_reseal`) is not one: no entry is offered while the server would answer it
 * (ACCT-KEYCHG-04), so reaching it is a fault and gets the generic error.
 */
export const rotationRefusal = (err: unknown): RotationRefusal | null => {
  if (err instanceof RotationRefusedError) return err.reason;
  if (!(err instanceof ApiError)) return null;
  if (err.payload?.error === "library_not_reencrypted") return "notReencrypted";
  if (err.payload?.error === "version_conflict") return "changed";
  return null;
};
