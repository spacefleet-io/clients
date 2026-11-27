// The top of a pushed page (album, artist, playlist): no navigator header, the page's own sky running up behind the
// status bar, and a round back button floating over it (UX-SKY-04).
import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { MOBILE_ICON_BUTTON_SIZE, MobileIconButton } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { colors, spacing } from "../theme";

/** The back button's row: the shared 48 dp icon button (UX-PHONE-13) and the gap under it, below the status bar. */
export const PAGE_BACK_ROW = MOBILE_ICON_BUTTON_SIZE + spacing.sm * 2;

/** Where a pushed page's content starts: under the status bar and the floating back button. */
export const usePageTop = () => useSafeAreaInsets().top + PAGE_BACK_ROW;

/**
 * The shared icon button (UX-PHONE-13, 48 dp like every phone icon button), round like the player's controls and dark
 * enough to find over any cover the page scrolls under it. Its label speaks the app's language, never Android's own
 * "Navigate up" (UX-I18N-01).
 */
export const PageBackButton = ({ onPress }: { onPress: () => void }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.row, { top: insets.top + spacing.sm, left: insets.left + spacing.lg }]}>
      <MobileIconButton testID="page-back" label={t("parrot.nav.back")} onPress={onPress} style={styles.round}>
        <ArrowLeft color={colors.text} size={22} />
      </MobileIconButton>
    </View>
  );
};

const styles = StyleSheet.create({
  row: { position: "absolute" },
  // The dark round behind the arrow over any cover; the shared button gives its size, shape and press.
  round: {
    backgroundColor: "rgba(0,0,0,0.45)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.22)",
  },
});
