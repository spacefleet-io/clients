import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLibraryActions, useLibraryShell } from "@/lib/libraryContext";
import { useAsyncAction } from "@space/desktop-shell/hooks";
import { RenderBoundary } from "@space/ui";
import { useLoadingModal } from "@/components/LoadingModalProvider";
import { notifyError } from "@/lib/notify";
import { rendererLogger } from "@/logger";
import { pickAutoplayEpisodeId } from "@/lib/episodePlayback";
import type { MediaDetails } from "@/lib/libraryDb";
import { useStopPlaybackOnUnmount } from "@/lib/useStopPlaybackOnUnmount";

const playTraceLog = rendererLogger.child({ scope: "play-trace" });

const MediaPlaybackController = lazy(() => import("@/components/MediaPlaybackController"));

// Eagerly warm the playback chunk after the host page renders so the *first*
// Play click doesn't serialize lazy-load + parse + render before the launch UI
// appears. The cold-start E2E (playback.e2e cold-start case) guards the
// non-no-op contract this enables; see also the requestIdleCallback warm-up in
// useInlinePlayback().
const preloadPlaybackChunks = () => {
  void import("@/components/MediaPlaybackController").catch(() => undefined);
};

type PlaybackState = {
  media: MediaDetails;
  episodeId: string | null;
  requestId: number;
  autoResume: boolean;
  onLaunchFailed?: (error: string) => void;
};

/** PLAT-WEB-05: how the web player hand-off starts a playback in the hidden window. */
export type PlayMediaOptions = {
  /** Resume from the saved position without the resume / start-over prompt. */
  autoResume?: boolean;
  /** The playback did not start (item missing or without files, busy, dataset not loaded, launch failed). */
  onFailed?: (error: string) => void;
};

export type InlinePlayback = {
  /** Launch playback for a media id (picks the right TV episode via resume markers). */
  handlePlayMedia: (id: string, options?: PlayMediaOptions) => void;
  /** The media id currently launching (drives the per-tile overlay pinned state). */
  pendingPlayId: string | null;
  /** True while a launch is in flight (re-clicks are dropped). */
  playPending: boolean;
  /** True once the launch crosses the spinner-delay threshold. */
  playSpinnerVisible: boolean;
  /** Lazy <MediaPlaybackController> mount — render once per host page. */
  playbackMount: ReactNode;
};

/**
 * The play-button-facing slice of {@link InlinePlayback} — everything a poster
 * grid needs to render its hover Play overlays, minus the controller mount.
 * A page owns ONE {@link useInlinePlayback} instance and passes this slice down
 * to nested grids (e.g. Library → PlaylistsManager) so they share the single
 * mpv controller instead of each mounting their own.
 */
export type InlinePlaybackControls = Omit<InlinePlayback, "playbackMount">;

/**
 * Shared inline-playback plumbing for poster grids (Home, Media library,
 * Playlists). Extracted verbatim from Dashboard so a single implementation
 * backs the hover Play button everywhere; the per-page wiring only differs in
 * where {@link InlinePlayback.playbackMount} is rendered and which tiles get an
 * overlay. Pair with {@link import("@/components/PlayPosterOverlay")}.
 *
 * Behavioural contract (load-bearing — exercised by playback.e2e cold-start):
 * a Play click must never silently no-op; within the cold-start budget it
 * either opens the resume dialog or the global LoadingModal.
 */
