import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { BombIcon, RotateCwIcon } from "lucide-react";
import {
  ApiError,
  TwoFactorMethod,
  cancelScheduledDeletion,
  changePassword,
  confirmEmailTwoFactorEnable,
  confirmTotp,
  disableTwoFactor,
  getDeletionOptions,
  getSettings,
  requestEmailTwoFactorEnable,
  setupTotp,
} from "@/api";
import { useAuth, useHasPassword } from "@/auth";
import { Button, Input, Label } from "@space/ui";
import { keyChangeOffered } from "@space/shared/keyChange";
import { isClientUiLanguage } from "@space/shared";
import { keyChangeText } from "@space/shared/keyChangeText";
import { useKeyRotationReadiness } from "@space/shared/useKeyRotationReadiness";
import { tooManyAttemptsText } from "@space/shared/signInError";
import { useLibraryRecoveryFlows } from "@/lib/settings/useLibraryRecoveryFlows";
import { SettingHint, SettingPanel } from "../kit";

const AccountTwoFactorSection = lazy(() => import("../../../pages/AccountTwoFactorSection"));
const AccountDeleteDialog = lazy(() => import("../../../pages/AccountDeleteDialog"));
const SettingsRecoveryDialogs = lazy(() => import("../../../pages/SettingsRecoveryDialogs"));

const getApiErrorMessage = (error: unknown, t: (key: string) => string) => {
  if (error instanceof ApiError) {
    switch (error.payload.error) {
      case "invalid_credentials":
        return t("account.errors.invalidCredentials");
      case "invalid_code":
        return t("account.errors.invalidCode");
      case "setup_expired":
        return t("account.errors.setupExpired");
      case "invalid_password":
        return t("account.twoFactor.errors.invalidPassword");
      case "two_factor_required":
        return t("account.twoFactor.errors.twoFactorRequired");
      case "two_factor_invalid":
        return t("account.twoFactor.errors.twoFactorInvalid");
      default:
        return t("account.errors.generic");
    }
  }
  return t("account.errors.generic");
};

