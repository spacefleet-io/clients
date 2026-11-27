import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { AlertTriangle } from "lucide-react-native";
import type { AccountAccess } from "@space/shared/accountAccess";
import { getCurrentLanguage, useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { getUnpaidAccessInfo, unpaidMessage } from "../unpaidAccess";
import { SkyCover } from "./mobile-sky-cover";

/**
 * Notice shown above every main screen of the phone and TV apps (Badger, Parrot) while the account is unpaid
 * (ACCT-UNPAID-03): playback and uploads are stopped and the files are deleted on the wipe date. It only informs; it
 * never links to or mentions paying (ACCT-PAY-02). Renders nothing for free and paid accounts. `access` is the app's
 * last `GET /auth/me` answer, re-evaluated against the clock at render time; no polling.
 */
export const UnpaidAccessBanner = ({
  access,
  scale = 1,
}: {
  access: AccountAccess | null | undefined;
  /** Multiplies every size; the TV passes its screen scale (UX-TV-13), phones 1. */
  scale?: number;
}) => {
  const styles = stylesFor(scale);
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const { unpaid, wipeAt } = getUnpaidAccessInfo(access);
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
