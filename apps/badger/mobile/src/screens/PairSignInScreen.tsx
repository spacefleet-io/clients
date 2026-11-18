import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { MobileAuthButton, MobileStartupPage } from "@space/mobile-shell/components";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { useTranslation } from "@space/mobile-shell/i18n";
import { completePairing } from "@space/mobile-shell/pairing";
import { MobilePairingPanel, type MobilePairingPanelLook } from "@space/mobile-shell/pairing-panel";
import { useAuth } from "../store/auth";
import { createPhoneCompletionDeps, createPhonePairingClient, currentPhoneDeviceName, PHONE_PAIRING_LOG_TAG } from "../lib/phonePairing";
import { SetupStepBar } from "../setup/BadgerSetupFlow";
import { markPhoneSetupPaired } from "../setup/phoneSetupStore";

export const PairingText: MobilePairingPanelLook["Text"] = ({ tone, testID, children }) => {
  const theme = useMobileShellTheme();
  const color = tone === "error" ? (theme.colors.danger ?? theme.colors.accent) : tone === "muted" ? theme.colors.textMuted : theme.colors.text;
  return (
    <Text style={[tone === "code" ? styles.code : styles.body, { color }]} testID={testID} selectable={tone === "code"}>
      {children}
    </Text>
  );
};

export const PairingButton: MobilePairingPanelLook["Button"] = ({ label, onPress }) => <MobileAuthButton label={label} onPress={onPress} />;

/**
 * Sign in with another device (UX-PHONE-05, ACCT-PAIR-01): this phone shows a code; a signed-in Badger approves it and sends
 * the session and the library key. The code is requested on mount and dropped on unmount (the shared panel).
 */
export const PairSignInScreen = () => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { setSession } = useAuth();
  return (
    <MobileStartupPage>
      <View style={styles.wrap} testID="pair-sign-in">
        <SetupStepBar step="signIn" />
        <Text style={[styles.title, { color: theme.colors.text }]} accessibilityRole="header">
          {t("login.pairing.title")}
        </Text>
        <MobilePairingPanel
          createClient={createPhonePairingClient}
          complete={async (approved) => {
            const completion = await completePairing(createPhoneCompletionDeps(setSession), approved);
            // Pairing brought the key: the setup's key screen does not apply (UX-SETUP-03 screen 3).
            if (completion.ok) await markPhoneSetupPaired();
            return completion;
          }}
          logTag={PHONE_PAIRING_LOG_TAG}
          deviceName={currentPhoneDeviceName()}
          app="badger"
          testIDPrefix="pair-sign-in"
          Text={PairingText}
          Button={PairingButton}
          gap={10}
          codeGap={8}
          qrPadding={12}
        />
        <Pressable testID="pair-sign-in-password" onPress={() => navigation.goBack()} accessibilityRole="button">
          <Text style={[styles.link, { color: theme.colors.accent }]}>{t("login.pairing.usePassword")}</Text>
        </Pressable>
      </View>
    </MobileStartupPage>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  title: { fontSize: 22, fontWeight: "800", textAlign: "center", marginBottom: 6 },
  body: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  code: { fontSize: 24, fontWeight: "800", letterSpacing: 3 },
  link: { fontSize: 14, fontWeight: "700", textAlign: "center", marginTop: 16 },
});
