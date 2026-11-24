// TV Home (PAR-TV-03, draft `1a-home-topbar`): under the top bar, the "Jump back in" card with the album last played on
// this TV (its cover, title, "artist · year · songs", Resume at the time the song was left at or Play, Shuffle, and the
// song's wave with the played part in green), then the "Recently played" row of album cards, the "Recently added" row
// (PAR-HOME-01: the library's newest albums, right under "Recently played", as on the phone and desktop) and the "Your
// artists" row of round photos, each with "See all". What it picks is `homeView` and `homeRecentlyAdded` from
// @space/parrot-core, as on the phone and desktop; "Recently added"'s "See all" opens the albums newest added first.
import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Pause, Play, Shuffle } from "lucide-react-native";
import { AudioPlayback, showsPause } from "@space/mobile-audio-playback";
import { MobileLibraryLoading, SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvPillButton } from "@space/mobile-shell/tv/TvPillButton";
import { TvBody, TvEyebrow, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_COLOR, TV_SPACE, TV_TYPE } from "@space/mobile-shell/tv/tokens";
import { tvHomeCardWidth } from "@space/mobile-shell/tv/layout";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { libraryContent } from "@space/shared/libraryContent";
import {
  formatDuration,
  homeAlbumDetail,
  homeAlbumStart,
  homeJumpButton,
  homeRecentlyAdded,
  homeView,
  parrotCoverThumbKey,
  type ParrotAlbumSort,
} from "@space/parrot-core";
import { PARROT_MASCOT } from "../brand";
import { listAlbums, listArtists, listSongs } from "../lib/library";
import { nowPlayingOf } from "../lib/nowPlaying";
import { ParrotArt } from "../screens/art";
import { useListeningHistory } from "../state/history";
import { useSession } from "../state/session";
import { usePlayerState } from "../state/usePlayerState";
import { useQuery } from "../state/useQuery";
import { TvAlbumCard, TvArtistCard, TvCardRow, TvWave } from "./TvMusicParts";
import { useTvPages, useTvPlay } from "./tvPages";

const log = scopeLogger("parrot.tv.home");

/** Draft `.artist` 150 px wide with a 52 px gap, `.hero .cover` 220 px. */
const ARTIST_WIDTH = 75;
const ARTIST_GAP = 26;
const HERO_COVER = 110;

/** What the library says while it is not open: still loading, missing, failed or empty. */
export const TvLibraryState = ({ kind, error }: { kind: "loading" | "empty" | "missing" | "error"; error?: string | null }) => {
  const { t } = useTranslation();
  const styles = useTvStyles(baseStyles);
  if (kind === "loading") return <MobileLibraryLoading app="parrot" source={PARROT_MASCOT} label={t("parrot.library.loading")} />;
  return (
    <View style={styles.state} testID={`tv-library-${kind}`}>
      <TvBody muted>{kind === "error" ? t("parrot.library.openFailed", { error: error ?? "" }) : t("parrot.library.noAlbums")}</TvBody>
    </View>
  );
};

