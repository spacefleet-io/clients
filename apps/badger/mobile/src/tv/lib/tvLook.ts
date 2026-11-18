import { TV_COLOR, TV_RADII } from "../ui/tokens";

/**
 * Named corners of the TV screens (UX-TV-04, UX-TV-34), in dp: the family's rounded shapes from the approved TV mockups
 * (Chris 2026-11-12 (chat)). New code takes `TV_RADII` and the primitives in `src/tv/ui` directly.
 */
export const TV_RADIUS = {
  /** Dialogs, side panels, settings and details blocks: rounded cards. */
  panel: TV_RADII.card,
  /** Home rows and the Media library panel. */
  section: TV_RADII.card,
  /** Posters, wide pictures, episode stills. */
  picture: TV_RADII.poster,
  /** Tabs, menu items and the buttons not yet drawn as pills (`TvPillButton`). */
  button: TV_RADII.control,
  /** Buttons, chips and small tags (genres, qualities, tracks). */
  pill: TV_RADII.pill,
} as const;

/** A translucent card over the sky (mockup `.card`), so the shooting stars stay visible. */
export const TV_PANEL_BACKGROUND = TV_COLOR.cardOnSky;
export const TV_PANEL_BORDER = TV_COLOR.borderSoft;

/** Labels in spaced capitals (top-bar tabs, row headings): 0.12em tracking. */
export const tvTrackedLabel = (fontSize: number) => ({
  textTransform: "uppercase" as const,
  letterSpacing: fontSize * 0.12,
  fontWeight: "900" as const,
  fontSize,
});
