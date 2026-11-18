import React, { useCallback } from "react";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from "react-native-reanimated";
import { MobileButtonFace, type MobileButtonFaceProps } from "./mobile-button-face";

type MobileButtonProps = Omit<MobileButtonFaceProps, "onPressIn" | "onPressOut">;

const PRESS_SPRING = { damping: 15, stiffness: 350, mass: 0.3 };

export const MobileButton = (props: MobileButtonProps) => {
  const { disabled, loading } = props;
  const scale = useSharedValue(1);

  const onPressIn = useCallback(() => {
    if (!disabled && !loading) scale.value = withSpring(0.97, PRESS_SPRING);
  }, [disabled, loading, scale]);

  const onPressOut = useCallback(() => {
    scale.value = withSpring(1, PRESS_SPRING);
  }, [scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View style={animatedStyle}>
      <MobileButtonFace {...props} onPressIn={onPressIn} onPressOut={onPressOut} />
    </Animated.View>
  );
};
