import React, { useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useMobileShellTheme } from "../theme";
import { TV_FOCUS_RING_WIDTH, TV_FOCUS_SCALE } from "./tv-focus";

export type MobileButtonFaceProps = {
  label: string;
  /** Drawn before the label, centred with it (a language's flag in the account language prompt). */
  leading?: React.ReactNode;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  testID?: string;
  /** TV: the remote starts on this button when its screen or dialog opens (a dialog's safe action). */
  hasTVPreferredFocus?: boolean;
};

// The shared button look without the reanimated press spring, so apps that do
// not ship react-native-reanimated (Parrot) can use shared forms built on it.
export const MobileButtonFace = ({
  label,
  leading,
  onPress,
  onPressIn,
  onPressOut,
  disabled,
  loading,
  variant = "primary",
  testID,
  hasTVPreferredFocus,
}: MobileButtonFaceProps) => {
  const theme = useMobileShellTheme();
  const tv = Platform.isTV === true;
  const [focused, setFocused] = useState(false);

  const bgStyles = {
    primary: {
      backgroundColor: theme.colors.accent,
      shadowColor: theme.colors.accent,
      shadowOffset: { width: 0, height: 6 } as const,
      shadowOpacity: 0.35,
      shadowRadius: 16,
      elevation: 8,
    },
    secondary: {
      backgroundColor: theme.colors.surfaceRaised,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.05)",
    },
    ghost: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.10)",
    },
    danger: {
      backgroundColor: theme.colors.danger,
      shadowColor: theme.colors.danger,
      shadowOffset: { width: 0, height: 6 } as const,
      shadowOpacity: 0.35,
      shadowRadius: 16,
      elevation: 8,
    },
  };

  const labelColor =
    variant === "primary" || variant === "danger"
      ? theme.accentTextHex
      : theme.colors.text;

  return (
    <Pressable
      testID={testID}
      hasTVPreferredFocus={tv && hasTVPreferredFocus === true ? true : undefined}
      style={[
        styles.button,
        bgStyles[variant],
        // TV: the remote's ring in the text colour, laid out while idle so focusing never shifts the screen (UX-TV-17).
        tv && styles.tvRing,
        tv && focused && { borderColor: theme.colors.text, transform: [{ scale: TV_FOCUS_SCALE }] },
        disabled && styles.disabled,
      ]}
      onFocus={tv ? () => setFocused(true) : undefined}
      onBlur={tv ? () => setFocused(false) : undefined}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onPress={onPress}
      disabled={disabled || loading}
    >
      {loading ? (
        <ActivityIndicator color={theme.colors.text} />
      ) : leading ? (
        <View style={styles.row}>
          {leading}
          <Text style={[styles.label, { color: labelColor, fontWeight: "800" }]}>{label}</Text>
        </View>
      ) : (
        <Text style={[styles.label, { color: labelColor, fontWeight: "800" }]}>{label}</Text>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    paddingVertical: 14,
    borderRadius: 18,
    alignItems: "center",
  },
  tvRing: {
    borderWidth: TV_FOCUS_RING_WIDTH,
    borderColor: "transparent",
  },
  disabled: {
    opacity: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  label: {
    fontSize: 16,
  },
});
