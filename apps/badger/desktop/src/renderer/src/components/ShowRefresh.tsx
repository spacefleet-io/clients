import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth";
import { useLibraryActions, useLibraryData } from "@/lib/libraryContext";
import { getTmdbDetails, keepLocalizedTexts } from "@/lib/metadata";
import type { IngestJobRecord } from "@/lib/runtimeIngestJobs";
import {
  SHOW_REFRESH_STATE_KEY,
  episodeMoveChoices,
  parseShowRefreshState,
  pendingShowDelistings,
  resolveShowDelisting,
  runShowRefreshPass,
  type ShowDelisting,
} from "@/lib/showRefresh";
import type { ShowEpisodeSlot } from "@/lib/libraryDb";
import { toast } from "@space/ui";
import ShowDelistingDialog from "@/components/ShowDelistingDialog";
import ShowEpisodeMoveDialog from "@/components/ShowEpisodeMoveDialog";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "show-refresh" });

/** Lets the library settle and the first screen render before the first pass asks TMDB. */
export const SHOW_REFRESH_START_DELAY_MS = 60_000;
/** A pass runs every hour while the app stays open, so a show is checked on its air day and never drifts a day; each show still waits its day (see `showRefreshDueReason`). */
export const SHOW_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** Import jobs a refresh should not interleave its writes with. */
const IMPORT_JOB_KINDS: Record<string, true> = { source: true, format: true };
/** Same terminal set as the jobs UI: an `interrupted` job left behind must not block the refresh forever. */
const FINISHED_JOB_STATUSES: Record<string, true> = { succeeded: true, failed: true, cancelled: true, interrupted: true };

const loadState = () => parseShowRefreshState(window.localStorage.getItem(SHOW_REFRESH_STATE_KEY));

/**
 * LIB-SHOW-01: keeps the episode lists of shows that are still airing current.
 * One pass a minute after the library loads, then one an hour; each pass
 * refreshes only the shows that are due (see `runShowRefreshPass`).
 * LIB-SHOW-02: after each pass, offers the episodes TMDB stopped listing for
 * removal, one show at a time (`ShowDelistingDialog`).
 * LIB-SHOW-04: then, one episode at a time, suggests a move for each one the
 * user has a file for (`ShowEpisodeMoveDialog`).
 */
