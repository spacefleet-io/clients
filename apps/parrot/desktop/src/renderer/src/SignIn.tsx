import { useState, type FormEvent } from "react";
import { Button, Input, LanguageMenu, Spinner } from "@space/ui";
import { BadgerPhoneSignInCard, BadgerSignInDivider } from "@space/ui/badger/sign-in";
import { MASCOT_GLOW } from "@space/ui/floating-mascot";
import {
  DesktopForgotPasswordLink,
  DesktopPasswordResetDialog,
  DesktopStartupCard,
  DesktopStartupControls,
  PairWithPhone,
  pairWithPhoneText,
} from "@space/desktop-shell/components";
import { CLIENT_UI_LANGUAGES, isClientUiLanguage } from "@space/shared/i18n";
import mascotUrl from "@space/parrot-core/mascot.webp";
import type { ParrotPairedSignIn, ParrotState } from "../../shared/ipc";
import { signInFailureText, type Translate } from "./i18n";
import { reconcileAfterSignIn, useAccountLanguagePrompt } from "./accountLanguage";
import { SignUpForm, VerifyEmailForm } from "./SignUp";
import { ProviderSecondStep, ProviderSignIn, useProviderSignInReturn } from "./ProviderSignIn";

type Props = { t: Translate; state: ParrotState; onState: (state: ParrotState) => void };

const pairLog = {
  info: (message: string, extra?: Record<string, unknown>) => console.info(`[parrot:sign-in] ${message}`, extra ?? ""),
  warn: (message: string, extra?: Record<string, unknown>) => console.warn(`[parrot:sign-in] ${message}`, extra ?? ""),
  error: (message: string, extra?: Record<string, unknown>) => console.error(`[parrot:sign-in] ${message}`, extra ?? ""),
};

/**
 * The sign-in screen, before setup (Chris 2026-11-09: "login should come before the setup, not as a step in it").
 * It opens on the email and password form (ACCT-SIGNIN-04); under an "or" line, the shared highlighted "Sign in with
 * another device" card opens the QR code a signed-in Badger or Parrot app approves (ACCT-PAIR-01/05), which hands over
 * the library key so setup then skips the key; "Sign in with email and password instead" comes back to the form.
 * "Create an account" under the form opens sign-up (ACCT-AUTH-10: a desktop app creates accounts), then the emailed
 * code; a sign-in refused because the email is not confirmed yet opens that code step too. Under the email form of the
 * sign-in and sign-up modes, an "or" line and the Google, Apple and Microsoft buttons the API lists (ACCT-SIGNIN-05, ACCT-SIGNIN-07);
 * their return is taken here whatever the mode, and a second sign-in step replaces the email form until answered.
 */
