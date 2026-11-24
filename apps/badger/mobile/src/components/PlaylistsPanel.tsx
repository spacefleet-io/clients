import React, { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ChevronRight, Heart, ListPlus, Plus, Bookmark } from "lucide-react-native";
import { MobileEmptyState, SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import type { PlaylistRow } from "@space/shared/libraryTypes";
import { useLibraryActions, useLibraryData, useLibraryStatus } from "../store/library";
import { RootStackParamList } from "../navigation/AppNavigator";
import { MobileIconButton } from "@space/mobile-shell/components";
import { RIPPLE } from "./PosterCard";
import { usePullRefreshScroll, usePullToRefresh } from "../lib/usePullToRefresh";
import { theme } from "../theme/theme";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const EMPTY_STATE_IMAGE = require("../assets/empty-state.webp");
const ROW_HEIGHT = 64;
const ROW_GAP = 8;
const keyExtractor = (item: PlaylistRow) => item.id;
const getItemLayout = (_: ArrayLike<PlaylistRow> | null | undefined, index: number) => ({
  length: ROW_HEIGHT + ROW_GAP,
  offset: (ROW_HEIGHT + ROW_GAP) * index,
  index,
});

const PlaylistRowItem = memo(({ item, onOpen }: { item: PlaylistRow; onOpen: (playlist: PlaylistRow, title: string) => void }) => {
  const { t } = useTranslation();
  const Icon = item.slug === "favorites" ? Heart : item.slug === "watchlist" ? Bookmark : ListPlus;
  const title =
    item.slug === "favorites"
      ? t("playlists.system.favorites")
      : item.slug === "watchlist"
        ? t("playlists.system.watchlist")
        : item.name;
  const handlePress = useCallback(() => onOpen(item, title), [item, onOpen, title]);
  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      android_ripple={RIPPLE}
      accessibilityRole="button"
      accessibilityLabel={t("playlists.rowLabel", { name: title })}
      testID={`playlist-row-${item.slug ?? item.id}`}
    >
      <View style={styles.rowIcon}>
        <Icon size={18} color={theme.colors.accent} />
      </View>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {title}
      </Text>
      <ChevronRight size={18} color={theme.colors.textDim} />
    </Pressable>
  );
});
PlaylistRowItem.displayName = "PlaylistRowItem";

/**
 * The Playlists tab (UX-PHONE-07): no page title (the tab bar names the page); system lists first, then custom lists,
 * with an inline "create". A row opens the playlist page (`PlaylistDetail`).
 */
export const PlaylistsPanel = memo(() => {
  const { t } = useTranslation();
  const { playlists } = useLibraryData();
  const { refresh } = useLibraryStatus();
  const { createPlaylist } = useLibraryActions();
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const pull = usePullToRefresh(refresh);
  const skyScroll = usePullRefreshScroll(pull, useSkyScroll());

  const sorted = useMemo(
    () => [...playlists].sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name)),
    [playlists],
  );

  const openPlaylist = useCallback(
    (playlist: PlaylistRow, title: string) => navigation.navigate("PlaylistDetail", { playlistId: playlist.id, title }),
    [navigation],
  );
  const renderItem = useCallback(
    ({ item }: { item: PlaylistRow }) => (
      <SkyCover>
        {/* UX-CRASH-01: a row that throws shows a placeholder in its place; the rest of the list stays. */}
        <MobileRenderBoundary name={`playlist-row:${item.id}`} variant="item">
          {() => <PlaylistRowItem item={item} onOpen={openPlaylist} />}
        </MobileRenderBoundary>
      </SkyCover>
    ),
    [openPlaylist],
  );

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await createPlaylist(trimmed);
      setName("");
    } finally {
      setBusy(false);
    }
  }, [busy, createPlaylist, name]);

  return (
    <View style={styles.page}>
      <View style={styles.compose}>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder={t("playlists.newPlaceholder")}
          placeholderTextColor={theme.colors.textDim}
          returnKeyType="done"
          onSubmitEditing={() => void handleCreate()}
          accessibilityLabel={t("playlists.newPlaceholder")}
        />
        <MobileIconButton label={t("playlists.create")} onPress={() => void handleCreate()} disabled={busy || !name.trim()} style={styles.create}>
          <Plus size={20} color={theme.colors.bg} />
        </MobileIconButton>
      </View>
      <FlatList
        data={sorted}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          <MobileEmptyState
            title={t("playlists.empty.title")}
            subtitle={t("playlists.empty.subtitle")}
            imageSource={EMPTY_STATE_IMAGE}
          />
        }
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
            progressBackgroundColor={theme.colors.surface}
          />
        }
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={10}
        windowSize={7}
        {...skyScroll}
      />
    </View>
  );
});
PlaylistsPanel.displayName = "PlaylistsPanel";

const Separator = () => <View style={{ height: ROW_GAP }} />;

const styles = StyleSheet.create({
  // The Library page's room under the status bar and above the tab bar, so both tabs start at the same height.
  page: { flex: 1, paddingTop: 8, gap: 12, marginBottom: 8 },
  compose: { flexDirection: "row", gap: 10, alignItems: "center" },
  input: {
    flex: 1,
    height: 48,
    borderRadius: 14,
    paddingHorizontal: 14,
    fontSize: 14,
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.controlBorder,
  },
  create: { backgroundColor: theme.colors.accent, borderRadius: 14 },
  list: { paddingBottom: 24, flexGrow: 1 },
  row: {
    height: ROW_HEIGHT,
    borderRadius: 16,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accentSoft,
  },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: "700", color: theme.colors.text },
});
