/**
 * The device's pieces of the artwork copy (`artworkCopy.ts`, META-ART-01) for one open library: the metadata
 * service's `image` op, the encrypted store in the user's storage, the ticket count, and a new pass each time a
 * ticket batch lands. Kept apart from the library store so the store does not load the tunnel and ticket modules.
 */
import { Buffer } from "buffer";
import crypto from "react-native-quick-crypto";
import { buildArtworkAssetRef, newArtworkObjectKey } from "@space/library-db-definition/artworkCopy";
import { deleteStorageObjects } from "@space/shared/api";
import { scopeLogger } from "@space/mobile-shell/logger";
import { startArtworkCopy, type ArtworkCopyLibrary } from "./artworkCopy";
import { artworkCacheEpoch, rememberDecryptedArtwork } from "./assets";
import { encryptBytesToBase64 } from "./crypto";
import { uploadObjectViaTunnel } from "./library/transport";
import { fetchArtworkImage, onTicketsArrived, ticketsHeld } from "./metadata/runtime";

const log = scopeLogger("artwork");

/**
 * Encrypts a picture with the library key and stores it in the user's storage under a new random name, as the
 * computer app does (`uploadEncryptedAssetBytes`): base64 ciphertext as UTF-8 text. Returns its `asset:<type>::<key>`
 * reference; the plaintext goes into the local cache, so showing it needs no download.
 */
export const storeEncryptedArtwork = async (token: string, keyBase64: string, bytes: Uint8Array, contentType: string) => {
  // A sign-out while this runs empties the cache; the plaintext must not land in it afterwards.
  const startedEpoch = artworkCacheEpoch();
  const encryptedBase64 = await encryptBytesToBase64(keyBase64, bytes);
  const objectKey = await uploadObjectViaTunnel(
    token,
    newArtworkObjectKey(crypto.randomUUID()),
    new TextEncoder().encode(encryptedBase64),
    { role: "artwork" }
  );
  const ref = buildArtworkAssetRef(objectKey, contentType);
  await rememberDecryptedArtwork(ref, Buffer.from(bytes).toString("base64"), startedEpoch);
  return ref;
};

export type LibraryArtworkCopy = {
  /** Schedules every title that still holds a metadata-service path (library open, after a sync). */
  migrate: () => void;
  stop: () => void;
};

export const startLibraryArtworkCopy = (options: {
  library: ArtworkCopyLibrary;
  token: string;
  keyBase64: string;
  onApplied: () => void;
}): LibraryArtworkCopy => {
  const run = startArtworkCopy({
    library: options.library,
    fetchImage: fetchArtworkImage,
    storeEncrypted: (bytes, contentType) => storeEncryptedArtwork(options.token, options.keyBase64, bytes, contentType),
    ticketsHeld,
    // STOR-PLACE-10: a copy the library did not take (the title was deleted meanwhile) is deleted again at once.
    discard: (keys) => deleteStorageObjects(options.token, keys),
    onApplied: options.onApplied,
    log: (event, detail) => log.info(event, detail),
  });
  const migrate = () => {
    run.migrate().catch((error: unknown) => {
      log.warn("artwork.migration.failed", { reason: error instanceof Error ? error.message : String(error) });
    });
  };
  const unsubscribeTickets = onTicketsArrived(migrate);
  return {
    migrate,
    stop: () => {
      unsubscribeTickets();
      run.stop();
    },
  };
};
