// Settings → Manage offline content (OFFL-MANAGE-01): everything saved offline on this phone as artists › albums › songs
// (a song saved on its own sits under its artist and album too), then playlists › songs, each row with the space its
// songs take and a bin, and Remove all; the phones' shared screen. A bin removes the row's songs (`removeKeptRow`): from
// the library's kept albums and songs, or, under a playlist, from that playlist only; an album's, artist's or playlist's
// bin stops keeping those items outright. A file another kept item still holds stays. The kept songs are the keeping
// loop's (`keptSongs`), the sizes the download engine's
// (`listItems`), the names and covers the open library's.
import React, { useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { Heart, ListMusic } from "lucide-react-native";
import { MobileOfflineContent } from "@space/mobile-shell/offline-content";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import {
  groupParrotOfflineTree,
  type OfflineManageRow,
  type ParrotOfflineAlbum,
  type ParrotOfflineSong,
} from "@space/shared/offlineManage";
import { nativeListItems } from "@space/mobile-media-proxy/downloads";
import { parrotCoverThumbKey } from "@space/parrot-core";
import { keptSongs, removeKeptRow, unkeepAll } from "../lib/kept";
import { listAlbums, listArtists, listPlaylists, listSongs } from "../lib/library";
import { isLikedPlaylist } from "../lib/playlists";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { colors } from "../theme";
import { ParrotArt } from "./art";
import { useKept } from "./kept";
import type { RootStack } from "./routes";

const log = scopeLogger("offline-content");

type SongInfo = Omit<ParrotOfflineSong, "fileId">;

export const OfflineContentScreen = ({ navigation }: NativeStackScreenProps<RootStack, "OfflineContent">) => {
  const { status } = useKept();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const { t } = useTranslation();
  // The names and covers: read once per library load.
  const names = useQuery(async () => {
    const empty = { songs: new Map<string, SongInfo>(), albums: new Map<string, ParrotOfflineAlbum>(), playlists: new Map<string, string>(), artists: new Map<string, string>() };
    if (library.status !== "ready") return empty;
    const [albums, playlists, songs, artists] = await Promise.all([listAlbums(), listPlaylists(), listSongs(), listArtists()]);
    for (const album of albums) {
      empty.albums.set(album.id, { title: album.title, artistId: album.artistId ?? null, artistName: album.artistName, imagePath: parrotCoverThumbKey(album) });
    }
    for (const playlist of playlists) empty.playlists.set(playlist.id, isLikedPlaylist(playlist.id) ? t("shell.playlists.liked") : playlist.name);
    for (const song of songs) {
      empty.songs.set(song.id, {
        trackId: song.id,
        title: song.title,
        albumId: song.albumId,
        artistId: song.artistId || null,
        artistName: song.artistName,
        disc: song.disc,
        number: song.number,
      });
    }
    for (const artist of artists) {
      const picture = artist.pictureThumbObjectKey ?? artist.pictureObjectKey;
      if (picture) empty.artists.set(artist.id, picture);
    }
    return empty;
  }, [version, t]);
  // The sizes on disk: read again whenever the kept list changes (a song finishing its download included).
  const sizes = useQuery(() => nativeListItems(), [status]);

  const list = useMemo(() => {
    if (!sizes.answered && !sizes.data) return null;
    const bytes = new Map((sizes.data?.items ?? []).map((item) => [item.itemId, item.bytes]));
    const songOf = (song: { trackId: string; fileId: string }): ParrotOfflineSong => ({
      title: null,
      albumId: null,
      artistId: null,
      artistName: null,
      ...names.data?.songs.get(song.trackId),
      trackId: song.trackId,
      fileId: song.fileId,
    });
    const items = keptSongs();
    const grouped = groupParrotOfflineTree({
      songs: items.filter((item) => item.kind !== "playlist").flatMap((item) => item.songs.map(songOf)),
      playlists: items
        .filter((item) => item.kind === "playlist")
        .map((item) => ({ id: item.id, title: names.data?.playlists.get(item.id) ?? null, songs: item.songs.map(songOf) })),
      albumOf: (albumId) => names.data?.albums.get(albumId) ?? null,
      artistImageOf: (artistId) => names.data?.artists.get(artistId) ?? null,
      bytesOf: (fileId) => bytes.get(fileId) ?? 0,
    });
    log.info("listed", { items: items.length, rows: grouped.rows.length, totalBytes: grouped.totalBytes });
    return grouped;
  }, [names.data, sizes.answered, sizes.data]);

  const onRemove = useCallback(async (row: OfflineManageRow) => {
    log.info("remove", { key: row.key, kind: row.kind, playlistId: row.playlistId ?? null });
    await removeKeptRow(row);
  }, []);
  const onRemoveAll = useCallback(async () => {
    log.info("removeAll");
    await unkeepAll();
  }, []);
  // A playlist has no cover: it wears the same icon tile as on the Playlists tab, so every top-level row lines up.
  const renderArtwork = useCallback((row: OfflineManageRow, size: number) => {
    if (row.kind !== "playlist") return <ParrotArt seed={row.id || row.key} size={size} radius={row.kind === "artist" ? size / 2 : 6} coverKey={row.imagePath} />;
    const liked = isLikedPlaylist(row.id);
    return (
      <View testID="offline-playlist-art" style={[styles.playlistArt, liked && styles.likedArt]}>
        {liked ? <Heart size={size / 2} color={colors.accentText} fill={colors.accentText} /> : <ListMusic size={size / 2} color={colors.accent} />}
      </View>
    );
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <MobileOfflineContent
        app="parrot"
        list={list}
        onRemove={onRemove}
        onRemoveAll={onRemoveAll}
        onBack={() => navigation.goBack()}
        renderArtwork={renderArtwork}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  playlistArt: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceRaised },
  likedArt: { backgroundColor: colors.accent },
});
