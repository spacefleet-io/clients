/**
 * ACCT-SIGNIN-05 on Parrot desktop: an "or" line, then the Google, Apple and Microsoft buttons, under the email form and
 * its button on the sign-in and sign-up screens. Only the providers `GET /auth/providers` lists are drawn, so nothing shows while
 * none is configured. A row makes a fresh secret, keeps it in this window and asks main to start the sign-in; main
 * opens the provider in the system browser, the API sends the browser back to `parrot://auth/provider` and the sign-in
 * screen trades the code (`useProviderSignInReturn`).
 */
import { useEffect, useState, type FormEvent } from "react";
import { Button, Input, Spinner } from "@space/ui";
import { ProviderSignInRows } from "@space/ui/provider-sign-in-rows";
import { BadgerSignInDivider } from "@space/ui/badger/sign-in";
import { useProviderReturn } from "@space/desktop-shell/provider-return";
import { newProviderClientSecret, type ProviderReturn, type ProviderSignInErrorCode } from "@space/shared/providerSignIn";
import type { SignInProvider } from "@space/shared/api";
import type { ParrotLanguage } from "../../shared/ipc";
import { signInFailureText, type Translate } from "./i18n";

const log = (message: string, extra?: Record<string, unknown>) => console.info(`[parrot:provider-sign-in] ${message}`, extra ?? "");

/**
 * Where the window keeps the secret whose hash started the sign-in. `localStorage`, so a Parrot restarted while the
 * person was at the provider still finishes; the secret is worth nothing without the code and is dropped once used.
 */
export const PROVIDER_VERIFIER_KEY = "sf_provider_sign_in_verifier";

const PROVIDER_NAMES: Record<SignInProvider, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };

const providerErrorText = (t: Translate, code: ProviderSignInErrorCode) => t(`signIn.provider.errors.${code}`);

type RowsProps = {
  t: Translate;
  language: ParrotLanguage;
  /** "signIn" titles the rows "Sign in with …", "signUp" "Sign up with …". */
  mode: "signIn" | "signUp";
  /** The browser was opened: the screen says to finish there. */
  onStarted: () => void;
  /** A failure to start, in words. */
  onError: (message: string) => void;
};

export function ProviderSignIn({ t, language, mode, onStarted, onError }: RowsProps) {
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const [busy, setBusy] = useState<SignInProvider | null>(null);

  useEffect(() => {
    let live = true;
    void window.parrot.providerSignIn.list().then((on) => {
      log("providers listed", { providers: on });
      if (live) setProviders(on);
    });
    return () => {
      live = false;
    };
  }, []);

  if (providers.length === 0) return null;

  const start = async (provider: SignInProvider) => {
    setBusy(provider);
    try {
      const { verifier, challenge } = newProviderClientSecret();
      localStorage.setItem(PROVIDER_VERIFIER_KEY, verifier);
      const result = await window.parrot.providerSignIn.start(provider, challenge);
      if (result.ok) {
        log("provider opened in the browser", { provider, mode });
        onStarted();
        return;
      }
      log("start failed", { provider, failure: result.failure });
      onError(result.failure === "rateLimited" ? signInFailureText(language, result.failure, result.retryAfterMinutes) : t("signIn.provider.errorStart"));
    } finally {
      setBusy(null);
    }
  };

  const titleKey = mode === "signUp" ? "signIn.provider.signUpWith" : "signIn.provider.signInWith";
  return (
    <div className="grid gap-4" data-testid="provider-sign-in">
      <BadgerSignInDivider label={t("signIn.provider.or")} testId="provider-sign-in-divider" />
      <ProviderSignInRows
        providers={providers}
        busy={busy}
        label={(provider) => t(titleKey, { provider: PROVIDER_NAMES[provider] })}
        onSelect={(provider) => void start(provider)}
      />
    </div>
  );
}

/** A provider sign-in coming back: the code waits here while the account asks for its second step. */
export type ProviderSignInReturn = {
  /** Set while the API asks for the second sign-in step; the code stays usable until it is answered. */
  secondStep: { code: string } | null;
  busy: boolean;
  /** Trades the code again with the second-step code (or asks for a fresh emailed code). */
  submitSecondStep: (twoFactorCode: string) => Promise<void>;
  resendSecondStep: () => Promise<void>;
  cancel: () => void;
};

