import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import { useMobileShellTheme } from "../theme";

type MobileAuthBrandProps = {
  iconSource: ImageSourcePropType;
  /** The line under the mascot; the crash screen shows none. */
  subtitle?: string;
  /** Mascot width and height in dp (80 by default). The Badger phone draws it smaller (UX-PHONE-05). */
  size?: number;
};

/** One leg of the float: 3 s up by 10 pt, 3 s back, looped (the desktop `.animate-float`, 6 s). */
export const MOBILE_AUTH_BRAND_FLOAT = { distance: -10, legMs: 3000 } as const;

// The floating mascot over the sign-in, first-setup and whole-window crash screens, the same in every fleet app; the glow takes the app's
// accent. React Native's own Animated (native driver), not reanimated, so apps that do not ship reanimated (Parrot) can
// use it. It stands still when the system asks for reduced motion (UX-A11Y-03; on Android that is also animator scale 0):
// a native-driver loop runs its own frame callback whatever the animator scale, so it kept the sign-in from ever going
// idle. Still until the OS has answered, so no loop starts before it.
export const MobileAuthBrand = ({ iconSource, subtitle, size = 80 }: MobileAuthBrandProps) => {
  const theme = useMobileShellTheme();
  const translateY = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let live = true;
    const set = (enabled: boolean) => {
      if (live) setReduceMotion(enabled);
    };
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", set);
    AccessibilityInfo.isReduceMotionEnabled().then(set, () => set(false));
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      translateY.setValue(0);
      return undefined;
    }
    const leg = (toValue: number) =>
      Animated.timing(translateY, {
        toValue,
        duration: MOBILE_AUTH_BRAND_FLOAT.legMs,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      });
    const loop = Animated.loop(Animated.sequence([leg(MOBILE_AUTH_BRAND_FLOAT.distance), leg(0)]));
    loop.start();
    return () => loop.stop();
  }, [translateY, reduceMotion]);

  return (
    <View style={styles.brandWrap}>
      <Animated.View style={{ transform: [{ translateY }] }}>
        <Image source={iconSource} style={[styles.brandIcon, { width: size, height: size, shadowColor: theme.colors.accent }]} resizeMode="contain" />
      </Animated.View>
      {subtitle ? <Text style={[styles.brandSubtitle, { color: theme.colors.textMuted }]}>{subtitle}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  brandWrap: {
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  brandIcon: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 30,
  },
  brandSubtitle: {
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 2.2,
  },
});
