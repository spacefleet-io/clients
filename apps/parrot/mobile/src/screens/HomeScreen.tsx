// Home (PAR-HOME-01, PAR-HOME-02): the desktop's Home on the phone, with no page title: the tab bar names the page
// (PAR-NAV-04). "Jump back in" with the album played last here
// (Resume where it stopped, or Shuffle), then "Recently played" and "Your artists" as rows that scroll sideways. What
// it picks is `homeView` from @space/parrot-core, the same on every surface; the history is this phone's own.
import React from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Pause, Play, Shuffle } from "lucide-react-native";
import { AudioPlayback, showsPause } from "@space/mobile-audio-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileMascotLoader } from "@space/mobile-shell/mascot-loader";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { guardRenderItem } from "@space/mobile-shell/render-boundary";
import { formatDuration, homeAlbumDetail, homeAlbumStart, homeJumpButton, homeView, parrotArtistPictureThumbKey, parrotCoverThumbKey } from "@space/parrot-core";
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

/** Which library list a row's "See all" opens. */
export type HomeSeeAll = "albums" | "artists";

export const HomeScreen = ({ onSeeAll }: { onSeeAll: (view: HomeSeeAll) => void }) => {
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
  if (library.status !== "ready" || (data.loading && !data.data)) {
    return (
      <View style={styles.fill}>
        {library.status === "error" ? (
          <LibraryTabHint error={library.error} onOpenLibrary={() => onSeeAll("albums")} />
        ) : (
          <View style={styles.loading}>
            <MobileMascotLoader app="parrot" source={PARROT_MASCOT} size={120} />
          </View>
        )}
      </View>
    );
  }
  const { albums, artists, songs } = data.data ?? { albums: [], artists: [], songs: [] };
  if (albums.length === 0) return <EmptyLibrary />;
  const view = homeView(history, albums, artists, songs);
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

      <Shelf title={view.played ? t("shell.home.recentlyPlayed") : t("parrot.library.view.albums")} onSeeAll={() => onSeeAll("albums")} testID="home-albums">
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
          data={view.albums}
          keyExtractor={(album) => album.id}
          {...skyScroll}
          renderItem={guardRenderItem("album-tile", ({ item }) => (
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
          ), { width: TILE, height: TILE, margin: 0 })}
        />
      </Shelf>

      {view.artists.length > 0 ? (
        <Shelf title={t("shell.home.yourArtists")} onSeeAll={() => onSeeAll("artists")} testID="home-artists">
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.row}
            data={view.artists}
            keyExtractor={(artist) => artist.id}
            {...skyScroll}
            renderItem={guardRenderItem("artist-tile", ({ item }) => (
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
            ), { width: 96, margin: 0 })}
          />
        </Shelf>
      ) : null}
    </ScrollView>
  );
};

const Shelf = ({ title, onSeeAll, testID, children }: { title: string; onSeeAll: () => void; testID: string; children: React.ReactNode }) => {
  const { t } = useTranslation();
  return (
    <View style={styles.shelf} testID={testID}>
      <View style={styles.shelfHead}>
        <Text style={styles.shelfTitle}>{title}</Text>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onSeeAll} testID={`${testID}-see-all`}>
          <Text style={styles.seeAll}>{t("shell.home.seeAll")}</Text>
        </Pressable>
      </View>
      {children}
    </View>
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
  loading: { alignItems: "center", marginTop: spacing.xl },
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
  shelf: { marginTop: spacing.xl },
  shelfHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  shelfTitle: { color: colors.text, fontSize: 20, fontWeight: "800" },
  seeAll: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  row: { paddingHorizontal: spacing.lg, gap: spacing.lg },
  artist: { width: 96, alignItems: "center", gap: spacing.sm },
  artistName: { color: colors.text, fontSize: 13, fontWeight: "600", textAlign: "center" },
});
