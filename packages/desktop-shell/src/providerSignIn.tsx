/**
 * ACCT-SIGNIN-05 on Badger and Parrot desktop: an "or" line, then the Google, Apple and Microsoft buttons, under the
 * email form and its button on the sign-in and sign-up screens. Only the providers the API lists are drawn, so
 * nothing shows while none is configured or the list cannot be read (the email form still works). A row keeps a new
 * secret (`providerVerifier`), asks the app to start the sign-in with its hash and open the provider in the system
 * browser; the browser comes back through the app's `<scheme>://auth/provider` link (`useProviderReturn`).
 */
import { useEffect, useRef, useState } from "react";
import { ProviderSignInRows } from "@space/ui/provider-sign-in-rows";
import { BadgerSignInDivider } from "@space/ui/badger/sign-in";
import { isClientUiLanguage } from "@space/shared";
import type { SignInProvider } from "@space/shared/api";
import { newProviderClientSecret, providerSignInText } from "@space/shared/providerSignIn";

const log = {
  info: (message: string, extra: Record<string, unknown>) => console.info(`[provider-sign-in] ${message}`, extra),
  warn: (message: string, extra: Record<string, unknown>) => console.warn(`[provider-sign-in] ${message}`, extra),
};

/**
 * Where the window keeps the secret whose hash started the sign-in. `localStorage`, so an app restarted while the
 * person was at the provider still finishes; the secret is worth nothing without the code and is dropped once used.
 * The key is the one both apps have always used: changing it would lose a sign-in in flight across an update.
 */
export const PROVIDER_VERIFIER_KEY = "sf_provider_sign_in_verifier";

/** The secret kept between starting a provider sign-in and trading the code the browser brings back. */
export const providerVerifier = {
  /** Keeps a new secret and returns its hash, the `clientChallenge` that starts the sign-in. */
  begin: (): string => {
    const { verifier, challenge } = newProviderClientSecret();
    localStorage.setItem(PROVIDER_VERIFIER_KEY, verifier);
    return challenge;
  },
  /** The kept secret, or null when this window did not start the sign-in (another computer, a cleared profile). */
  read: (): string | null => localStorage.getItem(PROVIDER_VERIFIER_KEY),
  /** Forgets the secret once its code is traded or can no longer be. */
  drop: (): void => localStorage.removeItem(PROVIDER_VERIFIER_KEY),
};

/** How starting a sign-in went: `message` is the app's own words for a refusal (too many attempts), else the shared one. */
export type ProviderSignInStart = { ok: true } | { ok: false; message?: string };

const PROVIDER_NAMES: Record<SignInProvider, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };

export type DesktopProviderSignInProps = {
  /** The window's UI language (an unknown one falls back to English). */
  language: string;
  /** "signIn" titles the rows "Sign in with …", "signUp" "Sign up with …". */
  mode: "signIn" | "signUp";
  /** Rows are not drawn while the app cannot sign in (service update in progress). */
  disabled?: boolean;
  /** The providers the API offers (`GET /auth/providers`). */
  list: () => Promise<SignInProvider[]>;
  /** Starts the sign-in at the API with `clientChallenge` and opens the provider in the system browser. */
  start: (provider: SignInProvider, clientChallenge: string) => Promise<ProviderSignInStart>;
  /** The browser was opened: the screen says to finish there. */
  onStarted: () => void;
  /** A failure to start, in words for the screen's error box. */
  onError: (message: string) => void;
};

export function DesktopProviderSignIn({ language, mode, disabled = false, list, start, onStarted, onError }: DesktopProviderSignInProps) {
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const [busy, setBusy] = useState<SignInProvider | null>(null);
  const lang = isClientUiLanguage(language) ? language : "en";

  // The list is read once per screen: the API's providers do not change while it is shown.
  const listOnce = useRef(list);
  useEffect(() => {
    let live = true;
    listOnce
      .current()
      .then((on) => {
        log.info("providers listed", { providers: on });
        if (live) setProviders(on);
      })
      .catch((err: unknown) => {
        // No list, no rows: the email form still works.
        log.warn("could not list providers", { error: err instanceof Error ? err.name : typeof err });
      });
    return () => {
      live = false;
    };
  }, []);

  if (providers.length === 0 || disabled) return null;

  const begin = async (provider: SignInProvider) => {
    setBusy(provider);
    try {
      const result = await start(provider, providerVerifier.begin());
      if (result.ok) {
        log.info("provider opened in the browser", { provider, mode });
        onStarted();
        return;
      }
      log.warn("start refused", { provider, own: result.message !== undefined });
      onError(result.message ?? providerSignInText(lang, "errorStart"));
    } catch (err) {
      log.warn("start failed", { provider, error: err instanceof Error ? err.name : typeof err });
      onError(providerSignInText(lang, "errorStart"));
    } finally {
      setBusy(null);
    }
  };

  const titleKey = mode === "signUp" ? "signUpWith" : "signInWith";
  return (
    <div className="grid gap-4" data-testid="provider-sign-in">
      <BadgerSignInDivider label={providerSignInText(lang, "or")} testId="provider-sign-in-divider" />
      <ProviderSignInRows
        providers={providers}
        busy={busy}
        label={(provider) => providerSignInText(lang, titleKey, PROVIDER_NAMES[provider])}
        onSelect={(provider) => void begin(provider)}
      />
    </div>
  );
}
