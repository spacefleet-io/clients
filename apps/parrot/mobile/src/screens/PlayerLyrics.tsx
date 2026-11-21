// The Lyrics sheet of the phone's full player (PAR-PLAY-06, PAR-LYR-01/04/05/06), drawn like the desktop's Lyrics tab
// (`ParrotLyricsPane`, @space/ui): synced lines light up as they are sung (the line sung now big and green, the ones
// sung dim, the next ones half bright) and the list scrolls to keep it in view; a tap on a line plays from there.
// Plain lyrics show as written. What shows ("Looking for lyrics…", "No lyrics", "Search again") is `useTrackLyrics`,
// shared with the TV's lyrics; the LRC reading, the "which line is sung now" rule, the lookup and the saved op are the
// shared ones of @space/parrot-core; only the drawing is the phone's.
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { Mic } from "lucide-react-native";
import { AudioPlayback } from "@space/mobile-audio-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { activeLyricIndex, type ParrotLyrics } from "@space/parrot-core";
import { lyricsNoneText, lyricsSourceKey, useTrackLyrics } from "../state/useTrackLyrics";
import { colors, spacing } from "../theme";

export const PlayerLyrics = ({ trackId, positionMs }: { trackId: string; positionMs: number }) => {
  const { t } = useTranslation();
  const { view, searchAgain } = useTrackLyrics(trackId);

  if (view.kind === "reading") {
    return <ActivityIndicator color={colors.textMuted} style={{ marginVertical: spacing.xl }} />;
  }
  if (view.kind === "synced") {
    return (
      <View style={{ gap: spacing.md }}>
        <SyncedLines lines={view.lines} positionMs={positionMs} />
        <Text style={styles.source}>{t(lyricsSourceKey(view))}</Text>
      </View>
    );
  }
  if (view.kind === "plain") {
    return (
      <View style={{ gap: spacing.md }}>
        {/* UX-SHEET-01: scrolled to its top, a drag down closes the lyrics sheet. */}
        <MobileSheetScrollView style={styles.scroll} testID="lyrics-plain">
          <Text style={styles.plain}>{view.text}</Text>
        </MobileSheetScrollView>
        <Text style={styles.source}>{t(lyricsSourceKey(view))}</Text>
      </View>
    );
  }
  if (view.kind === "searching") {
    return (
      <View style={{ gap: spacing.sm }} testID="lyrics-searching" accessibilityRole="progressbar" accessibilityLiveRegion="polite">
        <View style={styles.searchingTitle}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={styles.noneTitle}>{t("shell.nowPlaying.searchingLyricsTitle")}</Text>
        </View>
        <Text style={styles.meta} testID="lyrics-fetch-message">
          {t("shell.nowPlaying.searchingLyricsBody")}
        </Text>
      </View>
    );
  }
  const text = lyricsNoneText(view);
  return (
    <View style={{ gap: spacing.sm }} testID="lyrics-none">
      <Text style={styles.noneTitle}>{t(text.title)}</Text>
      <Text style={styles.meta} testID="lyrics-fetch-message">
        {t(text.body)}
      </Text>
      {view.searchAgain && (
        <Pressable testID="lyrics-fetch" accessibilityRole="button" onPress={searchAgain} style={({ pressed }) => [styles.fetch, pressed && { opacity: 0.6 }]}>
          <Mic size={16} color={colors.accentText} />
          <Text style={styles.fetchText}>{t("shell.nowPlaying.fetchLyrics")}</Text>
        </Pressable>
      )}
    </View>
  );
};

/** Synced lines, the one sung now kept in view; a tap plays from a line's start. */
const SyncedLines = ({ lines, positionMs }: { lines: NonNullable<ParrotLyrics["synced"]>; positionMs: number }) => {
  const active = activeLyricIndex(lines, positionMs);
  const scroll = useRef<ScrollViewInstance | null>(null);
  const offsets = useRef<number[]>([]);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const y = offsets.current[Math.max(0, active)];
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - height / 3), animated: true });
  }, [active, height]);
  return (
    <MobileSheetScrollView ref={scroll} style={styles.scroll} testID="lyrics-synced" onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
      {lines.map((line, index) => {
        const state = index === active ? "now" : index < active ? "past" : "next";
        return (
          <Pressable
            key={`${line.ms}-${index}`}
            testID={state === "now" ? "lyrics-line-now" : "lyrics-line"}
            accessibilityRole="button"
            accessibilityState={{ selected: state === "now" }}
            onLayout={(event) => {
              offsets.current[index] = event.nativeEvent.layout.y;
            }}
            onPress={() => void AudioPlayback.seekTo(line.ms)}
            style={styles.line}
          >
            <Text style={[styles.lineText, state === "now" ? styles.lineNow : state === "past" ? styles.linePast : styles.lineNext]}>{line.text || "♪"}</Text>
          </Pressable>
        );
      })}
    </MobileSheetScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: { maxHeight: 420 },
  line: { paddingVertical: spacing.xs },
  lineText: { fontWeight: "800", color: colors.text },
  lineNow: { fontSize: 26, color: colors.accent },
  linePast: { fontSize: 22, opacity: 0.3 },
  lineNext: { fontSize: 22, opacity: 0.55 },
  plain: { color: colors.text, opacity: 0.8, fontSize: 18, fontWeight: "600", lineHeight: 28 },
  source: { color: colors.textMuted, fontSize: 12 },
  noneTitle: { color: colors.textMuted, fontSize: 24, fontWeight: "800" },
  searchingTitle: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  meta: { color: colors.textMuted, fontSize: 15 },
  fetch: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.sm,
    marginTop: spacing.md,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: 22,
    backgroundColor: colors.accent,
  },
  fetchText: { color: colors.accentText, fontSize: 15, fontWeight: "700" },
});
