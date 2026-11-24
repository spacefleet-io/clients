/**
 * ACCT-SIGNIN-05 on Badger desktop: an "or" line, then the Google, Apple and Microsoft buttons, under the email form and
 * its button on the sign-in and sign-up screens. Only the providers `GET /auth/providers` lists are drawn, so nothing shows while
 * none is configured. A row starts the sign-in at the API and opens the provider in the system browser; the API sends
 * the browser back to `badger://auth/provider` with `signinCode` or `signinError`, main brings the app forward and the
 * sign-in screen trades the code (`useProviderReturn`).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderSignInRows } from "@space/ui/provider-sign-in-rows";
import { BadgerSignInDivider } from "@space/ui/badger/sign-in";
import { isClientUiLanguage } from "@space/shared";
import { newProviderClientSecret, providerReturnAddress } from "@space/shared/providerSignIn";
import type { ProviderSignInErrorCode } from "@space/shared/providerSignIn";
import { tooManyAttemptsText } from "@space/shared/signInError";
import { listSignInProviders, startProviderSignIn } from "../api";
import type { SignInProvider } from "../api";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "provider-sign-in" });

/**
 * Where the window keeps the secret whose hash started the sign-in. `localStorage`, so a Badger restarted while the
 * person was at the provider still finishes; the secret is worth nothing without the code and is dropped once used.
 */
export const PROVIDER_VERIFIER_KEY = "sf_provider_sign_in_verifier";

/** The address the API sends the browser back to; main hands the link to the sign-in screen. */
export const PROVIDER_RETURN_TO = providerReturnAddress("badger");

const PROVIDER_NAMES: Record<SignInProvider, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };

/** The words for a `signinError` (or a completion's `invalid_code`). */
export const providerErrorKey = (code: ProviderSignInErrorCode) => `login.provider.errors.${code}`;

type ProviderSignInProps = {
  /** "signin" titles the rows "Sign in with …", "signup" "Sign up with …". */
  mode: "signin" | "signup";
  /** Rows are not drawn while the app cannot sign in (service update in progress). */
  disabled?: boolean;
  /** The browser was opened: the screen says to finish there. */
  onStarted: () => void;
  /** A failure to start, in words for the screen's error box. */
  onError: (message: string) => void;
};

export function ProviderSignIn({ mode, disabled = false, onStarted, onError }: ProviderSignInProps) {
  const { t, i18n } = useTranslation();
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const [busy, setBusy] = useState<SignInProvider | null>(null);

  useEffect(() => {
    let live = true;
    listSignInProviders()
      .then(({ providers: on }) => {
        log.info({ providers: on }, "providers listed");
        if (live) setProviders(on);
      })
      .catch((err: unknown) => {
        // No list, no rows: the email form still works.
        log.warn({ error: err instanceof Error ? err.name : typeof err }, "could not list providers");
      });
    return () => {
      live = false;
    };
  }, []);

  if (providers.length === 0 || disabled) return null;

  const start = async (provider: SignInProvider) => {
    setBusy(provider);
    try {
      const { verifier, challenge } = newProviderClientSecret();
      localStorage.setItem(PROVIDER_VERIFIER_KEY, verifier);
      const { url } = await startProviderSignIn(provider, {
        returnTo: PROVIDER_RETURN_TO,
        surface: "desktop",
        clientChallenge: challenge,
        ...(isClientUiLanguage(i18n.language) ? { uiLanguage: i18n.language } : {}),
      });
      // https only: the window-open handler hands it to the system browser (shell.openExternal).
      window.open(url, "_blank", "noopener,noreferrer");
      log.info({ provider, mode }, "provider opened in the browser");
      onStarted();
    } catch (err) {
      log.warn({ provider, error: err instanceof Error ? err.name : typeof err }, "start failed");
      onError(tooManyAttemptsText(t, err) ?? t("login.provider.errorStart"));
    } finally {
      setBusy(null);
    }
  };

  const titleKey = mode === "signup" ? "login.provider.signUpWith" : "login.provider.signInWith";
  return (
    <div className="grid gap-4">
      <BadgerSignInDivider label={t("login.provider.or")} testId="provider-sign-in-divider" />
      <ProviderSignInRows
        providers={providers}
        busy={busy}
        label={(provider) => t(titleKey, { provider: PROVIDER_NAMES[provider] })}
        onSelect={(provider) => void start(provider)}
      />
    </div>
  );
}
