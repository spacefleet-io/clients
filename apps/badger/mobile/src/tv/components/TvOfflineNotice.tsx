import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { CloudOff, RefreshCw } from "lucide-react-native";
import { formatPendingOpsLabel, type MobileOfflineVariant } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { theme } from "../../theme/theme";
import { TV_RADIUS, tvTrackedLabel } from "../lib/tvLook";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";

type TvOfflineNoticeProps = {
  variant: MobileOfflineVariant;
  pendingOps: number;
  onRetry: () => void;
};

/**
 * UX-TV-14: the TV's offline notice is one small button in the top menu row, not the phone's banner. It covers
 * nothing, shifts nothing, and the remote reaches it like a tab; OK retries. The technical cause stays in the logs.
 * It must fit the bar's right side beside Settings without reaching the centred tabs (TV-SHELL-OFFLINE-PILL-001): the
 * icon, the count and Retry sit side by side and never shrink; a title too long for the room left (the sync failure in
 * French, German, …) ends in "…" instead of pushing the pill over the tabs. The changes waiting show as a count, their
 * sentence only in the accessibility label.
 */
export const TvOfflineNotice = ({ variant, pendingOps, onRetry }: TvOfflineNoticeProps) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const Icon = variant === "sync_error" ? RefreshCw : CloudOff;
  const title = t(variant === "sync_error" ? "tvShell.offline.syncError" : "tvShell.offline.network");
  const pendingLabel = pendingOps > 0 ? formatPendingOpsLabel(pendingOps, t) : null;
  const label = [title, pendingLabel, t("tvShell.offline.retry")].filter(Boolean).join(" · ");
  return (
    <TvFocusable
      testID="tv-offline-notice"
      style={styles.notice}
      focusedStyle={styles.noticeFocused}
      scale={1.05}
      onPress={() => {
        console.info("tv.offline.retry", JSON.stringify({ variant, pendingOps }));
        onRetry();
      }}
      accessibilityLabel={label}
    >
      <View style={styles.content}>
        <View style={styles.icon}>
          <Icon size={14 * scale} color={theme.colors.danger} />
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {pendingOps > 0 ? (
          <View style={styles.count} testID="tv-offline-pending">
            <Text style={styles.countText}>{pendingOps}</Text>
          </View>
        ) : null}
        <Text style={styles.retry} numberOfLines={1}>
          {t("tvShell.offline.retry")}
        </Text>
      </View>
    </TvFocusable>
  );
};

/** Sizes in design dp, the height of the bar's tabs (30), scaled with the TV (UX-TV-13). */
const baseStyles = StyleSheet.create({
  notice: {
    flexShrink: 1,
    minWidth: 0,
    height: 30,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: TV_RADIUS.button,
    backgroundColor: "rgba(255,127,127,0.10)",
  },
  noticeFocused: { backgroundColor: "rgba(255,127,127,0.22)" },
  content: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 },
  icon: { flexShrink: 0 },
  title: { ...tvTrackedLabel(10.5), color: theme.colors.danger, flexShrink: 1 },
  count: {
    flexShrink: 0,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,127,127,0.25)",
  },
  countText: { fontSize: 10, fontWeight: "800", color: theme.colors.text },
  retry: { ...tvTrackedLabel(10.5), color: theme.colors.text, flexShrink: 0 },
});
