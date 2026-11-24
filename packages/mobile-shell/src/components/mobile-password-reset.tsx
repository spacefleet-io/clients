/**
 * "Forgot password?" on a phone sign-in screen: the e-mail gets a code, then the
 * code and a new password reset it. A card over the sign-in form; `onDone` hands back the notice to show under it.
 */
import React, { useEffect, useState } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { Lock, Mail } from "lucide-react-native";
import { confirmPasswordReset, requestPasswordReset } from "@space/shared/api";
import { isRateLimited, signInErrorValues, TOO_MANY_ATTEMPTS_KEY } from "@space/shared/signInError";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { MobileAuthButton, MobileAuthInput } from "./mobile-auth-form";

type Props = {
  initialEmail: string;
  /** Closed: `notice` is the i18n key to show on the sign-in screen ("login.reset.noticeComplete"), else null. */
  onDone: (notice: string | null) => void;
};

export const MobilePasswordReset = ({ initialEmail, onDone }: Props) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const [step, setStep] = useState<"request" | "confirm">("request");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  /** `{count, minutes}` for the "too many attempts" sentence (ACCT-AUTH-11). */
  const [messageValues, setMessageValues] = useState(signInErrorValues(null));
  const [busy, setBusy] = useState(false);

  // Android Back closes the card first, as its Cancel does; with it closed Back leaves the sign-in as before.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onDone(null);
      return true;
    });
    return () => sub.remove();
  }, [onDone]);

  const request = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      await requestPasswordReset(email.trim());
      setStep("confirm");
      setMessage("login.reset.noticeSent");
    } catch (err) {
      setMessageValues(signInErrorValues(err));
      setMessage(isRateLimited(err) ? TOO_MANY_ATTEMPTS_KEY : "login.reset.errorFailed");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (password !== confirm) {
      setMessage("login.reset.errorMismatch");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await confirmPasswordReset(email.trim(), code.trim(), password);
      onDone("login.reset.noticeComplete");
    } catch (err) {
      setMessageValues(signInErrorValues(err));
      setMessage(isRateLimited(err) ? TOO_MANY_ATTEMPTS_KEY : "login.reset.errorInvalidCode");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.overlay} testID="password-reset">
      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <Text style={[styles.title, { color: theme.colors.text }]}>{t("login.reset.title")}</Text>
        <Text style={{ color: theme.colors.textMuted, fontSize: 14 }}>{t("login.reset.subtitle")}</Text>
        {message ? <Text style={{ color: message.includes("error") ? theme.colors.danger : theme.colors.accent, fontSize: 13 }}>{t(message, messageValues)}</Text> : null}
        {step === "request" ? (
          <>
            <MobileAuthInput icon={Mail} value={email} onChangeText={setEmail} placeholder={t("login.reset.emailLabel")} keyboardType="email-address" autoCapitalize="none" textContentType="emailAddress" autoComplete="email" />
            <MobileAuthButton label={busy ? t("login.reset.requesting") : t("login.reset.request")} onPress={() => void request()} disabled={busy} />
          </>
        ) : (
          <>
            <MobileAuthInput icon={Lock} value={code} onChangeText={setCode} placeholder={t("login.reset.codePlaceholder")} textContentType="oneTimeCode" autoComplete="one-time-code" />
            <MobileAuthInput icon={Lock} value={password} onChangeText={setPassword} placeholder={t("login.reset.passwordLabel")} secureTextEntry textContentType="newPassword" autoComplete="new-password" />
            <MobileAuthInput icon={Lock} value={confirm} onChangeText={setConfirm} placeholder={t("login.reset.passwordConfirmLabel")} secureTextEntry textContentType="newPassword" autoComplete="new-password" />
            <MobileAuthButton label={busy ? t("login.reset.submitting") : t("login.reset.submit")} onPress={() => void submit()} disabled={busy} />
          </>
        )}
        <Pressable accessibilityRole="button" onPress={() => onDone(null)}>
          <Text style={[styles.cancel, { color: theme.colors.accent }]}>{t("login.reset.cancel").toUpperCase()}</Text>
        </Pressable>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 20, zIndex: 10 },
  card: { borderRadius: 16, borderWidth: 1, padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: "700" },
  cancel: { fontSize: 12, fontWeight: "700", letterSpacing: 1.5, textAlign: "center", paddingVertical: 8 },
});
