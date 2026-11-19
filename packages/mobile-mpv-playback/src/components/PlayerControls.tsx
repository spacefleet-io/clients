import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
  ScrollView,
  type ScrollViewInstance,
  PanResponder,
  Dimensions,
  useWindowDimensions,
  BackHandler,
  TVFocusGuideView,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewInstance,
} from "react-native";
import { MpvControl } from "../MpvControl";

/** A mounted react-native-tvos View or Pressable: react-native-tvos adds `requestTVFocus()` to it at runtime. */
type TvViewInstance = ViewInstance & { requestTVFocus(): void };
import { MediaVolume } from "@space/mobile-media-volume";
import { isDoubleTap, isVerticalSwipe, levelAfterSwipe, surfaceTap, swipeTarget, type SurfaceTap } from "../gestures";
import { directRenderOf, sidecarObjectKey, unplayableUnderDirectRender } from "../ocrTwin";
import { previewLeft, SEEK_PREVIEW_WIDTH_PHONE, SEEK_PREVIEW_WIDTH_TV, type SeekPreviewSource } from "../seekPreview";
import { controlsBottomInset } from "../subtitleLift";
import { applySubtitlePick } from "../subtitlePick";
import {
  buildAudioRows,
  buildQualityRows,
  buildSubtitleRows,
  chapterRowTitle,
  pickerRowAccessibilityLabel,
  selectedRowScrollY,
  type SubtitleGetMoreRow,
  type SubtitleTryAnotherRow,
} from "../trackRows";
import { scaleStyle, scaleStyleSheet } from "../uiScale";
import type { AudioTrack, Chapter, MpvTrack, PlaybackSnapshot, PlaybackState, SubtitleTrack, VideoFormat } from "../types";
import { SeekPreviewPicture } from "./SeekPreviewPicture";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

// --- Theming ---------------------------------------------------------------
// Each consumer (badger-mobile) overrides via the
// `theme` prop; the defaults below reproduce the mpv-poc look.

export type PlayerControlsTheme = {
  /** Played-progress + active row colour. */
  accent: string;
  /** Translucent surface used by every chrome button + pill. */
  chromeBackground: string;
  /** 1dp border on every chrome surface. */
  chromeBorder: string;
  /** Bottom-sheet body background. */
  sheetBackground: string;
  /** Faint accent track shown on the unplayed seekbar segment. */
  unplayedAccent: string;
};

// The accent is Badger yellow, the shell theme's `accent` (`defaultMobileShellTheme`, PLAY-LOOK-01).
// Kept as literals: the desktop OSC test reads these colours from source (`osc-player-chrome.test.ts`).
const DEFAULT_THEME: PlayerControlsTheme = {
  accent: "#ffb357",
  chromeBackground: "rgba(35, 30, 35, 0.55)",
  chromeBorder: "rgba(76, 68, 76, 0.4)",
  sheetBackground: "#1f1f22",
  unplayedAccent: "rgba(255, 179, 87, 0.30)",
};

// --- Helpers ---------------------------------------------------------------

