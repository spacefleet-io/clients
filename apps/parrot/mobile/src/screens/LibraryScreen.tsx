// The Library tab (PAR-LOOK-01, PAR-NAV-02, PAR-NAV-04): no page title, the tab bar names the page. Albums / Artists /
// Songs chips over a line saying how the list is sorted and how many it holds, then the chosen view. Albums: the grid
// of album art, by artist, or newest added first when Home's "Recently added" "See all" opened it (PAR-HOME-01).
// Artists: each artist, a tap shows their albums. Songs: every song by title, a tap plays it and the
// songs after it. No search here: the bar's centre Search button searches the whole library (UX-PHONE-12). Playlists
// live in their own tab. While the phone is offline, what is not kept on it is greyed out and does not play (PAR-OFFL-04).
import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowUpDown } from "lucide-react-native";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { MobileLibraryLoading, MobileRailScroll, SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "@space/mobile-shell/i18n";
import { libraryContent } from "@space/shared/libraryContent";
import { guardRenderItem } from "@space/mobile-shell/render-boundary";
import { parrotArtistPictureThumbKey, parrotCoverThumbKey, sortParrotAlbums, type ParrotAlbumSort } from "@space/parrot-core";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { usePlay } from "../state/usePlay";
import { useNowPlaying } from "../state/usePlayerState";
import { usePlaylistEditor } from "../state/playlistEditor";
import { listAlbums, listArtists, listSongs } from "../lib/library";
import { PARROT_MASCOT } from "../brand";
import { colors, spacing } from "../theme";
import { ParrotArt } from "./art";
import { AlbumGrid } from "./AlbumGrid";
import { SongListRow, songRowNames } from "./SongListRow";
import { useOfflineReach } from "./kept";
import { EmptyLibrary } from "./EmptyLibrary";
import { Body, Button, Centered, Chips, ErrorText } from "./ui";
import type { RootStack } from "./routes";

export type LibraryView = "albums" | "artists" | "songs";

/** How each view is sorted (the library queries' order), for the line under the chips. */
export const LIBRARY_SORT: Record<LibraryView, string> = {
  albums: "parrot.library.sort.byArtist",
  artists: "parrot.library.sort.byName",
  songs: "parrot.library.sort.byTitle",
};

/** The line's words for an album order Home's "See all" asked for (PAR-HOME-01). */
export const albumSortLabel = (sort: ParrotAlbumSort): string =>
  sort === "recent" ? "shell.library.sortRecent" : sort === "title" ? "parrot.library.sort.byTitle" : "parrot.library.sort.byArtist";

/** Home's "See all" asks for a list, and for albums maybe an order ("Recently added": "recent"). */
export type LibraryRequest = { view: LibraryView; albumSort?: ParrotAlbumSort };

type LibraryScreenProps = {
  /** False while another tab shows: the page stays mounted in the tab pager, so it goes back to Albums. */
  active: boolean;
  /** Home's "See all" asks for a list (PAR-HOME-01); each new request object opens that list. */
  viewRequest: LibraryRequest | null;
};

export const LibraryScreen = ({ active, viewRequest }: LibraryScreenProps) => {
  const { library, reloadLibrary } = useSession();
  const { t } = useTranslation();
  const [view, setView] = useState<LibraryView>(viewRequest?.view ?? "albums");
  // null: the albums in the query's own order (by artist).
  const [albumSort, setAlbumSort] = useState<ParrotAlbumSort | null>(viewRequest?.albumSort ?? null);
  // The Library tab itself always opens on Albums by artist; only Home's "See all" picks another list or order.
  useEffect(() => {
    if (active) return;
    setView("albums");
    setAlbumSort(null);
  }, [active]);
  useEffect(() => {
    if (!viewRequest) return;
    setView(viewRequest.view);
    setAlbumSort(viewRequest.albumSort ?? null);
  }, [viewRequest]);
  // An empty library shows the empty-library screen instead of the chips over an empty list (PAR-EMPTY-01).
  const version = library.status === "ready" ? library.version : -1;
  const albums = useQuery(() => (version < 0 ? Promise.resolve(null) : listAlbums()), [version]);

  if (library.status === "error") {
    return (
      <Centered>
        <ErrorText>{t("parrot.library.openFailed", { error: library.error })}</ErrorText>
        <Button label={t("parrot.library.tryAgain")} onPress={() => void reloadLibrary()} />
      </Centered>
    );
  }
  if (library.status === "missing") return <EmptyLibrary />;
  // The empty library only once the albums of the library open now are read (UX-WAIT-04).
  const content = libraryContent({
    itemCount: library.status === "ready" ? (albums.data?.length ?? 0) : 0,
    settled: library.status === "ready" && albums.answered,
  });
  if (content === "loading") return <MobileLibraryLoading app="parrot" source={PARROT_MASCOT} label={t("parrot.library.loading")} />;
  if (content === "empty") return <EmptyLibrary />;

  const chips = (
    <MobileRailScroll style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
      <Chips
        options={[
          { id: "albums", label: t("parrot.library.view.albums") },
          { id: "artists", label: t("parrot.library.view.artists") },
          { id: "songs", label: t("parrot.library.view.songs") },
        ]}
        value={view}
        onChange={setView}
      />
    </MobileRailScroll>
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.head}>
        {chips}
      </View>
      {view === "albums" ? <AlbumsView sort={albumSort} /> : view === "artists" ? <ArtistsView /> : <SongsView />}
    </View>
  );
};