export default function SecuritySection() {
  const { t, i18n } = useTranslation();
  const keyChangeT = keyChangeText(isClientUiLanguage(i18n.language) ? i18n.language : "en");
  const { token, logout } = useAuth();
  const recovery = useLibraryRecoveryFlows();
  // ACCT-AUTH-04 / ACCT-AUTH-05: an account without a password sets its first one here, confirmed by a code.
  const hasPassword = useHasPassword();
  const [searchParams, setSearchParams] = useSearchParams();
  const { setShowKeyOpen } = recovery;
  // ACCT-KEYCHG-04: the key-change card shows exactly when the server would accept the change.
  const keyChange = keyChangeOffered("badger-desktop", useKeyRotationReadiness(token));

  // ACCT-DEV-03: "Show my key" in the sign-out question lands here with `showKey=1`; open the show-key dialog once and
  // drop the param so a reload or Back does not open it again.
  useEffect(() => {
    if (searchParams.get("showKey") !== "1") return;
    setShowKeyOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("showKey");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, setShowKeyOpen]);

  // --- password ---
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordRepeat, setNewPasswordRepeat] = useState("");
  const [passwordCodeAsked, setPasswordCodeAsked] = useState(false);
  const [passwordCode, setPasswordCode] = useState("");

  // --- delete account ---
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** ACCT-DEL-03: end of the paid year a delete request would be booked for (null: deleting is immediate). */
  const [periodEndDeleteAt, setPeriodEndDeleteAt] = useState<string | null>(null);
  /** ACCT-DEL-03: date of a deletion already booked. */
  const [deletionScheduledFor, setDeletionScheduledFor] = useState<string | null>(null);
  const [keepBusy, setKeepBusy] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);

  const loadDeletionOptions = useCallback(async () => {
    if (!token) return;
    try {
      const options = await getDeletionOptions(token);
      setPeriodEndDeleteAt(options.periodEndDeleteAt);
      setDeletionScheduledFor(options.scheduledFor);
    } catch {
      // Without the options the dialog still works: the API decides what a request does.
      setPeriodEndDeleteAt(null);
    }
  }, [token]);

  useEffect(() => {
    void loadDeletionOptions();
  }, [loadDeletionOptions]);

  const keepAccount = async () => {
    if (!token) return;
    setKeepBusy(true);
    setKeepError(null);
    try {
      await cancelScheduledDeletion(token);
      setDeletionScheduledFor(null);
      await loadDeletionOptions();
    } catch {
      setKeepError(t("account.deletion.cancelScheduledFailed"));
    } finally {
      setKeepBusy(false);
    }
  };

  // --- two factor ---
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [twoFactorMethod, setTwoFactorMethod] = useState<TwoFactorMethod | null>(null);
  const [twoFactorBusy, setTwoFactorBusy] = useState(false);
  const [twoFactorMessage, setTwoFactorMessage] = useState<string | null>(null);
  const [twoFactorError, setTwoFactorError] = useState<string | null>(null);
  const [enableFlowOpen, setEnableFlowOpen] = useState(false);
  const [enableMethod, setEnableMethod] = useState<TwoFactorMethod | "">("");
  const [emailEnableRequested, setEmailEnableRequested] = useState(false);
  const [emailEnableCode, setEmailEnableCode] = useState("");
  const [totpSetupState, setTotpSetupState] = useState<{ secret: string; otpauthUrl: string; qrCode: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [disableFlowOpen, setDisableFlowOpen] = useState(false);
  const [reauthPassword, setReauthPassword] = useState("");
  const [reauthCode, setReauthCode] = useState("");
  const [reauthCodeAsked, setReauthCodeAsked] = useState(false);

  useEffect(() => {
    if (!token) return;
    let mounted = true;
    getSettings(token)
      .then((settings) => {
        if (!mounted) return;
        setTwoFactorEnabled(settings.twoFactorEnabled);
        setTwoFactorMethod(settings.twoFactorMethod);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [token]);

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setSecurityMessage(null);
    if (newPassword.length < 8) {
      setSecurityMessage(t("account.security.errors.passwordLength"));
      return;
    }
    if (newPassword !== newPasswordRepeat) {
      setSecurityMessage(t("account.security.errors.passwordMismatch"));
      return;
    }
    setSecurityBusy(true);
    try {
      await changePassword(token, hasPassword ? currentPassword : "", newPassword, passwordCode.trim() || undefined);
      setSecurityMessage(t(hasPassword ? "account.security.changed" : "account.security.setDone"));
      // The API signs every session out on a password change; the key is unchanged, so keep it.
      await logout("sessionRejected");
    } catch (error) {
      // ACCT-AUTH-04: with 2FA on, the API asks for the second-step code before changing the password.
      const code = error instanceof ApiError ? error.payload.error : null;
      if (code === "two_factor_required" || code === "two_factor_invalid") {
        setPasswordCodeAsked(true);
        setSecurityMessage(
          t(code === "two_factor_required" ? "account.security.errors.twoFactorRequired" : "account.security.errors.twoFactorInvalid"),
        );
      } else {
        // ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05) says when to try again.
        setSecurityMessage(tooManyAttemptsText(t, error) ?? getApiErrorMessage(error, t));
      }
    } finally {
      setSecurityBusy(false);
    }
  };

  const resetTwoFactorFlows = () => {
    setEnableFlowOpen(false);
    setEnableMethod("");
    setEmailEnableRequested(false);
    setEmailEnableCode("");
    setTotpSetupState(null);
    setTotpCode("");
    setDisableFlowOpen(false);
    setReauthPassword("");
    setReauthCode("");
    setReauthCodeAsked(false);
    setTwoFactorBusy(false);
    setTwoFactorError(null);
    setTwoFactorMessage(null);
  };

  // ACCT-AUTH-04: the password (and the current code while 2FA is on) goes with every request that turns the second
  // step on, replaces it or turns it off. A `two_factor_required` answer for email 2FA means the API just emailed it.
  const reauth = () => ({ password: reauthPassword, twoFactorCode: reauthCode.trim() || undefined });

  const showReauthError = (error: unknown) => {
    const code = error instanceof ApiError ? error.payload.error : null;
    if (code === "two_factor_required" || code === "two_factor_invalid") {
      setReauthCodeAsked(true);
      if (code === "two_factor_required" && error instanceof ApiError && error.payload.method === "email") {
        setTwoFactorMessage(t("account.twoFactor.messages.codeSent"));
      }
    }
    // ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05) says when to try again.
    setTwoFactorError(tooManyAttemptsText(t, error) ?? getApiErrorMessage(error, t));
  };

  const startEnable = () => {
    setTwoFactorMessage(null);
    setTwoFactorError(null);
    setDisableFlowOpen(false);
    setReauthPassword("");
    setReauthCode("");
    setReauthCodeAsked(false);
    setEnableFlowOpen(true);
    setEnableMethod("");
  };

  const requestEmailEnable = async () => {
    if (!token) return;
    setTwoFactorBusy(true);
    setTwoFactorMessage(null);
    setTwoFactorError(null);
    try {
      await requestEmailTwoFactorEnable(token, reauth());
      setEmailEnableRequested(true);
      setTwoFactorMessage(t("account.twoFactor.messages.codeSent"));
    } catch (error) {
      showReauthError(error);
    } finally {
      setTwoFactorBusy(false);
    }
  };

  const confirmEmailEnable = async () => {
    if (!token) return;
    setTwoFactorBusy(true);
    setTwoFactorMessage(null);
    setTwoFactorError(null);
    try {
      await confirmEmailTwoFactorEnable(token, emailEnableCode);
      setTwoFactorEnabled(true);
      setTwoFactorMethod("email");
      resetTwoFactorFlows();
    } catch (error) {
      setTwoFactorError(getApiErrorMessage(error, t));
    } finally {
      setTwoFactorBusy(false);
    }
  };

  const generateTotpSetup = async () => {
    if (!token) return;
    setTwoFactorBusy(true);
    setTwoFactorMessage(null);
    setTwoFactorError(null);
    try {
      const result = await setupTotp(token, reauth());
      setTotpSetupState(result);
      setTwoFactorMessage(t("account.twoFactor.messages.totpReady"));
    } catch (error) {
      showReauthError(error);
    } finally {
      setTwoFactorBusy(false);
    }
  };

  const confirmTotpEnable = async () => {
    if (!token) return;
    setTwoFactorBusy(true);
    setTwoFactorMessage(null);
    setTwoFactorError(null);
    try {
      await confirmTotp(token, totpCode);
      setTwoFactorEnabled(true);
      setTwoFactorMethod("totp");
      resetTwoFactorFlows();
    } catch (error) {
      setTwoFactorError(getApiErrorMessage(error, t));
    } finally {
      setTwoFactorBusy(false);
    }
  };

  const startDisable = () => {
    setTwoFactorMessage(null);
    setTwoFactorError(null);
    setEnableFlowOpen(false);
    setEnableMethod("");
    setDisableFlowOpen(true);
    setReauthPassword("");
    setReauthCode("");
    setReauthCodeAsked(false);
  };

  const confirmDisable = async () => {
    if (!token) return;
    setTwoFactorBusy(true);
    setTwoFactorMessage(null);
    setTwoFactorError(null);
    try {
      await disableTwoFactor(token, reauth());
      setTwoFactorEnabled(false);
      setTwoFactorMethod(null);
      resetTwoFactorFlows();
    } catch (error) {
      showReauthError(error);
    } finally {
      setTwoFactorBusy(false);
    }
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setTwoFactorMessage(t("account.twoFactor.messages.copySuccess"));
    } catch {
      setTwoFactorMessage(t("account.twoFactor.messages.copyFail"));
    }
  };

  return (
    <div className="space-y-4">
      {/* Password */}
      <SettingPanel>
        <div className="space-y-1">
          <div className="font-semibold">{t(hasPassword ? "account.security.title" : "account.security.setTitle")}</div>
          <SettingHint>{t(hasPassword ? "account.security.subtitle" : "account.security.setSubtitle")}</SettingHint>
        </div>
        <form className="mt-4 grid gap-4" onSubmit={submitPassword}>
          {securityMessage ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">{securityMessage}</div>
          ) : null}
          {hasPassword ? (
            <div className="grid gap-2">
              <Label htmlFor="currentPassword">{t("account.security.currentPassword")}</Label>
              <Input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="newPassword">{t("account.security.newPassword")}</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="newPasswordRepeat">{t("account.security.repeatNewPassword")}</Label>
            <Input
              id="newPasswordRepeat"
              type="password"
              value={newPasswordRepeat}
              onChange={(e) => setNewPasswordRepeat(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          {passwordCodeAsked ? (
            <div className="grid gap-2">
              <Label htmlFor="passwordChangeCode">{t("account.twoFactor.verificationCode")}</Label>
              <Input
                id="passwordChangeCode"
                inputMode="numeric"
                value={passwordCode}
                onChange={(e) => setPasswordCode(e.target.value)}
                placeholder={t("account.twoFactor.codePlaceholder")}
                autoComplete="one-time-code"
              />
            </div>
          ) : null}
          <Button type="submit" className="w-fit" disabled={securityBusy}>
            {securityBusy
              ? t("account.security.updating")
              : t(hasPassword ? "account.security.change" : "account.security.set")}
          </Button>
        </form>
      </SettingPanel>

      {/* Two-factor */}
      <Suspense fallback={<div className="h-40 rounded-xl border border-border bg-card/40" />}>
        <AccountTwoFactorSection
          twoFactorEnabled={twoFactorEnabled}
          twoFactorMethod={twoFactorMethod}
          twoFactorBusy={twoFactorBusy}
          twoFactorMessage={twoFactorMessage}
          twoFactorError={twoFactorError}
          enableFlowOpen={enableFlowOpen}
          enableMethod={enableMethod}
          setEnableMethod={(value) => setEnableMethod(value)}
          emailEnableRequested={emailEnableRequested}
          emailEnableCode={emailEnableCode}
          setEmailEnableCode={setEmailEnableCode}
          totpSetupState={totpSetupState}
          totpCode={totpCode}
          setTotpCode={setTotpCode}
          disableFlowOpen={disableFlowOpen}
          reauthPassword={reauthPassword}
          setReauthPassword={setReauthPassword}
          reauthCode={reauthCode}
          setReauthCode={setReauthCode}
          reauthCodeAsked={reauthCodeAsked}
          resetTwoFactorFlows={resetTwoFactorFlows}
          startEnable={startEnable}
          requestEmailEnable={() => void requestEmailEnable()}
          confirmEmailEnable={() => void confirmEmailEnable()}
          generateTotpSetup={() => void generateTotpSetup()}
          confirmTotpEnable={() => void confirmTotpEnable()}
          copyText={(value) => void copyText(value)}
          startDisable={startDisable}
          confirmDisable={() => void confirmDisable()}
        />
      </Suspense>

      {/* Encryption key */}
      <SettingPanel>
        <div className="space-y-1">
          <div className="font-semibold">{t("settings.recovery.title")}</div>
          <SettingHint>{t("settings.recovery.subtitle")}</SettingHint>
        </div>
        <div className={keyChange ? "mt-4 grid gap-3 sm:grid-cols-2" : "mt-4 grid gap-3"}>
          <div className="rounded-xl border border-border p-4">
            <div className="space-y-1">
              <div className="font-semibold">{t("settings.recovery.show.title")}</div>
              <SettingHint>{t("settings.recovery.show.subtitle")}</SettingHint>
            </div>
            <div className="pt-3">
              <Button type="button" variant="secondary" onClick={() => recovery.setShowKeyOpen(true)}>
                {t("settings.recovery.show.button")}
              </Button>
            </div>
          </div>
          {/* ACCT-KEYCHG-04: no key-change entry while the account's media could not be re-sealed. */}
          {keyChange ? (
            <div className="rounded-xl border border-border p-4" data-testid="settings-key-change">
              <div className="space-y-1">
                <div className="font-semibold">{keyChangeT("entry.title")}</div>
                <SettingHint>{keyChangeT("entry.body")}</SettingHint>
              </div>
              <div className="pt-3">
                <Button type="button" variant="secondary" onClick={() => recovery.setRecoveryOpen(true)}>
                  <RotateCwIcon className="mr-2 h-4 w-4" />
                  {keyChangeT("entry.button")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </SettingPanel>

      {/* Danger zone */}
      <SettingPanel tone="danger">
        <div className="space-y-1">
          <div className="font-semibold text-destructive">{t("settings.dangerZone.title")}</div>
          <SettingHint>{t("settings.dangerZone.subtitle")}</SettingHint>
        </div>
        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-background/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="font-semibold text-destructive">{t("settings.recovery.reset.title")}</div>
              <SettingHint>{t("settings.recovery.reset.subtitle")}</SettingHint>
            </div>
            <Button type="button" variant="destructive" className="shrink-0" onClick={() => recovery.setResetOpen(true)}>
              <BombIcon className="mr-2 h-4 w-4" />
              {t("settings.recovery.reset.button")}
            </Button>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-background/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="font-semibold text-destructive">{t("account.deletion.title")}</div>
              {/* ACCT-DEL-03: once booked, the card names the date and that "Keep my account" undoes it. */}
              <SettingHint>
                {deletionScheduledFor
                  ? t("account.deletion.bookedDescription", {
                      date: new Date(deletionScheduledFor).toLocaleDateString(i18n.language),
                    })
                  : t("account.deletion.subtitle")}
              </SettingHint>
              <SettingHint>{t("account.deletion.downloadFirst")}</SettingHint>
              {deletionScheduledFor ? (
                <div className="font-medium text-destructive" data-testid="account-delete-scheduled">
                  {t("account.deletion.scheduled", {
                    date: new Date(deletionScheduledFor).toLocaleDateString(i18n.language),
                  })}
                </div>
              ) : null}
              {keepError ? (
                <div role="alert" className="text-sm text-destructive">
                  {keepError}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {deletionScheduledFor ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={keepBusy}
                  data-testid="account-delete-keep"
                  onClick={() => void keepAccount()}
                >
                  {t("account.deletion.cancelScheduled")}
                </Button>
              ) : (
                <Button type="button" variant="destructive" onClick={() => setDeleteOpen(true)}>
                  {t("account.deletion.delete")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </SettingPanel>

      {/* Dialogs */}
      {recovery.anyDialogOpen ? (
        <Suspense fallback={null}>
          <SettingsRecoveryDialogs
            showKeyOpen={recovery.showKeyOpen}
            setShowKeyOpen={recovery.setShowKeyOpen}
            showKeyValue={recovery.showKeyValue}
            copyShowKey={recovery.copyShowKey}
            showKeyPassword={recovery.showKeyPassword}
            setShowKeyPassword={recovery.setShowKeyPassword}
            showKeyNeedsCode={recovery.showKeyNeedsCode}
            showKeyCode={recovery.showKeyCode}
            setShowKeyCode={recovery.setShowKeyCode}
            showKeyMethod={recovery.showKeyMethod}
            showKeyNotice={recovery.showKeyNotice}
            showKeyError={recovery.showKeyError}
            showKeyBusy={recovery.showKeyBusy}
            submitShowKey={recovery.submitShowKey}
            recoveryOpen={recovery.recoveryOpen}
            setRecoveryOpen={recovery.setRecoveryOpen}
            recoveryKey={recovery.recoveryKey}
            copyRecoveryKey={recovery.copyRecoveryKey}
            recoveryConfirmed={recovery.recoveryConfirmed}
            setRecoveryConfirmed={recovery.setRecoveryConfirmed}
            recoveryPassword={recovery.recoveryPassword}
            setRecoveryPassword={recovery.setRecoveryPassword}
            recoveryNeedsCode={recovery.recoveryNeedsCode}
            recoveryCode={recovery.recoveryCode}
            setRecoveryCode={recovery.setRecoveryCode}
            recoveryMethod={recovery.recoveryMethod}
            recoveryNotice={recovery.recoveryNotice}
            recoveryError={recovery.recoveryError}
            recoveryBusy={recovery.recoveryBusy}
            submitRecovery={recovery.submitRecovery}
            keyChange={recovery.keyChange}
            resetOpen={recovery.resetOpen}
            setResetOpen={recovery.setResetOpen}
            resetConfirmed={recovery.resetConfirmed}
            setResetConfirmed={recovery.setResetConfirmed}
            resetPassword={recovery.resetPassword}
            setResetPassword={recovery.setResetPassword}
            resetNeedsCode={recovery.resetNeedsCode}
            resetCode={recovery.resetCode}
            setResetCode={recovery.setResetCode}
            resetMethod={recovery.resetMethod}
            resetNotice={recovery.resetNotice}
            resetError={recovery.resetError}
            resetBusy={recovery.resetBusy}
            submitReset={recovery.submitReset}
            resetResending={recovery.resetResending}
            resendResetCode={recovery.resendResetCode}
          />
        </Suspense>
      ) : null}

      <Suspense fallback={null}>
        <AccountDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          periodEndDeleteAt={periodEndDeleteAt}
          onScheduled={(deleteAt) => {
            setDeletionScheduledFor(deleteAt);
            setPeriodEndDeleteAt(null);
          }}
        />
      </Suspense>
    </div>
  );
}
