/**
 * META-ART-01 on the desktop: after a title is matched (or refreshed, restored, or opened), its artwork still stored
 * as catalog paths is copied into the user's storage, encrypted, and the library is pointed at the copies.
 *
 * The shared runtime (`@space/library-db-definition/artworkCopy`) decides what to copy and how to apply it; this file
 * only supplies the desktop's uploader (metadata service `image` op, META-ART-02, then encrypt and upload under a
 * random name: `uploadEncryptedAssetFromMetadata`) and the ticket floor. It runs in the background, one title at a
 * time; a failure leaves the catalog path in place and the next schedule of that title retries it.
 */
import {
  ARTWORK_COPY_PAUSE_MS,
  copyMediaArtwork,
  createArtworkCopyQueue,
  type ArtworkCopyQueue,
  type ArtworkCopyRunControl,
  type ArtworkCopyResult,
  type ArtworkCopyStore,
  type ArtworkKind,
  type ArtworkUploadOutcome,
} from "@space/library-db-definition/artworkCopy";
import { AssetArtworkError } from "@/lib/assetArtworkError";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "artwork-copy" });

/**
 * Tickets the background copy always leaves in the reserve, so a long series' stills never starve the user's own
 * searches and detail lookups (the reserve holds 600 and refills below 300 on its own schedule, META-ANON-02).
 */
export const ARTWORK_COPY_TICKET_FLOOR = 100;

export type ArtworkUpload = (kind: ArtworkKind, path: string) => Promise<string>;

/** Maps the uploader's errors onto the copy's outcomes: only `AssetArtworkError("missing")` means "no such image". */
export const toUploadOutcome = async (upload: ArtworkUpload, kind: ArtworkKind, path: string): Promise<ArtworkUploadOutcome> => {
  try {
    return { status: "ok", key: await upload(kind, path) };
  } catch (error) {
    if (error instanceof AssetArtworkError) {
      // A 429/503 carries the service's Retry-After: the shared copy waits it out and asks for the same picture again.
      if (error.reason === "rate_limited") return error.retryAfterMs === undefined ? { status: "rate_limited" } : { status: "rate_limited", retryAfterMs: error.retryAfterMs };
      return { status: error.reason };
    }
    log.warn({ kind, message: error instanceof Error ? error.message : String(error) }, "artwork upload failed");
    return { status: "unavailable" };
  }
};

export type DesktopArtworkCopyDeps = {
  store: ArtworkCopyStore;
  upload: ArtworkUpload;
  /** Tickets left in the reserve; the copy stops at `ARTWORK_COPY_TICKET_FLOOR`. */
  ticketsLeft: () => Promise<number>;
  /** Called after a run that changed the library (refreshes the snapshot). */
  onApplied?: (result: ArtworkCopyResult) => void | Promise<void>;
  /** The wait after a "slow down" (tests pass a fake clock); real timers otherwise. */
  sleep?: (ms: number) => Promise<void>;
};

export const runDesktopArtworkCopy = async (
  deps: DesktopArtworkCopyDeps,
  mediaId: string,
  control?: ArtworkCopyRunControl
): Promise<ArtworkCopyResult> => {
  const result = await copyMediaArtwork({
    store: deps.store,
    mediaId,
    upload: (kind, path) => toUploadOutcome(deps.upload, kind, path),
    canSpend: async () => (await deps.ticketsLeft()) > ARTWORK_COPY_TICKET_FLOOR,
    // A background title stops between pictures for one the user just matched, refreshed or opened.
    ...(control ? { shouldYield: control.shouldYield } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  log.info(result, result.yielded ? "artwork copy yielded" : "artwork copy");
  if (result.applied > 0) await deps.onApplied?.(result);
  return result;
};

/** Least time between two library re-reads caused by artwork copies (the first one runs at once). */
export const ARTWORK_REFRESH_GAP_MS = 15_000;

export const createDesktopArtworkCopyQueue = (deps: DesktopArtworkCopyDeps): ArtworkCopyQueue =>
  createArtworkCopyQueue({
    run: (mediaId, control) => runDesktopArtworkCopy(deps, mediaId, control),
    // A whole library migrating (`scheduleArtworkMigration`) is paced, never a burst at the metadata service.
    pauseMs: ARTWORK_COPY_PAUSE_MS,
    onError: (mediaId, error) =>
      log.warn({ mediaId, message: error instanceof Error ? error.message : String(error) }, "artwork copy failed"),
  });
