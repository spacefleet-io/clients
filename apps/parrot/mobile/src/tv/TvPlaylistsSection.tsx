// TV Playlists (PAR-TV-13): Liked songs first, then the user's playlists, as square cards in Home's card style; OK opens
// the playlist's page, laid out like the album page (PAR-TV-04). Making and editing playlists stays on the phone and
// desktop, where there is a keyboard.
import React from "react";
import { FlatList, StyleSheet, View, useWindowDimensions } from "react-native";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { TvBody, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_SPACE } from "@space/mobile-shell/tv/tokens";
import { TV_LIBRARY_GAP_Y, tvHomeCardWidth } from "@space/mobile-shell/tv/layout";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import type { ParrotPlaylist } from "@space/parrot-core";
import { listPlaylists } from "../lib/library";
import { usePlaylistName } from "../screens/PlaylistsView";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { TV_CARD_GROW_ROOM } from "@space/mobile-shell/tv/TvCardRow";
import { TvPlaylistCard } from "./TvMusicParts";
import { tvGridColumnsFor } from "./tvModel";
import { useTvPages } from "./tvPages";

export const TvPlaylistsSection = () => {
  const { t } = useTranslation();
  const { library, localChanges } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const playlists = useQuery(() => (library.status === "ready" ? listPlaylists() : Promise.resolve([])), [version, localChanges]);
  const nameOf = usePlaylistName();
  const { push } = useTvPages();
  const { width } = useWindowDimensions();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const skyScroll = useSkyScroll();
  const cardWidth = tvHomeCardWidth(scale);
  const gap = TV_SPACE.posterGap * scale;
  const columns = tvGridColumnsFor(width, cardWidth, gap, TV_SPACE.screenX * scale);
  const rows = playlists.data ?? [];

  return (
    <FlatList
      testID="tv-playlists"
      data={rows}
      key={columns}
      numColumns={columns}
      keyExtractor={(playlist: ParrotPlaylist) => playlist.id}
      contentContainerStyle={styles.content}
      columnWrapperStyle={columns > 1 ? { gap, paddingHorizontal: TV_SPACE.screenX * scale } : undefined}
      showsVerticalScrollIndicator={false}
      removeClippedSubviews={false}
      {...skyScroll}
      ListHeaderComponent={
        <View style={styles.head}>
          <TvTitle size="page">{t("shell.playlists.title")}</TvTitle>
          {playlists.answered && rows.length <= 1 ? <TvBody muted>{t("shell.playlists.empty")}</TvBody> : null}
        </View>
      }
      renderItem={({ item }) => (
        <SkyCover style={styles.cell}>
          <MobileRenderBoundary name={`tv-playlist:${item.id}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
            {() => (
              <TvPlaylistCard
                playlistId={item.id}
                width={cardWidth}
                title={nameOf(item)}
                subtitle={t("parrot.library.songs", { count: item.trackCount })}
                onPress={() => push({ kind: "playlist", playlistId: item.id, name: nameOf(item) })}
              />
            )}
          </MobileRenderBoundary>
        </SkyCover>
      )}
    />
  );
};

/** Sizes in design dp (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  content: { paddingTop: 14, paddingBottom: 30 },
  head: { gap: 6, paddingHorizontal: TV_SPACE.screenX, marginBottom: TV_SPACE.headingGap - TV_CARD_GROW_ROOM / 2 },
  cell: { paddingTop: TV_CARD_GROW_ROOM / 2, marginBottom: TV_LIBRARY_GAP_Y },
});
