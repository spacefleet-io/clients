import React, { memo, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Cast } from "lucide-react-native";
import { AirPlayPlayer, AirPlayRoutePickerView, type AirPlayRoute } from "@space/mobile-mpv-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { theme } from "../theme/theme";
import { castTargetEntries, type CastDeviceInfo } from "../lib/cast/castPicker";
import type { CastTarget } from "../lib/cast/castFlow";

const ROUTE_POLL_MS = 1500;

type Props = {
  /** Whether the sheet holding the rows is open: the AirPlay route is only watched then. */
  visible: boolean;
  /** Cast devices found on the Wi-Fi (`useDevices()`). */
  devices: readonly CastDeviceInfo[];
  onTarget: (target: CastTarget) => void;
};

/**
 * The Google Cast and AirPlay rows (UX-TV-03), one component for both the Play picker and the "Play on TV" sheet so the
 * two lists cannot drift. Renders a fragment: the parent sheet spaces the rows.
 */
export const CastTargetRows = memo(({ visible, devices, onTarget }: Props) => {
  const { t } = useTranslation();
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const [route, setRoute] = useState<AirPlayRoute | null>(null);

  // AirPlay is chosen in Apple's own sheet (the button), so watch the route while the sheet is open.
  useEffect(() => {
    if (!visible || platform !== "ios") return;
    let alive = true;
    const read = () =>
      void AirPlayPlayer.getRoute()
        .then((next) => alive && setRoute(next))
        .catch(() => undefined);
    read();
    const timer = setInterval(read, ROUTE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [visible, platform]);

  return (
    <>
      {castTargetEntries({ devices, platform, airPlayRoute: route }).map((entry) => {
        switch (entry.kind) {
          case "google-cast":
            return (
              <Pressable
                key={entry.target.deviceId}
                testID={`cast-target-${entry.target.deviceId}`}
                style={castRowStyles.row}
                onPress={() => onTarget(entry.target)}
                accessibilityRole="button"
                accessibilityLabel={entry.target.name}
              >
                <Cast size={20} color={theme.colors.text} />
                <View style={castRowStyles.rowText}>
                  <Text style={castRowStyles.rowName} numberOfLines={1}>
                    {entry.target.name}
                  </Text>
                  <Text style={castRowStyles.rowHint}>
                    {t("cast.deviceHint")} · {entry.target.modelName}
                  </Text>
                </View>
              </Pressable>
            );
          case "airplay-button":
            return (
              <View key="airplay-button" style={castRowStyles.row}>
                {AirPlayRoutePickerView ? (
                  <AirPlayRoutePickerView
                    style={styles.airPlayButton}
                    tintColor={theme.colors.text}
                    activeTintColor={theme.colors.accent}
                    prioritizesVideoDevices
                    accessibilityLabel={t("cast.airplay")}
                  />
                ) : null}
                <View style={castRowStyles.rowText}>
                  <Text style={castRowStyles.rowName}>{t("cast.airplay")}</Text>
                  <Text style={castRowStyles.rowHint}>{t("cast.airplayChoose")}</Text>
                </View>
              </View>
            );
          case "airplay-route":
            return (
              <Pressable
                key="airplay-route"
                testID="cast-target-airplay"
                style={[castRowStyles.row, styles.rowActive]}
                onPress={() => onTarget(entry.target)}
                accessibilityRole="button"
                accessibilityLabel={t("cast.airplayActive", { name: entry.target.name })}
              >
                <Cast size={20} color={theme.colors.accent} />
                <View style={castRowStyles.rowText}>
                  <Text style={castRowStyles.rowName} numberOfLines={1}>
                    {t("cast.airplayActive", { name: entry.target.name })}
                  </Text>
                </View>
              </Pressable>
            );
        }
      })}
    </>
  );
});
CastTargetRows.displayName = "CastTargetRows";

/** Row look shared with the Play picker's "This phone" row. */
export const castRowStyles = StyleSheet.create({
  row: {
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
  },
  rowText: { flex: 1 },
  rowName: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  rowHint: { color: theme.colors.textMuted, fontSize: 12 },
});

const styles = StyleSheet.create({
  rowActive: { borderColor: theme.colors.accent },
  airPlayButton: { width: 28, height: 28 },
});