/**
 * Listens for the `parrot://auth/provider` return on the sign-in screen (mounted in every mode, sign-up included) and
 * trades the code with the kept secret. `onSignedIn` runs once main holds the session; `onMessage` shows an error.
 */
export function useProviderSignInReturn({
  t,
  language,
  onBack,
  onSignedIn,
  onMessage,
}: {
  t: Translate;
  language: ParrotLanguage;
  /** The return came: bring the email screen back (it shows the second step or the error). */
  onBack: () => void;
  onSignedIn: () => Promise<void>;
  onMessage: (message: string | null) => void;
}): ProviderSignInReturn {
  const [secondStep, setSecondStep] = useState<{ code: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const drop = () => {
    localStorage.removeItem(PROVIDER_VERIFIER_KEY);
    setSecondStep(null);
  };

  const complete = async (code: string, extra: { twoFactorCode?: string; resendTwoFactor?: boolean } = {}) => {
    const verifier = localStorage.getItem(PROVIDER_VERIFIER_KEY);
    if (!verifier) {
      // The secret is gone (another sign-in, a cleared profile): this code cannot be traded here.
      log("return without a kept secret");
      drop();
      onMessage(providerErrorText(t, "invalid_code"));
      return;
    }
    setBusy(true);
    onMessage(null);
    try {
      const result = await window.parrot.providerSignIn.complete({ code, verifier, ...extra });
      if (result.ok) {
        log("signed in");
        drop();
        await onSignedIn();
        return;
      }
      if ("error" in result) {
        log("code spent", { error: result.error });
        drop();
        onMessage(providerErrorText(t, result.error));
        return;
      }
      log("completion asks again", { failure: result.failure, method: result.method });
      if (result.failure === "twoFactorRequired" || result.failure === "twoFactorInvalid") setSecondStep({ code });
      // The first ask is the prompt itself; a resend says so too (the API answers twoFactorRequired again).
      onMessage(signInFailureText(language, result.failure, result.retryAfterMinutes));
    } finally {
      setBusy(false);
    }
  };

  useProviderReturn(window.parrot.providerSignIn, (outcome: ProviderReturn) => {
    onBack();
    if ("error" in outcome) {
      log("return with an error", { error: outcome.error });
      drop();
      onMessage(providerErrorText(t, outcome.error));
      return;
    }
    log("return with a code");
    void complete(outcome.code);
  });

  return {
    secondStep,
    busy,
    submitSecondStep: async (twoFactorCode) => {
      if (secondStep) await complete(secondStep.code, { twoFactorCode: twoFactorCode.trim() });
    },
    resendSecondStep: async () => {
      if (secondStep) await complete(secondStep.code, { resendTwoFactor: true });
    },
    cancel: () => {
      log("second step cancelled");
      drop();
      onMessage(null);
    },
  };
}

/** The second sign-in step of a provider sign-in: only the code field, the provider already said who this is. */
export function ProviderSecondStep({ t, flow, message }: { t: Translate; flow: ProviderSignInReturn; message: string | null }) {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void flow.submitSecondStep(code);
  };
  return (
    <form className="space-y-3" onSubmit={submit} data-testid="provider-second-step">
      <Input inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder={t("signIn.code")} value={code} onChange={(e) => setCode(e.target.value)} data-testid="provider-second-step-code" />
      {message ? (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      <Button type="submit" disabled={flow.busy || !code.trim()} data-testid="provider-second-step-submit">
        {flow.busy ? <Spinner size="sm" /> : t("signIn.submit")}
      </Button>
      <div className="flex justify-between text-sm">
        <button type="button" className="text-primary hover:underline" disabled={flow.busy} onClick={() => void flow.resendSecondStep()} data-testid="provider-second-step-resend">
          {t("verify.resend")}
        </button>
        <button type="button" className="text-muted-foreground hover:underline" disabled={flow.busy} onClick={flow.cancel} data-testid="provider-second-step-cancel">
          {t("signIn.signOut")}
        </button>
      </div>
    </form>
  );
}
