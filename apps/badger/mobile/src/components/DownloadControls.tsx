import React, { memo, useCallback, useMemo } from "react";
import { Alert, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Clock, Download, RotateCw, TriangleAlert, WifiOff } from "lucide-react-native";
import type { TFunction } from "i18next";
import { translate, useTranslation } from "@space/mobile-shell/i18n";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { useAuth } from "../store/auth";
import { useLibraryActions } from "../store/library";
import { derivePillState, describeError, formatBytes, isActiveStatus, type PillState } from "../lib/downloads/decisions";
import { removeDownloads, retryDownloads, startDownload, type StartDownloadResult } from "../lib/downloads/downloadActions";
import { useDownloadsById } from "../lib/downloads/downloadsStore";
import { askDownloadQuality } from "../lib/downloads/qualityPrompt";
import { inScopeFileIds, type OfflineScope } from "../lib/downloads/scope";
import { downloadedSeasonNumbers, seasonPickerChanges, seasonPickerRows, type SeasonPickerRow } from "../lib/downloads/seasonPicker";
import { theme } from "../theme/theme";

const alertForResult = (result: StartDownloadResult): void => {
  switch (result.kind) {
    case "refused":
      if (result.refusal.reason === "insufficient_space") {
        Alert.alert(
          translate("downloads.refused.insufficientSpace.title"),
          translate("downloads.refused.insufficientSpace.message", {
            required: formatBytes(result.refusal.requiredBytes),
            free: formatBytes(result.refusal.freeBytes),
          }),
        );
      } else {
        Alert.alert(translate("downloads.refused.noNetwork.title"), translate("downloads.refused.noNetwork.message"));
      }
      return;
    case "nothing":
      Alert.alert(
        translate("downloads.nothing.title"),
        translate(`downloads.nothing.${result.reason}`),
      );
      return;
    case "error":
      Alert.alert(
        translate("downloads.errors.failedTitle"),
        result.reason === "details_missing" ? translate("downloads.errors.detailsMissing") : result.detail,
      );
      return;
    case "cancelled":
      return;
    case "enqueued":
      if (result.waitForWifi) {
        Alert.alert(translate("downloads.waitingWifiAlert.title"), translate("downloads.waitingWifiAlert.message"));
      }
      return;
  }
};

/**
 * State + press behaviour of one download control, bound to a scope of
 * `details` (movie, whole show, one season or one episode).
 */
export const useScopeDownload = (details: MediaDetails, scope: OfflineScope) => {
  const { token } = useAuth();
  const { getMediaDetails } = useLibraryActions();
  const { byId, state } = useDownloadsById();
  const scopeKey = scope.kind === "season" ? `season-${scope.seasonNumber}` : scope.kind === "episode" ? `ep-${scope.seasonNumber}-${scope.episodeNumber}` : scope.kind;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey encodes scope
  const fileIds = useMemo(() => inScopeFileIds(details, scope), [details, scopeKey]);
  const pill = useMemo(
    () => derivePillState(fileIds, byId, { networkAllowed: state.networkAllowed, wifiOnly: state.wifiOnly }),
    [fileIds, byId, state.networkAllowed, state.wifiOnly],
  );

  const onPress = useCallback(() => {
    const inScope = fileIds.map((id) => byId.get(id)).filter((i) => i !== undefined);
    const confirmRemove = (title: string, ids: string[]) =>
      Alert.alert(title, translate("downloads.confirmRemove.message"), [
        { text: translate("downloads.actions.keep"), style: "cancel" },
        { text: translate("downloads.actions.remove"), style: "destructive", onPress: () => void removeDownloads(ids) },
      ]);

    switch (pill.kind) {
      case "idle":
      case "partial":
        if (!token) return;
        void startDownload({
          details,
          scopes: [scope],
          token,
          loadFullDetails: (id) => getMediaDetails(id),
          chooseQuality: askDownloadQuality,
        }).then(alertForResult);
        return;
      case "queued":
      case "waiting":
      case "downloading":
        confirmRemove(translate("downloads.confirmCancel.title"), inScope.filter((i) => isActiveStatus(i.status)).map((i) => i.id));
        return;
      case "downloaded":
        confirmRemove(translate("downloads.confirmRemove.title"), inScope.map((i) => i.id));
        return;
      case "error":
        if (pill.retryable) {
          void retryDownloads(inScope.filter((i) => i.status === "failed").map((i) => i.id));
        } else {
          Alert.alert(translate("downloads.errors.failedTitle"), describeError(pill.error), [
            { text: translate("downloads.actions.close"), style: "cancel" },
            {
              text: translate("downloads.actions.remove"),
              style: "destructive",
              onPress: () => void removeDownloads(inScope.map((i) => i.id)),
            },
          ]);
        }
        return;
    }
  }, [pill, token, details, scope, fileIds, byId, getMediaDetails]);

  return { pill, onPress, hasFiles: fileIds.length > 0 };
};

