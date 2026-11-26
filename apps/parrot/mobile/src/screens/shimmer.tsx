// A plain pulsing block standing for a picture or text still on its way (PAR-META-20): loading never looks like
// "nothing there". The phone's take on the desktop's `animate-pulse` shimmer (@space/ui).
import React, { useEffect, useRef } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme";

export const SHIMMER_PULSE_MS = 700;

export const Shimmer = ({ style, testID }: { style?: StyleProp<ViewStyle>; testID?: string }) => {
  const opacity = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.9, duration: SHIMMER_PULSE_MS, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.45, duration: SHIMMER_PULSE_MS, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);
  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ backgroundColor: colors.surfaceRaised }, style, { opacity }]}
    />
  );
};
