// The artist page's Albums tab (PAR-LOOK-06): every release down a timeline, newest first, the year on the rail, each
// release with its own Play. A row of years jumps down the timeline when there are many. One album or thirty both read
// as a list, never a half-empty grid; a short discography (one or two releases) lists its songs under the timeline.
import React, { useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Play } from "lucide-react-native";
import { formatDuration, parrotCoverThumbKey } from "@space/parrot-core";
import { colors, spacing } from "../../theme";
import { ParrotArt } from "../art";
import { SectionTitle, SongRows } from "./pieces";
import { totalDuration, type ArtistPage } from "./useArtistPage";

/** Shown once a discography is long enough to need a way down it. */
export const YEAR_JUMP_FROM = 8;
/** A discography this short leaves the tab bare, so its songs follow the timeline. */
export const SONGS_BELOW_UPTO = 2;

/** `onJump` gets how far down this block a year starts, for the page to scroll there. */
export const Discography = ({ page, onJump }: { page: ArtistPage; onJump: (y: number) => void }) => {
  const { t } = page;
  const yearAt = useRef(new Map<number, number>());
  const railTop = useRef(0);
  const newestFirst = [...page.albums].reverse();
  const years = [...new Set(newestFirst.map((album) => album.year).filter((year): year is number => !!year))];
  return (
    <View testID="artist-discography">
      <SectionTitle right={t("parrot.library.albums", { count: page.albums.length })}>{t("parrot.artist.discography")}</SectionTitle>
      {page.albums.length >= YEAR_JUMP_FROM && years.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.years} testID="artist-years">
          {years.map((year) => (
            <Pressable
              key={year}
              testID="artist-year"
              accessibilityRole="button"
              onPress={() => onJump(railTop.current + (yearAt.current.get(year) ?? 0))}
              style={({ pressed }) => [styles.year, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.yearText}>{year}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.rail} onLayout={(event) => (railTop.current = event.nativeEvent.layout.y)}>
        {newestFirst.map((album, index) => {
          const songs = page.songs.filter((song) => song.albumId === album.id);
          const kind = album.kind === "single" ? t("parrot.artist.single") : album.kind === "ep" ? t("parrot.artist.ep") : t("parrot.artist.album");
          const ms = songs.reduce((sum, song) => sum + (song.durationMs ?? 0), 0);
          const firstOfYear = index === 0 || newestFirst[index - 1]!.year !== album.year;
          const unavailable = page.reach ? !page.reach.album(album.id) : false;
          return (
            <View
              key={album.id}
              style={styles.release}
              onLayout={firstOfYear && album.year ? (event) => yearAt.current.set(album.year!, event.nativeEvent.layout.y) : undefined}
            >
              <View style={styles.railColumn}>
                <Text style={styles.railYear}>{firstOfYear ? (album.year ?? "") : ""}</Text>
                <View style={[styles.railLine, index === newestFirst.length - 1 && { opacity: 0 }]} />
              </View>
              <Pressable
                testID="artist-release"
                accessibilityRole="button"
                accessibilityLabel={`${album.title}, ${album.year ?? ""}`}
                disabled={unavailable}
                onPress={() => page.openAlbum(album)}
                style={({ pressed }) => [styles.releaseBody, unavailable && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
              >
                <ParrotArt seed={album.id} size={index === 0 ? 112 : 72} radius={10} coverKey={parrotCoverThumbKey(album)} playing={page.now?.albumId === album.id} />
                <View style={{ flex: 1, gap: 3 }}>
                  {index === 0 ? <Text style={styles.newest}>{t("parrot.artist.latestRelease").toUpperCase()}</Text> : null}
                  <Text style={[styles.releaseTitle, index === 0 && { fontSize: 18 }]} numberOfLines={2}>
                    {album.title}
                  </Text>
                  <Text style={styles.releaseMeta} numberOfLines={2}>
                    {[kind, t("parrot.library.songs", { count: album.trackCount }), ms > 0 ? (ms < 3600000 ? formatDuration(ms) : totalDuration(ms, t)) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <Pressable
                  testID="artist-release-play"
                  accessibilityRole="button"
                  accessibilityLabel={t("parrot.album.play", { title: album.title })}
                  disabled={songs.length === 0 || unavailable}
                  onPress={() => page.playFrom(songs, 0)}
                  hitSlop={8}
                  style={({ pressed }) => [styles.releasePlay, pressed && { opacity: 0.6 }]}
                >
                  <Play size={16} color={colors.accent} fill={colors.accent} />
                </Pressable>
              </Pressable>
            </View>
          );
        })}
      </View>
      {page.albums.length > 0 && page.albums.length <= SONGS_BELOW_UPTO ? (
        <View style={{ marginTop: spacing.lg, gap: spacing.sm }} testID="artist-discography-songs">
          <SectionTitle right={t("parrot.library.songs", { count: page.songs.length })}>{t("parrot.artist.allSongs")}</SectionTitle>
          <SongRows list={page.songs} page={page} withCover={page.albums.length > 1} />
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  years: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  year: { paddingHorizontal: 12, height: 30, borderRadius: 15, borderWidth: 1, borderColor: colors.border, justifyContent: "center" },
  yearText: { color: colors.text, fontSize: 13, fontWeight: "700" },
  rail: { paddingTop: spacing.md, paddingRight: spacing.lg },
  release: { flexDirection: "row" },
  railColumn: { width: 56, alignItems: "center" },
  railYear: { color: colors.accent, fontSize: 12, fontWeight: "800", minHeight: 18, marginTop: spacing.sm },
  railLine: { flex: 1, width: 2, borderRadius: 1, backgroundColor: colors.border, marginTop: 4 },
  releaseBody: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  newest: { color: colors.accent, fontSize: 10.5, letterSpacing: 1.2, fontWeight: "900" },
  releaseTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  releaseMeta: { color: colors.textMuted, fontSize: 12.5 },
  releasePlay: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
});
