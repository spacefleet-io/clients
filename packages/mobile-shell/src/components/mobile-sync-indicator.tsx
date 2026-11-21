import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Check, RefreshCw } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";

/**
 * What the library sync shows (LIB-SYNC-13). `progress` is 0..1 while ops pages arrive, null when unknown; a result
 * says how many titles / episodes arrived (null counts: unknown, it just says the library was updated).
 */
export type MobileSyncIndicatorState =
  | { kind: "syncing"; progress: number | null }
  | { kind: "done"; changed: boolean; newTitles: number | null; newEpisodes: number | null }
  | { kind: "failed" };

export type MobileSyncIndicatorCopy = {
  text: string;
  /** Spoken label: the text plus what it means for the user. */
  label: string;
  tone: "busy" | "quiet" | "danger";
};

export const syncIndicatorCopy = (state: MobileSyncIndicatorState, t: TFunction): MobileSyncIndicatorCopy => {
  if (state.kind === "syncing") {
    const text =
      state.progress === null
        ? t("sync.indicator.updating")
        : t("sync.indicator.updatingProgress", { percent: Math.round(state.progress * 100) });
    return { text, label: `${text} — ${t("sync.indicator.savedStaysLabel")}`, tone: "busy" };
  }
  if (state.kind === "failed") {
    const text = t("sync.indicator.failed");
    return { text, label: `${t("sync.indicator.failedLabel")}. ${t("sync.indicator.retry")}`, tone: "danger" };
  }
  const text =
    (state.newEpisodes ?? 0) > 0
      ? t("sync.indicator.newEpisodes", { count: state.newEpisodes })
      : (state.newTitles ?? 0) > 0
        ? t("sync.indicator.newTitles", { count: state.newTitles })
        : state.changed
          ? t("sync.indicator.updated")
          : t("sync.indicator.upToDate");
  return { text, label: text, tone: "quiet" };
};

type MobileSyncIndicatorProps = {
  state: MobileSyncIndicatorState;
  /** A failed sync's tap runs it again. */
  onRetry: () => void;
  testID?: string;
};

/**
 * The library's update sign (LIB-SYNC-13): the same one-line pill as the offline sign (UX-NOTICE-02), on the tab bar's
 * top edge, so the saved library underneath stays usable while a sync runs. "Updating media library…" (with a percentage
 * once the pages are counted), then a quiet result that the store clears on its own; a failure stays, in the danger
 * colour, and a tap retries.
 */
export const MobileSyncIndicator = ({ state, onRetry, testID }: MobileSyncIndicatorProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const copy = syncIndicatorCopy(state, t);
  const color = copy.tone === "danger" ? theme.colors.danger : copy.tone === "busy" ? theme.colors.accent : theme.colors.success;
  const content = (
    <>
      {copy.tone === "busy" ? (
        <ActivityIndicator size={12} color={color} />
      ) : copy.tone === "danger" ? (
        <RefreshCw size={12} color={color} />
      ) : (
        <Check size={12} color={color} />
      )}
      <Text style={[styles.text, { color }]} numberOfLines={1}>
        {copy.text}
      </Text>
    </>
  );

  if (state.kind !== "failed") {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={copy.label}
        accessibilityLiveRegion="polite"
        testID={testID ?? "mobile-sync-indicator"}
        style={[styles.pill, { borderColor: color }]}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.label}
      accessibilityLiveRegion="polite"
      onPress={onRetry}
      hitSlop={10}
      testID={testID ?? "mobile-sync-indicator"}
      style={({ pressed }) => [styles.pill, { borderColor: color, opacity: pressed ? 0.85 : 1 }]}
    >
      {content}
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
});
