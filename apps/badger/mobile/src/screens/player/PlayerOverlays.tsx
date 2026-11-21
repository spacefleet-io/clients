import React, { useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { theme } from "../../theme/theme";
import { ensureI18n } from "../../lib/uiLanguage";
import { formatClock } from "@space/shared/format";
import type { PillAction } from "../../lib/playback/skipMarkers";
import { useMediaImage } from "../../lib/useMediaImage";
import { IS_TV } from "../../tv/lib/tvRuntime";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { useTvScale } from "@space/mobile-shell/tv/tvScale";
import { scaleStyleSheet } from "@space/shared/uiScale";
import { LaunchingMascot } from "../../components/LaunchingMascot";

const TARGET = 48;

/**
 * The overlays' sheet for this device: on TV at the window's scale (UX-TV-13; 2 on an Apple TV's 1920x1080 points),
 * on phones the sheet itself. Shared by every overlay so phone and TV stay in lockstep.
 */
const useOverlayStyles = () => {
  const scale = useTvScale();
  return scaleStyleSheet(baseStyles, IS_TV ? scale : 1);
};

type PlayerButtonProps = { primary?: boolean; testID: string; accessibilityLabel: string; onPress: () => void; children: React.ReactNode };

/**
 * A prompt button: a plain Pressable on phones; on TV a focus-ringed `TvFocusable`, and the primary button takes the
 * remote's focus when the prompt appears (the D-pad has no other way to reach it).
 */
const PlayerButton = ({ primary = false, children, ...rest }: PlayerButtonProps) => {
  const styles = useOverlayStyles();
  return IS_TV ? (
    <TvFocusable {...rest} style={[styles.button, primary && styles.primary]} hasTVPreferredFocus={primary}>
      {children}
    </TvFocusable>
  ) : (
    <Pressable {...rest} accessibilityRole="button" style={primary ? [styles.button, styles.primary] : styles.button}>
      {children}
    </Pressable>
  );
};

/**
 * Centered wait shown before the first frame, while rebuffering and while seeking; `slow` adds the 30 s hint
 * (PLAY-ABR-03). Until the first frame (`launching`) it is the hovering badger of the launch screens (UX-WAIT-02);
 * afterwards a plain spinner over the picture.
 */
export const PlayerSpinner = ({ slow = false, launching = false }: { slow?: boolean; launching?: boolean }) => {
  const { t } = useTranslation();
  const styles = useOverlayStyles();
  const slowHint = slow ? (
    <Text style={styles.slowHint} testID="player-loading-slow">
      {t("player.loadingSlow")}
    </Text>
  ) : null;
  if (launching) return <LaunchingMascot testID="player-loading">{slowHint}</LaunchingMascot>;
  return (
    <View style={styles.spinnerWrap} pointerEvents="none" testID="player-loading">
      <ActivityIndicator size="large" color="#fff" />
      {slowHint}
    </View>
  );
};

/**
 * What the player shows from the moment it opens until the first video frame (PLAY-OPEN-01): the title's background
 * picture (else its poster, else the app's dark background) under a dark scrim, with the loading spinner on top.
 */
export const PlayerLoadingBackdrop = ({
  backdropPath,
  posterPath,
  children,
}: {
  backdropPath: string | null;
  posterPath: string | null;
  children?: React.ReactNode;
}) => {
  const styles = useOverlayStyles();
  const backdrop = useMediaImage(backdropPath, "backdrop");
  const poster = useMediaImage(backdropPath ? null : posterPath, "poster");
  const uri = backdrop ?? poster;
  return (
    <View style={styles.backdropWrap} testID="player-backdrop">
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" testID="player-backdrop-image" /> : null}
      <View style={styles.backdropScrim} />
      {children}
    </View>
  );
};

export const PlayerError = ({ message, onRetry, onClose }: { message: string; onRetry: () => void; onClose: () => void }) => {
  const { t } = useTranslation();
  const styles = useOverlayStyles();
  return (
    <View style={styles.fill} testID="player-error">
      <Text style={styles.errorTitle}>{t("player.error.title")}</Text>
      <Text style={styles.errorBody}>{message}</Text>
      <View style={styles.row}>
        <PlayerButton primary onPress={onRetry} testID="player-error-retry" accessibilityLabel={t("player.error.retry")}>
          <Text style={styles.primaryText}>{t("player.error.retry")}</Text>
        </PlayerButton>
        <PlayerButton onPress={onClose} testID="player-error-close" accessibilityLabel={t("player.error.close")}>
          <Text style={styles.buttonText}>{t("player.error.close")}</Text>
        </PlayerButton>
      </View>
    </View>
  );
};

/** Shown before playback starts when a position worth resuming exists (2 % / 15 s / 95 % rules). */
export const ResumePrompt = ({
  title,
  seconds,
  onResume,
  onStartOver,
}: {
  title: string;
  seconds: number;
  onResume: () => void;
  onStartOver: () => void;
}) => {
  const { t } = useTranslation();
  const styles = useOverlayStyles();
  const resumeLabel = t("player.resume.resumeAt", { time: formatClock(seconds) });
  return (
    <View style={styles.fill} testID="player-resume-prompt">
      <Text style={styles.errorTitle} numberOfLines={2}>{title}</Text>
      <View style={styles.row}>
        <PlayerButton primary onPress={onResume} testID="player-resume-continue" accessibilityLabel={resumeLabel}>
          <Text style={styles.primaryText}>{resumeLabel}</Text>
        </PlayerButton>
        <PlayerButton onPress={onStartOver} testID="player-resume-start-over" accessibilityLabel={t("player.resume.startOver")}>
          <Text style={styles.buttonText}>{t("player.resume.startOver")}</Text>
        </PlayerButton>
      </View>
    </View>
  );
};

/**
 * Skip intro / Skip credits / Next episode pill, with the auto-skip countdown when running. On TV it is a focus-ringed
 * button that already holds the remote's focus when it appears (UX-TV-01), so one OK skips; Back dismisses it.
 */
export const SkipPill = ({ action, onPress }: { action: PillAction; onPress: () => void }) => {
  const { t } = useTranslation();
  const styles = useOverlayStyles();
  const testID =
    action.kind === "skip_intro" ? "player-skip-intro" : action.kind === "skip_credits" ? "player-skip-credits" : "player-next-episode-pill";
  const showCountdown = action.autoSkip && action.countdown !== null;
  const label = t(action.labelKey);
  const text = (
    <Text style={styles.pillText}>
      {showCountdown ? t("player.skip.withCountdown", { label, seconds: Math.ceil(action.countdown ?? 0) }) : label}
    </Text>
  );
  return IS_TV ? (
    <TvFocusable style={styles.pill} onPress={onPress} testID={testID} accessibilityLabel={label} hasTVPreferredFocus>
      {text}
    </TvFocusable>
  ) : (
    <Pressable style={styles.pill} onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={label}>
      {text}
    </Pressable>
  );
};

/** "Up next" card with a countdown (autoplay on); tap plays it now, Cancel keeps watching the credits. */
export const NextEpisodeCard = ({
  label,
  countdown,
  onPlayNow,
  onCancel,
}: {
  label: string;
  countdown: number | null;
  onPlayNow: () => void;
  onCancel: () => void;
}) => {
  const { t } = useTranslation();
  const styles = useOverlayStyles();
  return (
    <View style={styles.card} testID="player-next-episode-card">
      <Text style={styles.cardKicker}>
        {countdown !== null ? t("player.nextCard.startsIn", { seconds: Math.ceil(countdown) }) : t("player.nextCard.upNext")}
      </Text>
      <Text style={styles.cardTitle} numberOfLines={2}>{label}</Text>
      <View style={styles.row}>
        <PlayerButton primary onPress={onPlayNow} testID="player-next-episode-now" accessibilityLabel={t("player.nextCard.playNowLabel")}>
          <Text style={styles.primaryText}>{t("player.nextCard.playNow")}</Text>
        </PlayerButton>
        <PlayerButton onPress={onCancel} testID="player-next-episode-cancel" accessibilityLabel={t("player.nextCard.cancel")}>
          <Text style={styles.buttonText}>{t("player.nextCard.cancel")}</Text>
        </PlayerButton>
      </View>
    </View>
  );
};

/**
 * "This phone isn't powerful enough" (spec PLAY-CODEC-03): shown once per playback when the device cannot play smoothly and
 * nothing lighter exists. Plain words, no codec names; playback keeps running underneath, the button only dismisses it.
 */
export const DeviceTooWeakNotice = ({ pinned, onKeepWatching }: { pinned: boolean; onKeepWatching: () => void }) => {
  const { t } = useTranslation();
  const styles = useOverlayStyles();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void ensureI18n().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!ready) return null;
  return (
    <View style={styles.card} testID="player-device-too-weak">
      <Text style={styles.cardTitle} testID="player-device-too-weak-message">
        {t(Platform.isTV ? "player.deviceTooWeak.messageTv" : "player.deviceTooWeak.message")}
      </Text>
      {pinned ? <Text style={styles.cardHint} testID="player-device-too-weak-hint">{t("player.deviceTooWeak.pinnedHint")}</Text> : null}
      <View style={styles.row}>
        <PlayerButton primary onPress={onKeepWatching} testID="player-device-too-weak-keep" accessibilityLabel={t("player.deviceTooWeak.keepWatching")}>
          <Text style={styles.primaryText}>{t("player.deviceTooWeak.keepWatching")}</Text>
        </PlayerButton>
      </View>
    </View>
  );
};

