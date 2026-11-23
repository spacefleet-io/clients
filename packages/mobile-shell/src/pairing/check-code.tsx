// PRIV-PAIR-01: the six digits a device asking to sign in shows once the approving app connected, for the user to
// compare with that app before it hands over the key. One look for the phone pages and the TV sign-in card.
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { formatCheckCode } from "@space/pairing-crypto";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";

export type PairingCheckCodeProps = {
  checkCode: string;
  /** The digits' testID; the box is `<testID>-box`. */
  testID: string;
  /** Scales the text (a TV reads from across the room). */
  scale?: number;
};

export const PairingCheckCode = ({ checkCode, testID, scale = 1 }: PairingCheckCodeProps) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  return (
    <View style={[styles.box, { borderColor: theme.colors.accent }]} testID={`${testID}-box`}>
      <Text style={[styles.label, { color: theme.colors.textMuted, fontSize: 13 * scale }]}>{t("phonePairing.check.label")}</Text>
      <Text style={[styles.code, { color: theme.colors.text, fontSize: 32 * scale }]} testID={testID} selectable>
        {formatCheckCode(checkCode)}
      </Text>
      <Text style={[styles.hint, { color: theme.colors.textMuted, fontSize: 13 * scale }]}>{t("phonePairing.check.hint")}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  box: { alignItems: "center", gap: 4, borderWidth: 2, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, alignSelf: "stretch" },
  label: { textTransform: "uppercase", letterSpacing: 1 },
  code: { fontWeight: "800", letterSpacing: 4, fontVariant: ["tabular-nums"] },
  hint: { textAlign: "center" },
});
