import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMobileShellTheme } from "../theme";

/** The thin "or" line between two ways to sign in (phone sign-in card, provider rows). */
export const MobileOrDivider = ({ label, testID }: { label: string; testID?: string }) => {
  const theme = useMobileShellTheme();
  return (
    <View testID={testID} style={styles.orRow}>
      <View style={[styles.orLine, { backgroundColor: theme.colors.border }]} />
      <Text style={[styles.orText, { color: theme.colors.textMuted }]}>{label}</Text>
      <View style={[styles.orLine, { backgroundColor: theme.colors.border }]} />
    </View>
  );
};

const styles = StyleSheet.create({
  orRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 },
  orLine: { flex: 1, height: 1 },
  orText: { fontSize: 12.5 },
});
