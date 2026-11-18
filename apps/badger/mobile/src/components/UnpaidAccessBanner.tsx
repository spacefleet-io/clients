import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { AlertTriangle } from "lucide-react-native";
import { SkyCover } from "@space/mobile-shell/components";
import { getCurrentLanguage, useTranslation } from "@space/mobile-shell/i18n";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { useAuth } from "../store/auth";
import { getUnpaidAccessInfo, unpaidMessage } from "../lib/unpaidAccess";

/**
 * Notice shown above every main screen while the account is unpaid (ACCT-UNPAID-03): playback and uploads are
 * stopped and the files are deleted on the wipe date. It only informs; it never links to or mentions paying
 * (ACCT-PAY-02). Renders nothing for free and paid accounts. `user.access` is refreshed by the existing
 * `/auth/me` call, no polling.
 */
export const UnpaidAccessBanner = ({ scale = 1 }: { /** Multiplies every size; the TV passes its screen scale (UX-TV-13), phones 1. */ scale?: number }) => {
  const { user } = useAuth();
  const styles = stylesFor(scale);
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const { unpaid, wipeAt } = getUnpaidAccessInfo(user?.access);
  if (!unpaid) return null;
  return (
    <SkyCover>
      <View
        accessibilityRole="alert"
        testID="unpaid-access-banner"
        style={[
          styles.banner,
          {
            backgroundColor: "rgba(255,193,77,0.12)",
            borderColor: theme.colors.warning,
          },
        ]}
      >
        <AlertTriangle size={16 * scale} color={theme.colors.warning} />
        <Text style={[styles.text, { color: theme.colors.text }]}>{unpaidMessage(t, "unpaidBanner", wipeAt, getCurrentLanguage())}</Text>
      </View>
    </SkyCover>
  );
};

const makeStyles = (s: number) =>
  StyleSheet.create({
    banner: {
      marginHorizontal: 4 * s,
      marginTop: 8 * s,
      flexDirection: "row",
      alignItems: "center",
      gap: 10 * s,
      borderWidth: 1 * s,
      borderRadius: 14 * s,
      paddingHorizontal: 14 * s,
      paddingVertical: 10 * s,
    },
    text: { flex: 1, fontSize: 13 * s, lineHeight: 18 * s, fontWeight: "600" },
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
