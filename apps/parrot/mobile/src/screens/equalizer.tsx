// The playing marks on the phone (PAR-LOOK-01): three bars that bounce while the music plays, the same as the web
// player's and the desktop's `ParrotEqualizer` (@space/ui/parrot, CSS there), and the green badge holding them on the
// tile of the album that plays. React Native's own Animated (native driver); still when the phone asks for less motion.
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme";

/** The bars' heights and bounce, as in `@space/ui/parrot`'s CSS (a test fails when the two differ). */
export const PARROT_EQUALIZER = {
  heights: [6, 12, 9],
  /** One bounce: down to `low` of the height, up, down again. */
  periodMs: 900,
  low: 0.45,
  /** Bar i starts `i * stepMs` into the bounce (CSS `animation-delay: -300ms`, `-600ms`). */
  stepMs: 300,
} as const;

/**
 * The bar's height factor over one bounce, as `interpolate` input/output points: `low` at the bounce's start and end,
 * full height halfway, moved forward by the bar's head start (`offset`, a share of the bounce).
 */
export const equalizerKeyframes = (offset: number): { inputRange: number[]; outputRange: number[] } => {
  const { low } = PARROT_EQUALIZER;
  const at = (phase: number) => low + (1 - low) * (1 - Math.abs(2 * phase - 1));
  const points = new Map<number, number>([
    [0, at(offset % 1)],
    [1, at(offset % 1)],
    [(1 - offset) % 1, low],
    [(1.5 - offset) % 1, 1],
  ]);
  const inputRange = [...points.keys()].sort((a, b) => a - b);
  return { inputRange, outputRange: inputRange.map((t) => points.get(t)!) };
};

/** Follows the phone's "remove animations" setting. */
const useReduceMotion = () => {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => live && setReduce(value));
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduce;
};

export const ParrotEqualizer = ({ animated = false, color = colors.accent }: { animated?: boolean; color?: string }) => {
  const clock = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();
  const moving = animated && !reduceMotion;
  useEffect(() => {
    if (!moving) return undefined;
    clock.setValue(0);
    const loop = Animated.loop(Animated.timing(clock, { toValue: 1, duration: PARROT_EQUALIZER.periodMs, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [clock, moving]);
  return (
    <View testID="parrot-equalizer" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.eq}>
      {PARROT_EQUALIZER.heights.map((height, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            { height, backgroundColor: color },
            moving ? { transform: [{ scaleY: clock.interpolate(equalizerKeyframes((i * PARROT_EQUALIZER.stepMs) / PARROT_EQUALIZER.periodMs)) }] } : null,
          ]}
        />
      ))}
    </View>
  );
};

/** The green round badge in the bottom-right corner of the playing album's tile (the mockup's Low Orbit). */
export const PlayingBadge = ({ size, animated, style }: { size: number; animated: boolean; style?: StyleProp<ViewStyle> }) => {
  const badge = Math.min(32, Math.max(20, Math.round(size * 0.18)));
  return (
    <View testID="playing-badge" pointerEvents="none" style={[styles.badge, { width: badge, height: badge, borderRadius: badge / 2 }, style]}>
      <ParrotEqualizer animated={animated} color={colors.accentText} />
    </View>
  );
};

const styles = StyleSheet.create({
  eq: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 12 },
  bar: { width: 3, borderRadius: 1, transformOrigin: "bottom" },
  badge: {
    position: "absolute",
    right: "6%",
    bottom: "6%",
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
  },
});
