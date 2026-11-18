/** The renderer's decrypted-artwork cache (META-ART-01/02); the cache itself lives in `@space/metadata-client/artworkCache`. */
import type { ArtworkStore } from "@space/metadata-client";
import { createArtworkStore, createIndexedDbArtworkBackend, createMemoryArtworkBackend } from "@space/metadata-client/artworkCache";

let rendererStore: ArtworkStore | null = null;

/**
 * The app's one store (one byte bound, one index): IndexedDB when the renderer has it, otherwise memory only
 * (nothing persists, nothing breaks). It holds only the decrypted copies of the user's own artwork (META-ART-01:
 * what browsing shows, keyed `vault|<asset ref>`); the metadata service's answers fetched to make those copies stay
 * in memory (`createDesktopImageResolver`), so a migration cannot evict them. Sign-out clears it (`stopMetadataTickets`).
 */
export const getRendererArtworkStore = (): ArtworkStore => {
  const factory = typeof indexedDB === "undefined" ? null : indexedDB;
  rendererStore ??= createArtworkStore(factory ? createIndexedDbArtworkBackend(factory) : createMemoryArtworkBackend());
  return rendererStore;
};

/**
 * Sign-out guard for writes of decrypted artwork. A display that started before sign-out can finish after the
 * store was cleared; it may write only while the session that started it is still open. `stopMetadataTickets`
 * closes the session (and clears the store), `startMetadataTickets` opens a new one.
 */
let artworkSession = { id: 0, open: true };

/** The current artwork session; pass it back to `mayWriteArtwork` before a write. */
export const currentArtworkSession = (): number => artworkSession.id;

/** True while the session `id` is still open (no sign-out since it was read). */
export const mayWriteArtwork = (id: number): boolean => artworkSession.open && artworkSession.id === id;

export const closeArtworkSession = (): void => {
  artworkSession = { id: artworkSession.id + 1, open: false };
};

export const openArtworkSession = (): void => {
  if (!artworkSession.open) artworkSession = { id: artworkSession.id + 1, open: true };
};
