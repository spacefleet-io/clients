/**
 * The family's icon-only button on the phone (UX-PHONE-13): a 48 dp round touch target whatever the icon's size, a
 * required screen-reader label, a ripple on Android and a dimmed press on iOS. Badger and Parrot draw every icon button
 * (back arrows, "…" menus, like, keep, retry) with it, so the two apps share one touch floor.
 */
import React, { memo } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

/** The touch target's side, in dp (Material's minimum; Apple asks 44 pt). */
export const MOBILE_ICON_BUTTON_SIZE = 48;

export type MobileIconButtonProps = {
  /** What the button does, read by the screen reader; the icon carries no text. */
  label: string;
  onPress: () => void;
  /** The icon, drawn centred (a lucide icon with its size and colour). */
  children: React.ReactNode;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

const RIPPLE = { color: "rgba(219, 223, 240, 0.2)", borderless: true, radius: MOBILE_ICON_BUTTON_SIZE / 2 } as const;

export const MobileIconButton = memo(({ label, onPress, children, disabled, testID, style }: MobileIconButtonProps) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled: Boolean(disabled) }}
    android_ripple={RIPPLE}
    hitSlop={4}
    style={({ pressed }) => [styles.button, (pressed || disabled) && styles.dimmed, style]}
  >
    {children}
  </Pressable>
));
MobileIconButton.displayName = "MobileIconButton";

const styles = StyleSheet.create({
  button: {
    width: MOBILE_ICON_BUTTON_SIZE,
    height: MOBILE_ICON_BUTTON_SIZE,
    borderRadius: MOBILE_ICON_BUTTON_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dimmed: { opacity: 0.6 },
});
