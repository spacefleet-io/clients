import React from "react";
import { Image, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { useMobileShellTheme } from "../theme";
import { SkyCover } from "./mobile-sky-cover";

type MobileEmptyStateProps = {
  title: string;
  subtitle: string;
  imageSource?: ImageSourcePropType;
  /**
   * Multiplies every size (text, gaps, fade height). 1 on phones; the TV passes its screen scale so an Apple TV
   * (1920x1080 points) draws it as large as an Android TV (960x540 dp) does (UX-TV-13).
   */
  scale?: number;
};

export const MobileEmptyState = ({ title, subtitle, imageSource, scale = 1 }: MobileEmptyStateProps) => {
  const theme = useMobileShellTheme();
  const styles = stylesFor(scale);
  const titleOpacity = useSharedValue(0.85);

  React.useEffect(() => {
    titleOpacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.85, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, [titleOpacity]);

  const titleAnimatedStyle = useAnimatedStyle(() => ({
    opacity: titleOpacity.value,
  }));

  return (
    <SkyCover style={styles.emptyState}>
      {imageSource ? (
        <View style={styles.bannerWrap}>
          <Image source={imageSource} style={styles.banner} resizeMode="cover" />
          <View style={styles.bannerOverlay} />
          {/* Bottom fade gradient approximation using multiple semi-transparent strips */}
          <View style={styles.bannerFadeBottom}>
            <View style={[styles.fadeStrip, { opacity: 0.3, backgroundColor: theme.colors.bg }]} />
            <View style={[styles.fadeStrip, { opacity: 0.6, backgroundColor: theme.colors.bg }]} />
            <View style={[styles.fadeStrip, { opacity: 0.85, backgroundColor: theme.colors.bg }]} />
            <View style={[styles.fadeStrip, { opacity: 1, backgroundColor: theme.colors.bg }]} />
          </View>
        </View>
      ) : null}
      <View style={styles.copyWrap}>
        <Animated.Text
          style={[
            styles.title,
            {
              color: theme.colors.text,
              fontFamily: theme.font.family.display,
              textShadowColor: `${theme.colors.accent}33`,
              textShadowOffset: { width: 0, height: 0 },
              textShadowRadius: 20 * scale,
            },
            titleAnimatedStyle,
          ]}
        >
          {title.toUpperCase()}
        </Animated.Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{subtitle}</Text>
      </View>
    </SkyCover>
  );
};

const makeStyles = (s: number) =>
  StyleSheet.create({
    emptyState: {
      flex: 1,
      justifyContent: "center",
    },
    bannerWrap: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: "55%",
      overflow: "hidden",
    },
    banner: {
      width: "100%",
      height: "100%",
      opacity: 0.82,
    },
    bannerOverlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(13,17,23,0.18)",
    },
    bannerFadeBottom: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      height: 80 * s,
      flexDirection: "column",
    },
    fadeStrip: {
      flex: 1,
    },
    copyWrap: {
      marginTop: "20%",
      alignItems: "center",
      paddingHorizontal: 28 * s,
      gap: 10 * s,
    },
    title: {
      fontSize: 26 * s,
      fontWeight: "800",
      letterSpacing: 1.5 * s,
      textAlign: "center",
    },
    subtitle: {
      fontSize: 14 * s,
      lineHeight: 21 * s,
      textAlign: "center",
      maxWidth: 280 * s,
    },
  });

/** One sheet per scale, built on first use (phones and Android TV only ever ask for 1). */
const sheets = new Map<number, ReturnType<typeof makeStyles>>();
const stylesFor = (scale: number) => {
  let sheet = sheets.get(scale);
  if (!sheet) {
    sheet = makeStyles(scale);
    sheets.set(scale, sheet);
  }
  return sheet;
};
