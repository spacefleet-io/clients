import { decryptMediaObject } from "@space/media-crypto";
import { downloadStorageObjectViaTunnel } from "@space/library-db-runtime/api";
import { cachedChunkLoader, type ParrotChunkLoader } from "@space/parrot-core";
import { PARROT_APP_ID } from "./importer";

/**
 * Downloads and decrypts chunks on Node (the desktop's player), through the shared chunk cache of
 * `@space/parrot-core` (recent chunks kept up to `maxBytes`, one download per chunk in flight). A chunk kept on the
 * computer (`readKept`, PAR-OFFL-03) is read from disk instead, so a kept song plays with no connection.
 */
export const createParrotChunkLoader = (input: {
  token: () => string;
  libraryKeyBase64: () => string;
  /** The profile the playback is for (STOR-BW-11): the account's main profile. The gateway refuses a playback without it. */
  profileId: () => Promise<string | null>;
  clientType: string;
  maxBytes?: number;
  download?: typeof downloadStorageObjectViaTunnel;
  /** A kept chunk's sealed bytes, or null when it is not kept here. */
  readKept?: (objectKey: string) => Promise<Uint8Array | null>;
  log?: (message: string) => void;
  /** Each chunk downloaded (not read from disk): its sealed size and how long it took, to measure the connection (PAR-PLAY-02). */
  onDownloaded?: (bytes: number, ms: number) => void;
}): ParrotChunkLoader & { clear: () => void } => {
  const download = input.download ?? downloadStorageObjectViaTunnel;
  const downloadMeasured = async (objectKey: string) => {
    const profileId = await input.profileId();
    const started = performance.now();
    const sealed = await download(input.token(), objectKey, { clientType: input.clientType, profileId }, PARROT_APP_ID);
    input.onDownloaded?.(sealed.length, performance.now() - started);
    return sealed;
  };
  return cachedChunkLoader({
    maxBytes: input.maxBytes,
    log: input.log,
    open: async (chunk) => {
      const sealed = (await input.readKept?.(chunk.objectKey)) ?? (await downloadMeasured(chunk.objectKey));
      return new Uint8Array(decryptMediaObject(sealed, input.libraryKeyBase64()));
    },
  });
};
