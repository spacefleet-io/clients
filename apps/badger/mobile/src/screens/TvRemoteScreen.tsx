import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft, AudioLines, Captions, Check, Pause, Play, RotateCcw, RotateCw, Square } from "lucide-react-native";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useAuth } from "../store/auth";
import { MobileIconButton } from "@space/mobile-shell/components";
import { BottomSheet } from "../components/BottomSheet";
import { usePickerSheet } from "../components/usePickerSheet";
import { createAppRelay } from "../lib/playOnTv/appRelay";
import { createPhoneRemote, REMOTE_SEEK_STEP_SECONDS, type PhoneRemote, type RemoteAction, type RemoteView } from "../lib/playOnTv/phoneRemote";
import { remoteStatusKey } from "../lib/playOnTv/remoteStatus";
import type { StartCommand, TvTrack } from "../lib/playOnTv/protocol";
import { tvRemoteMediaHandlers, tvRemoteMediaState } from "../lib/playback/osMediaSession";
import { useOsMediaSession } from "../lib/playback/useOsMediaSession";
import { useMediaImage } from "../lib/useMediaImage";
import { formatClock } from "@space/shared/format";
import { theme } from "../theme/theme";

type Params = { tvPeerId: string; tvName: string; title: string; start: StartCommand; posterPath?: string | null };

const log = (event: string, data: Record<string, unknown> = {}) => console.info(`tv.cast.phone.${event}`, JSON.stringify(data));

/**
 * The phone as the remote of a title it started on a TV app ("Play on TV", UX-TV-02): pause / play, 10 s back and
 * forward, audio and subtitle pick, stop. Everything shown comes from the TV's own state messages over the account's
 * sealed relay, so the phone and the TV need not share a network.
 */
export const TvRemoteScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { tvPeerId, tvName, title, start, posterPath } = useRoute().params as Params;
  const { token } = useAuth();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const remoteRef = useRef<PhoneRemote | null>(null);
  const [view, setView] = useState<RemoteView>({ status: "connecting", tv: null });
  const [noKey, setNoKey] = useState(false);
  const audioSheet = usePickerSheet();
  const subtitleSheet = usePickerSheet();

  useEffect(() => {
    let disposed = false;
    let remote: PhoneRemote | null = null;
    void (async () => {
      const relay = await createAppRelay("mobile", () => tokenRef.current);
      if (disposed) return;
      if (!relay) {
        setNoKey(true);
        return;
      }
      remote = createPhoneRemote({
        channel: relay.channel,
        registerSelf: () => relay.transport.register("mobile"),
        tvPeerId,
        log: (event, data) => log(event, data),
      });
      remoteRef.current = remote;
      remote.subscribe(setView);
      log("start", { episode: start.episodeId !== null, positionSeconds: start.positionSeconds });
      await remote.start(start);
    })();
    return () => {
      disposed = true;
      remote?.dispose();
      remoteRef.current = null;
    };
  }, [start, tvPeerId]);

  const send = useCallback((action: RemoteAction) => {
    log("send", { type: action.type });
    void remoteRef.current?.send(action);
  }, []);

  // The phone's notification-shade and lock-screen card and its headset buttons control what the TV plays
  // (PLAY-OSMEDIA-01 item 4), from the TV's own state; leaving this screen releases the card.
  const posterUrl = useMediaImage(posterPath ?? null, "poster");
  const osMediaState = useMemo(() => tvRemoteMediaState(view, title, posterUrl), [view, title, posterUrl]);
  useOsMediaSession(osMediaState, tvRemoteMediaHandlers(send));

  const retry = useCallback(() => {
    const remote = remoteRef.current;
    if (!remote) return;
    log("retry", { tvState: view.tv?.phase ?? null });
    // Nothing started yet on the TV: start again; else just ask the TV where it is.
    void (view.tv && view.tv.phase !== "failed" ? remote.resume() : remote.start(start));
  }, [start, view.tv]);

  const tv = view.tv;
  const statusKey = noKey ? "unreachable" : remoteStatusKey(view);
  const statusText = t(`playOnTv.remote.${statusKey}`, { name: tvName });
  const controlsEnabled = view.status === "connected" && (tv?.phase === "playing" || tv?.phase === "paused");
  const busy = !noKey && (view.status === "connecting" || view.status === "waiting" || tv?.phase === "loading");
  const canRetry = noKey ? false : view.status === "unreachable" || tv?.phase === "failed";
  const trackLabel = (track: TvTrack, index: number) => track.label ?? track.language ?? t("playOnTv.remote.trackFallback", { n: index + 1 });

  const pickTrack = (kind: "audio" | "subtitle", idx: number) => {
    const sheet = kind === "audio" ? audioSheet : subtitleSheet;
    sheet.close(() => send(kind === "audio" ? { type: "setAudio", idx } : { type: "setSubtitle", idx }));
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <MobileIconButton label={t("playOnTv.remote.close")} onPress={() => navigation.goBack()}>
          <ArrowLeft size={22} color={theme.colors.text} />
        </MobileIconButton>
        <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
          {tv?.title ?? title}
        </Text>
      </View>

      <View style={styles.body}>
        <View style={styles.statusBlock}>
          {busy ? <ActivityIndicator color={theme.colors.accent} /> : null}
          <Text testID="tv-remote-status" style={styles.status} accessibilityLiveRegion="polite">
            {statusText}
          </Text>
          {tv && controlsEnabled ? (
            <Text style={styles.position}>
              {t("playOnTv.remote.position", { position: formatClock(tv.positionSeconds), duration: formatClock(tv.durationSeconds) })}
            </Text>
          ) : null}
          {canRetry ? (
            <Pressable testID="tv-remote-retry" onPress={retry} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.action}>{t("playOnTv.remote.retry").toUpperCase()}</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.transport}>
          <RoundButton
            label={t("playOnTv.remote.back")}
            disabled={!controlsEnabled}
            onPress={() => send({ type: "seekBy", deltaSeconds: -REMOTE_SEEK_STEP_SECONDS })}
          >
            <RotateCcw size={26} color={theme.colors.text} />
          </RoundButton>
          <RoundButton
            big
            label={tv?.phase === "paused" ? t("playOnTv.remote.play") : t("playOnTv.remote.pause")}
            disabled={!controlsEnabled}
            onPress={() => {
              log("send", { type: "toggle", from: tv?.phase ?? null });
              void remoteRef.current?.togglePause();
            }}
          >
            {tv?.phase === "paused" ? (
              <Play size={34} color={theme.colors.bg} fill={theme.colors.bg} />
            ) : (
              <Pause size={34} color={theme.colors.bg} fill={theme.colors.bg} />
            )}
          </RoundButton>
          <RoundButton
            label={t("playOnTv.remote.forward")}
            disabled={!controlsEnabled}
            onPress={() => send({ type: "seekBy", deltaSeconds: REMOTE_SEEK_STEP_SECONDS })}
          >
            <RotateCw size={26} color={theme.colors.text} />
          </RoundButton>
        </View>

        <View style={styles.row}>
          <PillButton
            label={t("playOnTv.remote.audio")}
            disabled={!controlsEnabled || (tv?.audioTracks.length ?? 0) < 2}
            onPress={audioSheet.open}
          >
            <AudioLines size={18} color={theme.colors.text} />
          </PillButton>
          <PillButton label={t("playOnTv.remote.subtitles")} disabled={!controlsEnabled} onPress={subtitleSheet.open}>
            <Captions size={18} color={theme.colors.text} />
          </PillButton>
          <PillButton
            label={t("playOnTv.remote.stop")}
            disabled={!controlsEnabled}
            onPress={() => send({ type: "stop" })}
          >
            <Square size={16} color={theme.colors.text} />
          </PillButton>
        </View>
      </View>

      <BottomSheet sheet={audioSheet} testID="tv-remote-audio">
        <Text style={styles.sheetTitle}>{t("playOnTv.remote.audio")}</Text>
        <MobileSheetScrollView contentContainerStyle={styles.sheetList}>
          {(tv?.audioTracks ?? []).map((track, index) => (
            <TrackRow key={track.idx} label={trackLabel(track, index)} active={tv?.audioIdx === track.idx} onPress={() => pickTrack("audio", track.idx)} />
          ))}
        </MobileSheetScrollView>
      </BottomSheet>

      <BottomSheet sheet={subtitleSheet} testID="tv-remote-subtitles">
        <Text style={styles.sheetTitle}>{t("playOnTv.remote.subtitles")}</Text>
        <MobileSheetScrollView contentContainerStyle={styles.sheetList}>
          <TrackRow label={t("playOnTv.remote.subtitlesOff")} active={tv?.subtitleIdx === -1} onPress={() => pickTrack("subtitle", -1)} />
          {(tv?.subtitleTracks ?? []).map((track, index) => (
            <TrackRow
              key={track.idx}
              label={trackLabel(track, index)}
              active={tv?.subtitleIdx === track.idx}
              onPress={() => pickTrack("subtitle", track.idx)}
            />
          ))}
        </MobileSheetScrollView>
      </BottomSheet>
    </SafeAreaView>
  );
};

