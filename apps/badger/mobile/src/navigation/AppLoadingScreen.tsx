import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MobileMascotLoader } from "@space/mobile-shell/mascot-loader";
import { IS_TV } from "../tv/lib/tvRuntime";
import { theme } from "../theme/theme";

const MASCOT = require("../assets/mascot.webp");

/**
 * The full-screen wait while the app opens and while it opens the library, on the phone and the TV: the hovering badger
 * above the unchanged loading text (UX-WAIT-02). The text stays the status; the badger is decorative.
 */
export const AppLoadingScreen = ({ label }: { label: string }) => (
  <SafeAreaView style={styles.safeArea}>
    <View style={styles.loadingWrap}>
      <MobileMascotLoader app="badger" source={MASCOT} size={IS_TV ? 180 : 120} />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  </SafeAreaView>
);

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.xl,
  },
  loadingText: {
    color: theme.colors.textMuted,
  },
});
