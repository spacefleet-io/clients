// The floating mini player above the tab bar while a song is queued (PAR-LOOK-01): the album art, the title over the
// artist, the output switcher (Android 11+), a round green play/pause, a thin green line for the position, and a tap
// opens the player.
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Cast, Pause, Play } from "lucide-react-native";
import { AudioPlayback, showsPause } from "@space/mobile-audio-playback";
import { parrotCoverThumbKey } from "@space/parrot-core";
import { useTranslation } from "@space/mobile-shell/i18n";
import { nowPlayingTitles } from "../lib/nowPlaying";
import { usePlayerState } from "../state/usePlayerState";
import { colors, spacing } from "../theme";
import { ParrotArt } from "./art";

export const NowPlayingBar = ({ onOpen }: { onOpen: () => void }) => {
  const state = usePlayerState(1000);
  const { t } = useTranslation();
  const [canCast, setCanCast] = useState(false);
  useEffect(() => {
    let live = true;
    AudioPlayback.canShowOutputSwitcher().then(
      (yes) => live && setCanCast(yes),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);
  if (!state?.mediaId) return null;
  const meta = nowPlayingTitles.get(state.mediaId);
  const progress = state.durationMs > 0 ? Math.min(1, state.positionMs / state.durationMs) : 0;
  return (
    <View style={styles.dock}>
      <View style={styles.card} testID="mini-player">
        <Pressable accessibilityRole="button" accessibilityLabel={t("parrot.player.open")} onPress={onOpen} style={styles.row}>
          <ParrotArt seed={meta?.albumId ?? state.mediaId} size={40} radius={8} coverKey={meta?.cover ? parrotCoverThumbKey(meta.cover) : null} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              {meta?.title ?? t("parrot.player.playing")}
            </Text>
            {meta?.artist ? (
              <Text style={styles.meta} numberOfLines={1}>
                {meta.artist}
              </Text>
            ) : null}
          </View>
          {canCast ? (
            <Pressable
              testID="mini-player-cast"
              accessibilityRole="button"
              accessibilityLabel={t("parrot.player.output")}
              hitSlop={8}
              onPress={() => void AudioPlayback.showOutputSwitcher()}
              style={styles.cast}
            >
              <Cast color={colors.textMuted} size={20} />
            </Pressable>
          ) : null}
          <Pressable
            testID="mini-player-toggle"
            accessibilityRole="button"
            accessibilityLabel={showsPause(state) ? t("player.controls.pause") : t("player.controls.play")}
            hitSlop={12}
            onPress={() => void (showsPause(state) ? AudioPlayback.pause() : AudioPlayback.play())}
            style={styles.toggle}
          >
            {showsPause(state) ? <Pause color={colors.accentText} fill={colors.accentText} size={18} /> : <Play color={colors.accentText} fill={colors.accentText} size={18} />}
          </Pressable>
        </Pressable>
        <View style={styles.track}>
          <View style={[styles.progress, { width: `${progress * 100}%` }]} />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  dock: { paddingHorizontal: 10, paddingBottom: 10, paddingTop: 4 },
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: 14,
    overflow: "hidden",
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: 10, height: 60 },
  title: { color: colors.text, fontSize: 14, fontWeight: "700" },
  meta: { color: colors.textMuted, fontSize: 12 },
  cast: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  toggle: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  track: { height: 2, backgroundColor: colors.surface },
  progress: { height: 2, backgroundColor: colors.accent },
});
