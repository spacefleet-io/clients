import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, BackHandler, Platform, StyleSheet, View } from "react-native";
import { StackActions, useNavigation, useRoute } from "@react-navigation/native";
import { MpvControl, MpvPlayer, PlaybackBridge, PlayerControls, switchEpisodeKeepingCore, type AudioTrack, type MpvTrack, type PlayerControlsHandle, type PlayerControlsLabels, type PlaybackSnapshot, type SubtitleTrack } from "@space/mobile-mpv-playback";
import { directRenderOf, loadsOcrTwin } from "@space/mobile-mpv-playback/ocrTwin";
import { getCurrentLanguage, useTranslation } from "@space/mobile-shell/i18n";
import { useLibraryActions } from "../store/library";
import { useAuth } from "../store/auth";
import { playerFailureMessage } from "@space/mobile-shell/unpaid-access";
import { getAppSettings } from "../lib/appSettings";
import { theme } from "../theme/theme";
import { usePlayerSession } from "./player/usePlayerSession";
import { useLocalizedPlayback } from "../lib/useLocalizedShowDetails";
import { IS_TV } from "../tv/lib/tvRuntime";
import { episodeSwitchStartAt } from "@space/shared/playbackResume";
import { useTvScale } from "@space/mobile-shell/tv/tvScale";
import { TvPlayerRemote } from "../tv/components/TvPlayerRemote";
import { PlayerCastPicker } from "../components/PlayerCastPicker";
import { googleCastAvailable } from "../lib/cast/googleCastAvailable";
import type { CastTarget } from "../lib/cast/castFlow";
import {
  DeviceTooWeakNotice,
  NextEpisodeCard,
  PlayerError,
  PlayerLoadingBackdrop,
  PlayerSpinner,
  ResumePrompt,
  SkipPill,
  TrafficCapNotice,
} from "./player/PlayerOverlays";
import { usePlaybackSnapshot } from "../lib/playback/usePlaybackSnapshot";
import { buildStartOptions, detectPlaybackFailure, shouldShowLoadingHint, shouldShowSpinner, trackLoading, type PlaybackFailureCode } from "../lib/playback/health";
import { armStartOver, commitProgressSave, createProgressGate, planProgressSave } from "../lib/playback/progressSave";
import { applyStartTracks, planStartTracks, rememberAudioPick, rememberSubtitlePick, resolveMpvAudioId, type StartTrackDefaults, type StartTrackPlan } from "../lib/playback/trackPrefs";
import { findActiveSidecar, playbackObjectUrl, sidecarSubtitleUrl } from "../lib/playback/sidecarSubtitle";
import { createSeekPreviewSource, loadSheetDataUri } from "../lib/playback/seekPreviewSource";
import {
  createAutoSkipState,
  stepAutoSkip,
  suppressAutoSkip,
  type PillAction,
  type PillConfig,
} from "../lib/playback/skipMarkers";
import { formatEpisodeLabel } from "../lib/playback/nextEpisode";
import { localPlaybackMediaState } from "../lib/playback/osMediaSession";
import { useOsMediaSession } from "../lib/playback/useOsMediaSession";
import { useMediaImage } from "../lib/useMediaImage";
import { formatNowPlaying } from "@space/shared/nowPlaying";
import {
  isFetchedSubtitleSource,
  subtitleFetchCopy,
  subtitleFetchNeedsTitle,
  subtitleFetchTarget,
  type FetchedSubtitleTrack as LibraryFetchedSubtitleTrack,
} from "@space/shared/subtitleFetch";
import { useNetworkOnline } from "../lib/networkListener";
import type { FetchedSubtitleTrack } from "../lib/subtitleFetchStore";
import {
  fetchedSubtitleToPlayerTrack,
  replacePlayerSubtitle,
  withFetchedSubtitles,
  type ReplacedSubtitles,
} from "../lib/playback/fetchedSubtitles";
import { PlayerSubtitleFetch } from "./player/PlayerSubtitleFetch";
import { PlayerSubtitleVersion } from "./player/PlayerSubtitleVersion";
import { PlayerSubtitleFile } from "./player/PlayerSubtitleFile";
import { attachRemotePlayer, publishRemoteState, remoteStateWanted, type RemotePlayer } from "../lib/playOnTv/playerLink";
import type { RemoteStart } from "../lib/playOnTv/protocol";
import { applyRemoteCommand, buildTvState } from "../tv/lib/remotePlayerAdapter";
import { buildDecoderProbes } from "../lib/playback/decoderCaps";
import {
  cacheReachedEnd,
  capCeilingRank,
  createAbrController,
  noteLoadStarted,
  noteSeek,
  noteSwitchSettled,
  planStart,
  selectQuality,
  stepAbr,
  type AbrController,
  type DecoderPolicy,
  type QualityCap,
  type QualityState,
  type Variant,
} from "@space/playback-abr";
import { MOBILE_DEFAULT_CACHE_CONFIG, rungMasterUrl } from "../lib/playback/rungSwitch";
import { QualitySwitchMachine } from "../lib/playback/qualitySwitch";
import {
  TRAFFIC_POLL_MS,
  activeQualityCap,
  applySiloTrafficEvent,
  noteCapSwitch,
  parseSiloTrafficEvent,
  planCapRelease,
  planCapStep,
  trafficPollDue,
  type CapDisplacement,
  type SiloTrafficEvent,
  type SiloUnavailableCode,
} from "../lib/playback/siloTraffic";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import { playbackBufferCap } from "../lib/playback/trafficBuffer";

const SAVE_INTERVAL_MS = 5_000;
const NEXT_EPISODE_COUNTDOWN_S = 5;
/** The controls wear the Badger shell's accent on phone and TV, so the player matches the rest of the app (PLAY-LOOK-01). */
const CONTROLS_THEME = { accent: theme.colors.accent };

/**
 * The profile's "Default audio language" and "Subtitle language" (ACCT-SQUAD-03), read at play start only, with when
 * the subtitle language was last changed (PLAY-TRACK-11).
 */
const startTrackDefaults = (): StartTrackDefaults => {
  const settings = getAppSettings();
  return {
    audioLanguage: settings.defaultAudioLanguage ?? null,
    subtitleLanguage: settings.defaultSubtitleLanguage ?? null,
    subtitleSetAt: settings.defaultSubtitleLanguageSetAt ?? null,
  };
};

type Start = { seconds: number; startOver: boolean };

/** Remounts the player when the episode changes so every piece of per-file state starts clean. */
export const PlayerScreen = () => {
  const route = useRoute();
  const { mediaId, episodeId, backdropPath, posterPath, remoteStart, startAt } = route.params as {
    mediaId: string;
    episodeId?: string | null;
    backdropPath?: string | null;
    posterPath?: string | null;
    remoteStart?: RemoteStart | null;
    startAt?: PlayerStartAt | null;
  };
  return (
    <PlayerScreenInner
      key={`${mediaId}:${episodeId ?? ""}`}
      mediaId={mediaId}
      episodeId={episodeId ?? null}
      artwork={{ backdropPath: backdropPath ?? null, posterPath: posterPath ?? null }}
      remoteStart={remoteStart ?? null}
      startAt={startAt ?? null}
    />
  );
};

type Artwork = { backdropPath: string | null; posterPath: string | null };

/** Chosen before the player opened (the TV Home's Resume / Start over, UX-TV-05): the player does not ask again. */
export type PlayerStartAt = "resume" | "startOver";

