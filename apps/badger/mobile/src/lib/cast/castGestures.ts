import { isDoubleTap, surfaceTap, type SurfaceTap } from "@space/mobile-mpv-playback/gestures";

/**
 * A finished tap on the cast screen's touch pad (UX-TV-03): a second tap on the same half within DOUBLE_TAP_MS seeks
 * 10 s back (left) or forward (right), as in the player. `last` is what the next tap compares against: cleared after a
 * double tap so a third tap starts a new pair.
 */
export const castPadTap = (
  previous: SurfaceTap | null,
  touch: { locationX: number; downAt: number; upAt: number },
  width: number,
): { seek: 1 | -1 | null; last: SurfaceTap | null } => {
  const tap = surfaceTap(touch, width);
  if (!isDoubleTap(previous, tap)) return { seek: null, last: tap };
  return { seek: tap.side === "left" ? -1 : 1, last: null };
};
