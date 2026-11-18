/**
 * LIB-CREW-01 backfill on the desktop: runs the shared `backfillMissingCrew` against the opened library, with the
 * metadata service's details lookup (the ticket pipeline "Restore from TMDB" uses) as the fetch. Writes only the
 * crew of a title that still holds none. Progress is published for the quiet line in the Jobs sidebar; nothing
 * else is shown.
 */
import { useSyncExternalStore } from "react";
import { MetadataUnavailableError, NoTicketError } from "@space/metadata-client";
import { backfillMissingCrew, type CrewBackfillResult } from "@space/library-db-runtime/crewBackfill";
import { pickLibraryCrew } from "@space/shared/libraryCrew";
import type { LibraryDb } from "@/lib/libraryDb";
import { getTmdbDetails } from "@/lib/metadata";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "crew-backfill" });

/** Lets the library settle and the first screen render before the first lookup. */
export const CREW_BACKFILL_START_DELAY_MS = 20_000;
/** Filled titles between two snapshot refreshes, so the web player and other readers see crew arrive in batches. */
const SNAPSHOT_REFRESH_EVERY = 25;

export type CrewBackfillProgress = { handled: number; total: number } | null;

let progress: CrewBackfillProgress = null;
const listeners = new Set<() => void>();
const publish = (next: CrewBackfillProgress) => {
  progress = next;
  for (const listener of listeners) listener();
};

/** The running pass's progress, or null when none runs (the Jobs sidebar shows its line only then). */
export const useCrewBackfillProgress = (): CrewBackfillProgress =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => progress
  );

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  window.setTimeout(resolve, ms);
  return promise;
};

/** Starts the pass after the start delay; the returned function stops it between titles (sign-out, library closed). */
export const startCrewBackfill = (
  db: LibraryDb,
  token: string,
  onFilled: () => Promise<unknown>
): { stop: () => void; done: Promise<CrewBackfillResult | null> } => {
  let stopped = false;
  let filledSinceRefresh = 0;
  const fetchCrew = async (mediaId: string): Promise<number> => {
    const details = await db.getMediaDetails(mediaId);
    if (!details || details.tmdbId === null) return 0;
    // Crew written meanwhile (a restore, an edit) is the user's: never replaced.
    if (details.crew?.length) return details.crew.length;
    const fresh = await getTmdbDetails(token, details.type, details.tmdbId);
    const crew = pickLibraryCrew(fresh.crew ?? []);
    if (crew.length === 0) return 0;
    await db.updateMediaMetadata({ mediaId, crew });
    filledSinceRefresh += 1;
    if (filledSinceRefresh >= SNAPSHOT_REFRESH_EVERY) {
      filledSinceRefresh = 0;
      await onFilled();
    }
    return crew.length;
  };

  const done = sleep(CREW_BACKFILL_START_DELAY_MS).then(async () => {
    if (stopped) return null;
    try {
      const result = await backfillMissingCrew(db, {
        fetchCrew,
        sleep,
        isOffline: () => !navigator.onLine,
        isPlaying: async () => (await window.sf?.isExternalMpvAlive?.().catch(() => false)) ?? false,
        retryAfterMs: (error) => {
          if (error instanceof MetadataUnavailableError) return (error.retryAfterSeconds ?? 0) * 1000;
          if (error instanceof NoTicketError) return 0;
          return null;
        },
        shouldStop: () => stopped,
        onProgress: (handled, total) => publish(handled < total ? { handled, total } : null),
        log: (message, details) => log.info(details, message),
      });
      if (filledSinceRefresh > 0) await onFilled();
      if (result.found > 0) log.info(result, "crew backfill finished");
      return result;
    } catch (err) {
      log.warn({ err: String(err) }, "crew backfill crashed");
      return null;
    } finally {
      publish(null);
    }
  });
  return {
    stop: () => {
      stopped = true;
    },
    done,
  };
};
