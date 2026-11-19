import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PublicTopNav from "../components/PublicTopNav";
import { ApiError, resendVerification, verifyEmail } from "../api";
import { tooManyAttemptsText } from "@space/shared/signInError";
import { useAuth } from "../auth";
import { Button } from "@space/ui";
import { Input } from "@space/ui";
import { Label } from "@space/ui";
import { DesktopStartupCard, DesktopStartupControls, DesktopStartupPage } from "@space/desktop-shell/components";
import SetupLanguageMenu from "@/components/SetupLanguageMenu";
import mascotWebp from "@/assets/mascot.webp";

export default function VerifyEmailPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const params = new URLSearchParams(location.search);
  const initialEmail = params.get("email") ?? "";
  const mascotSrc = mascotWebp;

  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "verifying" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email || !code) {
      setStatus("error");
      setMessage(t("verifyEmail.errors.invalidCode"));
      return;
    }

    setStatus("verifying");
    setMessage(null);
    try {
      const result = await verifyEmail(email, code);
      setSession(result.token, result.user);
      navigate("/onboarding/key", { replace: true });
    } catch (err) {
      const tooMany = tooManyAttemptsText(t, err);
      if (tooMany) {
        setStatus("error");
        setMessage(tooMany);
      } else if (err instanceof ApiError && err.payload.error === "invalid_code") {
        setStatus("error");
        setMessage(t("verifyEmail.errors.invalidCode"));
      } else {
        setStatus("error");
        setMessage(t("verifyEmail.errors.generic"));
      }
    }
  };

  const resend = async () => {
    if (!email) {
      setMessage(t("verifyEmail.errors.emailRequired"));
      return;
    }
    setSending(true);
    setMessage(null);
    try {
      await resendVerification(email);
      setMessage(t("verifyEmail.sent"));
    } catch (err) {
      const tooMany = tooManyAttemptsText(t, err);
      if (tooMany) {
        setMessage(tooMany);
      } else if (err instanceof ApiError && err.payload.error === "email_not_found") {
        setMessage(t("verifyEmail.errors.emailNotFound"));
      } else {
        setMessage(t("verifyEmail.errors.sendFailed"));
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <DesktopStartupPage
      nebula="badger"
      topNav={<PublicTopNav />}
      mainClassName="py-12"
      controls={
        <DesktopStartupControls>
          <SetupLanguageMenu />
        </DesktopStartupControls>
      }
    >
        <DesktopStartupCard
          title={t("verifyEmail.title")}
          description={t("verifyEmail.subtitle")}
          mascotSrc={mascotSrc}
          mascotAlt={t("brand.mascotAlt")}
          mascotGlowClassName="drop-shadow-[0_0_30px_rgba(255,170,84,0.3)]"
          mascotPlacement="above"
          contentClassName="space-y-4 pb-8 pt-4"
        >
            {status === "verifying" ? (
              <div className="text-sm text-muted-foreground">{t("verifyEmail.verifying")}</div>
            ) : null}
            {message ? (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {message}
              </div>
            ) : null}

            <form className="space-y-4" onSubmit={(event) => void submit(event)}>
              <div className="grid gap-2">
                <Label htmlFor="email">{t("verifyEmail.emailLabel")}</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="code">{t("verifyEmail.codeLabel")}</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={t("verifyEmail.codePlaceholder")}
                  required
                />
              </div>

              <Button type="submit" disabled={status === "verifying"}>
                {status === "verifying" ? t("verifyEmail.verifying") : t("verifyEmail.submit")}
              </Button>

              <Button type="button" variant="secondary" onClick={() => void resend()} disabled={sending}>
                {sending ? t("verifyEmail.sending") : t("verifyEmail.resend")}
              </Button>
            </form>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <Link className="hover:text-foreground" to="/login">
                {t("verifyEmail.backToSignIn")}
              </Link>
              <Link className="hover:text-foreground" to="/signup">
                {t("verifyEmail.createAccount")}
              </Link>
            </div>
        </DesktopStartupCard>
    </DesktopStartupPage>
  );
}
