import { useWindowDimensions } from "react-native";
import { scaleStyleSheet } from "@space/mobile-mpv-playback/uiScale";

/**
 * The TV interface is drawn for a 960x540 design screen: what Android TV reports at 1080p (one dp = two pixels).
 * tvOS reports 1920x1080 points for the same screen, so every TV size is multiplied by the window's scale against that
 * design screen (UX-TV-13): 1 on Android TV (unchanged), 2 on an Apple TV, so both show the same layout and text size.
 */
export const TV_DESIGN_WIDTH = 960;
export const TV_DESIGN_HEIGHT = 540;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

/** Scale of a window against the design screen: the smaller ratio, so the layout always fits. */
export const tvScaleForWindow = (width: number, height: number): number => {
  const ratio = Math.min(width / TV_DESIGN_WIDTH, height / TV_DESIGN_HEIGHT);
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio));
};

/** The current window's TV scale. */
export const useTvScale = (): number => {
  const { width, height } = useWindowDimensions();
  return tvScaleForWindow(width, height);
};

/** One design size (dp at 960x540) at this scale. */
export const tvScaled = (value: number, scale: number): number => value * scale;

/** The current window's version of a design-dp style sheet (`scaleStyleSheet` at the window's TV scale). */
export const useTvStyles = <T extends object>(styles: T): T => scaleStyleSheet(styles, useTvScale());
