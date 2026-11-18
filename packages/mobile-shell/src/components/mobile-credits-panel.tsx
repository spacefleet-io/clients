import React, { useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { resolveLegalLanguage } from "@space/legal";
import { creditsFor, type CreditProduct } from "@space/legal/credits";
import type { CreditsSource } from "@space/metadata-client/credits";
import { useSourceCredits } from "@space/metadata-client/credits-react";
import { useMobileShellTheme } from "../theme";
import { TV_FOCUS_RING_WIDTH } from "./tv-focus";

type MobileCreditsPanelProps = {
  language: string | undefined;
  product: CreditProduct;
  /** Where the credits come from: the metadata service, and the device's copy of its last answer. */
  source: CreditsSource;
  /** Phones open a source's site; a TV has no browser, so its rows only take the focus (to scroll the list). */
  openLinks: boolean;
  /** Text scale (the TV passes its screen scale). */
  scale?: number;
};

const SVG_DATA_URI = /^data:image\/svg\+xml(?:;charset=utf-8)?,/i;

/** A logo `data:` URI drawn at `height`: SVG through react-native-svg (its width from the viewBox), others as images. */
const CreditLogo = ({ name, logo, height }: { name: string; logo: string; height: number }) => {
  const svg = SVG_DATA_URI.test(logo) ? decodeURIComponent(logo.replace(SVG_DATA_URI, "")) : null;
  if (!svg) {
    return <Image source={{ uri: logo }} style={{ height, width: height * 4 }} resizeMode="contain" accessibilityLabel={name} testID="credit-logo" />;
  }
  const [, , width = 1, viewHeight = 1] = (/viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 1 1").split(/[\s,]+/).map(Number);
  return <SvgXml xml={svg} height={height} width={height * (width / viewHeight)} accessibilityLabel={name} testID="credit-logo" />;
};

/**
 * Settings > About on phones and TVs: who provides the data the app shows, with the logo and notice a source's terms
 * require, in the app's language. The list comes from the metadata service (`GET /credits`, META-SRC-09), the same
 * list as the website's legal notice credits and the computer apps' About (REL-FAM-02), and the last answer is kept
 * on the device; before the app was ever online a neutral line stands in.
 * The credits sit under one "About" header row, closed by default, that opens in place on a tap or the remote's
 * select (UX-SET-02); the attribution text and logo inside are unchanged.
 */
export const MobileCreditsPanel = ({ language, product, source, openLinks, scale = 1 }: MobileCreditsPanelProps) => {
  const theme = useMobileShellTheme();
  const lang = resolveLegalLanguage(language);
  const labels = creditsFor(lang);
  const credits = useSourceCredits(product, lang, source);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const muted = { color: theme.colors.textMuted, fontFamily: theme.font.family.sans, fontSize: 13 * scale, lineHeight: 19 * scale };
  const label = { color: theme.colors.text, fontFamily: theme.font.family.sans, fontSize: 15 * scale };
  return (
    <View testID="settings-credits">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={labels.about}
        onPress={() => setOpen((value) => !value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.toggle, { borderColor: focused ? theme.colors.accent : "transparent", borderWidth: TV_FOCUS_RING_WIDTH }]}
        testID="settings-credits-toggle"
      >
        <Text style={[styles.name, label]}>{labels.about}</Text>
        <Text style={[label, { color: theme.colors.textMuted }]} accessibilityElementsHidden importantForAccessibility="no">
          {open ? "▴" : "▾"}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.panel} testID="settings-credits-body">
          <Text style={muted}>{labels.intro}</Text>
          {credits ? (
            <>
              {credits.entries.map((entry) => (
                <Pressable
                  key={entry.id}
                  accessibilityRole={openLinks ? "link" : "text"}
                  onPress={openLinks ? () => void Linking.openURL(entry.url).catch(() => undefined) : undefined}
                  testID={`credit-${entry.id}`}
                >
                  <Text style={[styles.name, label]}>{entry.name}</Text>
                  <Text style={muted}>{entry.text}</Text>
                </Pressable>
              ))}
              {credits.entries
                .filter((entry) => entry.logo || entry.notice)
                .map((entry) => (
                  <View key={entry.id} style={styles.notice}>
                    {entry.logo ? <CreditLogo name={entry.name} logo={entry.logo} height={12 * scale} /> : null}
                    {entry.notice ? <Text style={muted}>{entry.notice}</Text> : null}
                  </View>
                ))}
            </>
          ) : (
            <Text style={muted} testID="settings-credits-unavailable">
              {labels.unavailable}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 56, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 12 },
  panel: { gap: 12, paddingHorizontal: 16, paddingBottom: 14 },
  name: { fontWeight: "700" },
  notice: { gap: 8, alignItems: "flex-start" },
});
