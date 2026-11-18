// Re-export from shell package for backward compatibility.
export { MobileButton as Button } from "@space/mobile-shell/components";
export { MobileInput as Input } from "@space/mobile-shell/components";
export { MobileCard as Card } from "@space/mobile-shell/components";

// SectionHeader is app-specific (uses display font + subtitle).
// The shell has MobileSectionHeader (row title with icon) for poster rows,
// but this one is the full-page section header with large title + subtitle.
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMobileShellTheme } from "@space/mobile-shell/theme";

export const SectionHeader = ({ title, subtitle }: { title: string; subtitle?: string }) => {
  const theme = useMobileShellTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text
        style={[
          styles.sectionTitle,
          {
            color: theme.colors.text,
            fontFamily: theme.font.family.display,
          },
        ]}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text style={[styles.sectionSubtitle, { color: theme.colors.textMuted }]}>{subtitle}</Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  sectionHeader: {
    gap: 6,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  sectionSubtitle: {
    fontSize: 14,
  },
});
