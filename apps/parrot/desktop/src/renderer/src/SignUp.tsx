import { useState, type FormEvent } from "react";
import { Button, Input, Spinner } from "@space/ui";
import { newsOptInText } from "@space/legal";
import { signInErrorText } from "@space/shared/signInError";
import { checkSignUpInput, disposableEmailCheck } from "@space/shared/signUp";
import type { ParrotLanguage } from "../../shared/ipc";
import type { Translate } from "./i18n";

/**
 * ACCT-AUTH-10: a desktop app creates SpaceFleet accounts, Parrot included. The same steps as Badger desktop's
 * sign-up, through the same checks (`@space/shared/signUp`): email, password and repeated password, the unticked News
 * box (ACCT-NEWS-01), then the code the API emails (ACCT-AUTH-01). The token stays in main; an accepted code signs
 * this computer in and setup asks for the library key next, like after any first sign-in.
 */

const log = (message: string, extra?: Record<string, unknown>) => console.info(`[parrot:sign-up] ${message}`, extra ?? "");

// ACCT-AUTH-02: the build's throwaway-domain lists, as in Badger desktop; without lists the API alone decides.
const isDisposableEmail = disposableEmailCheck(import.meta.env.VITE_EMAIL_DOMAIN_ALLOWLIST, import.meta.env.VITE_DISPOSABLE_EMAIL_DOMAINS);

type Common = { t: Translate; language: ParrotLanguage };

export function SignUpForm({ t, language, onCodeSent, onSignIn }: Common & { onCodeSent: (email: string) => void; onSignIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // ACCT-NEWS-01: unticked until the user ticks it.
  const [newsOptIn, setNewsOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmed = email.trim();
    const problem = checkSignUpInput(trimmed, password, confirm, isDisposableEmail);
    if (problem) {
      log("refused before sending", { problem });
      setError(t(`signUp.error.${problem}`));
      return;
    }
    setBusy(true);
    try {
      const result = await window.parrot.signUp({ email: trimmed, password, newsOptIn });
      if (result.ok) {
        log("account created, code emailed", { newsOptIn });
        onCodeSent(trimmed);
        return;
      }
      log("sign-up refused", { failure: result.failure });
      setError(
        result.failure === "rateLimited"
          ? signInErrorText(language, "tooManyAttempts", result.retryAfterMinutes)
          : t(`signUp.error.${result.failure}`),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={submit} data-testid="sign-up">
      <p className="text-sm text-muted-foreground">{t("signUp.body")}</p>
      <Input type="email" autoComplete="email" placeholder={t("signUp.email")} aria-label={t("signUp.email")} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="signup-email" required />
      <Input type="password" autoComplete="new-password" placeholder={t("signUp.password")} aria-label={t("signUp.password")} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="signup-password" required />
      <Input type="password" autoComplete="new-password" placeholder={t("signUp.confirm")} aria-label={t("signUp.confirm")} value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="signup-confirm" required />
      <label className="flex cursor-pointer items-start gap-3 text-left text-sm leading-relaxed text-muted-foreground">
        <input
          type="checkbox"
          data-testid="signup-news-opt-in"
          checked={newsOptIn}
          onChange={(event) => setNewsOptIn(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-primary"
        />
        <span>{newsOptInText(language).newsBox}</span>
      </label>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !email || !password || !confirm} data-testid="signup-submit">
        {busy ? <Spinner size="sm" /> : t("signUp.submit")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t("signUp.haveAccount")}{" "}
        <button type="button" className="font-medium text-primary hover:underline" onClick={onSignIn} data-testid="signup-to-sign-in">
          {t("signUp.signIn")}
        </button>
      </p>
    </form>
  );
}

export function VerifyEmailForm({
  t,
  language,
  email: initialEmail,
  notice,
  onVerified,
  onBack,
}: Common & { email: string; notice?: string | null; onVerified: () => Promise<void>; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(notice ?? null);

  const tooMany = (minutes: number) => signInErrorText(language, "tooManyAttempts", minutes);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const result = await window.parrot.verifyEmail({ email: email.trim(), code: code.trim() });
      if (result.ok) {
        log("email verified, signed in");
        await onVerified();
        return;
      }
      log("code refused", { failure: result.failure });
      setError(result.failure === "rateLimited" ? tooMany(result.retryAfterMinutes) : t(`verify.error.${result.failure}`));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    setMessage(null);
    setSending(true);
    try {
      const result = await window.parrot.resendVerification(email.trim());
      log("resend", result.ok ? { ok: true } : { failure: result.failure });
      if (result.ok) setMessage(t("verify.sent"));
      else setError(result.failure === "rateLimited" ? tooMany(result.retryAfterMinutes) : t(`verify.error.${result.failure}`));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={submit} data-testid="verify-email">
      <p className="text-sm text-muted-foreground">{t("verify.body", { email: email.trim() })}</p>
      {initialEmail ? null : (
        <Input type="email" autoComplete="email" placeholder={t("verify.email")} aria-label={t("verify.email")} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="verify-email-address" required />
      )}
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder={t("verify.code")}
        aria-label={t("verify.code")}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        data-testid="verify-code"
        required
      />
      {message ? (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !email.trim() || !code.trim()} data-testid="verify-submit">
        {busy ? <Spinner size="sm" /> : t("verify.submit")}
      </Button>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <button type="button" className="hover:text-foreground" onClick={onBack} data-testid="verify-back">
          {t("verify.back")}
        </button>
        {/* UX-BTN-01: "Resend code" is the shared ghost button, as in Badger. */}
        <Button type="button" variant="ghost" onClick={() => void resend()} disabled={sending || !email.trim()} data-testid="verify-resend">
          {t("verify.resend")}
        </Button>
      </div>
    </form>
  );
}
