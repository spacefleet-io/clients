import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type AccessibilityActionEvent,
} from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { AudioLines, Captions, Cast, Check, ChevronsLeft, ChevronsRight, Pause, Play, Square, Volume2, VolumeX } from "lucide-react-native";
import { isVerticalSwipe, levelAfterSwipe, SWIPE_SLOP_DP, type SurfaceTap } from "@space/mobile-mpv-playback/gestures";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { VolumeSlider } from "@space/mobile-media-volume";
import { buildAudioRows, buildSubtitleRows, pickerRowAccessibilityLabel, type TrackRow } from "@space/mobile-mpv-playback/trackRows";
import type { RootStackParamList } from "../../navigation/AppNavigator";
import { theme } from "../../theme/theme";
import { BottomSheet } from "../../components/BottomSheet";
import { usePickerSheet } from "../../components/usePickerSheet";
import { formatClock } from "@space/shared/format";
import { castMediaHandlers, castMediaState } from "../../lib/playback/osMediaSession";
import { useOsMediaSession } from "../../lib/playback/useOsMediaSession";
import { castPadTap } from "../../lib/cast/castGestures";
import { useCastPlayback } from "./useCastPlayback";

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * The phone as the remote of a cast (UX-TV-03): the film plays on the Google Cast / AirPlay device, never on the phone
 * (MPV-MODEL-02). Leaving this screen ends the cast. On Android the cast drives the app's OS media session (the Cast
 * SDK's own card is off, `BadgerCastOptionsProvider`): one card with the Badger glyph, headset and lock-screen
 * play/pause reaching the device, and a foreground service that keeps the phone serving with the screen off. On an
 * iPhone AVPlayer owns Now Playing during AirPlay, so the card is not bound there.
 * The audio and subtitle pickers and the volume bar act on the device: the volume is the TV's, the one the phone's
 * volume keys also move while casting.
 */
