// The Lyrics sheet of the phone's full player (PAR-PLAY-06, PAR-LYR-01/04/05/06/08/10), drawn like the desktop's Lyrics
// tab (`ParrotLyricsPane`, @space/ui): synced lines light up as they are sung (the line sung now big and green, the
// ones sung dim, the next ones half bright) and the list scrolls to keep it in view; a tap on a line plays from there.
// Plain lyrics show as written. What shows ("Looking for lyrics…", "No lyrics", "Search again") is `useTrackLyrics`,
// shared with the TV's lyrics; the LRC reading, the "which line is sung now" rule, the lookup and the saved op are the
// shared ones of @space/parrot-core; only the drawing is the phone's. Under the words, "Add lyrics" / "Edit lyrics"
// opens the editor (PAR-LYR-10) and "Remove my lyrics" takes the user's own away (PAR-LYR-11).
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { Mic, Pencil, Trash2 } from "lucide-react-native";
import { AudioPlayback } from "@space/mobile-audio-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { activeLyricIndex, type ParrotLyrics, type ParrotOwnLyrics } from "@space/parrot-core";
import { lyricsNoneText, lyricsSourceKey, useTrackLyrics, type TrackLyricsView } from "../state/useTrackLyrics";
import { colors, spacing } from "../theme";
import { LyricsEditor } from "./LyricsEditor";

/** The song the editor was opened for: it stays on that song, and saves to it, when the next song starts. */
type EditedSong = { title: string; lyrics: ParrotLyrics | null; save: (lyrics: ParrotOwnLyrics) => Promise<void> };

export const PlayerLyrics = ({ trackId, title, positionMs, playing }: { trackId: string; title: string; positionMs: number; playing: boolean }) => {
  const { t } = useTranslation();
  const { view, lyrics, searchAgain, saveOwn } = useTrackLyrics(trackId);
  const [editing, setEditing] = useState<EditedSong | null>(null);
  const [removeFailed, setRemoveFailed] = useState(false);

  // The editor stays mounted while another song's lyrics are read, so the user's words are never lost.
  const editor = (
    <LyricsEditor
      open={editing !== null}
      title={editing?.title ?? title}
      lyrics={editing?.lyrics ?? null}
      playing={playing}
      onClose={() => setEditing(null)}
      onSave={editing?.save ?? saveOwn}
    />
  );
  if (view.kind === "reading") {
    return (
      <>
        <ActivityIndicator color={colors.textMuted} style={{ marginVertical: spacing.xl }} />
        {editor}
      </>
    );
  }
  const hasWords = view.kind === "synced" || view.kind === "plain";
  const own = (
    <>
      <View style={styles.ownRow}>
        <Pressable
          testID={hasWords ? "lyrics-edit" : "lyrics-add"}
          accessibilityRole="button"
          onPress={() => setEditing({ title, lyrics, save: saveOwn })}
          style={({ pressed }) => [styles.ownButton, pressed && { opacity: 0.6 }]}
        >
          <Pencil size={14} color={colors.text} />
          <Text style={styles.ownText}>{hasWords ? t("shell.lyrics.edit") : t("shell.lyrics.add")}</Text>
        </Pressable>
        {hasWords && view.own && (
          <Pressable
            testID="lyrics-remove"
            accessibilityRole="button"
            onPress={() => {
              setRemoveFailed(false);
              saveOwn(null).catch(() => setRemoveFailed(true));
            }}
            style={({ pressed }) => [styles.ownButton, styles.ownButtonQuiet, pressed && { opacity: 0.6 }]}
          >
            <Trash2 size={14} color={colors.textMuted} />
            <Text style={[styles.ownText, { color: colors.textMuted }]}>{t("shell.lyrics.remove")}</Text>
          </Pressable>
        )}
      </View>
      {removeFailed && <Text style={styles.problem}>{t("shell.lyricsEditor.saveFailed")}</Text>}
    </>
  );
  return (
    <>
      <LyricsWords view={view} positionMs={positionMs} searchAgain={searchAgain} own={own} />
      {/* One editor for every view: a save that turns "No lyrics" into words keeps the same dialog until it closes. */}
      {editor}
    </>
  );
};

/** The words, or what stands in for them, with the user's own lyrics controls (`own`) under them. */
const LyricsWords = ({
  view,
  positionMs,
  searchAgain,
  own,
}: {
  view: Exclude<TrackLyricsView, { kind: "reading" }>;
  positionMs: number;
  searchAgain: () => void;
  own: React.ReactNode;
}) => {
  const { t } = useTranslation();
  if (view.kind === "synced") {
    return (
      <View style={{ gap: spacing.md }}>
        <SyncedLines lines={view.lines} positionMs={positionMs} />
        <Text style={styles.source}>{t(lyricsSourceKey(view))}</Text>
        {own}
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
        {own}
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
        {own}
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
      {own}
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
  ownRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  ownButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ownButtonQuiet: { borderColor: "transparent" },
  ownText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  problem: { color: colors.danger, fontSize: 14 },
});
