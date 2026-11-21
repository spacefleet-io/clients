import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Lock, Mail } from "lucide-react";
import PublicTopNav from "../components/PublicTopNav";
import { ApiError, TwoFactorMethod, completeProviderSignIn, confirmPasswordReset, requestPasswordReset } from "../api";
import {
  classifySignInError,
  signInErrorDetails,
  signInErrorMessageKey,
  signInErrorValues,
  tooManyAttemptsText,
} from "@space/shared/signInError";
import { useAuth } from "../auth";
import { Button } from "@space/ui";
import { Input } from "@space/ui";
import { Label } from "@space/ui";
import { BadgerPhoneSignInCard, BadgerSignInDivider } from "@space/ui/badger/sign-in";
import { isClientUiLanguage } from "@space/shared";
import AuthApiHostButton from "@/components/AuthApiHostButton";
import {
  AuthCardLayout,
  DesktopAuthPrimaryButton,
  DesktopAuthPrompt,
  DesktopForgotPasswordLink,
  DesktopPasswordResetDialog,
  DesktopStartupControls,
  DesktopStartupPage,
  NoticeSurface,
  PairWithPhone,
  desktopAuthInputClassName,
  desktopAuthPromptActionClassName,
  pairWithPhoneText,
} from "@space/desktop-shell/components";
import { createPasswordResetActions } from "@space/desktop-shell/password-reset";
import mascotWebp from "@/assets/mascot.webp";
import { completePairedSignIn, type ApprovedPairing } from "@/lib/pairedSignIn";
import { createPairedSignInDeps } from "@/lib/pairedSignInDeps";
import { rendererLogger } from "@/logger";
import SetupLanguageMenu from "@/components/SetupLanguageMenu";
import { PROVIDER_VERIFIER_KEY, ProviderSignIn, providerErrorKey } from "@/components/ProviderSignIn";
import { useProviderReturn } from "@space/desktop-shell/provider-return";
import type { ProviderReturn } from "@space/shared/providerSignIn";

const log = rendererLogger.child({ scope: "login" });
// ACCT-AUTH-05: the shared reset dialog over this window's API calls (Parrot desktop runs the same ones from main).
const passwordResetActions = createPasswordResetActions({ requestPasswordReset, confirmPasswordReset }, (line) =>
  log.warn({}, line),
);

