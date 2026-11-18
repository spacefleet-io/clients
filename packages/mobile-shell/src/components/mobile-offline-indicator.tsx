import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { CloudOff, RefreshCw } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";

/**
 * "network": the device cannot reach the server. "sync_error": the connection is fine but the media library could
 * not sync (e.g. a missing op blob in storage); it must not say "Offline".
 */
export type MobileOfflineVariant = "network" | "sync_error";

type MobileOfflineIndicatorProps = {
  pendingOps: number;
  onRetry: () => void;
  variant?: MobileOfflineVariant;
  testID?: string;
};

export const formatPendingOpsLabel = (count: number, t: TFunction): string =>
  t("offline.pending", { count: Math.max(0, count) });

/**
 * The small lasting offline sign (UX-NOTICE-02): a one-line pill the shell puts on the tab bar's top edge, so it adds
 * no height to any page. Offline is a normal state (the saved library and downloads keep working), so this is all
 * that stays on screen; the passing notice (`MobileNoticeToast`) says it once when the app goes offline. Tapping it
 * retries. No technical detail: the spoken label says what is shown and how many changes are waiting.
 */
export const MobileOfflineIndicator = ({ pendingOps, onRetry, variant = "network", testID }: MobileOfflineIndicatorProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const Icon = variant === "sync_error" ? RefreshCw : CloudOff;
  const copyKey = variant === "sync_error" ? "offline.indicator.syncError" : "offline.indicator.network";
  const waiting = pendingOps > 0 ? formatPendingOpsLabel(pendingOps, t) : null;
  const label = [t(`${copyKey}.label`), waiting, t("offline.indicator.retry")].filter(Boolean).join(". ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onRetry}
      hitSlop={10}
      testID={testID ?? "mobile-offline-indicator"}
      style={({ pressed }) => [
        styles.pill,
        { borderColor: theme.colors.danger, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Icon size={12} color={theme.colors.danger} />
      <Text style={[styles.text, { color: theme.colors.danger }]} numberOfLines={1}>
        {t(`${copyKey}.text`)}
      </Text>
      {waiting ? (
        <Text style={[styles.count, { color: theme.colors.textMuted }]} numberOfLines={1}>
          {String(pendingOps)}
        </Text>
      ) : null}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 22,
    paddingHorizontal: 9,
    borderRadius: 11,
    borderWidth: 1,
    backgroundColor: "rgba(18, 20, 33, 0.96)",
  },
  text: {
    fontSize: 11,
    fontWeight: "700",
  },
  count: {
    fontSize: 11,
    fontWeight: "700",
  },
});
