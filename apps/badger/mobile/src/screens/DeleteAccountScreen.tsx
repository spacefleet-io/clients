import React, { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { ApiError, cancelScheduledDeletion, deleteAccount, getDeletionOptions } from "@space/shared/api";
import { bookedDeletionDate, type AccountDeletionMode } from "@space/shared/accountDeletion";
import { TOO_MANY_ATTEMPTS_KEY, isRateLimited, signInErrorValues, type SignInErrorValues } from "@space/shared/signInError";
import { getCurrentLanguage, useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { useAuth } from "../store/auth";
import { Button, Input } from "../components/ui";
import { IconButton } from "../components/IconButton";
import { SettingsGroup } from "../components/SettingsRows";
import {
  DELETE_CONFIRM_WORD,
  accountDeletionError,
  accountDeletionModeInput,
  finishAccountDeletion,
} from "../lib/accountDeletion";
import { clearLibraryKey } from "../lib/onboarding";
import { removeDownloads } from "../lib/downloads/downloadActions";
import { getDownloadsState } from "../lib/downloads/downloadsStore";
import { theme } from "../theme/theme";

const log = scopeLogger("delete-account");

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(getCurrentLanguage());

/**
 * Irreversible account deletion (store rule: an app that can create an account must be able to delete it).
 * Password + typed DELETE (+ 2FA code when the API asks), like desktop; on success the account is scheduled
 * for deletion and the user is signed out. ACCT-DEL-03: on a paid yearly plan past its guarantee the user picks
 * "at the end of your paid year" (default: the deletion is booked, the account keeps working) or "now, no refund";
 * a booked deletion shows its date and a "Keep my account" button.
 */
export const DeleteAccountScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { token, user, logout, refresh, setUser } = useAuth();
  // ACCT-AUTH-04: an account without a password is asked a code instead (the first try emails one).
  const hasPassword = user?.hasPassword !== false;
  /** ACCT-DEL-03: end of the paid year a request would be booked for (null: deleting is immediate). */
  const [periodEndDeleteAt, setPeriodEndDeleteAt] = useState<string | null>(null);
  /** ACCT-DEL-03: date of a deletion already booked. */
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [mode, setMode] = useState<AccountDeletionMode>("end_of_period");
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // The i18n key (not text) so the message follows the UI language if it changes while shown.
  const [error, setError] = useState<{ key: string; values?: SignInErrorValues } | null>(null);
  // Two taps can land before `busy` re-renders; a second DELETE would fail on the revoked session.
  const inFlight = useRef(false);

  const canSubmit =
    Boolean(token) &&
    confirmText.trim() === DELETE_CONFIRM_WORD &&
    (!hasPassword || password.length > 0) &&
    (!needsCode || code.trim().length > 0) &&
    !busy;

  const loadOptions = useCallback(async () => {
    if (!token) return;
    try {
      const options = await getDeletionOptions(token);
      log.info("options", { ...options });
      setPeriodEndDeleteAt(options.periodEndDeleteAt);
      setScheduledFor(options.scheduledFor);
    } catch (err) {
      // Without the options the form still works: the API decides what a request does.
      log.warn("options.failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void loadOptions();
    }, [loadOptions])
  );

  const keepAccount = useCallback(async () => {
    if (!token || cancelling) return;
    setCancelling(true);
    setCancelFailed(false);
    try {
      log.info("cancel booked deletion");
      const { user } = await cancelScheduledDeletion(token);
      setUser(user);
      setScheduledFor(null);
      await loadOptions();
    } catch (err) {
      log.warn("cancel.failed", { error: err instanceof Error ? err.message : String(err) });
      setCancelFailed(true);
    } finally {
      setCancelling(false);
    }
  }, [cancelling, loadOptions, setUser, token]);

  const submit = useCallback(async () => {
    if (!token || !canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof deleteAccount>>;
    try {
      log.info("submit", { withTwoFactorCode: needsCode, mode: periodEndDeleteAt ? mode : null });
      result = await deleteAccount(token, {
        password: hasPassword ? password : "",
        confirm: DELETE_CONFIRM_WORD,
        ...(needsCode && code.trim() ? { twoFactorCode: code.trim() } : {}),
        ...accountDeletionModeInput(periodEndDeleteAt, mode),
      });
    } catch (err) {
      const mapped = accountDeletionError(err instanceof ApiError ? err.payload?.error : null);
      if (mapped.needsCode) setNeedsCode(true);
      // ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05) says when to try again.
      setError(
        isRateLimited(err)
          ? { key: TOO_MANY_ATTEMPTS_KEY, values: signInErrorValues(err) }
          : { key: `deleteAccount.errors.${mapped.key}` }
      );
      setBusy(false);
      inFlight.current = false;
      return;
    }
    log.info("result", { ...result });
    if (result.status === "deletion_scheduled_for_period_end") {
      // ACCT-DEL-03: booked; the account keeps working until the end of the paid year.
      setScheduledFor(result.deleteAt);
      setPeriodEndDeleteAt(null);
      setPassword("");
      setConfirmText("");
      setCode("");
      setNeedsCode(false);
      setMode("end_of_period");
      setBusy(false);
      inFlight.current = false;
      void refresh();
      return;
    }
    await finishAccountDeletion({
      downloadIds: getDownloadsState().items.map((item) => item.id),
      removeDownloads,
      clearLibraryKey,
      logout: () => logout("signOut"),
    });
  }, [canSubmit, code, hasPassword, logout, mode, needsCode, password, periodEndDeleteAt, refresh, token]);

  const bookedDate = bookedDeletionDate(scheduledFor, periodEndDeleteAt, mode);
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <IconButton label={t("deleteAccount.back")} onPress={() => navigation.goBack()}>
          <ArrowLeft size={22} color={theme.colors.text} />
        </IconButton>
        <Text style={styles.title} accessibilityRole="header">
          {t("deleteAccount.title")}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.warning} testID="delete-account-warning">
          {bookedDate ? t("deleteAccount.warningBooked", { date: formatDate(bookedDate) }) : t("deleteAccount.warning")}
        </Text>
        <Text style={styles.body}>{t("deleteAccount.keepFiles")}</Text>
        {scheduledFor ? (
          <SettingsGroup>
            <View style={styles.form} testID="delete-account-scheduled">
              <Text style={styles.scheduled}>{t("deleteAccount.scheduled", { date: formatDate(scheduledFor) })}</Text>
              {cancelFailed ? (
                <Text style={styles.error} accessibilityLiveRegion="polite">
                  {t("deleteAccount.cancelScheduledFailed")}
                </Text>
              ) : null}
              <Button
                label={t("deleteAccount.cancelScheduled")}
                onPress={() => void keepAccount()}
                loading={cancelling}
                disabled={cancelling}
                testID="delete-account-keep"
              />
            </View>
          </SettingsGroup>
        ) : (
        <SettingsGroup>
          <View style={styles.form}>
            {periodEndDeleteAt ? (
              <View style={styles.modes} accessibilityRole="radiogroup" testID="delete-account-mode">
                <Text style={styles.modeTitle}>{t("deleteAccount.modeTitle")}</Text>
                {(["end_of_period", "now"] as const).map((option) => {
                  const selected = option === mode;
                  const label =
                    option === "end_of_period"
                      ? t("deleteAccount.modeEndOfPeriod", { date: formatDate(periodEndDeleteAt) })
                      : t("deleteAccount.modeNow");
                  return (
                    <Pressable
                      key={option}
                      style={[styles.mode, selected && styles.modeSelected]}
                      onPress={() => setMode(option)}
                      accessibilityRole="radio"
                      accessibilityLabel={label}
                      accessibilityState={{ selected }}
                      testID={`delete-account-mode-${option}`}
                    >
                      <View style={[styles.radio, selected && styles.radioSelected]} />
                      <Text style={styles.modeLabel}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {hasPassword ? (
              <Input
                label={t("deleteAccount.passwordLabel")}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
              />
            ) : (
              <Text testID="delete-account-recheck-hint" style={styles.body}>{t("login.code.recheckHint")}</Text>
            )}
            <Input
              label={t("deleteAccount.confirmLabel")}
              value={confirmText}
              onChangeText={setConfirmText}
              placeholder={DELETE_CONFIRM_WORD}
              autoCapitalize="characters"
            />
            {needsCode ? (
              <Input
                label={t("deleteAccount.codeLabel")}
                value={code}
                onChangeText={setCode}
                autoCapitalize="none"
              />
            ) : null}
            {error ? (
              <Text style={styles.error} accessibilityLiveRegion="polite">
                {t(error.key, error.values)}
              </Text>
            ) : null}
            <Button
              label={busy ? t("deleteAccount.deleting") : t("deleteAccount.delete")}
              variant="danger"
              onPress={() => void submit()}
              loading={busy}
              disabled={!canSubmit}
            />
          </View>
        </SettingsGroup>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  title: { flex: 1, fontSize: 22, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  content: { paddingTop: 8, paddingBottom: 24, gap: 16 },
  warning: { fontSize: 15, lineHeight: 21, fontWeight: "700", color: theme.colors.danger },
  body: { fontSize: 14, lineHeight: 20, color: theme.colors.textMuted },
  form: { padding: 16, gap: 12 },
  error: { fontSize: 13, color: theme.colors.danger },
  scheduled: { fontSize: 15, lineHeight: 21, fontWeight: "700", color: theme.colors.text },
  modes: { gap: 8 },
  modeTitle: { fontSize: 15, lineHeight: 21, fontWeight: "700", color: theme.colors.text },
  mode: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modeSelected: { borderColor: theme.colors.accent },
  radio: { width: 18, height: 18, marginTop: 2, borderRadius: 9, borderWidth: 2, borderColor: theme.colors.textMuted },
  radioSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  modeLabel: { flex: 1, fontSize: 14, lineHeight: 20, color: theme.colors.text },
});