const pillLabel = (pill: PillState, t: TFunction): string => {
  switch (pill.kind) {
    case "idle":
      return t("downloads.pill.idle");
    case "partial":
      return t("downloads.pill.partial", { completed: pill.completed, total: pill.total });
    case "queued":
      return t("downloads.pill.queued");
    case "waiting":
      return pill.reason === "wifi" ? t("downloads.pill.waitingWifi") : t("downloads.pill.waitingNetwork");
    case "downloading":
      return t("downloads.pill.downloading", { percent: pill.percent });
    case "downloaded":
      return t("downloads.pill.downloaded");
    case "error": {
      const message = describeError(pill.error);
      return pill.retryable ? t("downloads.pill.errorRetry", { message }) : message;
    }
  }
};

const PillIcon = ({ pill, size = 20 }: { pill: PillState; size?: number }) => {
  const { t } = useTranslation();
  const color = theme.colors.text;
  switch (pill.kind) {
    case "idle":
    case "partial":
      return <Download size={size} color={color} />;
    case "queued":
      return <Clock size={size} color={color} />;
    case "waiting":
      return <WifiOff size={size} color={color} />;
    case "downloading":
      return <Text style={styles.percent}>{t("downloads.percent", { percent: pill.percent })}</Text>;
    case "downloaded":
      // Desktop's "saved offline" look: the download glyph on a solid accent chip, not a check
      // (a check reads as "watched").
      return (
        <View style={[styles.savedChip, { width: size + 12, height: size + 12, borderRadius: (size + 12) / 2 }]}>
          <Download size={size - 2} color={theme.accentTextHex} strokeWidth={2.5} />
        </View>
      );
    case "error":
      return pill.retryable ? <RotateCw size={size} color={theme.colors.danger} /> : <TriangleAlert size={size} color={theme.colors.danger} />;
  }
};

type ControlProps = {
  details: MediaDetails;
  style?: StyleProp<ViewStyle>;
  /** Shows only: the button opens the season picker instead of downloading the whole show. */
  onPickSeasons?: () => void;
};

/** The main download button: a movie, or (via the season picker) a show. */
export const DownloadPill = memo(({ details, style, onPickSeasons }: ControlProps) => {
  const isShow = details.files.some((f) => f.season != null && f.episode != null);
  const scope = useMemo<OfflineScope>(() => (isShow ? { kind: "show" } : { kind: "movie" }), [isShow]);
  const { t } = useTranslation();
  const { pill, onPress, hasFiles } = useScopeDownload(details, scope);
  const pickSeasons = isShow ? onPickSeasons : undefined;
  return (
    <Pressable
      testID="download-pill"
      style={[styles.pill, pill.kind === "downloaded" && styles.pillDone, !hasFiles && styles.disabled, style]}
      onPress={pickSeasons ?? onPress}
      disabled={!hasFiles}
      accessibilityRole="button"
      accessibilityLabel={pickSeasons ? t("downloads.picker.open") : pillLabel(pill, t)}
      android_ripple={RIPPLE}
    >
      <PillIcon pill={pill} />
    </Pressable>
  );
});
DownloadPill.displayName = "DownloadPill";

