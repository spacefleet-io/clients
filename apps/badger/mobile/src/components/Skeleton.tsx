import React, { memo, useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, type ViewStyle } from "react-native";
import { SkyCover } from "@space/mobile-shell/components";
import { theme } from "../theme/theme";
import { POSTER_ASPECT, POSTER_FOOTER_HEIGHT } from "./PosterCard";

/** One native-driven opacity pulse shared by every block inside it (no JS-thread work per frame). */
export const SkeletonPulse = memo(({ children, style }: { children: React.ReactNode; style?: ViewStyle }) => {
  const opacity = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.55, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View style={[style, { opacity }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {children}
    </Animated.View>
  );
});
SkeletonPulse.displayName = "SkeletonPulse";

export const SkeletonBlock = ({ width, height, radius = 8, style }: { width: number | `${number}%`; height: number; radius?: number; style?: ViewStyle }) => (
  <View style={[{ width, height, borderRadius: radius, backgroundColor: theme.colors.surfaceRaised }, style]} />
);

/** Placeholder poster tiles in the exact geometry of `PosterCard`. */
export const PosterTileSkeleton = memo(({ width }: { width: number }) => (
  <View style={{ width }}>
    <SkeletonBlock width={width} height={Math.round(width * POSTER_ASPECT)} radius={12} />
    <SkeletonBlock width="70%" height={10} radius={5} style={styles.titleLine} />
  </View>
));
PosterTileSkeleton.displayName = "PosterTileSkeleton";

export const PosterGridSkeleton = memo(
  ({ columns, cardWidth, rows = 3, gap, rowGap = gap }: { columns: number; cardWidth: number; rows?: number; gap: number; rowGap?: number }) => (
  <SkeletonPulse style={{ gap: rowGap }}>
    {Array.from({ length: rows }, (_, row) => (
      <SkyCover key={row} style={[styles.row, { gap, height: Math.round(cardWidth * POSTER_ASPECT) + POSTER_FOOTER_HEIGHT }]}>
        {Array.from({ length: columns }, (_, col) => (
          <PosterTileSkeleton key={col} width={cardWidth} />
        ))}
      </SkyCover>
    ))}
  </SkeletonPulse>
  ),
);
PosterGridSkeleton.displayName = "PosterGridSkeleton";

export const PosterRailSkeleton = memo(({ cardWidth, count = 3 }: { cardWidth: number; count?: number }) => (
  <SkeletonPulse style={styles.rail}>
    {Array.from({ length: count }, (_, i) => (
      <PosterTileSkeleton key={i} width={cardWidth} />
    ))}
  </SkeletonPulse>
));
PosterRailSkeleton.displayName = "PosterRailSkeleton";

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  rail: { flexDirection: "row", gap: 14 },
  titleLine: { marginTop: 12 },
});