export const TvHomeSection = ({ onSeeAll }: { onSeeAll: (albumSort?: ParrotAlbumSort) => void }) => {
  const { t } = useTranslation();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const data = useQuery(async () => {
    const [albums, artists, songs] = await Promise.all([listAlbums(), listArtists(), listSongs()]);
    return { albums, artists, songs };
  }, [version]);
  const history = useListeningHistory();
  const { push } = useTvPages();
  const { play, starting } = useTvPlay();
  const player = usePlayerState(1000);
  const now = nowPlayingOf(player);
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const skyScroll = useSkyScroll();

  if (library.status === "missing") return <TvLibraryState kind="missing" />;
  if (library.status === "error") return <TvLibraryState kind="error" error={library.error} />;
  const { albums, artists, songs } = (library.status === "ready" ? data.data : null) ?? { albums: [], artists: [], songs: [] };
  const content = libraryContent({ itemCount: albums.length, settled: library.status === "ready" && data.answered });
  if (content === "loading") return <TvLibraryState kind="loading" />;
  if (content === "empty") return <TvLibraryState kind="empty" />;

  const view = homeView(history, albums, artists, songs);
  const added = homeRecentlyAdded(albums);
  const jump = view.jump;
  const entry = jump?.entry ?? null;
  const button = jump ? homeJumpButton(jump.album.id, entry, now && player ? { ...now, positionMs: player.positionMs, playing: showsPause(player) } : null) : null;
  const waveTrack = button?.trackId ? songs.find((song) => song.id === button.trackId) : undefined;
  const playAlbum = (albumId: string, shuffle: boolean) => {
    const start = homeAlbumStart(songs, albumId, jump?.album.id === albumId ? entry : null, shuffle);
    if (start.tracks.length === 0) return;
    log.info("play_album", { albumId, index: start.index, startMs: start.startMs, shuffle });
    const album = albums.find((row) => row.id === albumId);
    void play(start.tracks, start.index, album ? { title: album.title, cover: album } : undefined, { shuffle, startPositionMs: start.startMs });
  };
  const openAlbum = (albumId: string) => push({ kind: "album", albumId });
  const cardWidth = tvHomeCardWidth(scale);

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} {...skyScroll}>
      {jump ? (
        <SkyCover style={styles.hero} testID="tv-home-jump">
          <ParrotArt seed={jump.album.id} size={HERO_COVER * scale} radius={8 * scale} coverKey={parrotCoverThumbKey(jump.album)} playing={now?.albumId === jump.album.id} />
          <View style={styles.heroText}>
            <TvEyebrow>{entry ? t("shell.home.jumpBackIn") : t("shell.home.startListening")}</TvEyebrow>
            <TvTitle size="hero" numberOfLines={1} style={styles.heroTitle}>
              {jump.album.title}
            </TvTitle>
            <TvBody muted numberOfLines={1} testID="tv-home-jump-detail">
              {homeAlbumDetail(jump.album, t("shell.library.unknownArtist"), t("parrot.library.songs", { count: jump.album.trackCount }))}
            </TvBody>
            <View style={styles.heroActions}>
              <TvPillButton
                testID="tv-home-resume"
                variant="primary"
                hasTVPreferredFocus
                disabled={starting !== null}
                icon={button?.kind === "pause" ? Pause : Play}
                filledIcon
                label={
                  button?.kind === "pause"
                    ? t("player.controls.pause")
                    : button?.kind === "resume"
                      ? t("shell.home.resume", { time: formatDuration(button.positionMs) })
                      : t("player.controls.play")
                }
                onPress={() => (button?.live ? void (button.kind === "pause" ? AudioPlayback.pause() : AudioPlayback.play()) : playAlbum(jump.album.id, false))}
              />
              <TvPillButton testID="tv-home-shuffle" icon={Shuffle} label={t("shell.home.shuffle")} disabled={starting !== null} onPress={() => playAlbum(jump.album.id, true)} />
            </View>
          </View>
          <TvWave
            style={styles.heroWave}
            seed={waveTrack?.id ?? jump.album.id}
            progress={waveTrack?.durationMs && button ? Math.min(1, button.positionMs / waveTrack.durationMs) : 0}
            height={28}
            bars={72}
          />
        </SkyCover>
      ) : null}

      <TvCardRow
        testID="tv-home-albums"
        title={view.played ? t("shell.home.recentlyPlayed") : t("parrot.library.view.albums")}
        items={view.albums}
        keyOf={(album) => album.id}
        cardWidth={cardWidth}
        gap={TV_SPACE.posterGap}
        onSeeAll={() => onSeeAll()}
        renderCard={(album, _index, onFocus) => (
          <TvAlbumCard album={album} width={cardWidth} playing={now?.albumId === album.id ? { animated: now.playing } : null} onOpen={openAlbum} onFocus={onFocus} />
        )}
      />

      {added.length > 0 ? (
        <TvCardRow
          testID="tv-home-added"
          title={t("shell.home.recentlyAdded")}
          items={added}
          keyOf={(album) => album.id}
          cardWidth={cardWidth}
          gap={TV_SPACE.posterGap}
          onSeeAll={() => onSeeAll("recent")}
          renderCard={(album, _index, onFocus) => (
            <TvAlbumCard album={album} width={cardWidth} playing={now?.albumId === album.id ? { animated: now.playing } : null} onOpen={openAlbum} onFocus={onFocus} />
          )}
        />
      ) : null}

      {view.artists.length > 0 ? (
        <TvCardRow
          testID="tv-home-artists"
          title={t("shell.home.yourArtists")}
          items={view.artists}
          keyOf={(artist) => artist.id}
          cardWidth={ARTIST_WIDTH * scale}
          gap={ARTIST_GAP}
          onSeeAll={() => onSeeAll()}
          renderCard={(artist, _index, onFocus) => (
            <TvArtistCard artist={artist} width={ARTIST_WIDTH * scale} onOpen={(row) => push({ kind: "artist", artistId: row.id, name: row.name })} onFocus={onFocus} />
          )}
        />
      ) : null}
    </ScrollView>
  );
};

/** Sizes in design dp: draft px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  scroll: { paddingBottom: 24, gap: 6 },
  state: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: TV_SPACE.screenX },
  // Draft `.hero`: margin 34px 72px, padding 30px 40px, radius 24, gap 48.
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    marginTop: 14,
    marginHorizontal: TV_SPACE.screenX,
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: TV_COLOR.cardOnSky,
    borderWidth: 0.75,
    borderColor: TV_COLOR.borderSoft,
  },
  heroText: { flex: 1, gap: 3 },
  heroTitle: { ...TV_TYPE.hero },
  heroActions: { flexDirection: "row", gap: 11, marginTop: 12 },
  heroWave: { width: 230 },
});
