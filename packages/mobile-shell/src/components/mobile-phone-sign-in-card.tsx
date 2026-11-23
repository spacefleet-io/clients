import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronRight, QrCode } from "lucide-react-native";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { MobileOrDivider } from "./mobile-or-divider";

/**
 * Under a phone's email and password form (ACCT-SIGNIN-04): an "or" line, then the highlighted "Sign in with another
 * device" card (QR icon, title, one line) that opens the code sign-in. Shared by Badger and Parrot phones (REL-FAM-02).
 * The key screens pass their own title and line ("Get the key from another device", UX-KEY-01). The TV's remote
 * focuses the card on the key step: its ring is drawn over the card while focused, so nothing shifts (UX-TV-17).
 */
export const MobilePhoneSignInCard = ({
  onPress,
  testID = "login-qr-card",
  title,
  body,
}: {
  onPress: () => void;
  testID?: string;
  title?: string;
  body?: string;
}) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const cardTitle = title ?? t("login.qr.title");
  const cardBody = body ?? t("login.qr.body");
  const [focused, setFocused] = useState(false);
  return (
    <>
      <MobileOrDivider label={t("login.qr.or")} />
      <Pressable
        testID={testID}
        style={[styles.card, { borderColor: `${theme.colors.accent}99`, backgroundColor: `${theme.colors.accent}17` }]}
        onPress={onPress}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityRole="button"
        accessibilityLabel={cardTitle}
        accessibilityHint={cardBody}
      >
        <View style={[styles.iconTile, { backgroundColor: `${theme.colors.accent}2e` }]}>
          <QrCode size={22} color={theme.colors.accent} />
        </View>
        <View style={styles.text}>
          <Text style={[styles.title, { color: theme.colors.text }]}>{cardTitle}</Text>
          <Text style={[styles.body, { color: theme.colors.textMuted }]}>{cardBody}</Text>
        </View>
        <ChevronRight size={18} color={theme.colors.textMuted} />
        {focused ? <View pointerEvents="none" style={[styles.ring, { borderColor: theme.colors.text }]} /> : null}
      </Pressable>
    </>
  );
};

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1.5 },
  iconTile: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: "700" },
  body: { fontSize: 13, lineHeight: 19, marginTop: 2 },
  ring: { position: "absolute", top: -1.5, left: -1.5, right: -1.5, bottom: -1.5, borderWidth: 3, borderRadius: 16 },
});