export function useInlinePlayback(): InlinePlayback {
  const { t } = useTranslation();
  const { datasetStatus } = useLibraryShell();
  const { awaitDatasetReady, getMediaDetails, fetchMediaDetails, getSharedSetting } =
    useLibraryActions();
  const loadingModal = useLoadingModal();

  const [playbackState, setPlaybackState] = useState<PlaybackState | null>(null);
  const [pendingPlayId, setPendingPlayId] = useState<string | null>(null);
  const [playbackControllerReady, setPlaybackControllerReady] = useState(false);
  const controllerReadyResolversRef = useRef<Array<() => void>>([]);

  const awaitControllerReady = useCallback(() => {
    return new Promise<void>((resolve) => {
      controllerReadyResolversRef.current.push(resolve);
    });
  }, []);

  useEffect(() => {
    if (!playbackControllerReady) return;
    const resolvers = controllerReadyResolversRef.current;
    controllerReadyResolversRef.current = [];
    for (const r of resolvers) r();
  }, [playbackControllerReady]);

  useEffect(() => {
    const unsubscribe = window.sf?.onMpvExternalMessage?.((msg) => {
      if (msg.type !== "exit") return;
      setPlaybackState(null);
    });
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, []);

  useStopPlaybackOnUnmount(playbackState !== null);

  // Warm up the playback chunk after the host page mounts so the first Play
  // click doesn't serialize lazy-load + parse + render before the launch UI
  // appears. Use requestIdleCallback when available so it doesn't compete with
  // first paint or initial library hydration; fall back to a 0-ms timeout.
  useEffect(() => {
    type IdleHandle = number;
    const ric = window as Window & {
      requestIdleCallback?: (cb: () => void) => IdleHandle;
      cancelIdleCallback?: (handle: IdleHandle) => void;
    };
    let cancel: (() => void) | null = null;
    if (typeof ric.requestIdleCallback === "function") {
      const handle = ric.requestIdleCallback(preloadPlaybackChunks);
      cancel = () => ric.cancelIdleCallback?.(handle);
    } else {
      const handle = window.setTimeout(preloadPlaybackChunks, 0);
      cancel = () => window.clearTimeout(handle);
    }
    return () => cancel?.();
  }, []);

  const playAction = useAsyncAction(
    async (id: string, options: PlayMediaOptions = {}) => {
      playTraceLog.debug(
        {
          id,
          datasetStatus,
          datasetNotReady: !datasetStatus.playback || !datasetStatus.metadata,
        },
        "inlinePlayback.playAction:fn:start",
      );
      const datasetNotReady = !datasetStatus.playback || !datasetStatus.metadata;
      const modalToken = datasetNotReady
        ? loadingModal.showLoading({
            title: t("player.launching"),
            subtitle: t("player.preparingPlayback"),
          })
        : null;
      playTraceLog.debug(
        { id, datasetNotReady, modalToken },
        "inlinePlayback.playAction:fn:modal-decision",
      );
      try {
        const waitForDataset = async (which: "playback" | "metadata") => {
          playTraceLog.debug({ id, which }, "inlinePlayback.playAction:waitForDataset:start");
          const result = await Promise.race([
            awaitDatasetReady(which).then(() => "ready" as const),
            new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 30_000)),
          ]);
          playTraceLog.debug(
            { id, which, result },
            "inlinePlayback.playAction:waitForDataset:result",
          );
          if (result === "timeout") {
            throw new Error(
              `Library ${which} data did not load in 30s. Check your connection and try again.`,
            );
          }
        };
        if (!datasetStatus.playback) {
          await waitForDataset("playback");
        } else if (!datasetStatus.metadata) {
          await waitForDataset("metadata");
        }
        playTraceLog.debug({ id }, "inlinePlayback.playAction:fetchMediaDetails:start");
        const details = (await fetchMediaDetails(id)) ?? getMediaDetails(id);
        playTraceLog.debug(
          {
            id,
            hasDetails: !!details,
            hasFiles: details?.hasFiles,
            type: details?.type,
            fileCount: details?.files?.length,
          },
          "inlinePlayback.playAction:fetchMediaDetails:result",
        );
        if (!details?.hasFiles) {
          playTraceLog.warn({ id, found: Boolean(details) }, "inlinePlayback.playAction:abort (no files)");
          options.onFailed?.(details ? "media_has_no_files" : "media_not_found");
          return;
        }
        // One-click episode resolution (most-recent in-progress → first
        // unwatched → first with a file). Pure helper; resume-key shape stays
        // here. Returns null for movies. @see pickAutoplayEpisodeId
        const episodeId = pickAutoplayEpisodeId(
          details,
          (epId) => getSharedSetting(`episode_resume_v1:${epId}`)?.value,
        );
        setPlaybackControllerReady(false);
        setPlaybackState((prev) => {
          // Use Date.now() rather than prev+1 so the request ID is globally
          // monotonic across `playbackState` reset cycles (the on-mpv-exit
          // listener nulls playbackState, so the next click would otherwise
          // collide with requestId=1 from the previous click and trip the
          // module-level shouldHandlePlaybackRequest dedupe in
          // @space/desktop-mpv-playback. Dialog-side MediaDetailsDialog uses
          // the same Date.now() pattern for the same reason.)
          // @bugfix dialog-reopen-resume-prompt-dropped
          const next: PlaybackState = {
            media: details,
            episodeId,
            requestId: Date.now(),
            autoResume: options.autoResume === true,
            onLaunchFailed: options.onFailed,
          };
          playTraceLog.debug(
            {
              id: details.id,
              episodeId,
              prevRequestId: prev?.requestId ?? 0,
              nextRequestId: next.requestId,
            },
            "inlinePlayback.playAction:setPlaybackState",
          );
          return next;
        });
        // Keep playAction.pending true until the MediaPlaybackController has
        // committed its first launch UI (resume prompt OR playback-open). That
        // way the inline Button spinner will appear at the 400 ms threshold if
        // the controller takes longer than that to mount and render.
        await Promise.race([
          awaitControllerReady(),
          new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
        ]);
      } finally {
        if (modalToken) {
          playTraceLog.debug({ id, modalToken }, "inlinePlayback.playAction:fn:hideModal");
          loadingModal.hideLoading(modalToken);
        }
        playTraceLog.debug({ id }, "inlinePlayback.playAction:fn:end");
      }
    },
    {
      onError: (error, [id, options]) => {
        const message = error instanceof Error ? error.message : String(error);
        playTraceLog.warn({ id, error: message }, "inline-play failed");
        notifyError(message || "Playback failed to start");
        options?.onFailed?.(message || "playback_failed");
      },
    },
  );

  const handlePlayMedia = useCallback(
    (id: string, options?: PlayMediaOptions) => {
      playTraceLog.debug(
        {
          id,
          playActionPending: playAction.pending,
          playActionSpinnerVisible: playAction.spinnerVisible,
          pendingPlayId,
          datasetStatus,
        },
        "inlinePlayback.handlePlayMedia:click",
      );
      if (playAction.pending) {
        playTraceLog.debug({ id }, "inlinePlayback.handlePlayMedia:dropped (pending)");
        options?.onFailed?.("playback_busy");
        return;
      }
      setPendingPlayId(id);
      const startedAt = Date.now();
      void playAction
        .trigger(id, options)
        .then(
          (res) =>
            playTraceLog.debug(
              { id, res, elapsedMs: Date.now() - startedAt },
              "inlinePlayback.playAction:resolved",
            ),
          (err) =>
            playTraceLog.warn(
              { id, err: String(err), elapsedMs: Date.now() - startedAt },
              "inlinePlayback.playAction:rejected",
            ),
        )
        .finally(() => {
          playTraceLog.debug(
            { id, elapsedMs: Date.now() - startedAt },
            "inlinePlayback.playAction:settled (finally)",
          );
          setPendingPlayId((current) => (current === id ? null : current));
        });
    },
    [playAction, pendingPlayId, datasetStatus],
  );

  const playbackMount = playbackState ? (
    // UX-CRASH-01: a player crash shows a notice, not a dark window.
    <RenderBoundary name="player-overlay" variant="overlay">
    <Suspense fallback={null}>
      <MediaPlaybackController
        key={`${playbackState.media.id}:${playbackState.requestId}`}
        media={playbackState.media}
        episodeId={playbackState.episodeId}
        requestId={playbackState.requestId}
        onLaunchUiReady={() => setPlaybackControllerReady(true)}
        autoResume={playbackState.autoResume}
        onLaunchFailed={playbackState.onLaunchFailed}
      />
    </Suspense>
    </RenderBoundary>
  ) : null;

  return {
    handlePlayMedia,
    pendingPlayId,
    playPending: playAction.pending,
    playSpinnerVisible: playAction.spinnerVisible,
    playbackMount,
  };
}
