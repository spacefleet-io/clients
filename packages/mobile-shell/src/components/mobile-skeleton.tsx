/**
 * The family's loading placeholder on the phone and TV: grey blocks in the shape of what is coming, pulsing together
 * (PAR-META-20: loading never looks like "nothing there"). One pulse drives every block inside it on the native
 * thread, so a screen full of placeholders costs one animation. The timing is the desktop's `animate-pulse`
 * (@space/ui): opacity 1 → 0.5 → 1 over 2 s, so Badger, Parrot, the desktop and the web player breathe alike.
 */
import React, { memo, useEffect, useRef } from "react";
import { Animated, Easing, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { useMobileShellTheme } from "../theme";

/** The pulse's one timing: each half of the 2 s cycle, and the opacity it dims to. */
export const MOBILE_SKELETON_PULSE = { halfMs: 1000, low: 0.5, high: 1 } as const;

const EASING = Easing.bezier(0.4, 0, 0.6, 1);

/** Pulses everything inside it; with no children it is itself one grey block (give it a size or a fill style). */
export const MobileSkeletonPulse = memo(
  ({ children, style, testID }: { children?: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) => {
    const theme = useMobileShellTheme();
    const opacity = useRef(new Animated.Value(MOBILE_SKELETON_PULSE.high)).current;
    useEffect(() => {
      const step = (toValue: number) =>
        Animated.timing(opacity, { toValue, duration: MOBILE_SKELETON_PULSE.halfMs, easing: EASING, useNativeDriver: true });
      const loop = Animated.loop(Animated.sequence([step(MOBILE_SKELETON_PULSE.low), step(MOBILE_SKELETON_PULSE.high)]));
      loop.start();
      return () => loop.stop();
    }, [opacity]);
    return (
      <Animated.View
        testID={testID}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[children == null && { backgroundColor: theme.colors.surfaceRaised }, style, { opacity }]}
      >
        {children}
      </Animated.View>
    );
  },
);
MobileSkeletonPulse.displayName = "MobileSkeletonPulse";

/** One grey placeholder block, drawn inside a `MobileSkeletonPulse`. */
export const MobileSkeletonBlock = ({
  width,
  height,
  radius = 8,
  style,
}: {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) => {
  const theme = useMobileShellTheme();
  return <View style={[{ width, height, borderRadius: radius, backgroundColor: theme.colors.surfaceRaised }, style]} />;
};