export default function Login() {
  const { t, i18n } = useTranslation();
  const pairLanguage = isClientUiLanguage(i18n.language) ? i18n.language : "en";
  const { login, systemIssue, setSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [twoFactorMethod, setTwoFactorMethod] = useState<TwoFactorMethod | null>(null);
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const mascotSrc = mascotWebp;
  const autoLoginAttempted = useRef(false);
  // The email form is the sign-in screen; the highlighted phone card under it opens pairing (ACCT-SIGNIN-03/04).
  const pairingAvailable = Boolean(window.sf?.pairing);
  const [mode, setMode] = useState<"pair" | "email">("email");
  const completePairing = async (approved: ApprovedPairing) => {
    const check = await completePairedSignIn(
      createPairedSignInDeps(setSession, (message, extra) => log.info(extra ?? {}, message)),
      approved,
    );
    if (check === "verified") navigate("/");
    return check;
  };

  // ACCT-SIGNIN-05: the `signinCode` a Google, Apple or Microsoft sign-in came back with, kept while the account's
  // second step is asked for (the same code is traded again with it).
  const [providerCode, setProviderCode] = useState<string | null>(null);

  const dropProviderSignIn = () => {
    localStorage.removeItem(PROVIDER_VERIFIER_KEY);
    setProviderCode(null);
    setTwoFactorRequired(false);
    setTwoFactorMethod(null);
    setTwoFactorCode("");
  };

  /** Trades the returned code and this computer's secret for a session; on a second step, keeps the code and asks for it. */
  const finishProviderSignIn = async (code: string, secondStepCode?: string) => {
    const verifier = localStorage.getItem(PROVIDER_VERIFIER_KEY);
    if (!verifier) {
      // Started on another computer or another Badger: its secret is not here.
      log.warn({}, "provider.return.noSecret");
      setError(t(providerErrorKey("invalid_code")));
      return;
    }
    try {
      const result = await completeProviderSignIn(code, verifier, secondStepCode);
      localStorage.removeItem(PROVIDER_VERIFIER_KEY);
      setProviderCode(null);
      setSession(result.token, result.user);
      log.info({}, "provider.signedIn");
      navigate("/");
    } catch (err) {
      const tooMany = tooManyAttemptsText(t, err);
      const apiError = err instanceof ApiError ? err : null;
      const apiCode = typeof apiError?.payload.error === "string" ? apiError.payload.error : null;
      log.warn({ error: apiCode ?? (err instanceof Error ? err.name : typeof err), status: apiError?.status }, "provider.complete.failed");
      if (tooMany) {
        setError(tooMany);
      } else if (apiCode === "two_factor_required") {
        const method: TwoFactorMethod = apiError?.payload.method === "totp" ? "totp" : "email";
        setProviderCode(code);
        setTwoFactorMethod(method);
        setTwoFactorRequired(true);
        setInfo(method === "email" ? t("login.infoEmail") : t("login.infoTotp"));
      } else if (apiCode === "two_factor_invalid") {
        setError(t(signInErrorMessageKey("twoFactorInvalid"), signInErrorValues(err)));
      } else if (apiCode === "invalid_code" || apiCode === "account_deletion_pending") {
        dropProviderSignIn();
        setError(t(providerErrorKey(apiCode)));
      } else {
        setError(t(providerErrorKey("provider_failed")));
      }
    }
  };

  // The browser came back through `badger://auth/provider`: trade the code, or say why there is none.
  useProviderReturn(window.sf?.providerSignIn, (outcome: ProviderReturn) => {
    setMode("email");
    setInfo(null);
    setError(null);
    if ("error" in outcome) {
      log.info({ error: outcome.error }, "provider.return.error");
      dropProviderSignIn();
      setError(t(providerErrorKey(outcome.error)));
      return;
    }
    setLoading(true);
    void finishProviderSignIn(outcome.code).finally(() => setLoading(false));
  });

  useEffect(() => {
    setTwoFactorRequired(false);
    setTwoFactorCode("");
    setTwoFactorMethod(null);
  }, [email, password]);

  useEffect(() => {
    if (!import.meta.env.DEV || autoLoginAttempted.current) {
      return;
    }
    const params = new URLSearchParams(location.search);
    if (params.get("auto") !== "1") {
      return;
    }
    const emailParam = params.get("email");
    const passwordParam = params.get("password");
    if (!emailParam || !passwordParam) {
      return;
    }

    autoLoginAttempted.current = true;
    setEmail(emailParam);
    setPassword(passwordParam);
    setError(null);
    setLoading(true);

    login(emailParam, passwordParam)
      .then(() => navigate("/"))
      .catch((err) => {
        const failure = classifySignInError(err);
        log.warn({ failure, ...signInErrorDetails(err) }, "login.auto.failed");
        if (failure === "emailNotVerified") {
          navigate(`/verify?email=${encodeURIComponent(emailParam)}`);
          return;
        }
        setError(t(signInErrorMessageKey(failure), signInErrorValues(err)));
      })
      .finally(() => setLoading(false));
  }, [location.search, login, navigate, t]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);

    if (providerCode) {
      await finishProviderSignIn(providerCode, twoFactorCode);
      setLoading(false);
      return;
    }

    try {
      await login(email, password, twoFactorRequired ? twoFactorCode : undefined);
      navigate("/");
    } catch (err) {
      const failure = classifySignInError(err);
      // Never the credentials: the kind, the HTTP status and the API's error code (ACCT-AUTH-11).
      log.warn({ failure, ...signInErrorDetails(err) }, "login.failed");
      if (failure === "twoFactorRequired" && err instanceof ApiError) {
        const method = (err.payload.method as TwoFactorMethod) ?? "email";
        setTwoFactorMethod(method);
        setTwoFactorRequired(true);
        setInfo(method === "email" ? t("login.infoEmail") : t("login.infoTotp"));
        setError(null);
      } else if (failure === "twoFactorInvalid") {
        setTwoFactorRequired(true);
        setError(t(signInErrorMessageKey(failure), signInErrorValues(err)));
      } else if (failure === "emailNotVerified") {
        navigate(`/verify?email=${encodeURIComponent(email)}`);
      } else {
        setError(t(signInErrorMessageKey(failure), signInErrorValues(err)));
      }
    } finally {
      setLoading(false);
    }
  };

  const resendCode = async () => {
    if (!twoFactorRequired) return;
    setResending(true);
    setError(null);
    try {
      if (providerCode) {
        // The API sends a new code and answers `two_factor_required` again.
        try {
          await completeProviderSignIn(providerCode, localStorage.getItem(PROVIDER_VERIFIER_KEY) ?? "", undefined, true);
        } catch (err) {
          if (!(err instanceof ApiError && err.payload.error === "two_factor_required")) throw err;
        }
      } else {
        await login(email, password, undefined, true);
      }
      setInfo(t("login.resendSuccess"));
    } catch (err) {
      setError(tooManyAttemptsText(t, err) ?? t("login.resendError"));
    } finally {
      setResending(false);
    }
  };

  return (
    <DesktopStartupPage nebula="badger"
      topNav={<PublicTopNav />}
      controls={
        <DesktopStartupControls>
          <SetupLanguageMenu />
          <AuthApiHostButton />
        </DesktopStartupControls>
      }
    >
      <AuthCardLayout
        subtitle={t("login.subtitle")}
        mascotSrc={mascotSrc}
        mascotAlt={t("brand.mascotAlt")}
        mascotGlowClassName="drop-shadow-[0_0_30px_rgba(255,170,84,0.3)]"
      >
            {mode === "pair" ? (
              <PairWithPhone
                language={pairLanguage}
                actions={window.sf!.pairing!}
                onApproved={completePairing}
                onBack={() => setMode("email")}
                log={{
                  info: (message, extra) => log.info(extra ?? {}, message),
                  warn: (message, extra) => log.warn(extra ?? {}, message),
                  error: (message, extra) => log.error(extra ?? {}, message),
                }}
              />
            ) : null}
            {mode === "email" ? (
            <form className="grid gap-4" onSubmit={onSubmit}>
              {systemIssue ? (
                <NoticeSurface tone="info">
                  Service update in progress. Please update/restart the app and try again.
                </NoticeSurface>
              ) : null}
              {error ? <NoticeSurface tone="error">{error}</NoticeSurface> : null}
              {info ? <NoticeSurface tone="info">{info}</NoticeSurface> : null}

              {/* The provider sign-in's second step asks for the code alone: no email and password. */}
              {providerCode ? null : (
              <>
              <div className="relative">
                <Label htmlFor="email" className="sr-only">
                  {t("login.emailLabel")}
                </Label>
                <Mail className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70" size={18} />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  placeholder={t("login.emailLabel")}
                  className={desktopAuthInputClassName}
                  required
                />
              </div>
              <div className="relative">
                <Label htmlFor="password" className="sr-only">
                  {t("login.passwordLabel")}
                </Label>
                <Lock className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70" size={18} />
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder={t("login.passwordLabel")}
                  className={desktopAuthInputClassName}
                  required
                />
              </div>
              </>
              )}

              {twoFactorRequired ? (
                <div className="grid gap-2">
                  <Label htmlFor="twoFactor">{t("login.twoFactorLabel")}</Label>
                  <Input
                    id="twoFactor"
                    type="text"
                    value={twoFactorCode}
                    onChange={(event) => setTwoFactorCode(event.target.value)}
                    placeholder={t("login.twoFactorPlaceholder")}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                  />
                </div>
              ) : null}

              <DesktopAuthPrimaryButton
                disabled={Boolean(systemIssue) || loading}
                className="bg-[#ffaa54] text-[#0d1117] hover:bg-[#ff9b30] shadow-2xl shadow-[#ffaa54]/20"
              >
                {loading ? t("login.signingIn") : t("login.button")} {!loading ? <ArrowRight size={18} /> : null}
              </DesktopAuthPrimaryButton>

              {twoFactorRequired && twoFactorMethod === "email" ? (
                // UX-BTN-01: a plain text button, the ghost button like every other "Resend code".
                <Button
                  variant="ghost"
                  type="button"
                  disabled={resending}
                  onClick={() => void resendCode()}
                >
                  {resending ? t("login.resending") : t("login.resend")}
                </Button>
              ) : null}

              {/* ACCT-SIGNIN-05: "Forgot password?" belongs to the password sign-in, so it sits with the form, before the "or" line. */}
              <DesktopForgotPasswordLink language={pairLanguage} onClick={() => setResetOpen(true)} />

              {providerCode ? null : (
                <ProviderSignIn
                  mode="signin"
                  disabled={Boolean(systemIssue)}
                  onStarted={() => {
                    setError(null);
                    setInfo(t("login.provider.continueInBrowser"));
                  }}
                  onError={(message) => {
                    setInfo(null);
                    setError(message);
                  }}
                />
              )}

              <DesktopAuthPrompt>
                <Link className={desktopAuthPromptActionClassName} to="/signup">
                  {t("login.noAccountPrompt")} <span className="text-primary">{t("login.createAccount")}</span>
                </Link>
              </DesktopAuthPrompt>
              {pairingAvailable ? (
                <>
                  <BadgerSignInDivider label={pairWithPhoneText(pairLanguage)("or")} />
                  <BadgerPhoneSignInCard
                    title={pairWithPhoneText(pairLanguage)("title")}
                    body={pairWithPhoneText(pairLanguage)("card")}
                    onClick={() => setMode("pair")}
                  />
                </>
              ) : null}
            </form>
            ) : null}
      </AuthCardLayout>

      <DesktopPasswordResetDialog
        language={pairLanguage}
        open={resetOpen}
        onOpenChange={setResetOpen}
        initialEmail={email}
        actions={passwordResetActions}
        onComplete={(notice) => {
          setError(null);
          setInfo(notice);
        }}
      />
    </DesktopStartupPage>
  );
}
