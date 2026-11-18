/**
 * The TV player's remote control (MPV-TV-01, UX-TV-01: the TV plays through the embedded mpv, driven by the D-pad):
 * pure decisions, no React and no native module, so every key in every state is unit-testable.
 *
 * Three layers:
 *  - `remoteKeyFromEvent` turns a react-native-tvos `useTVEventHandler` event into a key (or null for noise: key-down,
 *    touch-surface pans, keys the player does not use);
 *  - `remoteHoldFromEvent` / `holdStepSeconds` read a held left / right (the accelerating scrub);
 *  - `remoteAction` decides what a key does given what is on screen;
 *  - `remoteScrubContext` / `swipeHandledByPan` hand the Siri Remote's touch surface to the speed-following scrub
 *    (`touchScrub.ts`) where left / right jump, so a left / right swipe there is not also a 10 s jump.
 *
 * UX-TV-01 as implemented (Chris 2026-10-29): with the video alone, OK pauses / plays and shows the controls, left /
 * right jump (faster when held), UP shows the controls with the focus on the top-right row (Chapters, else subtitles),
 * DOWN shows them with the focus on the progress bar. With the controls up the D-pad moves the focus between their
 * buttons natively and OK presses the focused one; on the progress bar left / right jump instead. Back hides the
 * controls and a second Back leaves. The remote's subtitles key (KEYCODE_CAPTIONS, event type `captions`) opens the
 * subtitles menu. Inside a track menu the D-pad moves between rows natively and left / right switch the menu
 * (subtitles / audio / quality). A prompt (resume, error, "Skip intro", next episode, device-too-weak / traffic-cap
 * notice) owns the focus and its button is already selected: OK presses it natively, Back dismisses a skip pill, the
 * next-episode card or a notice (a notice first, even over an open menu: Back closes the topmost thing).
 *
 * Remote transport keys: play / pause (Android KEYCODE_MEDIA_PLAY / KEYCODE_MEDIA_PAUSE, sent by some Android TV
 * remotes, HDMI-CEC and keyboards) play or pause whatever the current state; play/pause (Fire TV, Siri Remote,
 * KEYCODE_MEDIA_PLAY_PAUSE) toggles; rewind / fast-forward jump 10 s, all of them also under the next-episode card and
 * the notices, but not under a resume or error prompt; stop (KEYCODE_MEDIA_STOP) leaves the player for
 * the title in every state. react-native-tvos's Android root view (`modules/core/ReactAndroidHWInputDeviceHelper`)
 * already turns those key codes (and KEYCODE_CAPTIONS) into the `useTVEventHandler` event types read here, so no native
 * code is needed. The
 * Siri Remote has only play/pause (tvOS `playPause`), covered by the toggle.
 */

export type RemoteKey =
  | "left"
  | "right"
  | "up"
  | "down"
  | "select"
  | "playPause"
  | "play"
  | "pause"
  | "stop"
  | "rewind"
  | "fastForward"
  /** The remote's subtitles / captions key (Android KEYCODE_CAPTIONS). */
  | "captions"
  | "back";

/** What is on screen, as far as the remote cares. */
export type RemoteContext = {
  /** The controls overlay (top bar, play/pause, seek bar) is visible. */
  overlayVisible: boolean;
  /** An audio / subtitle / quality / chapter menu is open. */
  sheetOpen: boolean;
  /** A prompt owns the focus: resume, error, next-episode card, device-too-weak or traffic-cap notice. */
  promptOpen: boolean;
  /** The next-episode card is the open prompt: Back dismisses it (keep watching) instead of leaving. */
  nextCardOpen: boolean;
  /**
   * The device-too-weak or traffic-cap notice is the open prompt (drawn over the controls and any menu): Back dismisses
   * it, like its "Keep watching" button, instead of leaving.
   */
  noticeOpen: boolean;
  /** A "Skip intro" / "Skip credits" pill is showing, focused: OK presses it, Back dismisses it. */
  pillVisible: boolean;
  /** The controls are up and the D-pad focus is on the progress bar: left / right jump instead of moving the focus. */
  progressFocused: boolean;
};