const formatTime = (seconds: number) => {
  if (!seconds || !isFinite(seconds)) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

export type PlayerControlsProps = {
  labels: PlayerControlsLabels;
  hlsUrl: string;
  fullDuration: number;
  videos: VideoFormat[];
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  chapters: Chapter[];
  theme?: Partial<PlayerControlsTheme>;
  /**
   * Latest playback snapshot, polled once by the owner (0.5-1 Hz). The controls
   * never poll position themselves, so there is exactly one poller per player.
   */
  snapshot: PlaybackSnapshot | null;
  /** "auto" = adaptive bitrate; "manual" = pinned to `activeVideoId`. */
  qualityMode?: "auto" | "manual";
  /** Variant currently playing (drives the check mark; in auto mode also the "Auto (1080p)" label). */
  activeVideoId?: string | null;
  /** Pick a variant id, or "auto". Owner performs the switch preserving position/audio/subs. */
  onSelectQuality?: (variantId: string | "auto") => void;
  /** Called after the controls issued any user seek (target in seconds) so the owner can react / measure. */
  onSeekIssued?: (targetSeconds: number) => void;
  /** The "what's playing" line top-left, already formatted by the owner (PLAY-OVL-01); nothing is drawn when empty. */
  title?: string;
  /**
   * Cast button, first of the top-right row, shown only when provided: the phone passes it to hand the title to a Cast
   * device (PLAY-OVL-04); the TV never does.
   */
  onCastPress?: () => void;
  /** Centre previous-episode button, shown only when provided: the owner passes it only for an episode that has a previous playable one (PLAY-OVL-03). */
  onPreviousEpisode?: () => void;
  /** Centre next-episode button, shown only when provided: the owner passes it only for an episode that has a next playable one (PLAY-OVL-03). */
  onNextEpisode?: () => void;
  /** Fires when the control chrome shows/hides so the owner can slow its polling while hidden. */
  onVisibilityChange?: (visible: boolean) => void;
  /**
   * Distance (dp) from the bottom of the controls' box up to the measured top of the bottom bar (timecodes + progress
   * bar), on every layout change; the owner keeps subtitles above it while the controls show (MPV-OSC-02).
   */
  onControlsBottomInset?: (inset: number) => void;
  onBackPress?: () => void;
  /**
   * Size multiplier for the whole chrome (UX-TV-13): the controls are drawn in dp for a 960x540 TV window, so an Apple
   * TV's 1920x1080 points pass 2. Default 1 (phones and Android TV keep their sizes).
   */
  uiScale?: number;
  /** Audio track index (into `audioTracks`) playing at start; default 0. A later value (the plan applied at the first frame) moves the selection. */
  initialAudioIdx?: number;
  /** Subtitle track index showing at start; default -1 (off). A later value (the plan applied at the first frame) moves the selection. */
  initialSubtitleIdx?: number;
  /** Fires only when the USER picks an audio track (never for the initial selection), so the owner can remember it. */
  onAudioPick?: (track: AudioTrack) => void;
  /** mpv's audio id for the library audio track at `idx`; without it the pick goes by position. */
  resolveAudioId?: (mpvTracks: readonly MpvTrack[], idx: number) => number;
  /** Fires only when the USER picks a subtitle track (`null` = Off), never for the initial selection. */
  onSubtitlePick?: (track: SubtitleTrack | null) => void;
  /**
   * TV build (Android TV / Fire TV / Apple TV): the controls are driven by the remote (UX-TV-01). While the overlay is up
   * every chrome button and the progress bar are on the D-pad (accent focus ring, focus placed by `handle.show(focus)`,
   * auto-hide restarted by every focus move); once hidden none of them takes the focus. Menus trap focus and focus
   * their selected row, and the touch-only surface is not focusable. Phones leave it off.
   */
  tv?: boolean;
  /** TV: the progress bar gained (true) or lost (false) the D-pad focus, so the owner's remote makes left / right jump there. */
  onProgressFocusChange?: (focused: boolean) => void;
  /** Fires when a menu (audio, subtitles, quality, chapters) opens or closes, so the owner can route remote keys. */
  onSheetOpenChange?: (open: boolean) => void;
  /** Imperative remote control of the overlay and playback for the owner's key handler (TV). */
  handleRef?: React.Ref<PlayerControlsHandle>;
  /**
   * Seek-bar preview pictures of the playing video (MPV-PREV-01): drawn above the thumb while the phone drags the bar,
   * above the bar while the TV steps left / right with the controls up. None (no previews): the bar as before.
   */
  seekPreview?: SeekPreviewSource | null;
  /**
   * "Get more subtitles…" as the subtitle menu's last row (PLAY-SUBGET-02), shown only when provided. Picking it closes
   * the menu, then calls `onPress`; the owner pauses, shows the search over the video and resumes.
   */
  getMoreSubtitles?: SubtitleGetMoreRow | null;
  /**
   * "Try another version" after "Get more subtitles…" while the subtitle on is a fetched one (PLAY-SUBGET-07). Picking
   * it closes the menu, then calls `onPress` with that track; the owner pauses, replaces it and resumes.
   */
  tryAnotherSubtitle?: SubtitleTryAnotherRow | null;
  /**
   * "Add a subtitle file…" right after "Get more subtitles…" (PLAY-SUBGET-23), shown only when provided (the phone, never
   * the TV). Picking it closes the menu, then calls `onPress`; the owner opens the file picker and stores the file.
   */
  addSubtitleFile?: SubtitleGetMoreRow | null;
};

/** What the owner's remote handler can do to the controls (TV). */
export type PlayerControlsHandle = {
  /** Show the controls; on TV `focus` also puts the D-pad focus on that control ("top" = Chapters, else subtitles). */
  show: (focus?: ChromeFocus) => void;
  /** TV: restart the auto-hide timer while the controls are up (a remote key the overlay did not see as a focus move); a key during the fade-out cuts it short. */
  keepVisible: () => void;
  /**
   * TV: whether the controls are on screen now. It turns false the moment a fade-out ends and true the moment `show`
   * runs, before the owner's `onVisibilityChange` re-render, so a remote key pressed in between is decided on what is
   * really on screen (UX-TV-01).
   */
  isVisible: () => boolean;
  /**
   * TV: a D-pad direction was pressed while the controls are up. Right after a menu closed (its button not focused
   * yet) the focus goes from that button the way the arrow points; any other focus placement still waiting is
   * dropped, so it never pulls the focus back from where the press took it.
   */
  focusArrow: (key: "up" | "down" | "left" | "right") => void;
  /** TV: put the D-pad focus back on the control it was last sent to (after a prompt that held it went away). */
  refocus: () => void;
  hide: () => void;
  closeSheet: () => void;
  /** Open the subtitles menu (the remote's subtitles key). */
  openSheet: (sheet: "subtitles") => void;
  /** While subtitles / audio / quality is open: switch to the next (+1) or previous (-1) of the three. */
  cycleSheet: (direction: -1 | 1) => void;
  /** Seek `seconds` (default SEEK_STEP_SECONDS) back (-1) or forward (+1) through `MpvControl.seekRelative`, with the toast. */
  stepSeek: (direction: -1 | 1, seconds?: number) => void;
  /**
   * TV touch scrub (UX-TV-01): draw a pending target (s) on the progress bar (thumb, time, preview picture) and keep
   * the controls up while it lasts; null clears it. Nothing is seeked.
   */
  scrubTo: (seconds: number | null) => void;
  /** Seek to `seconds` (absolute, exact, like the phone's slider release) and keep the bar there until mpv follows. */
  seekTo: (seconds: number) => void;
  /** The playing position and the progress bar's length (the library's duration, else mpv's), in seconds. */
  times: () => { position: number; duration: number };
  togglePause: () => void;
  /** Pick an audio track by its index in `audioTracks`, exactly as a pick in the menu (remembered, PLAY-TRACK-04). */
  selectAudio: (idx: number) => Promise<void>;
  /**
   * Pick a subtitle by its index in `subtitleTracks`, -1 = off, exactly as a pick in the menu (PLAY-TRACK-06 on failure).
   * `reload` loads it again even when that row is already on: "Try another version" put a new track in it (PLAY-SUBGET-07).
   */
  selectSubtitle: (idx: number, options?: { reload?: boolean }) => Promise<void>;
  /** The audio / subtitle rows the menus show as picked (-1 = off / mpv default). */
  trackState: () => { audioIdx: number; subtitleIdx: number };
};

/** Every user-facing string of the controls, supplied translated by the owner so this package stays language-agnostic. */
export type PlayerControlsLabels = {
  closePlayer: string;
  videoSurface: string;
  chapters: string;
  previousEpisode: string;
  nextEpisode: string;
  subtitles: string;
  audio: string;
  quality: string;
  /** Cast button; only read when `onCastPress` is given. */
  cast?: string;
  /** Indicator title while sliding on the right half. */
  volume: string;
  /** Indicator title while sliding on the left half. */
  brightness: string;
  /** Flash shown after a double-tap seek on the left half (10 s). */
  seekBackToast: string;
  /** Flash shown after a double-tap seek on the right half (10 s). */
  seekForwardToast: string;
  /** Flash shown after a remote seek: `amount` is the signed number of seconds ("+30"). */
  seekBy: (amount: string) => string;
  play: string;
  pause: string;
  seekBar: string;
  /** Quality row that enables adaptive bitrate. */
  qualityAuto: string;
  /** Subtitle row that turns subtitles off. */
  subtitlesOff: string;
  /** Notice shown when a picked subtitle cannot be loaded; the previous subtitle is put back (PLAY-TRACK-06). */
  subtitleLoadFailed: string;
  /** Row title for an audio/subtitle track with neither label nor language (1-based). */
  trackFallback: (position: number) => string;
};

type SheetKind = "none" | "chapters" | "video" | "audio" | "subtitles";

/** A control the TV's D-pad focus can be sent to; "top" = the first of the top-right row (Chapters, else subtitles). */
export type ChromeFocus = "top" | "close" | "progress" | "play" | "chapters" | "subtitles" | "audio" | "quality";
/** The top-right button that opens each menu: the focus goes back to it when the menu closes (TV). */
const SHEET_OPENER: Record<Exclude<SheetKind, "none">, ChromeFocus> = {
  chapters: "chapters",
  subtitles: "subtitles",
  audio: "audio",
  video: "quality",
};

/** Where an arrow takes the focus from a top-right button (the row the menus open from): the close button sits left of the row, play / pause below it. */
const topRowNeighbor = (from: ChromeFocus, key: "up" | "down" | "left" | "right", hasChapters: boolean): ChromeFocus => {
  if (key === "up") return from;
  if (key === "down") return "play";
  const row: ChromeFocus[] = hasChapters ? ["chapters", "subtitles", "audio", "quality"] : ["subtitles", "audio", "quality"];
  const at = row.indexOf(from);
  if (at < 0) return from;
  if (key === "left") return at === 0 ? "close" : row[at - 1]!;
  return row[Math.min(at + 1, row.length - 1)]!;
};

const ZERO_STATE: PlaybackState = { position: 0, duration: 0, paused: false, cacheEnd: 0 };
const AUTO_HIDE_MS = 4000;
/** How long a notice (e.g. "Subtitles couldn't load") stays on screen. */
const NOTICE_MS = 3500;
const SEEK_STEP_SECONDS = 10;
/** The menus the remote's left / right switch between while one of them is open (TV). */
const TAB_SHEETS: readonly SheetKind[] = ["subtitles", "audio", "video"];
/** Focus ring width of a focused TV menu row: same as the TV shell's `TvFocusable`. */
const TV_FOCUS_RING_WIDTH = 3;
/** Wait before asking a control for the focus: it only becomes focusable in the commit that shows the overlay. */
const TV_FOCUS_DELAY_MS = 80;
const MIN_TARGET_DP = 48;
const SHEET_DISMISS_DY = 80;
const SHEET_DISMISS_VY = 0.6;
const SEEK_TRACK_HEIGHT = 8;
const SEEK_THUMB_WIDTH = 6;
const SEEK_THUMB_HEIGHT = 24;
const SEEK_THUMB_GAP = 14;
/**
 * TV: how long the preview picture stays after the last left / right step with the controls up. Steps closer together
 * than this add up from the moment the previous one aimed at (mpv seeks relatively; the polled position lags behind).
 */
const TV_PREVIEW_HOLD_MS = 1500;
/**
 * TV with the controls hidden (MPV-PREV-01): a left / right step brings up the progress bar alone, with the aimed time
 * and its picture, instead of a bare ±seconds toast; it goes this long after the last step.
 */
const TV_SCRUB_HOLD_MS = 3000;
/** TV touch scrub: after its seek the bar stays on the target until mpv's position is this close to it... */
const TV_SEEK_SETTLED_SECONDS = 2;
/** ...or this long at most (a seek that lands elsewhere or slowly). */
const TV_SEEK_SETTLE_MS = 2500;
/** Gap between the top of the 48 dp seek bar and the bottom of the preview picture's time line. */
const SEEK_PREVIEW_BOTTOM = 40;

export const PlayerControls = (
  {
    hlsUrl,
    labels,
    fullDuration,
    videos,
    audioTracks,
    subtitleTracks,
    chapters,
    theme: themeProp,
    snapshot,
    qualityMode = "manual",
    activeVideoId = null,
    onSelectQuality,
    onSeekIssued,
    title,
    onCastPress,
    onPreviousEpisode,
    onNextEpisode,
    onProgressFocusChange,
    onVisibilityChange,
    onControlsBottomInset,
    onBackPress,
    initialAudioIdx = 0,
    initialSubtitleIdx = -1,
    onAudioPick,
    resolveAudioId,
    onSubtitlePick,
    tv = false,
    onSheetOpenChange,
    handleRef,
    seekPreview,
    getMoreSubtitles,
    tryAnotherSubtitle,
    addSubtitleFile,
    uiScale = 1,
  }: PlayerControlsProps,
) => {
  const theme = useMemo<PlayerControlsTheme>(
    () => ({ ...DEFAULT_THEME, ...themeProp }),
    [themeProp],
  );
  const styles = stylesFor(theme, uiScale);

  const state: PlaybackState = snapshot ?? ZERO_STATE;
  const hasChapters = chapters.length > 0;
  const pausedRef = useRef(state.paused);
  pausedRef.current = state.paused;
  const [seekToast, setSeekToast] = useState<{ side: "left" | "right"; label: string } | null>(null);
  const seekToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<Parameters<typeof clearTimeout>[0]>(undefined);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const lastTap = useRef<SurfaceTap | null>(null);
  const pressInAt = useRef(0);
  const [visible, setVisible] = useState(true);
  // The latest `visible` (the TV seek steps, `isVisible`); set where a fade-out ends and in `show`, ahead of the re-render.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (tv) console.info("tv.player.controls.visible", JSON.stringify({ visible }));
    onVisibilityChange?.(visible);
  }, [visible, onVisibilityChange]);
  const [seeking, setSeeking] = useState(false);
  const [seekPos, setSeekPos] = useState(0);
  const [sheet, setSheet] = useState<SheetKind>("none");
  const [mountedSheet, setMountedSheet] = useState<SheetKind>("none");
  // The sheet a press asked for is drawn in that same render: waiting for the effect below to mount it cost a second
  // render of the whole overlay before anything moved (seconds on a weak TV box). `mountedSheet` only outlives `sheet`
  // while the close animation runs.
  const shownSheet: SheetKind = sheet !== "none" ? sheet : mountedSheet;

  const [activeAudioIdx, setActiveAudioIdx] = useState(initialAudioIdx);
  const [activeSubIdx, setActiveSubIdx] = useState(initialSubtitleIdx);
  // The owner re-plans the start tracks once the VO is known (direct rendering never starts a picture subtitle without
  // an OCR twin, PLAY-TRACK-05): the selected rows follow that plan.
  useEffect(() => { setActiveAudioIdx(initialAudioIdx); }, [initialAudioIdx]);
  useEffect(() => {
    console.info("[mpv-subtitles] controls.start_selection", JSON.stringify({ initialSubtitleIdx }));
    setActiveSubIdx(initialSubtitleIdx);
  }, [initialSubtitleIdx]);
  const [mpvTracks, setMpvTracks] = useState<MpvTrack[]>([]);

  const fadeAnim = useRef(new Animated.Value(1)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekBarWidth = useRef(1);
  const seekBarPageX = useRef(0);
  // The bottom bar's real top edge (MPV-OSC-02): the overlay's height and the bar layer's top, both from layout.
  const overlayHeight = useRef(0);
  const bottomBarTop = useRef(-1);
  const reportedInset = useRef(-1);
  const reportBottomInset = useCallback(() => {
    const inset = controlsBottomInset(overlayHeight.current, bottomBarTop.current);
    if (!onControlsBottomInset || inset === reportedInset.current) return;
    reportedInset.current = inset;
    console.info("player.controls.bottom_inset", JSON.stringify({ inset, overlayHeight: overlayHeight.current, barTop: bottomBarTop.current, scale: uiScale }));
    onControlsBottomInset(inset);
  }, [onControlsBottomInset, uiScale]);

  const screen = useRef(Dimensions.get("window")).current;
  const sheetClosedY = useRef(screen.height).current;
  const sheetY = useRef(new Animated.Value(sheetClosedY)).current;
  const sheetMeasuredHeight = useRef(0);
  const backdropAnim = useRef(new Animated.Value(0)).current;

  // Track list (audio/subtitle ids) changes rarely: refresh when a sheet opens and every
  // 3 s until the demuxer has reported tracks, never on the position tick.
  const refreshTracks = useCallback(async () => {
    try {
      const tracks = await MpvControl.getTrackList();
      if (Array.isArray(tracks)) setMpvTracks(tracks as MpvTrack[]);
    } catch {}
  }, []);

  useEffect(() => {
    void refreshTracks();
    const id = setInterval(() => {
      if (mpvTracksCount.current === 0) void refreshTracks();
    }, 3000);
    return () => clearInterval(id);
  }, [refreshTracks]);

  const mpvTracksCount = useRef(0);
  mpvTracksCount.current = mpvTracks.length;

  useEffect(() => {
    if (sheet !== "none") void refreshTracks();
  }, [sheet, refreshTracks]);

  const clearHide = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHide();
    hideTimer.current = setTimeout(() => {
      if (!pausedRef.current) {
        Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true })
          // A fade cut short by show() (setValue stops it, finished: false) must not hide the controls it just showed.
          .start(({ finished }) => {
            if (tv) console.info("tv.player.controls.auto_hide_end", JSON.stringify({ finished }));
            if (finished) {
              visibleRef.current = false;
              setVisible(false);
            }
          });
      }
    }, AUTO_HIDE_MS);
  }, [fadeAnim, clearHide, tv]);
  /** TV: a remote key while the controls are up; one that comes during the fade-out cuts it short (finished: false). */
  const keepVisible = useCallback(() => {
    fadeAnim.setValue(1);
    scheduleHide();
  }, [fadeAnim, scheduleHide]);

  // --- TV: D-pad focus on the chrome (UX-TV-01) ------------------------------------------------------------------
  // The overlay's buttons and progress bar take the focus only while it is up; a key that brings it up says where the
  // focus goes (`show(focus)`), a closing menu sends it back to the button that opened it. At first the focus is on
  // play / pause, as the overlay starts visible. Each ask is placed once per showing of the overlay (a menu closing
  // never replays an older ask), and a D-pad press that comes before a pending ask lands drops it (UX-TV-01).
  const chaptersRef = useRef<TvViewInstance>(null);
  const subtitlesRef = useRef<TvViewInstance>(null);
  const closeRef = useRef<TvViewInstance>(null);
  const audioRef = useRef<TvViewInstance>(null);
  const qualityRef = useRef<TvViewInstance>(null);
  const playRef = useRef<TvViewInstance>(null);
  const progressRef = useRef<TvViewInstance>(null);
  const [focusAsk, setFocusAsk] = useState<{ target: ChromeFocus; seq: number }>({ target: "play", seq: 0 });
  /** Seq of the latest ask, set synchronously so a key arriving before the re-render still sees it. */
  const askSeq = useRef(0);
  /** Seq of the ask already placed (or dropped) during this showing of the overlay; -1 once it hides. */
  const placedSeq = useRef(-1);
  const askFocus = useCallback((target: ChromeFocus) => {
    if (!tv) return;
    askSeq.current += 1;
    setFocusAsk({ target, seq: askSeq.current });
  }, [tv]);
  /**
   * The menu button the focus is going back to while a menu closes, until it is placed. Set the moment the menu is
   * told to close (before any re-render), so an arrow pressed right after Back steps from it instead of being lost.
   */
  const restoreOpener = useRef<ChromeFocus | null>(null);
  const sheetNow = useRef(sheet);
  sheetNow.current = sheet;
  const closeSheet = useCallback(() => {
    const open = sheetNow.current;
    if (tv && open !== "none") restoreOpener.current = SHEET_OPENER[open];
    setSheet("none");
  }, [tv]);
  const focusArrow = useCallback((key: "up" | "down" | "left" | "right") => {
    if (!tv) return;
    const from = restoreOpener.current;
    if (from) {
      const to = topRowNeighbor(from, key, hasChapters);
      restoreOpener.current = to;
      console.info("tv.player.controls.focus_step", JSON.stringify({ from, key, to }));
      // An ask already waiting is replaced; before the closing menu has asked, it asks for the stepped button itself.
      if (askSeq.current !== placedSeq.current) askFocus(to);
      return;
    }
    if (placedSeq.current === askSeq.current) return;
    console.info("tv.player.controls.focus_dropped", JSON.stringify({ seq: askSeq.current }));
    placedSeq.current = askSeq.current;
  }, [tv, hasChapters, askFocus]);

  const show = useCallback((focus?: ChromeFocus) => {
    if (tv) console.info("tv.player.controls.show", JSON.stringify({ focus: focus ?? null }));
    setVisible(true);
    fadeAnim.setValue(1);
    // After setValue: a hide fade it cut short ends there (finished: false), and the controls are up from here on.
    visibleRef.current = true;
    scheduleHide();
    if (focus) askFocus(focus);
  }, [fadeAnim, scheduleHide, askFocus, tv]);
  useEffect(() => {
    if (!tv) return undefined;
    // Hidden: the next showing places the focus again (on the last control asked for). An open menu holds the focus
    // itself and asks for its opener when it closes, so whatever was asked before it opened is never replayed.
    if (!visible) {
      placedSeq.current = -1;
      restoreOpener.current = null;
    }
    if (sheet !== "none") placedSeq.current = askSeq.current;
    if (!visible || sheet !== "none" || placedSeq.current === focusAsk.seq) return undefined;
    const id = setTimeout(() => {
      if (placedSeq.current === focusAsk.seq) return; // dropped by a D-pad press while waiting
      if (askSeq.current !== focusAsk.seq) return; // a newer ask (an arrow stepped it) re-renders and places itself
      placedSeq.current = focusAsk.seq;
      restoreOpener.current = null;
      const target = focusAsk.target === "top" ? (hasChapters ? "chapters" : "subtitles") : focusAsk.target;
      const ref = { close: closeRef, chapters: chaptersRef, subtitles: subtitlesRef, audio: audioRef, quality: qualityRef, play: playRef, progress: progressRef }[target];
      console.info("tv.player.controls.focus", JSON.stringify({ asked: focusAsk.target, target, seq: focusAsk.seq, found: ref.current !== null }));
      ref.current?.requestTVFocus();
    }, TV_FOCUS_DELAY_MS);
    return () => clearTimeout(id);
  }, [tv, visible, sheet, focusAsk, hasChapters]);

  // A focus move is the user navigating: the controls stay up while they do.
  const onChromeFocus = useCallback(() => {
    if (tv) scheduleHide();
  }, [tv, scheduleHide]);
  const chromeFocus = { tv, visible, onFocus: onChromeFocus, uiScale };
  const [progressFocused, setProgressFocused] = useState(false);
  const setProgressFocus = useCallback((focused: boolean) => {
    setProgressFocused(focused);
    onProgressFocusChange?.(focused);
    if (focused) scheduleHide();
  }, [onProgressFocusChange, scheduleHide]);
  // Hidden controls hold no focus: the progress bar's blur may not come when its view stops being focusable.
  useEffect(() => {
    if (!visible && progressFocused) setProgressFocus(false);
  }, [visible, progressFocused, setProgressFocus]);

  useEffect(() => {
    if (state.paused && !visible) show();
    if (state.paused) clearHide();
  }, [state.paused]);

  useEffect(() => { scheduleHide(); }, []);

  useEffect(() => {
    if (sheet !== "none") {
      restoreOpener.current = null;
      clearHide();
      setVisible(true);
      fadeAnim.setValue(1);
      setMountedSheet(sheet);
      Animated.parallel([
        Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
        Animated.timing(backdropAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else if (mountedSheet !== "none") {
      Animated.parallel([
        Animated.timing(sheetY, { toValue: sheetClosedY, duration: 220, useNativeDriver: true }),
        Animated.timing(backdropAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setMountedSheet("none");
      });
      scheduleHide();
      // Back to the menu's button, or wherever an arrow pressed since the close took it from there.
      if (!restoreOpener.current) restoreOpener.current = SHEET_OPENER[mountedSheet];
      askFocus(restoreOpener.current);
    }
  }, [sheet]);

  // Android back: close an open sheet first; otherwise let the owner's handler run. On TV the owner's remote handler
  // decides every Back (sheet, prompt, controls, leave) in one place, so this one is not registered there.
  useEffect(() => {
    if (sheet === "none" || tv) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setSheet("none");
      return true;
    });
    return () => sub.remove();
  }, [sheet, tv]);

  const seekBy = useCallback(async (delta: number) => {
    const target = Math.max(0, state.position + delta);
    try { await MpvControl.seekRelative(delta, null); }
    catch (e: any) { console.warn("[controls] relative seek error", e); }
    onSeekIssued?.(target);
  }, [state.position, onSeekIssued]);

  const flashSeekToast = useCallback((side: "left" | "right", label: string) => {
    setSeekToast({ side, label });
    if (seekToastTimer.current) clearTimeout(seekToastTimer.current);
    seekToastTimer.current = setTimeout(() => setSeekToast(null), 700);
  }, []);

  const flashNotice = useCallback((label: string) => {
    setNotice(label);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  useEffect(() => () => {
    clearTimeout(seekToastTimer.current ?? undefined);
    clearTimeout(noticeTimer.current);
    clearHide();
  }, [clearHide]);

  // Vertical slides on the video: right half = media volume, left half = screen brightness (reset on exit).
  const [slideHud, setSlideHud] = useState<{ target: "volume" | "brightness"; level: number } | null>(null);
  const slideHudTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const slide = useRef<{ target: "volume" | "brightness"; start: number; last: number } | null>(null);
  const levelCache = useRef<{ volume: number; brightness: number }>({ volume: 0.5, brightness: 0.5 });
  const brightnessOverridden = useRef(false);

  const readLevel = useCallback(async (target: "volume" | "brightness") => {
    try {
      const level = target === "volume" ? await MediaVolume.get() : await MpvControl.getScreenBrightness();
      levelCache.current[target] = level;
      return level;
    } catch {
      return levelCache.current[target];
    }
  }, []);

  useEffect(() => {
    void readLevel("volume");
    void readLevel("brightness");
    return () => {
      clearTimeout(slideHudTimer.current);
      if (brightnessOverridden.current) void MpvControl.setScreenBrightness(-1).catch(() => undefined);
    };
  }, [readLevel]);

  const surfacePan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, gs) => isVerticalSwipe(gs.dx, gs.dy),
        onPanResponderGrant: (_, gs) => {
          lastTap.current = null;
          const target = swipeTarget(gs.x0, windowWidth);
          const start = levelCache.current[target];
          slide.current = { target, start, last: start };
          clearTimeout(slideHudTimer.current);
          setSlideHud({ target, level: start });
          // The volume keys may have moved it since the last read: rebase once the fresh level arrives.
          void readLevel(target).then((fresh) => {
            if (slide.current?.target === target) slide.current.start = fresh;
          });
        },
        onPanResponderMove: (_, gs) => {
          const s = slide.current;
          if (!s) return;
          const level = levelAfterSwipe(s.start, gs.dy, windowHeight);
          if (Math.abs(level - s.last) < 0.005) return;
          s.last = level;
          levelCache.current[s.target] = level;
          setSlideHud({ target: s.target, level });
          if (s.target === "volume") {
            void MediaVolume.set(level).catch(() => undefined);
          } else {
            brightnessOverridden.current = true;
            void MpvControl.setScreenBrightness(level).catch(() => undefined);
          }
        },
        onPanResponderRelease: () => {
          slide.current = null;
          slideHudTimer.current = setTimeout(() => setSlideHud(null), 600);
        },
        onPanResponderTerminate: () => {
          slide.current = null;
          slideHudTimer.current = setTimeout(() => setSlideHud(null), 600);
        },
      }),
    [windowWidth, windowHeight, readLevel],
  );

  // Single tap toggles the controls; a second tap on the same half within DOUBLE_TAP_MS seeks +-10 s.
  const onSurfacePress = useCallback((evt: GestureResponderEvent) => {
    const tap = surfaceTap(
      { locationX: evt.nativeEvent.locationX, downAt: pressInAt.current, upAt: evt.nativeEvent.timestamp },
      windowWidth,
    );
    const { side } = tap;
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      const delta = side === "left" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
      void seekBy(delta);
      flashSeekToast(side, side === "left" ? labels.seekBackToast : labels.seekForwardToast);
      show();
      return;
    }
    lastTap.current = tap;
    if (sheet !== "none") { setSheet("none"); return; }
    if (visible) {
      clearHide();
      Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setVisible(false); });
    } else {
      show();
    }
  }, [windowWidth, seekBy, flashSeekToast, show, sheet, visible, clearHide, fadeAnim, labels]);

  const togglePause = async () => {
    try { await MpvControl.togglePause(); } catch {}
    scheduleHide();
  };

  // --- TV: remote control ---------------------------------------------------
  const hide = useCallback(() => {
    clearHide();
    Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true })
      // A fade cut short by show() (setValue stops it, finished: false) must not hide the controls it just showed.
      .start(({ finished }) => {
        if (tv) console.info("tv.player.controls.hide_end", JSON.stringify({ finished }));
        if (!finished) return;
        visibleRef.current = false;
        setVisible(false);
      });
  }, [clearHide, fadeAnim, tv]);

  // TV (MPV-PREV-01): a step aims the preview picture at where the seeks are taking the video. With the controls up the
  // picture shows above the focused bar; with them hidden the progress bar alone comes up with the aimed time and its
  // picture (picture only when the title has previews), and goes a few seconds after the last step.
  const [tvAim, setTvAim] = useState<number | null>(null);
  const tvAimRef = useRef<{ seconds: number; at: number } | null>(null);
  const tvAimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const positionRef = useRef(state.position);
  positionRef.current = state.position;
  // The seek bar's length (the library's duration, else mpv's): a TV aim never runs past the bar's end.
  const barDurationRef = useRef(0);
  barDurationRef.current = fullDuration > 0 ? fullDuration : state.duration;
  useEffect(() => () => clearTimeout(tvAimTimer.current), []);

  const stepSeek = useCallback((direction: -1 | 1, seconds: number = SEEK_STEP_SECONDS) => {
    void seekBy(direction * seconds);
    const scrub = tv && !visibleRef.current;
    // The scrub bar shows where the jump lands, which the bare toast never did.
    if (!scrub) flashSeekToast(direction < 0 ? "left" : "right", labels.seekBy(`${direction < 0 ? "-" : "+"}${seconds}`));
    if (!scrub && (!seekPreview || !visibleRef.current)) return;
    const hold = scrub ? TV_SCRUB_HOLD_MS : TV_PREVIEW_HOLD_MS;
    const now = Date.now();
    const previous = tvAimRef.current;
    const from = previous && now - previous.at < hold ? previous.seconds : positionRef.current;
    const duration = barDurationRef.current;
    const ahead = from + direction * seconds;
    const aim = Math.max(0, duration > 0 ? Math.min(duration, ahead) : ahead);
    tvAimRef.current = { seconds: aim, at: now };
    if (scrub) {
      console.info("tv.player.scrub.step", JSON.stringify({ direction, seconds, from, aim, duration, previews: !!seekPreview }));
    }
    setTvAim(aim);
    clearTimeout(tvAimTimer.current);
    tvAimTimer.current = setTimeout(() => {
      if (scrub) console.info("tv.player.scrub.hide", JSON.stringify({ aim }));
      tvAimRef.current = null;
      setTvAim(null);
    }, hold);
  }, [seekBy, flashSeekToast, labels, seekPreview, tv]);

  // TV touch scrub (UX-TV-01, Chris 2026-11-08): the owner's remote moves a pending target with the Siri Remote's touch
  // surface; the bar draws it (thumb, time, preview picture) like the phone's slider drag while the video plays on.
  // After the seek the bar stays on the target until mpv's position reaches it, so the thumb never flicks back.
  const [tvScrub, setTvScrub] = useState<number | null>(null);
  const tvScrubSettle = useRef<{ target: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const endScrubSettle = useCallback((why: string) => {
    const settle = tvScrubSettle.current;
    if (!settle) return;
    clearTimeout(settle.timer);
    tvScrubSettle.current = null;
    console.info("tv.player.scrub.settled", JSON.stringify({ why, target: settle.target, position: positionRef.current }));
    setTvScrub(null);
  }, []);
  useEffect(() => () => clearTimeout(tvScrubSettle.current?.timer), []);
  useEffect(() => {
    const settle = tvScrubSettle.current;
    if (settle && Math.abs(state.position - settle.target) < TV_SEEK_SETTLED_SECONDS) endScrubSettle("position");
  }, [state.position, endScrubSettle]);
  const scrubTo = useCallback((seconds: number | null) => {
    if (tvScrubSettle.current) {
      clearTimeout(tvScrubSettle.current.timer);
      tvScrubSettle.current = null;
    }
    setTvScrub(seconds);
    if (seconds !== null) clearHide();
    else if (visibleRef.current) scheduleHide();
  }, [clearHide, scheduleHide]);
  const seekTo = useCallback((target: number) => {
    console.info("tv.player.controls.seek_to", JSON.stringify({ target, from: positionRef.current }));
    if (tvScrubSettle.current) clearTimeout(tvScrubSettle.current.timer);
    setTvScrub(target);
    tvScrubSettle.current = { target, timer: setTimeout(() => endScrubSettle("timeout"), TV_SEEK_SETTLE_MS) };
    MpvControl.seek(target, "absolute+exact").catch((e: unknown) => console.error("[controls] seek error", e));
    onSeekIssued?.(target);
    if (visibleRef.current) scheduleHide();
  }, [endScrubSettle, onSeekIssued, scheduleHide]);

  /** When the remote asked for the open menu, until its first layout: logged as the press-to-menu delay. */
  const sheetAskedAt = useRef<{ kind: SheetKind; at: number } | null>(null);
  /**
   * The subtitles button and the remote's subtitles key open the menu straight away, with nothing searched: Off, every
   * subtitle the title already has, then "Get more subtitles…", the only row that searches online (PLAY-SUBGET-24).
   */
  const openSubtitleMenu = useCallback((from: "button" | "remote") => {
    console.info("player.controls.subtitles_button", JSON.stringify({ from, tracks: subtitleTracks.length }));
    if (from === "remote") sheetAskedAt.current = { kind: "subtitles", at: Date.now() };
    setSheet("subtitles");
  }, [subtitleTracks.length]);
  const openSheet = useCallback((kind: "subtitles") => {
    console.info("tv.player.controls.open_sheet", kind);
    openSubtitleMenu("remote");
  }, [openSubtitleMenu]);

  const cycleSheet = useCallback((direction: -1 | 1) => {
    setSheet((current) => {
      const at = TAB_SHEETS.indexOf(current);
      if (at < 0) return current;
      const next = TAB_SHEETS[(at + direction + TAB_SHEETS.length) % TAB_SHEETS.length];
      console.info("tv.player.controls.cycle_sheet", JSON.stringify({ from: current, to: next }));
      return next;
    });
  }, []);

  useEffect(() => { onSheetOpenChange?.(sheet !== "none"); }, [sheet, onSheetOpenChange]);

  const SheetWrap: React.ElementType = tv ? TVFocusGuideView : View;
  const sheetWrapProps = tv ? { trapFocusUp: true, trapFocusDown: true, trapFocusLeft: true, trapFocusRight: true } : {};
  const SeekWrap: React.ElementType = tv ? TVFocusGuideView : React.Fragment;
  const seekWrapProps = tv ? { style: styles.seekBarSlot, trapFocusLeft: true, trapFocusRight: true } : {};

  // Under direct rendering (Android TV) a picture track with an OCR twin loads the twin's SRT, and one without a twin
  // is greyed out and can't be picked (PLAY-TRACK-05).
  const directRender = directRenderOf(snapshot) === true;
  const subUrlFor = useCallback((sub: SubtitleTrack): string => {
    const origin = hlsUrl.split("/playback/")[0];
    return `${origin}/playback/object/${encodeURIComponent(sidecarObjectKey(sub, directRender, "pick"))}`;
  }, [hlsUrl, directRender]);

  const currentChapterIdx = useMemo(() => {
    if (chapters.length === 0) return -1;
    let idx = 0;
    for (let i = 0; i < chapters.length; i++) {
      if (state.position >= chapters[i].startSeconds) idx = i; else break;
    }
    return idx;
  }, [chapters, state.position]);

  const seekToChapter = useCallback(async (idx: number) => {
    if (idx < 0 || idx >= chapters.length) return;
    const target = chapters[idx].startSeconds;
    try { await MpvControl.seek(target, "absolute+exact"); }
    catch (e: any) { console.error("[controls] chapter seek error", e); }
    onSeekIssued?.(target);
    scheduleHide();
  }, [chapters, scheduleHide, onSeekIssued]);

  const selectQuality = useCallback((id: string | "auto") => {
    setSheet("none");
    onSelectQuality?.(id);
  }, [onSelectQuality]);

  const selectAudio = useCallback(async (idx: number) => {
    if (idx < 0 || idx >= audioTracks.length || idx === activeAudioIdx) { setSheet("none"); return; }
    setActiveAudioIdx(idx);
    onAudioPick?.(audioTracks[idx]);
    const tracks = mpvTracks.length > 0 ? mpvTracks : await MpvControl.getTrackList().catch(() => [] as MpvTrack[]);
    const mpvId = resolveAudioId ? resolveAudioId(tracks, idx) : tracks.filter((t) => t.type === "audio")[idx]?.id ?? idx + 1;
    console.info("[controls] audio.picked", JSON.stringify({
      idx,
      language: audioTracks[idx].language ?? null,
      label: audioTracks[idx].label ?? null,
      mpvId,
      mpvAudio: tracks.filter((t) => t.type === "audio").map((t) => ({ id: t.id, lang: t.lang ?? null, title: t.title ?? null })),
    }));
    try { await MpvControl.setAudioTrack(mpvId); }
    catch (e: unknown) { console.error("[controls] setAudioTrack error", e); }
    setSheet("none");
  }, [audioTracks, activeAudioIdx, mpvTracks, onAudioPick, resolveAudioId]);

  const selectSubtitle = useCallback(async (idx: number, options?: { reload?: boolean }) => {
    if (idx === activeSubIdx && !options?.reload) { setSheet("none"); return; }
    const picked = idx >= 0 ? subtitleTracks[idx] : undefined;
    if (picked && unplayableUnderDirectRender(picked, directRender)) {
      // The menu row is disabled; this catches the remote ("Play on TV") and imperative-handle picks.
      console.warn("[mpv-subtitles] pick.unplayable", JSON.stringify({ idx, pickedId: picked.id, format: picked.format, directRender }));
      setSheet("none");
      return;
    }
    await applySubtitlePick(
      MpvControl,
      { idx, previousIdx: activeSubIdx, subtitleTracks, urlFor: subUrlFor },
      {
        setActiveIdx: setActiveSubIdx,
        showLoadFailed: () => flashNotice(labels.subtitleLoadFailed),
        onPicked: onSubtitlePick,
      },
    );
    setSheet("none");
  }, [activeSubIdx, subtitleTracks, subUrlFor, directRender, onSubtitlePick, flashNotice, labels]);

  // After the pickers: the handle hands them to the owner (the TV's "Play on TV" remote picks tracks through them).
  useImperativeHandle(handleRef, () => ({
    show,
    keepVisible,
    isVisible: () => visibleRef.current,
    focusArrow,
    refocus: () => askFocus(focusAsk.target),
    hide,
    closeSheet,
    openSheet,
    cycleSheet,
    stepSeek,
    scrubTo,
    seekTo,
    times: () => ({ position: positionRef.current, duration: barDurationRef.current }),
    togglePause: () => { void togglePause(); },
    selectAudio,
    selectSubtitle,
    trackState: () => ({ audioIdx: activeAudioIdx, subtitleIdx: activeSubIdx }),
  }), [show, keepVisible, focusArrow, closeSheet, askFocus, focusAsk.target, hide, stepSeek, scrubTo, seekTo, openSheet, cycleSheet, selectAudio, selectSubtitle, activeAudioIdx, activeSubIdx]);

  const onSeekBarLayout = (evt: LayoutChangeEvent) => {
    seekBarWidth.current = evt.nativeEvent.layout.width;
    (evt.target as any).measure?.((_x: number, _y: number, _w: number, _h: number, pageX: number) => {
      if (pageX != null) seekBarPageX.current = pageX;
    });
  };

  const getRatio = (evt: GestureResponderEvent) => {
    const locationX = evt.nativeEvent.locationX;
    const pageX = evt.nativeEvent.pageX;
    const width = Math.max(1, seekBarWidth.current);
    const useLocation =
      Number.isFinite(locationX) && locationX >= 0 &&
      (seekBarPageX.current <= 0 || Math.abs(locationX - (pageX - seekBarPageX.current)) < 8);
    const x = useLocation ? locationX : Math.max(0, pageX - seekBarPageX.current);
    return Math.max(0, Math.min(1, x / width));
  };

  const seekBarDuration = fullDuration > 0 ? fullDuration : state.duration;

  const onSeekGrant = (evt: GestureResponderEvent) => {
    setSeeking(true);
    setSeekPos(getRatio(evt) * seekBarDuration);
    clearHide();
  };
  const onSeekMove = (evt: GestureResponderEvent) => {
    setSeekPos(getRatio(evt) * seekBarDuration);
  };
  const onSeekRelease = async (evt: GestureResponderEvent) => {
    const target = getRatio(evt) * seekBarDuration;
    setSeeking(false);
    try { await MpvControl.seek(target, "absolute+exact"); }
    catch (e: any) { console.error("[controls] seek error", e); }
    onSeekIssued?.(target);
    scheduleHide();
  };

  const realPosition = state.position;
  // The bar's moment: the phone's drag, else the TV touch scrub's pending target, else the playing position.
  const barTime = seeking ? seekPos : tvScrub ?? realPosition;
  const progress = seekBarDuration > 0 ? barTime / seekBarDuration : 0;
  const displayTime = barTime;

  // MPV-PREV-01: the moment the bar points at (phone drag, TV steps), its picture once loaded.
  const [, setPreviewTick] = useState(0);
  useEffect(() => seekPreview?.subscribe(() => setPreviewTick((tick) => tick + 1)), [seekPreview]);
  // TV, controls hidden: the progress bar alone is up while a step's aim lasts.
  const scrubShown = tv && !visible && tvAim !== null;
  const previewSeconds = !seekPreview ? null : seeking ? seekPos : tvScrub ?? tvAim;
  useEffect(() => {
    if (previewSeconds !== null) seekPreview?.want(previewSeconds);
  }, [previewSeconds, seekPreview]);
  const previewFrame = previewSeconds !== null ? seekPreview?.frameAt(previewSeconds) ?? null : null;
  const previewWidth = tv ? SEEK_PREVIEW_WIDTH_TV : SEEK_PREVIEW_WIDTH_PHONE;
  const previewPicture = previewFrame && previewSeconds !== null ? (
    <SeekPreviewPicture
      frame={previewFrame}
      displayWidth={previewWidth}
      uiScale={uiScale}
      left={previewLeft(
        seekBarDuration > 0 ? (previewSeconds / seekBarDuration) * Math.max(1, seekBarWidth.current) : 0,
        previewWidth * uiScale,
        Math.max(1, seekBarWidth.current),
      )}
      bottom={SEEK_PREVIEW_BOTTOM * uiScale}
      time={formatTime(previewSeconds)}
      borderColor={theme.chromeBorder}
    />
  ) : null;

  const onSheetLayout = (e: LayoutChangeEvent) => {
    sheetMeasuredHeight.current = e.nativeEvent.layout.height;
    const asked = sheetAskedAt.current;
    if (asked) {
      sheetAskedAt.current = null;
      console.info("tv.player.controls.sheet_shown", JSON.stringify({ kind: asked.kind, ms: Date.now() - asked.at }));
    }
  };

  // TV: the menu's selected row takes the focus (`hasTVPreferredFocus`), but the native scroll-to-focus runs before the
  // rows are laid out, so a selected row below the first screenful kept the focus off screen (#2754). Once both the
  // menu and that row have a layout, scroll the row into view.
  const sheetScrollRef = useRef<ScrollViewInstance | null>(null);
  const sheetScrollHeight = useRef(0);
  const selectedRowLayout = useRef<{ y: number; height: number } | null>(null);
  const scrollToSelectedRow = () => {
    const row = selectedRowLayout.current;
    const y = row ? selectedRowScrollY(row, sheetScrollHeight.current) : null;
    if (y === null) return;
    console.info("tv.player.controls.sheet_scrolled_to_selected", JSON.stringify({ kind: shownSheet, y: Math.round(y) }));
    sheetScrollRef.current?.scrollTo({ y, animated: false });
  };
  const onSheetScrollLayout = (e: LayoutChangeEvent) => {
    sheetScrollHeight.current = e.nativeEvent.layout.height;
    scrollToSelectedRow();
  };
  const onSelectedRowLayout = (e: LayoutChangeEvent) => {
    selectedRowLayout.current = { y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height };
    scrollToSelectedRow();
  };
  // Before the next menu's layout events: a row measured in the menu shown before must not move this one.
  useLayoutEffect(() => {
    selectedRowLayout.current = null;
  }, [shownSheet]);

  const sheetPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 4,
      onPanResponderGrant: () => { sheetY.extractOffset(); },
      onPanResponderMove: (_, gs) => {
        if (gs.dy > 0) sheetY.setValue(gs.dy);
        else sheetY.setValue(0);
      },
      onPanResponderRelease: (_, gs) => {
        sheetY.flattenOffset();
        if (gs.dy > SHEET_DISMISS_DY || gs.vy > SHEET_DISMISS_VY) {
          setSheet("none");
        } else {
          Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 12 }).start();
        }
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => {
        sheetY.flattenOffset();
        Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 12 }).start();
      },
    }),
  ).current;

  const isLandscape = windowWidth > windowHeight;
  const sheetMaxWidth = isLandscape
    ? Math.min(640 * uiScale, Math.round(windowWidth * 0.7))
    : Math.round(windowWidth * 0.92);

  const videoRows: PickerRow[] = buildQualityRows(videos, activeVideoId, qualityMode, labels.qualityAuto, selectQuality);
  const audioRows: PickerRow[] = buildAudioRows(audioTracks, activeAudioIdx, labels.trackFallback, selectAudio);
  const subtitleRows: PickerRow[] = buildSubtitleRows(
    subtitleTracks,
    activeSubIdx,
    labels.subtitlesOff,
    labels.trackFallback,
    selectSubtitle,
    (sub) => unplayableUnderDirectRender(sub, directRender),
    getMoreSubtitles
      ? {
          ...getMoreSubtitles,
          onPress: () => {
            setSheet("none");
            getMoreSubtitles.onPress();
          },
        }
      : null,
    tryAnotherSubtitle
      ? {
          ...tryAnotherSubtitle,
          onPress: (track) => {
            setSheet("none");
            tryAnotherSubtitle.onPress(track);
          },
        }
      : null,
    addSubtitleFile
      ? {
          ...addSubtitleFile,
          onPress: () => {
            setSheet("none");
            addSubtitleFile.onPress();
          },
        }
      : null,
  );

  const sheetTitle =
    shownSheet === "chapters" ? labels.chapters :
    shownSheet === "video" ? labels.quality :
    shownSheet === "audio" ? labels.audio :
    shownSheet === "subtitles" ? labels.subtitles : "";

  const trackWidth = Math.max(1, seekBarWidth.current);
  const playedPx = progress * trackWidth;
  const halfGap = (SEEK_THUMB_GAP * uiScale) / 2;
  const playedEnd = Math.max(0, Math.min(trackWidth, playedPx - halfGap));
  const unplayedStart = Math.max(0, Math.min(trackWidth, playedPx + halfGap));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="player-root">
      <View style={StyleSheet.absoluteFill} {...surfacePan.panHandlers}>
        <Pressable
          style={StyleSheet.absoluteFill}
          testID="player-surface"
          accessibilityLabel={labels.videoSurface}
          focusable={!tv}
          onPressIn={(evt) => { pressInAt.current = evt.nativeEvent.timestamp; }}
          onPress={onSurfacePress}
        />
      </View>
      <Animated.View
        style={[styles.overlay, { opacity: fadeAnim }]}
        pointerEvents={visible ? "box-none" : "none"}
        onLayout={(e) => { overlayHeight.current = e.nativeEvent.layout.height; reportBottomInset(); }}
      >
        <View style={styles.topBarLayer} pointerEvents="box-none">
          <View style={styles.topBar} pointerEvents="box-none" testID="player-top-bar">
            <ChromeIconButton ref={closeRef} theme={theme} testID="player-close" label={labels.closePlayer} onPress={onBackPress ?? (() => {})} {...chromeFocus}>
              <ChromeGlyphIcon kind="back" scale={uiScale} />
            </ChromeIconButton>
            {title ? (
              <Text testID="player-now-playing" style={styles.nowPlaying} numberOfLines={1}>{title}</Text>
            ) : null}
            <View style={styles.topSpacer} />
            {hasChapters && (
              <ChromeIconButton ref={chaptersRef} theme={theme} testID="player-chapters-button" label={labels.chapters} onPress={() => setSheet("chapters")} {...chromeFocus}>
                <ChromeGlyphIcon kind="chapters" scale={uiScale} />
              </ChromeIconButton>
            )}
            {onCastPress && (
              <ChromeIconButton theme={theme} testID="player-cast-button" label={labels.cast ?? "Cast"} onPress={onCastPress} {...chromeFocus}>
                <ChromeGlyphIcon kind="cast" scale={uiScale} />
              </ChromeIconButton>
            )}
            <ChromeIconButton ref={subtitlesRef} theme={theme} testID="player-subtitles-button" label={labels.subtitles} onPress={() => openSubtitleMenu("button")} {...chromeFocus}>
              <ChromeGlyphIcon kind="subtitles" scale={uiScale} />
            </ChromeIconButton>
            <ChromeIconButton ref={audioRef} theme={theme} testID="player-audio-button" label={labels.audio} onPress={() => setSheet("audio")} {...chromeFocus}>
              <ChromeGlyphIcon kind="audio" scale={uiScale} />
            </ChromeIconButton>
            <ChromeIconButton ref={qualityRef} theme={theme} testID="player-quality-button" label={labels.quality} onPress={() => setSheet("video")} {...chromeFocus}>
              <ChromeGlyphIcon kind="quality" scale={uiScale} />
            </ChromeIconButton>
          </View>
        </View>

        <View style={styles.centerLayer} pointerEvents="box-none">
          <View style={styles.centerControls} pointerEvents="box-none" testID="player-centre-controls">
            {onPreviousEpisode && (
              <ChromeRoundButton theme={theme} size={56 * uiScale} testID="player-previous-episode" label={labels.previousEpisode} onPress={onPreviousEpisode} {...chromeFocus}>
                <ChromeGlyphIcon kind="previous" size={20} scale={uiScale} />
              </ChromeRoundButton>
            )}
            <ChromeRoundButton ref={playRef} theme={theme} size={64 * uiScale} testID="player-play-pause" label={state.paused ? labels.play : labels.pause} onPress={togglePause} {...chromeFocus}>
              <ChromeGlyphIcon kind={state.paused ? "play" : "pause"} size={26} scale={uiScale} />
            </ChromeRoundButton>
            {onNextEpisode && (
              <ChromeRoundButton theme={theme} size={56 * uiScale} testID="player-next-episode" label={labels.nextEpisode} onPress={onNextEpisode} {...chromeFocus}>
                <ChromeGlyphIcon kind="next" size={20} scale={uiScale} />
              </ChromeRoundButton>
            )}
          </View>
        </View>

        <View
          style={styles.bottomBarLayer}
          pointerEvents="box-none"
          onLayout={(e) => { bottomBarTop.current = e.nativeEvent.layout.y; reportBottomInset(); }}
        >
          <View style={styles.bottomBar} pointerEvents="box-none">
            <Text style={styles.timeText}>{formatTime(displayTime)}</Text>
            {/* TV: left / right on the focused bar jump 10 s (the remote handler); the guide keeps the native focus
                engine from also moving the focus sideways to Close or Quality. Up still leaves for the centre row. */}
            <SeekWrap {...seekWrapProps}>
              <View
                ref={progressRef}
                style={styles.seekBarOuter}
                testID="player-timeline"
                accessibilityLabel={labels.seekBar}
                {...(tv ? { focusable: visible, onFocus: () => setProgressFocus(true), onBlur: () => setProgressFocus(false) } : {})}
                onLayout={onSeekBarLayout}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderTerminationRequest={() => false}
                onResponderGrant={onSeekGrant}
                onResponderMove={onSeekMove}
                onResponderRelease={onSeekRelease}
                onResponderTerminate={onSeekRelease}
              >
                {tv && progressFocused && (
                  <View pointerEvents="none" testID="player-timeline-focus" style={[styles.seekFocusRing, { borderColor: theme.accent }]} />
                )}
                {playedEnd > 0 && (
                  <View style={[styles.seekSegment, { left: 0, width: playedEnd, backgroundColor: theme.accent }]} />
                )}
                {unplayedStart < trackWidth && (
                  <View style={[styles.seekSegment, { left: unplayedStart, width: trackWidth - unplayedStart, backgroundColor: theme.unplayedAccent }]} />
                )}
                <View style={[styles.seekThumb, { left: playedPx - (SEEK_THUMB_WIDTH * uiScale) / 2 }]} />
                {!scrubShown && previewPicture}
              </View>
            </SeekWrap>
            <Text style={styles.timeText}>{formatTime(seekBarDuration)}</Text>
          </View>
        </View>
      </Animated.View>

      {scrubShown && tvAim !== null && (() => {
        // Same geometry as the overlay's bar (its measured width), drawn without the rest of the chrome and never
        // focusable: the remote keeps seeking from the video, as with the controls hidden.
        const aimPx = seekBarDuration > 0 ? Math.max(0, Math.min(trackWidth, (tvAim / seekBarDuration) * trackWidth)) : 0;
        const aimPlayedEnd = Math.max(0, Math.min(trackWidth, aimPx - halfGap));
        const aimUnplayedStart = Math.max(0, Math.min(trackWidth, aimPx + halfGap));
        return (
          <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="player-scrub">
            <View style={styles.scrubBackdrop} />
            <View style={styles.bottomBarLayer}>
              <View style={styles.bottomBar}>
                <Text style={styles.timeText}>{formatTime(tvAim)}</Text>
                <View style={styles.seekBarOuter} testID="player-scrub-bar">
                  {aimPlayedEnd > 0 && (
                    <View style={[styles.seekSegment, { left: 0, width: aimPlayedEnd, backgroundColor: theme.accent }]} />
                  )}
                  {aimUnplayedStart < trackWidth && (
                    <View style={[styles.seekSegment, { left: aimUnplayedStart, width: trackWidth - aimUnplayedStart, backgroundColor: theme.unplayedAccent }]} />
                  )}
                  <View testID="player-scrub-thumb" style={[styles.seekThumb, { left: aimPx - (SEEK_THUMB_WIDTH * uiScale) / 2 }]} />
                  {previewPicture}
                </View>
                <Text style={styles.timeText}>{formatTime(seekBarDuration)}</Text>
              </View>
            </View>
          </View>
        );
      })()}

      {seekToast && (
        <View
          pointerEvents="none"
          style={[styles.seekToast, seekToast.side === "left" ? { left: "12%" } : { right: "12%" }]}
        >
          <Text style={styles.seekToastText}>{seekToast.label}</Text>
        </View>
      )}

      {notice && (
        <View pointerEvents="none" style={styles.notice} accessibilityLiveRegion="polite">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}

      {slideHud && (
        <View pointerEvents="none" style={[styles.slideHud, slideHud.target === "brightness" ? { left: "8%" } : { right: "8%" }]}>
          <Text style={styles.slideHudTitle}>{slideHud.target === "volume" ? labels.volume : labels.brightness}</Text>
          <View style={styles.slideHudTrack}>
            <View style={[styles.slideHudFill, { width: `${Math.round(slideHud.level * 100)}%` }]} />
          </View>
          <Text style={styles.slideHudValue}>{`${Math.round(slideHud.level * 100)}%`}</Text>
        </View>
      )}

      {shownSheet !== "none" && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.sheetBackdrop,
              { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }) },
            ]}
            pointerEvents="auto"
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheet("none")} focusable={!tv} />
          </Animated.View>
          <SheetWrap style={styles.sheetWrap} pointerEvents="box-none" {...sheetWrapProps}>
            <Animated.View
              onLayout={onSheetLayout}
              style={[styles.sheet, { width: sheetMaxWidth, transform: [{ translateY: sheetY }] }]}
              {...sheetPan.panHandlers}
            >
              <View style={styles.sheetHandleHitArea}>
                <View style={styles.sheetHandle} />
              </View>
              {tv && TAB_SHEETS.includes(shownSheet) ? (
                <View style={styles.sheetTabs} testID="player-sheet-tabs">
                  {TAB_SHEETS.map((kind) => (
                    <Text key={kind} style={[styles.sheetTab, kind === shownSheet && styles.sheetTabActive]}>
                      {kind === "subtitles" ? labels.subtitles : kind === "audio" ? labels.audio : labels.quality}
                    </Text>
                  ))}
                </View>
              ) : null}
              <Text style={styles.sheetTitle}>{sheetTitle}</Text>
              <ScrollView
                ref={sheetScrollRef}
                style={styles.sheetScroll}
                contentContainerStyle={styles.sheetScrollContent}
                onLayout={tv ? onSheetScrollLayout : undefined}
              >
                {shownSheet === "chapters" && chapters.map((c, i) => (
                  <ChapterRow
                    key={i}
                    theme={theme}
                    index={i}
                    title={c.title}
                    start={c.startSeconds}
                    selected={i === currentChapterIdx}
                    tv={tv}
                    uiScale={uiScale}
                    onLayout={tv && i === currentChapterIdx ? onSelectedRowLayout : undefined}
                    onPress={() => { seekToChapter(i); setSheet("none"); }}
                  />
                ))}
                {shownSheet === "video" && videoRows.map((r) => <PickerRowView key={r.key} theme={theme} row={r} tv={tv} uiScale={uiScale} onLayout={tv && r.selected ? onSelectedRowLayout : undefined} />)}
                {shownSheet === "audio" && audioRows.map((r) => <PickerRowView key={r.key} theme={theme} row={r} tv={tv} uiScale={uiScale} onLayout={tv && r.selected ? onSelectedRowLayout : undefined} />)}
                {shownSheet === "subtitles" && subtitleRows.map((r) => <PickerRowView key={r.key} theme={theme} row={r} tv={tv} uiScale={uiScale} onLayout={tv && r.selected ? onSelectedRowLayout : undefined} />)}
              </ScrollView>
            </Animated.View>
          </SheetWrap>
        </View>
      )}
    </View>
  );
};

