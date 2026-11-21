// TV full-screen lyrics (PAR-TV-08), opened by Now playing's Lyrics button and drawn in the `3a-now-lyrics` style (Chris
// 2026-11-20: Now playing B picked, the 3a style for the lyrics view only): the cover, "PLAYING FROM ALBUM", the song and
// artist at the left; the lyrics at the right in large type, the line sung now big and green, the ones sung dim, the
// next ones grey, moving up in time with the song; where they came from at the top right; along the bottom previous,
// play and pause, next, the wave between the times, shuffle, Up next and the heart. What shows ("Looking for lyrics…",
// "No lyrics", "Search again") is `useTrackLyrics`, the phone's own hook (PAR-LYR-04/05/06); only the drawing is the TV's.
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { ListMusic, MicVocal, Shuffle } from "lucide-react-native";
import { type AudioPlaybackState } from "@space/mobile-audio-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvPillButton } from "@space/mobile-shell/tv/TvPillButton";
import { TvBody, TvEyebrow } from "@space/mobile-shell/tv/TvText";
import { TV_COLOR, TV_TYPE, useTvAccent } from "@space/mobile-shell/tv/tokens";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { activeLyricIndex, formatDuration, parrotCoverThumbKey, type ParrotLyrics } from "@space/parrot-core";
import { nowPlayingTitles } from "../lib/nowPlaying";
import { setPlaybackShuffle } from "../lib/playback";
import { ParrotArt } from "../screens/art";
import { usePlayerState } from "../state/usePlayerState";
import { lyricsNoneText, lyricsSourceKey, useTrackLyrics } from "../state/useTrackLyrics";
import { TvRoundButton, TvWave } from "./TvMusicParts";
import { TvLikeButton, TvTransport } from "./TvNowPlayingPage";
import { lyricsEdgeOpacity } from "./tvModel";
import { useTvPages } from "./tvPages";

const log = scopeLogger("parrot.tv.lyrics");

/** Draft `.cover` 420 px; the bar's buttons 76 px. */
const COVER = 210;
const CONTROL = 38;

export const TvLyricsPage = () => {
  const state = usePlayerState(250);
  const { t } = useTranslation();
  const styles = useTvStyles(baseStyles);
  if (!state?.mediaId) {
    return (
      <View style={styles.empty} testID="tv-lyrics-empty">
        <TvBody muted>{t("parrot.player.nothing")}</TvBody>
      </View>
    );
  }
  return <Lyrics state={state} trackId={state.mediaId} />;
};

const Lyrics = ({ state, trackId }: { state: AudioPlaybackState; trackId: string }) => {
  const { t } = useTranslation();
  const { push } = useTvPages();
  const { view, searchAgain } = useTrackLyrics(trackId);
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const meta = nowPlayingTitles.get(trackId);
  const duration = state.durationMs > 0 ? state.durationMs : 0;

  return (
    <View style={styles.page} testID="tv-lyrics">
      <View style={styles.body}>
        <View style={styles.song}>
          <ParrotArt
            seed={meta?.albumId ?? trackId}
            size={COVER * scale}
            radius={12 * scale}
            coverKey={meta?.cover?.coverObjectKey}
            previewKey={meta?.cover ? parrotCoverThumbKey(meta.cover) : null}
          />
          <View style={styles.from}>
            <TvEyebrow>{t("parrot.player.playingFromAlbum")}</TvEyebrow>
            <TvBody muted numberOfLines={1}>
              {meta?.album ?? ""}
            </TvBody>
          </View>
          <Text style={styles.title} numberOfLines={2}>
            {meta?.title ?? t("parrot.player.unknownSong")}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {meta?.artist || t("shell.library.unknownArtist")}
          </Text>
        </View>
        <View style={styles.lyrics}>
          {view.kind === "synced" || view.kind === "plain" ? (
            <View style={styles.source}>
              <MicVocal size={10 * scale} color={TV_COLOR.muted} />
              <Text style={styles.sourceText}>{t(lyricsSourceKey(view))}</Text>
            </View>
          ) : null}
          {view.kind === "reading" ? (
            <ActivityIndicator color={TV_COLOR.muted} />
          ) : view.kind === "synced" ? (
            <SyncedLines lines={view.lines} positionMs={state.positionMs} />
          ) : view.kind === "plain" ? (
            <ScrollView style={styles.scroll} testID="tv-lyrics-plain" showsVerticalScrollIndicator={false}>
              <Text style={styles.plain}>{view.text}</Text>
            </ScrollView>
          ) : view.kind === "searching" ? (
            <View style={styles.message} testID="tv-lyrics-searching">
              <View style={styles.searchingTitle}>
                <ActivityIndicator color={TV_COLOR.muted} />
                <Text style={styles.messageTitle}>{t("shell.nowPlaying.searchingLyricsTitle")}</Text>
              </View>
              <TvBody muted>{t("shell.nowPlaying.searchingLyricsBody")}</TvBody>
            </View>
          ) : (
            <View style={styles.message} testID="tv-lyrics-none">
              <Text style={styles.messageTitle}>{t(lyricsNoneText(view).title)}</Text>
              <TvBody muted>{t(lyricsNoneText(view).body)}</TvBody>
              {view.searchAgain ? (
                <View style={styles.searchAgain}>
                  <TvPillButton
                    testID="tv-lyrics-search-again"
                    icon={MicVocal}
                    label={t("shell.nowPlaying.fetchLyrics")}
                    onPress={() => {
                      log.info("search_again", { trackId });
                      searchAgain();
                    }}
                  />
                </View>
              ) : null}
            </View>
          )}
        </View>
      </View>
      <View style={styles.bar}>
        <TvTransport state={state} withShuffle={false} withRepeat={false} />
        <Text style={styles.time}>{formatDuration(state.positionMs)}</Text>
        <TvWave seed={trackId} progress={duration > 0 ? state.positionMs / duration : 0} height={22} bars={110} style={styles.wave} />
        <Text style={styles.time}>{`-${formatDuration(Math.max(0, duration - state.positionMs))}`}</Text>
        <TvRoundButton
          testID="tv-lyrics-shuffle"
          icon={Shuffle}
          size={CONTROL}
          label={t("shell.player.shuffle")}
          active={state.shuffle}
          onPress={() => void setPlaybackShuffle(!state.shuffle).catch((error: unknown) => log.warn("shuffle_failed", { message: error instanceof Error ? error.message : String(error) }))}
        />
        <TvRoundButton testID="tv-lyrics-up-next" icon={ListMusic} size={CONTROL} label={t("shell.nowPlaying.upNext")} onPress={() => push({ kind: "queue" })} />
        <TvLikeButton trackId={trackId} />
      </View>
    </View>
  );
};