export default function SignIn({ t, state, onState }: Props) {
  const language = state.setup.language;
  const [mode, setMode] = useState<"pair" | "email" | "signUp" | "verify">("email");
  const [verifying, setVerifying] = useState<{ email: string; notice: string | null }>({ email: "", notice: null });
  const pairText = pairWithPhoneText(language);
  const languagePrompt = useAccountLanguagePrompt();
  // UX-I18N-07: right after a fresh sign-in, before setup, the language picked here meets the account's.
  const signedIn = async () => {
    await reconcileAfterSignIn(window.parrot, language, languagePrompt.ask);
    onState(await window.parrot.getState());
  };
  type Notice = { tone: "info" | "error"; text: string } | null;
  const [providerNotice, setProviderNotice] = useState<Notice>(null);
  const providerFlow = useProviderSignInReturn({
    t,
    language,
    onBack: () => setMode("email"),
    onSignedIn: signedIn,
    onMessage: (text) => setProviderNotice(text === null ? null : { tone: "error", text }),
  });
  const providerRows = (rowsMode: "signIn" | "signUp") => (
    <>
      <ProviderSignIn
        t={t}
        language={language}
        mode={rowsMode}
        onStarted={() => setProviderNotice({ tone: "info", text: t("signIn.provider.continueInBrowser") })}
        onError={(text) => setProviderNotice({ tone: "error", text })}
      />
      {providerNotice ? (
        <p
          className={providerNotice.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          role={providerNotice.tone === "error" ? "alert" : "status"}
          data-testid="provider-sign-in-notice"
        >
          {providerNotice.text}
        </p>
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-screen items-center justify-center p-8 pt-32">
      <DesktopStartupControls>
        <LanguageMenu
          current={language}
          languages={CLIENT_UI_LANGUAGES}
          ariaLabel={t("language.title")}
          onSelect={(next) => {
            if (isClientUiLanguage(next)) void window.parrot.saveSetup({ language: next }).then(onState);
          }}
        />
      </DesktopStartupControls>
      <div className="w-full max-w-xl" data-testid="sign-in">
        <DesktopStartupCard
          title={mode === "signUp" ? t("signUp.title") : mode === "verify" ? t("verify.title") : t("signIn.title")}
          mascotSrc={mascotUrl}
          mascotGlowClassName={MASCOT_GLOW.parrot}
          mascotPlacement="above"
          maxWidthClassName="max-w-xl"
        >
          {mode === "pair" ? (
            <PairWithPhone<ParrotPairedSignIn>
              language={language}
              actions={window.parrot.pairing}
              onApproved={async (approved) => {
                if (approved.check === "verified") await signedIn();
                return approved.check;
              }}
              onBack={() => setMode("email")}
              log={pairLog}
            />
          ) : mode === "signUp" ? (
            <div className="space-y-4">
              <SignUpForm
                t={t}
                language={language}
                onCodeSent={(email) => {
                  setVerifying({ email, notice: null });
                  setMode("verify");
                }}
                onSignIn={() => setMode("email")}
              />
              {providerRows("signUp")}
            </div>
          ) : mode === "verify" ? (
            <VerifyEmailForm
              t={t}
              language={language}
              email={verifying.email}
              notice={verifying.notice}
              onVerified={signedIn}
              onBack={() => setMode("email")}
            />
          ) : providerFlow.secondStep ? (
            <ProviderSecondStep t={t} flow={providerFlow} message={providerNotice?.text ?? null} />
          ) : (
            <div className="space-y-4">
              <EmailSignIn
                t={t}
                state={state}
                onSignedIn={signedIn}
                onEmailNotVerified={(email, notice) => {
                  setVerifying({ email, notice });
                  setMode("verify");
                }}
              />
              {providerRows("signIn")}
              <BadgerSignInDivider label={pairText("or")} />
              <BadgerPhoneSignInCard title={pairText("title")} body={pairText("card")} onClick={() => setMode("pair")} />
              <p className="text-center text-sm text-muted-foreground">
                {t("signIn.noAccount")}{" "}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => setMode("signUp")} data-testid="signin-create-account">
                  {t("signIn.createAccount")}
                </button>
              </p>
            </div>
          )}
        </DesktopStartupCard>
      </div>
      {languagePrompt.dialog}
    </div>
  );
}

function EmailSignIn({
  t,
  state,
  onSignedIn,
  onEmailNotVerified,
}: Pick<Props, "t" | "state"> & { onSignedIn: () => Promise<void>; onEmailNotVerified: (email: string, notice: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await window.parrot.signIn({ email: email.trim(), password, twoFactorCode: needsCode ? code.trim() : undefined });
      if (result.ok) {
        await onSignedIn();
        return;
      }
      if (result.failure === "emailNotVerified") {
        // As Badger desktop: an account whose email is not confirmed yet goes to the code step.
        onEmailNotVerified(email.trim(), signInFailureText(state.setup.language, result.failure, result.retryAfterMinutes));
        return;
      }
      if (result.failure === "twoFactorRequired") setNeedsCode(true);
      setError(signInFailureText(state.setup.language, result.failure, result.retryAfterMinutes));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="space-y-3" onSubmit={submit}>
        <Input type="email" autoComplete="username" placeholder={t("signIn.email")} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="signin-email" required />
        <Input type="password" autoComplete="current-password" placeholder={t("signIn.password")} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="signin-password" required />
        {needsCode && <Input inputMode="numeric" placeholder={t("signIn.code")} value={code} onChange={(e) => setCode(e.target.value)} data-testid="signin-code" />}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="text-sm text-muted-foreground" data-testid="signin-notice">
            {notice}
          </p>
        ) : null}
        <Button type="submit" disabled={busy || !email || !password} data-testid="signin-submit">
          {busy ? <Spinner size="sm" /> : t("signIn.submit")}
        </Button>
        {/* ACCT-SIGNIN-05: "Forgot password?" belongs to the password sign-in, so it sits with the form, before the "or" line. */}
        <DesktopForgotPasswordLink language={state.setup.language} onClick={() => setResetOpen(true)} />
      </form>
      <DesktopPasswordResetDialog
        language={state.setup.language}
        open={resetOpen}
        onOpenChange={setResetOpen}
        initialEmail={email}
        actions={window.parrot.passwordReset}
        onComplete={(text) => {
          setError(null);
          setNotice(text);
        }}
      />
    </>
  );
}
