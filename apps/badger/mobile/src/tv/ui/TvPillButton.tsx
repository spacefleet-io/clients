import React, { forwardRef, memo } from "react";
import { StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { TvFocusable, type TvFocusableProps } from "../components/TvFocusable";
import type { TvViewInstance } from "../lib/tvViewInstance";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { TV_COLOR, TV_RADII, TV_SHADOW, TV_TYPE } from "./tokens";

export type TvPillButtonVariant = "primary" | "secondary";

export type TvPillButtonProps = Omit<TvFocusableProps, "style" | "children" | "ring"> & {
  label: string;
  /** Drawn before the label (lucide). */
  icon?: LucideIcon;
  /** Draw the icon filled, as the mockups do for play, pause, previous and next. */
  filledIcon?: boolean;
  /** Drawn after the label (the chevron on Next). */
  iconEnd?: LucideIcon;
  /** `primary`: the one amber filled pill for the main action, with a soft amber glow. `secondary`: a dark pill with a thin border. */
  variant?: TvPillButtonVariant;
  style?: StyleProp<ViewStyle>;
};

/**
 * The family's button on TV (mockup `.btn`, UX-TV-34): a pill with an icon before the label. The focus ring sits outside
 * with a gap, so it shows on the amber pill too (UX-A11Y-04), and the focused button lifts slightly.
 */
export const TvPillButton = memo(
  forwardRef<TvViewInstance, TvPillButtonProps>(({ label, icon: Icon, filledIcon, iconEnd: IconEnd, variant = "secondary", style, ...rest }, ref) => {
    const scale = useTvScale();
    const styles = useTvStyles(baseStyles);
    const primary = variant === "primary";
    const color = primary ? TV_COLOR.onAmber : TV_COLOR.text;
    return (
      <TvFocusable
        ref={ref}
        accessibilityRole="button"
        accessibilityLabel={label}
        {...rest}
        style={[styles.button, primary ? styles.primary : styles.secondary, style]}
      >
        {Icon ? <Icon size={14 * scale} color={color} fill={filledIcon ? color : "none"} /> : null}
        <Text style={[styles.label, { color }]} numberOfLines={1}>
          {label}
        </Text>
        {IconEnd ? <IconEnd size={14 * scale} color={color} /> : null}
      </TvFocusable>
    );
  }),
);
TvPillButton.displayName = "TvPillButton";

export type TvIconButtonProps = Omit<TvFocusableProps, "style" | "children" | "ring"> & {
  icon: LucideIcon;
  /** Read aloud; the button shows no text. */
  accessibilityLabel: string;
  /** The open one (Settings while Settings is open): solid card fill and an amber icon. */
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A square icon button (mockup `.iconbtn`): Settings in the top bar, the language globe on sign-in. */
export const TvIconButton = memo(
  forwardRef<TvViewInstance, TvIconButtonProps>(({ icon: Icon, selected, style, ...rest }, ref) => {
    const scale = useTvScale();
    const styles = useTvStyles(baseStyles);
    return (
      <TvFocusable ref={ref} accessibilityRole="button" {...rest} style={[styles.iconButton, selected && styles.iconButtonSelected, style]}>
        <Icon size={14 * scale} color={selected ? TV_COLOR.amber : TV_COLOR.text} />
      </TvFocusable>
    );
  }),
);
TvIconButton.displayName = "TvIconButton";

/** Sizes in design dp (mockup px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 36,
    paddingHorizontal: 18,
    borderRadius: TV_RADII.pill,
  },
  primary: { backgroundColor: TV_COLOR.amber, boxShadow: TV_SHADOW.amberButton },
  secondary: { backgroundColor: TV_COLOR.secondaryOnSky, borderWidth: 0.75, borderColor: TV_COLOR.border },
  label: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 12.5, fontWeight: "700" },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: TV_RADII.control,
    backgroundColor: "rgba(36, 38, 56, 0.6)",
    borderWidth: 0.5,
    borderColor: TV_COLOR.borderSoft,
  },
  iconButtonSelected: { backgroundColor: TV_COLOR.card },
});
