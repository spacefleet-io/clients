/**
 * "Forgot password?" on Badger and Parrot desktop (ACCT-AUTH-05). The link sits with the email and password form,
 * right under its Sign in button and before the "or" line of the Google, Apple and Microsoft buttons
 * (ACCT-SIGNIN-05): it belongs to the password sign-in. It opens the reset dialog: the email gets a code, then the
 * code and a new password reset it. The app hands the API calls in (`DesktopPasswordResetActions`).
 */
import { useEffect, useState, type FormEvent } from "react";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label } from "@space/ui";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { signInErrorText } from "@space/shared/signInError";
import type { DesktopPasswordResetActions, DesktopPasswordResetResult } from "../passwordReset";
import { DesktopAuthPrompt, desktopAuthPromptActionClassName } from "./desktop-auth-form";
import { passwordResetText, type PasswordResetStringKey } from "./password-reset-strings";

/** The "Forgot password?" link, under the form's Sign in button. */
export const DesktopForgotPasswordLink = ({ language, onClick }: { language: ClientUiLanguage; onClick: () => void }) => (
  <DesktopAuthPrompt>
    <button type="button" className={desktopAuthPromptActionClassName} onClick={onClick} data-testid="forgot-password">
      {passwordResetText(language)("button")}
    </button>
  </DesktopAuthPrompt>
);

type DialogProps = {
  language: ClientUiLanguage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the sign-in form holds when the dialog opens. */
  initialEmail: string;
  actions: DesktopPasswordResetActions;
  /** The new password is set: the dialog closed, the sign-in screen says so (`noticeComplete`). */
  onComplete: (notice: string) => void;
};

export function DesktopPasswordResetDialog({ language, open, onOpenChange, initialEmail, actions, onComplete }: DialogProps) {
  const text = passwordResetText(language);
  const [step, setStep] = useState<"request" | "confirm">("request");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep("request");
    setEmail(initialEmail);
    setCode("");
    setPassword("");
    setPasswordConfirm("");
    setNotice(null);
    setError(null);
  }, [open, initialEmail]);

  const failureText = (result: Exclude<DesktopPasswordResetResult, { ok: true }>, fallback: PasswordResetStringKey) =>
    result.failure === "tooManyAttempts"
      ? signInErrorText(language, "tooManyAttempts", result.retryAfterMinutes)
      : result.failure === "invalidCode"
        ? text("errorInvalidCode")
        : text(fallback);

  const submitRequest = async () => {
    setBusy(true);
    const result = await actions.request(email);
    setBusy(false);
    // A refused request says when to try again; any other failure reads like a sent code, as the API answers either way.
    if (!result.ok && result.failure === "tooManyAttempts") {
      setError(failureText(result, "errorFailed"));
      return;
    }
    setStep("confirm");
    setNotice(text("noticeSent"));
  };

  const submitConfirm = async () => {
    if (password !== passwordConfirm) {
      setError(text("errorMismatch"));
      return;
    }
    setBusy(true);
    const result = await actions.confirm({ email, code, newPassword: password });
    setBusy(false);
    if (result.ok) {
      onOpenChange(false);
      onComplete(text("noticeComplete"));
      return;
    }
    setError(failureText(result, "errorFailed"));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    void (step === "request" ? submitRequest() : submitConfirm());
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    const result = await actions.request(email);
    setResending(false);
    if (result.ok) setNotice(text("noticeResent"));
    else setError(failureText(result, "errorResend"));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="password-reset-dialog">
        <DialogHeader>
          <DialogTitle>{text("title")}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <p className="text-sm text-muted-foreground">{text("subtitle")}</p>
          {notice ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" data-testid="password-reset-notice">
              {notice}
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="resetEmail">{text("emailLabel")}</Label>
            <Input
              id="resetEmail"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              disabled={step === "confirm"}
            />
          </div>
          {step === "confirm" ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="resetCode">{text("codeLabel")}</Label>
                <Input
                  id="resetCode"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={text("codePlaceholder")}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="resetPassword">{text("passwordLabel")}</Label>
                <Input
                  id="resetPassword"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="resetPasswordConfirm">{text("passwordConfirmLabel")}</Label>
                <Input
                  id="resetPasswordConfirm"
                  type="password"
                  value={passwordConfirm}
                  onChange={(event) => setPasswordConfirm(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-3 text-muted-foreground"
                  onClick={() => void resend()}
                  disabled={resending}
                >
                  {resending ? text("resending") : text("resend")}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? text("submitting") : text("submit")}
                </Button>
              </div>
            </>
          ) : (
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {text("cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? text("requesting") : text("request")}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
