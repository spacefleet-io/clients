import React, { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  StyleSheet,
  Text,
  View,
  type ImageErrorEvent,
  type ImageResizeMode,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Film, UserRound } from "lucide-react-native";
import { ARTWORK_SPINNER_DELAY_MS, type ArtworkSource } from "@space/shared/artworkImage";
import { useArtworkState } from "@space/shared/useArtworkState";
import { useMobileShellTheme } from "../theme";

/** How long a loaded picture takes to fade in over the placeholder, on the native driver. */
export const MOBILE_ARTWORK_FADE_MS = 200;

// One reduced-motion subscription for every tile on screen (a grid holds hundreds), not one each. It starts at
// "reduced" until the OS answers, so no spinner turns before the setting is known.
let reduceMotion = true;
let reduceMotionWatched = false;
const reduceMotionListeners = new Set<() => void>();
const setReduceMotion = (enabled: boolean) => {
  if (enabled === reduceMotion) return;
  reduceMotion = enabled;
  for (const listener of reduceMotionListeners) listener();
};
const subscribeReduceMotion = (listener: () => void) => {
  if (!reduceMotionWatched) {
    reduceMotionWatched = true;
    AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion, () => setReduceMotion(false));
  }
  reduceMotionListeners.add(listener);
  return () => void reduceMotionListeners.delete(listener);
};
const readReduceMotion = () => reduceMotion;

export type MobileArtworkImageProps = {
  /** Where the picture stands, from the app's artwork hook. Key the tile by the artwork path. */
  source: ArtworkSource;
  /** The tile box (size, corners); the picture always fills it. */
  style?: StyleProp<ViewStyle>;
  resizeMode?: ImageResizeMode;
  /** Shown with the icon when there is no picture: the title, so the tile still says what it is. */
  label?: string;
  /** The fallback's icon: a film for posters and stills, a person for cast faces. */
  icon?: "film" | "person";
  /** A backdrop behind a page: only fades in, never shows a spinner or a fallback. */
  decorative?: boolean;
  /** Drawn instead of the icon and label when there is no picture (a cast face's initials). */
  fallback?: React.ReactNode;
  /** Also told when the picture fails to draw (the app's image-error log). */
  onImageError?: (event: ImageErrorEvent) => void;
  testID?: string;
};

/**
 * The small loading mark centred on a picture's placeholder (UX-WAIT-03): the platform's own `ActivityIndicator`
 * (animated natively, no script per frame), a still ring under reduced motion. It appears only after
 * `ARTWORK_SPINNER_DELAY_MS`, so a picture already on the device never flashes it. Mount it while the picture is awaited.
 */
export const MobileArtworkSpinner = memo(function MobileArtworkSpinner() {
  const theme = useMobileShellTheme();
  const reduced = useSyncExternalStore(subscribeReduceMotion, readReduceMotion);
  const [due, setDue] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDue(true), ARTWORK_SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!due) return null;
  return (
    <View style={styles.center} pointerEvents="none" testID="artwork-spinner">
      {reduced ? (
        <View style={[styles.ring, { borderColor: theme.colors.textMuted }]} />
      ) : (
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
      )}
    </View>
  );
});

/**
 * One poster, still or face of the phone and TV apps (UX-WAIT-03): `MobileArtworkSpinner` on the placeholder while the
 * picture comes, the picture faded in once drawn, and an icon with the title when there is none, it would not load, or
 * it took too long; never a plain dark box. The image view stays inaccessible: the card around it names the title.
 */
function MobileArtworkImageInner({
  source,
  style,
  resizeMode = "cover",
  label,
  icon = "film",
  decorative = false,
  fallback,
  onImageError,
  testID = "artwork-image",
}: MobileArtworkImageProps) {
  const theme = useMobileShellTheme();
  const { state, onLoad, onError } = useArtworkState(source);
  const { phase, url } = state;
  const opacity = useRef(new Animated.Value(phase === "loaded" ? 1 : 0)).current;
  const reduced = useSyncExternalStore(subscribeReduceMotion, readReduceMotion);

  useEffect(() => {
    if (phase !== "loaded") {
      opacity.setValue(0);
      return undefined;
    }
    const fade = Animated.timing(opacity, { toValue: 1, duration: reduced ? 0 : MOBILE_ARTWORK_FADE_MS, useNativeDriver: true });
    fade.start();
    return () => fade.stop();
  }, [phase, reduced, opacity]);

  const Icon = icon === "person" ? UserRound : Film;
  return (
    <View style={[styles.box, !decorative && { backgroundColor: theme.colors.surface }, style]} testID={testID} accessible={false}>
      {url ? (
        <Animated.Image
          source={{ uri: url }}
          style={[StyleSheet.absoluteFill, { opacity }]}
          resizeMode={resizeMode}
          // Android decodes at the tile's size, not the file's: a grid of full-size posters would fill the memory.
          resizeMethod="resize"
          fadeDuration={0}
          accessible={false}
          onLoad={() => onLoad(url)}
          onError={(event: ImageErrorEvent) => {
            onError(url);
            onImageError?.(event);
          }}
        />
      ) : null}
      {phase === "loading" && !decorative ? <MobileArtworkSpinner /> : null}
      {phase === "failed" && !decorative ? (
        <View style={[styles.center, styles.fallback]} pointerEvents="none" testID="artwork-fallback">
          {fallback ?? (
            <>
              <Icon size={24} color={theme.colors.textMuted} strokeWidth={1.75} />
              {label ? (
                <Text style={[styles.label, { color: theme.colors.textMuted, fontFamily: theme.font.family.sans }]} numberOfLines={3}>
                  {label}
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

export const MobileArtworkImage = memo(MobileArtworkImageInner);

const styles = StyleSheet.create({
  box: { overflow: "hidden" },
  center: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  fallback: { padding: 8, gap: 6 },
  ring: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, opacity: 0.6 },
  label: { fontSize: 12, fontWeight: "600", lineHeight: 16, textAlign: "center" },
});