type LineFrame = { y: number; height: number };

/**
 * The synced lines, the one sung now kept a third of the way down (draft: two sung lines above it), fading out toward the
 * window's top and bottom as the draft's mask does.
 */
const SyncedLines = ({ lines, positionMs }: { lines: NonNullable<ParrotLyrics["synced"]>; positionMs: number }) => {
  const active = activeLyricIndex(lines, positionMs);
  const accent = useTvAccent().color;
  const styles = useTvStyles(baseStyles);
  const scroll = useRef<ScrollViewInstance | null>(null);
  const [frames, setFrames] = useState<Array<LineFrame | undefined>>([]);
  const [height, setHeight] = useState(0);
  const anchor = frames[Math.max(0, active)];
  const scrollY = anchor ? Math.max(0, anchor.y - height / 3) : 0;
  useEffect(() => {
    scroll.current?.scrollTo({ y: scrollY, animated: true });
  }, [scrollY]);
  return (
    <ScrollView
      ref={scroll}
      style={styles.synced}
      testID="tv-lyrics-synced"
      showsVerticalScrollIndicator={false}
      scrollEnabled={false}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      {lines.map((line, index) => {
        const now = index === active;
        const frame = frames[index];
        return (
          <Text
            key={`${line.ms}-${index}`}
            testID={now ? "tv-lyrics-line-now" : "tv-lyrics-line"}
            onLayout={(event) => {
              const { y, height: lineHeight } = event.nativeEvent.layout;
              setFrames((current) => {
                const was = current[index];
                if (was && was.y === y && was.height === lineHeight) return current;
                const next = [...current];
                next[index] = { y, height: lineHeight };
                return next;
              });
            }}
            style={[
              styles.line,
              now ? [styles.lineNow, { color: accent }] : index < active ? styles.linePast : null,
              frame && height > 0 ? { opacity: lyricsEdgeOpacity(frame.y + frame.height / 2 - scrollY, height) } : null,
            ]}
          >
            {line.text || "♪"}
          </Text>
        );
      })}
    </ScrollView>
  );
};

/** Sizes in design dp: draft px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  // Draft `.lyr`: padding 84px 110px, columns 420px + the rest, gap 110px; the bar along the bottom.
  page: { flex: 1, paddingTop: 42, paddingBottom: 24, paddingHorizontal: 55 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, flexDirection: "row", gap: 55 },
  song: { width: COVER },
  from: { gap: 2, marginTop: 20 },
  title: { ...TV_TYPE.hero, fontSize: 27, lineHeight: 33, color: TV_COLOR.text, marginTop: 14 },
  artist: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 13, lineHeight: 18, color: TV_COLOR.muted, marginTop: 2 },
  // Draft `.lyr`: a 700px window centred in its column; the source line pinned to the page's top right.
  lyrics: { flex: 1, justifyContent: "center" },
  source: { position: "absolute", top: 0, right: 0, flexDirection: "row", alignItems: "center", gap: 5 },
  sourceText: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 9.5, color: TV_COLOR.muted },
  synced: { height: 350, flexGrow: 0 },
  scroll: { flex: 1, marginTop: 28 },
  // Draft `.line`: 50px at line-height 1.15, 32% white, past lines 20%, the current one 66px green; gap 30px.
  line: { fontFamily: TV_TYPE.hero.fontFamily, fontSize: 25, lineHeight: 29, fontWeight: "600", color: "rgba(255, 255, 255, 0.32)", marginBottom: 15 },
  linePast: { color: "rgba(255, 255, 255, 0.2)" },
  lineNow: { fontSize: 33, lineHeight: 38, fontWeight: "700" },
  plain: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 17, lineHeight: 26, color: TV_COLOR.text },
  message: { gap: 8, paddingTop: 30 },
  searchingTitle: { flexDirection: "row", alignItems: "center", gap: 10 },
  messageTitle: { ...TV_TYPE.page, color: TV_COLOR.text },
  searchAgain: { flexDirection: "row", marginTop: 8 },
  bar: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 14 },
  time: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 10, color: TV_COLOR.muted, fontVariant: ["tabular-nums"] },
  wave: { flex: 1, overflow: "hidden" },
});