// --- Chrome button primitives -------------------------------------------------

/** react-native-tvos adds `focused` to the Pressable style callback state at runtime; the bundled typings omit it. */
type FocusState = PressableStateCallbackType & { focused?: boolean };

/**
 * The TV D-pad side of a chrome button (UX-TV-01): on the D-pad only while the overlay is up; phones leave it out.
 * `uiScale`: the chrome's size multiplier (UX-TV-13), default 1.
 */
type ChromeFocusProps = { tv?: boolean; visible?: boolean; onFocus?: () => void; uiScale?: number };

/**
 * Pressable props of a chrome button. On TV the button takes the D-pad focus while the overlay is visible, with the
 * TV shell's look while focused (accent ring, light fill, slight zoom: `TvFocusable`); a focus move restarts the
 * auto-hide (`onFocus`). Phones touch them and never set `focusable`.
 */
const chromePressableProps = (theme: PlayerControlsTheme, { tv, visible, onFocus, uiScale = 1 }: ChromeFocusProps, base: StyleProp<ViewStyle>) =>
  tv
    ? {
        focusable: visible === true,
        onFocus,
        tvParallaxProperties: { enabled: false },
        style: (state: FocusState) => [
          base,
          state.focused === true
            ? { borderWidth: TV_FOCUS_RING_WIDTH * uiScale, borderColor: theme.accent, backgroundColor: "rgba(255, 255, 255, 0.24)", transform: [{ scale: 1.06 }] }
            : null,
        ],
      }
    : { style: base };

