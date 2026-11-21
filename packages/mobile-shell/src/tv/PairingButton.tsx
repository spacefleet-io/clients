import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { useMobileShellTheme } from "../theme";
import { useTvStyles } from "./tvScale";
import { TV_FOCUS, TV_RADII, useTvAccent } from "./tokens";
import { tvFocusRings } from "./TvFocusable";

type PairingButtonProps = {
  label: string;
  onPress: () => void;
  /** Takes the remote's focus when the screen appears. */
  preferredFocus?: boolean;
  variant?: "primary" | "secondary";
  /**
   * Smaller button for a pair of answers side by side in a panel (the error-reports question): it fills with the text
   * colour while focused, as in the approved TV design.
   */
  compact?: boolean;
  disabled?: boolean;
  /** Drawn before the label (the sign-in screen's mail icon). */
  icon?: React.ReactNode;
  testID?: string;
};

/**
 * Remote-friendly button for the pairing and setup screens: always focusable. The family's pill (UX-TV-34): the accent
 * for the main answer, dark for the others; under the focus the accent ring sits outside with a gap and the button lifts
 * slightly (UX-TV-35). (Pressable's own `onFocus`/`onBlur` are used: TV focus events are not emitted on Fabric.)
 */
export const PairingButton = ({ label, onPress, preferredFocus, variant = "secondary", compact, disabled, icon, testID }: PairingButtonProps) => {
  const theme = useMobileShellTheme();
  const styles = useTvStyles(baseStyles);
  const accent = useTvAccent();
  const rings = useTvStyles(useMemo(() => tvFocusRings(accent.color), [accent.color]));
  const [focused, setFocused] = React.useState(false);
  const primary = variant === "primary";
  const filled = compact === true && focused;
  const background = filled ? theme.colors.text : primary ? theme.colors.accent : theme.colors.surfaceRaised;
  const labelColor = filled || primary ? theme.accentTextHex : theme.colors.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      focusable={!disabled}
      disabled={disabled}
      hasTVPreferredFocus={preferredFocus}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        styles.button,
        compact && styles.compact,
        primary && !filled && { boxShadow: accent.glow },
        {
          backgroundColor: background,
          opacity: disabled ? 0.5 : 1,
          transform: [{ scale: focused ? TV_FOCUS.scale : 1 }],
        },
        focused && rings.outside,
      ]}
    >
      {icon}
      <Text style={[styles.label, compact && styles.compactLabel, { color: labelColor }]}>{label}</Text>
    </Pressable>
  );
};

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  button: {
    minWidth: 280,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: TV_RADII.pill,
  },
  compact: { minWidth: 190, paddingVertical: 12 },
  label: { fontSize: 22, fontWeight: "700" },
  compactLabel: { fontSize: 18 },
});
