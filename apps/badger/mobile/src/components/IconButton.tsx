import React, { memo } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

type IconButtonProps = {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
};

/** 48dp minimum touch target icon button with ripple and mandatory accessibility label. */
export const IconButton = memo(({ label, onPress, children, style, disabled }: IconButtonProps) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled: Boolean(disabled) }}
    android_ripple={{ color: "rgba(219, 223, 240, 0.2)", borderless: true, radius: 24 }}
    hitSlop={4}
    style={[styles.button, style]}
  >
    {children}
  </Pressable>
));
IconButton.displayName = "IconButton";

const styles = StyleSheet.create({
  button: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
  },
});
