// The full player in the approved Parrot design (PAR-LOOK-01, PAR-PLAY-05): over the sky with a teal wash, a header
// ("PLAYING FROM ALBUM" over the album, a "…" opening the song sheet every song row opens, with Go to album and Go to
// artist in it), the album art, what plays with a
// heart when the song is liked, its position on the waveform (tap to seek) with the time played and the time left,
// shuffle / previous / play-pause / next / repeat, a slider tied to the phone's media volume (the one its buttons move),
// then the output switcher, the lyrics and the queue. The notification and lock screen carry the same transport.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Cast,
  ChevronDown,
  Ellipsis,
  Heart,
  ListMusic,
  Mic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume,
  Volume2,
} from "lucide-react-native";
import { AudioPlayback, showsPause, type AudioPlaybackState } from "@space/mobile-audio-playback";
import { setPlaybackShuffle } from "../lib/playback";
import { useMediaVolume, VolumeSlider } from "@space/mobile-media-volume";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MOBILE_ICON_BUTTON_SIZE, MobileIconButton, SkyCover } from "@space/mobile-shell/components";
import { MobileBottomSheet, MobileSheetScrollView, useMobileDismissPan } from "@space/mobile-shell/bottom-sheet";
import { SHEET_CLOSE_MS } from "@space/mobile-shell/bottom-sheet-motion";
import { formatDuration, nextRepeatMode, parrotCoverThumbKey } from "@space/parrot-core";
import { nowPlayingTitles } from "../lib/nowPlaying";
import { usePlaylistEditor } from "../state/playlistEditor";
import { usePlayerState } from "../state/usePlayerState";
import { useUpNext } from "../state/useUpNext";
import { colors, spacing } from "../theme";
import { ParrotArt, WaveSeek } from "./art";
import { Body, Centered, ErrorText } from "./ui";
import { PLAYER_TINT, ParrotSky } from "./sky";
import { PlayerLyrics } from "./PlayerLyrics";
import type { RootStack } from "./routes";

const Control = ({ label, onPress, children, big, active }: { label: string; onPress: () => void; children: React.ReactNode; big?: boolean; active?: boolean }) => (
  <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={active === undefined ? undefined : { selected: active }}
    onPress={onPress}
    hitSlop={12}
    style={({ pressed }) => [big ? styles.bigControl : styles.control, pressed && { opacity: 0.6 }]}
  >
    {children}
  </Pressable>
);

/** "−1:23": the time left in the song, under the waveform's right end. */
export const remainingLabel = (positionMs: number, durationMs: number): string =>
  durationMs > 0 ? `\u2212${formatDuration(Math.max(0, durationMs - positionMs))}` : formatDuration(null);

/** Whether the phone can open Android's output switcher (Android 11+); the cast button shows only then. */
const useOutputSwitcher = () => {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    AudioPlayback.canShowOutputSwitcher().then(
      (yes) => live && setAvailable(yes),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);
  return available;
};

type Sheet = "lyrics" | "queue" | null;

