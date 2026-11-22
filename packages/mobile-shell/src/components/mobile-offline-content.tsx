/**
 * Settings › "Manage offline content" on the phones (OFFL-MANAGE-01), one screen for Badger and Parrot: one compact row
 * with the total saved offline on this phone and an outlined "Remove all" (behind a confirmation), then every saved item
 * in up to three levels, each row with the space it takes and a bin that removes it and everything inside it. Levels are
 * told apart by tint, not by indenting: the card colour, a lighter grey, then the app's accent tint, and each top-level
 * item with what is open under it forms one rounded block. Badger lists films and shows › seasons › episodes, Parrot
 * artists › albums › songs then playlists › songs; the grouping and the sizes are `@space/shared/offlineManage`, the app
 * hands the list in and does the removing. Text wraps everywhere and nothing has a fixed height, so the screen stays
 * readable at the largest system font size.
 */
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowLeft, ChevronDown, ChevronRight, Trash2 } from "lucide-react-native";
import type { OfflineManageList, OfflineManageRow } from "@space/shared/offlineManage";
import { formatLocalizedStorage } from "@space/shared/format";
import { getCurrentLanguage, useTranslation } from "../i18n";
import { scopeLogger } from "../logger";
import { useMobileShellTheme, type MobileShellTheme } from "../theme";

const log = scopeLogger("offline-content");

export type MobileOfflineContentApp = "badger" | "parrot";

export type MobileOfflineContentProps = {
  /** Which app's wording (films and episodes, or albums and songs). */
  app: MobileOfflineContentApp;
  /** What is kept, grouped; null while it loads. */
  list: OfflineManageList | null;
  /** Removes one row and everything inside it; the app then hands a new list. */
  onRemove: (row: OfflineManageRow) => Promise<void>;
  /** Removes everything kept on the phone. */
  onRemoveAll: () => Promise<void>;
  onBack: () => void;
  /**
   * The picture of a top-level row or an album row (the app's own artwork component, which fills the `size` square);
   * null = none. Other rows have no picture.
   */
  renderArtwork?: (row: OfflineManageRow, size: number) => React.ReactNode;
  /** Shown above the list (Badger: the link to downloads still in progress). */
  header?: React.ReactNode;
};

type VisibleRow = { row: OfflineManageRow; depth: number };

/** The rows on screen: top-level rows, and the children of each expanded one. */
export const visibleOfflineRows = (rows: readonly OfflineManageRow[], expanded: ReadonlySet<string>, depth = 0): VisibleRow[] =>
  rows.flatMap((row) => [
    { row, depth },
    ...(expanded.has(row.key) && row.children.length > 0 ? visibleOfflineRows(row.children, expanded, depth + 1) : []),
  ]);

export const formatOfflineBytes = (bytes: number): string =>
  formatLocalizedStorage(bytes, getCurrentLanguage(), { minUnit: bytes > 0 ? "B" : "MB" });

const TOP_ART = 44;
const NESTED_ART = 36;

