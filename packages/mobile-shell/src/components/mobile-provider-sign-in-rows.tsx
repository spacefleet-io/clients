import React from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

/**
 * The Google, Apple and Microsoft sign-in buttons on a phone (ACCT-SIGNIN-05, sizes ACCT-SIGNIN-07), the React Native
 * twin of the website and desktop buttons (`@space/ui/provider-sign-in-rows`): one row of three equal columns, each a
 * square logo-only button 54 with radius 13 and the logo on a tile inset 7, the provider's name as a 13 caption under
 * it, outside the button (Apple's rule for a logo-only custom button: square). The button's accessibility label is the
 * full title from `label`. Google and Microsoft: our dark surface, white tile. Apple: black button, white logo on a
 * black tile. Only the providers passed in are drawn (the ones `GET /auth/providers` lists), so nothing shows while
 * none is configured. Shared by the Badger and Parrot phones.
 */

export type MobileSignInProviderId = "google" | "apple" | "microsoft";

/** Column order of ACCT-SIGNIN-05, whatever order the providers arrive in. */
const ROW_ORDER: Record<MobileSignInProviderId, number> = { google: 0, apple: 1, microsoft: 2 };

export const orderedMobileProviders = (providers: readonly string[]): MobileSignInProviderId[] =>
  providers
    .filter((provider): provider is MobileSignInProviderId => Object.hasOwn(ROW_ORDER, provider))
    .sort((a, b) => ROW_ORDER[a] - ROW_ORDER[b]);

const GoogleLogo = () => (
  <Svg viewBox="0 0 48 48" width={18} height={18}>
    <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </Svg>
);

const AppleLogo = () => (
  <Svg viewBox="0 0 814 1000" width={16} height={19}>
    <Path
      fill="#ffffff"
      d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"
    />
  </Svg>
);

const MicrosoftLogo = () => (
  <Svg viewBox="0 0 21 21" width={18} height={18}>
    <Rect x={1} y={1} width={9} height={9} fill="#F25022" />
    <Rect x={11} y={1} width={9} height={9} fill="#7FBA00" />
    <Rect x={1} y={11} width={9} height={9} fill="#00A4EF" />
    <Rect x={11} y={11} width={9} height={9} fill="#FFB900" />
  </Svg>
);

const LOGOS: Record<MobileSignInProviderId, () => ReactNode> = { google: GoogleLogo, apple: AppleLogo, microsoft: MicrosoftLogo };

/** The name under each button: a brand name, the same in every language. */
export const MOBILE_PROVIDER_CAPTIONS: Record<MobileSignInProviderId, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };

const BUTTON_COLOURS: Record<MobileSignInProviderId, { backgroundColor: string }> = {
  google: { backgroundColor: "#33384a" },
  microsoft: { backgroundColor: "#33384a" },
  apple: { backgroundColor: "#000000" },
};
const TILE_COLOURS: Record<MobileSignInProviderId, { backgroundColor: string; borderWidth?: number; borderColor?: string }> = {
  google: { backgroundColor: "#ffffff" },
  microsoft: { backgroundColor: "#ffffff" },
  apple: { backgroundColor: "#000000", borderWidth: 1, borderColor: "#3a3f52" },
};

type MobileProviderSignInRowsProps = {
  providers: readonly string[];
  /** The button's accessibility label, e.g. "Sign in with Google" (the caller translates). */
  label: (provider: MobileSignInProviderId) => string;
  onSelect: (provider: MobileSignInProviderId) => void;
  /** The provider whose sign-in is starting: every button is disabled meanwhile. */
  busy?: MobileSignInProviderId | null;
};

/** The buttons only; the caller draws the "or" line (`MobileOrDivider`) above them, and nothing when this is empty. */
export const MobileProviderSignInRows = ({ providers, label, onSelect, busy = null }: MobileProviderSignInRowsProps) => {
  const rows = orderedMobileProviders(providers);
  if (rows.length === 0) return null;
  return (
    <View testID="provider-sign-in-rows" style={styles.stack}>
      {rows.map((provider) => {
        const Logo = LOGOS[provider];
        return (
          <View key={provider} style={[styles.column, busy !== null && busy !== provider ? styles.dimmed : null]}>
            <Pressable
              testID={`provider-sign-in-${provider}`}
              accessibilityRole="button"
              accessibilityLabel={label(provider)}
              accessibilityState={{ disabled: busy !== null, busy: busy === provider }}
              disabled={busy !== null}
              onPress={() => onSelect(provider)}
              style={[styles.button, BUTTON_COLOURS[provider]]}
            >
              <View style={[styles.tile, TILE_COLOURS[provider]]}>
                <Logo />
              </View>
            </Pressable>
            <Text
              testID={`provider-sign-in-${provider}-caption`}
              style={styles.caption}
              numberOfLines={1}
              importantForAccessibility="no"
              accessibilityElementsHidden
            >
              {MOBILE_PROVIDER_CAPTIONS[provider]}
            </Text>
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  stack: { flexDirection: "row", gap: 8 },
  column: { flex: 1, alignItems: "center", gap: 6 },
  button: {
    width: 54,
    height: 54,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#444a5b",
  },
  dimmed: { opacity: 0.5 },
  tile: {
    position: "absolute",
    left: 7,
    top: 7,
    right: 7,
    bottom: 7,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  caption: { fontSize: 13, fontWeight: "500", lineHeight: 17, color: "#a9b0c4" },
});
