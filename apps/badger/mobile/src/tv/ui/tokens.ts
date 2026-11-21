import type { TextStyle, ViewStyle } from "react-native";
import {
  TV_COLOR as SHARED_TV_COLOR,
  TV_EYEBROW as SHARED_TV_EYEBROW,
  TV_FOCUS as SHARED_TV_FOCUS,
  TV_SHADOW as SHARED_TV_SHADOW,
  tvAccent,
  tvFocusRing as sharedTvFocusRing,
} from "@space/mobile-shell/tv/tokens";
import { theme } from "../../theme/theme";

export { TV_FONT, TV_RADII, TV_SPACE, TV_TYPE, tvCardStyle } from "@space/mobile-shell/tv/tokens";

/**
 * Badger TV's tokens: the family's shared TV look (`@space/mobile-shell/tv/tokens`, UX-TV-34) with Badger's one amber
 * fixed in, for Badger's own screens' static style sheets. The shared components read the accent from the shell theme
 * (`useTvAccent`), which is this same amber in Badger.
 */
const AMBER = tvAccent(theme.colors.accent, theme.accentTextHex);

export const TV_COLOR = {
  ...SHARED_TV_COLOR,
  /** The one amber: main button, chosen tab or chip, progress, focus (`--primary`). */
  amber: AMBER.color,
  /** Text on amber (`--primary-foreground`). */
  onAmber: AMBER.onColor,
  /** Focused settings row tint (`--primary` at 10 %). */
  amberTint: AMBER.tint,
} as const;

/** Amber label in spaced capitals ("CONTINUE WATCHING"). */
export const TV_EYEBROW: TextStyle = { ...SHARED_TV_EYEBROW, color: TV_COLOR.amber };

/** The remote's focus (UX-A11Y-04, UX-TV-35): the shared ring and lift, in amber. */
export const TV_FOCUS = { ...SHARED_TV_FOCUS, color: TV_COLOR.amber } as const;

/** The amber focus ring; `inset` draws it inside the edge (settings rows that span the list). */
export const tvFocusRing = (inset = false): ViewStyle => sharedTvFocusRing(TV_COLOR.amber, inset);

export const TV_SHADOW = { ...SHARED_TV_SHADOW, amberButton: AMBER.glow } as const;