export const PlayerScreen = () => {
  const state = usePlayerState(250);
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const volume = useMediaVolume();
  const canCast = useOutputSwitcher();
  const editor = usePlaylistEditor();
  const [sheet, setSheet] = useState<Sheet>(null);
  // UX-SHEET-01: Now playing comes up as a sheet; a drag down on its header or cover sends it back down. iOS's own
  // modal sheet already follows the finger; Android's modal screen has no such drag, so it gets this one.
  const [drag] = useState(() => new Animated.Value(0));
  const dismiss = useCallback(() => {
    Animated.timing(drag, { toValue: height, duration: SHEET_CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() =>
      navigation.goBack()
    );
  }, [drag, height, navigation]);
  const makeDismissPan = useMobileDismissPan(drag, dismiss);
  const dragDismiss = Platform.OS === "android";
  const headerPan = useMemo(() => makeDismissPan(dragDismiss), [makeDismissPan, dragDismiss]);
  const coverPan = useMemo(() => makeDismissPan(dragDismiss), [makeDismissPan, dragDismiss]);

  if (!state || !state.mediaId) {
    return (
      <ParrotSky tint={PLAYER_TINT}>
        <Centered>
          <Body muted>{t("parrot.player.nothing")}</Body>
        </Centered>
      </ParrotSky>
    );
  }
  const meta = nowPlayingTitles.get(state.mediaId);
  const duration = state.durationMs > 0 ? state.durationMs : 0;
  const progress = duration > 0 ? Math.min(1, state.positionMs / duration) : 0;
  const artSize = Math.min(width - spacing.xl * 2, height * 0.38);
  const repeatLabel = state.repeat === "one" ? t("shell.player.repeatOne") : state.repeat === "all" ? t("shell.player.repeatAll") : t("shell.player.repeatOff");

  // PAR-NAV-05: the album's and the artist's names open their pages, as the "..." menu does.
  const openAlbum = meta?.albumId
    ? () => navigation.navigate("Album", { albumId: meta.albumId, title: meta.album, artistName: meta.artist, cover: meta.cover ?? undefined })
    : undefined;
  const openArtist = meta?.artistId ? () => navigation.navigate("Artist", { artistId: meta.artistId!, name: meta.artist }) : undefined;

  // The song sheet every song row opens (the app's own bottom sheet: a tap outside, Back or a drag down closes it),
  // with the way to the album and the artist on top.
  const openMenu = () =>
    editor.openSong(
      { id: state.mediaId!, title: meta?.title ?? t("parrot.player.unknownSong"), artist: meta?.artist },
      undefined,
      { onGoToAlbum: openAlbum, onGoToArtist: openArtist }
    );

  return (
    <Animated.View style={{ flex: 1, transform: [{ translateY: drag }] }}>
    <ParrotSky tint={PLAYER_TINT}>
      <View style={[styles.screen, { paddingTop: insets.top + spacing.sm }]}>
        <GestureDetector gesture={headerPan}>
        <View style={styles.header}>
          <MobileIconButton testID="player-close" label={t("parrot.player.close")} onPress={() => navigation.goBack()}>
            <ChevronDown size={28} color={colors.text} />
          </MobileIconButton>
          <View style={styles.headerText} accessibilityRole="header" accessible accessibilityLabel={`${t("parrot.player.playingFromAlbum")}, ${meta?.album ?? ""}`}>
            <Text style={styles.headerKicker} numberOfLines={1}>
              {t("parrot.player.playingFromAlbum").toUpperCase()}
            </Text>
            <Text testID="player-album-link" style={styles.headerAlbum} numberOfLines={1} onPress={openAlbum} suppressHighlighting>
              {meta?.album || t("parrot.nav.nowPlaying")}
            </Text>
          </View>
          <MobileIconButton testID="player-menu" label={t("parrot.player.more")} onPress={openMenu}>
            <Ellipsis size={22} color={colors.text} />
          </MobileIconButton>
        </View>
        </GestureDetector>

        <GestureDetector gesture={coverPan}>
        <SkyCover style={styles.artWrap}>
          <ParrotArt
            seed={meta?.albumId ?? state.mediaId}
            size={artSize}
            radius={18}
            style={styles.art}
            coverKey={meta?.cover?.coverObjectKey}
            previewKey={meta?.cover ? parrotCoverThumbKey(meta.cover) : null}
          />
        </SkyCover>
        </GestureDetector>

        <View style={styles.titleRow}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.title} numberOfLines={2}>
              {meta?.title ?? t("parrot.player.unknownSong")}
            </Text>
            <Text testID="player-artist-link" style={styles.meta} numberOfLines={1} onPress={openArtist} suppressHighlighting>
              {meta?.artist}
            </Text>
          </View>
          <Pressable
            testID="player-heart"
            accessibilityRole="button"
            accessibilityLabel={editor.liked(state.mediaId) ? t("shell.playlists.unlike") : t("shell.playlists.like")}
            accessibilityState={{ selected: editor.liked(state.mediaId) }}
            hitSlop={10}
            onPress={() => editor.toggleLike(state.mediaId!)}
            style={({ pressed }) => pressed && { opacity: 0.6 }}
          >
            <Heart size={26} color={editor.liked(state.mediaId) ? colors.accent : colors.textMuted} fill={editor.liked(state.mediaId) ? colors.accent : "transparent"} />
          </Pressable>
        </View>

        <View>
          <WaveSeek
            seed={state.mediaId}
            progress={progress}
            accessibilityLabel={t("parrot.player.position")}
            accessibilityValue={{ min: 0, max: Math.round(duration / 1000), now: Math.round(state.positionMs / 1000) }}
            onStep={(direction) => void AudioPlayback.seekTo(state.positionMs + direction * 15_000)}
            onSeek={(fraction) => {
              if (duration > 0) void AudioPlayback.seekTo(fraction * duration);
            }}
          />
          <View style={styles.times}>
            <Text style={styles.time}>{formatDuration(state.positionMs)}</Text>
            <Text style={styles.time} testID="player-remaining">
              {remainingLabel(state.positionMs, duration)}
            </Text>
          </View>
        </View>
        {state.error ? <ErrorText>{t("parrot.player.error", { error: state.error })}</ErrorText> : null}

        <View style={styles.controls}>
          <Control label={t("shell.player.shuffle")} active={state.shuffle} onPress={() => void setPlaybackShuffle(!state.shuffle)}>
            <Shuffle color={state.shuffle ? colors.accent : colors.textMuted} size={24} />
          </Control>
          <Control label={t("parrot.player.previous")} onPress={() => void AudioPlayback.previous()}>
            <SkipBack color={colors.text} fill={colors.text} size={30} />
          </Control>
          <Control big label={showsPause(state) ? t("player.controls.pause") : t("player.controls.play")} onPress={() => void (showsPause(state) ? AudioPlayback.pause() : AudioPlayback.play())}>
            {showsPause(state) ? <Pause color={colors.accentText} fill={colors.accentText} size={34} /> : <Play color={colors.accentText} fill={colors.accentText} size={34} />}
          </Control>
          <Control label={t("parrot.player.next")} onPress={() => void AudioPlayback.next()}>
            <SkipForward color={colors.text} fill={colors.text} size={30} />
          </Control>
          <Control label={repeatLabel} active={state.repeat !== "off"} onPress={() => void AudioPlayback.setRepeatMode(nextRepeatMode(state.repeat))}>
            {state.repeat === "one" ? <Repeat1 color={colors.accent} size={24} /> : <Repeat color={state.repeat === "all" ? colors.accent : colors.textMuted} size={24} />}
          </Control>
        </View>

        {volume.level === null ? null : (
          <View style={styles.volume}>
            <Volume color={colors.textMuted} size={20} />
            <VolumeSlider
              testID="player-volume"
              accessibilityLabel={t("player.controls.volume")}
              value={volume.level}
              onChange={volume.setLevel}
              colors={{ fill: colors.accent, thumb: colors.accent, track: colors.surfaceRaised }}
              style={styles.volumeSlider}
            />
            <Volume2 color={colors.textMuted} size={20} />
          </View>
        )}

        <View style={styles.bottom}>
          {canCast ? (
            <MobileIconButton testID="player-cast" label={t("parrot.player.output")} onPress={() => void AudioPlayback.showOutputSwitcher()}>
              <Cast size={22} color={colors.textMuted} />
            </MobileIconButton>
          ) : (
            <View style={styles.bottomSpacer} />
          )}
          <Pressable testID="player-lyrics" accessibilityRole="button" hitSlop={8} onPress={() => setSheet("lyrics")} style={({ pressed }) => [styles.lyrics, pressed && { opacity: 0.6 }]}>
            <Mic size={18} color={colors.textMuted} />
            <Text style={styles.lyricsText}>{t("shell.player.lyrics")}</Text>
          </Pressable>
          <MobileIconButton testID="player-queue" label={t("shell.player.queue")} onPress={() => setSheet("queue")}>
            <ListMusic size={22} color={colors.textMuted} />
          </MobileIconButton>
        </View>
      </View>
      <PlayerSheet
        sheet={sheet}
        state={state}
        onClose={() => setSheet(null)}
        onOpenArtist={(artistId, name) => {
          setSheet(null);
          navigation.navigate("Artist", { artistId, name });
        }}
      />
    </ParrotSky>
    </Animated.View>
  );
};

