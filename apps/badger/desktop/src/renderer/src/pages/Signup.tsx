import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Lock, Mail } from "lucide-react";
import PublicTopNav from "../components/PublicTopNav";
import { ApiError, signup } from "../api";
import { tooManyAttemptsText } from "@space/shared/signInError";
import { Input } from "@space/ui";
import { Label } from "@space/ui";
import { MASCOT_GLOW } from "@space/ui/floating-mascot";
import { deviceUiLanguageNow } from "@/lib/accountUiLanguage";
import AuthApiHostButton from "@/components/AuthApiHostButton";
import {
  AuthCardLayout,
  DesktopAuthPrimaryButton,
  DesktopAuthPrompt,
  DesktopStartupControls,
  DesktopStartupPage,
  NoticeSurface,
  desktopAuthInputClassName,
  desktopAuthPromptActionClassName,
  desktopAuthSignupAccentTextClassName,
  desktopAuthSignupButtonClassName,
} from "@space/desktop-shell/components";
import mascotWebp from "@/assets/mascot.webp";
import { validateDesktopSignupInput } from "@/lib/signupValidation";
import { newsOptInText } from "@space/legal";
import SetupLanguageMenu from "@/components/SetupLanguageMenu";
import { ProviderSignIn } from "@/components/ProviderSignIn";
import { useProviderReturnNudge } from "@space/desktop-shell/provider-return";

export default function Signup() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mascotSrc = mascotWebp;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // ACCT-NEWS-01: unticked until the user ticks it.
  const [newsOptIn, setNewsOptIn] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  // ACCT-SIGNIN-05: a provider sign-in started here comes back to the sign-in screen, which trades the code.
  useProviderReturnNudge(window.sf?.providerSignIn, () => navigate("/login"));

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const validationError = validateDesktopSignupInput(email, password, confirm);
    if (validationError) {
      setError(t(validationError));
      return;
    }

    setLoading(true);
    try {
      // The language the user registers in writes the first email (ACCT-EMAIL-01); the News box goes with it (ACCT-NEWS-01).
      await signup(email, password, deviceUiLanguageNow(), newsOptIn);
      navigate(`/verify?email=${encodeURIComponent(email)}`);
    } catch (err) {
      const tooMany = tooManyAttemptsText(t, err);
      if (tooMany) {
        setError(tooMany);
      } else if (err instanceof ApiError && err.payload.error === "email_exists") {
        setError(t("signup.errors.emailExists"));
      } else if (err instanceof ApiError && err.payload.error === "email_domain_disallowed") {
        setError(t("signup.errors.emailDomainDisallowed"));
      } else {
        setError(t("signup.errors.generic"));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <DesktopStartupPage nebula="badger"
      topNav={<PublicTopNav />}
      mainClassName="py-12"
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
        mascotGlowClassName={MASCOT_GLOW.badger}
      >
            <form className="grid gap-4" onSubmit={onSubmit}>
              {error ? <NoticeSurface tone="error">{error}</NoticeSurface> : null}
              {info ? <NoticeSurface tone="info">{info}</NoticeSurface> : null}
              <div className="relative">
                <Label htmlFor="email" className="sr-only">
                  {t("signup.emailLabel")}
                </Label>
                <Mail className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70" size={18} />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder={t("signup.emailLabel")}
                  className={desktopAuthInputClassName}
                  required
                />
              </div>
              <div className="relative">
                <Label htmlFor="password" className="sr-only">
                  {t("signup.passwordLabel")}
                </Label>
                <Lock className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70" size={18} />
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("signup.passwordLabel")}
                  className={desktopAuthInputClassName}
                  required
                />
              </div>
              <div className="relative">
                <Label htmlFor="confirm" className="sr-only">
                  {t("signup.confirmLabel")}
                </Label>
                <Lock className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70" size={18} />
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder={t("signup.confirmLabel")}
                  className={desktopAuthInputClassName}
                  required
                />
              </div>
              <label className="flex cursor-pointer items-start gap-3 text-left text-sm leading-relaxed text-muted-foreground">
                <input
                  type="checkbox"
                  data-testid="signup-news-opt-in"
                  checked={newsOptIn}
                  onChange={(event) => setNewsOptIn(event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                />
                <span>{newsOptInText(i18n.language).newsBox}</span>
              </label>
              <DesktopAuthPrimaryButton
                disabled={loading}
                className={desktopAuthSignupButtonClassName}
              >
                {loading ? t("signup.creating") : t("signup.button")} {!loading ? <Check size={18} /> : null}
              </DesktopAuthPrimaryButton>
              <ProviderSignIn
                mode="signup"
                onStarted={() => {
                  setError(null);
                  setInfo(t("login.provider.continueInBrowser"));
                }}
                onError={(message) => {
                  setInfo(null);
                  setError(message);
                }}
              />
              <DesktopAuthPrompt>
                <Link className={desktopAuthPromptActionClassName} to="/login">
                  {t("signup.haveAccountPrompt")} <span className={desktopAuthSignupAccentTextClassName}>{t("signup.signIn")}</span>
                </Link>
              </DesktopAuthPrompt>
            </form>
      </AuthCardLayout>
    </DesktopStartupPage>
  );
}
