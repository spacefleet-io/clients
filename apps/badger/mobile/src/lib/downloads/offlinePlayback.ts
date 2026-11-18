/**
 * Offline playback resolution for the player session.
 *
 * A file with a COMPLETED download plays through the same local proxy
 * (`PlaybackHttpServer` + `MediaCrypto`) but with `clientKind: "offline"`:
 * every object comes from the encrypted on-disk store, no gateway lookup, so
 * it works in airplane mode. Only the downloaded format exists on disk, so the
 * player must be given that format alone (no ABR ladder).
 */
import type { MediaFormat } from "@space/shared/libraryTypes";
import { nativeGetState } from "@space/mobile-media-proxy/downloads";

export type OfflinePlayback = {
  /** Format id that was downloaded. */
  formatId: string;
};

/**
 * Offline source for a file, or null when it is not (fully) downloaded.
 * Reads the native queue directly (authoritative, independent of whether the
 * JS mirror has loaded yet).
 */
export const resolveOfflinePlayback = async (fileId: string): Promise<OfflinePlayback | null> => {
  const { items } = await nativeGetState();
  const item = items.find((i) => i.id === fileId && i.status === "completed");
  return item ? { formatId: item.formatId } : null;
};

/** Restrict a file's formats to the downloaded one. */
export const filterToDownloadedFormat = <T extends Pick<MediaFormat, "id">>(
  formats: T[],
  offline: OfflinePlayback,
): T[] => formats.filter((f) => f.id === offline.formatId);
