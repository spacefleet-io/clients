// One playlist's songs in its order (opened from the Playlists tab or chip): a tap plays the list from that song on.
// A song's sheet takes it out of the playlist; the title row keeps it on this phone (PAR-OFFL-01), "Liked songs"
// included, and its "…" (never on "Liked songs") opens the actions sheet to rename it or, last and in red, delete it
// after asking (PAR-PL-02).
import React from "react";
import { ActivityIndicator, FlatList, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ellipsis, Pencil, Trash2 } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useSkyScroll } from "@space/mobile-shell/components";
import { guardRenderItem } from "@space/mobile-shell/render-boundary";
import { parrotCoverThumbKey } from "@space/parrot-core";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { usePlay } from "../state/usePlay";
import { useNowPlaying } from "../state/usePlayerState";
import { usePlaylistEditor } from "../state/playlistEditor";
import { listPlaylistSongs } from "../lib/library";
import { isLikedPlaylist } from "../lib/playlists";
import { colors, spacing } from "../theme";
import { ParrotArt } from "./art";
import { SongListRow, songRowNames } from "./SongListRow";
import { KeepButton, KeptLine, useKept, useOfflineReach } from "./kept";
import { Body, ErrorText, IconButton, PageTitle } from "./ui";
import { PageBackButton, usePageTop } from "./pageBack";
import { ParrotSky } from "./sky";
import type { RootStack } from "./routes";

export const PlaylistScreen = ({ route, navigation }: NativeStackScreenProps<RootStack, "Playlist">) => {
  const { playlistId } = route.params;
  const { t } = useTranslation();
  const { library, localChanges } = useSession();
  const editor = usePlaylistEditor();
  const version = library.status === "ready" ? library.version : -1;
  // A song added or taken out shows at once, before the server has the change (PAR-PL-03).
  const songs = useQuery(() => listPlaylistSongs(playlistId).catch(() => []), [playlistId, version, localChanges]);
  const { play, queue, starting, error } = usePlay();
  const now = useNowPlaying();
  const skyScroll = useSkyScroll();
  // The title row brings its own top padding.
  const top = usePageTop() - spacing.md;
  const list = songs.data ?? [];
  const liked = isLikedPlaylist(playlistId);
  const kept = useKept();
  const reach = useOfflineReach();
  // The name as saved now: a rename on this page shows at once.
  const name = editor.playlists.find((playlist) => playlist.id === playlistId)?.name ?? route.params.name;
  const playlist = { id: playlistId, name };
  return (
    <ParrotSky>
      <FlatList
        contentContainerStyle={[styles.list, { paddingTop: top }]}
        data={list}
        keyExtractor={(song, index) => `${song.id}:${index}`}
        {...skyScroll}
        ListHeaderComponent={
          <>
            <PageTitle
              title={liked ? t("shell.playlists.liked") : name}
              actions={
                <>
                  <KeepButton testID="playlist-keep" state={kept.state("playlist", playlistId)} onPress={() => editor.toggleKeep("playlist", playlistId)} />
                  {liked ? null : (
                    <IconButton
                      testID="playlist-more"
                      icon={Ellipsis}
                      label={t("shell.card.more")}
                      onPress={() =>
                        editor.openActions(
                          name,
                          [
                            { id: "rename", label: t("shell.playlists.rename"), icon: Pencil, onSelect: () => editor.renamePlaylist(playlist), testID: "playlist-menu-rename" },
                            {
                              id: "delete",
                              label: t("shell.playlists.delete"),
                              icon: Trash2,
                              destructive: true,
                              onSelect: () => editor.deletePlaylist(playlist, () => navigation.goBack()),
                              testID: "playlist-menu-delete",
                            },
                          ],
                          "playlist-menu"
                        )
                      }
                    />
                  )}
                </>
              }
            />
            <KeptLine kind="playlist" id={playlistId} kept={kept} />
            {error ? <ErrorText>{error}</ErrorText> : null}
          </>
        }
        ListEmptyComponent={
          songs.loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Body muted>{liked ? t("parrot.playlists.likedEmpty") : t("shell.playlists.emptyPlaylist")}</Body>
          )
        }
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
            onPress={() => void play(list, index)}
            onMore={() => editor.openSong({ id: item.id, title: item.title }, { playlistId, position: index }, { onAddToQueue: () => queue([item], "end") })}
            moreLabel={`${t("parrot.player.more")}, ${item.title}`}
          />
        ))}
      />
      <PageBackButton onPress={() => navigation.goBack()} />
    </ParrotSky>
  );
};

const styles = StyleSheet.create({ list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.xs } });
