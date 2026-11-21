/**
 * Deleting the account on a phone, shared by the Badger and Parrot phones (ACCT-DEL-01/02/03; the stores' rule that an
 * app which creates accounts lets people delete them in the app: Apple 5.1.1(v), Google Play's account deletion
 * requirement). Password (or, for an account without one, an emailed code: ACCT-AUTH-04) + typed DELETE (+ the second
 * step's code when the API asks), like the desktop. On a paid yearly plan past its guarantee it asks "at the end of the
 * paid year" (booked, the account keeps working, "Keep my account" undoes it) or "now, no refund" (ACCT-DEL-03).
 * The page around it (title, back button) is the app's; `onDeleted` clears the phone and signs out.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ApiError, cancelScheduledDeletion, deleteAccount, getDeletionOptions, getMe, type User } from "@space/shared/api";
import { bookedDeletionDate, type AccountDeletionMode } from "@space/shared/accountDeletion";
import { TOO_MANY_ATTEMPTS_KEY, isRateLimited, signInErrorValues, type SignInErrorValues } from "@space/shared/signInError";
import { DELETE_CONFIRM_WORD, accountDeletionError, accountDeletionModeInput } from "../accountDeletion";
import { getCurrentLanguage, useTranslation } from "../i18n";
import { scopeLogger } from "../logger";
import { useMobileShellTheme } from "../theme";
import { MobileAuthButton, MobileAuthInput } from "./mobile-auth-form";

const log = scopeLogger("delete-account");

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(getCurrentLanguage());

type Props = {
  token: string;
  /** From the app's signed-in user; unknown (`undefined`) reads it from the API before asking for a password. */
  hasPassword?: boolean;
  /** "Keep my account" cancelled a booked deletion: the API's fresh user. */
  onUserChanged?: (user: User) => void;
  /** A deletion was booked for the end of the paid year: the account keeps working, the app may refresh it. */
  onBooked?: () => void;
  /** The API accepted an immediate deletion: remove the account's data from the phone and sign out. Never throws. */
  onDeleted: () => Promise<void>;
};

