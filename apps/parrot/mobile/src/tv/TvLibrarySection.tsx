// TV Library (PAR-TV-13): "Artists" as a row of round artist photos, then "Albums" as a grid of Home's square album
// cards. OK on an album opens its page, OK on an artist the artist's page. The Library tab lists the albums by artist;
// Home's "Recently added" "See all" opens it newest added first (PAR-HOME-01), with focus on the newest album.
import React from "react";
import { FlatList, StyleSheet, View, useWindowDimensions } from "react-native";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { TvBody, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_SPACE } from "@space/mobile-shell/tv/tokens";
import { TV_LIBRARY_GAP_Y, tvHomeCardWidth } from "@space/mobile-shell/tv/layout";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { libraryContent } from "@space/shared/libraryContent";
import { sortParrotAlbums, type ParrotAlbumSort } from "@space/parrot-core";
import { listAlbums, listArtists, type AlbumWithCover } from "../lib/library";
import { useSession } from "../state/session";
import { useNowPlaying } from "../state/usePlayerState";
import { useQuery } from "../state/useQuery";
import { TvLibraryState } from "./TvHomeSection";
import { TV_CARD_GROW_ROOM, TvAlbumCard, TvArtistCard, TvCardRow } from "./TvMusicParts";
import { tvGridColumnsFor } from "./tvModel";
import { useTvPages } from "./tvPages";

const ARTIST_WIDTH = 75;
const ARTIST_GAP = 26;

export const TvLibrarySection = ({ albumSort }: { albumSort: ParrotAlbumSort | null }) => {
  const { t } = useTranslation();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const data = useQuery(async () => {
    const [albums, artists] = await Promise.all([listAlbums(), listArtists()]);
    return { albums, artists };
  }, [version]);
  const { push } = useTvPages();
  const now = useNowPlaying();
  const { width } = useWindowDimensions();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const skyScroll = useSkyScroll();

  if (library.status === "missing") return <TvLibraryState kind="missing" />;
  if (library.status === "error") return <TvLibraryState kind="error" error={library.error} />;
  const { albums: listed, artists } = (library.status === "ready" ? data.data : null) ?? { albums: [], artists: [] };
  const albums = albumSort ? sortParrotAlbums(listed, albumSort) : listed;
  const content = libraryContent({ itemCount: albums.length, settled: library.status === "ready" && data.answered });
  if (content === "loading") return <TvLibraryState kind="loading" />;
  if (content === "empty") return <TvLibraryState kind="empty" />;

  const cardWidth = tvHomeCardWidth(scale);
  const gap = TV_SPACE.posterGap * scale;
  const columns = tvGridColumnsFor(width, cardWidth, gap, TV_SPACE.screenX * scale);
  const openAlbum = (albumId: string) => push({ kind: "album", albumId });

  return (
    <FlatList
      testID="tv-library"
      data={albums}
      key={columns}
      numColumns={columns}
      keyExtractor={(album: AlbumWithCover) => album.id}
      contentContainerStyle={styles.content}
      columnWrapperStyle={columns > 1 ? { gap, paddingHorizontal: TV_SPACE.screenX * scale } : undefined}
      showsVerticalScrollIndicator={false}
      removeClippedSubviews={false}
      {...skyScroll}
      ListHeaderComponent={
        <View>
          {artists.length > 0 ? (
            <TvCardRow
              testID="tv-library-artists"
              title={t("parrot.library.view.artists")}
              items={artists}
              keyOf={(artist) => artist.id}
              cardWidth={ARTIST_WIDTH * scale}
              gap={ARTIST_GAP}
              renderCard={(artist, _index, onFocus) => (
                <TvArtistCard
                  artist={artist}
                  width={ARTIST_WIDTH * scale}
                  subtitle={t("parrot.library.albums", { count: artist.albumCount })}
                  onOpen={(row) => push({ kind: "artist", artistId: row.id, name: row.name })}
                  onFocus={onFocus}
                />
              )}
            />
          ) : null}
          <View style={styles.albumsHeading}>
            <TvTitle size="section" testID="tv-library-albums">
              {t("parrot.library.view.albums")}
            </TvTitle>
            {albumSort === "recent" ? (
              <TvBody muted testID="tv-library-albums-sort">
                {t("shell.library.sortRecent")}
              </TvBody>
            ) : null}
          </View>
        </View>
      }
      renderItem={({ item, index }) => (
        <SkyCover style={styles.cell}>
          {/* UX-CRASH-01: a card that throws shows a placeholder in its place; the rest of the grid stays. */}
          <MobileRenderBoundary name={`tv-library-album:${item.id}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
            {() => (
              <TvAlbumCard
                album={item}
                width={cardWidth}
                playing={now?.albumId === item.id ? { animated: now.playing } : null}
                onOpen={openAlbum}
                hasTVPreferredFocus={(artists.length === 0 || albumSort !== null) && index === 0}
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
  content: { paddingTop: 10, paddingBottom: 30 },
  albumsHeading: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    paddingHorizontal: TV_SPACE.screenX,
    marginTop: 4,
    marginBottom: TV_SPACE.headingGap - TV_CARD_GROW_ROOM / 2,
  },
  cell: { marginLeft: 0, paddingTop: TV_CARD_GROW_ROOM / 2, marginBottom: TV_LIBRARY_GAP_Y },
});