/** One-line status of a season row in the picker. */
export const seasonRowStatus = (row: SeasonPickerRow, t: TFunction): string => {
  const { state } = row;
  switch (state.kind) {
    case "idle":
      return t("downloads.picker.episodes", { count: row.fileIds.length });
    case "partial":
      return t("downloads.picker.partial", { completed: state.completed, total: state.total });
    case "queued":
      return t("downloads.status.queued");
    case "waiting":
      return state.reason === "wifi" ? t("downloads.status.waitingWifi") : t("downloads.status.waitingNetwork");
    case "downloading":
      return t("downloads.picker.downloading", { percent: state.percent });
    case "downloaded":
      return t("downloads.picker.downloaded");
    case "error":
      return describeError(state.error);
  }
};

/**
 * Season rows of a show for the download picker, the seasons fully saved
 * offline (chip stamps), and `apply` to download ticked / remove unticked seasons.
 */
export const useShowSeasonDownloads = (details: MediaDetails | null) => {
  const { token } = useAuth();
  const { getMediaDetails } = useLibraryActions();
  const { byId, state } = useDownloadsById();
  const rows = useMemo(
    () => (details ? seasonPickerRows(details, byId, { networkAllowed: state.networkAllowed, wifiOnly: state.wifiOnly }) : []),
    [details, byId, state.networkAllowed, state.wifiOnly],
  );
  const downloadedSeasons = useMemo(() => downloadedSeasonNumbers(rows), [rows]);

  const apply = useCallback(
    (checked: ReadonlySet<number>) => {
      if (!details) return;
      const { add, removeIds } = seasonPickerChanges(rows, checked, byId);
      const startAdds = async () => {
        if (!token || add.length === 0) return;
        // Every ticked season in one request: one quality prompt for the whole batch (OFFL-QUAL-01).
        const result = await startDownload({
          details,
          scopes: add.map((seasonNumber) => ({ kind: "season", seasonNumber }) as const),
          token,
          loadFullDetails: (id) => getMediaDetails(id),
          chooseQuality: askDownloadQuality,
        });
        alertForResult(result);
      };
      if (removeIds.length === 0) {
        void startAdds();
        return;
      }
      Alert.alert(translate("downloads.confirmRemove.title"), translate("downloads.confirmRemove.message"), [
        { text: translate("downloads.actions.keep"), style: "cancel" },
        {
          text: translate("downloads.actions.remove"),
          style: "destructive",
          onPress: () => void removeDownloads(removeIds).then(startAdds),
        },
      ]);
    },
    [details, rows, byId, token, getMediaDetails],
  );

  return { rows, downloadedSeasons, apply };
};

/** Compact per-episode download control; renders nothing for episodes without a file. */
export const EpisodeDownloadButton = memo(
  ({ details, seasonNumber, episodeNumber }: { details: MediaDetails; seasonNumber: number; episodeNumber: number }) => {
    const scope = useMemo<OfflineScope>(() => ({ kind: "episode", seasonNumber, episodeNumber }), [seasonNumber, episodeNumber]);
    const { t } = useTranslation();
    const { pill, onPress, hasFiles } = useScopeDownload(details, scope);
    if (!hasFiles) return null;
    return (
      <Pressable
        testID={`download-episode-${seasonNumber}-${episodeNumber}`}
        style={styles.episodeButton}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={t("downloads.episodeA11y", { label: pillLabel(pill, t), episode: episodeNumber })}
        hitSlop={4}
        android_ripple={RIPPLE_BORDERLESS}
      >
        <PillIcon pill={pill} size={18} />
      </Pressable>
    );
  },
);
EpisodeDownloadButton.displayName = "EpisodeDownloadButton";

const RIPPLE = { color: "rgba(219, 223, 240, 0.18)" } as const;
const RIPPLE_BORDERLESS = { color: "rgba(219, 223, 240, 0.2)", borderless: true, radius: 24 } as const;

const styles = StyleSheet.create({
  pill: {
    width: 58,
    height: 56,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
    backgroundColor: theme.colors.surface,
    justifyContent: "center",
    alignItems: "center",
  },
  pillDone: {
    backgroundColor: theme.colors.accentSoft,
    borderColor: theme.colors.accent,
  },
  savedChip: { backgroundColor: theme.colors.accent, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
  percent: { color: theme.colors.text, fontSize: 13, fontWeight: "800" },
  episodeButton: { width: 44, height: 48, alignItems: "center", justifyContent: "center" },
});
