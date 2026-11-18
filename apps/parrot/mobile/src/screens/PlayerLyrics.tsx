// The Lyrics sheet of the phone's full player (PAR-PLAY-06, PAR-LYR-01/04/05/06), drawn like the desktop's Lyrics tab
// (`ParrotLyricsPane`, @space/ui): synced lines light up as they are sung (the line sung now big and green, the ones
// sung dim, the next ones half bright) and the list scrolls to keep it in view; a tap on a line plays from there.
// Plain lyrics show as written. While a lookup for the song is queued or running (the automatic pass, or "Search
// again"), it says "Looking for lyrics…" with a spinner, never "No lyrics" (PAR-LYR-06). A song never looked up is handed
// to the automatic pass as soon as the sheet shows it (PAR-LYR-05), which asks it next, so it too says "Looking for
// lyrics…"; the sheet never asks the metadata service on its own (PAR-COPY-01), only on "Search again". "Search again"
// shows only once a lookup came back empty or failed, never while one is on its way (Chris 2026-11-16). The LRC reading,
// the "which line is sung now" rule, the lookup and the saved op are the shared ones of @space/parrot-core; only the
// drawing is the phone's.
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { Mic } from "lucide-react-native";
import { AudioPlayback } from "@space/mobile-audio-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { activeLyricIndex, type ParrotLyrics } from "@space/parrot-core";
import { fetchTrackLyrics, lyricsPending, readTrackLyrics } from "../lib/library";
import { lookupClient } from "../lib/lookup";
import { useSession } from "../state/session";
import { colors, spacing } from "../theme";

type FetchState = "idle" | "busy" | "none" | "failed";
/** One moment the automatic pass let go of a song (its identity tells reads begun before it from those after). */
type Settled = { trackId: string };

const log = (event: string, payload: Record<string, unknown>) => console.log(`parrot.lyrics ${event} ${JSON.stringify(payload)}`);

