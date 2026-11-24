import { Buffer } from "buffer";
import RNFS from "react-native-fs";
import crypto from "react-native-quick-crypto";
import {
  downloadStorageObjectViaTunnel,
  getLibraryDb,
  getLibraryMeta,
  uploadStorageObjectViaTunnel,
  type RotationLibraryCopy,
} from "@space/shared/api";
import { TRUSTED_CHUNK_REFS_VERSION } from "@space/shared/contracts/library";
import { openRemoteLibrarySnapshot } from "@space/mobile-shell/librarySnapshot";
import { fflateCodec } from "@space/mobile-shell/libraryOps";
import { reencryptLibrarySnapshotWith } from "@space/library-db-definition/snapshotPublish";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import { rewriteParrotReferences } from "@space/media-reseal";
import { decryptBytesToBytes, encryptBytesToBytes } from "./crypto";
import { openSqliteDb, removeDbFile } from "./library/dbFiles";
import { leaveWalForExport } from "./library/leaveWal";
import { sqliteStorageResealDb } from "./library/resealDb";
import { getRotationParrotDbPath, ROTATION_PARROT_DB_NAME } from "./libraryStorage";

/**
 * STOR-RESEAL-01: Parrot's library bytes with every media reference in `copies` (old key → copy) renamed, in a
 * temporary SQLite file: the published library refers to the re-sealed copies, never to the objects the switch deletes.
 */
const rewriteParrotBytes = async (bytes: Uint8Array, copies: ReadonlyMap<string, string>): Promise<Uint8Array> => {
  if (copies.size === 0) return bytes;
  const path = getRotationParrotDbPath();
  await removeDbFile(path);
  try {
    await RNFS.writeFile(path, Buffer.from(bytes).toString("base64"), "base64");
    const db = await openSqliteDb(ROTATION_PARROT_DB_NAME);
    try {
      await rewriteParrotReferences(sqliteStorageResealDb(db), copies);
      // The file is read whole next: every change in it, its header in the form every reader opens (LIB-FMT-10).
      await leaveWalForExport(db);
    } finally {
      await db.close();
    }
    return new Uint8Array(Buffer.from(await RNFS.readFile(path, "base64"), "base64"));
  } finally {
    await removeDbFile(path);
  }
};

/**
 * PRIV-KEY-06: Parrot's library opened with the old key, its media references renamed to the re-sealed copies
 * (STOR-RESEAL-01) and re-encrypted under the new one (chunks uploaded), with the version it was read at. None when
 * Parrot has no snapshot (the server refuses the rotation if it has a library). Throws
 * `ROTATION_REENCRYPT_<UNREADABLE|NOT_SNAPSHOTTED>` (`keyChangeFailureOf`): nothing rotated.
 */
// tla: VaultKeys/RotateRead
export const reencryptParrotLibrary = async (
  token: string,
  oldKey: string,
  newKey: string,
  resealCopies: ReadonlyMap<string, string>
): Promise<RotationLibraryCopy[]> => {
  const meta = await getLibraryMeta(token, "parrot");
  if (!meta.exists) return [];
  // Changes after the latest snapshot are not in it: re-encrypting it would drop them, so the rotation waits.
  if (meta.snapshotVersion !== meta.version) throw new Error("ROTATION_REENCRYPT_NOT_SNAPSHOTTED");
  const opened = await openRemoteLibrarySnapshot(oldKey, {
    getLibraryDb: () => getLibraryDb(token, "parrot"),
    download: (objectKey) =>
      downloadStorageObjectViaTunnel(token, objectKey, { clientType: "mobile", clientVersion: "badger-mobile", purpose: "library" }),
    decrypt: decryptBytesToBytes,
    inflate: fflateCodec,
    supportedStorageFormatVersion: STORAGE_FORMAT_VERSION,
  }).catch((err: unknown) => {
    if (err instanceof Error && err.message === "LIBRARY_MISSING") return null;
    if (err instanceof Error && err.message === "DECRYPT_FAILED") throw new Error("ROTATION_REENCRYPT_UNREADABLE");
    throw err;
  });
  if (!opened) return [];
  // Read at the snapshot's version: an edit landing since makes the server answer `version_conflict` (user tries again).
  const dbBytes = await rewriteParrotBytes(opened.dbBytes, resealCopies);
  const copy = await reencryptLibrarySnapshotWith(dbBytes, opened.snapshotVersion, {
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
