// One song in a list (an album's songs, the library's Songs view, a playlist). The song that plays is marked as in the
// approved design (PAR-LOOK-01): its title turns green and the equaliser takes the place of its track number. Its
// "more" button (or a long press) opens the song sheet: heart, add to playlist, remove (PAR-PL-02/04).
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ellipsis } from "lucide-react-native";
import { formatDuration } from "@space/parrot-core";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { colors, spacing } from "../theme";
import { ParrotEqualizer } from "./equalizer";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStack } from "./routes";

/** A name on a song's line under its title; `onPress` opens its page (PAR-NAV-05). */
export type SongRowName = { text: string; onPress?: () => void; testID?: string };

/** A song's artist and album as names that open the artist's and the album's pages (PAR-NAV-05). */
export const songRowNames = (
  song: { artistName: string; artistId?: string | null; albumTitle: string; albumId: string },
  navigation: Pick<NativeStackNavigationProp<RootStack>, "navigate">,
): SongRowName[] => [
  ...(song.artistName
    ? [{ text: song.artistName, testID: "song-artist-link", onPress: song.artistId ? () => navigation.navigate("Artist", { artistId: song.artistId!, name: song.artistName }) : undefined }]
    : []),
  ...(song.albumTitle
    ? [{ text: song.albumTitle, testID: "song-album-link", onPress: () => navigation.navigate("Album", { albumId: song.albumId, title: song.albumTitle, artistName: song.artistName }) }]
    : []),
];

export const SongListRow = ({
  lead,
  title,
  subtitle,
  names,
  durationMs,
  playing,
  starting,
  disabled,
  unavailable = false,
  accessibilityLabel,
  onPress,
  onMore,
  moreLabel,
}: {
  /** The track number, or the album art in the library's Songs view. */
  lead: React.ReactNode;
  title: string;
  subtitle?: string | null;
  /** The line under the title as the artist's and album's names, each opening its page; used instead of `subtitle`. */
  names?: readonly SongRowName[];
  durationMs: number | null;
  /** Set on the song that plays; `animated` while the music is not paused. */
  playing: { animated: boolean } | null;
  starting: boolean;
  disabled: boolean;
  /** While the phone is offline: a song not on it, greyed out and not played (PAR-OFFL-04). Its "more" sheet stays. */
  unavailable?: boolean;
  accessibilityLabel: string;
  onPress: () => void;
  /** Opens the song sheet; the row then has its "more" button. */
  onMore?: () => void;
  moreLabel?: string;
}) => (
  <Pressable
    testID={playing ? "song-row-playing" : "song-row"}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ selected: !!playing, disabled: unavailable }}
    disabled={disabled || unavailable}
    onPress={onPress}
    onLongPress={onMore}
    style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
  >
    <View testID="song-row-content" style={[styles.content, unavailable && UNAVAILABLE_LOOK]}>
      <View style={styles.lead}>{playing ? <ParrotEqualizer animated={playing.animated} /> : typeof lead === "string" || typeof lead === "number" ? <Text style={styles.number}>{lead}</Text> : lead}</View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, playing && styles.playingTitle]} numberOfLines={1}>
          {title}
        </Text>
        {names && names.length > 0 ? (
          <Text style={styles.meta} numberOfLines={1}>
            {names.map((name, index) => (
              <React.Fragment key={index}>
                {index > 0 ? " · " : ""}
                <Text testID={name.testID} onPress={name.onPress} accessibilityRole={name.onPress ? "link" : undefined} suppressHighlighting>
                  {name.text}
                </Text>
              </React.Fragment>
            ))}
          </Text>
        ) : subtitle ? (
          <Text style={styles.meta} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {starting ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.meta}>{formatDuration(durationMs)}</Text>}
    </View>
    {onMore ? (
      <Pressable testID="song-more" accessibilityRole="button" accessibilityLabel={moreLabel} hitSlop={8} onPress={onMore} style={({ pressed }) => [styles.more, pressed && { opacity: 0.6 }]}>
        <Ellipsis size={20} color={colors.textMuted} />
      </Pressable>
    ) : null}
  </Pressable>
);

/**
 * A song of the album the user does not have (PAR-LIB-05): greyed like Badger's missing episodes, its number, title,
 * a short note and its length; nothing to press, it never plays.
 */
export const MissingSongRow = ({ number, title, note, durationMs }: { number: number; title: string; note: string; durationMs: number | null }) => (
  <View testID="song-row-missing" accessibilityState={{ disabled: true }} accessibilityLabel={`${title}, ${note}`} style={[styles.row, styles.missing]}>
    <View style={styles.lead}>
      <Text style={styles.number}>{number}</Text>
    </View>
    <View style={{ flex: 1 }}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {note}
      </Text>
    </View>
    <Text style={styles.meta}>{formatDuration(durationMs)}</Text>
  </View>
);

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, paddingHorizontal: spacing.sm, minHeight: 48 },
  content: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md },
  more: { width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: -spacing.xs },
  missing: { opacity: 0.4 },
  lead: { minWidth: 28, alignItems: "flex-end", justifyContent: "center" },
  number: { color: colors.textMuted, textAlign: "right", fontVariant: ["tabular-nums"] },
  title: { color: colors.text, fontSize: 16 },
  playingTitle: { color: colors.accent, fontWeight: "700" },
  meta: { color: colors.textMuted, fontSize: 13, fontVariant: ["tabular-nums"] },
});
