import React, { memo, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useMpvSubtitle } from "../hooks/useMpvSubtitle";
import { createOverlayLift } from "../subtitleLift";
import { overlayPaddingBottom, type SubtitleOverlayModel } from "../subtitleOverlay";

export type MpvSubtitleOverlayProps = {
  /** From `useMpvSubtitle`; `null` draws nothing. */
  subtitle: SubtitleOverlayModel | null;
};

/**
 * The subtitle line over the video under direct rendering (PLAT-TV-06): white, dark outline, bottom-centred inside the
 * letterboxed picture. Re-renders only when the line or the video rect changes.
 */
export const MpvSubtitleOverlay = memo(function MpvSubtitleOverlay({ subtitle }: MpvSubtitleOverlayProps) {
  if (!subtitle) return null;
  const known = subtitle.width > 0 && subtitle.height > 0;
  const paddingBottom = overlayPaddingBottom(subtitle);
  const frame = known
    ? { left: subtitle.x, top: subtitle.y, width: subtitle.width, height: subtitle.height, paddingBottom }
    : [StyleSheet.absoluteFill, { paddingBottom }];
  return (
    <View pointerEvents="none" style={[styles.box, frame]} testID="mpv-subtitle-overlay">
      <Text
        style={[styles.text, { fontSize: subtitle.fontSize, lineHeight: Math.round(subtitle.fontSize * 1.25) }]}
        accessibilityLiveRegion="polite"
      >
        {subtitle.text}
      </Text>
    </View>
  );
});

/** Lift into place when the controls appear (they show at once), ease back down once they have faded out. */
const LIFT_UP_MS = 120;
const LIFT_DOWN_MS = 250;

export type MpvSubtitleLayerProps = {
  /** Height (dp) of the player box the overlay is drawn in. */
  boxHeight: number;
  /** Distance (dp) from the box bottom to the top of the player controls while they show; 0 when hidden (MPV-OSC-02). */
  controlsInset: number;
  /** The controls' `uiScale` (UX-TV-13), applied to the gap above the controls. Default 1. */
  uiScale?: number;
};

/**
 * Subscribes to the native subtitle event; its own component so a new line re-renders only the overlay, not the video
 * view. While the controls show, the line moves up above them (MPV-OSC-02) and animates back when they hide.
 */
export const MpvSubtitleLayer = ({ boxHeight, controlsInset, uiScale = 1 }: MpvSubtitleLayerProps) => {
  const subtitle = useMpvSubtitle();
  const [liftTracker] = useState(createOverlayLift);
  const lift = liftTracker.next({ subtitle, boxHeight, controlsInset, scale: uiScale });
  const translateY = useRef(new Animated.Value(0)).current;
  const applied = useRef(0);
  useEffect(() => {
    if (lift === applied.current) return;
    console.info(`[mpv-subtitles] overlay lift ${applied.current} -> ${lift} dp (controls inset ${controlsInset} of ${boxHeight} dp)`);
    const duration = lift > applied.current ? LIFT_UP_MS : LIFT_DOWN_MS;
    applied.current = lift;
    Animated.timing(translateY, { toValue: -lift, duration, useNativeDriver: true }).start();
  }, [lift, controlsInset, boxHeight, translateY]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [{ translateY }] }]}>
      <MpvSubtitleOverlay subtitle={subtitle} />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  box: {
    position: "absolute",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: "6%",
  },
  text: {
    color: "#ffffff",
    textAlign: "center",
    fontWeight: "600",
    textShadowColor: "rgba(0, 0, 0, 0.95)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
});