/**
 * The screen's context as of the key: `controlsVisible` is the controls' own reading at that moment
 * (`PlayerControlsHandle.isVisible`). The screen learns that the controls hid or came up one re-render later:
 * - a key pressed right after their fade-out ended (~20 ms, run 20261116-113824) still read `overlayVisible: true`: it
 *   was decided as a focus move on buttons no longer on screen and did nothing. Once they are gone the key is one on
 *   the bare video (UX-TV-01: "with the controls hidden: … left and right jump 10 seconds back or forward …").
 * - a Back pressed right after OK paused and showed them, during a 1.5 s JS stall (tv-player run on PR #2806), still
 *   read `overlayVisible: false` and left the player. Once they are up, Back hides them (UX-TV-01).
 * An open menu keeps the controls up whatever they say; no reading yet leaves the context as it is.
 */
export const liveRemoteContext = (context: RemoteContext, controlsVisible: boolean | undefined): RemoteContext => {
  if (controlsVisible === undefined || controlsVisible === context.overlayVisible || context.sheetOpen) return context;
  return controlsVisible ? { ...context, overlayVisible: true } : { ...context, overlayVisible: false, progressFocused: false };
};

/** The menu the player opens from the remote's own subtitles key. */
export type RemoteSheet = "subtitles";

/** Where the D-pad focus lands when a key brings the controls up: the top-right row or the progress bar. */
export type RemoteFocus = "top" | "progress";

export type RemoteAction =
  /** Seek by one step: `direction` -1 = back, +1 = forward (the step itself is the player's, SEEK_STEP_SECONDS). */
  | { type: "seek"; direction: -1 | 1 }
  | { type: "toggle-pause" }
  /** The remote's separate play / pause keys: set the pause state, idempotent (play on a playing video does nothing). */
  | { type: "set-paused"; paused: boolean }
  /** OK on the video: toggle pause and show the controls. */
  | { type: "toggle-pause-and-show" }
  /** Show the controls with the D-pad focus on `focus`. */
  | { type: "show-overlay"; focus: RemoteFocus }
  | { type: "hide-overlay" }
  | { type: "open-sheet"; sheet: RemoteSheet }
  /** Left / right inside the subtitles / audio / quality menus: switch to the neighbouring menu. */
  | { type: "cycle-sheet"; direction: -1 | 1 }
  | { type: "close-sheet" }
  /** Back on a skip pill / the next-episode card / a "Keep watching" notice: dismiss it and keep watching. */
  | { type: "dismiss-prompt"; prompt: "pill" | "next-card" | "notice" }
  | { type: "leave-player" }
  /** The key belongs to the platform focus engine (it moves focus / presses the focused control): do nothing here. */
  | { type: "native-focus" }
  | { type: "ignore" };

/**
 * `eventKeyAction` of the native key events: 0 down, 1 up, -1 / absent unknown (tvOS gesture recognisers). A press acts
 * on release: the Android TV emulator delivers only the key-up to `useTVEventHandler` (verified in logcat), so waiting
 * for a key-down would never fire; if a device delivers both, only the up acts, so the press still counts once.
 */
const KEY_ACTION_DOWN = 0;
const KEY_ACTION_UP = 1;

const KEY_BY_EVENT_TYPE: Readonly<Record<string, RemoteKey>> = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  select: "select",
  playPause: "playPause",
  play: "play",
  pause: "pause",
  stop: "stop",
  rewind: "rewind",
  fastForward: "fastForward",
  captions: "captions",
};

/**
 * A finished swipe on the Siri Remote's touch surface is the arrow it points to (tvOS sends `swipeUp` ... once per swipe,
 * with the recogniser's state `Ended`). The Siri Remote's ring can also be clicked, which arrives as the plain arrow.
 * Where left / right jump, a left / right swipe is the touch scrub's instead (`swipeHandledByPan`), not an arrow.
 */
const KEY_BY_SWIPE_TYPE: Readonly<Record<string, RemoteKey>> = {
  swipeLeft: "left",
  swipeRight: "right",
  swipeUp: "up",
  swipeDown: "down",
};

/** The part of a `useTVEventHandler` event the player reads. */
export type RemoteEvent = { eventType?: unknown; eventKeyAction?: unknown; body?: unknown };

