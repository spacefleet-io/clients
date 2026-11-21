import { useCallback, useEffect, useRef, type RefObject } from "react";
import { BackHandler, Platform, StyleSheet, useTVEventHandler, View } from "react-native";
import type { TvViewInstance } from "@space/mobile-shell/tv/tvViewInstance";
import { MpvControl, type PlayerControlsHandle } from "@space/mobile-mpv-playback";
import {
  HOLD_MAX_MS,
  HOLD_RELEASE_GUARD_MS,
  HOLD_TICK_MS,
  holdStepSeconds,
  liveRemoteContext,
  remoteAction,
  remoteHoldFromEvent,
  remoteKeyFromEvent,
  remoteScrubContext,
  swipeHandledByPan,
  type RemoteContext,
  type RemoteEvent,
  type RemoteKey,
} from "../lib/playerRemote";
import {
  IDLE_SCRUB,
  panFromEvent,
  scrubCancel,
  scrubPan,
  scrubPending,
  scrubSelect,
  scrubTick,
  scrubTickDelay,
  type ScrubResult,
  type TouchScrub,
} from "../lib/touchScrub";
import { tvEventControl } from "@space/mobile-shell/tv/useTvMenuKey";

/** Touch-scrub steps are logged at most this often (a pan sends ~60 events a second); begin / end / commit always. */
const SCRUB_STEP_LOG_MS = 150;

export type TvPlayerRemoteProps = {
  /** The controls overlay's imperative handle (show / hide / seek / pause / menus). */
  controlsRef: RefObject<PlayerControlsHandle | null>;
  /** What is on screen right now: decides what each key does. */
  context: RemoteContext;
  /** Back on the skip pill / the next-episode card / a "Keep watching" notice: dismiss it and keep watching. */
  onDismissPrompt: (prompt: "pill" | "next-card" | "notice") => void;
  /** Stop on the remote: leave the player for the title (the player screen's own Back). */
  onLeave: () => void;
};

/** A hold in progress: its direction, when it started, and the timer repeating the jump. */
type Hold = { direction: -1 | 1; startedAt: number; timer: Parameters<typeof clearInterval>[0] };

/**
 * The TV player's remote (MPV-TV-01, UX-TV-01): listens to the remote's key events and the hardware Back key and
 * runs what `remoteAction` decides. Mounted by the player screen on TV only, while a video plays; the phone never
 * renders it. Every decision is logged (`tv.player.remote`) so a session's key presses can be replayed from the log.
 */
