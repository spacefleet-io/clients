/**
 * The app's sky behind every phone and TV screen (UX-SKY-04): the desktop's blue-navy ground, the app's nebula
 * (UX-SKY-03) and the hero's stars (UX-SKY-02), painted once per screen so no screen is left on a flat dark colour.
 *
 * - `MobileSkyLayer` paints the ground colour and, unless something inside paints its own sky, the sky. The app wraps
 *   its whole tree in one (sign-in gates, setup, loading screens) and every navigator screen in another
 *   (`MobileSkyScreenLayout`, the navigator's `screenLayout`).
 * - A screen that paints its own sky with the shooting stars (`MobileAppBackdrop`: the tab shell, the sign-in page,
 *   Parrot's pages) claims the nearest layer, which then skips its own sky, so one screen never runs two star fields.
 *   An inner layer claims the outer one the same way: under the navigator the app-wide sky stands down.
 * - Screens and the navigator are transparent over it (`mobileNavigationTheme`); the video player alone keeps black.
 */
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useMobileShellTheme } from "../theme";
import { MobileSkyPaint } from "./mobile-sky-paint";

type ClaimSky = () => () => void;

const SkyLayerContext = createContext<ClaimSky | null>(null);

/** Tells the nearest `MobileSkyLayer` that this component paints the sky itself, for as long as it is mounted. */
export const useClaimSkyLayer = (): void => {
  const claim = useContext(SkyLayerContext);
  useLayoutEffect(() => claim?.(), [claim]);
};

type MobileSkyLayerProps = {
  children: React.ReactNode;
  /** True while the screen is covered by another one: the stars stand still (UX-SKY-01). */
  paused?: boolean;
  style?: StyleProp<ViewStyle>;
};

export const MobileSkyLayer = ({ children, paused, style }: MobileSkyLayerProps) => {
  const theme = useMobileShellTheme();
  useClaimSkyLayer();
  const [owners, setOwners] = useState(0);
  const claim = useCallback<ClaimSky>(() => {
    setOwners((count) => count + 1);
    return () => setOwners((count) => count - 1);
  }, []);
  return (
    <SkyLayerContext.Provider value={claim}>
      <View style={[styles.fill, { backgroundColor: theme.colors.bg }, style]}>
        {owners === 0 ? <MobileSkyPaint paused={paused} /> : null}
        {children}
      </View>
    </SkyLayerContext.Provider>
  );
};

/** The part of a React Navigation screen's `navigation` the layout needs (kept structural: the shell has no navigation dependency). */
export type MobileSkyScreenNavigation = {
  isFocused: () => boolean;
  addListener: (type: "focus" | "blur", listener: () => void) => () => void;
};

/**
 * A navigator screen's sky, for the navigator's `screenLayout`: its own layer, still while another screen covers it.
 * `sky={false}` leaves a see-through screen (a sheet over the screen below) to draw its own.
 */
export const MobileSkyScreenLayout = ({
  navigation,
  sky = true,
  children,
}: {
  navigation: MobileSkyScreenNavigation;
  sky?: boolean;
  children: React.ReactNode;
}) => {
  const [focused, setFocused] = useState(() => navigation.isFocused());
  useEffect(() => {
    const offFocus = navigation.addListener("focus", () => setFocused(true));
    const offBlur = navigation.addListener("blur", () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);
  if (!sky) return <>{children}</>;
  return <MobileSkyLayer paused={!focused}>{children}</MobileSkyLayer>;
};

/** A React Navigation theme over the sky: no screen, card or header background paints over it (UX-SKY-04). */
export const mobileNavigationTheme = <T extends { dark: boolean; colors: Record<string, string> }>(
  base: T,
  colors: { text: string; accent: string; border: string },
): T => ({
  ...base,
  dark: true,
  colors: { ...base.colors, background: "transparent", card: "transparent", text: colors.text, primary: colors.accent, border: colors.border },
});

const styles = StyleSheet.create({ fill: { flex: 1 } });
