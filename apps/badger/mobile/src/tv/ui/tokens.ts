import { StyleSheet, type TextStyle, type ViewStyle } from "react-native";
import { theme } from "../../theme/theme";

/**
 * The TV look of the Badger family (UX-TV-04, UX-TV-34): the approved TV mockups (Chris 2026-11-12 (chat), `badger-tv-redesign-v2`
 * `screens/tv.css`) carried into design dp. The mockups are drawn at 1920x1080 px and one design dp is two pixels on a 1080p
 * TV (UX-TV-13), so every mockup size is halved here. Style sheets built from these go through `useTvStyles`, which scales
 * them for an Apple TV.
 */

/** The shipped Badger dark palette (`packages/mobile-shell/src/theme.ts`, desktop's `badger-dark.css`). */
export const TV_COLOR = {
  /** Night blue ground under the sky (`--background`). */
  background: theme.colors.bg,
  /** Cards, lists, the open tab (`--card`). */
  card: theme.colors.surface,
  /** Translucent card over the sky (`--card` at 78 %): the stars show through. */
  cardOnSky: "rgba(36, 38, 56, 0.78)",
  /** Settings lists (`--card` at 82 %). */
  listOnSky: "rgba(36, 38, 56, 0.82)",
  /** Secondary fills: dark pill buttons, row icon squares, the toggle's track (`--secondary`). */
  secondary: theme.colors.surfaceRaised,
  /** Dark pill button fill (`--secondary` at 55 %). */
  secondaryOnSky: "rgba(51, 54, 72, 0.55)",
  /** Thin borders (`--border`). */
  border: theme.colors.border,
  /** Borders of cards and chips on the sky (`--border` at 60 %). */
  borderSoft: "rgba(68, 71, 90, 0.6)",
  /** Soft white text (`--foreground`). */
  text: theme.colors.text,
  /** Grey-blue secondary text (`--muted-foreground`). */
  muted: theme.colors.textMuted,
  /** The one amber: main button, chosen tab or chip, progress, focus (`--primary`). */
  amber: theme.colors.accent,
  /** Text on amber (`--primary-foreground`). */
  onAmber: theme.accentTextHex,
  /** Focused settings row tint (`--primary` at 10 %). */
  amberTint: "rgba(255, 179, 87, 0.1)",
  danger: theme.colors.danger,
} as const;

/** Rounded family shapes (mockup px halved): cards about 14 px on desktop and phone, scaled up for the TV. */
export const TV_RADII = {
  /** Cards and settings lists (mockup 20 px). */
  card: 10,
  /** Tabs, the Settings button, row icon squares, the segmented control's inner chips (mockup 14 px). */
  control: 7,
  /** The segmented control's tray (mockup 18 px). */
  tray: 9,
  /** Posters and pictures (mockup 12 px). */
  poster: 6,
  /** Buttons, chips, toggles, tags. */
  pill: 999,
} as const;

/** Spacing in design dp (mockup px halved). */
export const TV_SPACE = {
  /** Screen edge to content, left and right (mockup 72 px). */
  screenX: 36,
  /** Gap between posters in a row (mockup 34 px). */
  posterGap: 17,
  /** Gap between buttons in a row. */
  buttonGap: 8,
  /** Row heading to its posters (mockup 22 px). */
  headingGap: 11,
} as const;

/** Type scale in design dp: Space Grotesk for titles, Inter for everything else. */
export const TV_FONT = {
  display: theme.font.family.display,
  body: theme.font.family.sans,
} as const;

export const TV_TYPE = {
  /** Hero and title-page titles. */
  hero: { fontFamily: TV_FONT.display, fontSize: 36, lineHeight: 42, fontWeight: "600", letterSpacing: -0.72 },
  /** Page titles ("Playback", "Choose your language"). */
  page: { fontFamily: TV_FONT.display, fontSize: 20, lineHeight: 26, fontWeight: "600", letterSpacing: -0.4 },
  /** Row headings ("Recently added", mockup 32 px). */
  section: { fontFamily: TV_FONT.display, fontSize: 16, lineHeight: 21, fontWeight: "600", letterSpacing: -0.32 },
  /** Body lines, settings row titles (mockup 25 px). */
  body: { fontFamily: TV_FONT.body, fontSize: 12.5, lineHeight: 17 },
  /** Poster titles (mockup 21 px). */
  caption: { fontFamily: TV_FONT.body, fontSize: 10.5, lineHeight: 14, fontWeight: "600" },
  /** Grey second lines (mockup 18-19 px). */
  small: { fontFamily: TV_FONT.body, fontSize: 9.5, lineHeight: 13 },
} as const satisfies Record<string, TextStyle>;

/** Amber label in spaced capitals ("CONTINUE WATCHING", mockup 17 px, weight 900, 0.16em). */
export const TV_EYEBROW: TextStyle = {
  fontFamily: TV_FONT.body,
  fontSize: 8.5,
  lineHeight: 12,
  fontWeight: "900",
  letterSpacing: 8.5 * 0.16,
  textTransform: "uppercase",
  color: TV_COLOR.amber,
};

/**
 * The remote's focus (UX-A11Y-04, UX-TV-35): an amber ring with a gap around the focused thing and a slight lift
 * (mockup `outline: 5px; outline-offset: 6px; scale(1.05)`). Drawn as an outline, so it takes no room and focusing never
 * moves anything; the gap keeps it visible on an amber button.
 */
export const TV_FOCUS = {
  width: 2.5,
  offset: 3,
  color: TV_COLOR.amber,
  /** Lift of a focused button, chip or tab. */
  scale: 1.05,
  /** Lift of a focused poster. */
  posterScale: 1.06,
} as const;

/** The focus ring style; `inset` draws it inside the edge (settings rows that span the list). */
export const tvFocusRing = (inset = false): ViewStyle => ({
  outlineWidth: TV_FOCUS.width,
  outlineStyle: "solid",
  outlineColor: TV_FOCUS.color,
  outlineOffset: inset ? -TV_FOCUS.width : TV_FOCUS.offset,
});

/** Shadows (React Native `boxShadow`), mockup px halved. */
export const TV_SHADOW = {
  amberButton: "0px 6px 18px rgba(255, 179, 87, 0.28)",
  card: "0px 15px 40px rgba(0, 0, 0, 0.35)",
  poster: "0px 8px 18px rgba(0, 0, 0, 0.45)",
  posterFocused: "0px 14px 30px rgba(0, 0, 0, 0.65)",
} as const;

/** A translucent card on the sky (mockup `.card`). */
export const tvCardStyle = StyleSheet.create({
  card: {
    borderRadius: TV_RADII.card,
    backgroundColor: TV_COLOR.cardOnSky,
    borderWidth: 0.75,
    borderColor: TV_COLOR.borderSoft,
    boxShadow: TV_SHADOW.card,
  },
}).card;
