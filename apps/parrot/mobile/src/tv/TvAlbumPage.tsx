// TV album page (PAR-TV-04, draft `2-album`), under the top bar: the cover at the left with "ALBUM", the title,
// "artist · year · songs", Play and Shuffle; at the right the songs on one card, the playing one in green with its bars.
// OK on a song plays the album from it and opens Now playing. A playlist opens the same page, each song with its own
// cover (PAR-TV-13).
import React from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { Play, Shuffle } from "lucide-react-native";
import { useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvPillButton } from "@space/mobile-shell/tv/TvPillButton";
import { TvBody, TvEyebrow, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_SPACE, TV_TYPE } from "@space/mobile-shell/tv/tokens";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { albumPageRows, parrotCoverThumbKey, type ParrotCoverKeys, type TrackRow } from "@space/parrot-core";
import { albumHeader, listAlbumTracklist, listAlbumTracks, listPlaylistSongs } from "../lib/library";
import { isLikedPlaylist } from "../lib/playlists";
import { ParrotArt } from "../screens/art";
import { useSession } from "../state/session";
import { useNowPlaying } from "../state/usePlayerState";
import { useQuery } from "../state/useQuery";
import { TvListCard, TvPlaylistFace, TvSongRow } from "./TvMusicParts";
import { useTvPlay } from "./tvPages";

const log = scopeLogger("parrot.tv.album");

export type TvAlbumSource = { kind: "album"; albumId: string } | { kind: "playlist"; playlistId: string; name: string };

/** Draft `.cover` 500 px, `.row` 74 px high; a playlist row's cover 52 px. */
const COVER = 250;
const ROW = 37;
const ROW_COVER = 26;

type Song = TrackRow & { albumTitle?: string } & Partial<ParrotCoverKeys>;
type Row = { kind: "owned"; track: Song; index: number } | { kind: "missing"; key: string; number: number | null; title: string; durationMs: number | null };

