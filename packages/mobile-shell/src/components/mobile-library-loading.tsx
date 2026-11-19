import React from "react";
import { StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import type { MascotLoaderApp } from "@space/shared/mascotLoader";
import { useMobileShellTheme } from "../theme";
import { MobileMascotLoader } from "./mobile-mascot-loader";

type MobileLibraryLoadingProps = {
  app: MascotLoaderApp;
  /** The app's mascot picture (`src/assets/mascot.webp`). */
  source: ImageSourcePropType;
  /** "Loading library..." in the app's language. */
  label: string;
  /** Side of the mascot, dp: 120 on the phone, 180 on the TV (the size of the app's opening screen). */
  size?: number;
};

/**
 * What Home and the library page show while the library's content is not known yet (UX-WAIT-04): the app's opening
 * screen, i.e. its moving mascot above "Loading library..." (UX-WAIT-02), never the empty library. Transparent, so it
 * stands on the page's sky; the text is the status, the mascot is decorative.
 */
export const MobileLibraryLoading = ({ app, source, label, size = 120 }: MobileLibraryLoadingProps) => {
  const theme = useMobileShellTheme();
  return (
    <View style={styles.wrap} testID="library-loading" accessibilityRole="progressbar" accessibilityLabel={label}>
      <MobileMascotLoader app={app} source={source} size={size} />
      <Text style={[styles.label, { color: theme.colors.textMuted }]}>{label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 24 },
  label: { textAlign: "center" },
});
