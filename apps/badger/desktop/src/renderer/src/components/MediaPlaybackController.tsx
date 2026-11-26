import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@space/ui";
import { notifyError } from "@/lib/notify";
import { getUnpaidAccessInfo, unpaidMessage } from "@/lib/unpaidAccess";
import { formatAccessDate } from "@space/shared/effectiveAccess";
import {
  getPlaybackLaunchMedia,
  getPlaybackLaunchPlan,
  shouldClearPlaybackLaunchUi,
  shouldHandlePlaybackRequest,
} from "@space/desktop-mpv-playback";
import { resolveResumeCandidateSeconds } from "@space/shared/playbackResume";
import {
  asksWhichEdition,
  detailsForEdition,
  formatEditionLength,
  listEditions,
  orderEditionsForChooser,
  readEditionResume,
  type EditionResume,
  type EditionSlot,
  type MediaEdition,
} from "@space/shared/mediaEditions";
import type { MediaDetails } from "@/lib/libraryDb";
import { usePlaybackEngine } from "@/lib/usePlaybackEngine";
import { useHiddenDeferredSetProgress } from "@/lib/hiddenProgressBuffer";
import { getEpisodePlaybackLabel } from "@/lib/episodePlayback";
import { getNextPlayableEpisode, getPreviousPlayableEpisode } from "@space/shared/playableEpisodes";
import { useAuth } from "@/auth";
import { getMetadataSkipMarkers } from "@/api";
import { useClientConfig } from "@/lib/useClientConfig";
import { useLibraryActions, useLibraryShell } from "@/lib/libraryContext";
import { useLoadingModal } from "@/components/LoadingModalProvider";
import { useAsyncAction } from "@space/desktop-shell/hooks";
import { useAppPlaybackMark } from "@space/ui/app-playback-mark";
import { rendererLogger } from "@/logger";
import { LaunchingLoader } from "@/components/LaunchingLoader";
import { parseTrackPrefs, trackPrefsKey } from "@space/shared/trackPrefs";
import { resolvePlaybackStartTracks } from "@/lib/mpvPlaybackSelection";
import { useBadgerOsMediaSession } from "@/lib/osMediaSession";
import { useLocalArtwork } from "@space/media-session/react";
import { getDecryptedAssetUrl, isAssetKey } from "@/lib/assets";
import { getStoredLibraryKey } from "@/lib/onboarding";
import { desktopStreamSlotGate, setDesktopStreamSlotCloseHandler, setDesktopStreamSlotToken } from "@/lib/streamSlot";
import { useStreamSlotState } from "@space/ui/stream-slot-prompt";

const playTraceLog = rendererLogger.child({ scope: "play-trace" });
import {
  createExternalSkipMarkerFetchPayload,
  EXTERNAL_SKIP_MARKER_FETCH_KIND,
  isExternalSkipMarkerFetchPayload,
  isServiceSkipMarkerSource,
} from "../../../shared/skipMarkerCache";

type MediaPlaybackControllerProps = {
  media: MediaDetails;
  episodeId?: string | null;
  requestId: number;
  onLaunchUiReady?: () => void;
  /**
   * PLAT-WEB-05 (web player hand-off, hidden window): resume from the saved position like a normal Play, without
   * the resume / start-over prompt nobody would see.
   */
  autoResume?: boolean;
  /** PLAT-WEB-05: the launch gave up (stream error, launch timeout). */
  onLaunchFailed?: (error: string) => void;
};

/** The edition being played (PLAY-OPEN-02), on a film or episode with two or more; null otherwise. */
type ActiveEdition = { editionId: string; episodeId: string | null; slot: EditionSlot };

/** "Which edition?" waiting for an answer: the title as loaded, its editions in chooser order, their resume spots. */
type EditionChooser = {
  details: MediaDetails;
  episodeId: string | null;
  slot: EditionSlot;
  editions: MediaEdition[];
  resume: Record<string, EditionResume>;
};

/** The film (null) or the episode's season and number, as `listEditions` takes it. */
const editionSlotOf = (details: MediaDetails, episodeId: string | null): EditionSlot => {
  if (!episodeId) return null;
  const episode = details.episodes.find((item) => item.id === episodeId);
  return episode ? { season: episode.seasonNumber, episode: episode.episodeNumber } : null;
};

/** The title as the player sees it once the edition is chosen: the other editions of the same unit are gone. */
const scopeToEdition = (details: MediaDetails, active: ActiveEdition | null): MediaDetails =>
  active ? detailsForEdition(details, listEditions(details, active.slot), active.editionId) : details;

const formatTime = (value: number) => {
  if (!Number.isFinite(value)) return "--:--:--";
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
};