export const TvAlbumPage = ({ source }: { source: TvAlbumSource }) => {
  const { t } = useTranslation();
  const { library, localChanges } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const id = source.kind === "album" ? source.albumId : source.playlistId;
  const data = useQuery(async () => {
    if (source.kind === "playlist") return { header: null, songs: (await listPlaylistSongs(source.playlistId).catch(() => [])) as Song[], tracklist: null };
    const [header, songs, tracklist] = await Promise.all([albumHeader(source.albumId), listAlbumTracks(source.albumId), listAlbumTracklist(source.albumId)]);
    return { header, songs: songs as Song[], tracklist };
  }, [source.kind, id, version, localChanges]);
  const { play, starting } = useTvPlay();
  const now = useNowPlaying();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const skyScroll = useSkyScroll();

  const header = data.data?.header ?? null;
  const songs = data.data?.songs ?? [];
  const playlist = source.kind === "playlist";
  const rows: Row[] = playlist
    ? songs.map((track, index) => ({ kind: "owned", track, index }))
    : albumPageRows(songs, data.data?.tracklist).map((row) =>
        row.kind === "owned"
          ? { kind: "owned", track: row.track, index: row.index }
          : { kind: "missing", key: `missing:${row.listed.disc}:${row.listed.number}`, number: row.listed.number, title: row.listed.title, durationMs: row.listed.durationMs }
      );
  const title = playlist ? source.name : (header?.title ?? "");
  const albumInfo = playlist ? undefined : { title, cover: header };
  const detail = playlist
    ? t("parrot.library.songs", { count: songs.length })
    : [header?.artistName || t("shell.library.unknownArtist"), header?.year, t("parrot.library.songs", { count: songs.length })].filter(Boolean).join(" · ");
  const playFrom = (index: number, shuffle: boolean) => {
    if (songs.length === 0) return;
    log.info("play", { kind: source.kind, id, index, shuffle });
    void play(songs, index, albumInfo, { shuffle });
  };
  const firstOwned = rows.findIndex((row) => row.kind === "owned");
  const coverSeed = playlist ? (songs[0]?.albumId ?? id) : id;
  const coverKey = playlist ? (songs[0] ? parrotCoverThumbKey(songs[0] as ParrotCoverKeys) : null) : header ? parrotCoverThumbKey(header) : null;

  return (
    <View style={styles.page} testID={`tv-${source.kind}-page`}>
      <View style={styles.side}>
        {playlist && coverKey === null ? (
          <TvPlaylistFace playlistId={id} size={COVER * scale} radius={10 * scale} />
        ) : (
          <ParrotArt seed={coverSeed} size={COVER * scale} radius={10 * scale} coverKey={coverKey} playing={!playlist && now?.albumId === id} />
        )}
        <View style={styles.sideText}>
          <TvEyebrow>{playlist ? (isLikedPlaylist(id) ? t("shell.playlists.liked") : t("shell.playlists.kicker")) : t("shell.manage.field.album")}</TvEyebrow>
          <TvTitle size="hero" numberOfLines={2} style={styles.title}>
            {title}
          </TvTitle>
          <TvBody muted numberOfLines={1}>
            {detail}
          </TvBody>
        </View>
        <View style={styles.actions}>
          <TvPillButton testID="tv-album-play" variant="primary" icon={Play} filledIcon label={t("player.controls.play")} disabled={songs.length === 0 || starting !== null} onPress={() => playFrom(0, false)} />
          <TvPillButton
            testID="tv-album-shuffle"
            icon={Shuffle}
            label={t("shell.home.shuffle")}
            disabled={songs.length === 0 || starting !== null}
            onPress={() => playFrom(Math.floor(Math.random() * songs.length), true)}
          />
        </View>
      </View>
      {data.answered && songs.length === 0 ? (
        <View style={styles.listColumn}>
          <TvBody muted>{playlist ? (isLikedPlaylist(id) ? t("parrot.playlists.likedEmpty") : t("shell.playlists.emptyPlaylist")) : t("parrot.album.noSongs")}</TvBody>
        </View>
      ) : (
        <TvListCard style={styles.listColumn} testID="tv-album-songs">
          <FlatList
            data={rows}
            keyExtractor={(row) => (row.kind === "owned" ? `${row.track.id}:${row.index}` : row.key)}
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={false}
            {...skyScroll}
            renderItem={({ item, index }) =>
              item.kind === "missing" ? (
                <TvSongRow lead={item.number} title={item.title} subtitle={t("shell.library.missingTrack")} durationMs={item.durationMs} playing={null} height={ROW} onPress={() => undefined} focusable={false} />
              ) : (
                <TvSongRow
                  testID={`tv-album-song-${item.index}`}
                  height={playlist ? ROW + 6 : ROW}
                  lead={item.track.number ?? item.index + 1}
                  cover={
                    playlist ? <ParrotArt seed={item.track.albumId} size={ROW_COVER * scale} radius={4 * scale} coverKey={parrotCoverThumbKey(item.track as ParrotCoverKeys)} /> : undefined
                  }
                  title={item.track.title}
                  subtitle={playlist ? [item.track.artistName, item.track.albumTitle].filter(Boolean).join(" · ") : undefined}
                  durationMs={item.track.durationMs}
                  playing={now?.trackId === item.track.id ? { animated: now.playing } : null}
                  hasTVPreferredFocus={index === firstOwned}
                  onPress={() => playFrom(item.index, false)}
                />
              )
            }
          />
        </TvListCard>
      )}
    </View>
  );
};

/** Sizes in design dp: draft px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  // Draft `.album`: padding 44px 72px, columns 500px + the rest, gap 72px.
  page: { flex: 1, flexDirection: "row", gap: TV_SPACE.screenX, paddingTop: 22, paddingBottom: 18, paddingHorizontal: TV_SPACE.screenX },
  side: { width: COVER, gap: 12 },
  sideText: { gap: 3 },
  title: { ...TV_TYPE.hero, fontSize: 32, lineHeight: 38 },
  actions: { flexDirection: "row", gap: TV_SPACE.buttonGap + 2 },
  listColumn: { flex: 1 },
});
