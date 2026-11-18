/**
 * Renderer-side offline-availability state.
 *
 * Hydrates from the runtime via `badger.offline.list_local` and exposes a
 * shared `useOfflineStateByMediaId()` hook that components can consume to
 * roll the per-fileId data up into per-media `"none" | "partial" | "full"`
 * states for tile badges and modal header summaries.
 *
 * Why a separate module (not part of libraryContext): offline-state is a
 * per-device fact that the runtime owns, and we don't want to entangle it
 * with the SQLite library snapshot (which is per-library, not per-device).
 * Keep it cheap: one round-trip on mount + a small in-memory store.
 *
 * Phase 3 of the offline-mode plan (Layer C, item 15 — tiles & dashboard).
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { callOfflineListLocal, isOfflineIpcError } from "./offlineIpc";
import type { MediaDetails, MediaRow } from "@/lib/libraryDb";
import { collectOfflineLocalCounts } from "./offlineEstimator";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "offline-state" });

/** A single entry from `badger.offline.list_local`. */
export type OfflineLocalEntry = {
  mediaId: string;
  fileId: string;
  quality: string;
  container: "mkv" | "mp4";
  totalBytes: number;
  downloadedAt: string;
  localPath: string;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type StoreState = {
  /** Lookup of all currently-locally-saved entries, keyed by fileId. */
  byFileId: Map<string, OfflineLocalEntry>;
  /** Bumped on every mutation; used by `useSyncExternalStore` snapshot identity. */
  version: number;
  /** True while the initial bootstrap is in flight. */
  loading: boolean;
  /** Most recent fetch error (if any). */
  error: string | null;
};

let state: StoreState = {
  byFileId: new Map(),
  version: 0,
  loading: false,
  error: null,
};

const listeners = new Set<() => void>();

const notify = () => {
  listeners.forEach((cb) => cb());
};

const setState = (next: Partial<StoreState>) => {
  state = { ...state, ...next, version: state.version + 1 };
  notify();
};

export const subscribeOfflineState = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const getOfflineStateSnapshot = (): StoreState => state;

let bootstrapped = false;
let refcount = 0;

const hydrate = async (mediaIds?: string[]) => {
  setState({ loading: true, error: null });
  try {
    const result = await callOfflineListLocal(mediaIds ? { mediaIds } : {});
    if (isOfflineIpcError(result)) {
      log.warn(
        { errorCode: result.errorCode, status: result.status, message: result.message },
        "list_local_ipc_failed",
      );
      setState({ loading: false, error: result.message ?? result.errorCode ?? "ipc_failed" });
      return;
    }
    // Targeted hydration: when mediaIds is supplied, we only update the
    // slice of the byFileId map for those ids — preserving entries for
    // other media that may be in the cache. This is the modal-open path.
    const next = mediaIds ? new Map(state.byFileId) : new Map<string, OfflineLocalEntry>();
    if (mediaIds) {
      // Drop existing entries for the requested mediaIds, then re-insert.
      next.forEach((entry, fileId) => {
        if (mediaIds.includes(entry.mediaId)) next.delete(fileId);
      });
    }
    result.entries.forEach((entry) => {
      next.set(entry.fileId, entry);
    });
    state = { ...state, byFileId: next, version: state.version + 1, loading: false, error: null };
    notify();
    log.info(
      { entries: result.entries.length, scope: mediaIds ? "targeted" : "full" },
      "list_local_ok",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, "list_local_threw");
    setState({ loading: false, error: message });
  }
};

/**
 * Acquire the store. Refcounted — the FIRST acquire triggers a full hydrate;
 * subsequent acquires are free. Match each acquire() with a release(). The
 * store survives the last release (no reset) so re-mounting a tile doesn't
 * flicker through a "no data" state.
 */
export const acquireOfflineState = () => {
  refcount += 1;
  if (!bootstrapped) {
    bootstrapped = true;
    void hydrate();
  }
};

export const releaseOfflineState = () => {
  refcount = Math.max(0, refcount - 1);
};

/** Force a fresh full hydrate (e.g. after a submit completes). */
export const refreshOfflineState = () => {
  void hydrate();
};

/** Targeted re-hydrate for a single media item (modal-open path). */
export const refreshOfflineStateForMedia = (mediaId: string) => {
  void hydrate([mediaId]);
};

/** Test-only — reset the store between unit tests. */
export const __resetOfflineStateForTests = () => {
  state = { byFileId: new Map(), version: 0, loading: false, error: null };
  listeners.clear();
  bootstrapped = false;
  refcount = 0;
};

// ---------------------------------------------------------------------------
// Public hook API
// ---------------------------------------------------------------------------

/**
 * Subscribe to the offline-state store. Returns the raw byFileId map; for
 * per-media roll-ups use `useOfflineStateByMediaId()` instead.
 */
export const useOfflineState = (): StoreState => {
  useEffect(() => {
    acquireOfflineState();
    return () => {
      releaseOfflineState();
    };
  }, []);
  return useSyncExternalStore(subscribeOfflineState, getOfflineStateSnapshot, getOfflineStateSnapshot);
};

/** A per-mediaId roll-up — the shape MediaRow's `offlineState` reflects. */
export type OfflineStateRollUp = "none" | "partial" | "full";

/**
 * Resolve the per-media offline state from the store, given the full
 * MediaRow list (for "how many files total per media?"). When a media row's
 * full-vs-partial count can't be derived from MediaRow alone, the helper
 * conservatively returns "partial" if at least one file is saved.
 *
 * For accurate full vs partial classification on TV, the modal should pass
 * MediaDetails directly via `collectOfflineLocalCounts` instead.
 */
export const useOfflineStateByMediaId = (
  media: MediaRow[] | undefined,
): Map<string, OfflineStateRollUp> => {
  const store = useOfflineState();
  return useMemo(() => {
    const out = new Map<string, OfflineStateRollUp>();
    if (!media || store.byFileId.size === 0) return out;
    // Group local fileIds by mediaId.
    const localCountByMediaId = new Map<string, number>();
    store.byFileId.forEach((entry) => {
      localCountByMediaId.set(
        entry.mediaId,
        (localCountByMediaId.get(entry.mediaId) ?? 0) + 1,
      );
    });
    media.forEach((row) => {
      const localCount = localCountByMediaId.get(row.id) ?? 0;
      if (localCount === 0) {
        out.set(row.id, "none");
        return;
      }
      // Movies: a single file → presence = full.
      if (row.type === "movie") {
        out.set(row.id, "full");
        return;
      }
      // TV: need total episode count. Use `episodeCount` (the user's added
      // episodes — what's playable) when present; if it's null/0 use
      // totalEpisodes (the show's full count from metadata). When neither
      // gives us a real denominator we default to "partial" — a
      // conservative, non-misleading badge.
      const total = row.episodeCount || row.totalEpisodes || 0;
      if (total === 0) {
        out.set(row.id, "partial");
        return;
      }
      out.set(row.id, localCount >= total ? "full" : "partial");
    });
    return out;
    // store.version is intentionally included alongside store.byFileId so
    // a forced refresh — which would currently always also swap byFileId —
    // is also covered if we ever switch to an in-place mutation strategy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, store.byFileId, store.version]);
};

// ---------------------------------------------------------------------------
// Per-media-details helpers — used by the modal where MediaDetails IS in
// scope, so we can compute the precise per-episode key set.
// ---------------------------------------------------------------------------

/**
 * Return the set of fileIds known to be locally saved for the given mediaId.
 * Cheap accessor for `collectOfflineLocalCounts(details, fileIds)`.
 */
export const localFileIdsForMedia = (mediaId: string): Set<string> => {
  const out = new Set<string>();
  state.byFileId.forEach((entry) => {
    if (entry.mediaId === mediaId) out.add(entry.fileId);
  });
  return out;
};

/**
 * Return the on-disk path of a locally-saved file, or null if not saved.
 * Used by the playback engine to pick the offline source: the path originates
 * from the runtime's `list_local` (trusted) and is validated again in the main
 * process before serving. Reads module state directly (the store is hydrated
 * by the time playback starts). @bugfix offline-playback-ignored-local-file
 */
export const offlineLocalPathForFile = (fileId: string): string | null =>
  state.byFileId.get(fileId)?.localPath ?? null;

/**
 * Resolve the modal-level offline counts for a MediaDetails. Pure wrapper
 * around `collectOfflineLocalCounts` that pulls the local fileIds from the
 * store.
 */
export const computeOfflineLocalCountsForDetails = (details: MediaDetails | null) => {
  if (!details) {
    return collectOfflineLocalCounts(null, new Set<string>());
  }
  const fileIds = localFileIdsForMedia(details.id);
  return collectOfflineLocalCounts(details, fileIds);
};