/** "⇅ By artist ……… 248 albums"; `sort` names another order's words. */
export const CountLine = ({ view, count, sort }: { view: LibraryView; count: number | null; sort?: string }) => {
  const { t } = useTranslation();
  return (
    <View style={styles.countLine} testID="library-count">
      <View style={styles.sort}>
        <ArrowUpDown size={14} color={colors.text} />
        <Text style={styles.sortText}>{t(sort ?? LIBRARY_SORT[view])}</Text>
      </View>
      {count === null ? null : <Text style={styles.count}>{t(`parrot.library.${view}`, { count })}</Text>}
    </View>
  );
};

const useLibraryVersion = () => {
  const { library } = useSession();
  return library.status === "ready" ? library.version : -1;
};

const AlbumsView = ({ sort }: { sort: ParrotAlbumSort | null }) => {
  const { reloadLibrary } = useSession();
  const { t } = useTranslation();
  const version = useLibraryVersion();
  const albums = useQuery(() => listAlbums(), [version]);
  const reach = useOfflineReach();
  const shown = albums.data ? (sort ? sortParrotAlbums(albums.data, sort) : albums.data) : [];
  return (
    <AlbumGrid
      albums={shown}
      loading={albums.loading}
      empty={t("parrot.library.noAlbums")}
      unavailable={reach ? (album) => !reach.album(album.id) : undefined}
      header={<CountLine view="albums" count={albums.data ? shown.length : null} sort={sort ? albumSortLabel(sort) : undefined} />}
      onRefresh={() => void reloadLibrary()}
    />
  );
};

const ArtistsView = () => {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const version = useLibraryVersion();
  const artists = useQuery(() => listArtists(), [version]);
  const reach = useOfflineReach();
  const shown = artists.data ?? [];
  const skyScroll = useSkyScroll();
  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={shown}
      keyExtractor={(artist) => artist.id}
      {...skyScroll}
      ListHeaderComponent={<CountLine view="artists" count={artists.data ? shown.length : null} />}
      ListEmptyComponent={artists.loading ? <ActivityIndicator color={colors.accent} /> : <Body muted>{t("parrot.library.noArtists")}</Body>}
      renderItem={guardRenderItem("artist-row", ({ item }) => {
        const meta = `${t("parrot.library.albums", { count: item.albumCount })} · ${t("parrot.library.songs", { count: item.trackCount })}`;
        const unavailable = reach ? !reach.artist(item.id) : false;
        return (
          <Pressable
            testID="artist-row"
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${meta}`}
            accessibilityState={{ disabled: unavailable }}
            disabled={unavailable}
            onPress={() => navigation.navigate("Artist", { artistId: item.id, name: item.name })}
            style={({ pressed }) => [styles.artist, pressed && { opacity: 0.7 }]}
          >
            <View testID="artist-row-content" style={[styles.artistContent, unavailable && UNAVAILABLE_LOOK]}>
              <SkyCover>
                <ParrotArt seed={item.id} size={52} radius={26} coverKey={parrotArtistPictureThumbKey(item)} />
              </SkyCover>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.count} numberOfLines={1}>
                  {meta}
                </Text>
              </View>
            </View>
          </Pressable>
        );
      })}
    />
  );
};

const SongsView = () => {
  const { t } = useTranslation();
  const version = useLibraryVersion();
  const songs = useQuery(() => listSongs(), [version]);
  const { play, starting, error } = usePlay();
  const now = useNowPlaying();
  const skyScroll = useSkyScroll();
  const editor = usePlaylistEditor();
  const reach = useOfflineReach();
  const shown = songs.data ?? [];
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={shown}
      keyExtractor={(song) => song.id}
      {...skyScroll}
      ListHeaderComponent={
        <View>
          <CountLine view="songs" count={songs.data ? shown.length : null} />
          {error ? <ErrorText>{error}</ErrorText> : null}
          {songs.error ? <ErrorText>{songs.error}</ErrorText> : null}
        </View>
      }
      ListEmptyComponent={songs.loading ? <ActivityIndicator color={colors.accent} /> : <Body muted>{t("parrot.library.noSongs")}</Body>}
      renderItem={guardRenderItem("song-row", ({ item, index }) => (
        <SongListRow
          lead={<ParrotArt seed={item.albumId} coverKey={parrotCoverThumbKey(item)} size={40} radius={6} />}
          title={item.title}
          names={songRowNames(item, navigation)}
          durationMs={item.durationMs}
          playing={now?.trackId === item.id ? { animated: now.playing } : null}
          starting={starting === item.id}
          disabled={starting !== null}
          unavailable={reach ? !reach.song(item.id) : false}
          accessibilityLabel={t("parrot.album.play", { title: item.title })}
          onPress={() => void play(shown, index)}
          onMore={() => editor.openSong({ id: item.id, title: item.title })}
          moreLabel={`${t("parrot.player.more")}, ${item.title}`}
        />
      ))}
    />
  );
};

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingTop: spacing.md, paddingBottom: spacing.sm },
  chipScroll: { flex: 1 },
  chipRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg },
  list: { padding: spacing.lg, gap: spacing.xs },
  countLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: spacing.sm },
  count: { color: colors.textMuted, fontSize: 13 },
  sort: { flexDirection: "row", alignItems: "center", gap: 6 },
  sortText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  artist: { paddingVertical: spacing.sm, minHeight: 64 },
  artistContent: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md },
  name: { color: colors.text, fontSize: 16, fontWeight: "600" },
});