export const TvPlayerRemote = ({ controlsRef, context, onDismissPrompt, onLeave }: TvPlayerRemoteProps) => {
  /**
   * Back just closed a menu, and the screen has not re-rendered without it yet: keys pressed in between already see
   * it closed, so an arrow right after Back moves the focus instead of switching the closing menu's tab (issue 1004).
   */
  const sheetClosing = useRef(false);
  if (!context.sheetOpen) sheetClosing.current = false;
  const contextRef = useRef(context);
  contextRef.current = sheetClosing.current ? { ...context, sheetOpen: false } : context;
  const onDismissPromptRef = useRef(onDismissPrompt);
  onDismissPromptRef.current = onDismissPrompt;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  /** Before a key is decided: the controls' own reading beats a context the screen has not re-rendered yet. */
  const syncControlsVisible = useCallback(() => {
    contextRef.current = liveRemoteContext(contextRef.current, controlsRef.current?.isVisible());
  }, [controlsRef]);
  /** Runs one key; false when the player screen's own Back (leave the player) must take over. */
  const run = useCallback(
    (key: RemoteKey): boolean => {
      const action = remoteAction(key, contextRef.current);
      console.info("tv.player.remote", JSON.stringify({ key, action: action.type, detail: action, context: contextRef.current }));
      const controls = controlsRef.current;
      switch (action.type) {
        case "seek":
          controls?.stepSeek(action.direction);
          return true;
        case "toggle-pause":
          controls?.togglePause();
          return true;
        case "set-paused":
          // The remote's separate play / pause keys set the state instead of toggling it (play on a playing video
          // stays playing); a paused video brings the controls up through the overlay's own paused effect.
          console.info("tv.player.remote.set_paused", JSON.stringify({ paused: action.paused }));
          void MpvControl.setPaused(action.paused).catch((error: unknown) => {
            console.error("tv.player.remote.set_paused_failed", JSON.stringify({ paused: action.paused, error: String(error) }));
          });
          return true;
        case "toggle-pause-and-show":
          controls?.togglePause();
          controls?.show("play");
          return true;
        case "show-overlay":
          // Up lands on the top-right row, down on the progress bar (UX-TV-01, Chris 2026-10-29).
          controls?.show(action.focus);
          return true;
        case "hide-overlay":
          controls?.hide();
          return true;
        case "open-sheet":
          sheetClosing.current = false;
          controls?.openSheet(action.sheet);
          return true;
        case "cycle-sheet":
          controls?.cycleSheet(action.direction);
          return true;
        case "close-sheet":
          sheetClosing.current = true;
          contextRef.current = { ...contextRef.current, sheetOpen: false };
          controls?.closeSheet();
          return true;
        case "dismiss-prompt":
          onDismissPromptRef.current(action.prompt);
          return true;
        case "leave-player":
          return false;
        case "native-focus":
        case "ignore":
          return true;
      }
    },
    [controlsRef],
  );
  useEffect(() => {
    console.info("tv.player.remote.mounted");
    return () => console.info("tv.player.remote.unmounted");
  }, []);

  // A held left / right scrubs on a timer between the hold's start and end events (react-native-tvos sends nothing in
  // between): 10 s, then 30 s, then 60 s as the hold goes on (`holdStepSeconds`).
  const hold = useRef<Hold | null>(null);
  const lastHoldEndAt = useRef(0);
  const stopHold = useCallback((why: string) => {
    const current = hold.current;
    if (!current) return;
    clearInterval(current.timer);
    hold.current = null;
    lastHoldEndAt.current = Date.now();
    console.info("tv.player.remote.hold_end", JSON.stringify({ why, heldMs: Date.now() - current.startedAt }));
  }, []);
  useEffect(() => () => stopHold("unmount"), [stopHold]);

  const jumpHeld = useCallback(
    (current: Hold) => {
      const heldMs = Date.now() - current.startedAt;
      const action = remoteAction(current.direction < 0 ? "left" : "right", contextRef.current);
      if (action.type !== "seek" || heldMs > HOLD_MAX_MS) {
        stopHold(action.type !== "seek" ? "context" : "max");
        return;
      }
      const seconds = holdStepSeconds(heldMs);
      console.info("tv.player.remote.hold_step", JSON.stringify({ direction: current.direction, heldMs, seconds }));
      controlsRef.current?.stepSeek(current.direction, seconds);
    },
    [controlsRef, stopHold],
  );

  // The Siri Remote's touch surface scrubs where left / right jump (UX-TV-01, Chris 2026-11-08, `touchScrub.ts`): a
  // horizontal slide moves a pending target on the progress bar, further the faster the finger moves, the video playing
  // on; one seek goes when the finger has been off the surface a moment. Apple TV only: Android TV sends no pans.
  const panEnabled = useRef(false);
  useEffect(() => {
    const control = tvEventControl();
    if (!Platform.isTV || Platform.OS !== "ios" || !control?.enableTVPanGesture) {
      console.info("tv.player.scrub.pan_unavailable", JSON.stringify({ os: Platform.OS, isTV: Platform.isTV, control: !!control }));
      return undefined;
    }
    control.enableTVPanGesture();
    panEnabled.current = true;
    console.info("tv.player.scrub.pan_enabled");
    return () => {
      panEnabled.current = false;
      control.disableTVPanGesture?.();
      console.info("tv.player.scrub.pan_disabled");
    };
  }, []);

  const scrub = useRef<TouchScrub>(IDLE_SCRUB);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastStepLogAt = useRef(0);
  /** Runs a scrub transition's effects on the controls, then re-arms the commit timer. */
  const applyScrub = useCallback(
    (result: ScrubResult, why: string) => {
      scrub.current = result.state;
      const controls = controlsRef.current;
      for (const effect of result.effects) {
        switch (effect.type) {
          case "begin":
            console.info("tv.player.scrub.pan_begin", JSON.stringify({ why, ...effect, context: contextRef.current }));
            // The controls come up with the focus on the bar, which draws the pending target and its picture.
            if (!effect.resumed) controls?.show("progress");
            controls?.scrubTo(effect.target);
            break;
          case "step": {
            const now = Date.now();
            if (now - lastStepLogAt.current >= SCRUB_STEP_LOG_MS) {
              lastStepLogAt.current = now;
              console.info("tv.player.scrub.pan_step", JSON.stringify({ ...effect, origin: result.state.origin }));
            }
            controls?.scrubTo(effect.target);
            break;
          }
          case "gesture-end":
            console.info("tv.player.scrub.pan_end", JSON.stringify({ why, ...effect, origin: result.state.origin }));
            break;
          case "commit":
            console.info("tv.player.scrub.commit", JSON.stringify({ why, ...effect, deltaSeconds: effect.target - effect.origin }));
            if (controls) controls.seekTo(effect.target);
            else void MpvControl.seek(effect.target, "absolute+exact").catch((error: unknown) => console.error("tv.player.scrub.commit_failed", String(error)));
            break;
          case "drop":
            console.info("tv.player.scrub.drop", JSON.stringify({ why, ...effect }));
            controls?.scrubTo(null);
            break;
          case "cancel":
            console.info("tv.player.scrub.cancel", JSON.stringify({ why, ...effect }));
            controls?.scrubTo(null);
            break;
          case "ignored":
            console.info("tv.player.scrub.ignored", JSON.stringify({ why, reason: effect.reason, context: contextRef.current }));
            break;
        }
      }
      clearTimeout(scrubTimer.current);
      const delay = scrubTickDelay(result.state, Date.now());
      if (delay !== null) scrubTimer.current = setTimeout(() => applyScrub(scrubTick(scrub.current, Date.now()), "timer"), delay);
    },
    [controlsRef],
  );
  useEffect(
    () => () => {
      clearTimeout(scrubTimer.current);
      if (scrubPending(scrub.current)) console.info("tv.player.scrub.cancel", JSON.stringify({ why: "unmount", target: scrub.current.target }));
      scrub.current = IDLE_SCRUB;
    },
    [],
  );
  /** A key that seeks or acts on the bar while a scrub is pending: the scrub's seek goes first, then the key. */
  const settleScrubBefore = useCallback(
    (why: string) => {
      if (scrubPending(scrub.current)) applyScrub(scrubSelect(scrub.current), why);
    },
    [applyScrub],
  );

  const onTvEvent = useCallback(
    (event: RemoteEvent) => {
      syncControlsVisible();
      const pan = panFromEvent(event);
      if (pan) {
        // Not logged per event (~60 a second): the scrub logs its begin, throttled steps, end and seek.
        if (!panEnabled.current) return;
        const times = controlsRef.current?.times() ?? { position: 0, duration: 0 };
        applyScrub(
          scrubPan(scrub.current, pan, { now: Date.now(), position: times.position, duration: times.duration, canScrub: remoteScrubContext(contextRef.current) }),
          `pan:${pan.state}`,
        );
        return;
      }
      console.info("tv.player.remote.event", JSON.stringify(event));
      if (swipeHandledByPan(event, contextRef.current, { panEnabled: panEnabled.current, scrubbing: scrubPending(scrub.current) })) {
        console.info("tv.player.remote.swipe_by_pan", JSON.stringify({ eventType: event.eventType, target: scrub.current.target }));
        return;
      }
      const edge = remoteHoldFromEvent(event);
      if (edge) {
        if (edge.phase === "end") {
          stopHold("release");
          return;
        }
        stopHold("restart");
        settleScrubBefore("hold");
        const action = remoteAction(edge.direction < 0 ? "left" : "right", contextRef.current);
        if (action.type !== "seek") {
          console.info("tv.player.remote.hold_ignored", JSON.stringify({ action: action.type }));
          return;
        }
        const started: Hold = { direction: edge.direction, startedAt: Date.now(), timer: setInterval(() => jumpHeld(started), HOLD_TICK_MS) };
        hold.current = started;
        console.info("tv.player.remote.hold_start", JSON.stringify({ direction: edge.direction }));
        jumpHeld(started);
        return;
      }
      const key = remoteKeyFromEvent(event);
      if (!key) return;
      // OK during a pending scrub seeks there now (nothing else: no pause toggle, no press).
      if (key === "select" && scrubPending(scrub.current)) {
        applyScrub(scrubSelect(scrub.current), "key:select");
        controlsRef.current?.keepVisible();
        return;
      }
      if (key === "left" || key === "right" || key === "rewind" || key === "fastForward") settleScrubBefore(`key:${key}`);
      // Navigating the controls keeps them up: every key restarts the auto-hide (a focus move restarts it too), and a
      // direction decides where the focus goes: from a just-closed menu's button, or over a placement still pending.
      if (contextRef.current.overlayVisible && !contextRef.current.sheetOpen) {
        controlsRef.current?.keepVisible();
        if (key === "up" || key === "down" || key === "left" || key === "right") controlsRef.current?.focusArrow(key);
      }
      // A hold whose end event never came (tvOS cancels a long press without a key action) stops at the next key.
      stopHold(`key:${key}`);
      if ((key === "left" || key === "right") && Date.now() - lastHoldEndAt.current < HOLD_RELEASE_GUARD_MS) {
        console.info("tv.player.remote.press_after_hold_ignored", key);
        return;
      }
      // Only Stop leaves from here (Back arrives through the hardware Back handler below, never as a TV event).
      if (!run(key)) {
        console.info("tv.player.remote.leave", JSON.stringify({ key }));
        onLeaveRef.current();
      }
    },
    [applyScrub, controlsRef, jumpHeld, run, settleScrubBefore, stopHold, syncControlsVisible],
  );
  useTVEventHandler(onTvEvent);

  // Registered after the player screen's own Back handler, so it runs first: it takes Back while an overlay, menu or
  // dismissable prompt is up and lets it fall through (return false) to the screen's "leave the player" otherwise.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      stopHold("key:back");
      syncControlsVisible();
      // Back during a pending scrub drops it (no seek) and leaves the controls as they are.
      if (scrubPending(scrub.current)) {
        applyScrub(scrubCancel(scrub.current), "key:back");
        return true;
      }
      return run("back");
    });
    return () => sub.remove();
  }, [applyScrub, run, stopHold, syncControlsVisible]);

  // Android hands key events to the React root only while a view inside it has focus. While the controls are up their
  // buttons and progress bar are on the D-pad and hold it; with the video alone this invisible view holds the focus:
  // without it the D-pad would never reach `useTVEventHandler` and seek / pause / show the controls. A menu or a
  // prompt (including the skip pill) has its own focused control and takes the focus from it.
  const catcherRef = useRef<TvViewInstance>(null);
  const holdsFocus = !context.overlayVisible && !context.sheetOpen && !context.promptOpen && !context.pillVisible;
  useEffect(() => {
    if (!holdsFocus) return undefined;
    const id = setTimeout(() => {
      console.info("tv.player.remote.focus_catcher", JSON.stringify({ found: catcherRef.current !== null }));
      catcherRef.current?.requestTVFocus();
    }, 80);
    return () => clearTimeout(id);
  }, [holdsFocus]);

  // A prompt or the skip pill took the focus while the controls were up: when it goes, the focus goes back to the
  // control it was last sent to, so the D-pad never ends up nowhere.
  const promptHeldFocus = context.promptOpen || context.pillVisible;
  const hadPrompt = useRef(promptHeldFocus);
  useEffect(() => {
    const was = hadPrompt.current;
    hadPrompt.current = promptHeldFocus;
    if (!was || promptHeldFocus || !context.overlayVisible || context.sheetOpen) return;
    console.info("tv.player.remote.refocus_controls", "a prompt went away with the controls up");
    controlsRef.current?.refocus();
  }, [promptHeldFocus, context.overlayVisible, context.sheetOpen, controlsRef]);

  return <View ref={catcherRef} focusable={holdsFocus} style={StyleSheet.absoluteFill} pointerEvents="none" />;
};
