/** Vertical slide distance, as a fraction of the player height, that sweeps a level from 0 to 1. */
export const SWIPE_FULL_RANGE_FRACTION = 0.7;

/** Movement (dp) before a slide claims the touch from the tap / double-tap handler. */
export const SWIPE_SLOP_DP = 12;

/** The left half adjusts screen brightness, the right half media volume (the usual mobile-player convention). */
export const swipeTarget = (startX: number, width: number): "brightness" | "volume" =>
  startX < width / 2 ? "brightness" : "volume";

/** True once a move is clearly a vertical slide rather than a tap or a horizontal drag. */
export const isVerticalSwipe = (dx: number, dy: number): boolean =>
  Math.abs(dy) > SWIPE_SLOP_DP && Math.abs(dy) > 2 * Math.abs(dx);

/** Level after sliding `dy` px (negative = up = louder/brighter) from `start`, clamped to 0..1. */
export const levelAfterSwipe = (start: number, dy: number, height: number): number => {
  const range = Math.max(1, height * SWIPE_FULL_RANGE_FRACTION);
  return Math.min(1, Math.max(0, start - dy / range));
};

/** Max gap from the first tap's release to the second tap's press (Android's DOUBLE_TAP_TIMEOUT). */
export const DOUBLE_TAP_MS = 300;

export type SurfaceTap = { downAt: number; upAt: number; side: "left" | "right" };

/**
 * A tap on the video, timed by the touch events' own timestamps: a JS thread stalled between two taps (throttled phone:
 * 200-600 ms) must not stretch a quick double tap past DOUBLE_TAP_MS.
 */
export const surfaceTap = (touch: { locationX: number; downAt: number; upAt: number }, width: number): SurfaceTap => ({
  downAt: touch.downAt,
  upAt: touch.upAt,
  side: touch.locationX < width / 2 ? "left" : "right",
});

/** Same half, and the second press lands within DOUBLE_TAP_MS of the first release (as Android's GestureDetector). */
export const isDoubleTap = (previous: SurfaceTap | null, next: SurfaceTap): boolean =>
  previous !== null && previous.side === next.side && next.downAt - previous.upAt <= DOUBLE_TAP_MS;
