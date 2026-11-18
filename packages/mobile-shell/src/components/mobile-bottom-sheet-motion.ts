// UX-SHEET-01: how a phone bottom sheet moves. Kept apart from the component so the rules are testable without a
// device: the sheet follows the finger, closes past a distance or on a flick, and the backdrop's opacity follows the
// sheet's offset (dark when the sheet is up, clear when it is out) instead of sliding with it.

/** A drag further down than this (points) closes the sheet when released. */
export const SHEET_CLOSE_DISTANCE = 130;
/** A downward flick faster than this (points per second) closes the sheet whatever its distance. */
export const SHEET_CLOSE_VELOCITY = 1100;
/** The drag zone at the top of a sheet (handle row, and the header under it) is at least this tall: a fingertip. */
export const SHEET_HANDLE_HEIGHT = 44;
/** The backdrop's colour at full opacity (sheet up). */
export const SHEET_BACKDROP_COLOR = "rgba(0,0,0,0.45)";
/** Share of the space above the keyboard the sheet may take; the rest stays backdrop (tap to close). */
export const SHEET_SHARE = 0.88;
export const SHEET_OPEN_MS = 210;
export const SHEET_CLOSE_MS = 180;

/** Released after a drag of `translationY` at `velocityY`: close, or spring back up. */
export const shouldCloseSheet = (translationY: number, velocityY: number): boolean =>
  translationY > SHEET_CLOSE_DISTANCE || velocityY > SHEET_CLOSE_VELOCITY;

/** The sheet's offset while dragged: it follows the finger down, never above its open position. */
export const sheetDragOffset = (translationY: number): number => Math.max(0, translationY);

/**
 * The backdrop's opacity as an interpolation of the sheet's offset: 1 with the sheet up (offset 0), 0 with the sheet
 * out of sight (offset `travel`, the window's height), clamped both ways.
 */
export const sheetBackdropInterpolation = (travel: number) => ({
  inputRange: [0, Math.max(1, travel)],
  outputRange: [1, 0],
  extrapolate: "clamp" as const,
});
