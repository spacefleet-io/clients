// One album's songs, in disc and track order; tapping one plays it and then the rest of the album. The song that plays
// is marked (green title, equaliser for its number) and the cover is ringed while the album plays (PAR-LOOK-01). Under
// the title sit the design's Play, Shuffle, heart and "…" (PAR-LOOK-05): the "…" holds the album card's actions
// (the shared `parrotCardActionList` of @space/parrot-core, PAR-CARD-01) without Play and Shuffle, Edit metadata among
// them (PAR-META-16/17), then Save offline (PAR-OFFL-01) and last Delete (PAR-LIB-03). The album's songs the
// user does not have sit greyed between them, never played (PAR-LIB-05).
import React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ArrowDownToLine, CircleCheck, Disc3, Ellipsis, Heart, ListEnd, ListPlus, ListStart, MicVocal, Pencil, Play, Shuffle, Trash2 } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { guardRenderItem } from "@space/mobile-shell/render-boundary";
import {
  albumPageRows,
  parrotAlbumPageActions,
  parrotCardActionList,
  parrotCoverThumbKey,
  type ParrotCardActionId,
  type ParrotCardPlayer,
  type TrackRow,
} from "@space/parrot-core";
import { useQuery } from "../state/useQuery";
import { usePlay } from "../state/usePlay";
import { useNowPlaying } from "../state/usePlayerState";
import { usePlaylistEditor, type SheetAction } from "../state/playlistEditor";
import { ParrotArt } from "./art";
import { PlayingBadge } from "./equalizer";
import { MissingSongRow, SongListRow } from "./SongListRow";
import { KeptLine, useKept, useOfflineReach } from "./kept";
import { albumHeader, listAlbumTracklist, listAlbumTracks } from "../lib/library";
import { useManage } from "../state/manage";
import { useSession } from "../state/session";
import { colors, spacing } from "../theme";
import { Body, ErrorText, IconButton, Title } from "./ui";
import { PageBackButton, usePageTop } from "./pageBack";
import type { RootStack } from "./routes";
import { ParrotSky } from "./sky";

const COVER = 220;

/** The phone's icon for each shared card action (the desktop's and the web player's are lucide-react's same ones). */
const ACTION_ICONS: Record<ParrotCardActionId, SheetAction["icon"]> = {
  play: Play,
  shuffle: Shuffle,
  "play-next": ListStart,
  "add-to-queue": ListEnd,
  "go-to-album": Disc3,
  "go-to-artist": MicVocal,
  "add-to-playlist": ListPlus,
  edit: Pencil,
};

