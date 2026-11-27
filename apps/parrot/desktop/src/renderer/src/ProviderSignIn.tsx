/**
 * ACCT-SIGNIN-05 on Parrot desktop: the return half of the Google, Apple and Microsoft sign-in. The rows under the email
 * form are the shared `DesktopProviderSignIn` (`@space/desktop-shell/provider-sign-in`): a row keeps a fresh secret in
 * this window and asks main to start the sign-in; main opens the provider in the system browser, the API sends the
 * browser back to `parrot://auth/provider` and the sign-in screen trades the code here (`useProviderSignInReturn`).
 */
import { useState, type FormEvent } from "react";
import { Button, Input, Spinner } from "@space/ui";
import { useProviderReturn } from "@space/desktop-shell/provider-return";
import { providerVerifier } from "@space/desktop-shell/provider-sign-in";
import { providerSignInTexts, type ProviderReturn, type ProviderSignInErrorCode } from "@space/shared/providerSignIn";
import type { ParrotLanguage } from "../../shared/ipc";
import { signInFailureText, type Translate } from "./i18n";

const log = (message: string, extra?: Record<string, unknown>) => console.info(`[parrot:provider-sign-in] ${message}`, extra ?? "");

/** The words for a `signinError` (or a completion's `invalid_code`), shared with every app (`@space/shared/providerSignIn`). */
const providerErrorText = (language: ParrotLanguage, code: ProviderSignInErrorCode) => providerSignInTexts[language].errors[code];

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
  language,
  onBack,
  onSignedIn,
  onMessage,
}: {
  language: ParrotLanguage;
  /** The return came: bring the email screen back (it shows the second step or the error). */
  onBack: () => void;
  onSignedIn: () => Promise<void>;
  onMessage: (message: string | null) => void;
}): ProviderSignInReturn {
  const [secondStep, setSecondStep] = useState<{ code: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const drop = () => {
    providerVerifier.drop();
    setSecondStep(null);
  };

  const complete = async (code: string, extra: { twoFactorCode?: string; resendTwoFactor?: boolean } = {}) => {
    const verifier = providerVerifier.read();
    if (!verifier) {
      // The secret is gone (another sign-in, a cleared profile): this code cannot be traded here.
      log("return without a kept secret");
      drop();
      onMessage(providerErrorText(language, "invalid_code"));
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
        onMessage(providerErrorText(language, result.error));
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
      onMessage(providerErrorText(language, outcome.error));
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
        {/* UX-BTN-01: the plain text buttons are the shared ghost button, as in Badger. */}
        <Button type="button" variant="ghost" disabled={flow.busy} onClick={() => void flow.resendSecondStep()} data-testid="provider-second-step-resend">
          {t("verify.resend")}
        </Button>
        <Button type="button" variant="ghost" disabled={flow.busy} onClick={flow.cancel} data-testid="provider-second-step-cancel">
          {t("signIn.signOut")}
        </Button>
      </div>
    </form>
  );
}
