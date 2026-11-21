import { decryptMediaObject } from "@space/media-crypto";
import { openStorageDownloadSession, type StorageDownloadSession } from "@space/library-db-runtime/api";
import { cachedChunkLoader, type ParrotChunkLoader } from "@space/parrot-core";
import { PARROT_APP_ID } from "./importer";

/**
 * How many chunks of one song download side by side (PAR-PLAY-08): each on its own reused tunnel session
 * (STOR-REUSE-02), so a song whose index sits at its end (13 MB of `moov` behind the audio) arrives in a few seconds
 * instead of one ~0.9 s session per 1 MiB chunk.
 */
export const PARROT_DOWNLOAD_LANES_PER_FILE = 4;
/** A song's sessions end once none of its chunks was asked for this long. */
export const PARROT_DOWNLOAD_SESSION_IDLE_MS = 20_000;

type Lane = { session: StorageDownloadSession; queued: number };
type FileSessions = { token: string; profileId: string | null; lanes: Lane[]; idle: ReturnType<typeof setTimeout> | null };

/**
 * Downloads and decrypts chunks on Node (the desktop's player), through the shared chunk cache of
 * `@space/parrot-core` (recent chunks kept up to `maxBytes`, one download per chunk in flight). A chunk kept on the
 * computer (`readKept`, PAR-OFFL-03) is read from disk instead, so a kept song plays with no connection.
 *
 * The chunks of one stored file (one media placement, `media/<placementId>/…`) share up to
 * `PARROT_DOWNLOAD_LANES_PER_FILE` reused tunnel sessions (PAR-PLAY-08): a chunk goes to an idle session, else a new one
 * while there are fewer than that, else the least busy. The sessions end after `PARROT_DOWNLOAD_SESSION_IDLE_MS`
 * without a chunk, on `clear()`, and when the token or profile changes.
 */
export const createParrotChunkLoader = (input: {
  token: () => string;
  libraryKeyBase64: () => string;
  /** The profile the playback is for (STOR-BW-11): the account's main profile. The gateway refuses a playback without it. */
  profileId: () => Promise<string | null>;
  clientType: string;
  maxBytes?: number;
  openSession?: typeof openStorageDownloadSession;
  /** A kept chunk's sealed bytes, or null when it is not kept here. */
  readKept?: (objectKey: string) => Promise<Uint8Array | null>;
  log?: (message: string) => void;
  /** Each chunk downloaded (not read from disk): its sealed size and how long it took, to measure the connection (PAR-PLAY-02). */
  onDownloaded?: (bytes: number, ms: number) => void;
}): ParrotChunkLoader & { clear: () => void } => {
  const openSession = input.openSession ?? openStorageDownloadSession;
  const files = new Map<string, FileSessions>();

  const closeFile = (media: string, file: FileSessions) => {
    if (files.get(media) === file) files.delete(media);
    clearTimeout(file.idle ?? undefined);
    for (const lane of file.lanes) void lane.session.close().catch(() => undefined);
    file.lanes = [];
  };

  const download = async (objectKey: string) => {
    // `media/<placementId>`: every chunk of one stored file lives on its placement's silo.
    const media = objectKey.split("/").slice(0, 2).join("/");
    const token = input.token();
    const profileId = await input.profileId();
    let file = files.get(media);
    if (file && (file.token !== token || file.profileId !== profileId)) {
      closeFile(media, file);
      file = undefined;
    }
    if (!file) {
      file = { token, profileId, lanes: [], idle: null };
      files.set(media, file);
    }
    clearTimeout(file.idle ?? undefined);
    file.idle = null;
    let lane = file.lanes.reduce<Lane | null>((best, next) => (!best || next.queued < best.queued ? next : best), null);
    if (!lane || (lane.queued > 0 && file.lanes.length < PARROT_DOWNLOAD_LANES_PER_FILE)) {
      lane = { session: openSession(token, { objectKey, profileId, clientType: input.clientType }, PARROT_APP_ID), queued: 0 };
      file.lanes.push(lane);
      input.log?.(`[parrot-chunks] ${media}: session ${file.lanes.length} of ${PARROT_DOWNLOAD_LANES_PER_FILE}`);
    }
    lane.queued += 1;
    const started = performance.now();
    try {
      const sealed = await lane.session.download(objectKey);
      input.onDownloaded?.(sealed.length, performance.now() - started);
      return sealed;
    } finally {
      lane.queued -= 1;
      const owner = file;
      if (files.get(media) === owner && owner.lanes.every((each) => each.queued === 0)) {
        owner.idle = setTimeout(() => closeFile(media, owner), PARROT_DOWNLOAD_SESSION_IDLE_MS);
        owner.idle.unref?.();
      }
    }
  };

  const load = cachedChunkLoader({
    maxBytes: input.maxBytes,
    log: input.log,
    open: async (chunk) => {
      const sealed = (await input.readKept?.(chunk.objectKey)) ?? (await download(chunk.objectKey));
      return new Uint8Array(decryptMediaObject(sealed, input.libraryKeyBase64()));
    },
  });
  const clearCache = load.clear;
  load.clear = () => {
    clearCache();
    for (const [media, file] of [...files]) closeFile(media, file);
  };
  return load;
};
