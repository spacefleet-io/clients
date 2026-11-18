/**
 * Offline downloads of titles that no longer exist in the library (LIB-OPS-02): cancel them in the native
 * queue and drop their files, so the phone does not keep storing a media that was deleted on another device.
 * A `media.delete` op names the titles; a snapshot that replaced the library names the titles that remain.
 *
 * Reads the native queue directly (not the JS mirror, which is only fed once the downloads bridge started)
 * and never throws: the library rows are already gone, a failing native call must not undo or stall the sync.
 */
import { scopeLogger } from "@space/mobile-shell/logger";
import { nativeGetState, nativeRemove } from "@space/mobile-media-proxy/downloads";

const log = scopeLogger("downloads");

const removeDownloadsWhere = async (scope: string, isGone: (mediaId: string) => boolean): Promise<void> => {
  try {
    const { items } = await nativeGetState();
    const fileIds = items.filter((item) => isGone(item.mediaId)).map((item) => item.id);
    log.info(`${scope}.remove`, { downloads: items.length, removed: fileIds.length });
    if (fileIds.length > 0) await nativeRemove(fileIds);
  } catch (err) {
    log.warn(`${scope}.remove_failed`, { error: String(err) });
  }
};

/** Downloads of the titles `media.delete` ops removed. */
export const removeDownloadsOfDeletedMedia = async (mediaIds: ReadonlySet<string>): Promise<void> => {
  if (mediaIds.size === 0) return;
  await removeDownloadsWhere("media_deleted", (mediaId) => mediaIds.has(mediaId));
};

/** Downloads of every title missing from the library, given the ids of the titles it holds. */
export const removeDownloadsOutsideLibrary = (libraryMediaIds: ReadonlySet<string>): Promise<void> =>
  removeDownloadsWhere("outside_library", (mediaId) => !libraryMediaIds.has(mediaId));
