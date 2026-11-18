import RNFS from "react-native-fs";
import { Buffer } from "buffer";
import crypto from "react-native-quick-crypto";
import { downloadStorageObjectViaTunnel } from "@space/shared/api";
import { scopeLogger } from "@space/mobile-shell/logger";
import { decryptBase64ToBytes } from "./crypto";
import { createVaultArtworkCache, parseAssetRef } from "./vaultArtworkCache";

const log = scopeLogger("artwork");

const assetCacheDir = () => `${RNFS.CachesDirectoryPath}/assets`;
/** Where older builds kept pictures fetched from the metadata service at display time; nothing reads it any more. */
const legacyMetadataImagesDir = () => `${RNFS.CachesDirectoryPath}/metadata-images`;
/** A picture being written; renamed into place once whole, so a crash never leaves a cut file the next start would show. */
const PARTIAL_SUFFIX = ".part";

const removeLegacyMetadataImages = async () => {
  try {
    if (await RNFS.exists(legacyMetadataImagesDir())) await RNFS.unlink(legacyMetadataImagesDir());
  } catch {
    log.warn("artwork.legacy_cache.remove_failed", {});
  }
};

/**
 * The decrypted pictures of the library on this device (META-ART-01/02): kept across restarts, under 128 MiB, emptied
 * on sign-out (`clearAssetUrlCache`, from the ticket lifecycle's erase).
 */
const vaultArtwork = createVaultArtworkCache({
  files: {
    pathFor: (fileName) => `${assetCacheDir()}/${fileName}`,
    exists: (path) => RNFS.exists(path),
    writeBase64: async (path, base64) => {
      const dir = assetCacheDir();
      if (!(await RNFS.exists(dir))) await RNFS.mkdir(dir);
      const partial = `${path}${PARTIAL_SUFFIX}`;
      await RNFS.writeFile(partial, base64, "base64");
      if (await RNFS.exists(path)) await RNFS.unlink(path);
      await RNFS.moveFile(partial, path);
    },
    list: async () => {
      const dir = assetCacheDir();
      if (!(await RNFS.exists(dir))) return [];
      const entries = await RNFS.readDir(dir);
      return entries
        .filter((entry) => entry.isFile() && !entry.path.endsWith(PARTIAL_SUFFIX))
        .map((entry) => ({ path: entry.path, size: Number(entry.size), mtime: entry.mtime?.getTime() ?? 0 }));
    },
    remove: async (path) => {
      if (await RNFS.exists(path)) await RNFS.unlink(path);
    },
    removeAll: async () => {
      const dir = assetCacheDir();
      if (await RNFS.exists(dir)) await RNFS.unlink(dir);
    },
    touch: async (path, mtimeMs) => {
      await RNFS.touch(path, new Date(mtimeMs), new Date(mtimeMs));
    },
  },
  hash: (input) => crypto.createHash("sha256").update(input).digest("hex"),
  onEvent: (event, detail) => log.info(event, detail),
});
void removeLegacyMetadataImages();

/** The session token and library key a download from the user's storage needs; null while signed out. */
export type AssetCredentials = () => Promise<{ token: string; keyBase64: string } | null>;

/**
 * `file://` URL of a stored picture: the copy on this device first (no session needed), else downloaded once from the
 * user's storage and decrypted. Null when neither is possible now.
 */
export const getDecryptedAssetUrl = (assetRef: string, credentials: AssetCredentials) =>
  vaultArtwork.load(assetRef, async (objectKey) => {
    const signedIn = await credentials();
    if (!signedIn) throw new Error("SIGNED_OUT");
    const payload = await downloadStorageObjectViaTunnel(signedIn.token, objectKey, {
      clientType: "mobile",
      clientVersion: "mobile-assets",
      // Posters/backdrops are library artwork: they keep flowing while the silo is saturated (STOR-BW-09).
      purpose: "library",
    });
    const decrypted = await decryptBase64ToBytes(signedIn.keyBase64, Buffer.from(payload).toString("utf8"));
    return Buffer.from(decrypted).toString("base64");
  });

export const getCachedAssetUrl = (assetRef: string): string | null => vaultArtwork.getCached(assetRef);

/** Sign-out: every decrypted picture leaves the device (and what older builds left behind). */
export const clearAssetUrlCache = async () => {
  await vaultArtwork.reset();
  await removeLegacyMetadataImages();
};

/** Read before storing a copy; a sign-out after it makes `rememberDecryptedArtwork` keep nothing. */
export const artworkCacheEpoch = () => vaultArtwork.epoch();

/** A copy this device just stored (`libraryArtworkCopy.ts`): its plaintext goes into the cache, no download. */
export const rememberDecryptedArtwork = (assetRef: string, base64: string, startedEpoch?: number) =>
  vaultArtwork.put(assetRef, base64, startedEpoch);

export const isAssetKey = (value: string | null) => {
  if (!value) return false;
  return value.startsWith("asset:") || value.startsWith("assets/");
};

export const extractAssetObjectKey = (value: string | null) => {
  if (!value) return null;
  const { objectKey } = parseAssetRef(value);
  return objectKey || null;
};
