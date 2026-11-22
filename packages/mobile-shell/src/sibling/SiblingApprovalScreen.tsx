import React, { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowRight } from "lucide-react-native";
import type { SiblingApproveDeps } from "@space/pairing-crypto";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { MobileStartupPage } from "../components/mobile-startup-page";
import { answerIncomingSiblingApproval } from "./approval";
import { SIBLING_APP_ICONS, SIBLING_APP_NAMES } from "./icons";
import { finishIncomingSiblingApproval, getIncomingSiblingApproval, type IncomingSiblingApproval } from "./native";

type SiblingApp = "badger" | "parrot";

export type SiblingApprovalViewProps = {
  /** This (signed-in) app; the asker is its sister. */
  self: SiblingApp;
  /** The account this app is signed in to, which the sister app will use. */
  email: string;
  /** The answer is being sent: both buttons are locked. */
  busy: boolean;
  onAllow: () => void;
  onCancel: () => void;
};

/**
 * ACCT-PAIR-07, in the signed-in phone app: "Let {App} use your SpaceFleet account?" under the asking app's real icon
 * → this app's real icon. Allow or Cancel only: no biometric or passcode step (same unlocked phone, Chris's decision).
 */
export const SiblingApprovalView = ({ self, email, busy, onAllow, onCancel }: SiblingApprovalViewProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const asker: SiblingApp = self === "badger" ? "parrot" : "badger";
  const app = SIBLING_APP_NAMES[asker];
  return (
    <MobileStartupPage>
      <View style={styles.content}>
        <View style={styles.icons}>
          <Image source={SIBLING_APP_ICONS[asker]} style={styles.icon} accessibilityIgnoresInvertColors />
          <ArrowRight size={26} color={theme.colors.textMuted} />
          <Image source={SIBLING_APP_ICONS[self]} style={styles.icon} accessibilityIgnoresInvertColors />
        </View>
        <Text accessibilityRole="header" style={[styles.title, { color: theme.colors.text }]}>
          {t("sibling.askTitle", { app })}
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>{t("sibling.askBody", { app, email })}</Text>
        <View style={styles.buttons}>
          <Pressable
            testID="sibling-allow"
            onPress={onAllow}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={[styles.primary, { backgroundColor: theme.colors.accent, opacity: busy ? 0.6 : 1 }]}
          >
            <Text style={[styles.primaryLabel, { color: theme.accentTextHex }]}>{t("sibling.allow")}</Text>
          </Pressable>
          <Pressable
            testID="sibling-deny"
            onPress={onCancel}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={[styles.secondary, { borderColor: theme.colors.border, opacity: busy ? 0.6 : 1 }]}
          >
            <Text style={[styles.secondaryLabel, { color: theme.colors.text }]}>{t("sibling.cancel")}</Text>
          </Pressable>
        </View>
      </View>
    </MobileStartupPage>
  );
};

export type SiblingApprovalScreenProps = {
  self: SiblingApp;
  /** This app's session token; null while signed out (the sister gets an error answer). */
  token: string | null;
  email: string;
  deps: SiblingApproveDeps;
};

/**
 * The `SiblingApproval` root component the approval activity shows: reads the verified request the OS handed over,
 * answers it once on Allow or Cancel, and the activity closes with the answer for the sister app.
 */
export const SiblingApprovalScreen = ({ self, token, email, deps }: SiblingApprovalScreenProps) => {
  const [incoming, setIncoming] = useState<IncomingSiblingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const answered = useRef(false);

  useEffect(() => {
    let live = true;
    void getIncomingSiblingApproval().then((request) => {
      if (!live) return;
      console.info("[sibling] approval.incoming", { present: request !== null, caller: request?.callerApp });
      if (request) setIncoming(request);
      // No verified request (the activity already answered "caller_unverified" and is closing): nothing to show.
    });
    return () => {
      live = false;
    };
  }, []);

  if (!incoming) return null;

  const answer = (allow: boolean) => {
    if (answered.current) return;
    answered.current = true;
    setBusy(true);
    void answerIncomingSiblingApproval({ self, token, deps, incoming, finish: finishIncomingSiblingApproval }, allow).catch((error: unknown) => {
      console.warn("[sibling] approval.finish failed", { message: error instanceof Error ? error.message : String(error) });
    });
  };

  return <SiblingApprovalView self={self} email={email} busy={busy} onAllow={() => answer(true)} onCancel={() => answer(false)} />;
};

const styles = StyleSheet.create({
  content: { gap: 18, paddingVertical: 24 },
  icons: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18 },
  icon: { width: 64, height: 64, borderRadius: 16 },
  title: { fontSize: 22, fontWeight: "700", textAlign: "center" },
  body: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  buttons: { gap: 12, marginTop: 8 },
  primary: { height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  primaryLabel: { fontSize: 16, fontWeight: "700" },
  secondary: { height: 50, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  secondaryLabel: { fontSize: 16, fontWeight: "600" },
});