const swipeEnded = (event: RemoteEvent): boolean => {
  const state = (event.body as { state?: unknown } | null | undefined)?.state;
  return state === undefined || state === "Ended";
};

/**
 * The key of a `useTVEventHandler` event, or null when it is not one the player acts on. Key-down is dropped so a press
 * acts once, on release; a swipe counts as its arrow once it has ended; long presses (`longLeft`, `longSelect`, ...)
 * and touch-surface pans (`pan`) have their own event types and so are not keys (a held left / right is read by
 * `remoteHoldFromEvent`).
 */
export const remoteKeyFromEvent = (event: RemoteEvent | null | undefined): RemoteKey | null => {
  if (!event || typeof event.eventType !== "string") return null;
  const swipe = KEY_BY_SWIPE_TYPE[event.eventType];
  if (swipe) return swipeEnded(event) ? swipe : null;
  if (Number(event.eventKeyAction) === KEY_ACTION_DOWN) return null;
  return KEY_BY_EVENT_TYPE[event.eventType] ?? null;
};

/**
 * Where a left / right jumps (the video alone, even under a skip pill, or the controls up with the focus on the
 * progress bar): the Siri Remote's touch surface scrubs there (`touchScrub.ts`, UX-TV-01, Chris 2026-11-08).
 */
export const remoteScrubContext = (context: RemoteContext): boolean => remoteAction("right", context).type === "seek";

/**
 * A finished left / right swipe that the touch-surface pan already scrubbed: with the pan on (Apple TV) and in the
 * scrub context, or while a scrub is under way (the controls coming up, the focus not landed on the bar yet), the swipe
 * is not also a 10 s jump nor a focus move. Elsewhere it stays the arrow; up / down swipes and ring clicks (plain
 * `left` / `right`) are never the pan's. Android TV has no pan (`panEnabled` false): nothing changes there.
 */
export const swipeHandledByPan = (
  event: RemoteEvent | null | undefined,
  context: RemoteContext,
  { panEnabled, scrubbing }: { panEnabled: boolean; scrubbing: boolean },
): boolean => {
  if (!panEnabled || !event) return false;
  if (event.eventType !== "swipeLeft" && event.eventType !== "swipeRight") return false;
  return scrubbing || remoteScrubContext(context);
};

/** One edge of a held left / right: `start` when the hold begins, `end` when the key is released. */
export type RemoteHold = { direction: -1 | 1; phase: "start" | "end" };

/**
 * A held left / right. react-native-tvos sends `longLeft` / `longRight` once when the hold crosses its threshold (key
 * action 0, down) and once on release (key action 1, up) - nothing in between and no plain `left` / `right` on release
 * (Android `ReactAndroidHWInputDeviceHelper`, tvOS long-press recogniser), so the scrub runs on a timer between the two
 * edges and a release cannot also fire a press. Any other key action is not an edge: tvOS reports a long press that
 * changes or is cancelled with no key action, and treating that as a start would restart (or never stop) the scrub.
 */
export const remoteHoldFromEvent = (event: RemoteEvent | null | undefined): RemoteHold | null => {
  if (!event || typeof event.eventType !== "string") return null;
  const direction = event.eventType === "longLeft" ? -1 : event.eventType === "longRight" ? 1 : null;
  if (direction === null) return null;
  const action = Number(event.eventKeyAction);
  if (action === KEY_ACTION_DOWN) return { direction, phase: "start" };
  if (action === KEY_ACTION_UP) return { direction, phase: "end" };
  return null;
};

/** How often a held key jumps again. */
export const HOLD_TICK_MS = 400;
/** Seek step once a hold has lasted this long: 10 s, then 30 s, then 60 s. */
const HOLD_STEPS: ReadonlyArray<{ fromMs: number; seconds: number }> = [
  { fromMs: 0, seconds: 10 },
  { fromMs: 1200, seconds: 30 },
  { fromMs: 3200, seconds: 60 },
];

/** The jump of the tick `heldMs` into a hold (0 = the first jump, on the hold's start). */
export const holdStepSeconds = (heldMs: number): number => {
  let seconds = HOLD_STEPS[0].seconds;
  for (const step of HOLD_STEPS) if (heldMs >= step.fromMs) seconds = step.seconds;
  return seconds;
};