type ChromeIconButtonProps = ChromeFocusProps & { theme: PlayerControlsTheme; onPress: () => void; testID?: string; label: string; glyph?: string; text?: string; children?: React.ReactNode };

const ChromeIconButton = React.forwardRef<TvViewInstance, ChromeIconButtonProps>(({ theme, onPress, testID, label, glyph, text, children, ...focus }, ref) => {
  const scale = focus.uiScale ?? 1;
  const styles = stylesFor(theme, scale);
  return (
    <Pressable ref={ref} onPress={onPress} {...chromePressableProps(theme, focus, styles.chromeIconButton)} hitSlop={4 * scale} testID={testID} accessibilityRole="button" accessibilityLabel={label}>
      {children ?? (
        <>
          {glyph != null && <Text style={styles.chromeGlyph}>{glyph}</Text>}
          {text != null && <Text style={styles.chromeText}>{text}</Text>}
        </>
      )}
    </Pressable>
  );
});

/**
 * The Badger design's player icons (PLAY-OVL-04), lucide's geometry as the mockup draws it: Cast, Captions, AudioLines,
 * Settings and Menu (chapters) in the top-right row, ArrowLeft for back, filled Play / Pause and SkipBack / SkipForward in
 * the centre. `size` dp at 1x (18 by default), drawn at `scale`.
 */
