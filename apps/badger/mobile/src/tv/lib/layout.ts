/**
 * TV screen geometry in design dp (a 960x540 screen, UX-TV-13). Pure so the numbers are testable. The constants are design
 * sizes: multiply them by the window's TV scale (`tvScale.ts`) before putting them on screen.
 */

/** Margin kept clear on the left and right: TVs may crop the picture edges (overscan). */
export const TV_SAFE_MARGIN_X = 48;
/** Margin kept clear at the top and bottom. */
export const TV_SAFE_MARGIN_Y = 24;
/** Gap between two cards. */
export const TV_CARD_GAP = 16;
/** A row or library panel sits this far from the window's left and right edges. */
export const TV_PANEL_MARGIN_X = 32;
/** Width of a panel's border. */
export const TV_PANEL_BORDER_WIDTH = 1;
/**
 * Room inside a panel, like desktop's card padding (`p-6`): its heading and posters start this far from its left and
 * right edges (UX-TV-11).
 */
export const TV_PANEL_INSET_X = 24;
/** Room inside a panel above its heading (or its first row of posters) and below its last posters. */
export const TV_PANEL_INSET_Y = 20;
/** Room between a row's heading ("CONTINUE WATCHING") and the posters under it, like desktop's card header. */
export const TV_HEADING_GAP = 16;
/** Room between two Home rows, like desktop's `space-y-6`. */
export const TV_ROW_GAP = 20;
/** From the window edge to the first poster inside a panel: margin, border and inner room. */
export const TV_PANEL_CONTENT_X = TV_PANEL_MARGIN_X + TV_PANEL_BORDER_WIDTH + TV_PANEL_INSET_X;
/** Cards visible across a rail, counting the half card that peeks at the right edge. */
const VISIBLE_CARDS = 5.5;
const MIN_CARD_WIDTH = 110;
const MAX_CARD_WIDTH = 260;

/**
 * Width of a poster card in a rail for a window of this width at this TV scale. Worked out on the design screen, then
 * scaled, so a 1920-point Apple TV window at scale 2 gets exactly twice the card of a 960 dp Android TV window.
 */
export const tvRailCardWidth = (windowWidth: number, scale: number): number => {
  const designWidth = windowWidth / scale;
  const raw = (designWidth - TV_SAFE_MARGIN_X) / VISIBLE_CARDS - TV_CARD_GAP;
  return Math.round(Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, raw))) * scale;
};

/**
 * Columns of the Media library grid for a window of this width at this TV scale, with cards the width of a rail's: they
 * fit between the panel's inner edges, which lie inside the TV safe margin.
 */
export const tvGridColumns = (windowWidth: number, scale: number): number => {
  const cardWidth = tvRailCardWidth(windowWidth, scale);
  const gap = TV_CARD_GAP * scale;
  const usable = windowWidth - Math.max(TV_SAFE_MARGIN_X, TV_PANEL_CONTENT_X) * scale * 2;
  return Math.max(1, Math.floor((usable + gap) / (cardWidth + gap)));
};

/** Home's poster width (mockup `.row`: 214 px columns), in design dp (UX-TV-05, UX-TV-11). */
export const TV_HOME_CARD_WIDTH = 107;
/** Columns of the Library grid (mockup `.grid`, UX-TV-09). */
export const TV_LIBRARY_COLUMNS = 8;
/** Gap between two Library columns, and between two rows (mockup 34 px / 30 px), in design dp. */
export const TV_LIBRARY_GAP_X = 17;
export const TV_LIBRARY_GAP_Y = 15;
/** Left and right margin of Home and Library (mockup 72 px): `TV_SPACE.screenX`, repeated so this file stays free of react-native. */
export const TV_SCREEN_X = 36;

/** Home's poster width on screen at this TV scale. */
export const tvHomeCardWidth = (scale: number): number => TV_HOME_CARD_WIDTH * scale;

/**
 * Width of a Library poster for a window of this width at this TV scale: eight columns fill the room between the
 * screen margins (about 96 dp on the 960 dp design screen). Worked out in design dp, then scaled.
 */
export const tvLibraryCardWidth = (windowWidth: number, scale: number): number => {
  const designWidth = windowWidth / scale;
  const usable = designWidth - TV_SCREEN_X * 2 - TV_LIBRARY_GAP_X * (TV_LIBRARY_COLUMNS - 1);
  return Math.floor((usable / TV_LIBRARY_COLUMNS) * scale);
};