export const CastScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { height } = useWindowDimensions();
  const { mediaId, episodeId, target } = useRoute().params as RootStackParamList["Cast"];
  const { view, setPlaying, togglePlay, seekTo, seekBy, selectTrack, setVolume, toggleMute, stop } = useCastPlayback(mediaId, episodeId ?? null, target);
  const [barWidth, setBarWidth] = useState(0);
  const sheet = usePickerSheet();
  const [sheetKind, setSheetKind] = useState<"audio" | "subtitles">("audio");

  const onBarLayout = useCallback((e: LayoutChangeEvent) => setBarWidth(e.nativeEvent.layout.width), []);
  const leave = useCallback(() => {
    void stop().finally(() => navigation.goBack());
  }, [navigation, stop]);
  // ACCT-STREAM-02: Cancel at "Play here instead?", or another device took the place: back to where the cast started.
  useEffect(() => {
    if (!view.closeReason) return;
    console.warn("[cast] stream slot close", JSON.stringify({ reason: view.closeReason }));
    leave();
  }, [view.closeReason, leave]);
  const openSheet = useCallback(
    (kind: "audio" | "subtitles") => {
      setSheetKind(kind);
      sheet.open();
    },
    [sheet],
  );

  // The touch pad (UX-TV-03): a double tap on its left or right half seeks 10 s, a vertical slide sets the TV volume,
  // with the player's gesture rules (`@space/mobile-mpv-playback/gestures`). Refs keep the responder stable across polls.
  const pad = useRef({ width: 1 });
  const lastTap = useRef<SurfaceTap | null>(null);
  const pressInAt = useRef(0);
  const slide = useRef<{ start: number; last: number } | null>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hud, setHud] = useState<{ kind: "volume"; level: number } | { kind: "seek"; direction: 1 | -1 } | null>(null);
  const live = useRef({ view, seekBy, setVolume, height });
  live.current = { view, seekBy, setVolume, height };
  useEffect(() => () => clearTimeout(hudTimer.current), []);
  const onPadLayout = useCallback((e: LayoutChangeEvent) => {
    pad.current.width = Math.max(1, e.nativeEvent.layout.width);
  }, []);
  const padPan = useMemo(() => {
    const hideHud = () => {
      clearTimeout(hudTimer.current);
      hudTimer.current = setTimeout(() => setHud(null), 700);
    };
    const endSlide = () => {
      const s = slide.current;
      slide.current = null;
      if (!s) return;
      live.current.setVolume(s.last, "end");
      hideHud();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => isVerticalSwipe(gs.dx, gs.dy),
      onPanResponderGrant: (e) => {
        pressInAt.current = e.nativeEvent.timestamp;
      },
      onPanResponderMove: (_, gs) => {
        const { view: v, height: h } = live.current;
        if (!slide.current) {
          if (v.volume === null || !isVerticalSwipe(gs.dx, gs.dy)) return;
          const start = v.muted ? 0 : v.volume;
          slide.current = { start, last: start };
          lastTap.current = null;
        }
        const s = slide.current;
        const level = levelAfterSwipe(s.start, gs.dy, h);
        if (Math.abs(level - s.last) < 0.005) return;
        s.last = level;
        clearTimeout(hudTimer.current);
        setHud({ kind: "volume", level });
        live.current.setVolume(level, "drag");
      },
      onPanResponderRelease: (e, gs) => {
        if (slide.current) return endSlide();
        if (Math.abs(gs.dx) > SWIPE_SLOP_DP || Math.abs(gs.dy) > SWIPE_SLOP_DP) return;
        const { seek, last } = castPadTap(
          lastTap.current,
          { locationX: e.nativeEvent.locationX, downAt: pressInAt.current, upAt: e.nativeEvent.timestamp },
          pad.current.width,
        );
        lastTap.current = last;
        if (seek === null) return;
        void live.current.seekBy(seek);
        setHud({ kind: "seek", direction: seek });
        hideHud();
      },
      onPanResponderTerminate: endSlide,
    });
  }, []);

  const osMediaState = useMemo(() => castMediaState(view), [view]);
  useOsMediaSession(osMediaState, castMediaHandlers({ setPlaying, seekTo, stop: leave }), Platform.OS === "android");

  const casting = view.phase === "casting" || view.phase === "ended";
  const fraction = view.durationSeconds > 0 ? Math.min(1, view.positionSeconds / view.durationSeconds) : 0;
  const status =
    view.phase === "preparing"
      ? t("cast.preparing")
      : view.phase === "connecting"
        ? t("cast.connecting", { name: target.name })
        : view.phase === "ended"
          ? t("cast.ended")
          : view.switching
            ? t("cast.switchingTrack")
            : t("cast.castingTo", { name: target.name });

  // The pickers list the file's tracks the device can play; a pick closes the sheet, then reloads the device.
  const { audioRows, subtitleRows } = useMemo(() => {
    const tracks = view.tracks;
    if (!tracks) return { audioRows: [] as TrackRow[], subtitleRows: [] as TrackRow[] };
    const fallback = (n: number) => t("cast.trackN", { n });
    const pick = (kind: "audio" | "subtitle", idx: number) => sheet.close(() => void selectTrack({ kind, idx }));
    return {
      audioRows: buildAudioRows(
        tracks.audio.map((c) => c.track),
        tracks.audio.findIndex((c) => c.idx === view.active.audioIdx),
        fallback,
        (i) => pick("audio", tracks.audio[i]!.idx),
      ),
      subtitleRows: buildSubtitleRows(
        tracks.subtitles.map((c) => c.track),
        view.active.subtitleIdx,
        t("cast.subtitlesOff"),
        fallback,
        (idx) => pick("subtitle", idx),
        (track) => track.format !== "vtt",
      ),
    };
  }, [view.tracks, view.active, t, sheet, selectTrack]);
  const audioLabel = audioRows.find((r) => r.selected)?.title ?? "-";
  const subtitleLabel = subtitleRows.find((r) => r.selected)?.title ?? t("cast.subtitlesOff");
  const tracksEnabled = view.phase === "casting" && !view.switching;
  const volumeLevel = view.muted ? 0 : (view.volume ?? 0);

  return (
    <SafeAreaView style={styles.root} testID="cast-screen">
      <View style={styles.header}>
        <Cast size={20} color={theme.colors.accent} />
        <Text style={styles.screenTitle} accessibilityRole="header">
          {t("cast.screenTitle")}
        </Text>
      </View>

      {casting ? (
        <View
          style={styles.pad}
          onLayout={onPadLayout}
          {...padPan.panHandlers}
          accessible
          accessibilityLabel={t("cast.gestureHint")}
          accessibilityActions={[
            { name: "back10", label: t("cast.back10") },
            { name: "forward10", label: t("cast.forward10") },
          ]}
          onAccessibilityAction={(e: AccessibilityActionEvent) => void seekBy(e.nativeEvent.actionName === "back10" ? -1 : 1)}
          testID="cast-gesture-pad"
        >
          {hud?.kind === "volume" ? (
            <View style={styles.hud} pointerEvents="none" testID="cast-volume-hud">
              {hud.level === 0 ? <VolumeX size={28} color={theme.colors.accent} /> : <Volume2 size={28} color={theme.colors.accent} />}
              <Text style={styles.hudText}>{`${Math.round(hud.level * 100)} %`}</Text>
            </View>
          ) : hud?.kind === "seek" ? (
            <View style={[styles.hud, hud.direction < 0 ? styles.hudLeft : styles.hudRight]} pointerEvents="none" testID="cast-seek-hud">
              {hud.direction < 0 ? <ChevronsLeft size={28} color={theme.colors.accent} /> : <ChevronsRight size={28} color={theme.colors.accent} />}
              <Text style={styles.hudText}>{hud.direction < 0 ? t("cast.seekBackToast") : t("cast.seekForwardToast")}</Text>
            </View>
          ) : (
            <Text style={styles.padHint} pointerEvents="none">
              {t("cast.gestureHint")}
            </Text>
          )}
        </View>
      ) : null}

      <View style={casting ? styles.bodyCasting : styles.body}>
        {view.title ? <Text style={styles.title}>{view.title}</Text> : null}
        {view.episodeLabel ? <Text style={styles.subtitle}>{view.episodeLabel}</Text> : null}

        {view.phase === "refused" && view.refusal ? (
          <View testID="cast-refused" accessibilityRole="alert">
            <Text style={styles.problemTitle}>{t("cast.refusedTitle")}</Text>
            <Text style={styles.problem}>{t(`cast.refused.${view.refusal}`)}</Text>
          </View>
        ) : view.phase === "error" && view.errorKey ? (
          <Text style={styles.problem} testID="cast-error" accessibilityRole="alert">
            {t(view.errorKey)}
          </Text>
        ) : (
          <>
            <Text style={styles.status} testID="cast-status" accessibilityLiveRegion="polite">
              {status}
            </Text>
            {casting ? (
              <>
                <View
                  style={styles.barHit}
                  onLayout={onBarLayout}
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel={t("cast.seekBar")}
                  accessibilityValue={{ min: 0, max: Math.round(view.durationSeconds), now: Math.round(view.positionSeconds), text: `${formatClock(view.positionSeconds)} / ${formatClock(view.durationSeconds)}` }}
                  accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
                  onAccessibilityAction={(e: AccessibilityActionEvent) => void seekBy(e.nativeEvent.actionName === "increment" ? 1 : -1)}
                >
                  <Pressable
                    style={styles.barTrack}
                    onPress={(e) => barWidth > 0 && void seekTo((e.nativeEvent.locationX / barWidth) * view.durationSeconds)}
                    testID="cast-seek"
                  >
                    <View style={[styles.barFill, { width: `${fraction * 100}%` }]} />
                  </Pressable>
                </View>
                <View style={styles.times}>
                  <Text style={styles.time}>{formatClock(view.positionSeconds)}</Text>
                  <Text style={styles.time}>{formatClock(view.durationSeconds)}</Text>
                </View>
                <View style={styles.controls}>
                  <Pressable
                    style={[styles.control, styles.controlMain]}
                    onPress={() => void togglePlay()}
                    accessibilityRole="button"
                    accessibilityLabel={view.playing ? t("cast.pause") : t("cast.play")}
                    testID="cast-play-pause"
                  >
                    {view.playing ? <Pause size={30} color={theme.colors.bg} fill={theme.colors.bg} /> : <Play size={30} color={theme.colors.bg} fill={theme.colors.bg} />}
                  </Pressable>
                </View>

                <View style={styles.volumeRow}>
                  <Pressable
                    style={styles.volumeButton}
                    onPress={toggleMute}
                    disabled={view.volume === null}
                    accessibilityRole="button"
                    accessibilityLabel={view.muted ? t("cast.unmute") : t("cast.mute")}
                    accessibilityState={{ selected: view.muted }}
                    testID="cast-mute"
                  >
                    {view.muted || volumeLevel === 0 ? <VolumeX size={22} color={theme.colors.accent} /> : <Volume2 size={22} color={theme.colors.text} />}
                  </Pressable>
                  <VolumeSlider
                    value={volumeLevel}
                    onChange={setVolume}
                    colors={{ fill: theme.colors.accent, track: theme.colors.surfaceRaised, thumb: theme.colors.accent }}
                    accessibilityLabel={t("cast.volume")}
                    step={0.05}
                    style={styles.volumeSlider}
                    testID="cast-volume"
                  />
                </View>

                <View style={styles.trackRow}>
                  <Pressable
                    style={[styles.trackButton, !tracksEnabled && styles.disabled]}
                    disabled={!tracksEnabled || audioRows.length === 0}
                    onPress={() => openSheet("audio")}
                    accessibilityRole="button"
                    accessibilityLabel={`${t("cast.audio")}, ${audioLabel}`}
                    testID="cast-audio"
                  >
                    <AudioLines size={18} color={theme.colors.accent} />
                    <View style={styles.trackText}>
                      <Text style={styles.trackKind}>{t("cast.audio")}</Text>
                      <Text style={styles.trackValue} numberOfLines={1}>
                        {audioLabel}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    style={[styles.trackButton, !tracksEnabled && styles.disabled]}
                    disabled={!tracksEnabled}
                    onPress={() => openSheet("subtitles")}
                    accessibilityRole="button"
                    accessibilityLabel={`${t("cast.subtitles")}, ${subtitleLabel}`}
                    testID="cast-subtitles"
                  >
                    <Captions size={18} color={theme.colors.accent} />
                    <View style={styles.trackText}>
                      <Text style={styles.trackKind}>{t("cast.subtitles")}</Text>
                      <Text style={styles.trackValue} numberOfLines={1}>
                        {subtitleLabel}
                      </Text>
                    </View>
                  </Pressable>
                </View>
              </>
            ) : null}
            <Text style={styles.note}>{t("cast.keepWifi")}</Text>
          </>
        )}
      </View>

      <Pressable style={styles.stop} onPress={leave} accessibilityRole="button" accessibilityLabel={t("cast.stop")} testID="cast-stop">
        <Square size={18} color={theme.colors.text} fill={theme.colors.text} />
        <Text style={styles.stopText}>{view.phase === "refused" || view.phase === "error" ? t("cast.back") : t("cast.stop")}</Text>
      </Pressable>

      <BottomSheet sheet={sheet} testID="cast-track-sheet">
        <Text style={styles.sheetTitle} accessibilityRole="header">
          {sheetKind === "audio" ? t("cast.audio") : t("cast.subtitles")}
        </Text>
        <MobileSheetScrollView contentContainerStyle={styles.sheetList}>
          {(sheetKind === "audio" ? audioRows : subtitleRows).map((row) => (
            <Pressable
              key={row.key}
              testID={row.testID ? `cast-${row.testID}` : undefined}
              style={[styles.sheetRow, row.selected && styles.sheetRowSelected, row.disabled && styles.disabled]}
              disabled={row.disabled}
              onPress={row.onPress}
              accessibilityRole="button"
              accessibilityState={{ selected: row.selected, disabled: row.disabled }}
              accessibilityLabel={pickerRowAccessibilityLabel(row)}
            >
              <View style={styles.trackText}>
                <Text style={[styles.sheetRowTitle, row.selected && styles.sheetRowTitleSelected]}>{row.title}</Text>
                {row.disabled ? (
                  <Text style={styles.sheetRowNote}>{t("cast.imageSubtitle")}</Text>
                ) : row.subtitle ? (
                  <Text style={styles.sheetRowNote}>{row.subtitle}</Text>
                ) : null}
              </View>
              {row.selected ? <Check size={18} color={theme.colors.accent} /> : null}
            </Pressable>
          ))}
        </MobileSheetScrollView>
      </BottomSheet>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, paddingBottom: 20 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14 },
  screenTitle: { color: theme.colors.text, fontSize: 16, fontWeight: "800", fontFamily: theme.font.family.display },
  body: { flex: 1, justifyContent: "center", gap: 14 },
  bodyCasting: { gap: 14, paddingTop: 12, paddingBottom: 16 },
  pad: {
    flex: 1,
    minHeight: 120,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  padHint: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: "center" },
  hud: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 16, backgroundColor: theme.colors.surfaceRaised },
  hudLeft: { alignSelf: "flex-start" },
  hudRight: { alignSelf: "flex-end" },
  hudText: { color: theme.colors.text, fontSize: 18, fontWeight: "800" },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: "800", fontFamily: theme.font.family.display },
  subtitle: { color: theme.colors.textMuted, fontSize: 14, fontWeight: "700" },
  status: { color: theme.colors.accent, fontSize: 14, fontWeight: "700" },
  problemTitle: { color: theme.colors.text, fontSize: 16, fontWeight: "800", marginBottom: 6 },
  problem: { color: theme.colors.textMuted, fontSize: 15, lineHeight: 22 },
  note: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 17 },
  barHit: { height: 36, justifyContent: "center" },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: theme.colors.surfaceRaised, overflow: "hidden", justifyContent: "center" },
  barFill: { height: 6, backgroundColor: theme.colors.accent },
  times: { flexDirection: "row", justifyContent: "space-between" },
  time: { color: theme.colors.textMuted, fontSize: 12 },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: 4 },
  control: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  controlMain: { width: 72, height: 72, borderRadius: 36, backgroundColor: theme.colors.accent },
  volumeRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  volumeButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  volumeSlider: { flex: 1 },
  trackRow: { flexDirection: "row", gap: 10 },
  trackButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
  trackText: { flex: 1, gap: 2 },
  trackKind: { color: theme.colors.textMuted, fontSize: 11, fontWeight: "700" },
  trackValue: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  stop: { minHeight: 48, borderRadius: 24, borderWidth: 1, borderColor: theme.colors.border, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  stopText: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  sheetTitle: { color: theme.colors.text, fontSize: 16, fontWeight: "800", fontFamily: theme.font.family.display },
  sheetList: { gap: 8, paddingBottom: 8 },
  sheetRow: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sheetRowSelected: { borderColor: theme.colors.accent },
  sheetRowTitle: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  sheetRowTitleSelected: { color: theme.colors.accent },
  sheetRowNote: { color: theme.colors.textMuted, fontSize: 12 },
});
