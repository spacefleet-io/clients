/**
 * Playback health helpers: start options for the initial load, spinner visibility and failure detection.
 * Pure so the polling hook in PlayerScreen stays a thin shell (see tests/playback-health.test.ts).
 */
import type { PlaybackSnapshot } from "@space/mobile-mpv-playback";

/**
 * PLAY-ABR-03: the "playback is taking long" timers never change quality. Loading that stays stuck (first start, a
 * rebuffer, a seek or a quality switch) shows a hint after 30 s and closes with an error after 60 s.
 */
export const LOADING_HINT_MS = 30_000;
export const LOADING_FAILURE_MS = 60_000;
/** `idle-active` for this long after load started (and no first frame) means libmpv gave up on the source. */
export const IDLE_FAILURE_GRACE_MS = 4_000;

/** Per-file mpv options for the first `loadfile` (resume position; the rung is chosen by the master url). */
export const buildStartOptions = (input: { startSeconds: number }): string | null =>
  Number.isFinite(input.startSeconds) && input.startSeconds > 0.5 ? `start=${input.startSeconds.toFixed(3)}` : null;

/**
 * Loading spinner: before the first frame, while rebuffering, and while a seek is in flight. With the picture switched
 * off (`vid=no`: the app in the background or the screen locked, PLAY-OSMEDIA-01) no frame ever comes, so only the
 * sound counts: otherwise the 60 s loading timeout closes a film that plays fine on the lock screen.
 */
export const shouldShowSpinner = (snapshot: PlaybackSnapshot | null): boolean => {
  if (!snapshot) return true;
  if (snapshot.eof) return false;
  const soundOnly = snapshot.vid < 0 && snapshot.aid >= 0;
  return (!snapshot.voConfigured && !soundOnly) || snapshot.pausedForCache || snapshot.seeking;
};

/**
 * Start of the current uninterrupted loading stretch (spinner showing or a quality switch running), or null when nothing is loading. `floorMs` is
 * when the first load began: the first start counts from there even before the first poll answered.
 */
export const trackLoading = (
  since: number | null,
  input: { snapshot: PlaybackSnapshot | null; nowMs: number; floorMs: number | null; switching?: boolean },
): number | null => {
  if (!input.snapshot) return null;
  // A quality switch counts as loading even while the old frame is still on screen.
  if (!shouldShowSpinner(input.snapshot) && !input.switching) return null;
  return since ?? input.floorMs ?? input.nowMs;
};

export const shouldShowLoadingHint = (stuckLoadingMs: number): boolean => stuckLoadingMs >= LOADING_HINT_MS;

export type FailureInput = {
  snapshot: PlaybackSnapshot | null;
  msSinceLoad: number;
  firstFrameSeen: boolean;
  /** How long loading has been stuck without a break (see `trackLoading`), 0 when it is not. */
  stuckLoadingMs: number;
  /**
   * A quality switch is loading: it retries an idle or rejected rung by itself, so an idle player is not a failure
   * until the switch gave up (then `switching` is false and the idle checks below apply).
   */
  switching: boolean;
};

/** Failure reason code: the suffix of the `player.error.<code>` i18n key shown to the user. */
export type PlaybackFailureCode = "openFailed" | "startTimeout" | "loadingTimeout" | "stoppedUnexpectedly";

/** Failure reason, or null while playback is healthy / still starting. */
export const detectPlaybackFailure = ({ snapshot, msSinceLoad, firstFrameSeen, stuckLoadingMs, switching }: FailureInput): PlaybackFailureCode | null => {
  if (!snapshot) return null;
  if (!firstFrameSeen && !switching && snapshot.idle && msSinceLoad >= IDLE_FAILURE_GRACE_MS) {
    return "openFailed";
  }
  if (stuckLoadingMs >= LOADING_FAILURE_MS) return firstFrameSeen ? "loadingTimeout" : "startTimeout";
  if (firstFrameSeen && !switching && snapshot.idle && !snapshot.eof) return "stoppedUnexpectedly";
  return null;
};