type ChromeGlyphKind = "cast" | "subtitles" | "audio" | "quality" | "chapters" | "back" | "play" | "pause" | "previous" | "next";
const ChromeGlyphIcon: React.FC<{ kind: ChromeGlyphKind; scale?: number; color?: string; size?: number }> = ({ kind, scale = 1, color = "#fff", size: base = 18 }) => {
  const size = Math.round(base * scale);
  const stroke = { stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" } as const;
  // The mockup fills play, pause and the skips (`fill:currentColor`), keeping lucide's 2-wide rounded outline.
  const solid = { ...stroke, fill: color } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" testID={`player-icon-${kind}`}>
      {kind === "cast" && (
        <>
          <Path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" {...stroke} />
          <Path d="M2 12a9 9 0 0 1 8 8" {...stroke} />
          <Path d="M2 16a5 5 0 0 1 4 4" {...stroke} />
          <Line x1="2" x2="2.01" y1="20" y2="20" {...stroke} />
        </>
      )}
      {kind === "subtitles" && (
        <>
          <Rect width="18" height="14" x="3" y="5" rx="2" ry="2" {...stroke} />
          <Path d="M7 15h4M15 15h2M7 11h2M13 11h4" {...stroke} />
        </>
      )}
      {kind === "audio" && <Path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" {...stroke} />}
      {kind === "chapters" && <Path d="M4 5h16M4 12h16M4 19h16" {...stroke} />}
      {kind === "back" && <Path d="m12 19-7-7 7-7M19 12H5" {...stroke} />}
      {kind === "play" && <Path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" {...solid} />}
      {kind === "pause" && (
        <>
          <Rect x="14" y="3" width="5" height="18" rx="1" {...solid} />
          <Rect x="5" y="3" width="5" height="18" rx="1" {...solid} />
        </>
      )}
      {kind === "previous" && (
        <>
          <Path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" {...solid} />
          <Path d="M3 20V4" {...stroke} />
        </>
      )}
      {kind === "next" && (
        <>
          <Path d="M21 4v16" {...stroke} />
          <Path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" {...solid} />
        </>
      )}
      {kind === "quality" && (
        <>
          <Path
            d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"
            {...stroke}
          />
          <Circle cx="12" cy="12" r="3" {...stroke} />
        </>
      )}
    </Svg>
  );
};

type ChromeRoundButtonProps = ChromeFocusProps & { theme: PlayerControlsTheme; size: number; onPress: () => void; testID?: string; label: string; children: React.ReactNode };

const ChromeRoundButton = React.forwardRef<TvViewInstance, ChromeRoundButtonProps>(({ theme, size, onPress, testID, label, children, ...focus }, ref) => {
  const styles = stylesFor(theme, focus.uiScale ?? 1);
  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...chromePressableProps(theme, focus, [styles.chromeRoundButton, { width: size, height: size, borderRadius: size / 2 }])}
      hitSlop={6 * (focus.uiScale ?? 1)}
    >
      {children}
    </Pressable>
  );
});

