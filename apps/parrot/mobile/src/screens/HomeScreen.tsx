// Home (PAR-HOME-01, PAR-HOME-02): the desktop's Home on the phone, with no page title: the tab bar names the page
// (PAR-NAV-04). "Jump back in" with the album played last here
// (Resume where it stopped, or Shuffle), then "Recently played", "Recently added" and "Your artists" as rows that
// scroll sideways. What it picks is `homeView` and `homeRecentlyAdded` from @space/parrot-core, the same on every
// surface; the history is this phone's own.
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Pause, Play, Shuffle } from "lucide-react-native";
import { AudioPlayback, showsPause } from "@space/mobile-audio-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileHomeRail, MobileLibraryLoading, SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { libraryContent } from "@space/shared/libraryContent";
import {
  formatDuration,
  homeAlbumDetail,
  homeAlbumStart,
  homeJumpButton,
  homeRecentlyAdded,
  homeView,
  parrotArtistPictureThumbKey,
  parrotCoverThumbKey,
  type ParrotAlbumSort,
} from "@space/parrot-core";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { usePlay } from "../state/usePlay";
import { usePlayerState } from "../state/usePlayerState";
import { nowPlayingOf } from "../lib/nowPlaying";
import { useListeningHistory } from "../state/history";
import { listAlbums, listArtists, listSongs } from "../lib/library";
import { PARROT_MASCOT } from "../brand";
import { colors, spacing } from "../theme";
import { HomeWave, ParrotArt } from "./art";
import { AlbumTile } from "./AlbumGrid";
import { EmptyLibrary } from "./EmptyLibrary";
import { ErrorText } from "./ui";
import type { RootStack } from "./routes";

const TILE = 140;
const idOf = (x: { id: string }) => x.id;

/** Which library list a row's "See all" opens. */
export type HomeSeeAll = "albums" | "artists";