export const MobileOfflineContent = ({ app, list, onRemove, onRemoveAll, onBack, renderArtwork, header }: MobileOfflineContentProps) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const styles = useMemo(() => stylesFor(theme), [theme]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const nameOf = useCallback(
    (row: OfflineManageRow): string => {
      if (row.title) return row.title;
      switch (row.kind) {
        case "season":
          return t("offlineContent.season", { n: row.seasonNumber ?? 0 });
        case "episode":
          return t("offlineContent.unknownEpisode");
        case "movie":
        case "show":
          return t("offlineContent.unknownTitle");
        case "artist":
          return t("offlineContent.unknownArtist");
        default:
          return t("offlineContent.unknown");
      }
    },
    [t]
  );

  const detailOf = useCallback(
    (row: OfflineManageRow): string => {
      const parts: string[] = [];
      if (row.kind === "episode" && row.seasonNumber !== undefined && row.episodeNumber !== undefined) {
        parts.push(t("offlineContent.episodeNumber", { season: row.seasonNumber, episode: row.episodeNumber }));
      }
      if (row.subtitle) parts.push(row.subtitle);
      parts.push(formatOfflineBytes(row.bytes));
      return parts.join(" · ");
    },
    [t]
  );

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setFailed(false);
    try {
      await action();
      log.info("removed", { key });
    } catch (err) {
      log.warn("remove.failed", { key, error: String(err) });
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }, []);

  const remove = useCallback((row: OfflineManageRow) => void run(row.key, () => onRemove(row)), [run, onRemove]);

  const confirmRemoveAll = useCallback(() => {
    Alert.alert(t(`offlineContent.${app}.confirmTitle`), t(`offlineContent.${app}.confirmBody`), [
      { text: t("offlineContent.confirmCancel"), style: "cancel" },
      { text: t("offlineContent.confirmRemove"), style: "destructive", onPress: () => void run("*", onRemoveAll) },
    ]);
  }, [app, onRemoveAll, run, t]);

  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const rows = useMemo(() => (list ? visibleOfflineRows(list.rows, expanded) : []), [list, expanded]);
  const empty = list !== null && list.rows.length === 0;
  const tints = useMemo(() => [theme.colors.surface, theme.colors.surfaceRaised, theme.colors.accentSoft], [theme]);

  const renderItem = useCallback(
    ({ item, index }: { item: VisibleRow; index: number }) => {
      const { row, depth } = item;
      const name = nameOf(row);
      const parent = row.children.length > 0;
      const open = expanded.has(row.key);
      const first = depth === 0;
      const last = index === rows.length - 1 || rows[index + 1]?.depth === 0;
      const artSize = first ? TOP_ART : NESTED_ART;
      const artwork = first || row.kind === "album" ? renderArtwork?.(row, artSize) ?? null : null;
      const Chevron = open ? ChevronDown : ChevronRight;
      return (
        <View
          testID={`offline-row-${row.key}`}
          style={[
            styles.row,
            { backgroundColor: tints[Math.min(depth, tints.length - 1)] },
            first ? styles.groupTop : styles.hairTop,
            last && styles.groupBottom,
          ]}
        >
          <Pressable
            testID={`offline-toggle-${row.key}`}
            style={styles.rowMain}
            disabled={!parent}
            onPress={() => toggle(row.key)}
            accessibilityRole={parent ? "button" : undefined}
            accessibilityState={parent ? { expanded: open } : undefined}
            accessibilityLabel={parent ? t("offlineContent.expand", { name }) : undefined}
          >
            <View style={styles.chevronSlot}>{parent ? <Chevron size={20} color={theme.colors.textMuted} /> : null}</View>
            {artwork ? (
              <View style={[styles.artwork, { width: artSize, height: artSize }, row.kind === "artist" && { borderRadius: artSize / 2 }]}>{artwork}</View>
            ) : null}
            <View style={styles.rowText}>
              <Text testID={`offline-title-${row.key}`} style={[styles.rowTitle, parent && depth < 2 && styles.rowTitleStrong]}>
                {name}
              </Text>
              <Text testID={`offline-detail-${row.key}`} style={styles.rowDetail}>
                {detailOf(row)}
              </Text>
            </View>
          </Pressable>
          {busy === row.key ? (
            <ActivityIndicator style={styles.icon} color={theme.colors.accent} />
          ) : (
            <Pressable
              testID={`offline-remove-${row.key}`}
              style={styles.icon}
              disabled={busy !== null}
              onPress={() => remove(row)}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={t("offlineContent.remove", { name })}
            >
              <Trash2 size={20} color={theme.colors.textMuted} />
            </Pressable>
          )}
        </View>
      );
    },
    [busy, detailOf, expanded, nameOf, remove, renderArtwork, rows, styles, t, theme, tints, toggle]
  );

  return (
    <View testID="offline-content-screen" style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          testID="offline-content-back"
          style={styles.icon}
          onPress={onBack}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={t("offlineContent.back")}
        >
          <ArrowLeft size={22} color={theme.colors.text} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          {t("offlineContent.title")}
        </Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.row.key}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.top}>
            {header}
            <View style={styles.summary}>
              {list ? (
                <Text style={styles.summaryText}>
                  <Text testID="offline-content-total" style={styles.summaryValue}>
                    {formatOfflineBytes(list.totalBytes)}
                  </Text>{" "}
                  {t("offlineContent.totalSuffix")}
                </Text>
              ) : (
                <ActivityIndicator testID="offline-content-loading" color={theme.colors.accent} />
              )}
              {list && !empty ? (
                <Pressable
                  testID="offline-content-remove-all"
                  style={styles.removeAll}
                  disabled={busy !== null}
                  onPress={confirmRemoveAll}
                  accessibilityRole="button"
                >
                  {busy === "*" ? <ActivityIndicator color={theme.colors.danger} /> : <Trash2 size={16} color={theme.colors.danger} />}
                  <Text style={styles.removeAllText}>{t("offlineContent.removeAll")}</Text>
                </Pressable>
              ) : null}
            </View>
            {failed ? (
              <Text testID="offline-content-error" style={styles.error} accessibilityLiveRegion="polite">
                {t("offlineContent.removeFailed")}
              </Text>
            ) : null}
            {empty ? (
              <Text testID="offline-content-empty" style={styles.empty}>
                {t(`offlineContent.${app}.empty`)}
              </Text>
            ) : null}
          </View>
        }
      />
    </View>
  );
};

const stylesFor = (theme: MobileShellTheme) =>
  StyleSheet.create({
    screen: { flex: 1 },
    header: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 8 },
    title: { flex: 1, color: theme.colors.text, fontSize: 22, fontWeight: "800" },
    icon: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: 24 },
    list: { paddingHorizontal: 16, paddingBottom: 32 },
    top: { gap: 8, marginBottom: 12 },
    summary: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
    summaryText: { color: theme.colors.textMuted, fontSize: 15, flexShrink: 1 },
    summaryValue: { color: theme.colors.text, fontSize: 20, fontWeight: "800" },
    removeAll: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 44,
      marginLeft: "auto",
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: theme.colors.danger,
    },
    removeAllText: { color: theme.colors.danger, fontSize: 15, fontWeight: "700", flexShrink: 1 },
    error: { color: theme.colors.danger, fontSize: 14 },
    empty: { color: theme.colors.textMuted, fontSize: 15, lineHeight: 22, paddingVertical: 8 },
    row: { flexDirection: "row", alignItems: "center", paddingLeft: 10, paddingRight: 2, paddingVertical: 6 },
    groupTop: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
    groupBottom: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14, marginBottom: 8 },
    hairTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border },
    rowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
    chevronSlot: { width: 20, alignItems: "center" },
    artwork: { borderRadius: 6, overflow: "hidden", backgroundColor: theme.colors.surfaceRaised },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { color: theme.colors.text, fontSize: 16 },
    rowTitleStrong: { fontWeight: "700" },
    rowDetail: { color: theme.colors.textMuted, fontSize: 13 },
  });