// --- Picker rows --------------------------------------------------------------

type PickerRow = {
  key: string;
  testID?: string;
  title: string;
  subtitle?: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
};

/**
 * A menu row on TV: always focusable (the menu traps focus), ring + highlight while focused, focus starts on the selected
 * row. Ring and corner are drawn at `uiScale` (UX-TV-13).
 */
const tvRowProps = (theme: PlayerControlsTheme, tv: boolean | undefined, selected: boolean, base: StyleProp<ViewStyle>, uiScale = 1) =>
  tv
    ? {
        hasTVPreferredFocus: selected,
        tvParallaxProperties: { enabled: false },
        style: (state: FocusState) => {
          const focused = state.focused === true;
          return [
            base,
            {
              borderWidth: TV_FOCUS_RING_WIDTH * uiScale,
              borderRadius: 16 * uiScale,
              borderColor: focused ? theme.accent : "transparent",
              backgroundColor: focused ? "rgba(255, 255, 255, 0.14)" : undefined,
            },
          ];
        },
      }
    : { style: base };

const PickerRowView: React.FC<{ theme: PlayerControlsTheme; row: PickerRow; tv?: boolean; uiScale?: number; onLayout?: (e: LayoutChangeEvent) => void }> = ({ theme, row, tv, uiScale = 1, onLayout }) => {
  const styles = stylesFor(theme, uiScale);
  const greyed = row.disabled === true;
  return (
    <Pressable
      // A greyed row picks nothing. On TV it stays focusable so the remote moves through it like any row (a disabled
      // view can't take focus, and DOWN past the last pickable row lost the ring to the ScrollView), as the greyed
      // episodes do (UX-TV-08); on a phone it is a disabled control (PLAY-TRACK-05).
      onPress={greyed ? undefined : row.onPress}
      disabled={greyed && !tv}
      onLayout={onLayout}
      {...tvRowProps(theme, tv, row.selected, styles.row, uiScale)}
      testID={row.testID}
      accessibilityRole="button"
      accessibilityLabel={pickerRowAccessibilityLabel(row)}
      accessibilityState={{ selected: row.selected, disabled: row.disabled === true }}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
    >
      <Text style={[styles.rowTitle, row.selected && styles.rowTitleActive, row.disabled === true && styles.rowDisabled]} numberOfLines={1}>
        {row.title}
      </Text>
      {row.subtitle && (
        <Text style={[styles.rowSubtitle, row.selected && styles.rowSubtitleActive, row.disabled === true && styles.rowDisabled]}>
          {row.subtitle}
        </Text>
      )}
    </Pressable>
  );
};