/**
 * "Too much traffic" (PLAY-QUAL-07): the silo holding the title is saturated and quality is held to `quality` until it
 * eases. Plain words; playback keeps running underneath, the button only dismisses the notice.
 */
export const TrafficCapNotice = ({ quality, onKeepWatching }: { quality: string; onKeepWatching: () => void }) => {
  const { t } = useTranslation();
  const styles = useOverlayStyles();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void ensureI18n().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!ready) return null;
  return (
    <View style={styles.card} testID="player-traffic-cap">
      <Text style={styles.cardTitle} testID="player-traffic-cap-message">{t("player.trafficCap.message", { quality })}</Text>
      <View style={styles.row}>
        <PlayerButton primary onPress={onKeepWatching} testID="player-traffic-cap-keep" accessibilityLabel={t("player.trafficCap.keepWatching")}>
          <Text style={styles.primaryText}>{t("player.trafficCap.keepWatching")}</Text>
        </PlayerButton>
      </View>
    </View>
  );
};

/** Design dp (phone sizes, and the TV's at 960x540); `useOverlayStyles` scales them on TV. */
const baseStyles = StyleSheet.create({
  backdropWrap: { ...StyleSheet.absoluteFill, backgroundColor: theme.colors.bg },
  backdropScrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.55)" },
  spinnerWrap: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  slowHint: { color: "#fff", fontSize: 14, textAlign: "center" },
  fill: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.88)",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  errorTitle: { color: "#fff", fontSize: 20, fontWeight: "700", textAlign: "center" },
  errorBody: { color: theme.colors.textMuted, fontSize: 15, textAlign: "center" },
  row: { flexDirection: "row", gap: 12, alignItems: "center" },
  button: {
    minHeight: TARGET,
    minWidth: TARGET,
    paddingHorizontal: 20,
    borderRadius: TARGET / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  primary: { backgroundColor: theme.colors.accent },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  primaryText: { color: "#1a1a1a", fontSize: 15, fontWeight: "700" },
  pill: {
    position: "absolute",
    right: 24,
    bottom: 96,
    minHeight: TARGET,
    paddingHorizontal: 20,
    borderRadius: TARGET / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(20,20,20,0.82)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  pillText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  card: {
    position: "absolute",
    right: 24,
    bottom: 96,
    maxWidth: 360,
    padding: 16,
    borderRadius: 16,
    gap: 8,
    backgroundColor: "rgba(20,20,20,0.9)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
  },
  cardKicker: { color: theme.colors.accent, fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  cardTitle: { color: "#fff", fontSize: 16, fontWeight: "600" },
  cardHint: { color: "rgba(255,255,255,0.72)", fontSize: 14 },
});