export default function ShowRefresh() {
  const { user, token } = useAuth();
  const { i18n, t } = useTranslation();
  const { loading, writeBlockedReason, media } = useLibraryData();
  const { refreshShowEpisodes, removeEpisodesNotOnTmdb, moveEpisodeToSlot, fetchMediaDetails } = useLibraryActions();
  // Offers left from an earlier session show as soon as the library is ready, before the first pass.
  const [delistings, setDelistings] = useState<ShowDelisting[]>(() => pendingShowDelistings(loadState()));
  const [removing, setRemoving] = useState(false);
  const [moveChoices, setMoveChoices] = useState<{ key: string; choices: ShowEpisodeSlot[] } | null>(null);
  const unmountedRef = useRef(false);
  const runningRef = useRef(false);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const inputsRef = useRef({ token, refreshShowEpisodes, accountLanguage: i18n.language || "en" });
  inputsRef.current = { token, refreshShowEpisodes, accountLanguage: i18n.language || "en" };

  const ready = Boolean(user) && Boolean(token) && !loading && !writeBlockedReason && media.length > 0;

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const runPass = () => {
      if (runningRef.current) return;
      runningRef.current = true;
      void runShowRefreshPass(mediaRef.current, {
        fetchDetails: async (tmdbId) => {
          const { token: currentToken, accountLanguage: language } = inputsRef.current;
          if (!currentToken) throw new Error("AUTH_REQUIRED");
          // Episode names are in the account's language (UX-I18N-07, ACCT-PROF-03), like the stored ones.
          const details = await getTmdbDetails(currentToken, "tv", tmdbId, language);
          // The refresh already holds the show's texts in this language: keep them (LIB-LANG-02), no extra lookup.
          const episodeKeys = (details.episodes ?? []).map((episode) => `${episode.seasonNumber}:${episode.episodeNumber}`);
          void keepLocalizedTexts("tv", tmdbId, language, details, episodeKeys).catch(() => undefined);
          return details;
        },
        refreshShowEpisodes: (mediaId, item) => inputsRef.current.refreshShowEpisodes(mediaId, item),
        isLibraryBusy: async () => {
          const list = window.sf?.runtimeJobs?.list;
          if (!list) return false;
          const snapshot = await list({});
          return ((snapshot?.jobs ?? []) as IngestJobRecord[]).some(
            (job) => IMPORT_JOB_KINDS[job.kind] === true && FINISHED_JOB_STATUSES[job.status] !== true
          );
        },
        loadState,
        saveState: (state) => window.localStorage.setItem(SHOW_REFRESH_STATE_KEY, JSON.stringify(state)),
        sleep: (ms) => {
          const { promise, resolve } = Promise.withResolvers<void>();
          window.setTimeout(resolve, ms);
          return promise;
        },
        log: (message, details) => {
          // eslint-disable-next-line no-console -- intentional [show-refresh] diagnostic (keep-diagnostic-logs)
          console.info(message, details);
          log.info(details, message);
        },
        isCancelled: () => unmountedRef.current,
      })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console -- intentional [show-refresh] diagnostic (keep-diagnostic-logs)
          console.error("[show-refresh] pass crashed", err);
          log.warn({ error: err instanceof Error ? err.message : String(err) }, "show refresh pass crashed");
        })
        .finally(() => {
          runningRef.current = false;
          if (!unmountedRef.current) setDelistings(pendingShowDelistings(loadState()));
        });
    };
    // eslint-disable-next-line no-console -- intentional [show-refresh] diagnostic (keep-diagnostic-logs)
    console.info("[show-refresh] scheduled", { delayMs: SHOW_REFRESH_START_DELAY_MS, intervalMs: SHOW_REFRESH_INTERVAL_MS });
    let interval: number | null = null;
    const timer = window.setTimeout(() => {
      runPass();
      interval = window.setInterval(runPass, SHOW_REFRESH_INTERVAL_MS);
    }, SHOW_REFRESH_START_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [ready]);

  // Only while the library can be written, and only for a show still in it (a show removed since is skipped).
  const offer = ready ? (delistings.find((item) => media.some((row) => row.id === item.mediaId)) ?? null) : null;
  // File-less episodes are asked about first (LIB-SHOW-02), then each episode with a file (LIB-SHOW-04).
  const moveOffer = offer && offer.episodes.length === 0 ? (offer.moves[0] ?? null) : null;
  const moveKey = offer && moveOffer && moveOffer.move.kind !== "move" ? `${offer.mediaId}:${moveOffer.id}` : null;

  // Pick-by-hand needs the show's episode list and which episodes already have a file.
  useEffect(() => {
    if (!moveKey || !offer) return;
    let cancelled = false;
    const notListedIds = new Set(Object.keys(loadState()[offer.mediaId]?.notListed ?? {}));
    void fetchMediaDetails(offer.mediaId)
      .then((details) => {
        if (!cancelled) setMoveChoices({ key: moveKey, choices: details ? episodeMoveChoices(details, notListedIds) : [] });
      })
      .catch((err: unknown) => {
        log.warn({ error: err instanceof Error ? err.message : String(err) }, "episode move choices unavailable");
        if (!cancelled) setMoveChoices({ key: moveKey, choices: [] });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the episode asked about changes
  }, [moveKey]);

  if (!offer) return null;
  const show = media.find((row) => row.id === offer.mediaId);
  const saveDecision = (decision: "removed" | "moved" | "kept", ids: string[]) => {
    const next = resolveShowDelisting(loadState(), offer.mediaId, ids, decision);
    window.localStorage.setItem(SHOW_REFRESH_STATE_KEY, JSON.stringify(next));
    // eslint-disable-next-line no-console -- intentional [show-refresh] diagnostic (keep-diagnostic-logs)
    console.info("[show-refresh] delisting answered", { mediaId: offer.mediaId, decision, episodeIds: ids });
    log.info({ mediaId: offer.mediaId, decision, episodeIds: ids }, "show delisting answered");
    setDelistings(pendingShowDelistings(next));
  };

  if (moveOffer) {
    const mergedIds = moveOffer.move.kind === "merged" ? moveOffer.move.partIds : [];
    return (
      <ShowEpisodeMoveDialog
        key={`${offer.mediaId}:${moveOffer.id}`}
        showTitle={show?.title ?? ""}
        episode={moveOffer}
        otherParts={offer.moves.filter((part) => part.id !== moveOffer.id && mergedIds.includes(part.id))}
        choices={moveChoices?.key === moveKey ? moveChoices.choices : []}
        busy={removing}
        onKeep={() => saveDecision("kept", [moveOffer.id])}
        onMove={(targetEpisodeId) => {
          setRemoving(true);
          moveEpisodeToSlot(offer.mediaId, moveOffer.id, targetEpisodeId)
            .then((result) => {
              // eslint-disable-next-line no-console -- intentional [show-refresh] diagnostic (keep-diagnostic-logs)
              console.info("[show-refresh] episode move answered", { mediaId: offer.mediaId, episodeId: moveOffer.id, targetEpisodeId, result });
              if (result.moved) saveDecision("moved", [moveOffer.id]);
              else toast.error(t("library.showDelisting.moveFailed"));
            })
            .catch((err: unknown) => {
              // eslint-disable-next-line no-console -- intentional [show-refresh] diagnostic (keep-diagnostic-logs)
              console.error("[show-refresh] episode move failed", err);
              log.warn({ error: err instanceof Error ? err.message : String(err) }, "episode move failed");
              toast.error(t("library.showDelisting.moveFailed"));
            })
            .finally(() => setRemoving(false));
        }}
      />
    );
  }

  const removalIds = offer.episodes.map((episode) => episode.id);
  return (
    <ShowDelistingDialog
      showTitle={show?.title ?? ""}
      episodes={offer.episodes}
      busy={removing}
      onKeep={() => saveDecision("kept", removalIds)}
      onRemove={() => {
        setRemoving(true);
        removeEpisodesNotOnTmdb(offer.mediaId, removalIds)
          .then((result) => {
            // eslint-disable-next-line no-console -- intentional [show-refresh] diagnostic (keep-diagnostic-logs)
            console.info("[show-refresh] delisted episodes removed", { mediaId: offer.mediaId, ...result });
            saveDecision("removed", removalIds);
          })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console -- intentional [show-refresh] diagnostic (keep-diagnostic-logs)
            console.error("[show-refresh] delisted episode removal failed", err);
            log.warn({ error: err instanceof Error ? err.message : String(err) }, "delisted episode removal failed");
            toast.error(t("library.showDelisting.removeFailed"));
          })
          .finally(() => setRemoving(false));
      }}
    />
  );
}