const ChapterRow: React.FC<{ theme: PlayerControlsTheme; index: number; title: string; start: number; selected: boolean; tv?: boolean; uiScale?: number; onLayout?: (e: LayoutChangeEvent) => void; onPress: () => void }> = ({ theme, index, title, start, selected, tv, uiScale = 1, onLayout, onPress }) => {
  const styles = stylesFor(theme, uiScale);
  const heading = chapterRowTitle(index, title);
  return (
    <Pressable
      onPress={onPress}
      onLayout={onLayout}
      {...tvRowProps(theme, tv, selected, styles.row, uiScale)}
      testID={`player-chapter-row-${index}`}
      accessibilityRole="button"
      accessibilityLabel={pickerRowAccessibilityLabel({ title: heading, subtitle: formatTime(start) })}
      accessibilityState={{ selected }}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
    >
      <Text style={[styles.rowTitle, selected && styles.rowTitleActive]} numberOfLines={1}>
        {heading}
      </Text>
      <Text style={[styles.rowSubtitle, selected && styles.rowSubtitleActive]}>
        {formatTime(start)}
      </Text>
    </Pressable>
  );
};

// --- Styles -------------------------------------------------------------------

type ControlsStyles = ReturnType<typeof makeStyles>;
const stylesByTheme = new WeakMap<PlayerControlsTheme, ControlsStyles>();

