import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, TVFocusGuideView, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SkyCover } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { MediaRow, PlaylistRow } from "@space/shared/libraryTypes";
import type { RootStackParamList } from "../../navigation/AppNavigator";
import { useLibraryActions, useLibraryData } from "../../store/library";
import { TvPosterGrid } from "../components/TvPosterGrid";
import { TV_SCREEN_X } from "@space/mobile-shell/tv/layout";
import { useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { TvChip } from "@space/mobile-shell/tv/TvChip";
import { TvBody } from "@space/mobile-shell/tv/TvText";

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The chips in the phone's order: Favorites and Watchlist first, then the others by name (UX-TV-37). */
export const tvPlaylistOrder = (playlists: readonly PlaylistRow[]): PlaylistRow[] =>
  [...playlists].sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));

/** A playlist's chip label: the system playlists in the screen's language, the others by their name. */
export const tvPlaylistName = (playlist: Pick<PlaylistRow, "slug" | "name">, t: Translate): string =>
  playlist.slug === "favorites"
    ? t("playlists.system.favorites")
    : playlist.slug === "watchlist"
      ? t("playlists.system.watchlist")
      : playlist.name;

/** A playlist's titles in the playlist's order; ids of titles no longer in the library are skipped. */
export const tvPlaylistTitles = (media: readonly MediaRow[], ids: readonly string[]): MediaRow[] => {
  const byId = new Map(media.map((item) => [item.id, item]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
};

/**
 * TV Playlists, a top-bar section of its own beside Home and Library (UX-TV-09, UX-TV-37): no title; one chip per
 * playlist at the top, the first one chosen, and the chosen playlist's titles in the grid under them. Moving along the
 * chips chooses the focused one, so the grid follows the remote. The TV only reads playlists.
 */
export const TvPlaylistsScreen = memo(() => {
  const { t } = useTranslation();
  const { media, playlists } = useLibraryData();
  const { listPlaylistItems } = useLibraryActions();
  const navigation = useNavigation<Nav>();
  const styles = useTvStyles(baseStyles);
  const ordered = useMemo(() => tvPlaylistOrder(playlists), [playlists]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen = ordered.find((playlist) => playlist.id === chosenId) ?? ordered[0] ?? null;
  const [itemIds, setItemIds] = useState<{ playlistId: string; ids: readonly string[] } | null>(null);

  const openMedia = useCallback((mediaId: string) => navigation.navigate("MediaDetails", { mediaId }), [navigation]);

  useEffect(() => {
    if (!chosen) return undefined;
    let cancelled = false;
    void listPlaylistItems(chosen.id)
      .then((ids) => {
        if (!cancelled) setItemIds({ playlistId: chosen.id, ids });
      })
      .catch((err: unknown) => console.warn("tv.playlists.items.failed", JSON.stringify({ playlistId: chosen.id, error: String(err) })));
    return () => {
      cancelled = true;
    };
    // `media` too: a title added to or removed from the library changes what the playlist shows.
  }, [chosen, listPlaylistItems, media]);

  const choose = useCallback(
    (playlistId: string) => {
      if (playlistId === chosen?.id) return;
      console.info("tv.playlists.choose", JSON.stringify({ from: chosen?.id ?? null, to: playlistId }));
      setChosenId(playlistId);
    },
    [chosen],
  );

  const items = useMemo(
    () => (chosen && itemIds?.playlistId === chosen.id ? tvPlaylistTitles(media, itemIds.ids) : null),
    [chosen, itemIds, media],
  );

  if (!chosen) {
    return (
      <View style={styles.screen}>
        <TvBody muted style={styles.emptyTitle} testID="tv-playlists-empty">
          {t("playlists.empty.title")}
        </TvBody>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Full width: DOWN from the top bar and UP from the grid land on the last chip focused, the chosen one. */}
      <TVFocusGuideView autoFocus style={styles.chipsGuide}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} testID="tv-playlists-chips">
          {ordered.map((playlist) => (
            <SkyCover key={playlist.id}>
              <TvChip
                label={tvPlaylistName(playlist, t)}
                selected={playlist.id === chosen.id}
                onFocus={() => choose(playlist.id)}
                onPress={() => choose(playlist.id)}
                testID={`tv-playlist-${playlist.id}`}
              />
            </SkyCover>
          ))}
        </ScrollView>
      </TVFocusGuideView>
      <View style={styles.panel} testID="tv-playlists-panel">
        {items === null ? null : items.length === 0 ? (
          <View testID="tv-playlists-empty">
            <TvBody style={styles.emptyTitle}>{t("playlists.detail.emptyTitle")}</TvBody>
            <TvBody muted style={styles.emptyHint}>
              {t("playlists.detail.emptySubtitle")}
            </TvBody>
          </View>
        ) : (
          // Another playlist is a new list: it starts at its top.
          <TvPosterGrid key={chosen.id} items={items} onOpenMedia={openMedia} />
        )}
      </View>
    </View>
  );
});
TvPlaylistsScreen.displayName = "TvPlaylistsScreen";

/** Sizes in design dp (the Library's bar band and grid, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  screen: { flex: 1 },
  // The chips sit where the Library's switch sits: the same room under the top bar.
  chipsGuide: { paddingTop: 12 },
  chips: { flexDirection: "row", gap: 8, paddingHorizontal: TV_SCREEN_X, paddingVertical: 6 },
  panel: { flex: 1 },
  emptyTitle: { paddingHorizontal: TV_SCREEN_X, paddingTop: 23 },
  emptyHint: { paddingHorizontal: TV_SCREEN_X, paddingTop: 6 },
});
