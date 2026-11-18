import React, { memo } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Smartphone } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { theme } from "../theme/theme";
import { BottomSheet } from "./BottomSheet";
import { CastTargetRows, castRowStyles } from "./CastTargetRows";
import type { PickerSheet } from "./usePickerSheet";
import type { CastDeviceInfo } from "../lib/cast/castPicker";
import type { CastTarget } from "../lib/cast/castFlow";

type Props = {
  sheet: PickerSheet;
  /** Cast devices found on the Wi-Fi (`useDevices()`). */
  devices: readonly CastDeviceInfo[];
  onPhone: () => void;
  onTarget: (target: CastTarget) => void;
};

/**
 * The play-target picker the play button opens (INTG-CAST-01): the phone itself, then the cast target rows (a Google Cast
 * device, or on an iPhone an AirPlay device) the "Play on TV" sheet shows too (UX-TV-03).
 */
export const CastPickerSheet = memo(({ sheet, devices, onPhone, onTarget }: Props) => {
  const { t } = useTranslation();
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const hasDevices = devices.length > 0;

  return (
    <BottomSheet sheet={sheet} testID="cast-picker">
      <Text style={styles.title} accessibilityRole="header">
        {t("cast.pickerTitle")}
      </Text>
      <Pressable testID="cast-target-phone" style={castRowStyles.row} onPress={onPhone} accessibilityRole="button" accessibilityLabel={t("cast.thisPhone")}>
        <Smartphone size={20} color={theme.colors.text} />
        <View style={castRowStyles.rowText}>
          <Text style={castRowStyles.rowName}>{t("cast.thisPhone")}</Text>
          <Text style={castRowStyles.rowHint}>{t("cast.thisPhoneHint")}</Text>
        </View>
      </Pressable>
      <CastTargetRows visible={sheet.visible} devices={devices} onTarget={onTarget} />
      {platform === "android" && !hasDevices ? <Text style={styles.note}>{t("cast.searching")}</Text> : null}
      {platform === "ios" && !hasDevices ? <Text style={styles.note}>{t("cast.noDevices")}</Text> : null}
    </BottomSheet>
  );
});
CastPickerSheet.displayName = "CastPickerSheet";

const styles = StyleSheet.create({
  title: { color: theme.colors.text, fontSize: 16, fontWeight: "800", fontFamily: theme.font.family.display },
  note: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 17 },
});