/**
 * One style sheet per theme object. Every chrome button and menu row used to rebuild the whole sheet on every render,
 * and the overlay re-renders on each playback tick: dozens of full `StyleSheet.create` calls a second on the JS thread.
 * The sheet is in design dp; `uiScale` (UX-TV-13) draws it larger, memoised per sheet and scale (the sheet itself at 1).
 */
const stylesFor = (theme: PlayerControlsTheme, uiScale: number): ControlsStyles => {
  let styles = stylesByTheme.get(theme);
  if (!styles) {
    styles = makeStyles(theme);
    stylesByTheme.set(theme, styles);
    console.info("player.controls.styles.created");
  }
  return scaleStyleSheet(styles, uiScale);
};

const makeStyles = (theme: PlayerControlsTheme) => StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.30)",
    // No justifyContent — each control row is its own absolute layer below.
    // Under RN 0.85 + Fabric, mixing position:absolute siblings with an
    // in-flow centered sibling collapsed all three rows to the top edge.
  },
  topBarLayer: {
    position: "absolute", top: 12, left: 12, right: 12,
  },
  topBar: {
    flexDirection: "row", alignItems: "center", gap: 6,
  },
  topSpacer: { flex: 1 },
  chromeIconButton: {
    width: MIN_TARGET_DP, height: MIN_TARGET_DP, borderRadius: MIN_TARGET_DP / 2,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.chromeBackground,
    borderWidth: 1, borderColor: theme.chromeBorder,
  },
  chromeRoundButton: {
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.chromeBackground,
    borderWidth: 1, borderColor: theme.chromeBorder,
  },
  nowPlaying: {
    color: "#fff", fontSize: 16, fontWeight: "600",
    flexShrink: 1, marginLeft: 12,
    textShadowColor: "rgba(0, 0, 0, 0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  chromeGlyph: {
    color: "#fff", fontSize: 20,
    textAlign: "center", textAlignVertical: "center",
    includeFontPadding: false,
  },
  chromeText: {
    color: "#fff", fontSize: 13, fontWeight: "700", letterSpacing: 0.5,
  },
  centerLayer: {
    ...StyleSheet.absoluteFill,
    alignItems: "center", justifyContent: "center",
  },
  centerControls: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 32,
  },
  bottomBarLayer: {
    position: "absolute", bottom: 16, left: 16, right: 16,
  },
  /** TV scrub bar with the controls hidden: a dark strip under the bar so it reads over any picture. */
  scrubBackdrop: {
    position: "absolute", left: 0, right: 0, bottom: 0, height: 96, backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  bottomBar: {
    flexDirection: "row", alignItems: "center", gap: 14,
  },
  timeText: {
    color: "#fff", fontSize: 14, fontVariant: ["tabular-nums"],
    fontWeight: "500", minWidth: 60, textAlign: "center",
    textShadowColor: "rgba(0, 0, 0, 0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  /** TV: the focus guide around the progress bar takes the bar's place in the row. */
  seekBarSlot: { flex: 1 },
  seekBarOuter: { flex: 1, height: 48, justifyContent: "center" },
  /** TV: ring around the progress bar while it holds the D-pad focus (left / right seek there). */
  seekFocusRing: {
    position: "absolute", left: -10, right: -10, top: 4, bottom: 4,
    borderWidth: TV_FOCUS_RING_WIDTH, borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.10)",
  },
  seekSegment: {
    position: "absolute",
    top: (48 - SEEK_TRACK_HEIGHT) / 2,
    height: SEEK_TRACK_HEIGHT,
    borderRadius: SEEK_TRACK_HEIGHT / 2,
  },
  seekThumb: {
    position: "absolute",
    top: (48 - SEEK_THUMB_HEIGHT) / 2,
    width: SEEK_THUMB_WIDTH,
    height: SEEK_THUMB_HEIGHT,
    borderRadius: SEEK_THUMB_WIDTH / 2,
    backgroundColor: theme.accent,
  },
  seekToast: {
    position: "absolute", top: "40%",
    minWidth: 72, height: 48, paddingHorizontal: 16, borderRadius: 24,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.55)",
  },
  seekToastText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  notice: {
    position: "absolute", top: "18%", alignSelf: "center",
    paddingVertical: 12, paddingHorizontal: 20, borderRadius: 24,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
  },
  noticeText: { color: "#fff", fontSize: 15, fontWeight: "600", textAlign: "center" },
  slideHud: {
    position: "absolute", top: "38%",
    width: 180, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 18,
    alignItems: "center", gap: 8,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  slideHudTitle: { color: "#fff", fontSize: 14, fontWeight: "700" },
  slideHudTrack: { width: "100%", height: 6, borderRadius: 3, backgroundColor: "rgba(255, 255, 255, 0.25)", overflow: "hidden" },
  slideHudFill: { height: "100%", borderRadius: 3, backgroundColor: theme.accent },
  slideHudValue: { color: "#fff", fontSize: 13, fontWeight: "600" },
  sheetBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: "#000" },
  sheetWrap: {
    ...StyleSheet.absoluteFill,
    alignItems: "center", justifyContent: "flex-end", paddingBottom: 16,
  },
  sheet: {
    backgroundColor: theme.sheetBackground,
    borderRadius: 24, paddingTop: 6, paddingBottom: 12,
    maxHeight: "85%", overflow: "hidden",
    elevation: 8,
    shadowColor: "#000", shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.4, shadowRadius: 8,
  },
  sheetHandleHitArea: {
    paddingTop: 6, paddingBottom: 8, alignItems: "center", justifyContent: "center",
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: "rgba(255, 255, 255, 0.35)",
  },
  sheetTitle: {
    color: "rgba(255, 255, 255, 0.6)",
    fontSize: 12, fontWeight: "700",
    textTransform: "uppercase", letterSpacing: 1.4,
    paddingHorizontal: 24, paddingTop: 4, paddingBottom: 8,
  },
  sheetScroll: { flexGrow: 0 },
  sheetScrollContent: { paddingBottom: 8 },
  row: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    minHeight: MIN_TARGET_DP,
    paddingHorizontal: 24, paddingVertical: 14, gap: 12,
  },
  rowTitle: { color: "#fff", fontSize: 16, flex: 1 },
  rowTitleActive: {
    color: theme.accent, fontStyle: "italic", fontWeight: "800",
  },
  rowSubtitle: {
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: 14, fontVariant: ["tabular-nums"],
  },
  rowSubtitleActive: {
    color: theme.accent, fontStyle: "italic", fontWeight: "800",
  },
  rowDisabled: { opacity: 0.35 },
  sheetTabs: {
    flexDirection: "row", gap: 24, paddingHorizontal: 24, paddingBottom: 8,
  },
  sheetTab: { color: "rgba(255, 255, 255, 0.55)", fontSize: 16 },
  sheetTabActive: { color: theme.accent, fontWeight: "800" },
});