const RoundButton = ({
  label,
  disabled,
  onPress,
  big,
  children,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  big?: boolean;
  children: React.ReactNode;
}) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    style={[styles.round, big && styles.roundBig, disabled && styles.disabled]}
  >
    {children}
  </Pressable>
);

const PillButton = ({ label, disabled, onPress, children }: { label: string; disabled: boolean; onPress: () => void; children: React.ReactNode }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    style={[styles.pill, disabled && styles.disabled]}
  >
    {children}
    <Text style={styles.pillText}>{label}</Text>
  </Pressable>
);

const TrackRow = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
  <Pressable style={styles.trackRow} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }}>
    <Text style={styles.trackName} numberOfLines={1}>
      {label}
    </Text>
    {active ? <Check size={16} color={theme.colors.accent} /> : null}
  </Pressable>
);

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  title: { flex: 1, fontSize: 20, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  body: { flex: 1, justifyContent: "center", gap: 40 },
  statusBlock: { alignItems: "center", gap: 10, minHeight: 110, justifyContent: "center" },
  status: { fontSize: 16, lineHeight: 22, fontWeight: "700", color: theme.colors.text, textAlign: "center" },
  position: { fontSize: 14, color: theme.colors.textMuted, fontVariant: ["tabular-nums"] },
  action: { color: theme.colors.accent, fontSize: 12, letterSpacing: 1.1, fontWeight: "800" },
  transport: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 28 },
  round: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.colors.surface,
    justifyContent: "center",
    alignItems: "center",
  },
  roundBig: { width: 88, height: 88, borderRadius: 44, backgroundColor: theme.colors.accent },
  disabled: { opacity: 0.4 },
  row: { flexDirection: "row", justifyContent: "center", gap: 10, flexWrap: "wrap" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
    backgroundColor: theme.colors.surface,
  },
  pillText: { color: theme.colors.text, fontSize: 13, fontWeight: "700" },
  sheetTitle: { color: theme.colors.text, fontSize: 16, fontWeight: "800", fontFamily: theme.font.family.display, marginBottom: 12 },
  sheetList: { gap: 8, paddingBottom: 8 },
  trackRow: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
  },
  trackName: { color: theme.colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
});
