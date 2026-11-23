// The Library tab (PAR-LOOK-01, PAR-NAV-02, PAR-NAV-04, PAR-LIB-06): no page title, the tab bar names the page. The
// library row of the desktop and the web player brought to the phone: the Albums / Artists / Songs switch, the quiet
// counts and the Filter and Sort buttons (DRAFT layouts A / B / C, see @space/mobile-shell/library-row), then the chosen
// view. Albums: the grid of album art, newest added first. Artists: each artist, a tap shows their albums. Songs: every
// song by title, a tap plays it and the songs after it. No search here: the bar's centre Search button searches the whole
// library (UX-PHONE-12). Playlists live in their own tab. While the phone is offline, what is not kept on it is greyed
// out and does not play (PAR-OFFL-04).
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { MobileLibraryLoading, SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import {
  MobileLibraryFilterPicker,
  MobileLibraryHeader,
  MobileLibraryPills,
  MobileLibrarySegmented,
  MobileLibrarySheet,
  MobileLibrarySheetButtons,
  MobileLibrarySheetSection,
  type MobileLibraryCount,
} from "@space/mobile-shell/library-row";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "@space/mobile-shell/i18n";
import { libraryContent } from "@space/shared/libraryContent";
import { guardRenderItem } from "@space/mobile-shell/render-boundary";
import {
  countParrotLibraryFilters,
  defaultParrotLibraryPrefs,
  parrotArtistPictureThumbKey,
  parrotCoverThumbKey,
  parrotLibraryDecadeOptions,
  parrotLibraryGenreOptions,
  shownParrotAlbums,
  shownParrotArtists,
  shownParrotSongs,
  PARROT_LIBRARY_FILTERS,
  PARROT_LIBRARY_SORTS,
  type ArtistRow,
  type ParrotAlbumSort,
  type ParrotLibraryContext,
  type ParrotLibraryFilters,
  type ParrotLibraryPrefs,
  type ParrotLibrarySort,
  type ParrotLibraryTab,
  type SongRow,
} from "@space/parrot-core";
import { shellCountKey } from "@space/parrot-core/shell-strings";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { usePlay } from "../state/usePlay";
import { useNowPlaying } from "../state/usePlayerState";
import { usePlaylistEditor } from "../state/playlistEditor";
import { useListeningHistory } from "../state/history";
import { listAlbums, listArtists, listPlaylists, listSongs, type AlbumWithCover, type WithCoverKeys } from "../lib/library";
import { isLikedPlaylist } from "../lib/playlists";
import { PARROT_MASCOT } from "../brand";
import { colors, spacing } from "../theme";
import { ParrotArt } from "./art";
import { AlbumGrid } from "./AlbumGrid";
import { SongListRow, songRowNames } from "./SongListRow";
import { useOfflineReach } from "./kept";
import { EmptyLibrary } from "./EmptyLibrary";
import { Body, Button, Centered, ErrorText } from "./ui";
import type { RootStack } from "./routes";

export type LibraryView = ParrotLibraryTab;

/** Home's "See all" asks for a list, and for albums maybe an order ("Recently added": "recent"). */
export type LibraryRequest = { view: LibraryView; albumSort?: ParrotAlbumSort };

/** Each sort's words in the Sort sheet (the shell's, shared with the desktop and the web player). */
const SORT_LABEL: Record<ParrotLibraryTab, Record<string, string>> = {
  albums: { recent: "sortRecent", played: "sortPlayed", title: "sortTitle", artist: "sortArtist", year: "sortYear" },
  artists: { name: "sortName", plays: "sortPlays", albums: "sortAlbumCount", songs: "sortSongCount" },
  songs: { title: "sortTitle", artist: "sortArtist", album: "sortAlbum", year: "sortYear", duration: "sortDuration" },
};

/** The count words of each tab's items ("14 albums"). */
const COUNT_KIND = { albums: "album", artists: "artist", songs: "song" } as const;

type LibraryScreenProps = {
  /** False while another tab shows: the page stays mounted in the tab pager, so it goes back to Albums. */
  active: boolean;
  /** Home's "See all" asks for a list (PAR-HOME-01); each new request object opens that list. */
  viewRequest: LibraryRequest | null;
};

type Sheet = "filter" | "sort" | null;

export const LibraryScreen = ({ active, viewRequest }: LibraryScreenProps) => {
  const { library, reloadLibrary, localChanges } = useSession();
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<LibraryView>(viewRequest?.view ?? "albums");
  const [prefs, setPrefs] = useState<ParrotLibraryPrefs>(() => withAlbumSort(defaultParrotLibraryPrefs(), viewRequest?.albumSort));
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState<ParrotLibraryFilters>({});
  // The Library tab itself always opens on Albums; only Home's "See all" picks another list or order.
  useEffect(() => {
    if (active) return;
    setView("albums");
    setSheet(null);
  }, [active]);
  useEffect(() => {
    if (!viewRequest) return;
    setView(viewRequest.view);
    setPrefs((current) => withAlbumSort(current, viewRequest.albumSort));
  }, [viewRequest]);
  // An empty library shows the empty-library screen instead of the row over an empty list (PAR-EMPTY-01).
  const version = library.status === "ready" ? library.version : -1;
  const albums = useQuery(() => (version < 0 ? Promise.resolve(null) : listAlbums()), [version]);
  const artists = useQuery(() => (version < 0 ? Promise.resolve(null) : listArtists()), [version]);
  const songs = useQuery(() => (version < 0 ? Promise.resolve(null) : listSongs()), [version]);
  const playlists = useQuery(() => (version < 0 ? Promise.resolve([]) : listPlaylists()), [version, localChanges]);
  const history = useListeningHistory();
  const context = useMemo<ParrotLibraryContext>(
    () => ({
      albums: albums.data ?? [],
      songs: songs.data ?? [],
      history,
      likedSongIds: new Set(playlists.data?.find((playlist) => isLikedPlaylist(playlist.id))?.trackIds ?? []),
    }),
    [albums.data, songs.data, history, playlists.data]
  );
  const shownAlbums = useMemo(() => shownParrotAlbums(albums.data ?? [], prefs.albums, context), [albums.data, prefs.albums, context]);
  const shownArtists = useMemo(() => shownParrotArtists(artists.data ?? [], prefs.artists, context), [artists.data, prefs.artists, context]);
  const shownSongs = useMemo(() => shownParrotSongs(songs.data ?? [], prefs.songs, context), [songs.data, prefs.songs, context]);
  // The picks a list offers: only a list with two or more choices shows (UX-LIB-01).
  const genres = useMemo(() => parrotLibraryGenreOptions(view, context), [view, context]);
  const decades = useMemo(() => parrotLibraryDecadeOptions(view, context), [view, context]);

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

  const tabPrefs = prefs[view];
  const filterCount = countParrotLibraryFilters(tabPrefs.filters);
  const setTab = <T extends ParrotLibraryTab>(tab: T, next: Partial<ParrotLibraryPrefs[T]>) =>
    setPrefs((current) => ({ ...current, [tab]: { ...current[tab], ...next } }));
  const setFilters = (filters: ParrotLibraryFilters) => setTab(view, { filters });
  const countText = (kind: "album" | "song" | "artist", n: number) => t(`shell.${shellCountKey(i18n.language, kind, n)}`, { n });
  const totals = { albums: albums.data?.length ?? 0, artists: artists.data?.length ?? 0, songs: songs.data?.length ?? 0 };
  const shownCount = view === "albums" ? shownAlbums.length : view === "artists" ? shownArtists.length : shownSongs.length;
  // PAR-LIB-06: the quiet counts; with a filter on, how many of the open tab's are shown.
  const counts: MobileLibraryCount[] =
    filterCount > 0
      ? [{ n: shownCount, text: t("shell.library.shownOf", { shown: shownCount, total: countText(COUNT_KIND[view], totals[view]) }) }]
      : (["albums", "songs", "artists"] as const).map((tab) => ({ n: totals[tab], text: countText(COUNT_KIND[tab], totals[tab]) }));
  const openFilter = () => {
    setDraft(tabPrefs.filters);
    setSheet("filter");
  };
  const apply = () => {
    setFilters(draft);
    setSheet(null);
  };
  const allowed: readonly string[] = PARROT_LIBRARY_FILTERS[view];
  const flags = (["liked", "lyrics", "lossless"] as const).filter((flag) => allowed.includes(flag));
  const sortSection = (
    <MobileLibrarySheetSection label={t("shell.library.sortHeading")} testID="library-sort-section">
      <MobileLibraryPills
        pills={(PARROT_LIBRARY_SORTS[view] as readonly ParrotLibrarySort[]).map((sort) => ({
          id: sort,
          label: t(`shell.library.${SORT_LABEL[view][sort]}`),
          on: tabPrefs.sort === sort,
          onPress: () => setTab(view, { sort } as Partial<ParrotLibraryPrefs[typeof view]>),
          testID: `library-sort-${sort}`,
        }))}
      />
    </MobileLibrarySheetSection>
  );
  const more = (count: number) => t("parrot.library.more", { count });
  const switcher = (
    <MobileLibrarySegmented
      options={[
        { id: "albums", label: t("parrot.library.view.albums"), testID: "library-tab-albums" },
        { id: "artists", label: t("parrot.library.view.artists"), testID: "library-tab-artists" },
        { id: "songs", label: t("parrot.library.view.songs"), testID: "library-tab-songs" },
      ]}
      value={view}
      onChange={setView}
    />
  );
  const header = (
    <View style={styles.head}>
      <MobileLibraryHeader
        switcher={switcher}
        counts={counts}
        filterCount={filterCount}
        filterDisabled={genres.length < 2 && decades.length < 2 && flags.length === 0}
        onOpenFilter={openFilter}
        onOpenSort={() => setSheet("sort")}
        onClear={() => setFilters({})}
        labels={{
          filter: t("shell.library.filter"),
          sort: t("shell.library.sort"),
          clear: t("shell.library.clearFilters"),
          filterActive: (count) => t("parrot.library.filterOn", { count }),
        }}
      />
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      {header}
      {view === "albums" ? (
        <AlbumsView albums={shownAlbums} loading={albums.loading} />
      ) : view === "artists" ? (
        <ArtistsView artists={shownArtists} loading={artists.loading} />
      ) : (
        <SongsView songs={shownSongs} loading={songs.loading} error={songs.error} />
      )}
      <MobileLibrarySheet
        visible={sheet === "filter"}
        onClose={() => setSheet(null)}
        title={t("shell.library.filter")}
        testID="library-filter-sheet"
        footer={
          <MobileLibrarySheetButtons
            secondary={{ label: t("shell.library.filterReset"), onPress: () => setDraft({}), testID: "library-filter-reset" }}
            primary={{ label: t("shell.library.filterApply"), onPress: apply, testID: "library-filter-apply" }}
          />
        }
      >
        {genres.length >= 2 ? (
          <MobileLibrarySheetSection label={t("shell.library.filterGenre")} testID="library-filter-genre">
            <MobileLibraryFilterPicker
              options={genres.map((genre) => ({ value: genre, label: genre }))}
              selected={draft.genre ? [draft.genre] : []}
              onChange={(next) => setDraft({ ...draft, genre: next[0] })}
              single
              searchPlaceholder={t("parrot.library.searchGenres")}
              emptyText={t("parrot.library.noMatch")}
              moreLabel={more}
              testID="library-genre-picker"
            />
          </MobileLibrarySheetSection>
        ) : null}
        {decades.length >= 2 ? (
          <MobileLibrarySheetSection label={t("shell.library.filterDecade")} testID="library-filter-decade">
            <MobileLibraryFilterPicker
              options={decades.map((decade) => ({ value: String(decade), label: t("shell.library.decade", { decade }) }))}
              selected={draft.decade !== undefined ? [String(draft.decade)] : []}
              onChange={(next) => setDraft({ ...draft, decade: next[0] ? Number(next[0]) : undefined })}
              single
              searchPlaceholder={t("parrot.library.searchGenres")}
              emptyText={t("parrot.library.noMatch")}
              moreLabel={more}
              testID="library-decade-picker"
            />
          </MobileLibrarySheetSection>
        ) : null}
        {flags.length > 0 ? (
          <MobileLibrarySheetSection label={t("shell.library.filterShowOnly")} testID="library-filter-flags">
            <MobileLibraryPills
              pills={flags.map((flag) => ({
                id: flag,
                label: t(`shell.library.filter${flag[0]!.toUpperCase()}${flag.slice(1)}`),
                on: !!draft[flag],
                onPress: () => setDraft({ ...draft, [flag]: draft[flag] ? undefined : true }),
                testID: `library-flag-${flag}`,
              }))}
            />
          </MobileLibrarySheetSection>
        ) : null}
      </MobileLibrarySheet>
      <MobileLibrarySheet
        visible={sheet === "sort"}
        onClose={() => setSheet(null)}
        title={t("shell.library.sort")}
        testID="library-sort-sheet"
        footer={<MobileLibrarySheetButtons primary={{ label: t("shell.library.sortDone"), onPress: () => setSheet(null), testID: "library-sort-done" }} />}
      >
        {sortSection}
      </MobileLibrarySheet>
    </View>
  );
};

/** Home's "Recently added" "See all" (PAR-HOME-01) opens Albums in that order; the other album orders map one to one. */
const withAlbumSort = (prefs: ParrotLibraryPrefs, sort: ParrotAlbumSort | undefined): ParrotLibraryPrefs =>
  sort ? { ...prefs, albums: { ...prefs.albums, sort } } : prefs;

const AlbumsView = ({ albums, loading }: { albums: AlbumWithCover[]; loading: boolean }) => {
  const { reloadLibrary } = useSession();
  const { t } = useTranslation();
  const reach = useOfflineReach();
  return (
    <AlbumGrid
      albums={albums}
      loading={loading}
      empty={t("parrot.library.noAlbums")}
      unavailable={reach ? (album) => !reach.album(album.id) : undefined}
      onRefresh={() => void reloadLibrary()}
    />
  );
};

const ArtistsView = ({ artists, loading }: { artists: ArtistRow[]; loading: boolean }) => {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const reach = useOfflineReach();
  const skyScroll = useSkyScroll();
  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={artists}
      keyExtractor={(artist) => artist.id}
      {...skyScroll}
      ListEmptyComponent={loading ? <ActivityIndicator color={colors.accent} /> : <Body muted>{t("parrot.library.noArtists")}</Body>}
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

const SongsView = ({ songs, loading, error: readError }: { songs: Array<WithCoverKeys<SongRow>>; loading: boolean; error: string | null }) => {
  const { t } = useTranslation();
  const { play, starting, error } = usePlay();
  const now = useNowPlaying();
  const skyScroll = useSkyScroll();
  const editor = usePlaylistEditor();
  const reach = useOfflineReach();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={songs}
      keyExtractor={(song) => song.id}
      {...skyScroll}
      ListHeaderComponent={
        error || readError ? (
          <View>
            {error ? <ErrorText>{error}</ErrorText> : null}
            {readError ? <ErrorText>{readError}</ErrorText> : null}
          </View>
        ) : undefined
      }
      ListEmptyComponent={loading ? <ActivityIndicator color={colors.accent} /> : <Body muted>{t("parrot.library.noSongs")}</Body>}
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
          onPress={() => void play(songs, index)}
          onMore={() => editor.openSong({ id: item.id, title: item.title })}
          moreLabel={`${t("parrot.player.more")}, ${item.title}`}
        />
      ))}
    />
  );
};

const styles = StyleSheet.create({
  head: { paddingTop: spacing.md, paddingBottom: spacing.sm, paddingHorizontal: spacing.lg },
  list: { padding: spacing.lg, gap: spacing.xs },
  count: { color: colors.textMuted, fontSize: 13 },
  artist: { paddingVertical: spacing.sm, minHeight: 64 },
  artistContent: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md },
  name: { color: colors.text, fontSize: 16, fontWeight: "600" },
});
