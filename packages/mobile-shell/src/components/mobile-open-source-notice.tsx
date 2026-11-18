import React from "react";
import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { openSourceFor, type CreditProduct } from "@space/legal/credits";
import { QrCode } from "../pairing-qr";
import { useMobileShellTheme } from "../theme";

type MobileOpenSourceNoticeProps = {
  language: string | undefined;
  product: CreditProduct;
  /** Phones open the source code in the browser; a TV has none, so it shows the address as text and a QR code. */
  openLinks: boolean;
  /** Text scale (the TV passes its screen scale). */
  scale?: number;
  /** Overrides the inset that lines it up with a settings group's rows (a card with its own padding passes none). */
  style?: StyleProp<ViewStyle>;
};

/**
 * UX-SET-03: the line that opens each app's credits place on phones and TVs, "<App> is open source, under the GPL-3.0
 * licence.", then "View the source code", which opens the public client repository in the system browser. The TV
 * shows the address and a QR code to scan with a phone instead, since it cannot open a browser or be typed on. Then
 * the credits of the language pickers' flag artwork (UX-I18N-10) and of the bundled Inter and Space Grotesk fonts.
 */
export const MobileOpenSourceNotice = ({ language, product, openLinks, scale = 1, style }: MobileOpenSourceNoticeProps) => {
  const theme = useMobileShellTheme();
  const { notice, linkLabel, url, flags, fonts } = openSourceFor(language, product);
  const muted = { color: theme.colors.textMuted, fontFamily: theme.font.family.sans, fontSize: 13 * scale, lineHeight: 19 * scale };
  const link = { color: theme.colors.accent, fontFamily: theme.font.family.sans, fontSize: 15 * scale, fontWeight: "700" as const };
  return (
    <View style={[styles.panel, { gap: 8 * scale }, style]} testID="open-source-notice">
      <Text style={muted}>{notice}</Text>
      {openLinks ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={linkLabel}
          onPress={() => void Linking.openURL(url).catch(() => undefined)}
          hitSlop={8}
          testID="open-source-link"
        >
          <Text style={link}>{linkLabel}</Text>
        </Pressable>
      ) : (
        <View style={[styles.tv, { gap: 16 * scale }]} testID="open-source-address">
          <QrCode payload={url} size={Math.round(120 * scale)} label={linkLabel} />
          <View style={styles.tvText}>
            <Text style={[link, { color: theme.colors.text }]}>{linkLabel}</Text>
            <Text style={muted}>{url.replace("https://", "")}</Text>
          </View>
        </View>
      )}
      <Text style={muted} testID="open-source-flags">
        {flags}
      </Text>
      <Text style={muted} testID="open-source-fonts">
        {fonts}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  panel: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  tv: { flexDirection: "row", alignItems: "center" },
  tvText: { flexShrink: 1, gap: 4 },
});
