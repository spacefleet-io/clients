// Badger's full-page section header: large display-font title with an optional subtitle. App-specific (only Badger's
// setup and key-change pages use it); buttons, inputs, cards and screens come straight from @space/mobile-shell.
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
