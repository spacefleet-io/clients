// The Library tab (PAR-LOOK-01, PAR-NAV-02, PAR-NAV-04): no page title, the tab bar names the page. Albums / Artists /
// Songs chips with the search button at their right, over a line saying how the list is sorted and how many it holds,
// then the chosen view. Albums: the grid of album art. Artists: each artist, a tap shows their albums. Songs: every
// song by title, a tap plays it and the songs after it. Search filters the view by name. Playlists live in their own
// tab. While the phone is offline, what is not kept on it is greyed out and does not play (PAR-OFFL-04).
import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowUpDown, Search, X } from "lucide-react-native";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileMascotLoader } from "@space/mobile-shell/mascot-loader";
import { guardRenderItem } from "@space/mobile-shell/render-boundary";
import { filterParrotAlbums, filterParrotArtists, filterParrotTracks, parrotArtistPictureThumbKey, parrotCoverThumbKey } from "@space/parrot-core";
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
import { Body, Button, Centered, Chips, ErrorText, IconButton } from "./ui";
import type { RootStack } from "./routes";

export type LibraryView = "albums" | "artists" | "songs";

/** How each view is sorted (the library queries' order), for the line under the chips. */
export const LIBRARY_SORT: Record<LibraryView, string> = {
  albums: "parrot.library.sort.byArtist",
  artists: "parrot.library.sort.byName",
  songs: "parrot.library.sort.byTitle",
};


type LibraryScreenProps = {
  /** False while another tab shows: the page stays mounted in the tab pager, so it goes back to Albums, search closed. */
  active: boolean;
  /** Home's "See all" asks for a list (PAR-HOME-01); each new request object opens that list. */
  viewRequest: { view: LibraryView } | null;
};

export const LibraryScreen = ({ active, viewRequest }: LibraryScreenProps) => {
  const { library, reloadLibrary } = useSession();
  const { t } = useTranslation();
  const [view, setView] = useState<LibraryView>(viewRequest?.view ?? "albums");
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  // The Library tab itself always opens on Albums; only Home's "See all" picks another list.
  useEffect(() => {
    if (active) return;
    setView("albums");
    setSearching(false);
    setSearch("");
  }, [active]);
  useEffect(() => {
    if (viewRequest) setView(viewRequest.view);
  }, [viewRequest]);
  // An empty library shows the empty-library screen instead of the chips over an empty list (PAR-EMPTY-01).
  const version = library.status === "ready" ? library.version : -1;
  const albums = useQuery(() => (version < 0 ? Promise.resolve(null) : listAlbums()), [version]);
  // No page title (PAR-NAV-04): the search button sits at the right of the chips, the search box opens under them.
  const searchButton = (
    <IconButton
      testID="library-search"
      icon={searching ? X : Search}
      label={searching ? t("parrot.library.closeSearch") : t("parrot.library.search")}
      onPress={() => {
        setSearching(!searching);
        setSearch("");
      }}
    />
  );
  const searchBox = searching ? (
    <View style={styles.searchBox}>
      <Search size={18} color={colors.textMuted} />
      <TextInput
        testID="library-search-input"
        autoFocus
        value={search}
        onChangeText={setSearch}
        placeholder={t("parrot.library.search")}
        placeholderTextColor={colors.textMuted}
        style={styles.searchInput}
        returnKeyType="search"
      />
    </View>
  ) : null;

  if (library.status === "loading" || library.status === "idle") {
    return (
      <Centered>
        <MobileMascotLoader app="parrot" source={PARROT_MASCOT} size={120} />
        <Body muted>{t("parrot.library.opening")}</Body>
      </Centered>
    );
  }
  if (library.status === "missing" || albums.data?.length === 0) return <EmptyLibrary />;
  if (library.status === "error") {
    return (
      <Centered>
        <ErrorText>{t("parrot.library.openFailed", { error: library.error })}</ErrorText>
        <Button label={t("parrot.library.tryAgain")} onPress={() => void reloadLibrary()} />
      </Centered>
    );
  }

  const chips = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
      <Chips
        options={[
          { id: "albums", label: t("parrot.library.view.albums") },
          { id: "artists", label: t("parrot.library.view.artists") },
          { id: "songs", label: t("parrot.library.view.songs") },
        ]}
        value={view}
        onChange={setView}
      />
    </ScrollView>
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.head}>
        {chips}
        {searchButton}
      </View>
      {searchBox}
      {view === "albums" ? <AlbumsView search={search} /> : view === "artists" ? <ArtistsView search={search} /> : <SongsView search={search} />}
    </View>
  );
};

/** "⇅ By artist ……… 248 albums". */
export const CountLine = ({ view, count }: { view: LibraryView; count: number | null }) => {
  const { t } = useTranslation();
  return (
    <View style={styles.countLine} testID="library-count">
      <View style={styles.sort}>
        <ArrowUpDown size={14} color={colors.text} />
        <Text style={styles.sortText}>{t(LIBRARY_SORT[view])}</Text>
      </View>
      {count === null ? null : <Text style={styles.count}>{t(`parrot.library.${view}`, { count })}</Text>}
    </View>
  );
};

const useLibraryVersion = () => {
  const { library } = useSession();
  return library.status === "ready" ? library.version : -1;
};

const AlbumsView = ({ search }: { search: string }) => {
  const { reloadLibrary } = useSession();
  const { t } = useTranslation();
  const version = useLibraryVersion();
  const albums = useQuery(() => listAlbums(), [version]);
  const reach = useOfflineReach();
  const shown = filterParrotAlbums(albums.data ?? [], search);
  return (
    <AlbumGrid
      albums={shown}
      loading={albums.loading}
      empty={t("parrot.library.noAlbums")}
      unavailable={reach ? (album) => !reach.album(album.id) : undefined}
      header={<CountLine view="albums" count={albums.data ? shown.length : null} />}
      onRefresh={() => void reloadLibrary()}
    />
  );
};

const ArtistsView = ({ search }: { search: string }) => {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const version = useLibraryVersion();
  const artists = useQuery(() => listArtists(), [version]);
  const reach = useOfflineReach();
  const shown = filterParrotArtists(artists.data ?? [], search);
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

const SongsView = ({ search }: { search: string }) => {
  const { t } = useTranslation();
  const version = useLibraryVersion();
  const songs = useQuery(() => listSongs(), [version]);
  const { play, starting, error } = usePlay();
  const now = useNowPlaying();
  const skyScroll = useSkyScroll();
  const editor = usePlaylistEditor();
  const reach = useOfflineReach();
  const shown = filterParrotTracks(songs.data ?? [], search);
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
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingTop: spacing.md, paddingRight: spacing.lg, paddingBottom: spacing.sm },
  chipScroll: { flex: 1 },
  chipRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg },
  list: { padding: spacing.lg, gap: spacing.xs },
  countLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: spacing.sm },
  count: { color: colors.textMuted, fontSize: 13 },
  sort: { flexDirection: "row", alignItems: "center", gap: 6 },
  sortText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 16, minHeight: 44 },
  artist: { paddingVertical: spacing.sm, minHeight: 64 },
  artistContent: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md },
  name: { color: colors.text, fontSize: 16, fontWeight: "600" },
});
