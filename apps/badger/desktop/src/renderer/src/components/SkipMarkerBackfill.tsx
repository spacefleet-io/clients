import { useEffect, useRef } from "react";
import { getMetadataSkipMarkers } from "@/api";
import { useAuth } from "@/auth";
import { useLibraryActions, useLibraryData } from "@/lib/libraryContext";
import { runSkipMarkerBackfill } from "@/lib/skipMarkerBackfill";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "skip-marker-backfill" });

/** Lets the library settle and the first screen render before the backfill starts asking the metadata service. */
export const SKIP_BACKFILL_START_DELAY_MS = 15_000;

/**
 * PLAY-NEXT-02: once per app start, after the library has loaded, fetches the
 * service markers of every TV episode that has a file but no marker and no
 * recorded hit/miss (see `runSkipMarkerBackfill`). Renders nothing.
 */
export default function SkipMarkerBackfill() {
  const { user } = useAuth();
  const { loading, writeBlockedReason, media } = useLibraryData();
  const { fetchMediaDetails, listSkipAnalysis, upsertSkipAnalysis, mergeSkipMarkers } = useLibraryActions();
  const startedRef = useRef(false);
  const unmountedRef = useRef(false);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const actionsRef = useRef({ fetchMediaDetails, listSkipAnalysis, upsertSkipAnalysis, mergeSkipMarkers });
  actionsRef.current = { fetchMediaDetails, listSkipAnalysis, upsertSkipAnalysis, mergeSkipMarkers };

  const ready = Boolean(user) && !loading && !writeBlockedReason && media.length > 0;

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    let fired = false;
    // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic (keep-diagnostic-logs)
    console.info("[skip-markers] backfill scheduled", { delayMs: SKIP_BACKFILL_START_DELAY_MS, mediaCount: mediaRef.current.length });
    const timer = window.setTimeout(() => {
      fired = true;
      void runSkipMarkerBackfill(mediaRef.current, {
        fetchMediaDetails: (mediaId) => actionsRef.current.fetchMediaDetails(mediaId),
        listSkipAnalysis: (mediaId, kind) => actionsRef.current.listSkipAnalysis(mediaId, kind),
        upsertSkipAnalysis: (mediaId, episodeId, kind, payload) =>
          actionsRef.current.upsertSkipAnalysis(mediaId, episodeId, kind, payload),
        mergeSkipMarkers: (mediaId, episodeId, markers) =>
          actionsRef.current.mergeSkipMarkers(mediaId, episodeId, markers),
        fetchMarkers: ({ catalogId, seasonNumber, episodeNumber, durationSeconds }) =>
          getMetadataSkipMarkers("", "tv", catalogId, seasonNumber, episodeNumber, durationSeconds),
        sleep: (ms) => {
          const { promise, resolve } = Promise.withResolvers<void>();
          window.setTimeout(resolve, ms);
          return promise;
        },
        log: (message, details) => {
          // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic (keep-diagnostic-logs)
          console.info(message, details);
          log.info(details, message);
        },
        isCancelled: () => unmountedRef.current,
      })
        .then((summary) => log.info(summary, "skip marker backfill finished"))
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic (keep-diagnostic-logs)
          console.error("[skip-markers] backfill crashed", err);
          log.warn({ error: err instanceof Error ? err.message : String(err) }, "skip marker backfill crashed");
        });
    }, SKIP_BACKFILL_START_DELAY_MS);
    return () => {
      if (fired) return;
      // Library went back to loading before the run started: wait for it again.
      window.clearTimeout(timer);
      startedRef.current = false;
    };
  }, [ready]);

  return null;
}
