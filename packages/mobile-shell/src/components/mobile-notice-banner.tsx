import React from "react";
import { StyleSheet, Text, type ViewStyle } from "react-native";
import { useMobileShellTheme } from "../theme";
import { SkyCover } from "./mobile-sky-cover";

type MobileNoticeBannerProps = {
  message: string;
  tone?: "neutral" | "info" | "error";
  style?: ViewStyle;
};

export const MobileNoticeBanner = ({
  message,
  tone = "neutral",
  style,
}: MobileNoticeBannerProps) => {
  const theme = useMobileShellTheme();

  const toneColors = {
    neutral: { bg: theme.colors.surface, border: theme.colors.border, text: theme.colors.textMuted },
    info: { bg: theme.colors.accentSoft, border: theme.colors.accent, text: theme.colors.accent },
    error: { bg: "rgba(255,127,127,0.08)", border: theme.colors.danger, text: theme.colors.danger },
  };

  const colors = toneColors[tone];

  return (
    <SkyCover
      style={[
        styles.banner,
        {
          backgroundColor: colors.bg,
          borderColor: colors.border,
        },
        style,
      ]}
    >
      <Text style={[styles.message, { color: colors.text }]}>{message}</Text>
    </SkyCover>
  );
};

const styles = StyleSheet.create({
  banner: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  message: {
    fontSize: 13,
    fontWeight: "600",
  },
});