export const MobileDeleteAccount = ({ token, hasPassword: knownHasPassword, onUserChanged, onBooked, onDeleted }: Props) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const [hasPassword, setHasPassword] = useState(knownHasPassword ?? true);
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
    confirmText.trim() === DELETE_CONFIRM_WORD && (!hasPassword || password.length > 0) && (!needsCode || code.trim().length > 0) && !busy;

  const loadOptions = useCallback(async () => {
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

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    if (knownHasPassword !== undefined) return;
    getMe(token)
      .then(({ user }) => setHasPassword(user.hasPassword !== false))
      .catch((err: unknown) => log.warn("me.failed", { error: err instanceof Error ? err.message : String(err) }));
  }, [knownHasPassword, token]);

  const keepAccount = async () => {
    if (cancelling) return;
    setCancelling(true);
    setCancelFailed(false);
    try {
      log.info("cancel booked deletion");
      const { user } = await cancelScheduledDeletion(token);
      onUserChanged?.(user);
      setScheduledFor(null);
      await loadOptions();
    } catch (err) {
      log.warn("cancel.failed", { error: err instanceof Error ? err.message : String(err) });
      setCancelFailed(true);
    } finally {
      setCancelling(false);
    }
  };

  const submit = async () => {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    log.info("submit", { withTwoFactorCode: needsCode, mode: periodEndDeleteAt ? mode : null });
    const result = await deleteAccount(token, {
      password: hasPassword ? password : "",
      confirm: DELETE_CONFIRM_WORD,
      ...(needsCode && code.trim() ? { twoFactorCode: code.trim() } : {}),
      ...accountDeletionModeInput(periodEndDeleteAt, mode),
    }).catch((err: unknown) => {
      const mapped = accountDeletionError(err instanceof ApiError ? err.payload?.error : null);
      if (mapped.needsCode) setNeedsCode(true);
      // ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05) says when to try again.
      setError(isRateLimited(err) ? { key: TOO_MANY_ATTEMPTS_KEY, values: signInErrorValues(err) } : { key: `deleteAccount.errors.${mapped.key}` });
      setBusy(false);
      inFlight.current = false;
      return null;
    });
    if (!result) return;
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
      onBooked?.();
      return;
    }
    await onDeleted();
  };

  const bookedDate = bookedDeletionDate(scheduledFor, periodEndDeleteAt, mode);
  const card = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
  return (
    <View style={styles.stack} testID="delete-account">
      <Text style={[styles.warning, { color: theme.colors.danger }]} testID="delete-account-warning">
        {bookedDate ? t("deleteAccount.warningBooked", { date: formatDate(bookedDate) }) : t("deleteAccount.warning")}
      </Text>
      <Text style={[styles.body, { color: theme.colors.textMuted }]}>{t("deleteAccount.keepFiles")}</Text>
      {scheduledFor ? (
        <View style={card} testID="delete-account-scheduled">
          <Text style={[styles.strong, { color: theme.colors.text }]}>{t("deleteAccount.scheduled", { date: formatDate(scheduledFor) })}</Text>
          {cancelFailed ? (
            <Text style={[styles.error, { color: theme.colors.danger }]} accessibilityLiveRegion="polite">
              {t("deleteAccount.cancelScheduledFailed")}
            </Text>
          ) : null}
          <MobileAuthButton testID="delete-account-keep" label={t("deleteAccount.cancelScheduled")} onPress={() => void keepAccount()} disabled={cancelling} />
        </View>
      ) : (
        <View style={card}>
          {periodEndDeleteAt ? (
            <View style={styles.modes} accessibilityRole="radiogroup" testID="delete-account-mode">
              <Text style={[styles.strong, { color: theme.colors.text }]}>{t("deleteAccount.modeTitle")}</Text>
              {(["end_of_period", "now"] as const).map((option) => {
                const selected = option === mode;
                const label = option === "end_of_period" ? t("deleteAccount.modeEndOfPeriod", { date: formatDate(periodEndDeleteAt) }) : t("deleteAccount.modeNow");
                return (
                  <Pressable
                    key={option}
                    style={[styles.mode, { borderColor: selected ? theme.colors.accent : theme.colors.border }]}
                    onPress={() => setMode(option)}
                    accessibilityRole="radio"
                    accessibilityLabel={label}
                    accessibilityState={{ selected }}
                    testID={`delete-account-mode-${option}`}
                  >
                    <View style={[styles.radio, { borderColor: selected ? theme.colors.accent : theme.colors.textMuted }, selected && { backgroundColor: theme.colors.accent }]} />
                    <Text style={[styles.modeLabel, { color: theme.colors.text }]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {hasPassword ? (
            <MobileAuthInput testID="delete-account-password" value={password} onChangeText={setPassword} placeholder={t("deleteAccount.passwordLabel")} secureTextEntry autoCapitalize="none" textContentType="password" autoComplete="current-password" />
          ) : (
            <Text testID="delete-account-recheck-hint" style={[styles.body, { color: theme.colors.textMuted }]}>
              {t("login.code.recheckHint")}
            </Text>
          )}
          <Text style={[styles.body, { color: theme.colors.textMuted }]}>{t("deleteAccount.confirmLabel")}</Text>
          <MobileAuthInput testID="delete-account-confirm" value={confirmText} onChangeText={setConfirmText} placeholder={DELETE_CONFIRM_WORD} autoCapitalize="characters" />
          {needsCode ? (
            <MobileAuthInput testID="delete-account-code" value={code} onChangeText={setCode} placeholder={t("deleteAccount.codeLabel")} autoCapitalize="none" textContentType="oneTimeCode" autoComplete="one-time-code" />
          ) : null}
          {error ? (
            <Text style={[styles.error, { color: theme.colors.danger }]} accessibilityLiveRegion="polite">
              {t(error.key, error.values)}
            </Text>
          ) : null}
          <MobileAuthButton
            testID="delete-account-submit"
            label={busy ? t("deleteAccount.deleting") : t("deleteAccount.delete")}
            bgColor={theme.colors.danger}
            textColor="#ffffff"
            onPress={() => void submit()}
            disabled={!canSubmit}
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  stack: { gap: 16 },
  warning: { fontSize: 15, lineHeight: 21, fontWeight: "700" },
  body: { fontSize: 14, lineHeight: 20 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12 },
  error: { fontSize: 13 },
  strong: { fontSize: 15, lineHeight: 21, fontWeight: "700" },
  modes: { gap: 8 },
  mode: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: 12, borderWidth: 1 },
  radio: { width: 18, height: 18, marginTop: 2, borderRadius: 9, borderWidth: 2 },
  modeLabel: { flex: 1, fontSize: 14, lineHeight: 20 },
});