export const PlayerLyrics = ({ trackId, positionMs }: { trackId: string; positionMs: number }) => {
  const { t } = useTranslation();
  // A new library version (e.g. the automatic lookup found this song's words, PAR-LYR-01) is read again.
  const { library, wantLyrics } = useSession();
  const libraryVersion = library.version;
  // Lyrics and the fetch state belong to one song: another song starts from its own.
  // `after`: the end of a lookup this read started after (null: none yet), so a read begun before it is known stale.
  // `readFailed`: the library could not be read, so a missing row does not mean "never looked up".
  const [lyrics, setLyrics] = useState<{ trackId: string; lyrics: ParrotLyrics | null; after: Settled | null; readFailed?: boolean } | null>(null);
  // The songs this sheet already handed to the automatic pass on its own: each is handed once.
  const askedOnOpen = useRef(new Set<string>());
  const [fetchState, setFetchState] = useState<{ trackId: string; state: FetchState } | null>(null);
  // PAR-LYR-06: the automatic pass still has this song queued or running.
  const autoPending = useSyncExternalStore(lyricsPending.onChange, () => lyricsPending.has(trackId));
  // When the pass lets go of the song, its answer is in the library but the words on screen are from a read begun
  // before: the sheet keeps "Looking for lyrics…" until a read begun after that moment returns, so "No lyrics yet" and
  // its Fetch button never flash between the save and the re-read (derived during render, so no frame shows them).
  const [seen, setSeen] = useState<{ trackId: string; pending: boolean }>({ trackId, pending: autoPending });
  const [settled, setSettled] = useState<Settled | null>(null);
  if (seen.trackId !== trackId || seen.pending !== autoPending) {
    if (seen.trackId === trackId && seen.pending && !autoPending) setSettled({ trackId });
    setSeen({ trackId, pending: autoPending });
  }
  const after = settled?.trackId === trackId ? settled : null;

  useEffect(() => {
    let live = true;
    readTrackLyrics(trackId).then(
      (found) => {
        log("read", { trackId, synced: found?.synced?.length ?? 0, plain: Boolean(found?.plain), fetched: found?.fetched ?? false });
        if (live) setLyrics({ trackId, lyrics: found, after });
      },
      (error: unknown) => {
        log("read_failed", { trackId, message: error instanceof Error ? error.message : String(error) });
        if (live) setLyrics({ trackId, lyrics: null, after, readFailed: true });
      }
    );
    return () => {
      live = false;
    };
  }, [trackId, libraryVersion, after]);

  const current = lyrics?.trackId === trackId ? lyrics.lyrics : null;
  const staleRead = after !== null && lyrics?.after !== after;
  // Read, and no lyrics row at all: never looked up (PAR-LYR-05), handed to the automatic pass below.
  const neverLookedUp = lyrics?.trackId === trackId && lyrics.lyrics === null && !lyrics.readFailed;
  // The pass let go of a song this sheet handed it, still never looked up: its lookup failed or the pass stopped.
  const handedAndLetGo = neverLookedUp && !autoPending && !staleRead && askedOnOpen.current.has(trackId);
  const ownState: FetchState = fetchState?.trackId === trackId ? fetchState.state : "idle";
  const state: FetchState = ownState === "idle" && handedAndLetGo ? "failed" : ownState;

  const fetchNow = () => {
    setFetchState({ trackId, state: "busy" });
    log("fetch", { trackId });
    fetchTrackLyrics(trackId, async (question) => (await lookupClient()).musicLyrics(question)).then(
      (result) => {
        log("fetched", { trackId, outcome: result.outcome });
        setFetchState({ trackId, state: result.outcome === "none" ? "none" : "idle" });
        if (result.lyrics) setLyrics({ trackId, lyrics: result.lyrics, after });
      },
      (error: unknown) => {
        log("fetch_failed", { trackId, message: error instanceof Error ? error.message : String(error) });
        setFetchState({ trackId, state: "failed" });
      }
    );
  };

  useEffect(() => {
    // A read begun before the pass let go of the song is not proof it was never looked up: wait for the re-read.
    if (!neverLookedUp || autoPending || staleRead || state !== "idle" || askedOnOpen.current.has(trackId)) return;
    askedOnOpen.current.add(trackId);
    log("want", { trackId });
    wantLyrics(trackId);
  }, [neverLookedUp, autoPending, staleRead, state, trackId, wantLyrics]);

  if (!lyrics || lyrics.trackId !== trackId) {
    return <ActivityIndicator color={colors.textMuted} style={{ marginVertical: spacing.xl }} />;
  }
  if (current?.synced) {
    return (
      <View style={{ gap: spacing.md }}>
        <SyncedLines lines={current.synced} positionMs={positionMs} />
        <Text style={styles.source}>{current.fetched ? t("shell.nowPlaying.fetchedSyncedLyricsSource") : t("shell.nowPlaying.syncedLyricsSource")}</Text>
      </View>
    );
  }
  if (current?.plain) {
    return (
      <View style={{ gap: spacing.md }}>
        {/* UX-SHEET-01: scrolled to its top, a drag down closes the lyrics sheet. */}
        <MobileSheetScrollView style={styles.scroll} testID="lyrics-plain">
          <Text style={styles.plain}>{current.plain}</Text>
        </MobileSheetScrollView>
        <Text style={styles.source}>{current.fetched ? t("shell.nowPlaying.fetchedPlainLyricsSource") : t("shell.nowPlaying.plainLyricsSource")}</Text>
      </View>
    );
  }
  if (state === "busy" || autoPending || staleRead || (neverLookedUp && state === "idle")) {
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
  // A song every source was asked about: the final "No lyrics" (PAR-LYR-04). "Search again" (PAR-LYR-05) only after a
  // lookup came back empty or failed.
  const notFound = current?.notFound === true && state === "idle";
  const searchAgain = notFound || state === "none" || state === "failed";
  const body = notFound
    ? t("shell.nowPlaying.noLyricsFoundBody")
    : state === "none"
      ? t("shell.nowPlaying.fetchLyricsNone")
      : state === "failed"
        ? t("shell.nowPlaying.fetchLyricsFailed")
        : t("shell.nowPlaying.fetchLyricsBody");
  return (
    <View style={{ gap: spacing.sm }} testID="lyrics-none">
      <Text style={styles.noneTitle}>{notFound || state === "none" ? t("shell.nowPlaying.noLyricsFoundTitle") : t("shell.nowPlaying.noLyricsTitle")}</Text>
      <Text style={styles.meta} testID="lyrics-fetch-message">
        {body}
      </Text>
      {searchAgain && (
        <Pressable testID="lyrics-fetch" accessibilityRole="button" onPress={fetchNow} style={({ pressed }) => [styles.fetch, pressed && { opacity: 0.6 }]}>
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