/** A hold whose release never arrives (focus lost mid-hold) stops by itself after this long. */
export const HOLD_MAX_MS = 30_000;

/** Plain left / right presses right after a hold ends are the tail of that hold (tvOS tap recogniser), not a new jump. */
export const HOLD_RELEASE_GUARD_MS = 300;

const NATIVE_FOCUS: RemoteAction = { type: "native-focus" };
const IGNORE: RemoteAction = { type: "ignore" };

/**
 * What `key` does. Back closes the topmost thing first (UX-TV-01): a device-too-weak / traffic-cap notice, drawn over
 * everything including an open menu, is dismissed; then an open menu closes; then a next-episode card or skip pill is
 * dismissed; any other prompt (resume, error) is left with the player; then a visible overlay hides, and only with the
 * video alone does Back leave the player. Stop leaves the player at once, whatever is on screen.
 */
export const remoteAction = (key: RemoteKey, context: RemoteContext): RemoteAction => {
  const { overlayVisible, sheetOpen, promptOpen, nextCardOpen, noticeOpen, pillVisible, progressFocused } = context;

  if (key === "stop") return { type: "leave-player" };

  if (key === "back") {
    if (noticeOpen) return { type: "dismiss-prompt", prompt: "notice" };
    if (sheetOpen) return { type: "close-sheet" };
    if (nextCardOpen) return { type: "dismiss-prompt", prompt: "next-card" };
    if (promptOpen) return { type: "leave-player" };
    if (pillVisible) return { type: "dismiss-prompt", prompt: "pill" };
    if (overlayVisible) return { type: "hide-overlay" };
    return { type: "leave-player" };
  }

  // The dedicated transport keys never navigate: they drive playback whatever is on screen, except under a resume or
  // error prompt (before the first frame or on an error there is nothing to pause or seek). The video plays on under
  // the next-episode card and the notices, so the keys still act there.
  const transportBlocked = promptOpen && !nextCardOpen && !noticeOpen;
  if (key === "rewind") return transportBlocked ? IGNORE : { type: "seek", direction: -1 };
  if (key === "fastForward") return transportBlocked ? IGNORE : { type: "seek", direction: 1 };
  if (key === "playPause") return transportBlocked ? IGNORE : { type: "toggle-pause" };
  if (key === "play") return transportBlocked ? IGNORE : { type: "set-paused", paused: false };
  if (key === "pause") return transportBlocked ? IGNORE : { type: "set-paused", paused: true };

  // A prompt's focused button owns the directions and OK.
  if (promptOpen) return key === "captions" ? IGNORE : NATIVE_FOCUS;

  // The remote's subtitles key opens the subtitles menu from anywhere else, including another menu.
  if (key === "captions") return { type: "open-sheet", sheet: "subtitles" };

  // Inside a menu the focus engine walks the rows; left / right switch between the subtitles / audio / quality menus.
  if (sheetOpen) {
    if (key === "left") return { type: "cycle-sheet", direction: -1 };
    if (key === "right") return { type: "cycle-sheet", direction: 1 };
    return NATIVE_FOCUS;
  }

  // The controls up: their buttons are on the D-pad, so the arrows move the focus and OK presses the focused button,
  // except on the progress bar, where left / right jump.
  if (overlayVisible) {
    if (progressFocused && key === "left") return { type: "seek", direction: -1 };
    if (progressFocused && key === "right") return { type: "seek", direction: 1 };
    return NATIVE_FOCUS;
  }

  // The video alone: left / right jump, up / down bring the controls up with the focus where the user is heading. A
  // skip pill, when showing, holds the focus, so OK is its native press.
  switch (key) {
    case "left":
      return { type: "seek", direction: -1 };
    case "right":
      return { type: "seek", direction: 1 };
    case "up":
      return { type: "show-overlay", focus: "top" };
    case "down":
      return { type: "show-overlay", focus: "progress" };
    case "select":
      return pillVisible ? NATIVE_FOCUS : { type: "toggle-pause-and-show" };
  }
};
