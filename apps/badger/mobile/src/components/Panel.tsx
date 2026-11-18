import React, { memo } from "react";
import { StyleProp, StyleSheet, Text, ViewStyle } from "react-native";
import { SkyCover } from "@space/mobile-shell/components";
import { theme } from "../theme/theme";

/** Rounded surface card shared by Settings groups, Home rows and the Media library (desktop `space-panel`). */
export const panelCardStyle = {
  backgroundColor: theme.colors.surface,
  borderRadius: 16,
  borderWidth: 1,
  borderColor: theme.colors.border,
  overflow: "hidden",
} as const;

/** Inner padding (dp) of a padded `Panel`. */
export const PANEL_PADDING = 12;

type PanelProps = {
  title?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** Padded panel with the title as its header, like the desktop dashboard sections. */
export const Panel = memo(({ title, children, style }: PanelProps) => (
  <SkyCover style={[styles.panel, style]}>
    {title ? (
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
    ) : null}
    {children}
  </SkyCover>
));
Panel.displayName = "Panel";

const styles = StyleSheet.create({
  panel: { ...panelCardStyle, padding: PANEL_PADDING, gap: 12 },
  title: {
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1.8,
    textTransform: "uppercase",
    color: theme.colors.textMuted,
  },
});
