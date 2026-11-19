import React, { useMemo, useState } from "react";
import {
  Image,
  ScrollView,
  StyleSheet,
  View,
  type ImageSourcePropType,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileShellTheme } from "../theme";
import { KeyboardAvoidingForm } from "../keyboard";
import MobileAppBackdrop from "./mobile-app-backdrop";
import MobilePosterWaterfall from "./mobile-poster-waterfall";
import { SkyCover, SkyCoversProvider } from "./mobile-sky-cover";
import { createSkyCoverRegistry, createSkyScrollHandlers } from "./mobile-sky-covers";
import { createUserInputSignal } from "./mobile-user-input";
import { useSkyRemoteInput } from "./use-sky-remote-input";

type MobileStartupPageProps = {
  backgroundSource?: ImageSourcePropType;
  waterfallPosters?: string[];
  controls?: React.ReactNode;
  /** Pinned under the scrolling form, above the keyboard: the sign-in's setup Back (`MobileSetupBackFooter`, UX-SETUP-08). */
  footer?: React.ReactNode;
  children: React.ReactNode;
};

export const MobileStartupPage = ({ backgroundSource, waterfallPosters, controls, footer, children }: MobileStartupPageProps) => {
  const theme = useMobileShellTheme();
  const insets = useSafeAreaInsets();
  const [input] = useState(createUserInputSignal);
  const [covers] = useState(createSkyCoverRegistry);
  const formScroll = useMemo(() => createSkyScrollHandlers(covers), [covers]);
  // TV sign-in pages: a remote key holds the sky still like a tap does on the phone (UX-SKY-01).
  useSkyRemoteInput(covers);
  const coveredSky = Boolean((waterfallPosters && waterfallPosters.length > 0) || backgroundSource);
  // Posters or a background image cover the sky: no shooting stars then (UX-SKY-02).
  const comets = useMemo(() => (coveredSky ? undefined : { input, covers }), [coveredSky, input, covers]);

  return (
    <SkyCoversProvider value={covers}>
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.colors.bg }]} {...input.touchHandlers}>
        <MobileAppBackdrop comets={comets} />
        {waterfallPosters && waterfallPosters.length > 0 ? (
          <MobilePosterWaterfall posters={waterfallPosters} />
        ) : backgroundSource ? (
          <View style={styles.backgroundWrap}>
            <Image source={backgroundSource} style={styles.background} resizeMode="cover" />
            <View style={[styles.backgroundOverlay, { backgroundColor: "rgba(13,17,23,0.84)" }]} />
          </View>
        ) : null}
        {controls ? <SkyCover style={[styles.controls, { top: insets.top + 8 }]}>{controls}</SkyCover> : null}

        <KeyboardAvoidingForm style={styles.keyboardWrap}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" {...formScroll}>
            <SkyCover style={styles.formShell}>{children}</SkyCover>
          </ScrollView>
          {footer}
        </KeyboardAvoidingForm>
      </SafeAreaView>
    </SkyCoversProvider>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  backgroundWrap: {
    ...StyleSheet.absoluteFill,
  },
  background: {
    width: "100%",
    height: "100%",
    opacity: 0.2,
  },
  backgroundOverlay: {
    ...StyleSheet.absoluteFill,
  },
  controls: {
    position: "absolute",
    right: 16,
    zIndex: 10,
    flexDirection: "row",
    gap: 10,
  },
  keyboardWrap: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingVertical: 28,
  },
  formShell: {
    gap: 14,
  },
});
