// The top of a pushed page (album, artist, playlist): no navigator header, the page's own sky running up behind the
// status bar, and a round back button floating over it (UX-SKY-04).
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { colors, spacing } from "../theme";

const BUTTON = 44;

/** The back button's row: the button and the gap under it, below the status bar. */
export const PAGE_BACK_ROW = BUTTON + spacing.sm * 2;

/** Where a pushed page's content starts: under the status bar and the floating back button. */
export const usePageTop = () => useSafeAreaInsets().top + PAGE_BACK_ROW;

/**
 * Round like the player's controls, dark enough to find over any cover the page scrolls under it. Its label speaks
 * the app's language, never Android's own "Navigate up" (UX-I18N-01).
 */
export const PageBackButton = ({ onPress }: { onPress: () => void }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.row, { top: insets.top + spacing.sm, left: insets.left + spacing.lg }]}>
      <Pressable
        testID="page-back"
        accessibilityRole="button"
        accessibilityLabel={t("parrot.nav.back")}
        hitSlop={8}
        onPress={onPress}
        style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]}
      >
        <ArrowLeft color={colors.text} size={22} />
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  row: { position: "absolute" },
  button: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
});
