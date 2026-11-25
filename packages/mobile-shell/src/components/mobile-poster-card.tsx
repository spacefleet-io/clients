import React, { useCallback } from "react";
import { Image, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from "react-native-reanimated";
import { useMobileShellTheme } from "../theme";

type MobilePosterCardProps = {
  title: string;
  meta?: string;
  posterUri?: string | null;
  progressPct?: number;
  showProgress?: boolean;
  onPress: () => void;
  width?: number;
  style?: ViewStyle;
};

const PRESS_SPRING = { damping: 15, stiffness: 300, mass: 0.4 };

export const MobilePosterCard = ({
  title,
  meta,
  posterUri,
  progressPct = 0,
  showProgress = false,
  onPress,
  width,
  style,
}: MobilePosterCardProps) => {
  const theme = useMobileShellTheme();
  const scale = useSharedValue(1);

  const onPressIn = useCallback(() => {
    scale.value = withSpring(0.95, PRESS_SPRING);
  }, [scale]);

  const onPressOut = useCallback(() => {
    scale.value = withSpring(1, PRESS_SPRING);
  }, [scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View style={[width ? { width } : undefined, style, animatedStyle]}>
      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onPress={onPress}
      >
        <View style={styles.posterFrame}>
          {posterUri ? (
            <Image source={{ uri: posterUri }} style={styles.posterImage} />
          ) : (
            <View style={[styles.posterFallback, { backgroundColor: theme.colors.surface }]} />
          )}
          {showProgress && progressPct > 0 ? (
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.min(100, progressPct)}%`,
                    backgroundColor: theme.colors.accent,
                    shadowColor: theme.colors.accent,
                    shadowOffset: { width: 0, height: 0 },
                    shadowOpacity: 0.8,
                    shadowRadius: 6,
                    elevation: 4,
                  },
                ]}
              />
            </View>
          ) : null}
        </View>
        <Text
          style={[
            styles.title,
            {
              color: theme.colors.text,
              fontFamily: theme.font.family.sans,
            },
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {meta ? (
          <Text style={[styles.meta, { color: theme.colors.textDim }]}>{meta.toUpperCase()}</Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  posterFrame: {
    aspectRatio: 2 / 3,
    borderRadius: 20,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
    backgroundColor: "#242638",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  posterImage: {
    width: "100%",
    height: "100%",
  },
  posterFallback: {
    flex: 1,
  },
  progressTrack: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  progressFill: {
    height: "100%",
  },
  title: {
    fontWeight: "700",
    fontSize: 12,
    marginTop: 8,
  },
  meta: {
    fontSize: 11,
    letterSpacing: 1,
    marginTop: 3,
  },
});
