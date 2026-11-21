import { useMemo } from "react";
import { StyleSheet, type TextStyle, type ViewStyle } from "react-native";
import { defaultMobileShellTheme, useMobileShellTheme } from "../theme";

/**
 * The TV look of the family (UX-TV-04, UX-TV-34): the approved TV mockups (Chris 2026-11-12 (chat), `badger-tv-redesign-v2`
 * `screens/tv.css`) carried into design dp, shared by Badger TV and Parrot TV. The mockups are drawn at 1920x1080 px and one
 * design dp is two pixels on a 1080p TV (UX-TV-13), so every mockup size is halved here. Style sheets built from these go
 * through `useTvStyles`, which scales them for an Apple TV.
 *
 * Only the accent differs between the apps (Badger's amber, Parrot's green, UX-THEME-02): it is read from the app's shell
 * theme with `useTvAccent`, never fixed here.
 */

const palette = defaultMobileShellTheme.colors;

/** The fleet's shared dark palette (`packages/mobile-shell/src/theme.ts`, desktop's `badger-dark.css`). */
export const TV_COLOR = {
  /** Night blue ground under the sky (`--background`). */
  background: palette.bg,
  /** Cards, lists, the open tab (`--card`). */
  card: palette.surface,
  /** Translucent card over the sky (`--card` at 78 %): the stars show through. */
  cardOnSky: "rgba(36, 38, 56, 0.78)",
  /** Settings lists (`--card` at 82 %). */
  listOnSky: "rgba(36, 38, 56, 0.82)",
  /** Secondary fills: dark pill buttons, row icon squares, the toggle's track (`--secondary`). */
  secondary: palette.surfaceRaised,
  /** Dark pill button fill (`--secondary` at 55 %). */
  secondaryOnSky: "rgba(51, 54, 72, 0.55)",
  /** Thin borders (`--border`). */
  border: palette.border,
  /** Borders of cards and chips on the sky (`--border` at 60 %). */
  borderSoft: "rgba(68, 71, 90, 0.6)",
  /** Soft white text (`--foreground`). */
  text: palette.text,
  /** Grey-blue secondary text (`--muted-foreground`). */
  muted: palette.textMuted,
  danger: palette.danger,
} as const;

/** The app's one accent on TV: main button, chosen tab or chip, progress, focus (`--primary`). */
export type TvAccent = {
  /** The accent itself. */
  color: string;
  /** Text and icons on the accent (`--primary-foreground`). */
  onColor: string;
  /** Focused settings row tint (`--primary` at 10 %). */
  tint: string;
  /** The main button's soft glow (mockup `0 12px 36px` of `--primary` at 28 %, halved). */
  glow: string;
};

/** `#rrggbb` (or `#rgb`) at an opacity, as `rgba(…)`. */
export const hexAlpha = (hex: string, alpha: number): string => {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.replace(/(.)/g, "$1$1") : value.slice(0, 6);
  const n = Number.parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

/** The TV accent of a shell theme's accent and its text colour. */
export const tvAccent = (accentHex: string, accentTextHex: string): TvAccent => ({
  color: accentHex,
  onColor: accentTextHex,
  tint: hexAlpha(accentHex, 0.1),
  glow: `0px 6px 18px ${hexAlpha(accentHex, 0.28)}`,
});

/** The app's TV accent, from its `MobileShellThemeProvider` (Badger's amber, Parrot's green). */
export const useTvAccent = (): TvAccent => {
  const { accentHex, accentTextHex } = useMobileShellTheme();
  return useMemo(() => tvAccent(accentHex, accentTextHex), [accentHex, accentTextHex]);
};

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
  display: defaultMobileShellTheme.font.family.display,
  body: defaultMobileShellTheme.font.family.sans,
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

/** Label in spaced capitals ("CONTINUE WATCHING", mockup 17 px, weight 900, 0.16em), in the accent unless muted. */
export const TV_EYEBROW: TextStyle = {
  fontFamily: TV_FONT.body,
  fontSize: 8.5,
  lineHeight: 12,
  fontWeight: "900",
  letterSpacing: 8.5 * 0.16,
  textTransform: "uppercase",
};

/**
 * The remote's focus (UX-A11Y-04, UX-TV-35): an accent ring with a gap around the focused thing and a slight lift
 * (mockup `outline: 5px; outline-offset: 6px; scale(1.05)`). Drawn as an outline, so it takes no room and focusing never
 * moves anything; the gap keeps it visible on an accent button.
 */
export const TV_FOCUS = {
  width: 2.5,
  offset: 3,
  /** Lift of a focused button, chip or tab. */
  scale: 1.05,
  /** Lift of a focused poster. */
  posterScale: 1.06,
} as const;

/** The focus ring style in the accent `color`; `inset` draws it inside the edge (settings rows that span the list). */
export const tvFocusRing = (color: string, inset = false): ViewStyle => ({
  outlineWidth: TV_FOCUS.width,
  outlineStyle: "solid",
  outlineColor: color,
  outlineOffset: inset ? -TV_FOCUS.width : TV_FOCUS.offset,
});

/** Shadows (React Native `boxShadow`), mockup px halved. The accent button's glow is `TvAccent.glow`. */
export const TV_SHADOW = {
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