export default function MediaPlaybackController({
  media,
  episodeId,
  requestId,
  onLaunchUiReady,
  autoResume = false,
  onLaunchFailed,
}: MediaPlaybackControllerProps) {
  // Read from effects that must not re-run when the parent passes a new callback.
  const onLaunchFailedRef = useRef(onLaunchFailed);
  useEffect(() => {
    onLaunchFailedRef.current = onLaunchFailed;
  });
  const { t, i18n } = useTranslation();
  const { token, user } = useAuth();
  const { datasetStatus } = useLibraryShell();
  const {
    getMediaDetails,
    fetchMediaDetails,
    getSharedSetting,
    getActiveProfileSettings,
    setMediaFormatChunks,
    setProgress,
    setTrackPrefs,
    addSubtitleTrack,
    removeSubtitleTrackNow,
    getMediaObjectKeys,
    mergeSkipMarkers,
    replaceSkipMarkers,
    upsertSkipAnalysis,
    listSkipAnalysis,
    awaitDatasetReady,
  } = useLibraryActions();
  // Issue #25 P19-residual: the engine's progress saves made while the window
  // is hidden persist without re-rendering library consumers; applied on show.
  const deferredSetProgress = useHiddenDeferredSetProgress(setProgress);
  // PLAY-OPEN-02 / PLAY-RESUME-05: the edition chosen at "Which edition?" (null for a title with one edition), and the
  // question while it waits for an answer.
  const [activeEdition, setActiveEdition] = useState<ActiveEdition | null>(null);
  const activeEditionRef = useRef<ActiveEdition | null>(null);
  activeEditionRef.current = activeEdition;
  const [editionChooser, setEditionChooser] = useState<EditionChooser | null>(null);
  // PLAY-RESUME-05: a save for the chosen edition's film or episode also keeps that edition's own resume spot.
  const engineSetProgress = useCallback<typeof deferredSetProgress>(
    (mediaId, pct, savedEpisodeId, timing) => {
      const edition = activeEditionRef.current;
      const forEdition = edition !== null && (savedEpisodeId ?? null) === edition.episodeId;
      return deferredSetProgress(mediaId, pct, savedEpisodeId, forEdition ? { ...timing, editionId: edition.editionId } : timing);
    },
    [deferredSetProgress]
  );
  const { showLoading, updateLoading, hideLoading } = useLoadingModal();
  const [currentMedia, setCurrentMedia] = useState(media);
  const [activeEpisodeId, setActiveEpisodeId] = useState<string | null>(episodeId ?? null);
  const clientConfig = useClientConfig();
  const [playbackOpen, setPlaybackOpen] = useState(false);
  const [resumePromptOpen, setResumePromptOpen] = useState(false);
  const [resumeCandidateTime, setResumeCandidateTime] = useState<number | null>(null);
  const [deferForPrompt, setDeferForPrompt] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchProgress, setLaunchProgress] = useState(0);
  const [launchStatusHint, setLaunchStatusHint] = useState<string | null>(null);
  // A launch that starts while the engine still reports the PREVIOUS launch as
  // ready (next episode over a playing one) must not be revealed off that stale
  // value. The engine only drops isReadyToReveal in the passive effects of the
  // commit that applies the new episode/media (init effect → start_load), so
  // the reveal effect running in that same commit still sees the old `true`.
  // A launch arms this ref; the reveal effect then defers its first decision by
  // one render (tick), which reads the engine's post-launch snapshot. This used
  // to be guaranteed by a separate flushSync(setCurrentMedia/setActiveEpisodeId)
  // commit ahead of setIsLaunching(true): an extra synchronous controller +
  // engine render inside the click / IPC handler (issue #25 P15).
  // @bugfix next-episode-launch-revealed-by-previous-episode-readiness
  // @regression-proof
  const revealRecheckPendingRef = useRef(false);
  const [revealRecheckTick, setRevealRecheckTick] = useState(0);
  const lastRequestIdRef = useRef(0);
  const loadingTokenRef = useRef<string | null>(null);
  const attemptedSkipMarkerFetchesRef = useRef<Set<string>>(new Set());
  const hadLaunchUiRef = useRef(false);
  const launchCompletionResolversRef = useRef<Array<() => void>>([]);
  const wasLaunchingRef = useRef(false);
  // Read fresh getSharedSetting AFTER awaitDatasetReady("playback") resolves —
  // a closure captured at render time still holds the pre-hydration empty value
  // and would resume from position 0. See run() below for the read site.
  // @bugfix evening-cold-start-resume-race
  const getSharedSettingRef = useRef(getSharedSetting);
  useEffect(() => {
    getSharedSettingRef.current = getSharedSetting;
  });

  // Diagnostic: log mount/unmount so we can spot a mount storm if it
  // reappears. Logged once per lifetime of this instance — if you see
  // multiple "MediaPlaybackController: mount" in quick succession for
  // one Play click, the modal's controller-instantiation block is
  // remounting (the bug fixed above by dropping the requestId-keyed key).
  useEffect(() => {
    playTraceLog.info({ mediaId: media.id }, "MediaPlaybackController: mount");
    return () => {
      playTraceLog.info({ mediaId: media.id }, "MediaPlaybackController: unmount");
    };
  }, [media.id]);

  const setLaunchProgressValue = useCallback((value: number) => {
    setLaunchProgress(Math.max(0, Math.min(100, Math.round(value))));
  }, []);

  const clearLaunchUi = useCallback(() => {
    setResumePromptOpen(false);
    setResumeCandidateTime(null);
    setDeferForPrompt(false);
    setIsLaunching(false);
    setLaunchStatusHint(null);
    setLaunchProgressValue(0);
    if (loadingTokenRef.current) {
      hideLoading(loadingTokenRef.current);
      loadingTokenRef.current = null;
    }
  }, [hideLoading, setLaunchProgressValue]);

  // Path B: don't surface a percentage on the global loading modal — we have
  // no real buffer-fill signal from mpv. Only show launchStatusHint when set
  // (e.g. "Switching to 360p HEVC" during a real network-slow fallback).
  const syncLoadingProgress = useCallback(
    (_value: number) => {
      const token = loadingTokenRef.current;
      if (!token) return;
      updateLoading(token, {
        title: t("player.launching"),
        subtitle: launchStatusHint ?? t("player.preparingPlayback"),
      });
    },
    [launchStatusHint, t, updateLoading]
  );

  useEffect(() => {
    // A library refresh while the chosen edition plays keeps the other editions out (PLAY-OPEN-03).
    setCurrentMedia(scopeToEdition(media, activeEditionRef.current));
  }, [media]);

  useEffect(() => {
    setActiveEpisodeId(episodeId ?? null);
  }, [episodeId]);

  const resumeEpisodeLabel = useMemo(() => {
    if (!activeEpisodeId || currentMedia.type !== "tv") return null;
    const episode = currentMedia.episodes.find((item) => item.id === activeEpisodeId);
    return getEpisodePlaybackLabel(episode);
  }, [activeEpisodeId, currentMedia.episodes, currentMedia.type]);

  const nextPlayableEpisode = useMemo(
    () => getNextPlayableEpisode(currentMedia, activeEpisodeId),
    [activeEpisodeId, currentMedia]
  );

  // Ref-shadow `nextPlayableEpisode` so handleExternalMpvOscAction can read
  // the LATEST value at action-firing time instead of whatever was captured
  // in the callback closure when it was last re-memoized. The auto-skip pill
  // fires 5+ seconds after activation; a state change in between (lazy
  // skip-marker fetch, media refresh, etc.) would otherwise leave the
  // handler pointing at a stale episode. Symptom this fixes: clicking play
  // on S1E2 leading to S1E5 actually loading after auto-skip.
  const nextPlayableEpisodeRef = useRef(nextPlayableEpisode);
  useEffect(() => {
    nextPlayableEpisodeRef.current = nextPlayableEpisode;
  }, [nextPlayableEpisode]);

  // Target of the mpv overlay's centre previous-episode button (PLAY-OVL-03);
  // ref-shadowed like nextPlayableEpisode for the same stale-closure reason.
  const previousPlayableEpisode = useMemo(
    () => getPreviousPlayableEpisode(currentMedia, activeEpisodeId),
    [activeEpisodeId, currentMedia]
  );
  const previousPlayableEpisodeRef = useRef(previousPlayableEpisode);
  useEffect(() => {
    previousPlayableEpisodeRef.current = previousPlayableEpisode;
  }, [previousPlayableEpisode]);

  const currentEpisode = useMemo(
    () => (activeEpisodeId ? currentMedia.episodes.find((item) => item.id === activeEpisodeId) ?? null : null),
    [activeEpisodeId, currentMedia.episodes]
  );

  const getStoredDuration = useCallback((details: MediaDetails) => {
    const durations = details.formats
      .map((format) => format.durationSeconds)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    return durations.length > 0 ? Math.max(...durations) : null;
  }, []);

  const getResumeCandidate = useCallback(
    (details: MediaDetails, progressOverride: number | null, episodeIdForResume: string | null) => {
      const duration = getStoredDuration(details);
      // For an episode, its episode_resume_v1 progress (the override) is the only
      // source — never fall back to the show-level progressPct. For a movie, fall
      // back to the movie's own progressPct. Take the episode id as an ARGUMENT
      // rather than the closure `activeEpisodeId`, which on a cold-start play is
      // still the pre-sync null (it lags the episodeId prop by a render).
      // @bugfix evening-cold-start-resume-race (episode-id half)
      const sourceProgress = episodeIdForResume ? progressOverride : progressOverride ?? details.progressPct;
      // Single source of truth for the resume floor (percent-aware). Returns
      // null for near-zero / trivial progress so getPlaybackLaunchPlan launches
      // from the start rather than prompting "resume from 00:00:00".
      return resolveResumeCandidateSeconds(sourceProgress, duration);
    },
    [getStoredDuration]
  );

  // The launch once the resume spot is known: the resume prompt (PLAY-RESUME-01), or a direct start. Kept in a ref,
  // refreshed every render, so the run effect and the "Which edition?" answer both reach the current render's values.
  const launchRef = useRef<(requestKey: string, nextResume: number | null) => void>(() => {});
  launchRef.current = (requestKey, nextResume) => {
    // PLAT-WEB-05: a hand-off resumes at the candidate straight away (what the Resume button does), no prompt.
    const launchPlan = getPlaybackLaunchPlan(autoResume ? null : nextResume);
    const startAt = autoResume ? (nextResume ?? 0) : 0;
    playTraceLog.debug({ requestKey, nextResume, launchPlan, autoResume, startAt }, "Controller.run:launchPlan");
    if (launchPlan.showResumePrompt) {
      playTraceLog.debug({ requestKey }, "Controller.run:showResumePrompt");
      setPlaybackOpen(true);
      setDeferForPrompt(launchPlan.deferForPrompt);
      setResumeCandidateTime(nextResume);
      setResumePromptOpen(true);
      setIsLaunching(false);
      if (loadingTokenRef.current) {
        hideLoading(loadingTokenRef.current);
        loadingTokenRef.current = null;
      }
      onLaunchUiReady?.();
      return;
    }
    playTraceLog.debug({ requestKey }, "Controller.run:directLaunch");
    onLaunchUiReady?.();
    setPlaybackOpen(launchPlan.openPlayback);
    setLaunchProgressValue(60);
    syncLoadingProgress(60);
    if (!loadingTokenRef.current) {
      loadingTokenRef.current = showLoading({ title: t("player.launching"), subtitle: t("player.preparingPlayback") });
    }
    setLaunchProgressValue(70);
    syncLoadingProgress(70);
    setResumeCandidateTime(null);
    setResumePromptOpen(false);
    setDeferForPrompt(launchPlan.deferForPrompt);
    // Zero the engine's resume refs (seekTargetRef / lastKnownTimeRef) before
    // the init effect picks them up. The poll loop writes lastKnownTimeRef on
    // every tick during playback and nothing clears it on mpv exit, so a
    // fresh Play on media with no resume-worthy progress would otherwise
    // inherit the prior in-session playback's last position and launch mpv
    // with `--start=<stale>`. Mirrors the next-episode reset above.
    // @bugfix cross-session-resume-refs-leak
    // An auto-resume (hand-off) sets them to the resume position instead: the init effect launches mpv there.
    playback.prepareEpisodeStart?.(startAt, true);
    setIsLaunching(true);
  };

  // PLAY-OPEN-02 answer: play that edition only (PLAY-OPEN-03, PLAY-OPEN-05) from its own spot (PLAY-RESUME-05);
  // the title's or episode's single spot is never used for a title with several editions.
  const launchEditionRef = useRef<
    (
      requestKey: string,
      details: MediaDetails,
      editionEpisodeId: string | null,
      slot: EditionSlot,
      editionId: string,
      resume: Record<string, EditionResume>
    ) => void
  >(() => {});
  launchEditionRef.current = (requestKey, details, editionEpisodeId, slot, editionId, resume) => {
    const chosen: ActiveEdition = { editionId, episodeId: editionEpisodeId, slot };
    activeEditionRef.current = chosen;
    setActiveEdition(chosen);
    setEditionChooser(null);
    setCurrentMedia(scopeToEdition(details, chosen));
    playTraceLog.debug({ requestKey, editionId, resume: resume[editionId] ?? null }, "Controller.run:editionChosen");
    launchRef.current(requestKey, resume[editionId]?.positionSeconds ?? null);
  };

  useEffect(() => {
    playTraceLog.debug({
      mediaId: media.id,
      episodeId,
      requestId,
      lastRequestId: lastRequestIdRef.current,
      datasetPlayback: datasetStatus.playback,
    }, "Controller.requestIdEffect:fire");
    if (!requestId || requestId === lastRequestIdRef.current) {
      playTraceLog.debug({ requestId, last: lastRequestIdRef.current }, "Controller.requestIdEffect:skip (same/zero)");
      return;
    }
    const requestKey = `${media.id}:${episodeId ?? "movie"}:${requestId}`;
    if (!shouldHandlePlaybackRequest(requestKey)) {
      playTraceLog.warn({ requestKey }, "Controller.requestIdEffect:dedupe-drop");
      return;
    }
    lastRequestIdRef.current = requestId;
    // Every Play plays the episode it was asked for. The controller stays mounted across plays and the episode
    // effect above only follows a CHANGED prop, so after the player moved on to the next episode (PLAY-NEXT-01)
    // and was closed, a second Play on the same episode would otherwise reopen the episode the player left on.
    setActiveEpisodeId(episodeId ?? null);
    let active = true;
    const run = async () => {
      playTraceLog.debug({ requestKey }, "Controller.run:start");
      setDeferForPrompt(false);
      setLaunchStatusHint(null);
      if (!datasetStatus.playback) {
        playTraceLog.debug({ requestKey }, "Controller.run:awaitDatasetReady:playback:start");
        loadingTokenRef.current = showLoading({ title: t("player.launching"), subtitle: t("player.preparingPlayback") });
        setLaunchProgressValue(10);
        let timedOut = false;
        await Promise.race([
          awaitDatasetReady("playback"),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              timedOut = true;
              resolve();
            }, 5000)
          ),
        ]);
        if (timedOut) {
          playTraceLog.warn({ requestKey }, "playback-await-timeout");
        }
        playTraceLog.debug({ requestKey }, "Controller.run:awaitDatasetReady:playback:done");
        if (!active) return;
      }
      setLaunchProgressValue(40);
      syncLoadingProgress(40);
      const refreshed = getMediaDetails(media.id);
      const nextMedia = getPlaybackLaunchMedia(media, refreshed);
      // PLAY-OPEN-02: a film or episode with two or more editions asks "Which edition?" at every Play, editions in
      // progress first with their spot (PLAY-RESUME-05). Read after awaitDatasetReady, like the resume spot below.
      const editionEpisodeId = episodeId ?? null;
      const editionSlot = editionSlotOf(nextMedia, editionEpisodeId);
      const editions = listEditions(nextMedia, editionSlot);
      if (asksWhichEdition(editions)) {
        const editionResume = readEditionResume(editions, (key) => getSharedSettingRef.current(key)?.value);
        const ordered = orderEditionsForChooser(editions, editionResume);
        playTraceLog.debug({ requestKey, editions: ordered.map((e) => e.id), editionResume }, "Controller.run:whichEdition");
        setActiveEdition(null);
        setCurrentMedia(nextMedia);
        setEditionChooser({ details: nextMedia, episodeId: editionEpisodeId, slot: editionSlot, editions: ordered, resume: editionResume });
        setIsLaunching(false);
        if (loadingTokenRef.current) {
          hideLoading(loadingTokenRef.current);
          loadingTokenRef.current = null;
        }
        onLaunchUiReady?.();
        return;
      }
      setActiveEdition(null);
      activeEditionRef.current = null;
      setCurrentMedia(nextMedia);
      // Read resume progress AFTER awaitDatasetReady — a closure captured at
      // render time still holds the empty pre-hydration getSharedSetting.
      // @bugfix evening-cold-start-resume-race
      //
      // Resolve the episode via the `episodeId` PROP, NOT the `activeEpisodeId`
      // state: on a cold-start play episodeId+requestId arrive in the same render
      // and the run effect re-runs capturing the fresh prop, while the state
      // (synced through a separate effect) still lags at the pre-sync null. The
      // prop is also the run effect's identity (the requestKey above uses it).
      // @bugfix evening-cold-start-resume-race (episode-id half)
      const resumeEpisodeId = episodeId ?? null;
      let resolvedPct: number | null = null;
      if (resumeEpisodeId) {
        const raw = getSharedSettingRef.current(`episode_resume_v1:${resumeEpisodeId}`)?.value;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { progressPct?: number };
            const value = Number(parsed.progressPct);
            if (Number.isFinite(value) && value > 0 && value < 100) {
              resolvedPct = value;
            }
          } catch {
            resolvedPct = null;
          }
        }
      }
      const nextResume = getResumeCandidate(nextMedia, resolvedPct, resumeEpisodeId);
      launchRef.current(requestKey, nextResume);
    };
    void run();
    return () => {
      active = false;
      if (loadingTokenRef.current) {
        hideLoading(loadingTokenRef.current);
        loadingTokenRef.current = null;
      }
    };
  }, [
    autoResume,
    awaitDatasetReady,
    datasetStatus.playback,
    getMediaDetails,
    getResumeCandidate,
    hideLoading,
    media,
    requestId,
    showLoading,
    t,
  ]);

  useEffect(() => {
    const shouldClear = shouldClearPlaybackLaunchUi(
      hadLaunchUiRef.current,
      playbackOpen,
      resumePromptOpen,
      deferForPrompt
    );
    hadLaunchUiRef.current = playbackOpen || resumePromptOpen || deferForPrompt || isLaunching;
    if (!shouldClear) return;
    clearLaunchUi();
  }, [clearLaunchUi, deferForPrompt, isLaunching, playbackOpen, resumePromptOpen]);

  useEffect(() => {
    if (!playbackOpen) return;
    const unsubscribe = window.sf?.onMpvExternalMessage?.((msg) => {
      if (msg.type !== "exit") return;
      clearLaunchUi();
      // Closing playback tears the engine's mpv down: name the cause (#25 c038).
      playTraceLog.info({ closeCause: "mpv-exit" }, "MediaPlaybackController: closing playback");
      setPlaybackOpen(false);
    });
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [clearLaunchUi, playbackOpen]);

  // ACCT-STREAM-01..04: the stream gate requests with this session's token, and closes this player when the user
  // cancels at "Play here instead?" or another device takes the place over (lib/streamSlot.ts).
  useEffect(() => setDesktopStreamSlotToken(token ?? null), [token]);
  useEffect(() => {
    if (!playbackOpen && !isLaunching) return;
    return setDesktopStreamSlotCloseHandler(() => {
      clearLaunchUi();
      playTraceLog.info({ closeCause: "stream-slot" }, "MediaPlaybackController: closing playback");
      setPlaybackOpen(false);
    });
  }, [clearLaunchUi, isLaunching, playbackOpen]);
  // While "Play here instead?" waits for the user, the launch is not slow: its timeouts start after the answer.
  const streamSlotAsking = useStreamSlotState(desktopStreamSlotGate).kind === "asking";

  // No background shooting star while a video launches or plays (UX-SKY-01).
  useAppPlaybackMark(playbackOpen || isLaunching);

  // Path B: cap cosmetic ramp at 70%. We don't have a real buffer-fill signal
  // from mpv routed to the renderer (no `cache-buffering-state` wiring in
  // `useMpvPlaybackEngine`), so the bar pauses at 70% during the actual buffer
  // fill and the success effect (line ~590) jumps it to 100 when playback
  // truly starts. Honest pause-then-jump > lying gradient to 92%.
  useEffect(() => {
    if (!isLaunching) return;
    const timer = window.setInterval(() => {
      setLaunchProgress((prev) => {
        if (prev >= 70) return prev;
        return Math.min(70, prev + 6);
      });
    }, 300);
    return () => window.clearInterval(timer);
  }, [isLaunching]);

  useEffect(() => {
    if (!isLaunching) return;
    syncLoadingProgress(launchProgress);
  }, [isLaunching, launchProgress, syncLoadingProgress]);

  const blockPlayback = deferForPrompt;
  const trackPrefsRaw = getSharedSetting?.(trackPrefsKey(currentMedia.id))?.value;
  const engineTrackPrefs = useMemo(() => parseTrackPrefs(trackPrefsRaw), [trackPrefsRaw]);
  const playback = usePlaybackEngine({
    open: playbackOpen,
    media: currentMedia,
    // MPV-PREV-04: the library refreshes this media while it plays; the engine reads its preview record from here.
    libraryFormats: getMediaDetails(currentMedia.id)?.formats ?? null,
    episodeId: activeEpisodeId,
    previousEpisode: previousPlayableEpisode
      ? { id: previousPlayableEpisode.id, label: getEpisodePlaybackLabel(previousPlayableEpisode) ?? previousPlayableEpisode.id }
      : null,
    nextEpisode: nextPlayableEpisode ? { id: nextPlayableEpisode.id, label: getEpisodePlaybackLabel(nextPlayableEpisode) ?? nextPlayableEpisode.id } : null,
    token,
    blockAutoPlay: blockPlayback,
    deferPlayback: blockPlayback,
    playbackQuality: clientConfig.playbackQuality,
    forcePlaybackQuality: clientConfig.forcePlaybackQuality,
    autoplayNextEpisode: clientConfig.autoplayNextEpisode,
    autoSkipIntro: clientConfig.introSkipEnabled,
    autoSkipCredits: clientConfig.creditsSkipEnabled,
    setMediaFormatChunks,
    setProgress: engineSetProgress,
    trackPrefs: engineTrackPrefs,
    setTrackPrefs,
    addSubtitleTrack,
    removeSubtitleTrack: removeSubtitleTrackNow,
    getMediaObjectKeys,
    skipEditLibrary: {
      listSkipAnalysis,
      upsertSkipAnalysis,
      replaceSkipMarkers,
      onChanged: async () => {
        const refreshed = await fetchMediaDetails(currentMedia.id);
        if (refreshed) setCurrentMedia(scopeToEdition(refreshed, activeEditionRef.current));
      },
    },
    t,
  });

  // Snap the engine's audio/subtitle selection to the CURRENT default on
  // every new playback request. This honors any default-track change the
  // user made between Play clicks (the case 5181c00f originally fixed via
  // a keyed remount, then 3d94a69a moved to an in-place reset-to-null).
  //
  // Pre-fix the reset cleared selectedAudioId to null, which triggered the
  // engine's audio resolver effect to re-pick the new default and call
  // setSelectedAudioId(newId) — TWO consecutive state writes mutating
  // audioMapSignature, which is in the engine's init-effect dep array.
  // React then re-fired the init effect a second time during the launch.
  // The launchInProgress latch in useMpvPlaybackEngine catches CONCURRENT
  // entry but a sequential init re-fire after the first loadStream's
  // launch completes is NOT blocked — the second call enters the loadfile
  // branch (mpv is alive) and triggers a needless re-load. Manifested as
  // playback restarting the first 3 s segment 4-5 times before stabilizing.
  //
  // Setting the selection to the new default DIRECTLY collapses the
  // cascade to ONE state write — audioMapSignature changes once, the
  // resolver no-ops (selection already matches), the init effect fires
  // exactly once, mpv launches exactly once.
  //
  // Read currentMedia via ref so the effect's identity is keyed purely on
  // requestId (the only signal we want to react to).
  //
  // @bugfix dialog-default-track-change-ignored
  // @bugfix mpv-launch-loop-from-controller-mount-storm
  // @bugfix mpv-launch-init-effect-sequential-refire
  // @regression-proof
  const resetAudio = playback.setSelectedAudioId;
  const resetSub = playback.resetSelectedSubtitleId;
  const currentMediaRef = useRef(currentMedia);
  currentMediaRef.current = currentMedia;
  const markSubtitlesOff = playback.setSelectedSubtitleId;
  // The profile's "Default audio language" (PLAY-TRACK-01) and "Subtitle language" (ACCT-SQUAD-03), read at play
  // start only: a Settings change applies to the next playback.
  const defaultAudioLanguageRef = useRef(clientConfig.defaultAudioLanguage);
  defaultAudioLanguageRef.current = clientConfig.defaultAudioLanguage;
  const defaultSubtitleLanguageRef = useRef(clientConfig.defaultSubtitleLanguage);
  defaultSubtitleLanguageRef.current = clientConfig.defaultSubtitleLanguage;
  // PLAY-TRACK-11: when the profile's subtitle language was last changed, so a newer change beats the title's choice.
  const getActiveProfileSettingsRef = useRef(getActiveProfileSettings);
  getActiveProfileSettingsRef.current = getActiveProfileSettings;
  useEffect(() => {
    if (!requestId) return;
    const m = currentMediaRef.current;
    const ep = activeEpisodeId;
    // PLAY-TRACK-04: the synced per-movie / per-show choice wins over the
    // default audio / subtitle language, which wins over the library
    // default; no remembered choice (or no matching track) falls back.
    // Read via the ref so a hydrating dataset is not stale.
    const prefs = parseTrackPrefs(getSharedSettingRef.current?.(trackPrefsKey(m.id))?.value);
    const defaultAudioLanguage = defaultAudioLanguageRef.current;
    const defaultSubtitleLanguage = defaultSubtitleLanguageRef.current;
    const subtitleSetAt = getActiveProfileSettingsRef.current?.()?.fieldUpdatedAt?.subtitleLanguage ?? null;
    const { audioDefault, audioSource, subDefault, subtitlesOffRemembered } = resolvePlaybackStartTracks({
      audioTracks: m.audioTracks,
      subtitleTracks: m.subtitleTracks,
      episodeId: ep,
      prefs,
      defaults: {
        audioLanguage: defaultAudioLanguage,
        subtitle: defaultSubtitleLanguage ? { language: defaultSubtitleLanguage } : null,
        subtitleSetAt,
      },
    });
    // eslint-disable-next-line no-console -- intentional track-prefs diagnostic (keep-diagnostic-logs)
    console.info("[track-prefs] play-start selection", { mediaId: m.id, episodeId: ep, prefs, defaultAudioLanguage, defaultSubtitleLanguage, subtitleSetAt, audioDefault, audioSource, subDefault, subtitlesOffRemembered });
    resetAudio(audioDefault);
    resetSub(subDefault);
    if (subtitlesOffRemembered) markSubtitlesOff("off");
    // activeEdition: the answer to "Which edition?" narrows the tracks to that edition's; pick again from them.
  }, [requestId, activeEpisodeId, activeEdition, resetAudio, resetSub, markSubtitlesOff]);

  const handleExternalMpvOscAction = useCallback(
    (payload: { type: string; [key: string]: unknown }) => {
      // Read the LATEST neighbours from the refs so a state change between
      // pill activation and the 5s-later auto-fire doesn't leave us pointing
      // at a stale episode. The refs always reflect the most recent render's
      // values; the captured closure value can be N renders old.
      const nextEpisode = nextPlayableEpisodeRef.current;
      const previousEpisode = previousPlayableEpisodeRef.current;
      // eslint-disable-next-line no-console -- intentional [osc-action] diagnostic (keep-diagnostic-logs)
      console.info("[osc-action] received", {
        payload,
        currentMediaId: currentMedia?.id,
        currentMediaType: currentMedia?.type,
        currentEpisodeId: currentEpisode?.id,
        currentEpisodeNumber: currentEpisode ? `s${currentEpisode.seasonNumber}e${currentEpisode.episodeNumber}` : null,
        previousEpisodeId: previousEpisode?.id ?? null,
        nextEpisodeId: nextEpisode?.id ?? null,
        nextEpisodeNumber: nextEpisode ? `s${nextEpisode.seasonNumber}e${nextEpisode.episodeNumber}` : null,
        playbackOpen,
      });
      if (payload?.type !== "next_episode" && payload?.type !== "previous_episode") {
        // eslint-disable-next-line no-console -- intentional [osc-action] diagnostic
        console.warn("[osc-action] ignoring unknown type", payload?.type);
        return;
      }
      const direction = payload.type === "previous_episode" ? "previous" : "next";
      const targetEpisode = direction === "previous" ? previousEpisode : nextEpisode;
      if (!targetEpisode) {
        // eslint-disable-next-line no-console -- intentional [osc-action] diagnostic
        console.warn(`[osc-action] no ${direction} playable episode — navigation skipped`, {
          currentEpisodeId: currentEpisode?.id,
          episodesCount: currentMedia?.episodes?.length,
        });
        return;
      }
      const leftAt = typeof payload.timePos === "number" && Number.isFinite(payload.timePos) ? payload.timePos : undefined;
      // eslint-disable-next-line no-console -- intentional [osc-action] diagnostic
      console.info(`[osc-action] navigating to ${direction} episode`, {
        from: currentEpisode?.id,
        to: targetEpisode.id,
        leftAt,
      });
      // @bugfix @regression-proof #2473 #2487 #2488: save the place in the
      // episode left (PLAY-OVL-03) BEFORE the swap, at mpv's time-pos when the
      // button was pressed. The 500 ms polled save could stop just short of it:
      // left at 630.04 s with credits at 630 s, the last save read 629.75 s, so
      // the episode was not watched (PLAY-RESUME-02) and Play reopened it.
      // flushProgress reads this render's target (the episode left) and the
      // reset below gates every later sample of the old file.
      playback.flushProgress?.(leftAt)?.catch((error: unknown) => {
        // eslint-disable-next-line no-console -- intentional [osc-action] diagnostic
        console.warn("[osc-action] saving the episode left failed", error);
      });
      playback.prepareEpisodeStart?.(0, true);
      const latestMedia = getPlaybackLaunchMedia(currentMedia, getMediaDetails(currentMedia.id));
      // An mpv IPC message, not a click: the episode swap stays synchronous so
      // it lands before mpv's next message is handled (a non-React callback
      // would otherwise commit on a later scheduler task). It used to be TWO
      // commits (flushSync for media + episode, then the launch flags); now it
      // is ONE. The launch flags committing alongside the swap is what the
      // reveal guard (revealRecheckPendingRef) makes safe.
      revealRecheckPendingRef.current = true;
      flushSync(() => {
        setCurrentMedia(latestMedia);
        setActiveEpisodeId(targetEpisode.id);
        setResumePromptOpen(false);
        setResumeCandidateTime(null);
        setDeferForPrompt(false);
        setLaunchStatusHint(null);
        setLaunchProgressValue(70);
        setPlaybackOpen(true);
        setIsLaunching(true);
      });
      syncLoadingProgress(70);
    },
    [
      currentEpisode,
      currentMedia,
      getMediaDetails,
      playback,
      playbackOpen,
      setLaunchProgressValue,
      syncLoadingProgress,
    ]
  );

  // Keep a stable ref to the latest osc-action handler. handleExternalMpvOscAction's
  // useCallback identity changes on EVERY render — it depends on `playback`, which
  // useMpvPlaybackEngine returns as a fresh object literal each render. A listener
  // effect with that callback in its deps therefore unsubscribes + resubscribes on
  // every render, and mpv delivers the next_episode action over an edge-triggered
  // IPC (preload `ipcRenderer.on`, no buffering): a message landing in one of those
  // teardown windows is dropped forever. The Lua side already set auto_skip_fired,
  // so the credits pill silently reverts to a manual "Next episode" button and auto-
  // navigation never happens — exactly the field-reported credits→next-episode
  // auto-skip failure. Subscribing ONCE via this ref (below) closes the drop window.
  // @bugfix next-episode-osc-action-dropped-on-listener-churn
  const handleExternalMpvOscActionRef = useRef(handleExternalMpvOscAction);
  useEffect(() => {
    handleExternalMpvOscActionRef.current = handleExternalMpvOscAction;
  }, [handleExternalMpvOscAction]);

  // Durable osc_action dispatch (defense-in-depth, same @bugfix). Dedupe live
  // and recovered (pulled) deliveries by the main-assigned monotonic seq so an
  // action is never handled twice — a double-handle would navigate ep1→ep2
  // then immediately ep2→ep3 (nextPlayableEpisodeRef advances after the first
  // nav). Ack on handle so main drops the pending copy. Stable identity (no
  // deps) so the listener effect below never re-subscribes because of it.
  const lastHandledOscSeqRef = useRef(-1);
  const dispatchOscAction = useCallback(
    (action: { type: string; [key: string]: unknown }, seq?: number) => {
      if (typeof seq === "number") {
        if (seq <= lastHandledOscSeqRef.current) return; // already handled (a replay)
        lastHandledOscSeqRef.current = seq;
        window.sf?.ackOscAction?.(seq);
      }
      handleExternalMpvOscActionRef.current(action);
    },
    []
  );

  // Test-only seam: lets the skip-markers durable-recovery test force the
  // listener into a teardown window (detach → deliver while detached →
  // re-attach → catch-up recovers). ALWAYS true in production, so the listener
  // subscribes exactly once per playback session and never churns (the actual
  // fix). Test 12 asserts the subscribe-count stays flat across re-renders.
  const [oscListenerEnabled, setOscListenerEnabled] = useState(true);

  // Diagnostic seam: how many times the osc_action IPC listener has (re)subscribed.
  // A correct listener subscribes once per playback session (when playbackOpen flips
  // true); pre-fix it climbed on every render. Surfaced on __e2ePlayback.getState()
  // and asserted by the skip-markers E2E regression test.
  const oscActionSubscribeCountRef = useRef(0);
  useEffect(() => {
    if (!playbackOpen || !oscListenerEnabled) return;
    oscActionSubscribeCountRef.current += 1;
    const unsubscribe = window.sf?.onMpvExternalMessage?.((msg) => {
      if (msg.type !== "osc_action") return;
      dispatchOscAction(msg.action, msg.seq);
    });
    // Catch-up: recover an osc_action delivered while this listener was
    // detached (a render-churn teardown window) or fired before it first
    // mounted. The main process retains the last action; we pull it on every
    // (re)subscribe and dedupe by seq so it's replayed-at-most-once.
    void window.sf?.getPendingOscAction?.().then((pending) => {
      if (pending) dispatchOscAction(pending.action, pending.seq);
    });
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [playbackOpen, oscListenerEnabled, dispatchOscAction]);

  // Test-mode seams: expose a window-global helper and a synthetic OSC event
  // listener so E2E tests can drive playback state deterministically. The
  // seam is INSTALLED unconditionally — no NODE_ENV gate. Reason: Vite freezes
  // process.env.NODE_ENV at build time as "production", which dead-code-
  // eliminated the seam in the production bundle that e2e tests run against.
  // The handler only fires on `sf:e2e-trigger-osc-action` events that nothing
  // in production dispatches, and the window-global is read-only state, so
  // shipping it adds a few hundred bytes and zero runtime risk.
  const playbackRef = useRef(playback);
  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  // PLAY-OSMEDIA-01: mpv plays outside the page, so a silent element in this renderer holds Chromium's media session
  // (MPRIS / SMTC / Now Playing) while mpv plays; the media keys, a headset and the OS panel drive mpv through the
  // same paths as the in-app controls and the mpv OSC. Paused keeps the session; closing playback releases it.
  // The poster is the user's own copy (META-ART-01); a title whose copy is not made yet shows none, it never asks
  // the metadata service while playing.
  const osMediaArtwork = useLocalArtwork(currentMedia.posterPath, async (posterPath) => {
    if (!isAssetKey(posterPath)) return null;
    const libraryKey = await getStoredLibraryKey();
    return token && libraryKey ? getDecryptedAssetUrl(token, libraryKey, posterPath) : null;
  });
  useBadgerOsMediaSession(
    {
      open: playbackOpen,
      isPlaying: playback.isPlaying,
      currentTime: playback.currentTime,
      duration: playback.safeDuration,
      title: currentMedia.title,
      episode: currentEpisode,
      hasNext: Boolean(nextPlayableEpisode),
      hasPrevious: Boolean(previousPlayableEpisode),
      artworkUrl: osMediaArtwork,
    },
    {
      play: () => {
        if (!playbackRef.current.isPlaying) void playbackRef.current.togglePlay();
      },
      pause: () => {
        if (playbackRef.current.isPlaying) void playbackRef.current.togglePlay();
      },
      stop: () => {
        playTraceLog.info({ closeCause: "os-media-stop" }, "MediaPlaybackController: closing playback");
        setPlaybackOpen(false);
      },
      next: () => handleExternalMpvOscActionRef.current({ type: "next_episode" }),
      previous: () => handleExternalMpvOscActionRef.current({ type: "previous_episode" }),
      seekTo: (seconds) => playbackRef.current.requestSeek(seconds),
    }
  );

  // Capture refs to the controller-local activeEpisodeId so the __e2ePlayback
  // seam can read the latest navigation target at any time without waiting on
  // a closure re-bind. Used by skip-markers E2E tests to verify next-episode
  // auto-skip navigated to the right episode.
  const activeEpisodeIdRef = useRef(activeEpisodeId);
  useEffect(() => {
    activeEpisodeIdRef.current = activeEpisodeId;
  }, [activeEpisodeId]);

  useEffect(() => {
    const target = window as typeof window & {
      __e2ePlayback?: {
        setSelectedAudioId: (id: string) => void;
        setSelectedSubtitleId: (id: string) => void;
        getState: () => {
          selectedAudioId: string | null;
          selectedSubtitleId: string;
          chapters: Array<{ startSeconds: number; title: string }>;
          audioOptions: Array<{ id: string; label: string }>;
          subtitleOptions: Array<{ id: string; label: string }>;
          effectiveFormatId: string | null;
          effectiveQuality: string | null;
          formatOptions: Array<{ id: string; quality: string }>;
          oscActionSubscribeCount: number;
        };
        getActiveEpisodeId: () => string | null;
        seekTo: (seconds: number) => void;
        startFrom: (seconds: number, withResume?: boolean) => void;
        resumeFrom: (seconds: number) => void;
        selectFormat: (formatId: string) => void;
        setOscListenerEnabled: (enabled: boolean) => void;
      };
    };
    target.__e2ePlayback = {
      setSelectedAudioId: (id: string) => {
        playbackRef.current.setSelectedAudioId(id);
      },
      setSelectedSubtitleId: (id: string) => {
        playbackRef.current.setSelectedSubtitleId(id);
      },
      getState: () => ({
        selectedAudioId: playbackRef.current.selectedAudioId,
        selectedSubtitleId: playbackRef.current.selectedSubtitleId,
        chapters: playbackRef.current.chapters.map((c) => ({
          startSeconds: c.startSeconds,
          title: c.title,
        })),
        // Expose the renderer-side option lists so tests can pick a valid id
        // (renderer audio/subtitle ids are derived from the playback engine
        // and don't always match raw library-db track ids).
        audioOptions: playbackRef.current.audioOptions.map((o) => ({
          id: o.id,
          label: o.label,
        })),
        subtitleOptions: playbackRef.current.subtitleOptions.map((o) => ({
          id: o.id,
          label: o.label,
        })),
        // Quality/format introspection for the next-episode quality-carry
        // E2E test: which format is effective + the full option list so the
        // test can pick the highest quality and verify it survives an
        // episode transition.
        effectiveFormatId: playbackRef.current.effectiveFormat?.id ?? null,
        effectiveQuality: playbackRef.current.effectiveFormat?.quality ?? null,
        formatOptions: playbackRef.current.formats.map((f) => ({
          id: f.id,
          quality: f.quality,
        })),
        // How many times the osc_action IPC listener has (re)subscribed. The
        // skip-markers regression test forces re-renders and asserts this does
        // NOT climb — proving the next_episode action listener no longer churns
        // (and therefore can't drop the auto-skip action mid-render).
        oscActionSubscribeCount: oscActionSubscribeCountRef.current,
      }),
      // skip-markers E2E test seams. Read activeEpisodeId via ref to bypass
      // closure-staleness concerns. seekTo/startFrom proxy to the playback
      // engine so tests can drive mid-marker entry scenarios deterministically.
      getActiveEpisodeId: () => activeEpisodeIdRef.current,
      seekTo: (seconds: number) => {
        playbackRef.current.requestSeek(seconds);
      },
      startFrom: (seconds: number, withResume = true) => {
        playbackRef.current.startFrom(seconds, withResume);
      },
      // The detail page's Resume with a given saved position, opening the
      // player when mpv is closed (MPV-PAUSE-01 resume e2e).
      resumeFrom: (seconds: number) => {
        void resumeActionRef.current.trigger(seconds);
      },
      // Mimics a user OSC quality pick (sets userTargetQuality), so the
      // quality-carry E2E test can verify the chosen quality survives a
      // next-episode transition.
      selectFormat: (formatId: string) => {
        playbackRef.current.selectFixedFormat(formatId, "user");
      },
      // Force the osc_action listener to detach (false) / re-attach (true) so
      // the durable-recovery regression test can open a teardown window,
      // deliver an action into it, then verify the catch-up pull recovers it.
      setOscListenerEnabled: (enabled: boolean) => {
        setOscListenerEnabled(enabled);
      },
    };
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string; [key: string]: unknown }>).detail;
      if (!detail) return;
      handleExternalMpvOscActionRef.current(detail);
    };
    window.addEventListener("sf:e2e-trigger-osc-action", handler as EventListener);
    return () => {
      window.removeEventListener("sf:e2e-trigger-osc-action", handler as EventListener);
      delete target.__e2ePlayback;
    };
  }, []);

  useEffect(() => {
    if (currentMedia.type !== "tv") return;
    if (currentMedia.catalogId == null) return;
    if (!currentEpisode) return;

    const externalMarkers = currentMedia.skipMarkers.filter(
      (marker) => marker.episodeId === currentEpisode.id && isServiceSkipMarkerSource(marker.source)
    );
    if (externalMarkers.length > 0) return;

    const fetchKey = `${currentMedia.id}:${currentEpisode.id}`;
    if (attemptedSkipMarkerFetchesRef.current.has(fetchKey)) return;
    attemptedSkipMarkerFetchesRef.current.add(fetchKey);

    const durationSeconds = getStoredDuration(currentMedia);
    void (async () => {
      try {
        const cachedFetchRows = await listSkipAnalysis(currentMedia.id, EXTERNAL_SKIP_MARKER_FETCH_KIND);
        const cachedFetch = cachedFetchRows.find(
          (row) => row.episodeId === currentEpisode.id && isExternalSkipMarkerFetchPayload(row.payload)
        );
        if (cachedFetch && (cachedFetch.payload.status === "hit" || cachedFetch.payload.status === "miss")) {
          return;
        }

        const result = await getMetadataSkipMarkers(
          "",
          "tv",
          currentMedia.catalogId as number,
          currentEpisode.seasonNumber,
          currentEpisode.episodeNumber,
          durationSeconds
        );
        const episodeByNumber = new Map(
          currentMedia.episodes.map((episode) => [`${episode.seasonNumber}:${episode.episodeNumber}`, episode.id] as const)
        );
        for (const coverageEntry of result.coverage) {
          const targetEpisodeId = episodeByNumber.get(`${coverageEntry.seasonNumber}:${coverageEntry.episodeNumber}`);
          if (!targetEpisodeId) continue;
          await upsertSkipAnalysis(
            currentMedia.id,
            targetEpisodeId,
            EXTERNAL_SKIP_MARKER_FETCH_KIND,
            createExternalSkipMarkerFetchPayload(coverageEntry, result.fetchedAt)
          );
        }

        // By source priority: the user's own times stay, the detected ones give way (PLAY-SKIP-08).
        const fetched = result.markers.flatMap((marker) =>
          marker.endSeconds == null
            ? []
            : [
                {
                  type: marker.type,
                  startSeconds: marker.startSeconds,
                  endSeconds: marker.endSeconds,
                  source: marker.source,
                  confidence: marker.confidence,
                },
              ]
        );
        if (fetched.length > 0) await mergeSkipMarkers(currentMedia.id, currentEpisode.id, fetched);
        const refreshed = await fetchMediaDetails(currentMedia.id);
        if (refreshed) {
          setCurrentMedia(refreshed);
        }
      } catch {
        // Skip markers remain optional; internal markers continue to work.
      }
    })();
  }, [
    currentEpisode,
    currentMedia,
    fetchMediaDetails,
    getStoredDuration,
    listSkipAnalysis,
    mergeSkipMarkers,
    upsertSkipAnalysis,
  ]);

  // ABR (in useMpvPlaybackEngine) owns quality switching during launch +
  // playback. The watchdog effect below is now a hard safety net only — it
  // fires when the engine never signals isReadyToReveal within 30 s and
  // surfaces an error toast. No more "Switching to 360p for a faster start"
  // wall-clock fallback; ABR makes those decisions based on real signals
  // (mpv's demuxer-cache-state buffer, its dropped-frame counters, and the
  // main-process link meter's throughput estimate).

  useEffect(() => {
    if (!playbackOpen || !isLaunching) return;
    // See revealRecheckPendingRef: the first decision after a launch starts
    // waits one render so it reads the engine's post-launch readiness.
    if (revealRecheckPendingRef.current) {
      revealRecheckPendingRef.current = false;
      setRevealRecheckTick((tick) => tick + 1);
      return;
    }
    // The playback engine signals isReadyToReveal once mpv is fully ready
    // (tracks stable + metadata applied + first frame). Dismissing earlier
    // (on isPlaying alone) left a visible gap between modal-disappear and
    // mpv-actually-on-screen-with-metadata.
    if (!playback.isReadyToReveal) return;
    setLaunchProgressValue(100);
    syncLoadingProgress(100);
    setIsLaunching(false);
    setLaunchStatusHint(null);
    if (resumeCandidateTime === null) {
      setResumePromptOpen(false);
    }
    if (loadingTokenRef.current) {
      hideLoading(loadingTokenRef.current);
      loadingTokenRef.current = null;
    }
  }, [
    playbackOpen,
    isLaunching,
    playback.isReadyToReveal,
    resumeCandidateTime,
    revealRecheckTick,
    setLaunchProgressValue,
    syncLoadingProgress,
  ]);

  useEffect(() => {
    if (!playbackOpen || !isLaunching || streamSlotAsking) return;
    // Two-tier safety net. The engine's deterministic budget is ~20 s
    // (tracks-stable 15 s + vo-configured 5 s) plus seek + resume overhead;
    // a healthy launch reaches isReadyToReveal well before 30 s. Beyond that
    // we're in "this is unusually slow" territory but mpv may still come up
    // — observed real-world launches at ~50 s on cold-disk + ffmpeg cold-
    // start. Showing "Couldn't start playback" at 30 s while the launch is
    // still progressing is a false-positive error.
    //
    // 30 s soft tier: keep the loading modal up, surface a "still launching"
    // status hint. No error toast. If isReadyToReveal flips after this, the
    // reveal effect dismisses the modal normally.
    // 60 s hard tier: genuine give-up. Dismiss the modal, surface
    // notifyError, set isLaunching false. The engine's launch flow will
    // eventually no-op if it reaches its tail after we've bailed.
    const softTimeout = window.setTimeout(() => {
      if (playback.isReadyToReveal) return;
      setLaunchStatusHint(t("player.launchSlow"));
    }, 30000);
    const hardTimeout = window.setTimeout(() => {
      if (playback.isReadyToReveal) return;
      setLaunchStatusHint(null);
      setIsLaunching(false);
      if (loadingTokenRef.current) {
        hideLoading(loadingTokenRef.current);
        loadingTokenRef.current = null;
      }
      notifyError(t("player.abrLaunchFailed"), undefined, { key: "playback-failed:launch-timeout" });
      onLaunchFailedRef.current?.("launch_timeout");
    }, 60000);
    return () => {
      window.clearTimeout(softTimeout);
      window.clearTimeout(hardTimeout);
    };
  }, [
    playbackOpen,
    isLaunching,
    streamSlotAsking,
    hideLoading,
    playback.isReadyToReveal,
    setLaunchProgressValue,
    syncLoadingProgress,
    t,
  ]);

  useEffect(() => {
    if (!playbackOpen) return;
    if (!playback.streamError) return;
    setLaunchProgressValue(0);
    setIsLaunching(false);
    setLaunchStatusHint(null);
    if (loadingTokenRef.current) {
      hideLoading(loadingTokenRef.current);
      loadingTokenRef.current = null;
    }
    // Unpaid accounts get 402 `subscription_unpaid` on every playback request, and a frozen over-quota account
    // 402 `account_over_quota` (ACCT-OVER-02); mpv only reports a generic load failure, so say what actually happened (#145).
    const unpaidAccess = getUnpaidAccessInfo(user?.access);
    const frozen = user?.access?.overQuota?.phase === "frozen" ? user.access.overQuota : null;
    // UX-NOTICE-11: the same failure replaces its earlier notice and bell entry instead of adding another.
    const reason = unpaidAccess.unpaid ? "unpaid" : frozen ? "frozen" : (playback.streamError ?? "stream");
    notifyError(
      unpaidAccess.unpaid
        ? unpaidMessage(t, "playbackBlocked", unpaidAccess.wipeAt, i18n?.language)
        : frozen
          ? t("account.overQuota.playbackBlocked", { date: formatAccessDate(frozen.deletionAt, i18n?.language) })
          : (playback.streamError ?? t("player.abrLaunchFailed")),
      undefined,
      { key: `playback-failed:${reason}` },
    );
    playTraceLog.info({ closeCause: "stream-error", streamError: playback.streamError }, "MediaPlaybackController: closing playback");
    onLaunchFailedRef.current?.(`stream_error: ${playback.streamError}`);
    setPlaybackOpen(false);
  }, [playback.streamError, playbackOpen, hideLoading, setLaunchProgressValue]);

  const awaitLaunchSettled = useCallback(() => {
    return new Promise<void>((resolve) => {
      launchCompletionResolversRef.current.push(resolve);
    });
  }, []);

  // Resume / Start over clicks: the launch render (media swap + open + engine
  // effects, chunk maps rebuilt when the library copy is newer) is most of the
  // click's processing time; the old flushSync only added a second synchronous
  // render in front of it. The launch now runs as ONE transition so it leaves
  // the click task, and the media swap and the launch flags commit together,
  // so the engine never launches with stale metadata.
  // @bugfix issue #25 P15 @regression-proof
  // (tests/media-playback-controller-click-no-sync-launch-render.test.tsx)
  const restartAction = useAsyncAction(async () => {
    const latestMedia = getPlaybackLaunchMedia(currentMedia, getMediaDetails(currentMedia.id));
    // setProgress applies its optimistic library update synchronously; keep
    // that app-wide re-render out of the click task too.
    let progressReset: Promise<void> = Promise.resolve();
    startTransition(() => {
      progressReset = setProgress(currentMedia.id, 0, activeEpisodeId ?? null);
    });
    await progressReset;
    playback.clearResumeTarget?.();
    revealRecheckPendingRef.current = true;
    startTransition(() => {
      setCurrentMedia(latestMedia);
      setDeferForPrompt(false);
      setLaunchProgressValue(70);
      setPlaybackOpen(true);
      setIsLaunching(true);
    });
    syncLoadingProgress(70);
    playback.prepareEpisodeStart?.(0, true);
    playback.startFrom(0, true);
    await awaitLaunchSettled();
    setResumePromptOpen(false);
  });
  const handleRestart = useCallback(() => {
    void restartAction.trigger();
  }, [restartAction]);

  // `time`: the E2E seam's saved position (fixtures are shorter than the
  // PLAY-RESUME-01 floor, so no prompt can offer one).
  const resumeAction = useAsyncAction(async (time: number | null = resumeCandidateTime) => {
    if (time === null) return;
    const latestMedia = getPlaybackLaunchMedia(currentMedia, getMediaDetails(currentMedia.id));
    revealRecheckPendingRef.current = true;
    startTransition(() => {
      setCurrentMedia(latestMedia);
      setDeferForPrompt(false);
      setLaunchProgressValue(70);
      setPlaybackOpen(true);
      setIsLaunching(true);
    });
    syncLoadingProgress(70);
    playback.startFrom(time, true);
    await awaitLaunchSettled();
    setResumePromptOpen(false);
  });
  const handleResume = useCallback(() => {
    void resumeAction.trigger();
  }, [resumeAction]);
  const resumeActionRef = useRef(resumeAction);
  useEffect(() => {
    resumeActionRef.current = resumeAction;
  }, [resumeAction]);

  useEffect(() => {
    if (isLaunching) {
      wasLaunchingRef.current = true;
      return;
    }
    if (!wasLaunchingRef.current) return;
    wasLaunchingRef.current = false;
    const resolvers = launchCompletionResolversRef.current;
    launchCompletionResolversRef.current = [];
    for (const resolve of resolvers) resolve();
  }, [isLaunching]);

  useEffect(() => () => {
    const resolvers = launchCompletionResolversRef.current;
    launchCompletionResolversRef.current = [];
    for (const resolve of resolvers) resolve();
  }, []);

  const showResumeDetails = resumeCandidateTime !== null;
  const resumeSubtitleText =
    showResumeDetails && resumeEpisodeLabel
      ? t("player.resumeSubtitleEpisode", {
          time: formatTime(resumeCandidateTime),
          episode: resumeEpisodeLabel,
        })
      : showResumeDetails
        ? t("player.resumeSubtitle", { time: formatTime(resumeCandidateTime) })
        : null;

  const closeEditionChooser = () => {
    playTraceLog.info({ closeCause: "edition-chooser-dismissed" }, "MediaPlaybackController: closing playback");
    setEditionChooser(null);
    setPlaybackOpen(false);
    setIsLaunching(false);
  };

  return (
    <>
    {/* PLAY-OPEN-02: "Which edition?" at every Play of a film or episode with two or more editions; nothing preselected. */}
    <Dialog open={editionChooser !== null} onOpenChange={(open) => {
      if (!open) closeEditionChooser();
    }}>
      <DialogContent className="max-w-sm border-none bg-transparent p-0 shadow-none" data-testid="edition-chooser">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("player.editionChooserTitle")}</DialogTitle>
          <DialogDescription>{t("player.editionChooserDescription")}</DialogDescription>
        </DialogHeader>
        <div className="w-full rounded-2xl bg-black/70 p-5 text-sm text-white shadow-xl">
          <div className="text-base font-semibold">{t("player.editionChooserTitle")}</div>
          <div className="mt-4 flex flex-col gap-2">
            {editionChooser?.editions.map((edition) => {
              const spot = editionChooser.resume[edition.id];
              const label = [
                edition.name || t("player.editionUnnamed"),
                spot ? t("player.editionResumeFrom", { time: formatEditionLength(spot.positionSeconds) }) : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Button
                  key={edition.id}
                  type="button"
                  variant="ghost"
                  className="h-auto justify-between gap-4 bg-white/10 px-4 py-3 text-left text-white hover:bg-white/20"
                  data-testid="edition-choice"
                  data-edition-id={edition.id}
                  onClick={() =>
                    launchEditionRef.current(
                      `edition:${edition.id}`,
                      editionChooser.details,
                      editionChooser.episodeId,
                      editionChooser.slot,
                      edition.id,
                      editionChooser.resume
                    )
                  }
                >
                  <span data-testid="edition-choice-label">{label}</span>
                  {edition.durationSeconds ? (
                    <span className="text-white/70" data-testid="edition-choice-length">
                      {formatEditionLength(edition.durationSeconds)}
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={resumePromptOpen} onOpenChange={(open) => {
      if (!open) {
        setResumePromptOpen(false);
        setResumeCandidateTime(null);
        setDeferForPrompt(false);
        playTraceLog.info({ closeCause: "resume-dialog-dismissed", isLaunching }, "MediaPlaybackController: closing playback");
        setPlaybackOpen(false);
        setIsLaunching(false);
      }
    }}>
      <DialogContent className="max-w-sm border-none bg-transparent p-0 shadow-none" hideCloseButton={isLaunching}>
        <DialogHeader className="sr-only">
          <DialogTitle>{showResumeDetails && !isLaunching ? t("player.resumeTitle") : t("player.launching")}</DialogTitle>
          <DialogDescription>
            {showResumeDetails && !isLaunching
              ? resumeEpisodeLabel
                ? t("player.resumeSubtitleEpisode", { time: "--:--:--", episode: resumeEpisodeLabel })
                : t("player.resumeSubtitle", { time: "--:--:--" })
              : t("player.launching")}
          </DialogDescription>
        </DialogHeader>
        {isLaunching ? (
          <LaunchingLoader title={t("player.launching")}>
            <div className="text-white/80">{launchStatusHint ?? t("player.preparingPlayback")}</div>
          </LaunchingLoader>
        ) : (
          <div className="w-full rounded-2xl bg-black/70 p-5 text-sm text-white shadow-xl">
            <div className="text-base font-semibold">
              {showResumeDetails ? t("player.resumeTitle") : t("player.launching")}
            </div>
            {showResumeDetails ? (
              <div className="mt-1 text-white/70">{resumeSubtitleText}</div>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                className="bg-white/10 text-white hover:bg-white/20"
                pending={restartAction.spinnerVisible}
                spinnerLabel={t("player.launching")}
                disabled={restartAction.pending || resumeAction.pending}
                onClick={() => handleRestart()}
              >
                {t("player.restart")}
              </Button>
              <Button
                type="button"
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                pending={resumeAction.spinnerVisible}
                spinnerLabel={t("player.launching")}
                disabled={resumeAction.pending || restartAction.pending}
                onClick={handleResume}
              >
                {t("player.resume")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
