import React, { memo, useCallback, useMemo } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft, RotateCw, Trash2, X } from "lucide-react-native";
import { MobileEmptyState } from "@space/mobile-shell/components";
import { RootStackParamList } from "../navigation/AppNavigator";
import { IconButton } from "../components/IconButton";
import { RIPPLE } from "../components/PosterCard";
import { useDownloads } from "../lib/downloads/downloadsStore";
import { removeDownloads, retryDownloads } from "../lib/downloads/downloadActions";
import { describeError, formatBytes, isActiveStatus, itemPercent } from "../lib/downloads/decisions";
import { trafficNoticeKey } from "../lib/downloads/trafficNotice";
import type { DownloadItem } from "@space/mobile-media-proxy/downloads";
import type { TFunction } from "i18next";
import { getCurrentLanguage, translate, useTranslation } from "@space/mobile-shell/i18n";
import { formatLocalizedStorageUsage } from "@space/shared/format";
import { theme } from "../theme/theme";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const EMPTY_STATE_IMAGE = require("../assets/empty-state.webp");

const compareItems = (a: DownloadItem, b: DownloadItem): number => {
  const active = Number(isActiveStatus(b.status)) - Number(isActiveStatus(a.status));
  if (active !== 0) return active;
  return (
    a.title.localeCompare(b.title) ||
    (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
    (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0)
  );
};

const statusLine = (item: DownloadItem, networkAllowed: boolean, wifiOnly: boolean, t: TFunction): string => {
  const waiting = wifiOnly ? t("downloads.status.waitingWifi") : t("downloads.status.waitingNetwork");
  switch (item.status) {
    case "completed":
      return t("downloads.status.completed", { size: formatBytes(item.storedBytes || item.estimatedBytes), quality: item.quality });
    case "failed":
      return describeError(item);
    case "queued":
      return networkAllowed ? t("downloads.status.queued") : waiting;
    case "waiting_network":
      return waiting;
    case "downloading": {
      if (!networkAllowed) return waiting;
      // Done against the total: never reads equal while bytes remain (STOR-UNIT-01); a zero start reads "0 MB" like formatBytes.
      const { used: done, limit: total } = formatLocalizedStorageUsage(item.doneBytes, item.estimatedBytes, getCurrentLanguage(), {
        minUnit: item.doneBytes > 0 ? "B" : "MB",
      });
      return t("downloads.status.downloading", { percent: itemPercent(item), done, total });
    }
  }
};

type RowProps = {
  item: DownloadItem;
  networkAllowed: boolean;
  wifiOnly: boolean;
  onOpen: (mediaId: string) => void;
  onDelete: (item: DownloadItem) => void;
  onRetry: (id: string) => void;
};

const DownloadRow = memo(({ item, networkAllowed, wifiOnly, onOpen, onDelete, onRetry }: RowProps) => {
  const { t } = useTranslation();
  const active = isActiveStatus(item.status);
  const failed = item.status === "failed";
  const percent = itemPercent(item);
  const handleOpen = useCallback(() => onOpen(item.mediaId), [onOpen, item.mediaId]);
  const handleDelete = useCallback(() => onDelete(item), [onDelete, item]);
  const handleRetry = useCallback(() => onRetry(item.id), [onRetry, item.id]);
  return (
    <Pressable
      style={styles.row}
      onPress={handleOpen}
      android_ripple={RIPPLE}
      accessibilityRole="button"
      accessibilityLabel={`${item.title} ${item.subtitle ?? ""}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {item.subtitle}
          </Text>
        ) : null}
        <Text style={[styles.rowStatus, failed && { color: theme.colors.danger }]} numberOfLines={2}>
          {statusLine(item, networkAllowed, wifiOnly, t)}
        </Text>
        {active ? (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
        ) : null}
      </View>
      {failed && item.errorCode !== "insufficient_space" ? (
        <IconButton label={t("downloads.row.retry")} onPress={handleRetry}>
          <RotateCw size={20} color={theme.colors.accent} />
        </IconButton>
      ) : null}
      <IconButton label={active ? t("downloads.row.cancel") : t("downloads.row.delete")} onPress={handleDelete}>
        {active ? <X size={20} color={theme.colors.textMuted} /> : <Trash2 size={20} color={theme.colors.textMuted} />}
      </IconButton>
    </Pressable>
  );
});
DownloadRow.displayName = "DownloadRow";

export const DownloadsScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const state = useDownloads();
  const items = useMemo(() => [...state.items].sort(compareItems), [state.items]);
  const trafficKey = trafficNoticeKey(state);
  const totalBytes = useMemo(
    () => state.items.reduce((sum, i) => sum + (i.status === "completed" ? i.storedBytes || i.estimatedBytes : i.doneBytes), 0),
    [state.items],
  );

  const goBack = useCallback(() => navigation.goBack(), [navigation]);
  const openMedia = useCallback(
    (mediaId: string) => navigation.navigate("MediaDetails", { mediaId }),
    [navigation],
  );
  const confirmDelete = useCallback((item: DownloadItem) => {
    const active = isActiveStatus(item.status);
    const label = item.subtitle ? `${item.title} ${item.subtitle}` : item.title;
    Alert.alert(
      active ? translate("downloads.confirmCancel.title") : translate("downloads.confirmDelete.title"),
      translate("downloads.confirmDelete.message", { label }),
      [
        { text: translate("downloads.actions.keep"), style: "cancel" },
        {
          text: active ? translate("downloads.row.cancel") : translate("downloads.actions.delete"),
          style: "destructive",
          onPress: () => void removeDownloads([item.id]),
        },
      ],
    );
  }, []);
  const retry = useCallback((id: string) => void retryDownloads([id]), []);
  const confirmDeleteAll = useCallback(() => {
    Alert.alert(translate("downloads.deleteAll.title"), translate("downloads.deleteAll.message", { size: formatBytes(totalBytes) }), [
      { text: translate("downloads.actions.keep"), style: "cancel" },
      {
        text: translate("downloads.deleteAll.confirm"),
        style: "destructive",
        onPress: () => void removeDownloads(state.items.map((i) => i.id)),
      },
    ]);
  }, [state.items, totalBytes]);

  const renderItem = useCallback(
    ({ item }: { item: DownloadItem }) => (
      <DownloadRow
        item={item}
        networkAllowed={state.networkAllowed}
        wifiOnly={state.wifiOnly}
        onOpen={openMedia}
        onDelete={confirmDelete}
        onRetry={retry}
      />
    ),
    [state.networkAllowed, state.wifiOnly, openMedia, confirmDelete, retry],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <IconButton label={t("downloads.back")} onPress={goBack}>
          <ArrowLeft size={22} color={theme.colors.text} />
        </IconButton>
        <View style={styles.headerText}>
          <Text style={styles.title} accessibilityRole="header">
            {t("downloads.title")}
          </Text>
          <Text style={styles.summary}>{t("downloads.summary", { count: items.length, size: formatBytes(totalBytes) })}</Text>
        </View>
        {items.length > 0 ? (
          <IconButton label={t("downloads.deleteAll.label")} onPress={confirmDeleteAll}>
            <Trash2 size={20} color={theme.colors.textMuted} />
          </IconButton>
        ) : null}
      </View>
      {state.wifiOnly && !state.networkAllowed && items.some((i) => isActiveStatus(i.status)) ? (
        <Text style={styles.banner}>{t("downloads.wifiBanner")}</Text>
      ) : null}
      {trafficKey ? <Text style={styles.banner}>{t(trafficKey)}</Text> : null}
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <MobileEmptyState
            imageSource={EMPTY_STATE_IMAGE}
            title={t("downloads.empty.title")}
            subtitle={t("downloads.empty.subtitle")}
          />
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 8, gap: 4 },
  headerText: { flex: 1 },
  title: { color: theme.colors.text, fontSize: 22, fontWeight: "800" },
  summary: { color: theme.colors.textDim, fontSize: 12, marginTop: 2 },
  banner: {
    color: theme.colors.warning,
    backgroundColor: theme.colors.accentSoft,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    fontSize: 13,
  },
  list: { paddingHorizontal: 16, paddingBottom: 32, gap: 8, flexGrow: 1 },
  row: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: theme.colors.text, fontSize: 15, fontWeight: "700" },
  rowSubtitle: { color: theme.colors.textMuted, fontSize: 13 },
  rowStatus: { color: theme.colors.textDim, fontSize: 12 },
  track: { height: 4, borderRadius: 2, backgroundColor: theme.colors.surfaceRaised, overflow: "hidden", marginTop: 6 },
  fill: { height: 4, backgroundColor: theme.colors.accent },
});