export const AlbumScreen = ({ route }: NativeStackScreenProps<RootStack, "Album">) => {
  const { albumId } = route.params;
  const { t } = useTranslation();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const tracks = useQuery(() => listAlbumTracks(albumId), [albumId, version]);
  const tracklist = useQuery(() => listAlbumTracklist(albumId), [albumId, version]);
  // The page opens with what the tile knew; after an edit (PAR-META-16) the library's row says what it is now.
  const header = useQuery(() => albumHeader(albumId), [albumId, version]);
  const title = header.data?.title ?? route.params.title;
  const artistName = header.data?.artistName ?? route.params.artistName;
  const cover = header.data ?? route.params.cover ?? null;
  const manage = useManage();
  const { play, queue, starting, error } = usePlay();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const top = usePageTop();
  const now = useNowPlaying();
  const albumPlays = now?.albumId === albumId;
  const editor = usePlaylistEditor();
  const kept = useKept();
  const reach = useOfflineReach();
  const songs = tracks.data ?? [];
  // Play, shuffle, the heart and the queue use `songs` only; the missing rows are for reading.
  const rows = albumPageRows(songs, tracklist.data);
  const songIds = songs.map((track) => track.id);
  const allLiked = editor.allLiked(songIds);
  const albumInfo = { title, cover };
  const player: ParrotCardPlayer<TrackRow> = {
    play: (list) => void play(list, 0, albumInfo),
    shuffle: (list) => void play(list, Math.floor(Math.random() * list.length), albumInfo, { shuffle: true }),
    playNext: (list) => void queue(list, "next", albumInfo).then(editor.queued),
    addToQueue: (list) => void queue(list, "end", albumInfo).then(editor.queued),
  };
  const artistId = header.data?.artistId || songs.find((track) => track.artistId)?.artistId;
  const openArtist = artistId ? () => navigation.navigate("Artist", { artistId, name: artistName }) : undefined;
  const openMenu = () => {
    const shared = parrotAlbumPageActions(
      parrotCardActionList((key) => t(`shell.${key}`), () => songs, player, {
        onGoToArtist: openArtist,
        onAddToPlaylist: (list) => editor.addToPlaylist({ id: albumId, title, trackIds: list.map((track) => track.id) }),
        onEdit: () => manage.edit({ kind: "album", id: albumId, title, coverKey: cover?.coverObjectKey ?? null }),
      })
    );
    const keptNow = kept.entry("album", albumId);
    editor.openActions(
      title,
      [
        ...shared.map((action) => ({ id: action.id, label: action.label, icon: ACTION_ICONS[action.id], onSelect: action.onSelect, testID: `album-menu-${action.id}` })),
        {
          id: "keep",
          label: keptNow ? t("parrot.kept.remove") : t("parrot.kept.keep"),
          icon: keptNow ? CircleCheck : ArrowDownToLine,
          onSelect: () => editor.toggleKeep("album", albumId),
          testID: keptNow ? "album-menu-unkeep" : "album-menu-keep",
        },
        {
          id: "delete",
          label: t("shell.manage.delete"),
          icon: Trash2,
          destructive: true,
          onSelect: () => manage.remove({ kind: "album", id: albumId }, title, () => navigation.goBack()),
          testID: "album-menu-delete",
        },
      ],
      "album-menu"
    );
  };

  return (
    <ParrotSky>
    <FlatList
      contentContainerStyle={{ padding: spacing.lg, paddingTop: top, gap: spacing.xs }}
      data={rows}
      keyExtractor={(row) => (row.kind === "owned" ? row.track.id : `missing:${row.listed.disc}:${row.listed.number}`)}
      ListHeaderComponent={
        <View style={{ gap: spacing.xs, marginBottom: spacing.md }}>
          <View style={{ alignSelf: "center", marginBottom: spacing.md }}>
            <ParrotArt
              seed={albumId}
              size={COVER}
              radius={14}
              playing={albumPlays}
              coverKey={cover?.coverObjectKey}
              previewKey={cover ? parrotCoverThumbKey(cover) : null}
            />
            {albumPlays ? <PlayingBadge size={COVER} animated={!!now?.playing} /> : null}
          </View>
          <Title>{title}</Title>
          {artistName ? (
            // PAR-NAV-05: the artist's name opens the artist's page.
            <Pressable testID="album-artist-link" accessibilityRole="link" disabled={!openArtist} onPress={openArtist} hitSlop={6} style={{ alignSelf: "flex-start" }}>
              <Body muted>{artistName}</Body>
            </Pressable>
          ) : null}
          <KeptLine kind="album" id={albumId} kept={kept} />
          <View style={styles.actions}>
            <Pressable
              testID="album-play"
              accessibilityRole="button"
              accessibilityLabel={t("shell.card.play")}
              disabled={songs.length === 0}
              onPress={() => player.play(songs)}
              style={({ pressed }) => [styles.play, (pressed || songs.length === 0) && { opacity: 0.6 }]}
            >
              <Play size={26} color={colors.accentText} fill={colors.accentText} />
            </Pressable>
            <IconButton testID="album-shuffle" icon={Shuffle} label={t("shell.card.shuffle")} onPress={() => songs.length > 0 && player.shuffle(songs)} />
            <IconButton
              testID="album-like"
              icon={AlbumHeart(allLiked)}
              color={allLiked ? colors.accent : colors.text}
              label={allLiked ? t("shell.playlists.unlike") : t("shell.playlists.like")}
              onPress={() => songs.length > 0 && editor.toggleLikeAll(songIds)}
            />
            <IconButton testID="album-more" icon={Ellipsis} label={t("shell.card.more")} onPress={openMenu} />
          </View>
          {error ? <ErrorText>{error}</ErrorText> : null}
          {tracks.error ? <ErrorText>{tracks.error}</ErrorText> : null}
        </View>
      }
      ListEmptyComponent={tracks.loading ? <ActivityIndicator color={colors.accent} /> : <Body muted>{t("parrot.album.noSongs")}</Body>}
      renderItem={guardRenderItem("song-row", ({ item: row }) => {
        if (row.kind === "missing") {
          return <MissingSongRow number={row.listed.number} title={row.listed.title} note={t("shell.library.missingTrack")} durationMs={row.listed.durationMs} />;
        }
        const { track: item, index } = row;
        return (
          <SongListRow
            lead={item.number ?? "·"}
            title={item.title}
            names={
              item.artistName && item.artistName !== artistName
                ? [
                    {
                      text: item.artistName,
                      testID: "song-artist-link",
                      onPress: item.artistId ? () => navigation.navigate("Artist", { artistId: item.artistId!, name: item.artistName }) : undefined,
                    },
                  ]
                : undefined
            }
            durationMs={item.durationMs}
            playing={now?.trackId === item.id ? { animated: now.playing } : null}
            starting={starting === item.id}
            disabled={starting !== null}
            unavailable={reach ? !reach.song(item.id) : false}
            accessibilityLabel={t("parrot.album.play", { title: item.title })}
            onPress={() => void play(songs, index, { title, cover })}
            onMore={() => editor.openSong({ id: item.id, title: item.title }, undefined, { onAddToQueue: () => queue([item], "end", albumInfo) })}
            moreLabel={`${t("parrot.player.more")}, ${item.title}`}
          />
        );
      })}
    />
    <PageBackButton onPress={() => navigation.goBack()} />
    </ParrotSky>
  );
};

/** The album's heart: filled green when every song is liked (PAR-PL-04). */
const FilledHeart = ({ size, color }: { size?: number; color?: string }) => <Heart size={size} color={color} fill={color} />;
const AlbumHeart = (on: boolean): SheetAction["icon"] => (on ? FilledHeart : Heart);

const styles = StyleSheet.create({
  actions: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
  play: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
});
