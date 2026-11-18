// The Playlists tab: "Liked songs" first, then the others by name, under a "New playlist" row (PAR-PL-02, PAR-NAV-02),
// with no page title: the tab bar names the page (PAR-NAV-04).
// A new playlist opens at once, ready for songs. While the phone is offline, a playlist with no song on it is greyed
// out and does not open (PAR-OFFL-04).
import React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Heart, ListMusic, Plus } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { guardRenderItem } from "@space/mobile-shell/render-boundary";
import { useSession } from "../state/session";
import { usePlaylistEditor } from "../state/playlistEditor";
import { useQuery } from "../state/useQuery";
import { listPlaylists } from "../lib/library";
import type { ParrotPlaylist } from "@space/parrot-core";
import { isLikedPlaylist } from "../lib/playlists";
import { colors, spacing } from "../theme";
import { useOfflineReach } from "./kept";
import { Body } from "./ui";
import type { RootStack } from "./routes";

/** A playlist's name as shown: "Liked songs" in the app's language, the others as the user named them. */
export const usePlaylistName = () => {
  const { t } = useTranslation();
  return (playlist: Pick<ParrotPlaylist, "id" | "name">) => (isLikedPlaylist(playlist.id) ? t("shell.playlists.liked") : playlist.name);
};

export const PlaylistsView = () => {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const { library, localChanges, reloadLibrary } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  // A change shows at once: written into the open library, read again here before the server has it (PAR-PL-03).
  const playlists = useQuery(() => (library.status === "ready" ? listPlaylists() : Promise.resolve([])), [version, localChanges]);
  const nameOf = usePlaylistName();
  const skyScroll = useSkyScroll();
  const editor = usePlaylistEditor();
  const reach = useOfflineReach();
  const rows = playlists.data ?? [];
  const onlyLiked = rows.length <= 1;
  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={rows}
      keyExtractor={(playlist) => playlist.id}
      onRefresh={() => void reloadLibrary()}
      refreshing={false}
      {...skyScroll}
      ListHeaderComponent={
        <View>
          <Pressable
            testID="playlist-new"
            accessibilityRole="button"
            accessibilityLabel={t("shell.playlists.new")}
            onPress={() => editor.newPlaylist((playlistId, name) => navigation.navigate("Playlist", { playlistId, name }))}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          >
            <View style={[styles.art, styles.newArt]}>
              <Plus size={24} color={colors.accent} />
            </View>
            <Text style={styles.name}>{t("shell.playlists.new")}</Text>
          </Pressable>
        </View>
      }
      ListEmptyComponent={playlists.loading ? <ActivityIndicator color={colors.accent} /> : undefined}
      ListFooterComponent={!playlists.loading && onlyLiked ? <Body muted>{t("shell.playlists.empty")}</Body> : undefined}
      ListFooterComponentStyle={styles.footer}
      renderItem={guardRenderItem("playlist-row", ({ item }) => {
        const liked = isLikedPlaylist(item.id);
        const name = nameOf(item);
        const count = t("parrot.library.songs", { count: item.trackCount });
        const unavailable = reach ? !reach.playlist(item.trackIds) : false;
        return (
          <Pressable
            testID={liked ? "playlist-liked" : "playlist-row"}
            accessibilityRole="button"
            accessibilityLabel={`${name}, ${count}`}
            accessibilityState={{ disabled: unavailable }}
            disabled={unavailable}
            onPress={() => navigation.navigate("Playlist", { playlistId: item.id, name })}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          >
            <View testID="playlist-row-content" style={[styles.rowContent, unavailable && UNAVAILABLE_LOOK]}>
            <SkyCover style={[styles.art, liked && styles.likedArt]}>
              {liked ? <Heart size={24} color={colors.accentText} fill={colors.accentText} /> : <ListMusic size={24} color={colors.accent} />}
            </SkyCover>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles.count}>{count}</Text>
            </View>
            </View>
          </Pressable>
        );
      })}
    />
  );
};

const styles = StyleSheet.create({
  list: { paddingTop: spacing.md, paddingBottom: spacing.xl, gap: spacing.xs },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minHeight: 68 },
  rowContent: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md },
  art: { width: 52, height: 52, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceRaised },
  likedArt: { backgroundColor: colors.accent },
  newArt: { backgroundColor: "transparent", borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.border },
  name: { color: colors.text, fontSize: 16, fontWeight: "700" },
  count: { color: colors.textMuted, fontSize: 13 },
});
