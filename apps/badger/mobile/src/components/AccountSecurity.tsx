import React, { useCallback, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { Button, Card, Input } from "./ui";
import { theme } from "../theme/theme";
import { changePassword, ApiError } from "@space/shared/api";
import { TOO_MANY_ATTEMPTS_KEY, isRateLimited, signInErrorValues, type SignInErrorValues } from "@space/shared/signInError";

type PasswordMessage =
  | { key: "success"; error: false }
  | { key: "required" | "tooShort" | "incorrect" | "twoFactorRequired" | "twoFactorInvalid" | "failed"; error: true }
  /** ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05). */
  | { key: "tooManyAttempts"; error: true; values: SignInErrorValues };

/**
 * `hasPassword` false (an account without a password, ACCT-AUTH-04/05): no current password is asked; the
 * form sets a first password and the API asks a code instead (the authenticator's, else an emailed one).
 */
export const PasswordChangeSection = ({ token, hasPassword = true }: { token: string; hasPassword?: boolean }) => {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // ACCT-AUTH-04: with 2FA on, the API asks for the second-step code before changing the password.
  const [codeAsked, setCodeAsked] = useState(false);
  const [code, setCode] = useState("");
  // Stores a message code (not text) so it follows the UI language if it changes while shown.
  const [message, setMessage] = useState<PasswordMessage | null>(null);

  const handleChange = useCallback(async () => {
    if ((hasPassword && !currentPassword) || !newPassword) {
      setMessage({ key: "required", error: true });
      return;
    }
    if (newPassword.length < 8) {
      setMessage({ key: "tooShort", error: true });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await changePassword(token, hasPassword ? currentPassword : "", newPassword, code.trim() || undefined);
      setMessage({ key: "success", error: false });
      setCurrentPassword("");
      setNewPassword("");
      setCode("");
      setCodeAsked(false);
    } catch (err) {
      const errorCode = err instanceof ApiError ? err.payload?.error : null;
      if (errorCode === "two_factor_required" || errorCode === "two_factor_invalid") {
        setCodeAsked(true);
        setMessage({ key: errorCode === "two_factor_required" ? "twoFactorRequired" : "twoFactorInvalid", error: true });
      } else if (isRateLimited(err)) {
        setMessage({ key: "tooManyAttempts", error: true, values: signInErrorValues(err) });
      } else {
        setMessage({ key: errorCode === "invalid_credentials" ? "incorrect" : "failed", error: true });
      }
    } finally {
      setBusy(false);
    }
  }, [code, currentPassword, hasPassword, newPassword, token]);

  return (
    <Card>
      <Text style={styles.sectionLabel}>{hasPassword ? t("account.password.title") : t("account.password.set.title")}</Text>
      {hasPassword ? (
        <Input
          label={t("account.password.currentPassword")}
          value={currentPassword}
          onChangeText={setCurrentPassword}
          secureTextEntry
        />
      ) : (
        <Text testID="password-change-recheck-hint" style={styles.subtle}>{t("login.code.recheckHint")}</Text>
      )}
      <Input label={t("account.password.newPassword")} value={newPassword} onChangeText={setNewPassword} secureTextEntry />
      {codeAsked ? (
        <Input label={t("account.password.codeLabel")} value={code} onChangeText={setCode} />
      ) : null}
      {message ? (
        <Text style={message.error ? styles.error : styles.success}>
          {message.key === "tooManyAttempts"
            ? t(TOO_MANY_ATTEMPTS_KEY, message.values)
            : message.error
              ? t(`account.password.errors.${message.key}`)
              : t("account.password.success")}
        </Text>
      ) : null}
      <Button
        label={
          hasPassword
            ? busy ? t("account.password.changing") : t("account.password.change")
            : busy ? t("account.password.set.setting") : t("account.password.set.button")
        }
        variant="secondary"
        onPress={handleChange}
        loading={busy}
      />
    </Card>
  );
};

const styles = StyleSheet.create({
  sectionLabel: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
    fontWeight: "600",
  },
  subtle: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  error: {
    color: theme.colors.danger,
    fontSize: theme.font.size.sm,
  },
  success: {
    color: theme.colors.success,
    fontSize: theme.font.size.sm,
  },
});