/** The lyrics of the song playing (PlayerLyrics) and the queue, in a sheet over the player (UX-SHEET-01). */
const PlayerSheet = ({
  sheet,
  state,
  onClose,
  onOpenArtist,
}: {
  sheet: Sheet;
  state: AudioPlaybackState;
  onClose: () => void;
  /** A queued song's artist name was tapped (PAR-NAV-05). */
  onOpenArtist: (artistId: string, name: string) => void;
}) => {
  const { t } = useTranslation();
  // The sheet keeps what it showed while it slides out.
  const [shown, setShown] = useState<Exclude<Sheet, null>>("lyrics");
  useEffect(() => {
    if (sheet) setShown(sheet);
  }, [sheet]);
  const kind = sheet ?? shown;
  const next = useUpNext(kind === "queue" && sheet !== null, state);
  return (
    <MobileBottomSheet
      visible={sheet !== null}
      onClose={onClose}
      testID={kind === "lyrics" ? "lyrics-sheet" : "queue-sheet"}
      title={kind === "queue" ? t("shell.nowPlaying.upNext") : undefined}
      sheetStyle={styles.sheet}
    >
      {kind === "lyrics" ? (
        state.mediaId ? (
          <PlayerLyrics trackId={state.mediaId} positionMs={state.positionMs} />
        ) : (
          <Text style={styles.sheetTitle}>{t("shell.nowPlaying.noLyricsTitle")}</Text>
        )
      ) : next.length === 0 ? (
        <Text style={styles.meta}>{t("shell.nowPlaying.nothingNext")}</Text>
      ) : (
        <MobileSheetScrollView style={{ maxHeight: 360 }}>
          {next.map((id, index) => {
            const song = nowPlayingTitles.get(id);
            return (
              <View key={`${id}:${index}`} style={styles.queueRow}>
                <ParrotArt seed={song?.albumId ?? id} size={40} radius={6} coverKey={song?.cover ? parrotCoverThumbKey(song.cover) : null} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.queueTitle} numberOfLines={1}>
                    {song?.title ?? t("parrot.player.unknownSong")}
                  </Text>
                  <Text
                    testID="queue-artist-link"
                    style={styles.meta}
                    numberOfLines={1}
                    onPress={song?.artistId ? () => onOpenArtist(song.artistId!, song.artist) : undefined}
                    suppressHighlighting
                  >
                    {song?.artist}
                  </Text>
                </View>
              </View>
            );
          })}
        </MobileSheetScrollView>
      )}
    </MobileBottomSheet>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.xl, paddingBottom: spacing.md, gap: spacing.lg, justifyContent: "space-between" },
  header: { flexDirection: "row", alignItems: "center", marginHorizontal: -spacing.md },
  headerText: { flex: 1, alignItems: "center" },
  headerKicker: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  headerAlbum: { color: colors.text, fontSize: 15, fontWeight: "700" },
  artWrap: { alignSelf: "center" },
  art: { elevation: 12 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  title: { color: colors.text, fontSize: 22, fontWeight: "800" },
  meta: { color: colors.textMuted, fontSize: 15 },
  times: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs },
  time: { color: colors.textMuted, fontSize: 13, fontVariant: ["tabular-nums"] },
  controls: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  volume: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  volumeSlider: { flex: 1 },
  control: { width: 52, height: 52, alignItems: "center", justifyContent: "center" },
  bigControl: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  bottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginHorizontal: -spacing.md },
  bottomSpacer: { width: MOBILE_ICON_BUTTON_SIZE },
  lyrics: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingHorizontal: spacing.md },
  lyricsText: { color: colors.textMuted, fontSize: 14, fontWeight: "600" },
  sheet: { backgroundColor: colors.surfaceRaised, paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, gap: spacing.md },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "800" },
  queueRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  queueTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
});