export const HomeScreen = ({ onSeeAll }: { onSeeAll: (view: HomeSeeAll, sort?: ParrotAlbumSort) => void }) => {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const data = useQuery(async () => {
    const [albums, artists, songs] = await Promise.all([listAlbums(), listArtists(), listSongs()]);
    return { albums, artists, songs };
  }, [version]);
  const history = useListeningHistory();
  const { play, starting, error } = usePlay();
  // Polled each second: Home's card names where the song stands while it plays or sits paused (PAR-HOME-01).
  const player = usePlayerState(1000);
  const now = nowPlayingOf(player);
  const skyScroll = useSkyScroll();

  if (library.status === "missing") return <EmptyLibrary />;
  if (library.status === "error") {
    return (
      <View style={styles.fill}>
        <LibraryTabHint error={library.error} onOpenLibrary={() => onSeeAll("albums")} />
      </View>
    );
  }
  // The empty library only once the albums of the library open now are read (UX-WAIT-04): the render where the library
  // turns ready still holds the answer of the run before (none), so `answered` decides, not `loading`.
  const { albums, artists, songs } = (library.status === "ready" ? data.data : null) ?? { albums: [], artists: [], songs: [] };
  const content = libraryContent({ itemCount: albums.length, settled: library.status === "ready" && data.answered });
  if (content === "loading") return <MobileLibraryLoading app="parrot" source={PARROT_MASCOT} label={t("parrot.library.loading")} />;
  if (content === "empty") return <EmptyLibrary />;
  const view = homeView(history, albums, artists, songs);
  const added = homeRecentlyAdded(albums);
  const playAlbum = (albumId: string, shuffle: boolean) => {
    const entry = view.jump?.album.id === albumId ? view.jump.entry : null;
    const start = homeAlbumStart(songs, albumId, entry, shuffle);
    if (start.tracks.length === 0) return;
    console.info("[parrot-home] play album", { albumId, index: start.index, first: start.tracks[start.index]?.title, startMs: start.startMs, shuffle });
    const album = albums.find((row) => row.id === albumId);
    void play(start.tracks, start.index, album ? { title: album.title, cover: album } : undefined, { shuffle, startPositionMs: start.startMs });
  };
  const jump = view.jump;
  const entry = jump?.entry ?? null;
  // While the card's album is queued the button follows the player: Pause while it plays, Resume where it stands.
  const button = jump ? homeJumpButton(jump.album.id, entry, now && player ? { ...now, positionMs: player.positionMs, playing: showsPause(player) } : null) : null;
  const waveTrack = button?.trackId ? songs.find((song) => song.id === button.trackId) : undefined;
  // The album tile of "Recently played" / "Albums" and "Recently added".
  const renderAlbum = (item: (typeof albums)[number]) => (
    <SkyCover>
      <AlbumTile
        album={item}
        size={TILE}
        playing={now?.albumId === item.id ? { animated: now.playing } : null}
        onPress={() =>
          navigation.navigate("Album", {
            albumId: item.id,
            title: item.title,
            artistName: item.artistName,
            cover: { coverObjectKey: item.coverObjectKey ?? null, coverThumbObjectKey: item.coverThumbObjectKey ?? null },
          })
        }
      />
    </SkyCover>
  );
  const renderArtist = (item: (typeof view.artists)[number]) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.name}
      onPress={() => navigation.navigate("Artist", { artistId: item.id, name: item.name })}
      style={({ pressed }) => [styles.artist, pressed && { opacity: 0.7 }]}
    >
      <SkyCover>
        <ParrotArt seed={item.id} size={96} radius={48} coverKey={parrotArtistPictureThumbKey(item)} />
      </SkyCover>
      <Text style={styles.artistName} numberOfLines={1}>
        {item.name}
      </Text>
    </Pressable>
  );
  // Every Home row is the shell's titled rail (UX-PHONE-01): its swipe scrolls the row, not the tab pager (UX-PHONE-09).
  const albumRail = (title: string, rowAlbums: typeof albums, testID: string, onPress: () => void) => (
    <MobileHomeRail
      {...shelf}
      title={title}
      items={rowAlbums}
      keyOf={idOf}
      renderItem={renderAlbum}
      itemWidth={TILE}
      itemHeight={TILE}
      boundaryName="album-tile"
      seeAll={{ label: t("shell.home.seeAll"), onPress }}
      testID={testID}
    />
  );

  return (
    <ScrollView contentContainerStyle={styles.scroll} {...skyScroll}>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {jump ? (
        <SkyCover style={styles.jump} testID="home-jump">
          <ParrotArt seed={jump.album.id} size={96} radius={12} coverKey={parrotCoverThumbKey(jump.album)} playing={now?.albumId === jump.album.id} />
          <View style={styles.jumpText}>
            <Text style={styles.kicker}>{(entry ? t("shell.home.jumpBackIn") : t("shell.home.startListening")).toUpperCase()}</Text>
            <Text style={styles.jumpTitle} numberOfLines={2}>
              {jump.album.title}
            </Text>
            <Text style={styles.meta} numberOfLines={1} testID="home-jump-detail">
              {homeAlbumDetail(jump.album, t("shell.library.unknownArtist"), t("parrot.library.songs", { count: jump.album.trackCount }))}
            </Text>
            <View style={styles.jumpActions}>
              <Pressable
                testID="home-resume"
                accessibilityRole="button"
                disabled={starting !== null}
                onPress={() => (button?.live ? void (button.kind === "pause" ? AudioPlayback.pause() : AudioPlayback.play()) : playAlbum(jump.album.id, false))}
                style={({ pressed }) => [styles.primary, pressed && { opacity: 0.7 }]}
              >
                {button?.kind === "pause" ? (
                  <Pause size={16} color={colors.accentText} fill={colors.accentText} />
                ) : (
                  <Play size={16} color={colors.accentText} fill={colors.accentText} />
                )}
                <Text style={styles.primaryText}>
                  {button?.kind === "pause"
                    ? t("player.controls.pause")
                    : button?.kind === "resume"
                      ? t("shell.home.resume", { time: formatDuration(button.positionMs) })
                      : t("player.controls.play")}
                </Text>
              </Pressable>
              <Pressable
                testID="home-shuffle"
                accessibilityRole="button"
                disabled={starting !== null}
                onPress={() => playAlbum(jump.album.id, true)}
                style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.7 }]}
              >
                <Shuffle size={16} color={colors.text} />
                <Text style={styles.secondaryText}>{t("shell.home.shuffle")}</Text>
              </Pressable>
            </View>
            <HomeWave
              seed={waveTrack?.id ?? jump.album.id}
              progress={waveTrack?.durationMs && button ? Math.min(1, button.positionMs / waveTrack.durationMs) : 0}
            />
          </View>
        </SkyCover>
      ) : null}

      {albumRail(view.played ? t("shell.home.recentlyPlayed") : t("parrot.library.view.albums"), view.albums, "home-albums", () => onSeeAll("albums"))}

      {added.length > 0 ? albumRail(t("shell.home.recentlyAdded"), added, "home-added", () => onSeeAll("albums", "recent")) : null}

      {view.artists.length > 0 ? (
        <MobileHomeRail
          {...shelf}
          title={t("shell.home.yourArtists")}
          items={view.artists}
          keyOf={idOf}
          renderItem={renderArtist}
          itemWidth={96}
          boundaryName="artist-tile"
          seeAll={{ label: t("shell.home.seeAll"), onPress: () => onSeeAll("artists") }}
          testID="home-artists"
        />
      ) : null}
    </ScrollView>
  );
};

/** The library failed to open: the Library tab says why and offers to try again. */
const LibraryTabHint = ({ error, onOpenLibrary }: { error: string | null; onOpenLibrary: () => void }) => {
  const { t } = useTranslation();
  return (
    <Pressable accessibilityRole="button" onPress={onOpenLibrary} style={{ padding: spacing.lg }}>
      <Text style={styles.meta}>{t("parrot.library.openFailed", { error })}</Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { paddingTop: spacing.md, paddingBottom: spacing.xl },
  jump: {
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: 18,
    backgroundColor: "rgba(22, 27, 38, 0.92)",
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
  },
  jumpText: { flex: 1, gap: 2 },
  kicker: { color: colors.accent, fontSize: 11, fontWeight: "700", letterSpacing: 1.2 },
  jumpTitle: { color: colors.text, fontSize: 18, fontWeight: "800" },
  meta: { color: colors.textMuted, fontSize: 13 },
  jumpActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" },
  primary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    minHeight: 36,
  },
  primaryText: { color: colors.accentText, fontWeight: "700", fontSize: 13 },
  secondary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    minHeight: 36,
  },
  secondaryText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  shelf: { marginTop: spacing.xl, gap: spacing.md },
  shelfTitle: { color: colors.text, fontSize: 20, fontWeight: "800" },
  seeAll: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  artist: { width: 96, alignItems: "center", gap: spacing.sm },
  artistName: { color: colors.text, fontSize: 13, fontWeight: "600", textAlign: "center" },
});

/** Parrot's look of a Home row: inset to the page edge, roomier gaps, its larger heading and accent "See all". */
const shelf = {
  style: styles.shelf,
  inset: spacing.lg,
  gap: spacing.lg,
  followSky: true,
  titleStyle: styles.shelfTitle,
  seeAllStyle: styles.seeAll,
} as const;
