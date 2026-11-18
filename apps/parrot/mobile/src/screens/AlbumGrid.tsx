// Albums as a two-column grid of their art (PAR-LOOK-01): the library's Albums view and an artist's albums. The album
// that plays is ringed in green and carries the bouncing equaliser badge (the mockup's Low Orbit tile).
import React, { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { parrotCoverThumbKey, type AlbumRow, type ParrotCoverKeys } from "@space/parrot-core";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { guardRenderItem } from "@space/mobile-shell/render-boundary";
import { useNowPlaying } from "../state/usePlayerState";
import { colors, spacing } from "../theme";
import { ParrotArt } from "./art";
import { PlayingBadge } from "./equalizer";
import { Body } from "./ui";
import type { RootStack } from "./routes";

/** An album row with the picture embedded in its music files, when the library has one. */
export type GridAlbum = AlbumRow & Partial<ParrotCoverKeys>;

const coverKeysOf = (album: GridAlbum): ParrotCoverKeys => ({
  coverObjectKey: album.coverObjectKey ?? null,
  coverThumbObjectKey: album.coverThumbObjectKey ?? null,
});

export const AlbumGrid = ({
  albums,
  loading,
  empty,
  header,
  onRefresh,
  unavailable,
  top = spacing.lg,
}: {
  albums: GridAlbum[];
  loading: boolean;
  empty: string;
  header?: React.ReactElement;
  onRefresh?: () => void;
  /** While the phone is offline: the albums with no song on it, greyed out and not opened (PAR-OFFL-04). */
  unavailable?: (album: GridAlbum) => boolean;
  /** Where the first row starts: a pushed page leaves room for its floating back button (`usePageTop`). */
  top?: number;
}) => {
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const now = useNowPlaying();
  const [width, setWidth] = useState(0);
  const skyScroll = useSkyScroll();
  const tile = Math.max(0, Math.floor((width - spacing.lg * 3) / 2));
  return (
    // Measured on a wrapper: the list's own onLayout also fires for its header row (16 dp in, 32 dp narrower), and the
    // tiles took that width, leaving a wide gap on the right.
    <View style={styles.fill} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <FlatList
        {...skyScroll}
        contentContainerStyle={{ padding: spacing.lg, paddingTop: top, gap: spacing.lg }}
        columnWrapperStyle={{ gap: spacing.lg }}
        numColumns={2}
        data={albums}
        keyExtractor={(album) => album.id}
        onRefresh={onRefresh}
        refreshing={false}
        ListHeaderComponent={header}
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.accent} /> : <Body muted>{empty}</Body>}
        renderItem={guardRenderItem("album-tile", ({ item }) => (
          <SkyCover>
            <AlbumTile
            album={item}
            size={tile}
            unavailable={unavailable?.(item) ?? false}
            playing={now?.albumId === item.id ? { animated: now.playing } : null}
            onPress={() =>
              navigation.navigate("Album", { albumId: item.id, title: item.title, artistName: item.artistName, cover: coverKeysOf(item) })
            }
            />
          </SkyCover>
        ), { width: tile, height: tile, margin: 0 })}
      />
    </View>
  );
};

export const AlbumTile = ({
  album,
  size,
  playing,
  unavailable = false,
  onPress,
}: {
  album: GridAlbum;
  size: number;
  /** Set on the album that plays; `animated` while the music is not paused. */
  playing: { animated: boolean } | null;
  unavailable?: boolean;
  onPress: () => void;
}) => (
  <Pressable
    testID="album-tile"
    accessibilityRole="button"
    accessibilityLabel={`${album.title}, ${album.artistName}`}
    accessibilityState={{ disabled: unavailable }}
    disabled={unavailable}
    onPress={onPress}
    style={({ pressed }) => [{ width: size }, pressed && { opacity: 0.7 }]}
  >
    <View testID="album-tile-content" style={unavailable ? UNAVAILABLE_LOOK : undefined}>
    <View>
      <ParrotArt
        seed={album.id}
        size={size}
        radius={14}
        label={album.title}
        playing={!!playing}
        coverKey={parrotCoverThumbKey(coverKeysOf(album))}
      />
      {playing ? <PlayingBadge size={size} animated={playing.animated} /> : null}
    </View>
    <Text style={styles.title} numberOfLines={1}>
      {album.title}
    </Text>
    <Text style={styles.meta} numberOfLines={1}>
      {[album.artistName, album.year].filter(Boolean).join(" · ")}
    </Text>
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  title: { color: colors.text, fontSize: 14, fontWeight: "700", marginTop: spacing.sm },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});
