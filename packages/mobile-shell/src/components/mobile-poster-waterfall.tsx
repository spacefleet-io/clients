import React, { memo, useMemo } from "react";
import { Dimensions, Image, StyleSheet, View } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";

type MobilePosterWaterfallProps = {
  posters: string[];
};

const POSTER_W = 90;
const POSTER_H = POSTER_W * 1.5;
const POSTER_GAP = 10;
const POSTER_SLOT = POSTER_W + POSTER_GAP;

const ROW_1_DURATION = 40_000;
const ROW_2_DURATION = 50_000;

const WaterfallRow = memo(
  ({ posters, duration, reverse }: { posters: string[]; duration: number; reverse?: boolean }) => {
    const tripled = useMemo(() => [...posters, ...posters, ...posters], [posters]);
    const totalWidth = posters.length * POSTER_SLOT;
    const translateX = useSharedValue(reverse ? -totalWidth : 0);

    React.useEffect(() => {
      const from = reverse ? -totalWidth : 0;
      const to = reverse ? 0 : -totalWidth;
      translateX.value = withRepeat(
        withSequence(
          withTiming(from, { duration: 0 }),
          withTiming(to, { duration, easing: Easing.linear }),
        ),
        -1,
      );
    }, [duration, reverse, totalWidth, translateX]);

    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: translateX.value }],
    }));

    return (
      <Animated.View style={[styles.row, animatedStyle]}>
        {tripled.map((uri, i) => (
          <Image
            key={`${i}`}
            source={{ uri }}
            style={styles.poster}
            resizeMode="cover"
          />
        ))}
      </Animated.View>
    );
  },
);

WaterfallRow.displayName = "WaterfallRow";

function MobilePosterWaterfall({ posters }: MobilePosterWaterfallProps) {
  if (posters.length === 0) return null;

  const { height } = Dimensions.get("window");

  return (
    <View style={[StyleSheet.absoluteFill, styles.container]} pointerEvents="none">
      <View style={styles.rotatedWrap}>
        <WaterfallRow posters={posters} duration={ROW_1_DURATION} />
        <WaterfallRow posters={posters} duration={ROW_2_DURATION} reverse />
      </View>
      {/* Dark overlays to feather edges */}
      <View style={[styles.fadeTop, { height: height * 0.35 }]} />
      <View style={[styles.fadeBottom, { height: height * 0.35 }]} />
    </View>
  );
}

export default memo(MobilePosterWaterfall);

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
    opacity: 0.2,
  },
  rotatedWrap: {
    flex: 1,
    justifyContent: "center",
    gap: POSTER_GAP,
    transform: [{ rotate: "14deg" }, { scale: 1.25 }],
  },
  row: {
    flexDirection: "row",
    gap: POSTER_GAP,
  },
  poster: {
    width: POSTER_W,
    height: POSTER_H,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  fadeTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(13,17,23,0.8)",
  },
  fadeBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(13,17,23,0.8)",
  },
});
