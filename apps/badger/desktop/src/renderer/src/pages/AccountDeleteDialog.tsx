import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@space/ui";
import { ApiError, deleteAccount } from "@/api";
import { useAuth, useHasPassword } from "@/auth";
import ReauthPasswordField from "@/components/ReauthPasswordField";
import { rendererLogger } from "@/logger";
import { bookedDeletionDate, type AccountDeletionMode } from "@space/shared/accountDeletion";
import { tooManyAttemptsText } from "@space/shared/signInError";

const log = rendererLogger.child({ scope: "account-delete" });

/** The word the user must type to confirm; the API checks it again (`confirm_required`). */
export const DELETE_CONFIRM_WORD = "DELETE";

type AccountDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ACCT-DEL-03: end of the paid year a request would be booked for; null/absent: deleting is immediate. */
  periodEndDeleteAt?: string | null;
  /** ACCT-DEL-03: the deletion was booked for `deleteAt`; the account keeps working, so no logout. */
  onScheduled?: (deleteAt: string) => void;
};

/**
 * Irreversible account deletion (#145 step 5): warns that the Media library is
 * wiped, tells the user to download it to this computer first, then needs the
 * password plus the typed word DELETE (plus a 2FA code when the API asks for
 * one). On success the account is scheduled for deletion and the user is logged
 * out. ACCT-DEL-03: on a paid yearly plan past its guarantee the user picks "at
 * the end of your paid year" (default: booked, the account keeps working, no
 * logout) or "now, no refund".
 */
export default function AccountDeleteDialog({ open, onOpenChange, periodEndDeleteAt = null, onScheduled }: AccountDeleteDialogProps) {
  const { t, i18n } = useTranslation();
  const { token, logout } = useAuth();
  // ACCT-AUTH-04: an account without a password confirms with the code alone (the first try emails it).
  const hasPassword = useHasPassword();
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AccountDeletionMode>("end_of_period");

  // A closed dialog must not keep a password (or a half-typed DELETE) in memory.
  useEffect(() => {
    if (open) return;
    setPassword("");
    setConfirmText("");
    setNeedsCode(false);
    setCode("");
    setError(null);
    setMode("end_of_period");
  }, [open]);

  const confirmed = confirmText === DELETE_CONFIRM_WORD;
  // ACCT-DEL-03: booking the end-of-year deletion can be undone until that date, so the intro must not say "permanently".
  const bookedDate = bookedDeletionDate(null, periodEndDeleteAt, mode);
  const canSubmit =
    Boolean(token) && confirmed && (!hasPassword || password.length > 0) && (!needsCode || code.trim().length > 0) && !busy;

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!token || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      log.info({ withTwoFactorCode: needsCode, mode: periodEndDeleteAt ? mode : null }, "deleting account");
      const result = await deleteAccount(token, {
        password,
        confirm: DELETE_CONFIRM_WORD,
        ...(needsCode && code.trim() ? { twoFactorCode: code.trim() } : {}),
        ...(periodEndDeleteAt ? { mode } : {}),
      });
      if (result.status === "deletion_scheduled_for_period_end") {
        log.info({ deleteAt: result.deleteAt }, "account deletion booked for the end of the paid year");
        onOpenChange(false);
        onScheduled?.(result.deleteAt);
        return;
      }
      log.info({}, "account deletion scheduled; logging out");
      onOpenChange(false);
      await logout("signOut");
    } catch (err) {
      const apiCode = err instanceof ApiError ? err.payload?.error : undefined;
      log.warn({ apiCode: apiCode ?? null, message: err instanceof Error ? err.message : String(err) }, "account deletion failed");
      switch (apiCode) {
        case "invalid_password":
          setError(t("account.deletion.errors.invalidPassword"));
          break;
        case "two_factor_required":
          setNeedsCode(true);
          setError(t("account.deletion.errors.twoFactorRequired"));
          break;
        case "two_factor_invalid":
          setNeedsCode(true);
          setError(t("account.deletion.errors.twoFactorInvalid"));
          break;
        case "confirm_required":
          setError(t("account.deletion.errors.confirmRequired"));
          break;
        default:
          // ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05) says when to try again.
          setError(tooManyAttemptsText(t, err) ?? t("account.deletion.failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="space-y-4" data-testid="account-delete-form">
          <DialogHeader>
            <DialogTitle>{bookedDate ? t("account.deletion.bookedTitle") : t("account.deletion.confirmTitle")}</DialogTitle>
            <DialogDescription data-testid="account-delete-intro">
              {bookedDate
                ? t("account.deletion.bookedDescription", { date: new Date(bookedDate).toLocaleDateString(i18n?.language) })
                : t("account.deletion.confirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <div
            role="note"
            data-testid="account-delete-download-warning"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <span>{t("account.deletion.downloadWarning")}</span>
          </div>
          {periodEndDeleteAt ? (
            <fieldset className="space-y-2" data-testid="account-delete-mode">
              <legend className="mb-1 text-sm font-medium">{t("account.deletion.modeTitle")}</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="account-delete-mode"
                  data-testid="account-delete-mode-end"
                  className="mt-1"
                  checked={mode === "end_of_period"}
                  onChange={() => setMode("end_of_period")}
                />
                <span>
                  {t("account.deletion.modeEndOfPeriod", {
                    date: new Date(periodEndDeleteAt).toLocaleDateString(i18n?.language),
                  })}
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="account-delete-mode"
                  data-testid="account-delete-mode-now"
                  className="mt-1"
                  checked={mode === "now"}
                  onChange={() => setMode("now")}
                />
                <span>{t("account.deletion.modeNow")}</span>
              </label>
            </fieldset>
          ) : null}
          <div className="space-y-2">
            <ReauthPasswordField
              id="accountDeletePassword"
              label={t("account.deletion.passwordLabel")}
              value={password}
              onChange={setPassword}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="accountDeleteConfirm">{t("account.deletion.confirmLabel")}</Label>
            <Input
              id="accountDeleteConfirm"
              autoComplete="off"
              placeholder={t("account.deletion.confirmPlaceholder")}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
          </div>
          {needsCode ? (
            <div className="space-y-2">
              <Label htmlFor="accountDeleteCode">{t("account.deletion.twoFactorLabel")}</Label>
              <Input
                id="accountDeleteCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t("account.deletion.twoFactorPlaceholder")}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("account.deletion.twoFactorPrompt")}</p>
            </div>
          ) : null}
          {error ? (
            <div role="alert" data-testid="account-delete-error" className="text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t("account.deletion.cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={!canSubmit} data-testid="account-delete-confirm">
              {busy ? t("account.deletion.deleting") : t("account.deletion.delete")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