const PlayerScreenInner = ({
  mediaId,
  episodeId,
  artwork,
  remoteStart,
  startAt,
}: {
  mediaId: string;
  episodeId: string | null;
  artwork: Artwork;
  /** Set when the phone started this title on the TV ("Play on TV", UX-TV-02). */
  remoteStart: RemoteStart | null;
  startAt: PlayerStartAt | null;
}) => {
  const navigation = useNavigation();
  const { setPlaybackProgress, setTrackPrefs } = useLibraryActions();
  // Names come from the episode list's source (LIB-LANG-01): the header, next card and resume prompt match the title page.
  const session = useLocalizedPlayback(usePlayerSession(mediaId, episodeId));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const { t } = useTranslation();
  /** TV: the controls' size multiplier (UX-TV-13; 2 on an Apple TV's 1920x1080 points). Phones keep their own sizes. */
  const windowTvScale = useTvScale();
  const controlsScale = IS_TV ? windowTvScale : 1;
  const { user, refresh: refreshAccount } = useAuth();
  // ACCT-UNPAID-03: the gateway refuses playback of an unpaid account (402 `subscription_unpaid`) but the native
  // player only reports a failed open, so name the real cause once the account is known to be unpaid.
  const offline = session.offline;
  const failureText = useCallback(
    (code: string) => playerFailureMessage(t, code, user?.access, getCurrentLanguage(), Date.now(), { offline }),
    [t, user?.access, offline],
  );
  const controlLabels = useMemo<PlayerControlsLabels>(
    () => ({
      closePlayer: t("player.controls.closePlayer"),
      videoSurface: t("player.controls.videoSurface"),
      chapters: t("player.controls.chapters"),
      previousEpisode: t("player.controls.previousEpisode"),
      nextEpisode: t("player.controls.nextEpisode"),
      subtitles: t("player.controls.subtitles"),
      audio: t("player.controls.audio"),
      quality: t("player.controls.quality"),
      cast: t("player.controls.cast"),
      volume: t("player.controls.volume"),
      brightness: t("player.controls.brightness"),
      seekBackToast: t("player.controls.seekBackToast"),
      seekBy: (amount) => t("player.controls.seekBy", { amount }),
      seekForwardToast: t("player.controls.seekForwardToast"),
      play: t("player.controls.play"),
      pause: t("player.controls.pause"),
      seekBar: t("player.controls.seekBar"),
      qualityAuto: t("player.controls.qualityAuto"),
      subtitlesOff: t("player.controls.subtitlesOff"),
      subtitleLoadFailed: t("player.controls.subtitleLoadFailed"),
      trackFallback: (position) => t("player.controls.trackFallback", { n: position }),
    }),
    [t],
  );

  /**
   * Subtitles fetched during this playback (PLAY-SUBGET-02) and the session's ones "Try another version" replaced
   * (PLAY-SUBGET-07): the menu lists them, and a quality switch reloads them.
   */
  const [addedSubtitles, setAddedSubtitles] = useState<{ fetched: SubtitleTrack[]; replaced: ReplacedSubtitles }>({ fetched: [], replaced: {} });
  const addedSubtitlesRef = useRef(addedSubtitles);
  addedSubtitlesRef.current = addedSubtitles;
  const [controlsVisible, setControlsVisible] = useState(true);
  /** TV: distance (dp) from the screen bottom to the controls' bottom bar top; subtitles sit above it while the controls show (MPV-OSC-02). */
  const [controlsInset, setControlsInset] = useState(0);
  /** TV: the progress bar holds the D-pad focus, so the remote's left / right seek (UX-TV-01). */
  const [progressFocused, setProgressFocused] = useState(false);
  /** TV: a track menu is open; with the overlay state this decides what the remote's keys do (src/tv/lib/playerRemote.ts). */
  const [sheetOpen, setSheetOpen] = useState(false);
  const controlsRef = useRef<PlayerControlsHandle>(null);
  const [start, setStart] = useState<Start | null>(null);
  const [failure, setFailure] = useState<PlaybackFailureCode | SiloUnavailableCode | null>(null);
  const [pill, setPill] = useState<PillAction | null>(null);
  /** TV: the marker whose pill Back dismissed (it stays hidden until the next marker's pill). */
  const [dismissedPillKey, setDismissedPillKey] = useState<string | null>(null);
  const [nextCard, setNextCard] = useState<{ countdown: number | null } | null>(null);
  const [quality, setQuality] = useState<QualityState | null>(null);
  /** The "this phone isn't powerful enough" notice is up (raised once per playback by the Auto controller). */
  /** The "not powerful enough" notice: null = hidden; `pinned` = quality is forced, so it also hints at unpinning. */
  const [tooWeak, setTooWeak] = useState<{ pinned: boolean } | null>(null);
  const qualityStarting = useRef(false);
  const qualityRef = useRef<QualityState | null>(null);
  /** Per-file Auto quality controller; `ctrl.quality` is the authority, `quality` state mirrors it for the UI. */
  const abrRef = useRef<AbrController | null>(null);
  qualityRef.current = quality;
  /**
   * The silo's report for this viewer (STOR-BW-07, STOR-BW-08, PLAY-QUAL-07): from the native proxy's `SpacePlaybackTraffic` events,
   * the 60 s poll only as fallback; per silo, never merged.
   */
  const [traffic, setTraffic] = useState<StorageTraffic | null>(null);
  const [capNotice, setCapNotice] = useState<QualityCap | null>(null);
  const capNoticeShown = useRef(false);
  /** The rung a cap took the player off, kept so a pinned rung comes back when the cap lifts. */
  const displacementRef = useRef<CapDisplacement | null>(null);
  const trafficRef = useRef<StorageTraffic | null>(null);
  const failureRef = useRef<PlaybackFailureCode | SiloUnavailableCode | null>(null);
  /** When the native proxy last reported traffic; null = never, so the fallback poll runs. */
  const lastNativeReportAt = useRef<number | null>(null);
  /** Auto's ceiling from Settings and the decoder, before any quality cap lowers it. */
  const baseCeilingRank = useRef(0);
  const capRef = useRef<QualityCap | null>(null);
  const activeCap = activeQualityCap(traffic);
  capRef.current = activeCap;
  trafficRef.current = traffic;
  failureRef.current = failure;

  const variants = useMemo<Variant[]>(
    () =>
      (session.metadata?.videos ?? []).map((video) => ({
        id: video.id,
        quality: video.quality,
        codec: video.codec,
        codecString: video.codecString,
        bitrateKbps: video.bitrateKbps ?? null,
        width: video.width ?? null,
        height: video.height ?? null,
        // A rung switch reloads and must fetch the whole segment at the position first: the drain rule needs the sizes.
        segments: video.chunks.map((chunk) => ({ startSeconds: chunk.startSeconds, sizeBytes: chunk.sizeBytes })),
      })),
    [session.metadata],
  );
  const variantsRef = useRef(variants);
  variantsRef.current = variants;

  // Prompt first when a resume candidate exists; otherwise start straight away. A start from the phone ("Play on TV")
  // never prompts: it starts at the phone's resume point (UX-TV-02). Nor does a start chosen on the TV Home's Continue
  // watching card (Resume / Start over, UX-TV-05).
  const needsPrompt =
    session.phase === "ready" && session.resumeCandidateSeconds !== null && remoteStart === null && startAt === null;
  useEffect(() => {
    if (session.phase !== "ready" || start !== null || needsPrompt) return;
    if (startAt !== null) {
      const seconds = startAt === "resume" ? session.resumeCandidateSeconds ?? 0 : 0;
      console.info("player.start.chosen", JSON.stringify({ startAt, seconds: Math.round(seconds) }));
      setStart({ seconds, startOver: startAt === "startOver" });
      return;
    }
    const seconds = remoteStart?.positionSeconds ?? 0;
    if (remoteStart) console.info("tv.cast.player.start", JSON.stringify({ positionSeconds: Math.round(seconds), tracks: remoteStart.tracks }));
    setStart({ seconds, startOver: false });
  }, [needsPrompt, remoteStart, session.phase, session.resumeCandidateSeconds, start, startAt]);

  // Quality state is created once the variants are known: Settings quality, limited by what the device really decodes
  // (`MpvControl.getDecoderCaps`: MediaCodecList on Android, Apple's published limits per model on iPhone). A phone counts
  // only its hardware decoders, a TV its software decoders too (PLAY-QUAL-06). Unknown caps (native call failed) = the
  // Settings rung, as before.
  useEffect(() => {
    if (variants.length === 0 || qualityRef.current || qualityStarting.current) return;
    qualityStarting.current = true;
    void (async () => {
      const settings = getAppSettings();
      const setting = { quality: settings.defaultQuality, force: settings.forceQuality };
      const caps = await MpvControl.getDecoderCaps(buildDecoderProbes(variants)).catch((error: unknown) => {
        console.warn("playback.decoder.caps_unavailable", JSON.stringify({ error: String(error) }));
        return null;
      });
      if (!mounted.current) return;
      const decoderPolicy: DecoderPolicy = IS_TV ? "any" : "hardware-first";
      const plan = planStart(variants, setting, caps, decoderPolicy);
      const ctrl = createAbrController(variants, setting, Date.now(), caps, { decoderPolicy });
      abrRef.current = ctrl;
      baseCeilingRank.current = ctrl.settingsCeilingRank;
      console.warn(
        "playback.quality.start",
        JSON.stringify({
          mode: ctrl.quality.mode,
          currentId: ctrl.quality.currentId,
          setting: settings.defaultQuality,
          force: settings.forceQuality,
          startReason: plan.reason,
          baselineId: plan.baseline?.id ?? null,
          decoderCaps: caps ? "known" : "unknown",
          decoderPolicy,
          probes: caps?.probes ?? [],
        }),
      );
      if (plan.forcedUndecodable) {
        console.warn("playback.quality.forced_undecodable", JSON.stringify({ forcedId: plan.variant?.id ?? null, note: "Force wins: playing it anyway" }));
      }
      setQuality(ctrl.quality);
    })();
  }, [variants]);

  const playing = session.phase === "ready" && start !== null && quality !== null;
  // Only the first load uses these (rule 1: the first frame is the Settings rung); later switches go through MpvControl.
  const startOptions = useMemo(
    () => (playing ? buildStartOptions({ startSeconds: start!.seconds }) : null),
    [playing, start],
  );
  const startSource = useMemo(
    () => (playing && session.playUrl && qualityRef.current?.currentId ? rungMasterUrl(session.playUrl, qualityRef.current.currentId) : null),
    [playing, start],
  );

  // Immersive landscape + keep screen on for the lifetime of the screen.
  useEffect(() => {
    void MpvControl.setImmersiveLandscape(true).catch(() => undefined);
    void MpvControl.setKeepScreenOn(true).catch(() => undefined);
    return () => {
      void MpvControl.setImmersiveLandscape(false).catch(() => undefined);
      void MpvControl.setKeepScreenOn(false).catch(() => undefined);
    };
  }, []);

  const handleBackPress = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    // Empty stack (e.g. NavigationContainer remount during playback): Main, not an activity close.
    navigation.navigate("Main" as never);
  }, [navigation]);

  // ACCT-STREAM-02: Cancel at "Play here instead?", or another device took the place: the player closes (the alert
  // says why), never an error screen.
  useEffect(() => {
    if (!session.closeReason) return;
    console.warn("player.stream_slot.close", JSON.stringify({ reason: session.closeReason }));
    handleBackPress();
  }, [session.closeReason, handleBackPress]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleBackPress();
      return true;
    });
    return () => sub.remove();
  }, [handleBackPress]);

  const { snapshot, latest } = usePlaybackSnapshot(playing, controlsVisible);

  // --- Remembered tracks (PLAY-TRACK-04) + default audio language (PLAY-TRACK-01) ----------------
  // The title's synced audio/subtitle choice, else the device's default audio language, applied once after the first
  // frame. Nothing here writes: a missing track or no record leaves mpv's own defaults, and only a user pick (below)
  // updates the record. Under direct rendering (known only at that frame) the plan is redone so a picture subtitle
  // without an OCR twin is never started (PLAY-TRACK-05); the controls' selected row follows the plan applied.
  const startTracks = useMemo(
    () =>
      session.metadata
        ? planStartTracks(
            session.trackPrefs,
            session.metadata.audioTracks,
            session.metadata.subtitleTracks,
            startTrackDefaults(),
          )
        : null,
    [session.metadata, session.trackPrefs],
  );
  const [appliedStartTracks, setAppliedStartTracks] = useState<StartTrackPlan | null>(null);
  const shownStartTracks = appliedStartTracks ?? startTracks;
  const startTracksApplied = useRef(false);
  useEffect(() => {
    const metadata = session.metadata;
    if (!playing || !snapshot?.voConfigured || startTracksApplied.current || !startTracks || !metadata || !session.playUrl) return;
    startTracksApplied.current = true;
    const directRender = directRenderOf(snapshot) === true;
    const plan = directRender
      ? planStartTracks(session.trackPrefs, metadata.audioTracks, metadata.subtitleTracks, startTrackDefaults(), true)
      : startTracks;
    setAppliedStartTracks(plan);
    void applyStartTracks({
      plan,
      audioTracks: metadata.audioTracks,
      subtitleTracks: metadata.subtitleTracks,
      playUrl: session.playUrl,
      directRender,
      player: MpvControl,
    })
      .then(
        () => console.warn("playback.tracks.applied", JSON.stringify({ audioIdx: plan.audioIdx, subtitle: plan.subtitle, directRender })),
        (err) => console.warn("playback.tracks.apply_failed", JSON.stringify({ error: String(err) })),
      )
      .then(async () => {
        // "Play on TV" with tracks chosen on the phone: picked after the remembered ones, through the TV's own menus.
        const tracks = remoteStart?.tracks;
        const controls = controlsRef.current;
        if (!tracks || !controls) return;
        if (tracks.audioIdx !== null && tracks.audioIdx < metadata.audioTracks.length) await controls.selectAudio(tracks.audioIdx);
        if (tracks.subtitleIdx !== null && tracks.subtitleIdx < metadata.subtitleTracks.length) await controls.selectSubtitle(tracks.subtitleIdx);
        console.info("tv.cast.player.tracks", JSON.stringify(tracks));
      })
      .catch((err) => console.warn("tv.cast.player.tracks_failed", JSON.stringify({ error: String(err) })));
  }, [playing, snapshot, startTracks, session.metadata, session.playUrl, session.trackPrefs, remoteStart]);

  // --- Picture subtitles vs direct rendering (PLAY-TRACK-05) ----------------------------------------------------------
  // The TV's direct rendering falls back to `vo=gpu` once for good when hardware decoding didn't engage
  // (MpvDirectRender, on a PLAYBACK_RESTART). An OCR twin loaded for direct rendering is then swapped back to its
  // picture track, which the GPU path draws as the original pictures.
  const directRender = directRenderOf(snapshot);
  const lastDirectRender = useRef<boolean | null>(null);
  useEffect(() => {
    if (directRender === null) return;
    const was = lastDirectRender.current;
    lastDirectRender.current = directRender;
    const subtitleTracks = session.metadata?.subtitleTracks;
    const playUrl = session.playUrl;
    if (was !== true || directRender || !subtitleTracks || !playUrl) return;
    void (async () => {
      const active = findActiveSidecar(await MpvControl.getTrackList(), subtitleTracks);
      // What the start, a pick or a quality switch loaded for direct rendering: the twin, if this track has one.
      const swap = active !== null && loadsOcrTwin(active, true);
      console.info(
        "[mpv-subtitles] render_switch",
        JSON.stringify({ directRender, pickedId: active?.id ?? null, twinId: active?.ocrTwin?.id ?? null, swap }),
      );
      if (!active || !swap) return;
      await MpvControl.removeAllSubtitles();
      await MpvControl.addSubtitle(sidecarSubtitleUrl(playUrl, active, false, "render_switch"), active.language, active.label);
    })().catch((err) => console.warn("[mpv-subtitles] render_switch_failed", JSON.stringify({ error: String(err) })));
  }, [directRender, session.metadata, session.playUrl]);

  // Seek-bar preview pictures (MPV-PREV-01): one source per playback, so each sheet is fetched at most once and kept in
  // memory only; its decrypted bytes come through the playback proxy like a sidecar subtitle.
  const seekPreview = useMemo(() => {
    const playUrl = session.playUrl;
    if (!playUrl) return null;
    return createSeekPreviewSource({
      previews: session.previews,
      sheetUrl: (objectKey) => playbackObjectUrl(playUrl, objectKey),
      loadSheet: loadSheetDataUri,
    });
  }, [session.previews, session.playUrl]);

  const onAudioPick = useCallback(
    (track: AudioTrack) => void rememberAudioPick(setTrackPrefs, mediaId, track),
    [mediaId, setTrackPrefs],
  );
  const audioTracks = session.metadata?.audioTracks;
  const resolveAudioId = useCallback(
    (mpvTracks: readonly MpvTrack[], idx: number) => resolveMpvAudioId(mpvTracks, audioTracks ?? [], idx),
    [audioTracks],
  );
  const onSubtitlePick = useCallback(
    (track: SubtitleTrack | null) => void rememberSubtitlePick(setTrackPrefs, mediaId, track),
    [mediaId, setTrackPrefs],
  );

  // --- Diagnostics ---------------------------------------------------------------------------
  const loadStartedAt = useRef<number | null>(null);
  /** Start of the current uninterrupted loading stretch (PLAY-ABR-03: hint at 30 s, error at 60 s). */
  const loadingSince = useRef<number | null>(null);
  const [slowLoading, setSlowLoading] = useState(false);
  // The title's picture covers the screen from open until the first video frame (PLAY-OPEN-01); it never comes back after.
  const [firstFrameShown, setFirstFrameShown] = useState(false);
  useEffect(() => {
    if (snapshot?.voConfigured) setFirstFrameShown(true);
  }, [snapshot?.voConfigured]);
  const firstFrameAt = useRef<number | null>(null);
  /**
   * When playback first left loading, with or without a picture: an episode started from the lock screen plays its sound
   * with the picture off (PLAY-OSMEDIA-01), so its first frame only comes on unlock. From then on the first start is over
   * and a later loading stretch counts from its own start, not from the load (OnePlus 9 test phone, PR #1762: `startTimeout` at unlock).
   */
  const startedAt = useRef<number | null>(null);
  const seekPending = useRef<{ at: number; target: number } | null>(null);
  const switchPending = useRef<{ at: number; reason: string; target: string } | null>(null);
  const lastDropLog = useRef(0);
  useEffect(() => {
    if (playing && loadStartedAt.current === null) loadStartedAt.current = Date.now();
  }, [playing]);

  // --- Progress saving -----------------------------------------------------------------------
  const lastSavedPosition = useRef<number | null>(null);
  const lastSavedAt = useRef(0);
  const wasPlaying = useRef(false);
  /** The position of the last frame shown; null until one was. */
  const lastPlayedSeconds = useRef<number | null>(null);
  // Explicit one-shot state, never derived from render (see `lib/playback/progressSave.ts`).
  const progressGate = useRef(createProgressGate());

  const saveProgress = useCallback(
    (snap: PlaybackSnapshot | null, final: boolean, completed = false) => {
      const current = sessionRef.current;
      if (!snap || current.phase !== "ready") return;
      const gate = progressGate.current;
      const plan = planProgressSave(gate, {
        positionSeconds: snap.position,
        durationSeconds: snap.duration > 0 ? snap.duration : current.durationSeconds,
        lastSavedPositionSeconds: lastSavedPosition.current,
        final,
        completed,
        creditsStartSeconds: current.markers.find((marker) => marker.type === "credits")?.startSeconds ?? null,
      });
      if (!plan) return;
      commitProgressSave(gate, plan);
      lastSavedPosition.current = plan.positionSeconds;
      lastSavedAt.current = Date.now();
      void setPlaybackProgress(
        mediaId,
        current.episode?.id ?? null,
        plan.progressPct,
        { positionSeconds: plan.positionSeconds, durationSeconds: plan.durationSeconds },
        final,
      ).catch((err) => console.warn("playback.progress.save_failed", JSON.stringify({ error: String(err) })));
      console.warn(
        "playback.progress.save",
        JSON.stringify({
          pct: Number(plan.progressPct.toFixed(2)),
          position: Math.round(plan.positionSeconds),
          final,
          completed,
          episodeId: current.episode?.id ?? null,
        }),
      );
    },
    [mediaId, setPlaybackProgress],
  );
  const saveProgressRef = useRef(saveProgress);
  saveProgressRef.current = saveProgress;

  // Mount-once: background and exit saves read the latest closure through the ref so a library
  // callback identity change never runs the "exit" save mid-playback.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") saveProgressRef.current(latest.current, true);
    });
    return () => {
      sub.remove();
      // Exit: persist where we are.
      saveProgressRef.current(latest.current, true);
    };
  }, [latest]);

  // --- Quality switching ---------------------------------------------------------------------
  // The whole switch (position, tracks, retry, queueing) is `QualitySwitchMachine` (PLAY-ABR-04, PLAY-TRACK-03); this
  // screen only feeds it the native player and reacts to its events.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onSelectQualityRef = useRef<(picked: string | "auto") => void>(() => undefined);
  const switcherRef = useRef<QualitySwitchMachine | null>(null);
  if (switcherRef.current === null) {
    const warmRung = PlaybackBridge.warmRung();
    switcherRef.current = new QualitySwitchMachine(
      {
        // Fresh native reads: the polled snapshot is 0.5-1 s old and can predate the viewer's last track pick or seek.
        readPlayback: async () => {
          const [snapshot, tracks] = await Promise.all([MpvControl.getPlaybackSnapshot().catch(() => latest.current), MpvControl.getTrackList().catch(() => [])]);
          return snapshot ? { snapshot, tracks } : null;
        },
        readSnapshot: () => MpvControl.getPlaybackSnapshot().catch(() => latest.current),
        load: async (url, startSeconds, options) => {
          await MpvControl.loadAt(url, startSeconds, options);
        },
        seek: async (seconds) => {
          await MpvControl.seek(seconds, null);
        },
        // A sidecar that no longer loads (native rejects `subtitle_load_failed`) must not fail the quality switch.
        restoreSidecar: (url, sidecar) =>
          MpvControl.addSubtitle(url, sidecar.language, sidecar.label).then(
            () => console.warn("playback.quality.sidecar_restored", JSON.stringify({ id: sidecar.id })),
            (err) => console.warn("playback.quality.sidecar_restore_failed", JSON.stringify({ id: sidecar.id, error: String(err) })),
          ),
        sleep: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
        // Make before break (Android proxy): the old rung plays on while the new rung's segment is fetched.
        warm: warmRung
          ? async (targetId, atSeconds) => {
              await warmRung(targetId, atSeconds);
            }
          : undefined,
        now: Date.now,
        // The native view (and mpv core) is destroyed on unmount: never touch it afterwards.
        alive: () => mounted.current,
        log: (event, data) => console.warn(`playback.quality.${event}`, JSON.stringify(data)),
      },
      () => ({
        playUrl: sessionRef.current.playUrl,
        subtitleTracks: withFetchedSubtitles(
          sessionRef.current.metadata?.subtitleTracks ?? [],
          addedSubtitlesRef.current.fetched,
          addedSubtitlesRef.current.replaced,
        ),
        warmInputs: (targetId) => {
          const target = variantsRef.current.find((variant) => variant.id === targetId);
          return target ? { segments: target.segments ?? [], ewmaBps: abrRef.current?.ewmaBps ?? null } : null;
        },
      }),
      {
        onSettled: (result) => {
          if (abrRef.current) noteSwitchSettled(abrRef.current, Date.now());
          console.warn("playback.quality.switch", JSON.stringify({ reason: result.reason, target: result.targetId, ms: result.ms, positionBefore: Math.round(result.startSeconds), settled: result.settled, attempts: result.attempts }));
        },
        // A pick made while another switch ran: committed and applied now that the running one ended.
        onQueuedPick: (targetId) => onSelectQualityRef.current(targetId),
      },
    );
  }
  const switcher = switcherRef.current;

  // A seek not yet landed is a pending start: a quality pick made now reloads there, not at the stale polled position.
  const onSeekIssued = useCallback(
    (target: number) => {
      seekPending.current = { at: Date.now(), target };
      switcher.noteSeek(target);
      if (abrRef.current) noteSeek(abrRef.current, Date.now());
    },
    [switcher],
  );

  // The first load's resume position is a pending start until the first frame lands there.
  useEffect(() => {
    if (playing && start) switcher.armStart(start.seconds);
  }, [playing, start, switcher]);

  const switchVariant = useCallback(
    (targetId: string, reason: string) => {
      switchPending.current = { at: Date.now(), reason, target: targetId };
      void switcher.request(targetId, reason);
    },
    [switcher],
  );

  const onSelectQuality = useCallback(
    (picked: string | "auto") => {
      const state = qualityRef.current;
      if (!state) return;
      if (picked !== "auto" && picked !== state.currentId && switcher.switching) {
        // Committing the pick now would show a quality mpv is not playing: the machine applies it once the running
        // switch settles (the last pick wins).
        void switcher.request(picked, "manual");
        return;
      }
      // Auto, or the rung already playing/loading, is the last pick: it replaces a manual pick still queued.
      if (switcher.switching) switcher.cancelQueued();
      displacementRef.current = null;
      const next = selectQuality(state, picked, Date.now());
      if (abrRef.current) abrRef.current.quality = next;
      setQuality(next);
      if (picked !== "auto" && picked !== state.currentId) switchVariant(picked, "manual");
      else if (picked === "auto") console.warn("playback.quality.auto_selected");
    },
    [switchVariant, switcher],
  );
  onSelectQualityRef.current = onSelectQuality;

  // --- Per-snapshot logic: metrics, failure, skip markers, ABR, HEVC lag, EOF, saving ----------
  const autoSkipRef = useRef(createAutoSkipState());
  const eofHandled = useRef(false);
  const prevPaused = useRef<boolean | null>(null);

  /** Set when this player hands over to another episode: the "Play on TV" phone keeps its remote instead of seeing an end. */
  const handoverRef = useRef(false);
  const goToEpisode = useCallback((which: "next" | "previous") => {
    const target = which === "next" ? sessionRef.current.nextEpisode : sessionRef.current.previousEpisode;
    if (!target) return;
    console.info("playback.episode.switch", JSON.stringify({ which, episodeId: target.id }));
    // Next finishes the episode (like EOF); Previous leaves it where the viewer stopped.
    saveProgress(latest.current, true, which === "next");
    handoverRef.current = true;
    // `remoteStart` belongs to the title the phone started: another episode starts like any next episode. Pressed on
    // the lock screen or the notification, nobody can answer the resume prompt: the episode resumes (PLAY-OSMEDIA-01).
    const unattended = episodeSwitchStartAt(AppState.currentState);
    if (unattended) console.info("playback.episode.switch.unattended", JSON.stringify({ startAt: unattended, appState: AppState.currentState }));
    // Hidden, React Native drops this player at once and holds the next one: its core is kept for the next episode.
    void switchEpisodeKeepingCore(MpvControl, { appState: AppState.currentState, platformOs: Platform.OS, isTv: IS_TV }, () =>
      navigation.setParams({ mediaId, episodeId: target.id, remoteStart: null, ...(unattended ? { startAt: unattended } : {}) } as never),
    );
  }, [latest, mediaId, navigation, saveProgress]);
  const goToNextEpisode = useCallback(() => goToEpisode("next"), [goToEpisode]);

  // PLAY-OVL-04 (phone): the Cast button pauses here and saves the position, so the Cast device resumes where the phone
  // stopped; picking a device replaces the player with the Cast screen, closing the sheet plays on here.
  const [castPickerOpen, setCastPickerOpen] = useState(false);
  const openCastPicker = useCallback(() => {
    void MpvControl.setPaused(true).catch(() => undefined);
    saveProgress(latest.current, true);
    setCastPickerOpen(true);
  }, [latest, saveProgress]);
  const closeCastPicker = useCallback(() => {
    setCastPickerOpen(false);
    void MpvControl.setPaused(false).catch(() => undefined);
  }, []);

  // --- "Get more subtitles…" (PLAY-SUBGET-02, -24, phone and TV) ----------------------------------------------------
  // The subtitle menu's row after the tracks, also with no track at all, and the only one that searches online: the
  // subtitles button (and the TV remote's captions key) always opens the menu first (PLAY-SUBGET-24). A title without a
  // catalog id is searched by title first (`subtitleFetchNeedsTitle`). Picking it pauses and shows the search over
  // the video; closing resumes, with the stored subtitle added to this playback's menu and switched on like a pick in the
  // menu (the controls' handle, so the pick is remembered, PLAY-SUBGET-19). Unavailable offline (PLAY-SUBGET-12) and while
  // a download on disk plays: the offline proxy can't load a subtitle stored in the vault after the download.
  const online = useNetworkOnline();
  const [subtitleFetchOpen, setSubtitleFetchOpen] = useState(false);
  const [switchOnSubtitleId, setSwitchOnSubtitleId] = useState<string | null>(null);
  const menuSubtitleTracks = useMemo(
    () => withFetchedSubtitles(session.metadata?.subtitleTracks ?? [], addedSubtitles.fetched, addedSubtitles.replaced),
    [session.metadata?.subtitleTracks, addedSubtitles],
  );
  const playsFromDownload = session.offline;
  const canSearchSubtitlesById = session.details !== null && subtitleFetchTarget(session.details, session.episode?.id ?? null) !== null;
  const canGetMoreSubtitles =
    canSearchSubtitlesById || (session.details !== null && subtitleFetchNeedsTitle(session.details, session.episode?.id ?? null) !== null);
  const openSubtitleFetch = useCallback(() => {
    console.info("subtitle_fetch.player.pause", JSON.stringify({ mediaId, episodeId: sessionRef.current.episode?.id ?? null }));
    void MpvControl.setPaused(true).catch(() => undefined);
    setSubtitleFetchOpen(true);
  }, [mediaId]);
  // A stored subtitle (fetched or added from a file) goes into this playback's menu and is switched on like a pick in
  // the menu; null resumes as it was.
  const switchOnAddedSubtitle = useCallback((added: FetchedSubtitleTrack | null) => {
    if (!added) {
      void MpvControl.setPaused(false).catch(() => undefined);
      return;
    }
    setAddedSubtitles((prev) => ({ ...prev, fetched: [...prev.fetched, fetchedSubtitleToPlayerTrack(added)] }));
    setSwitchOnSubtitleId(added.id);
  }, []);
  const closeSubtitleFetch = useCallback(
    (added: FetchedSubtitleTrack | null) => {
      setSubtitleFetchOpen(false);
      console.info("subtitle_fetch.player.close", JSON.stringify({ addedId: added?.id ?? null }));
      switchOnAddedSubtitle(added);
    },
    [switchOnAddedSubtitle],
  );
  useEffect(() => {
    if (!switchOnSubtitleId) return;
    const idx = menuSubtitleTracks.findIndex((track) => track.id === switchOnSubtitleId);
    const controls = controlsRef.current;
    if (idx < 0 || !controls) return;
    setSwitchOnSubtitleId(null);
    void controls
      .selectSubtitle(idx, { reload: true })
      .catch((err: unknown) => console.warn("subtitle_fetch.player.switch_on_failed", JSON.stringify({ error: String(err) })))
      .finally(() => {
        console.info("subtitle_fetch.player.resume", JSON.stringify({ idx, id: switchOnSubtitleId }));
        void MpvControl.setPaused(false).catch(() => undefined);
      });
  }, [menuSubtitleTracks, switchOnSubtitleId]);
  const subtitleUnavailableReason = useMemo(() => {
    const copy = subtitleFetchCopy(getCurrentLanguage());
    return !online ? copy.offline : playsFromDownload ? copy.fromDownload : null;
  }, [online, playsFromDownload]);
  const getMoreSubtitles = useMemo(() => {
    if (!canGetMoreSubtitles) return null;
    return { title: subtitleFetchCopy(getCurrentLanguage()).getMore, unavailableReason: subtitleUnavailableReason, onPress: openSubtitleFetch };
  }, [canGetMoreSubtitles, subtitleUnavailableReason, openSubtitleFetch]);

  // --- "Add a subtitle file…" (PLAY-SUBGET-23, phone only) ----------------------------------------------------------
  // After "Get more subtitles…": pauses, opens the system's file picker and stores the file in the vault like a
  // fetched subtitle, then switches it on at once and resumes. Storing needs the vault, so it is unavailable offline
  // and while a download plays, with the same reason as "Get more" (PLAY-SUBGET-12). Never on TV.
  const [subtitleFileOpen, setSubtitleFileOpen] = useState(false);
  const openSubtitleFile = useCallback(() => {
    console.info("subtitle_file.player.pause", JSON.stringify({ mediaId, episodeId: sessionRef.current.episode?.id ?? null }));
    void MpvControl.setPaused(true).catch(() => undefined);
    setSubtitleFileOpen(true);
  }, [mediaId]);
  const closeSubtitleFile = useCallback(
    (added: FetchedSubtitleTrack | null) => {
      setSubtitleFileOpen(false);
      console.info("subtitle_file.player.close", JSON.stringify({ addedId: added?.id ?? null }));
      switchOnAddedSubtitle(added);
    },
    [switchOnAddedSubtitle],
  );
  const addSubtitleFile = useMemo(() => {
    if (IS_TV || session.details === null) return null;
    return { title: subtitleFetchCopy(getCurrentLanguage()).addFile, unavailableReason: subtitleUnavailableReason, onPress: openSubtitleFile };
  }, [session.details, subtitleUnavailableReason, openSubtitleFile]);

  // --- "Try another version" (PLAY-SUBGET-07, phone and TV) ---------------------------------------------------------
  // In the subtitle menu after "Get more subtitles…" while the subtitle on is a fetched one. Picking it pauses and shows
  // the steps over the video; the new version takes the old one's row and is switched on, then playback resumes. Back,
  // or any outcome but "replaced", leaves the subtitle as it was and resumes.
  const [versionTrack, setVersionTrack] = useState<LibraryFetchedSubtitleTrack | null>(null);
  const openSubtitleVersion = useCallback(
    (track: SubtitleTrack) => {
      console.info(
        "subtitle_version.player.pause",
        JSON.stringify({ mediaId, episodeId: sessionRef.current.episode?.id ?? null, trackId: track.id, source: track.source ?? null }),
      );
      if (!track.source) return;
      void MpvControl.setPaused(true).catch(() => undefined);
      setVersionTrack({ id: track.id, language: track.language, label: track.label, source: track.source });
    },
    [mediaId],
  );
  const closeSubtitleVersion = useCallback(
    (replacement: FetchedSubtitleTrack | null) => {
      const old = versionTrack;
      setVersionTrack(null);
      console.info("subtitle_version.player.close", JSON.stringify({ oldId: old?.id ?? null, newId: replacement?.id ?? null }));
      if (!replacement || !old) {
        void MpvControl.setPaused(false).catch(() => undefined);
        return;
      }
      setAddedSubtitles((prev) => replacePlayerSubtitle(prev, old.id, fetchedSubtitleToPlayerTrack(replacement)));
      setSwitchOnSubtitleId(replacement.id);
    },
    [versionTrack],
  );
  const tryAnotherSubtitle = useMemo(() => {
    if (!canSearchSubtitlesById) return null;
    return {
      title: subtitleFetchCopy(getCurrentLanguage()).tryAnother,
      isFetched: (track: SubtitleTrack) => isFetchedSubtitleSource(track.source),
      unavailableReason: subtitleUnavailableReason,
      onPress: openSubtitleVersion,
    };
  }, [canSearchSubtitlesById, subtitleUnavailableReason, openSubtitleVersion]);
  const castTo = useCallback(
    (target: CastTarget) => {
      console.info("playback.cast.handover", JSON.stringify({ mediaId, episodeId: sessionRef.current.episode?.id ?? episodeId }));
      navigation.dispatch(StackActions.replace("Cast", { mediaId, episodeId: sessionRef.current.episode?.id ?? episodeId, target }));
    },
    [episodeId, mediaId, navigation],
  );
  const goToPreviousEpisode = useCallback(() => goToEpisode("previous"), [goToEpisode]);

  // --- Operating system media controls (PLAY-OSMEDIA-01, phone only: the TV app's remote keys reach the player) ----
  // The notification-shade and lock-screen card and the headset buttons drive this player while the app is in the
  // background; the card shows the decrypted poster once it is on the device.
  const osPosterUrl = useMediaImage(IS_TV ? null : artwork.posterPath ?? session.details?.posterPath ?? null, "poster");
  const osMediaState = useMemo(
    () =>
      localPlaybackMediaState({
        ready: playing,
        snapshot,
        details: session.details,
        episode: session.episode,
        posterUrl: osPosterUrl,
        fallbackDurationSeconds: session.durationSeconds,
        hasNextEpisode: session.nextEpisode !== null,
        hasPreviousEpisode: session.previousEpisode !== null,
      }),
    [playing, snapshot, session.details, session.episode, osPosterUrl, session.durationSeconds, session.nextEpisode, session.previousEpisode],
  );
  useOsMediaSession(
    osMediaState,
    {
      play: () => void MpvControl.setPaused(false).catch(() => undefined),
      pause: () => void MpvControl.setPaused(true).catch(() => undefined),
      stop: handleBackPress,
      next: goToNextEpisode,
      previous: goToPreviousEpisode,
      seekTo: (seconds) => {
        onSeekIssued(seconds);
        void MpvControl.seek(seconds, "absolute").catch(() => undefined);
      },
    },
    !IS_TV,
  );

  // --- "Play on TV" (UX-TV-02, TV only) ------------------------------------------------------
  // The phone's commands reach this player through the link; its state goes back about once a second while a phone drives it.
  const remoteRef = useRef<RemotePlayer | null>(null);
  remoteRef.current = {
    apply: (command) =>
      applyRemoteCommand(command, {
        controls: controlsRef.current,
        player: MpvControl,
        audioTrackCount: sessionRef.current.metadata?.audioTracks.length ?? 0,
        subtitleTrackCount: sessionRef.current.metadata?.subtitleTracks.length ?? 0,
        close: handleBackPress,
      }),
    state: () => {
      const current = sessionRef.current;
      const episodeLabel = formatEpisodeLabel(current.episode);
      return buildTvState({
        mediaId,
        episodeId: current.episode?.id ?? episodeId,
        title: [current.details?.title, episodeLabel].filter(Boolean).join(" · ") || null,
        failed: current.phase === "error" || failureRef.current !== null,
        snapshot: latest.current,
        fallbackDurationSeconds: current.durationSeconds,
        audioTracks: current.metadata?.audioTracks ?? [],
        subtitleTracks: current.metadata?.subtitleTracks ?? [],
        trackState: controlsRef.current?.trackState() ?? null,
      });
    },
  };
  useEffect(() => {
    if (!IS_TV) return;
    const detach = attachRemotePlayer({
      apply: (command) => remoteRef.current?.apply(command) ?? Promise.resolve("not_ready"),
      state: () => remoteRef.current!.state(),
    });
    const tick = setInterval(() => {
      if (remoteStateWanted() && remoteRef.current) publishRemoteState(remoteRef.current.state());
    }, 1_000);
    return () => {
      clearInterval(tick);
      detach(handoverRef.current);
    };
  }, []);

  /** "Keep watching" on the device-too-weak notice (its button, or Back on TV): the notice closes, playback carries on. */
  const keepWatchingTooWeak = useCallback(() => {
    console.warn("playback.device.too_weak.dismissed", JSON.stringify({ position: Math.round(latest.current?.position ?? 0) }));
    setTooWeak(null);
  }, []);

  /**
   * Back on a prompt that keeps the video going (TV): the pill is hidden for this marker and never auto-fires; the card
   * closes; a notice closes like its "Keep watching" button, the traffic-cap one first since it is drawn on top.
   */
  const dismissPrompt = useCallback(
    (prompt: "pill" | "next-card" | "notice") => {
      console.info("tv.player.prompt.dismissed", JSON.stringify({ prompt, key: pill?.key ?? null, capNotice: capNotice !== null, tooWeak: tooWeak !== null }));
      if (prompt === "next-card") {
        setNextCard(null);
        return;
      }
      if (prompt === "notice") {
        if (capNotice) setCapNotice(null);
        else keepWatchingTooWeak();
        return;
      }
      if (!pill) return;
      suppressAutoSkip(autoSkipRef.current, pill.key);
      setDismissedPillKey(pill.key);
    },
    [pill, capNotice, tooWeak, keepWatchingTooWeak],
  );
  const pillDismissed = pill !== null && pill.key === dismissedPillKey;

  const performPill = useCallback(
    (action: PillAction) => {
      suppressAutoSkip(autoSkipRef.current, action.key);
      if (action.kind === "next_episode") {
        goToNextEpisode();
        return;
      }
      if (action.seekToSeconds !== null) {
        onSeekIssued(action.seekToSeconds);
        void MpvControl.seek(action.seekToSeconds, null).catch(() => undefined);
      }
    },
    [goToNextEpisode, onSeekIssued],
  );
  const performPillRef = useRef(performPill);
  performPillRef.current = performPill;

  const fetchTraffic = session.fetchTraffic;

  // Pauses through the failure effect below, with no automatic resume: the viewer presses Retry once the silo lifted.
  const stopForSilo = useCallback((code: SiloUnavailableCode) => {
    console.warn("playback.silo.unavailable", JSON.stringify({ code }));
    failureRef.current = code;
    setFailure(code);
  }, []);

  // One entry for what the silo said: a native event (the gateway's real 503 / `session.ack`, STOR-BW-07, STOR-BW-08) or the fallback poll.
  const onSiloEvent = useCallback(
    (event: SiloTrafficEvent, fromNative: boolean) => {
      if (!mounted.current) return;
      const now = Date.now();
      if (fromNative) lastNativeReportAt.current = now;
      const next = applySiloTrafficEvent(trafficRef.current, event);
      console.warn(
        "playback.traffic.event",
        JSON.stringify({ fromNative, kind: event.kind, unavailable: next.unavailable, saturated: next.traffic?.saturated ?? null, cap: next.traffic?.qualityCap ?? null }),
      );
      trafficRef.current = next.traffic;
      setTraffic(next.traffic);
      if (next.unavailable && failureRef.current !== next.unavailable) stopForSilo(next.unavailable);
    },
    [mounted, stopForSilo],
  );
  const onSiloEventRef = useRef(onSiloEvent);
  onSiloEventRef.current = onSiloEvent;

  // The native proxy forwards the gateway's traffic answers from the first tunnel session on; listen from the moment it runs.
  const proxyReady = session.phase === "ready";
  useEffect(() => {
    if (!proxyReady) return;
    return PlaybackBridge.onTraffic((raw) => {
      const event = parseSiloTrafficEvent(raw);
      if (event) onSiloEventRef.current(event, true);
    });
  }, [proxyReady]);

  // Fallback only: the proxy reports every few seconds while it fetches, so the poll runs when it was silent for a whole interval.
  useEffect(() => {
    if (!playing || !fetchTraffic) return;
    let cancelled = false;
    const poll = () => {
      if (!trafficPollDue(lastNativeReportAt.current, Date.now())) return;
      void fetchTraffic().then((next) => {
        if (!cancelled && next) onSiloEventRef.current({ kind: "report", traffic: next }, false);
      });
    };
    poll();
    const id = setInterval(poll, TRAFFIC_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchTraffic, playing]);

  // A failure on screen stops playback: mpv pauses behind the error and no quality switch (running, retrying or queued)
  // reloads the player until the viewer presses Retry.
  useEffect(() => {
    if (!failure) return;
    switcher.cancel();
    void MpvControl.setPaused(true).catch(() => undefined);
  }, [failure, switcher]);

  // High traffic (STOR-BW-01): keep only the silo's playback buffer ahead; the cap is lifted when the state clears or the player closes.
  const bufferCap = playbackBufferCap(traffic);
  // The previous player lifted its cap on close, so only a change is sent (no 0 on mount).
  const sentBufferCap = useRef(0);
  useEffect(() => {
    if (bufferCap === sentBufferCap.current) return;
    sentBufferCap.current = bufferCap;
    console.info("playback.traffic.buffer_cap", JSON.stringify({ seconds: bufferCap }));
    void PlaybackBridge.setBufferCap(bufferCap).catch(() => undefined);
  }, [bufferCap]);
  useEffect(() => () => void PlaybackBridge.setBufferCap(0).catch(() => undefined), []);

  // The cap lifted: Auto climbs by itself (its ceiling is back), a pinned rung the cap took the player off comes back. Never while
  // the player is stopped or failed: Retry starts over.
  const failed = failure !== null;
  useEffect(() => {
    if (activeCap !== null) return;
    if (capNoticeShown.current) {
      capNoticeShown.current = false;
      setCapNotice(null);
    }
    const ctrl = abrRef.current;
    if (!ctrl) return;
    const release = planCapRelease(variants, ctrl.quality, displacementRef.current, activeCap, failed);
    displacementRef.current = release.displaced;
    if (release.restoreTo) {
      console.warn("playback.quality.cap_lifted", JSON.stringify({ from: ctrl.quality.currentId, restoreTo: release.restoreTo }));
      onSelectQualityRef.current(release.restoreTo);
    }
  }, [activeCap, failed, variants]);
  // A failed open may be the gateway's 402 `subscription_unpaid`: re-read the account so a stale `access` is corrected.
  const openFailed = failure !== null || session.error !== null;
  useEffect(() => {
    if (openFailed) void refreshAccount();
  }, [openFailed, refreshAccount]);

  useEffect(() => {
    if (!snapshot || !playing) return;
    const now = Date.now();
    const current = sessionRef.current;

    // Time to first frame.
    if (firstFrameAt.current === null && snapshot.voConfigured && loadStartedAt.current !== null) {
      firstFrameAt.current = now;
      console.warn(
        "playback.metrics.first_frame_ms",
        JSON.stringify({ ms: now - loadStartedAt.current, vid: snapshot.vid, codec: snapshot.videoCodec, hwdec: snapshot.hwdec, vo: snapshot.currentVo, w: snapshot.videoWidth, h: snapshot.videoHeight }),
      );
    }
    // Seek latency (resolution = poll interval).
    if (seekPending.current && !snapshot.seeking && !snapshot.pausedForCache && now - seekPending.current.at > 150) {
      if (Math.abs(snapshot.position - seekPending.current.target) < 3) {
        console.warn("playback.metrics.seek_ms", JSON.stringify({ ms: now - seekPending.current.at, target: Math.round(seekPending.current.target) }));
        seekPending.current = null;
      } else if (now - seekPending.current.at > 15_000) {
        seekPending.current = null;
      }
    }
    // Track-switch latency (first stable frame after the switch).
    if (switchPending.current && !switcher.switching && !snapshot.seeking && !snapshot.pausedForCache) {
      console.warn("playback.metrics.switch_ms", JSON.stringify({ ms: now - switchPending.current.at, reason: switchPending.current.reason, target: switchPending.current.target }));
      switchPending.current = null;
    }
    // Dropped frames, every ~10 s.
    if (now - lastDropLog.current > 10_000 && snapshot.voConfigured && !snapshot.paused) {
      lastDropLog.current = now;
      console.warn(
        "playback.metrics.drops",
        JSON.stringify({ vo: snapshot.frameDrops, decoder: snapshot.decoderFrameDrops, position: Math.round(snapshot.position), hwdec: snapshot.hwdec }),
      );
    }

    switcher.observe(snapshot, now);

    // Stuck loading (first start, rebuffer, seek or quality switch): hint at 30 s, error at 60 s. Never changes quality.
    loadingSince.current = trackLoading(loadingSince.current, {
      snapshot,
      nowMs: now,
      floorMs: firstFrameAt.current === null && startedAt.current === null ? loadStartedAt.current : null,
      switching: switcher.switching,
    });
    if (startedAt.current === null && loadingSince.current === null && loadStartedAt.current !== null) startedAt.current = now;
    const stuckLoadingMs = loadingSince.current === null ? 0 : now - loadingSince.current;
    setSlowLoading(shouldShowLoadingHint(stuckLoadingMs));

    // Failure detection. `failing` covers a failure raised on this very pass (the `failure` state only updates next render).
    let failing = failure !== null;
    const reason = detectPlaybackFailure({
      snapshot,
      msSinceLoad: loadStartedAt.current === null ? 0 : now - loadStartedAt.current,
      firstFrameSeen: firstFrameAt.current !== null,
      stuckLoadingMs,
      switching: switcher.switching,
    });
    if (reason && !failing) {
      failing = true;
      console.warn("playback.failure", JSON.stringify({ reason }));
      setFailure(reason);
      // No native event explained it: ask the silo once. A stop it reports is its own flag, never a guess from the failure.
      void current.fetchTraffic?.().then((next) => {
        if (next) onSiloEventRef.current({ kind: "report", traffic: next }, false);
      });
    }

    const settings = getAppSettings();
    const duration = snapshot.duration > 0 ? snapshot.duration : current.durationSeconds;

    // Skip markers / next-episode pill (+ 5 s auto-skip).
    const config: PillConfig = {
      markers: current.markers,
      hasNextEpisode: current.nextEpisode !== null,
      autoplayNextEpisode: settings.autoplayNextEpisode,
      autoSkipIntro: settings.autoSkipIntro,
      autoSkipCredits: settings.autoSkipCredits,
    };
    if (snapshot.voConfigured && !snapshot.eof) {
      const step = stepAutoSkip(autoSkipRef.current, { timePos: snapshot.position, duration, paused: snapshot.paused }, config);
      setPill((prev) =>
        prev?.key === step.action?.key && prev?.kind === step.action?.kind && prev?.countdown === step.action?.countdown && prev?.labelKey === step.action?.labelKey
          ? prev
          : step.action,
      );
      if (step.fire && step.action) {
        console.warn("playback.skip.auto", JSON.stringify({ kind: step.action.kind, key: step.action.key }));
        performPillRef.current(step.action);
      }
    }

    // Progress: periodic while playing, immediate on a pause edge.
    const isPlayingNow = snapshot.voConfigured && !snapshot.paused && !snapshot.eof;
    if (prevPaused.current === false && snapshot.paused) saveProgress(snapshot, true);
    else if (isPlayingNow && now - lastSavedAt.current >= SAVE_INTERVAL_MS) saveProgress(snapshot, false);
    prevPaused.current = snapshot.paused;
    // PLAY-AWAKE-01: every time playback starts or resumes, the device is told again to stay awake, so nothing that reset
    // it meanwhile (a trip through the background, another screen) lets the TV sleep in the middle of a film.
    if (isPlayingNow && !wasPlaying.current) {
      console.info("playback.keep_awake", JSON.stringify({ position: Math.round(snapshot.position) }));
      void MpvControl.setKeepScreenOn(true).catch(() => undefined);
    }
    wasPlaying.current = isPlayingNow;
    // Where Retry resumes (PLAY-RESUME-07): the last position a frame was shown at. A load that failed leaves mpv idle
    // at 0:00 with no frame, so the position it reports then is never taken.
    if (snapshot.voConfigured && !snapshot.idle && snapshot.position > 0) lastPlayedSeconds.current = snapshot.position;

    // Auto quality: decoder-bound check first, then network ABR (`stepAbr` from @space/playback-abr).
    const ctrl = abrRef.current;
    // PLAY-QUAL-07: while the silo is saturated Auto may not climb above the cap, and a playing rung above it steps
    // down to the best rung at or under it. A free viewer with no rung at or under 480p stops (STOR-BW-07).
    const cap = capRef.current;
    let capSwitched = false;
    if (ctrl) ctrl.settingsCeilingRank = cap ? capCeilingRank(baseCeilingRank.current, cap) : baseCeilingRank.current;
    if (ctrl && cap && ctrl.quality.currentId && !failing && !switcher.switching && snapshot.voConfigured) {
      const step = planCapStep(variants, ctrl.quality.currentId, cap);
      if (step.limited && !capNoticeShown.current) {
        capNoticeShown.current = true;
        setCapNotice(cap);
      }
      if (step.target?.kind === "stop") {
        failing = true;
        stopForSilo("playbackStopped");
      } else if (step.target?.kind === "switch") {
        console.warn("playback.quality.cap", JSON.stringify({ cap, from: ctrl.quality.currentId, target: step.target.id }));
        displacementRef.current = noteCapSwitch(displacementRef.current, ctrl.quality.currentId, step.target.id);
        ctrl.quality = { ...ctrl.quality, currentId: step.target.id, lastSwitchAtMs: now, lastReason: "abr-downshift" };
        setQuality(ctrl.quality);
        void switchVariant(step.target.id, "quality-cap");
        capSwitched = true;
      }
    }
    if (ctrl && !capSwitched && !failing && !switcher.switching && snapshot.voConfigured) {
      const action = stepAbr(ctrl, variants, {
        nowMs: now,
        sampledAtMs: snapshot.sampledAtMs,
        voConfigured: snapshot.voConfigured,
        position: snapshot.position,
        paused: snapshot.paused,
        pausedForCache: snapshot.pausedForCache,
        seeking: snapshot.seeking,
        bufferSeconds: snapshot.cacheDuration,
        cacheReachedEof: cacheReachedEnd(duration, snapshot.cacheEnd),
        netBps: snapshot.netBps,
        droppedFrames: snapshot.frameDrops + snapshot.decoderFrameDrops,
        hwdec: snapshot.hwdec,
        videoCodec: snapshot.videoCodec,
        avsyncSeconds: snapshot.avsync,
        cache:
          snapshot.cacheSecs > 0 && snapshot.demuxerMaxBytes > 0
            ? { cacheSecs: snapshot.cacheSecs, demuxerMaxBytes: snapshot.demuxerMaxBytes }
            : MOBILE_DEFAULT_CACHE_CONFIG,
      });
      if (action.kind === "too-weak") {
        console.warn(
          "playback.device.too_weak",
          JSON.stringify({
            reason: action.verdict.reason,
            mode: ctrl.quality.mode,
            pinned: action.pinned,
            currentId: ctrl.quality.currentId,
            hwdec: snapshot.hwdec,
            codec: snapshot.videoCodec,
            drops: snapshot.frameDrops + snapshot.decoderFrameDrops,
            bufferS: Number(snapshot.cacheDuration.toFixed(1)),
          }),
        );
        setTooWeak({ pinned: action.pinned });
      } else if (action.kind === "switch") {
        const evidence = {
          trigger: action.trigger,
          reason: action.reason,
          target: action.targetId,
          detail: action.detail,
          netMbps: Number((snapshot.netBps / 1e6).toFixed(2)),
          ewmaMbps: Number((ctrl.ewmaBps / 1e6).toFixed(2)),
          bufferS: Number(snapshot.cacheDuration.toFixed(1)),
          holdMs: ctrl.upshiftHoldMs,
          hwdec: snapshot.hwdec,
          vo: snapshot.currentVo,
        };
        console.warn(action.trigger === "decoder" ? "playback.hevc.lag" : "playback.abr.decision", JSON.stringify(evidence));
        setQuality(ctrl.quality);
        void switchVariant(action.targetId, action.reason);
      }
    }

    // End of file.
    if (snapshot.eof && firstFrameAt.current !== null && !eofHandled.current) {
      eofHandled.current = true;
      console.warn("playback.eof", JSON.stringify({ position: Math.round(snapshot.position), hasNext: current.nextEpisode !== null }));
      saveProgress(snapshot, true, true);
      if (current.nextEpisode) {
        setNextCard({ countdown: settings.autoplayNextEpisode ? NEXT_EPISODE_COUNTDOWN_S : null });
      } else {
        handleBackPress();
      }
    }
  }, [failure, handleBackPress, playing, saveProgress, snapshot, stopForSilo, switchVariant, switcher, variants]);

  // Next-episode card countdown (wall clock, 1 Hz).
  const cardCounting = nextCard !== null && nextCard.countdown !== null;
  useEffect(() => {
    if (!cardCounting) return;
    const id = setInterval(() => {
      setNextCard((prev) => (prev && prev.countdown !== null ? { countdown: Math.max(0, prev.countdown - 1) } : prev));
    }, 1000);
    return () => clearInterval(id);
  }, [cardCounting]);
  useEffect(() => {
    if (nextCard?.countdown === 0) goToNextEpisode();
  }, [goToNextEpisode, nextCard]);

  const handleRetry = useCallback(() => {
    // The reload replaces the player: a switch still running would load its rung into the new one.
    switcher.cancel();
    setFailure(null);
    setTraffic(null);
    setCapNotice(null);
    capNoticeShown.current = false;
    displacementRef.current = null;
    firstFrameAt.current = null;
    loadStartedAt.current = null;
    loadingSince.current = null;
    if (abrRef.current) noteLoadStarted(abrRef.current, Date.now());
    eofHandled.current = false;
    // Retry resumes where playback stopped (PLAY-RESUME-07), not where this session first started.
    const pos = lastPlayedSeconds.current ?? 0;
    console.warn("playback.retry", JSON.stringify({ lastPlayedSeconds: pos, reported: latest.current?.position ?? null }));
    setStart((prev) => ({ seconds: pos > 5 ? pos : prev?.seconds ?? 0, startOver: false }));
    session.reload();
  }, [latest, session, switcher]);

  const backdropPath = artwork.backdropPath ?? session.details?.backdropPath ?? null;
  const posterPath = artwork.posterPath ?? session.details?.posterPath ?? null;
  if (session.phase === "error") {
    return (
      <View style={styles.playerWrap}>
        <PlayerError message={failureText(session.error ?? "unavailable")} onRetry={handleRetry} onClose={handleBackPress} />
      </View>
    );
  }
  if (session.phase !== "ready" || !session.playUrl || !session.metadata) {
    return (
      <View style={styles.playerWrap} testID="player-root">
        <PlayerLoadingBackdrop backdropPath={backdropPath} posterPath={posterPath}>
          <PlayerSpinner launching />
        </PlayerLoadingBackdrop>
      </View>
    );
  }
  if (!playing) {
    return (
      <View style={styles.playerWrap} testID="player-root">
        <PlayerLoadingBackdrop backdropPath={backdropPath} posterPath={posterPath}>
          {needsPrompt && start === null && session.resumeCandidateSeconds !== null ? (
            <ResumePrompt
              title={formatEpisodeLabel(session.episode) ?? session.details?.title ?? ""}
              seconds={session.resumeCandidateSeconds}
              onResume={() => setStart({ seconds: session.resumeCandidateSeconds ?? 0, startOver: false })}
              onStartOver={() => {
                armStartOver(progressGate.current);
                setStart({ seconds: 0, startOver: true });
              }}
            />
          ) : (
            <PlayerSpinner launching />
          )}
        </PlayerLoadingBackdrop>
      </View>
    );
  }

  return (
    <View style={styles.playerWrap} testID="player-root">
      <MpvPlayer
        source={startSource ?? session.playUrl}
        startOptions={startOptions}
        style={styles.player}
        controlsInset={IS_TV && controlsVisible ? controlsInset : 0}
        uiScale={controlsScale}
      />
      {firstFrameShown ? null : <PlayerLoadingBackdrop backdropPath={backdropPath} posterPath={posterPath} />}
      {IS_TV ? (
        <TvPlayerRemote
          controlsRef={controlsRef}
          context={{
            overlayVisible: controlsVisible,
            sheetOpen,
            // The subtitle panels hold the D-pad (native focus on their rows) like a prompt; their own Back runs first.
            promptOpen: Boolean(tooWeak || capNotice || nextCard || failure || subtitleFetchOpen || versionTrack),
            nextCardOpen: nextCard !== null && !failure,
            noticeOpen: Boolean(tooWeak || capNotice) && !nextCard && !failure,
            pillVisible: pill !== null && !nextCard && !pillDismissed && !sheetOpen,
            progressFocused: progressFocused && controlsVisible,
          }}
          onDismissPrompt={dismissPrompt}
          onLeave={handleBackPress}
        />
      ) : null}
      <PlayerControls
        tv={IS_TV}
        theme={CONTROLS_THEME}
        handleRef={controlsRef}
        seekPreview={seekPreview}
        onSheetOpenChange={IS_TV ? setSheetOpen : undefined}
        labels={controlLabels}
        hlsUrl={session.playUrl}
        fullDuration={session.durationSeconds}
        videos={session.metadata.videos}
        audioTracks={session.metadata.audioTracks}
        subtitleTracks={menuSubtitleTracks}
        chapters={session.metadata.chapters}
        initialAudioIdx={shownStartTracks?.audioIdx ?? 0}
        initialSubtitleIdx={shownStartTracks?.subtitle.mode === "track" ? shownStartTracks.subtitle.idx : -1}
        onAudioPick={onAudioPick}
        resolveAudioId={resolveAudioId}
        onSubtitlePick={onSubtitlePick}
        getMoreSubtitles={getMoreSubtitles}
        tryAnotherSubtitle={tryAnotherSubtitle}
        addSubtitleFile={addSubtitleFile}
        snapshot={snapshot}
        qualityMode={quality?.mode ?? "auto"}
        activeVideoId={quality?.currentId ?? null}
        onSelectQuality={onSelectQuality}
        onSeekIssued={onSeekIssued}
        title={formatNowPlaying(session.details, session.episode)}
        onCastPress={IS_TV || !googleCastAvailable ? undefined : openCastPicker}
        onPreviousEpisode={session.previousEpisode ? goToPreviousEpisode : undefined}
        onNextEpisode={session.nextEpisode ? goToNextEpisode : undefined}
        onProgressFocusChange={IS_TV ? setProgressFocused : undefined}
        onVisibilityChange={setControlsVisible}
        onControlsBottomInset={IS_TV ? setControlsInset : undefined}
        uiScale={controlsScale}
        onBackPress={handleBackPress}
      />
      {shouldShowSpinner(snapshot) && !failure ? <PlayerSpinner slow={slowLoading} launching={!firstFrameShown} /> : null}
      {tooWeak ? <DeviceTooWeakNotice pinned={tooWeak.pinned} onKeepWatching={keepWatchingTooWeak} /> : null}
      {capNotice ? <TrafficCapNotice quality={capNotice} onKeepWatching={() => setCapNotice(null)} /> : null}
      {pill && !nextCard && !pillDismissed && !(IS_TV && sheetOpen) ? <SkipPill action={pill} onPress={() => performPill(pill)} /> : null}
      {nextCard && session.nextEpisode ? (
        <NextEpisodeCard
          label={formatEpisodeLabel(session.nextEpisode) ?? t("player.skip.nextEpisode")}
          countdown={nextCard.countdown}
          onPlayNow={goToNextEpisode}
          onCancel={() => setNextCard(null)}
        />
      ) : null}
      {failure ? <PlayerError message={failureText(failure)} onRetry={handleRetry} onClose={handleBackPress} /> : null}
      {!IS_TV && castPickerOpen ? <PlayerCastPicker onClose={closeCastPicker} onTarget={castTo} /> : null}
      {subtitleFetchOpen ? (
        <PlayerSubtitleFetch mediaId={mediaId} episodeId={session.episode?.id ?? null} onClose={closeSubtitleFetch} />
      ) : null}
      {versionTrack ? (
        <PlayerSubtitleVersion
          mediaId={mediaId}
          episodeId={session.episode?.id ?? null}
          track={versionTrack}
          onClose={closeSubtitleVersion}
        />
      ) : null}
      {subtitleFileOpen ? (
        <PlayerSubtitleFile mediaId={mediaId} episodeId={session.episode?.id ?? null} onClose={closeSubtitleFile} />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  playerWrap: {
    flex: 1,
    backgroundColor: "#000",
  },
  player: {
    // Stretch to parent via absolute-fill so the PlayerControls overlay
    // (also absoluteFill) inherits the same full-screen sizing. The previous
    // { width: '100%', height: '100%' } pattern collapsed under RN 0.85 +
    // Fabric — percentage heights inside flex containers don't reliably
    // resolve to the parent's computed flex:1 height, which left both
    // MpvPlayer and the controls overlay sized to a ~180px content band.
    ...StyleSheet.absoluteFill,
  },
});
