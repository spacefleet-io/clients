import React, { forwardRef, memo, useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import type { TvViewInstance } from "./tvViewInstance";
import { useTvStyles } from "./tvScale";
import { TV_FOCUS, TV_RADII, tvFocusRing, useTvAccent } from "./tokens";

/** Default grow factor of the focused element (mockup `scale(1.05)`). */
export const FOCUS_SCALE = TV_FOCUS.scale;

type FocusState = { pressed: boolean; focused: boolean };

export type TvFocusableProps = Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  /** Extra style while focused (on top of the ring and the scale). */
  focusedStyle?: StyleProp<ViewStyle>;
  /** Grow factor while focused; 1 keeps the size (rows that span the screen). */
  scale?: number;
  /** Where the accent ring sits: `outside` with a gap (buttons, chips, tabs), `inside` the edge (rows that fill a list), or `none` (the element draws its own focus, e.g. a poster's picture). */
  ring?: "outside" | "inside" | "none";
  /** Optional: a bare overlay (the trailer's play/pause surface) has nothing to render. */
  children?: ReactNode;
};

/**
 * The remote's focus target of the TV apps (UX-A11Y-04, UX-TV-35): a Pressable with the app's accent focus ring (an
 * outline with a gap, so it takes no room and nothing moves when the focus arrives) and a slight lift while focused.
 * `hasTVPreferredFocus` and the other focus props of react-native-tvos pass straight through, and the ref reaches the
 * native view (`requestTVFocus`). Apple's own focus effect is turned off so the look is the same on every TV.
 */
export const TvFocusable = memo(
  forwardRef<TvViewInstance, TvFocusableProps>(
    ({ style, focusedStyle, scale = FOCUS_SCALE, ring = "outside", children, ...rest }, ref) => {
      const styles = useTvStyles(baseStyles);
      const accent = useTvAccent().color;
      const rings = useTvStyles(useMemo(() => tvFocusRings(accent), [accent]));
      return (
        <Pressable
          ref={ref}
          accessibilityRole="button"
          tvParallaxProperties={{ enabled: false }}
          {...rest}
          style={(state) => {
            // react-native-tvos adds `focused` to the callback state at runtime; the bundled typings omit it.
            const { focused } = state as FocusState;
            return [
              styles.base,
              style,
              focused && ring === "outside" && rings.outside,
              focused && ring === "inside" && rings.inside,
              focused && focusedStyle,
              focused && scale !== 1 && { transform: [{ scale }] },
            ];
          }}
        >
          {children}
        </Pressable>
      );
    },
  ),
);
TvFocusable.displayName = "TvFocusable";

const baseStyles = StyleSheet.create({
  base: { borderRadius: TV_RADII.control },
});

/** The app's accent ring, outside with a gap or inside the edge. */
export const tvFocusRings = (accent: string) =>
  StyleSheet.create({
    outside: tvFocusRing(accent, false),
    inside: tvFocusRing(accent, true),
  });
