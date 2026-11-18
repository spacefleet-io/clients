/**
 * META-ART-01 on the phone and the TV: artwork still stored in the library as metadata-service paths is copied into
 * the user's storage, encrypted, and the library is pointed at the copies (`media.upsert`, so every device shows the
 * copy). Screens never ask the metadata service for a picture (`useMediaImage`); this copy is the one place this
 * device spends tickets on pictures.
 *
 * The shared runtime (`@space/library-db-definition/artworkCopy`) decides what to copy, paces the titles and swaps the
 * copies in; this file supplies the device's pieces (image fetch, encrypted store, ticket count) and the ticket floor.
 * A failure leaves the path in place; the next pass (library open, a sync, tickets arriving) retries it.
 */
import {
  ARTWORK_COPY_PAUSE_MS,
  copyMediaArtwork,
  createArtworkCopyQueue,
  createVaultArtworkUpload,
  scheduleArtworkMigration,
  type ArtworkCopyStore,
  type ArtworkFetchOutcome,
  type ArtworkKind,
} from "@space/library-db-definition/artworkCopy";

/**
 * Tickets the copy always leaves in the reserve, so a long series' stills never starve the user's own lookups (the
 * reserve holds 600 and refills below 300 on its own schedule, META-ANON-02). Same floor as the computer app.
 */
export const ARTWORK_COPY_TICKET_FLOOR = 100;

export type ArtworkCopyLibrary = ArtworkCopyStore & {
  /** Titles that still hold a metadata-service path somewhere (the migration of an existing library). */
  listMediaWithArtworkToCopy(): Promise<string[]>;
};

export type ArtworkCopyDeps = {
  library: ArtworkCopyLibrary;
  /** The metadata service's `image` op as bytes (`fetchArtworkImage` in `metadata/runtime.ts`). */
  fetchImage: (kind: ArtworkKind, path: string) => Promise<ArtworkFetchOutcome>;
  /** Encrypts with the library key, stores under a random name, answers the `asset:<type>::<key>` reference. */
  storeEncrypted: (bytes: Uint8Array, contentType: string) => Promise<string>;
  ticketsHeld: () => Promise<number>;
  /** A title's artwork was swapped in: the lists re-read the library. */
  onApplied?: (mediaId: string) => void;
  log: (event: string, detail: Record<string, unknown>) => void;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type ArtworkCopyRun = {
  /** Schedules every title that still holds a metadata-service path; resolves with how many were scheduled. */
  migrate: () => Promise<number>;
  /** Resolves once everything scheduled so far has run. */
  idle: () => Promise<void>;
  /** The library closed or the user signed out: nothing more runs. */
  stop: () => void;
};

/**
 * A title with a picture that failed (the service or the storage erred) waits this long before a pass retries it, so
 * a picture that keeps failing does not spend a ticket on every sync and every ticket batch.
 */
export const ARTWORK_COPY_FAILED_RETRY_MS = 30 * 60 * 1000;

export const startArtworkCopy = (deps: ArtworkCopyDeps): ArtworkCopyRun => {
  const now = deps.now ?? Date.now;
  const canSpend = async () => (await deps.ticketsHeld()) > ARTWORK_COPY_TICKET_FLOOR;
  let stopped = false;
  const retryAfter = new Map<string, number>();
  const coolDown = (mediaId: string) => retryAfter.set(mediaId, now() + ARTWORK_COPY_FAILED_RETRY_MS);
  const coolingDown = (mediaId: string) => {
    const until = retryAfter.get(mediaId);
    if (until === undefined) return false;
    if (until > now()) return true;
    retryAfter.delete(mediaId);
    return false;
  };
  const upload = createVaultArtworkUpload({
    fetchImage: deps.fetchImage,
    // Signed out or library closed mid-title: nothing more goes to the user's storage.
    storeEncrypted: async (bytes, contentType) => {
      if (stopped) throw new Error("ARTWORK_COPY_STOPPED");
      return deps.storeEncrypted(bytes, contentType);
    },
    onError: (stage, error) => deps.log("artwork.copy.upload_failed", { stage, reason: error instanceof Error ? error.name : "unknown" }),
  });
  const queue = createArtworkCopyQueue({
    run: async (mediaId, control) => {
      // At the floor already: the title waits for the next pass instead of opening its details for nothing.
      if (stopped || !(await canSpend())) return;
      const result = await copyMediaArtwork({ store: deps.library, mediaId, upload, canSpend, shouldYield: control.shouldYield });
      deps.log("artwork.copy", { ...result });
      if (result.failed > 0) coolDown(mediaId);
      if (result.applied > 0 && !stopped) deps.onApplied?.(mediaId);
      return result;
    },
    onError: (mediaId, error) => {
      coolDown(mediaId);
      deps.log("artwork.copy.failed", { mediaId, reason: error instanceof Error ? error.name : "unknown" });
    },
    pauseMs: deps.pauseMs ?? ARTWORK_COPY_PAUSE_MS,
    sleep: deps.sleep,
  });

  return {
    migrate: async () => {
      if (stopped || !(await canSpend())) return 0;
      const titles = await scheduleArtworkMigration({
        listMediaIds: async () => (await deps.library.listMediaWithArtworkToCopy()).filter((mediaId) => !coolingDown(mediaId)),
        hasArtworkToCopy: () => true,
        queue,
      });
      deps.log("artwork.migration.scheduled", { titles });
      return titles;
    },
    idle: () => queue.idle(),
    stop: () => {
      stopped = true;
      queue.stop();
    },
  };
};
